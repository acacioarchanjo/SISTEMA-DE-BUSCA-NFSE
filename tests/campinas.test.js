// Integração Campinas/SP (ABRASF 2.03, sistema IMA): envelope específico, assinatura e configuração conhecida.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import forge from 'node-forge';
import { XMLParser } from 'fast-xml-parser';
import { assinarXml, verificarAssinatura } from '../src/conectores/assinatura.js';
import { montarEnvio, montarEnvelope } from '../src/conectores/abrasf/mensagens.js';
import { obterPerfil, opcoesEfetivas } from '../src/conectores/abrasf/perfis.js';
import { municipioConhecido, difereDaRecomendada } from '../src/conectores/municipios-conhecidos.js';
import { criarConectorMunicipal } from '../src/conectores/registro.js';
import { sincronizarMunicipal, testarVinculo } from '../src/conectores/sincronizacao.js';
import { cadastrarEmpresa, abrirCredenciais } from '../src/crypto/credenciais.js';
import { listarAuditoria } from '../src/auditoria.js';
import { criarServidor } from '../src/server/app.js';
import { ambienteTeste, gerarPfx, CNPJ_TESTE, limpar } from './ajuda.js';
import { compNfse202 } from './abrasf-modelo.js';

const CAMPINAS = '3509502';
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });

test('assinatura XMLDSig: enveloped, URI vazia, RSA-SHA1/C14N, verificável e detecta adulteração', () => {
  const { repo, dataDir, id } = (() => { const a = ambienteTeste(); const { id } = cadastrarEmpresa(a.repo, { pfx: gerarPfx(), senha: '1234' }); return { ...a, id }; })();
  try {
    const cred = abrirCredenciais(repo, id);
    const envio = montarEnvio(obterPerfil('abrasf-2.03'), 'prestadas', { cnpj: CNPJ_TESTE, de: '2026-01-01', ate: '2026-01-31', pagina: 1, periodo: 'emissao' });
    const assinado = assinarXml(envio, cred, { elemento: 'ConsultarNfseServicoPrestadoEnvio' });
    assert.match(assinado, /<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
    assert.match(assinado, /<Reference URI="">/);
    assert.match(assinado, /rsa-sha1/);
    assert.match(assinado, /REC-xml-c14n-20010315/);
    assert.match(assinado, /<X509Certificate>/);
    assert.match(assinado, /<\/Signature><\/ConsultarNfseServicoPrestadoEnvio>$/, 'Signature é o último filho da raiz');
    assert.equal(verificarAssinatura(assinado, cred.cert), true);
    assert.equal(verificarAssinatura(assinado.replace('2026-01-31', '2026-02-28'), cred.cert), false, 'alterar o conteúdo invalida');
    assert.match(assinarXml(envio, cred, { elemento: 'ConsultarNfseServicoPrestadoEnvio', algoritmo: 'sha256' }), /rsa-sha256/);
  } finally {
    limpar(dataDir);
  }
});

test('Campinas: configuração conhecida gera o envelope que a prefeitura espera', () => {
  const c = municipioConhecido(CAMPINAS);
  assert.equal(c.perfil, 'abrasf-2.03');
  assert.equal(c.url, 'https://novanfse.campinas.sp.gov.br/notafiscal-abrasfv203-ws/NotaFiscalSoap');
  const perfil = obterPerfil(c.perfil);
  const envio = montarEnvio(perfil, 'prestadas', { cnpj: CNPJ_TESTE, de: '2026-01-01', ate: '2026-01-31', pagina: 1, periodo: 'emissao' });
  const { corpo, headers } = montarEnvelope(perfil, 'prestadas', envio, opcoesEfetivas(perfil, c.opcoes));
  assert.equal(headers['Content-Type'], 'text/xml; charset=utf-8');
  assert.equal(headers.SOAPAction, '""', 'SOAP 1.1 com SOAPAction vazio');
  assert.ok(corpo.includes('<soap:Body><ConsultarNfseServicoPrestado xmlns="http://nfse.abrasf.org.br"><ConsultarNfseServicoPrestadoEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">'));
  assert.ok(!corpo.includes('nfseCabecMsg'));

  assert.equal(difereDaRecomendada({ ibge: CAMPINAS, perfil: 'abrasf-2.02', url: c.url, opcoes: {} }), true);
  assert.equal(difereDaRecomendada({ ibge: CAMPINAS, perfil: c.perfil, url: `${c.url}?wsdl`, opcoes: { ...c.opcoes, assinarConsulta: true } }), false);
  assert.equal(difereDaRecomendada({ ibge: '9999999', perfil: 'x', url: 'y' }), false);
});

// ---------- servidor que imita a prefeitura de Campinas ----------
function tlsServidor() {
  const ch = forge.pki.rsa.generateKeyPair(1024);
  const c = forge.pki.createCertificate();
  c.publicKey = ch.publicKey; c.serialNumber = '05';
  c.validity.notBefore = new Date(Date.now() - 864e5); c.validity.notAfter = new Date(Date.now() + 864e5);
  c.setSubject([{ name: 'commonName', value: 'localhost' }]); c.setIssuer([{ name: 'commonName', value: 'localhost' }]);
  c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  c.sign(ch.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(c), key: forge.pki.privateKeyToPem(ch.privateKey) };
}
const pemDe = (raw) => `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

async function campinasSimulada(notas) {
  const tls = tlsServidor();
  const pedidos = [];
  const srv = https.createServer({ ...tls, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    let corpo = '';
    req.on('data', (x) => (corpo += x));
    req.on('end', () => {
      const body = parser.parse(corpo).Envelope.Body;
      const [op] = Object.keys(body);
      const envioNome = `${op}Envio`;
      const envioXml = corpo.match(new RegExp(`<${envioNome}[\\s\\S]*</${envioNome}>`))?.[0];
      const assinado = /<Signature/.test(envioXml ?? '');
      const valida = assinado && verificarAssinatura(envioXml, pemDe(req.socket.getPeerCertificate().raw));
      pedidos.push({ op, soapAction: req.headers.soapaction, assinado, valida });
      res.writeHead(200, { 'Content-Type': 'text/xml;charset=UTF-8' });
      const resp = (inner) => `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns4:${op}Response xmlns:ns4="http://nfse.abrasf.org.br">${inner}</ns4:${op}Response></S:Body></S:Envelope>`;
      const raiz = `${op}Resposta`;
      if (!envioXml || req.headers.soapaction !== '""') {
        return res.end(resp(`<${raiz} xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno><MensagemRetorno><Codigo>E1</Codigo><Mensagem>Estrutura inválida</Mensagem></MensagemRetorno></ListaMensagemRetorno></${raiz}>`));
      }
      if (!valida) {
        return res.end(resp(`<${raiz} xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno><MensagemRetorno><Codigo>E513</Codigo><Mensagem>Assinatura digital do XML não encontrada ou inválida.</Mensagem></MensagemRetorno></ListaMensagemRetorno></${raiz}>`));
      }
      const lista = notas[op.includes('Tomado') ? 'tomadas' : 'prestadas'] ?? [];
      res.end(resp(lista.length
        ? `<${raiz} xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaNfse>${lista.join('')}</ListaNfse></${raiz}>`
        : `<${raiz} xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno><MensagemRetorno><Codigo>E160</Codigo><Mensagem>Não foram encontradas NFS-e para os parâmetros informados.</Mensagem></MensagemRetorno></ListaMensagemRetorno></${raiz}>`));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `https://localhost:${srv.address().port}/notafiscal-abrasfv203-ws/NotaFiscalSoap`, ca: tls.cert, pedidos };
}

test('Campinas: configuração errada é sinalizada; a recomendada funciona e a assinatura é detectada e lembrada', async () => {
  const amb = ambienteTeste();
  const { repo, dataDir } = amb;
  const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
  const hoje = new Date().toISOString().slice(0, 10);
  const pref = await campinasSimulada({
    prestadas: [compNfse202({ numero: 501, prestador: CNPJ_TESTE, tomador: '04252011000110', item: '1.07', data: hoje, ibge: CAMPINAS })],
    tomadas: [compNfse202({ numero: 77, item: '17.05', data: hoje, ibge: CAMPINAS })],
  });
  const criar = (cfg) => criarConectorMunicipal(cfg, { ca: pref.ca, esperar: async () => {} });
  try {
    // 1) como o usuário cadastrou: ABRASF 2.02 genérico → recusado (estrutura)
    repo.salvarMunicipio({ ibge: CAMPINAS, nome: 'Campinas', uf: 'SP', perfil: 'abrasf-2.02', url: pref.url });
    const vid = repo.salvarVinculo({ empresaId: id, ibge: CAMPINAS });
    await assert.rejects(testarVinculo(repo, vid, { criarConector: criar }), (e) => e.codigo === 'DADO_INCONSISTENTE' && /Estrutura inválida/.test(e.message));

    // 2) configuração recomendada (envelope de Campinas), URL do servidor simulado
    const rec = municipioConhecido(CAMPINAS);
    repo.salvarMunicipio({ ibge: CAMPINAS, nome: rec.nome, uf: rec.uf, perfil: rec.perfil, url: pref.url, opcoes: rec.opcoes });
    const t = await testarVinculo(repo, vid, { criarConector: criar });
    assert.equal(t.ok, true);
    assert.equal(t.assinaturaDetectada, true);
    assert.match(t.mensagem, /assinatura foi ativada automaticamente/);
    assert.deepEqual(pref.pedidos.slice(-2).map((p) => [p.assinado, p.valida]), [[false, false], [true, true]], '1ª sem assinatura (recusada), 2ª assinada e válida');
    assert.equal(repo.obterMunicipio(CAMPINAS).opcoes.assinarConsulta, true, 'lembrado no cadastro');
    assert.equal(listarAuditoria(repo.db, { tipo: 'municipio.assinatura_detectada' }).length, 1);

    // 3) busca: já sai assinada desde a 1ª consulta
    const antes = pref.pedidos.length;
    const r = await sincronizarMunicipal(repo, vid, { de: hoje, ate: hoje, criarConector: criar, dataDir });
    assert.equal(r.codigo, 'SUCESSO');
    assert.deepEqual(r.porPapel, { prestadas: { notas: 1, novas: 1 }, tomadas: { notas: 1, novas: 1 } });
    assert.ok(pref.pedidos.slice(antes).every((p) => p.assinado && p.valida && p.soapAction === '""'));
    const div = repo.listarDivergencias({ empresaId: id }).itens.map((d) => d.codigo);
    assert.deepEqual(div, ['RET-001'], 'tomada 17.05 sem retenção');
  } finally {
    pref.srv.close();
    limpar(dataDir);
  }
});

test('API: municípios conhecidos, aviso de configuração diferente e aplicação da recomendada', async () => {
  const { repo, dataDir } = ambienteTeste();
  const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
  const srv = criarServidor(repo, { dataDir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (c, m = 'GET', corpo) => {
    const r = await fetch(base + c, { method: m, headers: { 'X-Buscador': '1', 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, dados: await r.json() };
  };
  try {
    assert.ok((await req('/api/municipios/conhecidos')).dados.some((m) => m.ibge === CAMPINAS && m.nome === 'Campinas'));
    // cadastro como o usuário fez (2.02 genérico, URL com ?wsdl) + assinatura já aprendida
    repo.salvarMunicipio({ ibge: CAMPINAS, nome: 'Campinas', uf: 'SP', perfil: 'abrasf-2.02', url: 'https://novanfse.campinas.sp.gov.br/notafiscal-abrasfv203-ws/NotaFiscalSoap', opcoes: { assinarConsulta: true } });
    await req('/api/vinculos', 'POST', { empresa: id, ibge: CAMPINAS });
    let [v] = (await req(`/api/vinculos?empresa=${id}`)).dados;
    assert.equal(v.recomendacao_disponivel, true);
    assert.equal(v.assinar_consulta, true);
    const m = await req(`/api/municipios/${CAMPINAS}/recomendada`, 'POST');
    assert.equal(m.dados.perfil, 'abrasf-2.03');
    assert.equal(m.dados.opcoes.estilo, 'direto');
    assert.equal(m.dados.opcoes.soapAction, '');
    assert.equal(m.dados.opcoes.assinarConsulta, true, 'mantém a assinatura aprendida');
    [v] = (await req(`/api/vinculos?empresa=${id}`)).dados;
    assert.equal(v.recomendacao_disponivel, false);
    assert.equal((await req('/api/municipios/1234567/recomendada', 'POST')).status, 404);
  } finally {
    srv.close();
    limpar(dataDir);
  }
});

test('mensagens de retorno: "assinatura não encontrada" é erro; "nenhuma NFS-e encontrada" é vazio', async () => {
  const { classificarMensagens } = await import('../src/conectores/abrasf/mensagens.js');
  const c = (msg) => { const r = classificarMensagens([{ codigo: 'E', mensagem: msg }]); return r.vazio ? 'vazio' : `${r.codigo}/${r.subcodigo}`; };
  assert.equal(c('Assinatura digital do XML não encontrada ou inválida.'), 'DADO_INCONSISTENTE/ASSINATURA_EXIGIDA');
  assert.equal(c('Certificado digital não encontrado no cadastro do contribuinte'), 'ERRO_AUTENTICACAO/ACESSO_NEGADO');
  assert.equal(c('Prestador não encontrado'), 'DADO_INCONSISTENTE/MENSAGEM_RETORNO', 'prestador não encontrado não é "sem notas"');
  assert.equal(c('Nenhuma NFS-e encontrada para os filtros informados'), 'vazio');
  assert.equal(c('Não foram encontradas NFS-e para os parâmetros informados.'), 'vazio');
  assert.equal(c('NFS-e não encontrada'), 'vazio');
  assert.equal(c('Não há notas no período'), 'vazio');
  assert.equal(c('Data inicial maior que data final'), 'DADO_INCONSISTENTE/MENSAGEM_RETORNO');
});
