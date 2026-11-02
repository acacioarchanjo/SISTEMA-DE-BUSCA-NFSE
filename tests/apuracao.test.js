import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { analisarBoleto, montarArrecadacao, montarCobranca, linhaDe, modulo10, modulo11Arrecadacao, dataDoFator } from '../src/apuracao/boleto.js';
import { apurarCompetencia } from '../src/apuracao/iss.js';
import { estadoCompetencia, aprovar, reabrir, registrarEncerramento, registrarGuia, registrarPagamento, visaoGeral } from '../src/apuracao/fluxo.js';
import { listarAuditoria, verificarAuditoria } from '../src/auditoria.js';
import { criarServidor } from '../src/server/app.js';
import { ambienteTeste, gerarPfx, limpar, CNPJ_TESTE } from './ajuda.js';

const CAMPINAS = '3509502';
const SP = '3550308';
const AGORA = new Date('2026-11-02T12:00:00Z');
const Q = (id) => ({ empresaId: id, ibge: CAMPINAS, competencia: '2026-09', agora: AGORA });
const PDF = Buffer.from('%PDF-1.4\n%teste\n').toString('base64');

// ---------- código de barras ----------
test('boleto: exemplos reais de arrecadação e cobrança, DVs e fator de vencimento', () => {
  // linhas públicas reais (energia, telecom, Banco do Brasil): validam módulo 10/11 de forma independente
  const energia = analisarBoleto('83640000001-1 33120138000-2 81288462711-6 08013618155-1');
  assert.equal(energia.tipo, 'arrecadacao');
  assert.equal(energia.valor, 133.12);
  assert.equal(energia.segmentoNome, 'Energia elétrica e gás');
  assert.equal(analisarBoleto('846700000017435900240209024050002435842210108119').valor, 143.59);
  const bb = analisarBoleto('00190000090114971860168524522114675860000102656');
  assert.equal(bb.tipo, 'cobranca');
  assert.equal(bb.banco, '001');
  assert.equal(bb.valor, 1026.56);
  assert.equal(bb.vencimento, '2018-07-15');
  assert.equal(analisarBoleto(bb.codigoBarras).valor, 1026.56, 'aceita o código de barras de 44 dígitos');

  assert.throws(() => analisarBoleto('83640000001-1 33120138000-2 81288462711-6 08013618155-2'), /bloco 4/);
  assert.throws(() => analisarBoleto('00190000090114971860168524522114675860000102657'), /geral/);
  assert.throws(() => analisarBoleto('123'), /Quantidade de dígitos/);

  // prefeitura (segmento 1), módulo 10 e módulo 11; ida e volta código ↔ linha
  for (const idValor of ['6', '8']) {
    const cod = montarArrecadacao({ segmento: 1, idValor, valor: 1234.56, orgao: '0123' });
    const r = analisarBoleto(linhaDe(cod));
    assert.equal(r.segmentoNome, 'Prefeituras');
    assert.equal(r.valor, 1234.56);
    assert.equal(r.codigoBarras, cod);
  }
  // fator de vencimento: reinício em 22/02/2025
  assert.equal(dataDoFator(1000, new Date('2025-03-01')), '2025-02-22');
  assert.equal(dataDoFator(1000, new Date('2000-07-01')), '2000-07-03');
  assert.equal(analisarBoleto(linhaDe(montarCobranca({ valor: 10, vencimento: '2026-11-10' })), { referencia: AGORA }).vencimento, '2026-11-10');
  assert.equal(modulo10('0'), 0);
  assert.equal(modulo11Arrecadacao('0'), 0, 'resto 0 → DV 0');
});

// ---------- apuração ----------
function popular(repo, id, o = {}) {
  let n = 0;
  const nota = (x) => repo.salvarDocumento({
    empresa_id: id, chave: `CH${++n}`, numero: String(n), origem: 'adn', sistema: 'adn', situacao: 'normal', competencia: '2026-09-10',
    codigo_municipio_incidencia: CAMPINAS, municipio_gerador: CAMPINAS, valor_servico: 1000, base_calculo: 1000, aliquota: 5, valor_iss: 50,
    iss_retido: 0, tp_ret_issqn: '1', prestador_regime: '1', ...x,
  });
  // prestadas (empresa = prestadora, regime normal)
  nota({ papel: 'emitida', prestador_doc: CNPJ_TESTE, tomador_doc: '04252011000110' });                       // ISS próprio 50
  nota({ papel: 'emitida', prestador_doc: CNPJ_TESTE, valor_servico: 2000, base_calculo: 2000, aliquota: 2, valor_iss: 40 }); // ISS próprio 40 (2%)
  nota({ papel: 'emitida', prestador_doc: CNPJ_TESTE, iss_retido: 1, tp_ret_issqn: '2' });                    // retido pelo cliente: fora
  nota({ papel: 'emitida', prestador_doc: CNPJ_TESTE, codigo_municipio_incidencia: SP });                     // incidência SP: fora
  nota({ papel: 'emitida', prestador_doc: CNPJ_TESTE, situacao: 'cancelada' });                               // cancelada: fora
  // tomadas
  nota({ papel: 'recebida', prestador_doc: '04252011000110', prestador_nome: 'Limpeza A', iss_retido: 1, tp_ret_issqn: '2', valor_iss: 30, aliquota: 3 }); // retido 30
  nota({ papel: 'recebida', prestador_doc: '04252011000110', prestador_nome: 'Limpeza A', iss_retido: 1, tp_ret_issqn: '2', valor_iss: 20, aliquota: 2 }); // retido 20
  nota({ papel: 'recebida', prestador_doc: '11444777000161', iss_retido: 1, tp_ret_issqn: '3' });             // intermediário: fora
  nota({ papel: 'recebida', prestador_doc: '11444777000161', municipio_gerador: SP });                        // de fora, ISS de Campinas sem retenção: alerta
  nota({ papel: 'recebida', prestador_doc: '11444777000161', competencia: '2026-10-01', iss_retido: 1, tp_ret_issqn: '2' }); // outro mês
  if (o.coberto !== false) {
    repo.db.prepare(`INSERT INTO execucoes (empresa_id, tipo, status, codigo, inicio, fim) VALUES (?, 'busca_adn', 'ok', 'SUCESSO', '2026-10-05 10:00:00', '2026-10-05 10:01:00')`).run(id);
  }
}

test('apuração: ISS próprio, retido, informativos, pendências e hash determinístico', () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    popular(repo, id);
    const a = apurarCompetencia(repo.db, Q(id));
    assert.equal(a.proprio.notas, 2);
    assert.equal(a.proprio.iss, 90);
    assert.equal(a.proprio.aRecolher, 90);
    assert.deepEqual(a.proprio.porAliquota.map((x) => [x.aliquota, x.iss]), [[2, 40], [5, 50]]);
    assert.equal(a.retido.notas, 2);
    assert.equal(a.retido.aRecolher, 50);
    assert.deepEqual(a.retido.porPrestador.map((p) => [p.prestador_nome, p.iss]), [['Limpeza A', 50]]);
    assert.equal(a.informativo.retidoPeloCliente.iss, 50);
    assert.equal(a.informativo.retidoIntermediario.notas, 1);
    assert.equal(a.informativo.canceladas, 1);
    assert.equal(a.totalARecolher, 140);
    assert.deepEqual(a.guiasEsperadas, [{ tipo: 'ISS_PROPRIO', valor: 90 }, { tipo: 'ISS_RETIDO', valor: 50 }]);
    assert.equal(a.bloqueantes, 0);
    const cod = a.pendencias.map((p) => p.codigo);
    assert.ok(cod.includes('TOMADOR-FORA') && cod.includes('DECLARACAO-TOMADOR') && cod.includes('RETIDO-INTERMEDIARIO'));
    assert.match(a.fiscal.guia, /GRD/);
    assert.equal(apurarCompetencia(repo.db, Q(id)).hash, a.hash, 'determinístico');

    // pendências bloqueantes: mês não terminado; busca não rodou depois do fim do mês
    assert.ok(apurarCompetencia(repo.db, { ...Q(id), agora: new Date('2026-09-20T00:00:00Z') }).pendencias.some((p) => p.codigo === 'COMPETENCIA-ABERTA'));
    assert.ok(apurarCompetencia(repo.db, { ...Q(id), competencia: '2026-10' }).pendencias.some((p) => p.codigo === 'COBERTURA-ADN'));

    // Simples Nacional: ISS próprio vai no DAS
    repo.db.prepare("UPDATE documentos SET prestador_regime = '3' WHERE papel = 'emitida'").run();
    const s = apurarCompetencia(repo.db, Q(id));
    assert.equal(s.proprio.simplesNacional, true);
    assert.equal(s.proprio.aRecolher, 0);
    assert.deepEqual(s.guiasEsperadas, [{ tipo: 'ISS_RETIDO', valor: 50 }]);
    assert.notEqual(s.hash, a.hash);
  } finally {
    limpar(dataDir);
  }
});

test('fluxo: aprovar → encerrar → guias conferidas pelo código de barras → pagamento; desatualização e reabertura', () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    popular(repo, id);
    const q = Q(id);
    const op = { dataDir, agora: AGORA };
    assert.equal(estadoCompetencia(repo.db, q).status, 'ABERTA');
    assert.throws(() => registrarEncerramento(repo.db, q, { por: 'Ana', protocolo: '1', data: '2026-10-05' }), /Aprove/);
    assert.throws(() => aprovar(repo.db, q, { por: 'Ana' }), /confirmação/);
    let e = aprovar(repo.db, q, { por: 'Ana Contadora', confirmo: true });
    assert.equal(e.status, 'APROVADA');
    assert.equal(e.desatualizada, false);
    assert.throws(() => aprovar(repo.db, q, { por: 'Ana', confirmo: true }), /já está APROVADA/);

    e = registrarEncerramento(repo.db, q, { por: 'Ana', protocolo: 'ENC-2026-0915', data: '2026-10-05' });
    assert.equal(e.status, 'ENCERRADA');

    // guia com valor diferente do apurado → exige justificativa
    const grdErrada = linhaDe(montarArrecadacao({ segmento: 1, valor: 91.5, orgao: '0350' }));
    assert.throws(() => registrarGuia(repo.db, q, { por: 'Ana', tipo: 'ISS_PROPRIO', linhaDigitavel: grdErrada, vencimento: '2026-10-10' }, op), /difere do apurado/);
    // dígito errado
    assert.throws(() => registrarGuia(repo.db, q, { por: 'Ana', tipo: 'ISS_PROPRIO', linhaDigitavel: grdErrada.replace(/.$/, (d) => String((Number(d) + 1) % 10)), vencimento: '2026-10-10' }, op), /inválida/);
    // arrecadação não traz vencimento → obrigatório
    const grd = linhaDe(montarArrecadacao({ segmento: 1, valor: 90, orgao: '0350' }));
    assert.throws(() => registrarGuia(repo.db, q, { por: 'Ana', tipo: 'ISS_PROPRIO', linhaDigitavel: grd }, op), /vencimento/);
    assert.throws(() => registrarGuia(repo.db, q, { por: 'Ana', tipo: 'ISS_PROPRIO', linhaDigitavel: grd, vencimento: '2026-10-10', pdfBase64: Buffer.from('oi').toString('base64') }, op), /não é um PDF/);
    e = registrarGuia(repo.db, q, { por: 'Ana', tipo: 'ISS_PROPRIO', linhaDigitavel: grd, vencimento: '2026-10-10', pdfBase64: PDF }, op);
    assert.equal(e.status, 'ENCERRADA', 'falta a guia do retido');
    const g1 = e.registro.guias[0];
    assert.equal(g1.valorGuia, 90);
    assert.equal(g1.diferenca, 0);
    assert.equal(g1.emAtraso, true, '10/10 < 02/11');
    assert.ok(fs.existsSync(path.join(dataDir, g1.arquivo)));
    // retido em boleto bancário: vencimento vem do fator
    const bol = linhaDe(montarCobranca({ banco: '001', valor: 50, vencimento: '2026-11-10' }));
    e = registrarGuia(repo.db, q, { por: 'Ana', tipo: 'ISS_RETIDO', linhaDigitavel: bol }, op);
    assert.equal(e.status, 'GUIA_EMITIDA');
    assert.equal(e.registro.guias[1].vencimento, '2026-11-10');
    assert.throws(() => registrarGuia(repo.db, q, { por: 'Ana', tipo: 'ISS_RETIDO', linhaDigitavel: bol }, op), /já registrada/);

    e = registrarPagamento(repo.db, q, { por: 'Ana', tipo: 'ISS_PROPRIO', data: '2026-10-20', valorPago: 92.1, pdfBase64: PDF }, op);
    assert.equal(e.status, 'GUIA_EMITIDA');
    assert.equal(e.registro.guias[0].pagamento.aposVencimento, true);
    e = registrarPagamento(repo.db, q, { por: 'Ana', tipo: 'ISS_RETIDO', data: '2026-11-05' }, op);
    assert.equal(e.status, 'PAGA');
    assert.equal(e.registro.guias[1].pagamento.valorPago, 50);

    // nota nova depois de pago → desatualizada; reabrir exige motivo e registra retificação
    repo.salvarDocumento({ empresa_id: id, chave: 'ATRASADA', numero: '99', origem: 'adn', sistema: 'adn', papel: 'emitida', situacao: 'normal', competencia: '2026-09-30',
      codigo_municipio_incidencia: CAMPINAS, prestador_doc: CNPJ_TESTE, valor_servico: 100, base_calculo: 100, aliquota: 5, valor_iss: 5, iss_retido: 0, prestador_regime: '1' });
    e = estadoCompetencia(repo.db, q);
    assert.equal(e.desatualizada, true);
    assert.match(e.proximo, /reabra/);
    assert.throws(() => reabrir(repo.db, q, { por: 'Ana', motivo: 'curto' }), /motivo/);
    e = reabrir(repo.db, q, { por: 'Ana', motivo: 'Nota 99 emitida em 30/09 chegou depois do encerramento' });
    assert.equal(e.status, 'ABERTA');
    assert.equal(e.atual.proprio.aRecolher, 95);

    const tipos = listarAuditoria(repo.db, { limite: 50 }).map((x) => x.tipo);
    for (const t of ['competencia.aprovada', 'competencia.encerrada', 'guia.registrada', 'guia.paga', 'competencia.reaberta']) assert.ok(tipos.includes(t), t);
    const reab = listarAuditoria(repo.db, { tipo: 'competencia.reaberta' })[0];
    assert.equal(reab.payload.retificacao_no_portal, true, 'reabertura depois de pago indica retificação no portal');
    assert.equal(reab.payload.status_anterior, 'PAGA');
    assert.equal(verificarAuditoria(repo.db).integra, true, 'cadeia de hash íntegra');

    // aprovar com pendência bloqueante exige justificativa
    const qOut = { ...q, competencia: '2026-10' };
    assert.throws(() => aprovar(repo.db, qOut, { por: 'Ana', confirmo: true }), /justificativa/);
    assert.equal(aprovar(repo.db, qOut, { por: 'Ana', confirmo: true, justificativa: 'Busca do ADN fora do ar; notas conferidas no portal.' }).status, 'APROVADA');
  } finally {
    limpar(dataDir);
  }
});

test('apuração: API (estado, ações, boleto, visão geral)', async () => {
  const amb = ambienteTeste();
  const srv = criarServidor(amb.repo, { dataDir: amb.dataDir, sincronizar: async () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (c, corpo) => {
    const r = await fetch(base + c, { method: corpo ? 'POST' : 'GET', headers: { 'X-Buscador': '1', 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
    const t = r.headers.get('content-type') ?? '';
    return { status: r.status, dados: t.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  try {
    const { id } = cadastrarEmpresa(amb.repo, { pfx: gerarPfx(), senha: '1234' });
    popular(amb.repo, id);
    const alvo = { empresa: id, ibge: CAMPINAS, competencia: '2026-09' };
    const qs = new URLSearchParams(alvo);
    assert.equal((await req('/api/apuracao?empresa=1&ibge=35&competencia=2026-9')).status, 400);
    const est = await req(`/api/apuracao?${qs}`);
    assert.equal(est.status, 200);
    assert.equal(est.dados.atual.totalARecolher, 140);
    assert.equal((await req('/api/apuracao/aprovar', { ...alvo, por: 'Ana', confirmo: true })).dados.status, 'APROVADA');
    assert.equal((await req('/api/apuracao/aprovar', { ...alvo, por: 'Ana', confirmo: true })).status, 409);
    assert.equal((await req('/api/apuracao/encerramento', { ...alvo, por: 'Ana', protocolo: 'X1', data: '2026-10-05' })).dados.status, 'ENCERRADA');
    const linha = linhaDe(montarArrecadacao({ valor: 90 }));
    const bol = await req(`/api/apuracao/boleto?linha=${encodeURIComponent(linha)}`);
    assert.equal(bol.dados.ok, true);
    assert.equal(bol.dados.valor, 90);
    assert.equal((await req('/api/apuracao/boleto?linha=123')).dados.ok, false);
    const g = await req('/api/apuracao/guia', { ...alvo, por: 'Ana', tipo: 'ISS_PROPRIO', linhaDigitavel: linha, vencimento: '2026-11-10', pdfBase64: PDF });
    assert.equal(g.status, 200, JSON.stringify(g.dados));
    const pdf = await req(`/api/apuracao/arquivo?${qs}&tipo=ISS_PROPRIO&qual=guia`);
    assert.equal(pdf.dados.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await req(`/api/apuracao/arquivo?${qs}&tipo=ISS_RETIDO&qual=guia`)).status, 404);
    // visão geral precisa de vínculo municipal
    amb.repo.salvarMunicipio({ ibge: CAMPINAS, nome: 'Campinas', uf: 'SP', perfil: 'abrasf-2.03', url: 'https://x.invalid/ws' });
    amb.repo.salvarVinculo({ empresaId: id, ibge: CAMPINAS });
    const v = visaoGeral(amb.repo.db, { meses: 2, agora: AGORA });
    assert.deepEqual(v.competencias, ['2026-10', '2026-09']);
    assert.equal(v.linhas.find((l) => l.competencia === '2026-09').status, 'ENCERRADA');
    assert.equal((await req('/api/apuracao/visao')).status, 200);
  } finally {
    srv.close();
    limpar(amb.dataDir);
  }
});
