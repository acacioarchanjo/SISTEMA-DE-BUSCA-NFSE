// Fluxo da competência do ISS — toda mudança de etapa é uma decisão HUMANA registrada na auditoria.
//
//   ABERTA ──aprovar──▶ APROVADA ──encerramento no portal──▶ ENCERRADA ──guia(s)──▶ GUIA_EMITIDA ──pagamento(s)──▶ PAGA
//      ▲                    │ (nota nova/alterada depois da aprovação → "desatualizada": exige reaprovação)
//      └──────reabrir───────┘ (com motivo; depois do encerramento, a reabertura indica retificação no portal)
//
// O sistema NÃO encerra a competência no portal, NÃO emite e NÃO paga guias: registra o que a pessoa fez,
// confere o valor da guia pelo código de barras e guarda os comprovantes.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { registrarAuditoria } from '../auditoria.js';
import { apurarCompetencia } from './iss.js';
import { analisarBoleto } from './boleto.js';
import { lerPreferencias } from '../espelho/drive.js';
import { nomePasta } from '../exportador/dominio.js';

export const ETAPAS = ['ABERTA', 'APROVADA', 'ENCERRADA', 'GUIA_EMITIDA', 'PAGA'];
export const TIPOS_GUIA = { ISS_PROPRIO: 'ISS próprio', ISS_RETIDO: 'ISS retido (tomador)' };

export class ErroFluxo extends Error {
  name = 'ErroFluxo';
  constructor(mensagem, status = 400) { super(mensagem); this.status = status; }
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const MAX_PDF = 5 * 1024 * 1024;

function linha(db, empresaId, ibge, competencia) {
  const l = db.prepare('SELECT * FROM competencias_iss WHERE empresa_id = ? AND ibge = ? AND competencia = ?').get(empresaId, String(ibge), competencia);
  if (!l) return null;
  return { ...l, apuracao: JSON.parse(l.apuracao), encerramento: l.encerramento ? JSON.parse(l.encerramento) : null, guias: JSON.parse(l.guias) };
}

/** Estado completo: apuração atual + registro do fluxo + o que falta para a próxima etapa. */
export function estadoCompetencia(db, { empresaId, ibge, competencia, agora }) {
  const atual = apurarCompetencia(db, { empresaId, ibge, competencia, agora });
  const reg = linha(db, empresaId, ibge, competencia);
  const status = reg?.status ?? 'ABERTA';
  const desatualizada = !!reg && reg.hash !== atual.hash;
  const guiasEsperadas = (reg?.apuracao ?? atual).guiasEsperadas;
  const faltamGuias = guiasEsperadas.filter((g) => !reg?.guias.some((x) => x.tipo === g.tipo));
  const faltamPagamentos = (reg?.guias ?? []).filter((g) => !g.pagamento);
  let proximo;
  if (status === 'ABERTA') proximo = atual.bloqueantes ? 'Resolva as pendências bloqueantes (ou aprove com justificativa).' : 'Confira os valores e aprove a apuração.';
  else if (desatualizada) proximo = 'Notas mudaram depois da aprovação: reabra e aprove de novo.';
  else if (status === 'APROVADA') proximo = 'Encerre a competência no portal da prefeitura e registre o protocolo aqui.';
  else if (status === 'ENCERRADA') proximo = faltamGuias.length ? `Emita no portal e registre: ${faltamGuias.map((g) => TIPOS_GUIA[g.tipo]).join(', ')}.` : 'Sem guia a recolher.';
  else if (status === 'GUIA_EMITIDA') proximo = 'Depois de pagar, registre o pagamento e anexe o comprovante.';
  else proximo = 'Competência concluída.';
  return { atual, registro: reg, status, desatualizada, faltamGuias, faltamPagamentos, proximo };
}

function exigir(cond, msg, status = 400) {
  if (!cond) throw new ErroFluxo(msg, status);
}

const auditar = (db, tipo, est, payload) =>
  registrarAuditoria(db, {
    tipo,
    empresaCnpj: est.atual.empresa.cnpj,
    payload: { empresa_id: est.atual.empresa.id, ibge: est.atual.municipio.ibge, competencia: est.atual.competencia, ...payload },
  });

/** Aprovação humana da apuração (congela o snapshot). */
export function aprovar(db, q, { por, justificativa, confirmo }) {
  const est = estadoCompetencia(db, q);
  exigir(est.status === 'ABERTA', `A competência já está ${est.status}. Para mudar, reabra.`, 409);
  exigir(String(por ?? '').trim().length >= 3, 'Informe quem está aprovando (nome).');
  exigir(confirmo === true, 'Marque a confirmação de que conferiu os valores.');
  const just = String(justificativa ?? '').trim();
  if (est.atual.bloqueantes) exigir(just.length >= 15, `Há ${est.atual.bloqueantes} pendência(s) bloqueante(s): para aprovar mesmo assim, escreva a justificativa (mín. 15 caracteres).`);
  const agora = new Date().toISOString();
  db.prepare(`INSERT INTO competencias_iss (empresa_id, ibge, competencia, status, apuracao, hash, aprovado_por, aprovado_em, justificativa)
              VALUES (?, ?, ?, 'APROVADA', ?, ?, ?, ?, ?)`)
    .run(q.empresaId, String(q.ibge), q.competencia, JSON.stringify(est.atual), est.atual.hash, String(por).trim(), agora, just || null);
  auditar(db, 'competencia.aprovada', est, {
    por: String(por).trim(), hash: est.atual.hash, total: est.atual.totalARecolher,
    iss_proprio: est.atual.proprio.aRecolher, iss_retido: est.atual.retido.aRecolher, pendencias_bloqueantes: est.atual.bloqueantes, justificativa: just || null,
  });
  return estadoCompetencia(db, q);
}

/** Reabre (volta para ABERTA). Depois do encerramento, indica retificação a fazer no portal. */
export function reabrir(db, q, { por, motivo }) {
  const est = estadoCompetencia(db, q);
  exigir(est.registro, 'A competência já está aberta.', 409);
  exigir(String(por ?? '').trim().length >= 3, 'Informe quem está reabrindo.');
  exigir(String(motivo ?? '').trim().length >= 10, 'Informe o motivo (mín. 10 caracteres).');
  db.prepare('DELETE FROM competencias_iss WHERE id = ?').run(est.registro.id);
  auditar(db, 'competencia.reaberta', est, {
    por: String(por).trim(), motivo: String(motivo).trim(), status_anterior: est.status, hash_anterior: est.registro.hash,
    retificacao_no_portal: ['ENCERRADA', 'GUIA_EMITIDA', 'PAGA'].includes(est.status),
    registro_anterior: { aprovado_por: est.registro.aprovado_por, aprovado_em: est.registro.aprovado_em, encerramento: est.registro.encerramento, guias: est.registro.guias.map(({ arquivo, pagamento, ...g }) => ({ ...g, pago: !!pagamento })) },
  });
  return estadoCompetencia(db, q);
}

/** Registra o encerramento feito no portal (protocolo/recibo). */
export function registrarEncerramento(db, q, { por, protocolo, data, observacao }) {
  const est = estadoCompetencia(db, q);
  exigir(est.status === 'APROVADA', est.status === 'ABERTA' ? 'Aprove a apuração antes de encerrar.' : `A competência já está ${est.status}.`, 409);
  exigir(!est.desatualizada, 'Notas mudaram depois da aprovação: reabra e aprove de novo antes de encerrar.', 409);
  exigir(String(por ?? '').trim().length >= 3, 'Informe quem encerrou.');
  exigir(String(protocolo ?? '').trim().length >= 1, 'Informe o protocolo/recibo do encerramento no portal (ou "sem protocolo").');
  exigir(/^\d{4}-\d{2}-\d{2}$/.test(String(data ?? '')), 'Data do encerramento no formato AAAA-MM-DD.');
  const enc = { protocolo: String(protocolo).trim(), data, por: String(por).trim(), observacao: String(observacao ?? '').trim() || null, registrado_em: new Date().toISOString() };
  const semGuia = est.registro.apuracao.guiasEsperadas.length === 0;
  db.prepare(`UPDATE competencias_iss SET status = ?, encerramento = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(semGuia ? 'PAGA' : 'ENCERRADA', JSON.stringify(enc), est.registro.id);
  auditar(db, 'competencia.encerrada', est, { ...enc, sem_guia: semGuia });
  return estadoCompetencia(db, q);
}

function pastaArquivos(est, dataDir) {
  return path.join(dataDir, 'guias', est.atual.empresa.cnpj, est.atual.municipio.ibge, est.atual.competencia);
}

/** Valida e grava um PDF (base64). Devolve o caminho relativo à pasta de dados. */
function gravarPdf(est, base64, nome, dataDir) {
  const buf = Buffer.from(String(base64), 'base64');
  exigir(buf.length > 0 && buf.length <= MAX_PDF, 'O PDF precisa ter até 5 MB.');
  exigir(buf.subarray(0, 5).toString('latin1') === '%PDF-', 'O arquivo enviado não é um PDF.');
  const dir = pastaArquivos(est, dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, nome);
  fs.writeFileSync(abs, buf);
  copiarParaDrive(est, abs, nome, dataDir);
  return path.relative(dataDir, abs).split(path.sep).join('/');
}

/** Se a pasta do Google Drive estiver configurada, guarda a guia/comprovante junto das notas do mês. */
function copiarParaDrive(est, abs, nome, dataDir) {
  try {
    const db = est._db;
    const pref = db ? lerPreferencias(db) : null;
    if (!pref?.pasta || !fs.existsSync(pref.pasta)) return;
    const c = est.atual.competencia;
    const dest = path.join(pref.pasta, `${est.atual.empresa.cnpj} - ${nomePasta(est.atual.empresa.razao_social)}`, c.slice(0, 4), c, 'Guias', nome);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  } catch { /* o Drive é opcional */ }
}

/**
 * Registra uma guia emitida no portal: a linha digitável/código de barras é validada (dígitos verificadores)
 * e o valor lido do código é comparado com a apuração aprovada.
 */
export function registrarGuia(db, q, { por, tipo, linhaDigitavel, vencimento, pdfBase64, justificativaDiferenca }, { dataDir = config.dataDir, agora = new Date() } = {}) {
  const est = { ...estadoCompetencia(db, q), _db: db };
  exigir(['ENCERRADA', 'GUIA_EMITIDA'].includes(est.status), est.status === 'APROVADA' ? 'Registre o encerramento no portal antes da guia.' : `Não é possível registrar guia com a competência ${est.status}.`, 409);
  exigir(!est.desatualizada, 'Notas mudaram depois da aprovação: reabra e aprove de novo.', 409);
  exigir(TIPOS_GUIA[tipo], 'Tipo de guia inválido.');
  const esperada = est.registro.apuracao.guiasEsperadas.find((g) => g.tipo === tipo);
  exigir(esperada, `A apuração não tem ${TIPOS_GUIA[tipo]} a recolher.`);
  exigir(!est.registro.guias.some((g) => g.tipo === tipo), `${TIPOS_GUIA[tipo]} já registrada. Para trocar, reabra a competência.`, 409);
  exigir(String(por ?? '').trim().length >= 3, 'Informe quem emitiu a guia.');

  let b;
  try {
    b = analisarBoleto(linhaDigitavel, { referencia: agora });
  } catch (e) {
    throw new ErroFluxo(`Linha digitável inválida: ${e.message}`);
  }
  const venc = vencimento || b.vencimento;
  exigir(/^\d{4}-\d{2}-\d{2}$/.test(String(venc ?? '')), 'Informe o vencimento da guia (AAAA-MM-DD): ele não vem no código de barras deste tipo de guia.');
  const diferenca = b.valor === null ? null : r2(b.valor - esperada.valor);
  const just = String(justificativaDiferenca ?? '').trim();
  if (diferenca !== null && Math.abs(diferenca) >= 0.01) {
    exigir(just.length >= 10, `O valor da guia (R$ ${b.valor.toFixed(2)}) difere do apurado (R$ ${esperada.valor.toFixed(2)}) em R$ ${diferenca.toFixed(2)}. ` +
      'Confira; se a diferença for correta (multa, juros, ajuste), escreva a justificativa.');
  }
  const guia = {
    tipo, valorApurado: esperada.valor, valorGuia: b.valor, diferenca, justificativaDiferenca: just || null,
    vencimento: venc, emAtraso: venc < agora.toISOString().slice(0, 10),
    formato: b.tipo, codigoBarras: b.codigoBarras, linhaDigitavel: b.linhaDigitavel, banco: b.banco ?? null, orgao: b.orgao ?? null,
    por: String(por).trim(), registrada_em: agora.toISOString(), arquivo: null, pagamento: null,
  };
  if (pdfBase64) guia.arquivo = gravarPdf(est, pdfBase64, `guia-${tipo}.pdf`, dataDir);
  const guias = [...est.registro.guias, guia];
  const todas = est.registro.apuracao.guiasEsperadas.every((g) => guias.some((x) => x.tipo === g.tipo));
  db.prepare(`UPDATE competencias_iss SET status = ?, guias = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(todas ? 'GUIA_EMITIDA' : 'ENCERRADA', JSON.stringify(guias), est.registro.id);
  auditar(db, 'guia.registrada', est, { ...guia, arquivo: !!guia.arquivo });
  return estadoCompetencia(db, q);
}

/** Registra o pagamento (feito pela pessoa no banco) e o comprovante. */
export function registrarPagamento(db, q, { por, tipo, data, valorPago, autenticacao, pdfBase64 }, { dataDir = config.dataDir } = {}) {
  const est = { ...estadoCompetencia(db, q), _db: db };
  exigir(['ENCERRADA', 'GUIA_EMITIDA'].includes(est.status), `Não é possível registrar pagamento com a competência ${est.status}.`, 409);
  const guias = est.registro.guias.map((g) => ({ ...g }));
  const g = guias.find((x) => x.tipo === tipo);
  exigir(g, 'Registre a guia antes do pagamento.');
  exigir(!g.pagamento, 'Pagamento desta guia já registrado.', 409);
  exigir(String(por ?? '').trim().length >= 3, 'Informe quem registrou o pagamento.');
  exigir(/^\d{4}-\d{2}-\d{2}$/.test(String(data ?? '')), 'Data do pagamento no formato AAAA-MM-DD.');
  const pago = valorPago === undefined || valorPago === null || valorPago === '' ? g.valorGuia ?? g.valorApurado : r2(valorPago);
  exigir(Number.isFinite(pago) && pago > 0, 'Valor pago inválido.');
  g.pagamento = {
    data, valorPago: pago, autenticacao: String(autenticacao ?? '').trim() || null, por: String(por).trim(),
    aposVencimento: data > g.vencimento, registrado_em: new Date().toISOString(), comprovante: null,
  };
  if (pdfBase64) g.pagamento.comprovante = gravarPdf(est, pdfBase64, `comprovante-${tipo}.pdf`, dataDir);
  const todasPagas = est.registro.apuracao.guiasEsperadas.every((e) => guias.find((x) => x.tipo === e.tipo)?.pagamento);
  db.prepare(`UPDATE competencias_iss SET status = ?, guias = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(todasPagas ? 'PAGA' : est.status, JSON.stringify(guias), est.registro.id);
  auditar(db, 'guia.paga', est, { tipo, ...g.pagamento, comprovante: !!g.pagamento.comprovante });
  return estadoCompetencia(db, q);
}

/** Painel: situação das competências recentes de todas as empresas × municípios com vínculo. */
export function visaoGeral(db, { meses = 3, agora = new Date() } = {}) {
  const comps = [];
  for (let i = 1; i <= meses; i++) {
    const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - i, 1));
    comps.push(d.toISOString().slice(0, 7));
  }
  const pares = db.prepare(`SELECT v.empresa_id, v.ibge, m.nome AS municipio, e.razao_social, e.cnpj FROM vinculos_municipais v
    JOIN empresas e ON e.id = v.empresa_id JOIN municipios m ON m.ibge = v.ibge WHERE v.ativo = 1 AND e.ativo = 1 ORDER BY e.razao_social`).all();
  const linhas = [];
  for (const p of pares) {
    for (const c of comps) {
      const est = estadoCompetencia(db, { empresaId: p.empresa_id, ibge: p.ibge, competencia: c, agora });
      linhas.push({
        empresa_id: p.empresa_id, empresa: p.razao_social, cnpj: p.cnpj, ibge: p.ibge, municipio: p.municipio, competencia: c,
        status: est.status, desatualizada: est.desatualizada, total: (est.registro?.apuracao ?? est.atual).totalARecolher,
        bloqueantes: est.atual.bloqueantes, proximo: est.proximo,
        vencimentos: (est.registro?.guias ?? []).filter((g) => !g.pagamento).map((g) => g.vencimento),
      });
    }
  }
  return { competencias: comps, linhas };
}
