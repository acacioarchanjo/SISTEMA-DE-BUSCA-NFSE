// Fase 1 do roteiro: catálogo de status, log de auditoria e regras fiscais RET/ALQ/CMP/CAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { avaliarNota, subitemDe } from '../src/fiscal/regras.js';
import { validarDocumentos } from '../src/fiscal/validacao.js';
import { classificarErro, classificarSucesso, statusLegado } from '../src/execucao/catalogo.js';
import { registrarAuditoria, verificarAuditoria, listarAuditoria, mascararDocumento } from '../src/auditoria.js';
import { ErroAdn } from '../src/adn/cliente.js';
import { ErroCertificado } from '../src/crypto/certificado.js';
import { ErroCofre } from '../src/crypto/cofre.js';
import { ErroTrava, registrarNfse, registrarEvento, sincronizarEmpresa, sincronizarTodas } from '../src/adn/distribuicao.js';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { abrirBanco } from '../src/db/index.js';
import { criarServidor } from '../src/server/app.js';
import { ambienteTeste, gerarPfx, fixture, xmlRecebida, CHAVE_TESTE, limpar } from './ajuda.js';

// ---------- helpers ----------
const notaBase = (extra = {}) => ({
  situacao: 'normal', papel: 'recebida', competencia: '2026-03-15', data_emissao: '2026-03-15T10:00:00-03:00',
  codigo_servico: '070201', tomador_doc: '11222333000181', prestador_doc: '04252011000110', prestador_regime: '1',
  aliquota: 3, iss_retido: 0, tp_ret_issqn: '1', ...extra,
});
const codigos = (n, ctx) => avaliarNota(n, ctx).map((d) => d.codigo).sort();

/** Variações do XML de exemplo. */
const xmlCom = ({ cTribNac, tpRet, aliq, regime, dhEmi, base = fixture('nfse-exemplo.xml') } = {}) => {
  let x = base;
  if (cTribNac) x = x.replace('<cTribNac>010101</cTribNac>', `<cTribNac>${cTribNac}</cTribNac>`);
  if (tpRet) x = x.replace('<tpRetISSQN>1</tpRetISSQN>', `<tpRetISSQN>${tpRet}</tpRetISSQN>`);
  if (aliq) x = x.replace('<pAliqAplic>2.00</pAliqAplic>', `<pAliqAplic>${aliq}</pAliqAplic>`);
  if (regime) x = x.replace('<opSimpNac>1</opSimpNac>', `<opSimpNac>${regime}</opSimpNac>`);
  if (dhEmi) x = x.replace('<dhEmi>2026-03-15T10:00:00-03:00</dhEmi>', `<dhEmi>${dhEmi}</dhEmi>`);
  return x;
};

function empresaComNotas() {
  const amb = ambienteTeste();
  const { id } = cadastrarEmpresa(amb.repo, { pfx: gerarPfx(), senha: '1234' });
  return { ...amb, id, empresa: amb.repo.obterEmpresa(id) };
}

// ---------- regras ----------
test('regras: subitem a partir do cTribNac', () => {
  assert.equal(subitemDe('070201'), '7.02');
  assert.equal(subitemDe('170501'), '17.05');
  assert.equal(subitemDe('010101'), '1.01');
  assert.equal(subitemDe(null), null);
});

test('RET-001: retenção obrigatória faltando (bloqueante para a tomadora, alerta para a prestadora)', () => {
  const r = avaliarNota(notaBase());
  assert.deepEqual(r.map((d) => d.codigo), ['RET-001']);
  assert.equal(r[0].severidade, 'BLOQUEANTE');
  assert.equal(avaliarNota(notaBase({ papel: 'emitida' }))[0].severidade, 'ALERTA');
  assert.deepEqual(codigos(notaBase({ iss_retido: 1, tp_ret_issqn: '2' })), [], 'com retenção: ok');
  assert.deepEqual(codigos(notaBase({ codigo_servico: '010101' })), [], 'subitem fora da lista');
  assert.deepEqual(codigos(notaBase({ tomador_doc: '12345678909' })), [], 'tomador PF');
  assert.deepEqual(codigos(notaBase({ prestador_regime: '2' })), [], 'prestador MEI');
  assert.deepEqual(codigos(notaBase({ situacao: 'cancelada' })).filter((c) => c.startsWith('RET')), [], 'cancelada não gera RET');
});

test('RET-002/004/005: retenções sem responsabilidade, Simples fora da faixa, MEI', () => {
  assert.deepEqual(codigos(notaBase({ codigo_servico: '010101', iss_retido: 1 })), ['RET-002']);
  assert.deepEqual(codigos(notaBase({ tomador_doc: '12345678909', iss_retido: 1 })), ['RET-002']);
  assert.deepEqual(codigos(notaBase({ prestador_regime: '3', iss_retido: 1, aliquota: 1.5 })), ['RET-004']);
  assert.deepEqual(codigos(notaBase({ prestador_regime: '3', iss_retido: 1, aliquota: 3.1 })), []);
  assert.deepEqual(codigos(notaBase({ prestador_regime: '2', iss_retido: 1 })), ['RET-005']);
});

test('ALQ-001/002: alíquota mínima e máxima, com exceções', () => {
  assert.deepEqual(codigos(notaBase({ codigo_servico: '010101', aliquota: 1.5 })), ['ALQ-001']);
  assert.deepEqual(codigos(notaBase({ codigo_servico: '070201', aliquota: 1.5, iss_retido: 1 })), [], '7.02 é exceção');
  assert.deepEqual(codigos(notaBase({ codigo_servico: '010101', aliquota: 1.5, prestador_regime: '3' })), [], 'Simples segue os Anexos');
  assert.deepEqual(codigos(notaBase({ codigo_servico: '010101', aliquota: 0 })), [], 'alíquota zero (isenção/imunidade) não alerta');
  assert.deepEqual(codigos(notaBase({ codigo_servico: '010101', aliquota: 6 })), ['ALQ-002']);
  assert.deepEqual(codigos(notaBase({ codigo_servico: '010101', aliquota: 1.5, competencia: '2016-06-01', data_emissao: '2016-06-01' })), [], 'antes da LC 157');
});

test('CMP-001 e CAN-001: competência e cancelamento fora do mês', () => {
  const ok = notaBase({ codigo_servico: '010101' });
  assert.deepEqual(codigos({ ...ok, data_emissao: '2026-04-02T09:00:00-03:00' }), ['CMP-001']);
  assert.equal(avaliarNota({ ...ok, data_emissao: '2026-07-02' })[0].severidade, 'ALERTA', '3+ meses vira alerta');
  const cancelada = { ...ok, situacao: 'cancelada' };
  assert.deepEqual(codigos(cancelada, { eventos: [{ tipo_evento: '101101', data_evento: '2026-03-20T08:00:00-03:00' }] }), [], 'mesmo mês');
  const r = avaliarNota(cancelada, { eventos: [{ tipo_evento: '101101', data_evento: '2026-05-03T08:00:00-03:00' }] });
  assert.deepEqual(r.map((d) => [d.codigo, d.severidade]), [['CAN-001', 'BLOQUEANTE']]);
  assert.equal(avaliarNota(cancelada, { eventos: [] })[0].severidade, 'ALERTA', 'sem data do evento');
});

// ---------- catálogo ----------
test('catálogo: classificação de erros e de sucesso', () => {
  const c = (e) => { const r = classificarErro(e); return `${r.codigo}/${r.subcodigo}`; };
  assert.equal(c(new ErroCertificado('Certificado vencido em 01/01/2026.')), 'ERRO_AUTENTICACAO/CERT_VENCIDO');
  assert.equal(c(new ErroCertificado('Senha do certificado incorreta')), 'ERRO_AUTENTICACAO/CERT_SENHA');
  assert.equal(c(new ErroAdn('negado', { status: 403 })), 'ERRO_AUTENTICACAO/ACESSO_NEGADO');
  assert.equal(c(new ErroAdn('x', { consumoIndevido: true, status: 429 })), 'LIMITE_CONSUMO/CONSUMO_INDEVIDO');
  assert.equal(c(new ErroAdn('Servidor', { status: 503, temporario: true })), 'PORTAL_INDISPONIVEL/SERVIDOR_FORA');
  assert.equal(c(new ErroAdn('Falha de rede: ENOTFOUND getaddrinfo ENOTFOUND adn.nfse.gov.br')), 'PORTAL_INDISPONIVEL/SEM_CONEXAO');
  assert.equal(c(new ErroAdn('Tempo esgotado na comunicação', { temporario: true })), 'PORTAL_INDISPONIVEL/TIMEOUT');
  assert.equal(c(new ErroAdn('ADN rejeitou a consulta: E123')), 'DADO_INCONSISTENTE/REJEICAO_ADN');
  assert.equal(c(new ErroCofre('chave')), 'ERRO_CONFIGURACAO/CHAVE_MESTRA');
  assert.equal(c(new ErroTrava('Empresa travada até ...')), 'LIMITE_CONSUMO/PAUSA_ATIVA');
  assert.equal(c(new ErroTrava('Já existe uma busca em andamento')), 'EXIGE_ACAO_USUARIO/BUSCA_EM_ANDAMENTO');
  assert.equal(c(new TypeError('x is undefined')), 'ERRO_INTERNO/null');
  assert.equal(classificarSucesso({ novos: 0, eventos: 0, erros: [] }).codigo, 'SEM_MOVIMENTO');
  assert.equal(classificarSucesso({ novos: 2, erros: ['x'] }).codigo, 'SUCESSO_PARCIAL');
  assert.equal(statusLegado('LIMITE_CONSUMO'), 'travada');
  assert.equal(statusLegado('SEM_MOVIMENTO'), 'ok');
});

// ---------- validação no banco ----------
test('validação: grava divergências, mantém as ignoradas e resolve as que deixam de valer', () => {
  const { repo, dataDir, id, empresa } = empresaComNotas();
  try {
    // recebida, serviço 7.02, tomador PJ (a empresa), sem retenção → RET-001 bloqueante
    registrarNfse(repo, empresa, { xml: xmlCom({ base: xmlRecebida(), cTribNac: '070201' }) }, dataDir);
    // emitida com alíquota 6% → ALQ-002
    registrarNfse(repo, empresa, { xml: xmlCom({ aliq: '6.00' }) }, dataDir);
    let v = validarDocumentos(repo, { empresaId: id, dataDir });
    assert.equal(v.novas, 2);
    assert.deepEqual(v.abertas, { BLOQUEANTE: 2, ALERTA: 0, INFO: 0 });

    const { itens } = repo.listarDivergencias({ empresaId: id, status: 'aberta' });
    const ret = itens.find((d) => d.codigo === 'RET-001');
    assert.equal(ret.papel, 'recebida');
    assert.match(ret.mensagem, /subitem 7\.02/);
    assert.equal(ret.detalhes.fonte_legal, 'LC 116/2003, art. 6º, §2º, II');

    // pessoa ignora com motivo → revalidar não reabre
    repo.definirStatusDivergencia(ret.id, 'ignorada', 'Prestador imune, documento arquivado');
    v = validarDocumentos(repo, { empresaId: id, dataDir });
    assert.equal(v.novas, 0);
    assert.equal(repo.obterDivergencia(ret.id).status, 'ignorada');

    // nota passa a ter alíquota correta (dados atualizados) → ALQ-002 vira resolvida
    const alq = itens.find((d) => d.codigo === 'ALQ-002');
    repo.db.prepare('UPDATE documentos SET aliquota = 2 WHERE id = ?').run(alq.documento_id);
    v = validarDocumentos(repo, { empresaId: id, dataDir });
    assert.equal(v.resolvidas, 1);
    assert.equal(repo.obterDivergencia(alq.id).status, 'resolvida');
    assert.deepEqual(v.abertas, { BLOQUEANTE: 0, ALERTA: 0, INFO: 0 });

    // listagem de notas traz a contagem e filtra
    repo.db.prepare('UPDATE documentos SET aliquota = 6 WHERE id = ?').run(alq.documento_id);
    v = validarDocumentos(repo, { empresaId: id, dataDir });
    assert.equal(v.reabertas, 1);
    const docs = repo.listarDocumentos({ empresaId: id, divergencia: 'bloqueante' });
    assert.equal(docs.itens.length, 1);
    assert.equal(docs.itens[0].div_bloqueantes, 1);
  } finally {
    limpar(dataDir);
  }
});

test('validação: cancelamento em mês posterior gera CAN-001; notas antigas são completadas pelo XML', () => {
  const { repo, dataDir, id, empresa } = empresaComNotas();
  try {
    registrarNfse(repo, empresa, { xml: fixture('nfse-exemplo.xml') }, dataDir);
    registrarEvento(repo, empresa, { xml: fixture('evento-cancelamento.xml').replace('2026-03-20T08:59:00-03:00', '2026-05-04T10:00:00-03:00') }, dataDir);
    // simula nota gravada por versão antiga (sem os campos novos)
    repo.db.exec('UPDATE documentos SET prestador_regime = NULL, tp_ret_issqn = NULL');
    validarDocumentos(repo, { empresaId: id, dataDir });
    const d = repo.listarDocumentos({ empresaId: id }).itens[0];
    assert.equal(d.prestador_regime, '1', 'metadado recuperado do XML');
    assert.equal(d.situacao, 'cancelada');
    const div = repo.listarDivergencias({ empresaId: id }).itens.map((x) => x.codigo);
    assert.deepEqual(div, ['CAN-001']);
  } finally {
    limpar(dataDir);
  }
});

// ---------- auditoria ----------
test('auditoria: cadeia de hash, bloqueio de alteração, detecção de adulteração e remoção de segredos', () => {
  const { dataDir } = ambienteTeste();
  const arq = path.join(dataDir, 'aud.db');
  const db = abrirBanco(arq);
  try {
    registrarAuditoria(db, { tipo: 'teste.a', payload: { valor: 1, senha: 'segredo', aninhado: { cert_cifrado: 'v1:xxx', ok: true } } });
    registrarAuditoria(db, { tipo: 'teste.b', payload: { valor: 2 } });
    registrarAuditoria(db, { tipo: 'teste.c', payload: { valor: 3 } });
    assert.deepEqual(verificarAuditoria(db).integra, true);
    assert.equal(verificarAuditoria(db).total, 3);

    const [c, b, a] = listarAuditoria(db, { limite: 10 });
    assert.equal(a.payload.senha, '[removido]');
    assert.equal(a.payload.aninhado.cert_cifrado, '[removido]');
    assert.equal(a.payload.aninhado.ok, true);
    assert.equal(b.hash_anterior, a.hash_registro);
    assert.equal(c.hash_anterior, b.hash_registro);

    assert.throws(() => db.prepare("UPDATE auditoria SET payload = '{}' WHERE id = 2").run(), /não podem ser alterados/);
    assert.throws(() => db.prepare('DELETE FROM auditoria WHERE id = 2').run(), /não podem ser apagados/);

    // alguém com acesso ao arquivo remove o trigger e adultera: a verificação percebe
    db.exec('DROP TRIGGER auditoria_sem_update');
    db.prepare('UPDATE auditoria SET payload = ? WHERE id = 2').run(JSON.stringify({ tipo: 'teste.b', valor: 999 }));
    const v = verificarAuditoria(db);
    assert.equal(v.integra, false);
    assert.equal(v.problemaEm, 2);
    assert.equal(mascararDocumento('12345678909'), '***.456.789-**');
    assert.equal(mascararDocumento('11222333000181'), '11222333000181');
  } finally {
    db.close();
    limpar(dataDir);
  }
});

test('auditoria: cadastro de empresa registra evento sem dados do certificado', () => {
  const { repo, dataDir, id } = empresaComNotas();
  try {
    const [r] = listarAuditoria(repo.db, { tipo: 'empresa.cadastrada' });
    assert.equal(r.payload.empresa_id, id);
    assert.match(r.payload.certificado.valido_ate, /^\d{4}-/);
    assert.ok(!JSON.stringify(r.payload).includes('BEGIN'), 'nenhum PEM/chave no log');
    repo.excluirEmpresa(id, { motivo: 'teste' });
    assert.equal(listarAuditoria(repo.db, { tipo: 'empresa.excluida' })[0].payload.motivo, 'teste');
    assert.equal(verificarAuditoria(repo.db).integra, true);
  } finally {
    limpar(dataDir);
  }
});

// ---------- execução ponta a ponta ----------
const clienteFalso = (docs, { erro } = {}) => ({
  fechar() {},
  async distribuicao(nsu) {
    if (erro) throw erro;
    const lote = docs.filter((d) => d.nsu >= nsu).slice(0, 50);
    return lote.length ? { status: 'DOCUMENTOS_LOCALIZADOS', documentos: lote } : { status: 'NENHUM_DOCUMENTO', documentos: [] };
  },
});

test('execução: código do catálogo, detalhes, validação automática e auditoria por empresa e por lote', async () => {
  const { repo, dataDir, id } = empresaComNotas();
  try {
    const docs = [
      { nsu: 1, tipo: 'NFSE', xml: xmlCom({ base: xmlRecebida(), cTribNac: '070201' }) },
      { nsu: 2, tipo: 'NFSE', xml: '<lixo>' },
    ];
    const r = await sincronizarEmpresa(repo, id, { criarCliente: () => clienteFalso(docs), intervaloMs: 0, dataDir });
    assert.equal(r.codigo, 'SUCESSO_PARCIAL');
    assert.equal(r.validacao.abertas.BLOQUEANTE, 1);
    const x = repo.obterExecucao(r.execucaoId);
    assert.equal(x.codigo, 'SUCESSO_PARCIAL');
    assert.equal(x.status, 'ok');
    assert.equal(x.detalhes.documentos_com_erro.length, 1);
    assert.match(x.mensagem, /1 bloqueante/);

    // segunda busca sem nada novo → SEM_MOVIMENTO
    const r2 = await sincronizarEmpresa(repo, id, { criarCliente: () => clienteFalso(docs), intervaloMs: 0, dataDir });
    assert.equal(r2.codigo, 'SEM_MOVIMENTO');

    // erro de rede → PORTAL_INDISPONIVEL, registrado e auditado
    await assert.rejects(
      sincronizarEmpresa(repo, id, { criarCliente: () => clienteFalso([], { erro: new ErroAdn('Falha de rede: ENOTFOUND x', { temporario: false }) }), intervaloMs: 0, dataDir }),
      (e) => e.codigo === 'PORTAL_INDISPONIVEL' && e.subcodigo === 'SEM_CONEXAO',
    );
    const ult = repo.listarExecucoes({ empresaId: id })[0];
    assert.equal(ult.codigo, 'PORTAL_INDISPONIVEL');
    assert.equal(ult.subcodigo, 'SEM_CONEXAO');

    const aud = listarAuditoria(repo.db, { tipo: 'execucao.finalizada' });
    assert.deepEqual(aud.map((a) => a.payload.status), ['PORTAL_INDISPONIVEL', 'SEM_MOVIMENTO', 'SUCESSO_PARCIAL']);
    assert.equal(aud[2].payload.cursor.ate, 2);
    assert.equal(aud[2].payload.regras_versao.startsWith('regras-'), true);

    // lote
    const res = await sincronizarTodas(repo, { criarCliente: () => clienteFalso(docs), intervaloMs: 0, dataDir, disparo: { origem: 'teste' } });
    assert.equal(res[0].codigo, 'SEM_MOVIMENTO');
    const [lote] = listarAuditoria(repo.db, { tipo: 'lote.finalizado' });
    assert.equal(lote.payload.disparo.origem, 'teste');
    assert.deepEqual(lote.payload.resumo.status, { SEM_MOVIMENTO: 1 });
    assert.equal(lote.payload.resumo.divergencias_abertas.BLOQUEANTE, 1);
    assert.equal(lote.lote_id, lote.payload.lote_id);
    assert.equal(verificarAuditoria(repo.db).integra, true);
  } finally {
    limpar(dataDir);
  }
});

test('migração: banco da versão anterior ganha as colunas novas e códigos derivados', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-mig-'));
  const arq = path.join(dir, 'antigo.db');
  try {
    const velho = new Database(arq);
    velho.exec(`CREATE TABLE execucoes (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, tipo TEXT NOT NULL, status TEXT NOT NULL,
      inicio TEXT NOT NULL DEFAULT (datetime('now')), fim TEXT, lotes INTEGER DEFAULT 0, novos INTEGER DEFAULT 0, eventos INTEGER DEFAULT 0, ultimo_nsu INTEGER, mensagem TEXT);
      INSERT INTO execucoes (tipo, status, novos) VALUES ('busca_adn','ok',3), ('busca_adn','ok',0), ('busca_adn','travada',0), ('busca_adn','erro',0);`);
    velho.close();
    const db = abrirBanco(arq);
    const cods = db.prepare('SELECT codigo FROM execucoes ORDER BY id').pluck().all();
    assert.deepEqual(cods, ['SUCESSO', 'SEM_MOVIMENTO', 'LIMITE_CONSUMO', 'ERRO_INTERNO']);
    const cols = db.prepare('PRAGMA table_info(documentos)').all().map((c) => c.name);
    assert.ok(cols.includes('prestador_regime') && cols.includes('validado_em'));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- API ----------
test('API: catálogo, divergências (ignorar exige motivo), validar e auditoria', async () => {
  const { repo, dataDir, id, empresa } = empresaComNotas();
  registrarNfse(repo, empresa, { xml: xmlCom({ base: xmlRecebida(), cTribNac: '070201' }) }, dataDir);
  const srv = criarServidor(repo, { dataDir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (caminho, metodo = 'GET', corpo) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { 'X-Buscador': '1', 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, dados: await r.json() };
  };
  try {
    const cat = await req('/api/catalogo');
    assert.ok(cat.dados.status.PORTAL_INDISPONIVEL.acao);
    assert.ok(cat.dados.regras.some((r) => r.codigo === 'RET-001'));

    const val = await req('/api/validar', 'POST', { empresa: id });
    assert.equal(val.dados.abertas.BLOQUEANTE, 1);

    const lista = await req(`/api/divergencias?empresa=${id}`);
    assert.equal(lista.dados.total, 1);
    assert.equal(lista.dados.contagem.BLOQUEANTE, 1);
    const div = lista.dados.itens[0];

    assert.equal((await req(`/api/divergencias/${div.id}/ignorar`, 'POST', { motivo: 'ok' })).status, 400);
    const ign = await req(`/api/divergencias/${div.id}/ignorar`, 'POST', { motivo: 'Lei municipal dispensa a retenção' });
    assert.equal(ign.dados.status, 'ignorada');
    assert.equal((await req(`/api/divergencias?empresa=${id}`)).dados.total, 0);
    assert.equal((await req(`/api/divergencias?empresa=${id}&status=todas`)).dados.total, 1);
    assert.equal((await req(`/api/divergencias/${div.id}/reabrir`, 'POST')).dados.status, 'aberta');

    const doc = await req(`/api/documentos/${div.documento_id}`);
    assert.equal(doc.dados.divergencias[0].codigo, 'RET-001');
    const resumo = await req('/api/resumo');
    assert.equal(resumo.dados.divergencias_bloqueantes, 1);

    const ver = await req('/api/auditoria/verificar');
    assert.equal(ver.dados.integra, true);
    const aud = await req('/api/auditoria?limite=10');
    assert.deepEqual(aud.dados.slice(0, 3).map((a) => a.tipo), ['divergencia.reaberta', 'divergencia.ignorada', 'validacao.executada']);
    const exp = await fetch(base + '/api/auditoria/exportar');
    assert.match(exp.headers.get('content-disposition'), /auditoria-.*\.json/);
  } finally {
    srv.close();
    limpar(dataDir);
  }
});
