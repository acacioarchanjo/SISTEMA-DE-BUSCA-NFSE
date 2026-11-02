import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import zlib from 'node:zlib';
import forge from 'node-forge';
import { sincronizarEmpresa, ErroTrava } from '../src/adn/distribuicao.js';
import { ClienteAdn, ErroAdn, decodificarXml } from '../src/adn/cliente.js';
import { cadastrarEmpresa, abrirCredenciais } from '../src/crypto/credenciais.js';
import { lerXmlSalvo } from '../src/nfse/armazenamento.js';
import { ambienteTeste, gerarPfx, fixture, xmlRecebida, CHAVE_TESTE, CNPJ_TESTE, limpar } from './ajuda.js';

const gz = (s) => zlib.gzipSync(Buffer.from(s)).toString('base64');

/** Cliente falso: serve documentos a partir do NSU pedido, em lotes. */
function clienteFalso(docs, { tamanhoLote = 2, falharEm } = {}) {
  const chamadas = [];
  return {
    chamadas,
    fechar() {},
    async distribuicao(nsu) {
      chamadas.push(nsu);
      if (falharEm && chamadas.length === falharEm) throw new ErroAdn('Consumo indevido', { consumoIndevido: true, status: 429 });
      const lote = docs.filter((d) => d.nsu >= nsu).slice(0, tamanhoLote);
      if (!lote.length) return { status: 'NENHUM_DOCUMENTO', documentos: [] };
      return { status: 'DOCUMENTOS_LOCALIZADOS', documentos: lote };
    },
  };
}

const DOCS = () => [
  { nsu: 1, tipo: 'NFSE', chave: CHAVE_TESTE, xml: fixture('nfse-exemplo.xml') },
  { nsu: 2, tipo: 'NFSE', xml: xmlRecebida() },
  { nsu: 3, tipo: 'EVENTO', tipoEvento: '101101', chave: CHAVE_TESTE, xml: fixture('evento-cancelamento.xml') },
  { nsu: 4, tipo: 'NFSE', xml: '<lixo>' },
];

test('distribuição: baixa por NSU, aplica eventos, avança cursor e é idempotente', async () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    const falso = clienteFalso(DOCS());
    const r = await sincronizarEmpresa(repo, id, { criarCliente: () => falso, intervaloMs: 0 });

    assert.equal(r.novos, 2);
    assert.equal(r.eventos, 1);
    assert.equal(r.erros.length, 1, 'XML inválido registrado sem travar a fila');
    assert.equal(repo.obterCursor(id), 4);

    const { itens } = repo.listarDocumentos({ empresaId: id });
    const emitida = itens.find((d) => d.papel === 'emitida');
    const recebida = itens.find((d) => d.papel === 'recebida');
    assert.equal(emitida.chave, CHAVE_TESTE);
    assert.equal(emitida.situacao, 'cancelada');
    assert.equal(recebida.prestador_doc, '99888777000100');
    assert.match(lerXmlSalvo(emitida.xml_path, dataDir), /infNFSe/);
    assert.match(emitida.xml_path, new RegExp(`xml/${CNPJ_TESTE}/2026-03/`));

    const exec = repo.listarExecucoes({ empresaId: id })[0];
    assert.equal(exec.status, 'ok');

    // segunda execução: nada novo, cursor parado
    const r2 = await sincronizarEmpresa(repo, id, { criarCliente: () => clienteFalso(DOCS()), intervaloMs: 0 });
    assert.equal(r2.novos, 0);
    assert.equal(repo.obterCursor(id), 4);
  } finally {
    limpar(dataDir);
  }
});

test('distribuição: consumo indevido trava a empresa e preserva o progresso', async () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    await assert.rejects(
      sincronizarEmpresa(repo, id, { criarCliente: () => clienteFalso(DOCS(), { falharEm: 2 }), intervaloMs: 0 }),
      ErroAdn,
    );
    assert.equal(repo.obterCursor(id), 2, 'primeiro lote ficou gravado');
    assert.ok(new Date(repo.obterEmpresa(id).trava_ate) > new Date());
    assert.equal(repo.listarExecucoes({ empresaId: id })[0].status, 'travada');
    await assert.rejects(sincronizarEmpresa(repo, id, { criarCliente: () => clienteFalso(DOCS()) }), ErroTrava);
  } finally {
    limpar(dataDir);
  }
});

test('cliente ADN: decodifica base64+gzip', () => {
  assert.equal(decodificarXml(gz('<a/>')), '<a/>');
  assert.equal(decodificarXml(Buffer.from('<b/>').toString('base64')), '<b/>');
  assert.equal(decodificarXml('<c/>'), '<c/>');
});

// ---- Servidor HTTPS local exigindo certificado de cliente (simula o ADN) ----
function certificadoServidor() {
  const chaves = forge.pki.rsa.generateKeyPair(1024);
  const c = forge.pki.createCertificate();
  c.publicKey = chaves.publicKey;
  c.serialNumber = '02';
  c.validity.notBefore = new Date(Date.now() - 86_400_000);
  c.validity.notAfter = new Date(Date.now() + 86_400_000);
  c.setSubject([{ name: 'commonName', value: 'localhost' }]);
  c.setIssuer([{ name: 'commonName', value: 'localhost' }]);
  c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  c.sign(chaves.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(c), key: forge.pki.privateKeyToPem(chaves.privateKey) };
}

test('cliente ADN: mTLS real contra servidor local + formato JSON da distribuição', async () => {
  const { repo, dataDir } = ambienteTeste();
  const srvCert = certificadoServidor();
  const pedidos = [];
  const servidor = https.createServer({ ...srvCert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const certCliente = req.socket.getPeerCertificate();
    pedidos.push({ url: req.url, cn: certCliente?.subject?.CN });
    if (!certCliente?.subject) {
      res.writeHead(403).end();
      return;
    }
    const nsu = Number(req.url.match(/DFe\/(\d+)/)[1]);
    if (nsu >= 1) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO', LoteDFe: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
        LoteDFe: [{ NSU: 1, ChaveAcesso: CHAVE_TESTE, TipoDocumento: 'NFSE', ArquivoXml: gz(fixture('nfse-exemplo.xml')), DataHoraGeracao: '2026-03-15T10:05:00' }],
      }),
    );
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    const r = await sincronizarEmpresa(repo, id, {
      intervaloMs: 0,
      criarCliente: (cred) => new ClienteAdn(cred, { host: 'localhost', porta, ca: srvCert.cert }),
    });
    assert.equal(r.novos, 1);
    assert.equal(repo.obterCursor(id), 1);
    assert.match(pedidos[0].url, new RegExp(`^/contribuintes/DFe/0\\?cnpjConsulta=${CNPJ_TESTE}&lote=true$`));
    assert.equal(pedidos[0].cn, `EMPRESA TESTE LTDA:${CNPJ_TESTE}`, 'servidor recebeu o certificado A1');

    // HTTP 429 vira consumo indevido
    const cliente429 = new ClienteAdn(abrirCredenciais(repo, id), { host: 'localhost', porta, ca: srvCert.cert });
    servidor.removeAllListeners('request');
    servidor.on('request', (req, res) => res.writeHead(429).end('Too Many Requests'));
    await assert.rejects(cliente429.distribuicao(5), (e) => e.consumoIndevido === true);
    cliente429.fechar();
  } finally {
    servidor.close();
    servidor.closeAllConnections?.();
    limpar(dataDir);
  }
});

test('distribuição: cancelamento que chega antes da nota é aplicado depois', async () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    const docs = [
      { nsu: 10, tipo: 'EVENTO', tipoEvento: '101101', chave: CHAVE_TESTE, xml: fixture('evento-cancelamento.xml') },
      { nsu: 11, tipo: 'NFSE', xml: fixture('nfse-exemplo.xml') },
    ];
    await sincronizarEmpresa(repo, id, { criarCliente: () => clienteFalso(docs), intervaloMs: 0 });
    assert.equal(repo.listarDocumentos({ empresaId: id }).itens[0].situacao, 'cancelada');
  } finally {
    limpar(dataDir);
  }
});
