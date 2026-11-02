// Fase 2 do roteiro: contrato de conector, conector ABRASF genérico e cadastro de municípios.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import forge from 'node-forge';
import { XMLParser } from 'fast-xml-parser';
import { parseCompNfse, normalizarAliquota, normalizarItemLista } from '../src/conectores/abrasf/parser.js';
import { montarEnvio, montarEnvelope, lerResposta, escaparXml } from '../src/conectores/abrasf/mensagens.js';
import { obterPerfil, opcoesEfetivas } from '../src/conectores/abrasf/perfis.js';
import { janelas } from '../src/conectores/abrasf/conector.js';
import { criarConectorMunicipal } from '../src/conectores/registro.js';
import { verificarContrato, ErroConector } from '../src/conectores/contrato.js';
import { sincronizarMunicipal, testarVinculo, periodoPadrao } from '../src/conectores/sincronizacao.js';
import { registrarNfse, sincronizarTodas } from '../src/adn/distribuicao.js';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { listarAuditoria, verificarAuditoria } from '../src/auditoria.js';
import { criarServidor } from '../src/server/app.js';
import { ambienteTeste, gerarPfx, fixture, CNPJ_TESTE, limpar } from './ajuda.js';
import { compNfse202 } from './abrasf-modelo.js';

const P202 = obterPerfil('abrasf-2.02');
const P100 = obterPerfil('abrasf-1.00');

// ---------- parser ----------
test('ABRASF 2.02: CompNfse vira o modelo canônico (valores, retenções, regime, chave)', () => {
  const n = parseCompNfse(compNfse202(), { ibge: '4205407', municipioNome: 'Florianópolis' });
  assert.equal(n.chave, 'NFSM-4205407-04252011000110-1001');
  assert.equal(n.sistema, 'abrasf');
  assert.equal(n.numero, '1001');
  assert.equal(n.codigo_verificacao, 'CV-1001');
  assert.equal(n.competencia, '2026-03-10');
  assert.equal(n.prestador_doc, '04252011000110');
  assert.equal(n.prestador_nome, 'CONSTRUTORA EXEMPLO LTDA');
  assert.equal(n.tomador_doc, CNPJ_TESTE);
  assert.equal(n.codigo_servico, '070200');
  assert.equal(n.codigo_servico_municipal, '70201');
  assert.equal(n.municipio_incidencia, 'Florianópolis');
  assert.equal(n.valor_servico, 2000);
  assert.equal(n.aliquota, 5);
  assert.equal(n.valor_iss, 100);
  assert.equal(n.iss_retido, false);
  assert.equal(n.tp_ret_issqn, '1');
  assert.equal(n.valor_pis, 13);
  assert.equal(n.valor_total_retencoes, 13 + 60 + 30 + 20);
  assert.equal(n.valor_liquido, 1877);
  assert.equal(n.prestador_regime, '1');
  assert.equal(n.situacao, 'normal');

  const c = parseCompNfse(compNfse202({ retido: true, cancelada: '2026-04-02', optante: '1' }));
  assert.equal(c.iss_retido, true);
  assert.equal(c.tp_ret_issqn, '2');
  assert.equal(c.prestador_regime, '3');
  assert.equal(c.situacao, 'cancelada');
  assert.deepEqual(c.eventos.map((e) => [e.tipo_evento, e.data_evento]), [['101101', '2026-04-02T09:00:00']]);
});

test('ABRASF 1.00: alíquota em fração, item sem ponto, cancelamento com DataHoraCancelamento', () => {
  const n = parseCompNfse(fixture('abrasf-100-compnfse.xml'));
  assert.equal(n.chave, 'NFSM-3106200-11222333000181-55');
  assert.equal(n.aliquota, 3);
  assert.equal(n.codigo_servico, '010700');
  assert.equal(n.iss_retido, true);
  assert.equal(n.prestador_regime, '3');
  assert.equal(n.competencia, '2025-11-01');
  assert.equal(n.situacao, 'cancelada');
  assert.equal(n.eventos[0].data_evento, '2025-12-02T09:00:00');
  assert.equal(normalizarAliquota('0.05'), 5);
  assert.equal(normalizarAliquota('2,5'), 2.5);
  assert.equal(normalizarItemLista('702'), '070200');
  assert.equal(normalizarItemLista('17.05'), '170500');
  assert.equal(normalizarItemLista('1405'), '140500');
});

// ---------- mensagens ----------
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });

test('mensagens: corpo da consulta por versão e papel; envelope SOAP 1.1/1.2 e estilos', () => {
  const prest = montarEnvio(P202, 'prestadas', { cnpj: CNPJ_TESTE, im: '999', de: '2026-03-01', ate: '2026-03-31', pagina: 2, periodo: 'emissao' });
  const p = parser.parse(prest).ConsultarNfseServicoPrestadoEnvio;
  assert.equal(p.Prestador.CpfCnpj.Cnpj, CNPJ_TESTE);
  assert.equal(p.Prestador.InscricaoMunicipal, '999');
  assert.equal(p.PeriodoEmissao.DataFinal, '2026-03-31');
  assert.equal(p.Pagina, '2');
  const tom = parser.parse(montarEnvio(P202, 'tomadas', { cnpj: CNPJ_TESTE, de: '2026-03-01', ate: '2026-03-31', periodo: 'competencia' })).ConsultarNfseServicoTomadoEnvio;
  assert.equal(tom.Consulente.CpfCnpj.Cnpj, CNPJ_TESTE);
  assert.equal(tom.Tomador.CpfCnpj.Cnpj, CNPJ_TESTE);
  assert.ok(tom.PeriodoCompetencia);
  assert.equal(tom.Consulente.InscricaoMunicipal, undefined, 'IM vazia é omitida');
  const v1 = parser.parse(montarEnvio(P100, 'prestadas', { cnpj: CNPJ_TESTE, im: '1', de: '2025-11-01', ate: '2025-11-30' })).ConsultarNfseEnvio;
  assert.equal(v1.Prestador.Cnpj, CNPJ_TESTE);

  const o11 = opcoesEfetivas(P202, {});
  const e11 = montarEnvelope(P202, 'prestadas', prest, o11);
  assert.equal(e11.headers['Content-Type'], 'text/xml; charset=utf-8');
  assert.equal(e11.headers.SOAPAction, '"http://nfse.abrasf.org.br/ConsultarNfseServicoPrestado"');
  const corpo = parser.parse(e11.corpo).Envelope.Body.ConsultarNfseServicoPrestadoRequest;
  assert.match(corpo.nfseDadosMsg, /^<ConsultarNfseServicoPrestadoEnvio/);
  assert.match(corpo.nfseCabecMsg, /<versaoDados>2.02<\/versaoDados>/);
  assert.ok(e11.corpo.includes(escaparXml('<Pagina>2</Pagina>')), 'XML escapado dentro de nfseDadosMsg');

  const o12 = opcoesEfetivas(P202, { soapVersao: '1.2', estilo: 'direto', elementoOperacao: '{op}', soapAction: '' });
  const e12 = montarEnvelope(P202, 'prestadas', prest, o12);
  assert.equal(e12.headers['Content-Type'], 'application/soap+xml; charset=utf-8');
  assert.ok(e12.corpo.includes('<nfse:ConsultarNfseServicoPrestado><ConsultarNfseServicoPrestadoEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">'));
  assert.ok(e12.corpo.includes('http://www.w3.org/2003/05/soap-envelope'));
});

const envelope = (inner) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
const respPrestadas = (comps, prox) =>
  `<ConsultarNfseServicoPrestadoResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaNfse>${comps.join('')}${prox ? `<ProximaPagina>${prox}</ProximaPagina>` : ''}</ListaNfse></ConsultarNfseServicoPrestadoResposta>`;
const mensagemRetorno = (cod, msg, raiz = 'ConsultarNfseServicoPrestadoResposta') =>
  `<${raiz} xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno><MensagemRetorno><Codigo>${cod}</Codigo><Mensagem>${msg}</Mensagem></MensagemRetorno></ListaMensagemRetorno></${raiz}>`;

test('mensagens: leitura de respostas (embutida, direta, vazia) e classificação de erros', () => {
  const comp = compNfse202();
  const embutida = envelope(`<ConsultarNfseServicoPrestadoResponse xmlns="http://nfse.abrasf.org.br"><outputXML>${escaparXml(respPrestadas([comp, compNfse202({ numero: 1002 })], 2))}</outputXML></ConsultarNfseServicoPrestadoResponse>`);
  const r1 = lerResposta(P202, 'prestadas', { status: 200, corpo: embutida });
  assert.equal(r1.compNfse.length, 2);
  assert.equal(r1.proximaPagina, 2);
  assert.match(r1.compNfse[0], /^<CompNfse/);
  const r2 = lerResposta(P202, 'prestadas', { status: 200, corpo: envelope(respPrestadas([comp])) });
  assert.equal(r2.compNfse.length, 1);
  assert.equal(r2.proximaPagina, null);
  assert.deepEqual(lerResposta(P202, 'prestadas', { status: 200, corpo: envelope(mensagemRetorno('E160', 'Nenhuma NFS-e encontrada para os filtros informados')) }).compNfse, []);

  const erro = (corpo, status = 200) => {
    try { lerResposta(P202, 'prestadas', { status, corpo }); } catch (e) { assert.ok(e instanceof ErroConector); return `${e.codigo}/${e.subcodigo}`; }
    return 'sem erro';
  };
  assert.equal(erro(envelope(mensagemRetorno('E045', 'Certificado digital não autorizado para o contribuinte'))), 'ERRO_AUTENTICACAO/ACESSO_NEGADO');
  assert.equal(erro(envelope(mensagemRetorno('E999', 'Data inicial maior que data final'))), 'DADO_INCONSISTENTE/MENSAGEM_RETORNO');
  assert.equal(erro(envelope('<s:Fault><faultcode>s:Client</faultcode><faultstring>Server was unable to read request</faultstring></s:Fault>'), 500), 'DADO_INCONSISTENTE/SOAP_FAULT');
  assert.equal(erro('<html><body>Em manutenção</body></html>', 503), 'PORTAL_INDISPONIVEL/HTML_NO_LUGAR_DE_XML');
  assert.equal(erro('<!DOCTYPE html><html>login</html>', 200), 'MUDANCA_LAYOUT/HTML_NO_LUGAR_DE_XML');
  assert.equal(erro(envelope('<OutraCoisa>ok</OutraCoisa>')), 'MUDANCA_LAYOUT/RESPOSTA_INESPERADA');
  assert.equal(erro('', 403), 'ERRO_AUTENTICACAO/ACESSO_NEGADO');
  assert.equal(erro('', 502), 'PORTAL_INDISPONIVEL/SERVIDOR_FORA');
});

test('janelas de período e contrato do conector', () => {
  assert.deepEqual(janelas('2026-01-01', '2026-03-05', 30), [
    { de: '2026-01-01', ate: '2026-01-30' }, { de: '2026-01-31', ate: '2026-03-01' }, { de: '2026-03-02', ate: '2026-03-05' },
  ]);
  assert.deepEqual(janelas('2026-03-05', '2026-03-05', 30), [{ de: '2026-03-05', ate: '2026-03-05' }]);
  assert.throws(() => janelas('2026-03-05', '2026-03-01', 30), /Período inválido/);
  const c = criarConectorMunicipal({ municipio: { ibge: '1', nome: 'X', perfil: 'abrasf-1.00', url: 'https://x.invalid/ws' }, credenciais: { cert: '', key: '', cnpj: CNPJ_TESTE } });
  assert.equal(verificarContrato(c), true);
  assert.equal(c.capacidades().notas_tomadas, 'NAO_SUPORTADO');
  c.fechar();
  assert.throws(() => criarConectorMunicipal({ municipio: { perfil: 'abrasf-2.02', url: 'http://inseguro/ws' }, credenciais: {} }), (e) => e.subcodigo === 'URL_INVALIDA');
  assert.equal(periodoPadrao({ ultima_data: '2026-03-20' }, new Date('2026-03-25T12:00:00Z')).de, '2026-03-15');
});

// ---------- prefeitura simulada (HTTPS + mTLS) ----------
function certificadoServidor() {
  const chaves = forge.pki.rsa.generateKeyPair(1024);
  const c = forge.pki.createCertificate();
  c.publicKey = chaves.publicKey;
  c.serialNumber = '03';
  c.validity.notBefore = new Date(Date.now() - 86_400_000);
  c.validity.notAfter = new Date(Date.now() + 86_400_000);
  c.setSubject([{ name: 'commonName', value: 'localhost' }]);
  c.setIssuer([{ name: 'commonName', value: 'localhost' }]);
  c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  c.sign(chaves.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(c), key: forge.pki.privateKeyToPem(chaves.privateKey) };
}

/** Prefeitura ABRASF 2.02 simulada: `notas` = { prestadas: [...xml], tomadas: [...xml] }, 2 por página. */
async function prefeituraSimulada(notas, { porPagina = 2, comportamento } = {}) {
  const tls = certificadoServidor();
  const pedidos = [];
  const srv = https.createServer({ ...tls, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    let corpo = '';
    req.on('data', (c) => (corpo += c));
    req.on('end', () => {
      const env = parser.parse(corpo).Envelope.Body;
      const [operacao] = Object.keys(env);
      const papel = operacao.includes('Tomado') ? 'tomadas' : 'prestadas';
      const dados = parser.parse(env[operacao].nfseDadosMsg);
      const envio = Object.values(dados)[0];
      const pagina = Number(envio.Pagina ?? 1);
      const cn = req.socket.getPeerCertificate()?.subject?.CN;
      pedidos.push({ papel, pagina, de: envio.PeriodoEmissao?.DataInicial, ate: envio.PeriodoEmissao?.DataFinal, cn, soapAction: req.headers.soapaction });
      if (comportamento) return comportamento(req, res, { papel, pagina });
      const lista = (notas[papel] ?? []).filter((x) => {
        const d = x.match(/<DataEmissao>(\d{4}-\d{2}-\d{2})T/)[1];
        return d >= envio.PeriodoEmissao.DataInicial && d <= envio.PeriodoEmissao.DataFinal;
      });
      const pag = lista.slice((pagina - 1) * porPagina, pagina * porPagina);
      const raiz = papel === 'tomadas' ? 'ConsultarNfseServicoTomadoResposta' : 'ConsultarNfseServicoPrestadoResposta';
      const resposta = pag.length
        ? `<${raiz} xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaNfse>${pag.join('')}${lista.length > pagina * porPagina ? `<ProximaPagina>${pagina + 1}</ProximaPagina>` : ''}</ListaNfse></${raiz}>`
        : mensagemRetorno('E160', 'Nenhuma NFS-e encontrada', raiz);
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(envelope(`<${operacao.replace('Request', 'Response')} xmlns="http://nfse.abrasf.org.br"><outputXML>${escaparXml(resposta)}</outputXML></${operacao.replace('Request', 'Response')}>`));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `https://localhost:${srv.address().port}/nfse/ws`, ca: tls.cert, pedidos };
}

function cenario() {
  const amb = ambienteTeste();
  const { id } = cadastrarEmpresa(amb.repo, { pfx: gerarPfx(), senha: '1234' });
  return { ...amb, id, empresa: amb.repo.obterEmpresa(id) };
}
const conectorTeste = (ca) => (cfg) => criarConectorMunicipal(cfg, { ca, esperar: async () => {} });

test('busca na prefeitura: mTLS, janelas, paginação, prestadas e tomadas, cancelamento, conferência e auditoria', async () => {
  const { repo, dataDir, id } = cenario();
  const notas = {
    prestadas: [
      compNfse202({ numero: 1, prestador: CNPJ_TESTE, prestadorNome: 'EMPRESA TESTE LTDA', tomador: '04252011000110', tomadorNome: 'CLIENTE', item: '1.07', data: '2026-01-10' }),
      compNfse202({ numero: 2, prestador: CNPJ_TESTE, tomador: '04252011000110', item: '1.07', data: '2026-01-11' }),
      compNfse202({ numero: 3, prestador: CNPJ_TESTE, tomador: '04252011000110', item: '1.07', data: '2026-01-12', cancelada: '2026-03-01' }),
      compNfse202({ numero: 4, prestador: CNPJ_TESTE, tomador: '04252011000110', item: '1.07', data: '2026-02-20' }),
    ],
    tomadas: [compNfse202({ numero: 900, item: '7.02', retido: false, data: '2026-02-03' })],
  };
  const pref = await prefeituraSimulada(notas);
  try {
    repo.salvarMunicipio({ ibge: '4205407', nome: 'Florianópolis', uf: 'SC', perfil: 'abrasf-2.02', url: pref.url, opcoes: { janelaDias: 31 } });
    const vid = repo.salvarVinculo({ empresaId: id, ibge: '4205407', inscricaoMunicipal: '123' });

    const r = await sincronizarMunicipal(repo, vid, { de: '2026-01-01', ate: '2026-02-28', criarConector: conectorTeste(pref.ca), dataDir });
    assert.equal(r.codigo, 'SUCESSO');
    assert.deepEqual(r.porPapel, { prestadas: { notas: 4, novas: 4 }, tomadas: { notas: 1, novas: 1 } });
    // 2 janelas (jan, fev); jan tem 3 notas → 2 páginas
    const pagsPrest = pref.pedidos.filter((p) => p.papel === 'prestadas').map((p) => `${p.de}:${p.pagina}`);
    assert.deepEqual(pagsPrest, ['2026-01-01:1', '2026-01-01:2', '2026-02-01:1']);
    assert.equal(pref.pedidos[0].cn, `EMPRESA TESTE LTDA:${CNPJ_TESTE}`, 'certificado A1 enviado na conexão');
    assert.equal(pref.pedidos[0].soapAction, '"http://nfse.abrasf.org.br/ConsultarNfseServicoPrestado"');

    const { itens } = repo.listarDocumentos({ empresaId: id, limite: 50 });
    assert.equal(itens.length, 5);
    assert.ok(itens.every((d) => d.sistema === 'abrasf' && d.origem === 'prefeitura'));
    assert.equal(itens.filter((d) => d.papel === 'emitida').length, 4);
    const tomada = itens.find((d) => d.papel === 'recebida');
    assert.equal(tomada.codigo_verificacao, 'CV-900');
    const cancelada = itens.find((d) => d.numero === '3');
    assert.equal(cancelada.situacao, 'cancelada');

    // conferência: RET-001 (tomada 7.02 sem retenção) e CAN-001 (cancelada em mês posterior)
    const div = repo.listarDivergencias({ empresaId: id }).itens.map((d) => d.codigo).sort();
    assert.deepEqual(div, ['CAN-001', 'RET-001']);

    assert.equal(repo.obterVinculo(vid).ultima_data, '2026-02-28');
    const x = repo.listarExecucoes({ empresaId: id })[0];
    assert.equal(x.tipo, 'busca_municipal');
    assert.equal(x.municipio_nome, 'Florianópolis');
    const [aud] = listarAuditoria(repo.db, { tipo: 'execucao.finalizada' });
    assert.equal(aud.payload.rotina, 'busca_municipal');
    assert.equal(aud.payload.municipio.ibge, '4205407');
    assert.match(aud.payload.conector, /^abrasf-2\.02@/);

    // segunda busca: nada novo, eventos não duplicam
    const r2 = await sincronizarMunicipal(repo, vid, { de: '2026-01-01', ate: '2026-02-28', criarConector: conectorTeste(pref.ca), dataDir });
    assert.equal(r2.codigo, 'SEM_MOVIMENTO');
    assert.equal(r2.atualizados, 5);
    assert.equal(repo.listarEventos(id, cancelada.chave).length, 1);
    assert.equal(verificarAuditoria(repo.db).integra, true);

    // teste de conexão
    const t = await testarVinculo(repo, vid, { criarConector: conectorTeste(pref.ca) });
    assert.equal(t.ok, true);
    assert.match(t.mensagem, /Conexão OK com Florianópolis/);
  } finally {
    pref.srv.close();
    limpar(dataDir);
  }
});

test('busca na prefeitura: SOAP Fault, HTML de manutenção (com novas tentativas) e ABRASF 1.00 sem tomadas', async () => {
  const { repo, dataDir, id } = cenario();
  let chamadas = 0;
  const pref = await prefeituraSimulada({}, {
    comportamento: (req, res) => {
      chamadas++;
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.end('<html><body>Sistema em manutenção</body></html>');
    },
  });
  try {
    repo.salvarMunicipio({ ibge: '1111111', nome: 'Cidade Fora', perfil: 'abrasf-2.02', url: pref.url });
    const vid = repo.salvarVinculo({ empresaId: id, ibge: '1111111' });
    await assert.rejects(
      sincronizarMunicipal(repo, vid, { de: '2026-01-01', ate: '2026-01-05', criarConector: conectorTeste(pref.ca), dataDir }),
      (e) => e.codigo === 'PORTAL_INDISPONIVEL' && e.subcodigo === 'HTML_NO_LUGAR_DE_XML',
    );
    assert.equal(chamadas, 3, 'tentou 3 vezes antes de desistir');
    const x = repo.obterExecucao(repo.listarExecucoes({ empresaId: id })[0].id);
    assert.equal(x.codigo, 'PORTAL_INDISPONIVEL');
    assert.equal(x.detalhes.falhas_transitorias.length, 2);
    assert.equal(repo.obterVinculo(vid).ultima_data, null, 'não avança o período quando falha');
  } finally {
    pref.srv.close();
  }

  const fault = await prefeituraSimulada({}, {
    comportamento: (req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      res.end(envelope('<s:Fault><faultcode>s:Client</faultcode><faultstring>Elemento inválido: Pagina</faultstring></s:Fault>'));
    },
  });
  try {
    repo.salvarMunicipio({ ibge: '2222222', nome: 'Cidade Fault', perfil: 'abrasf-2.02', url: fault.url });
    const vid = repo.salvarVinculo({ empresaId: id, ibge: '2222222' });
    await assert.rejects(sincronizarMunicipal(repo, vid, { de: '2026-01-01', ate: '2026-01-05', criarConector: conectorTeste(fault.ca), dataDir }), (e) => e.codigo === 'DADO_INCONSISTENTE' && e.subcodigo === 'SOAP_FAULT');
  } finally {
    fault.srv.close();
  }

  // ABRASF 1.00: envelope direto, só prestadas
  const v100 = await (async () => {
    const tls = certificadoServidor();
    const srv = https.createServer({ ...tls, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      let corpo = '';
      req.on('data', (c) => (corpo += c));
      req.on('end', () => {
        assert.ok(corpo.includes('<ConsultarNfseEnvio xmlns="http://www.abrasf.org.br/ABRASF/arquivos/nfse.xsd">'), 'XML direto no Body');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(envelope(`<ConsultarNfseResposta xmlns="http://www.abrasf.org.br/ABRASF/arquivos/nfse.xsd"><ListaNfse>${fixture('abrasf-100-compnfse.xml').replace(/<\?xml[^>]*\?>/, '')}</ListaNfse></ConsultarNfseResposta>`));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { srv, url: `https://localhost:${srv.address().port}/ws`, ca: tls.cert };
  })();
  try {
    repo.salvarMunicipio({ ibge: '3106200', nome: 'Belo Horizonte', perfil: 'abrasf-1.00', url: v100.url });
    const vid = repo.salvarVinculo({ empresaId: id, ibge: '3106200' });
    const r = await sincronizarMunicipal(repo, vid, { de: '2025-11-01', ate: '2025-11-30', criarConector: conectorTeste(v100.ca), dataDir });
    assert.equal(r.codigo, 'SUCESSO');
    assert.equal(r.porPapel.tomadas, 'NAO_SUPORTADO');
    assert.match(r.mensagem, /tomadas: não disponível/);
    // nota cancelada não passa pelas regras de retenção: só o alerta de cancelamento fora do mês
    const div = repo.listarDivergencias({ empresaId: id }).itens.map((d) => d.codigo).sort();
    assert.deepEqual(div, ['CAN-001']);
  } finally {
    v100.srv.close();
    limpar(dataDir);
  }
});

test('DUP-001: a mesma prestação vinda do ADN e da prefeitura é sinalizada', async () => {
  const { repo, dataDir, id, empresa } = cenario();
  try {
    registrarNfse(repo, empresa, { xml: fixture('nfse-exemplo.xml') }, dataDir); // ADN: 15/03/2026, 10.000,00
    const pref = await prefeituraSimulada({
      prestadas: [compNfse202({ numero: 12, prestador: CNPJ_TESTE, tomador: '04252011000110', item: '1.01', data: '2026-03-15', valor: 10000, aliquota: '2.00' })],
    });
    try {
      repo.salvarMunicipio({ ibge: '3550308', nome: 'São Paulo', perfil: 'abrasf-2.02', url: pref.url });
      const vid = repo.salvarVinculo({ empresaId: id, ibge: '3550308' });
      await sincronizarMunicipal(repo, vid, { de: '2026-03-01', ate: '2026-03-31', criarConector: conectorTeste(pref.ca), dataDir });
    } finally {
      pref.srv.close();
    }
    const dups = repo.listarDivergencias({ empresaId: id, codigo: 'DUP-001' }).itens;
    assert.equal(dups.length, 2, 'as duas notas recebem o alerta');
    assert.ok(dups.every((d) => d.severidade === 'ALERTA'));
  } finally {
    limpar(dataDir);
  }
});

test('lote: "buscar todas" também consulta as prefeituras vinculadas', async () => {
  const { repo, dataDir, id } = cenario();
  const pref = await prefeituraSimulada({ prestadas: [compNfse202({ numero: 7, prestador: CNPJ_TESTE, tomador: '04252011000110', item: '1.07', data: new Date().toISOString().slice(0, 10) })] });
  try {
    repo.salvarMunicipio({ ibge: '4205407', nome: 'Florianópolis', perfil: 'abrasf-2.02', url: pref.url });
    repo.salvarVinculo({ empresaId: id, ibge: '4205407' });
    const adnVazio = () => ({ fechar() {}, async distribuicao() { return { documentos: [] }; } });
    const res = await sincronizarTodas(repo, { criarCliente: adnVazio, intervaloMs: 0, dataDir, criarConectorMunicipal: conectorTeste(pref.ca) });
    assert.deepEqual(res.map((r) => [r.fonte, r.codigo]), [['ADN', 'SEM_MOVIMENTO'], ['Florianópolis', 'SUCESSO']]);
    const [lote] = listarAuditoria(repo.db, { tipo: 'lote.finalizado' });
    assert.deepEqual(lote.payload.empresas.map((e) => e.fonte), ['ADN', 'Florianópolis']);
  } finally {
    pref.srv.close();
    limpar(dataDir);
  }
});

test('API: perfis, municípios, vínculos e auditoria das alterações', async () => {
  const { repo, dataDir, id } = cenario();
  const srv = criarServidor(repo, { dataDir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (caminho, metodo = 'GET', corpo) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { 'X-Buscador': '1', 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, dados: await r.json() };
  };
  try {
    const perfis = await req('/api/perfis');
    assert.ok(perfis.dados.perfis.some((p) => p.id === 'abrasf-2.04' && p.tomadas));
    assert.equal(perfis.dados.opcoesPadrao.janelaDias, 30);

    assert.equal((await req('/api/municipios', 'POST', { ibge: '42', nome: 'X', perfil: 'abrasf-2.02', url: 'https://a/b' })).status, 400, 'IBGE com 7 dígitos');
    assert.equal((await req('/api/municipios', 'POST', { ibge: '4205407', nome: 'Floripa', perfil: 'abrasf-9', url: 'https://a/b' })).status, 400, 'perfil inválido');
    assert.equal((await req('/api/municipios', 'POST', { ibge: '4205407', nome: 'Floripa', perfil: 'abrasf-2.02', url: 'http://a/b' })).status, 400, 'só https');
    const m = await req('/api/municipios', 'POST', { ibge: '4205407', nome: 'Florianópolis', uf: 'sc', perfil: 'abrasf-2.02', url: 'https://ws.exemplo.gov.br/nfse', opcoes: { soapVersao: '1.2', janelaDias: '15', lixo: 'x' } });
    assert.equal(m.status, 200);
    assert.equal(m.dados.uf, 'SC');
    assert.deepEqual(m.dados.opcoes, { soapVersao: '1.2', janelaDias: 15 }, 'só opções conhecidas, com tipo certo');

    const v = await req('/api/vinculos', 'POST', { empresa: id, ibge: '4205407', inscricaoMunicipal: '123' });
    assert.equal(v.status, 200);
    const lista = await req(`/api/vinculos?empresa=${id}`);
    assert.equal(lista.dados[0].municipio_nome, 'Florianópolis');
    assert.equal((await req('/api/municipios/4205407', 'DELETE')).status, 400, 'não exclui com vínculo');
    assert.equal((await req(`/api/vinculos/${v.dados.id}`, 'DELETE')).status, 200);
    assert.equal((await req('/api/municipios/4205407', 'DELETE')).status, 200);

    const tipos = listarAuditoria(repo.db, { limite: 10 }).map((a) => a.tipo);
    assert.deepEqual(tipos.slice(0, 4), ['municipio.excluido', 'vinculo.excluido', 'vinculo.salvo', 'municipio.salvo']);
  } finally {
    srv.close();
    limpar(dataDir);
  }
});
