// Retenções na fonte das NFS-e tomadas: filtros rápidos e consolidação para a EFD-Reinf.
//
// Série R-4000 (retenções federais de IR, CSLL, PIS e COFINS):
//   R-4020 → beneficiário pessoa jurídica (CNPJ)
//   R-4010 → beneficiário pessoa física (CPF)
// Série R-2000 (contribuição previdenciária):
//   R-2010 → INSS retido sobre serviços tomados (cessão de mão de obra / empreitada)
//
// Atenção: na Reinf o fato gerador da série R-4000 é a DATA DO PAGAMENTO/CRÉDITO, não a emissão da nota.
// Este relatório agrupa pela competência da NFS-e e serve de base de conferência; o pagamento real vem do financeiro.
import { decimalBR, dataBR, formatarCnpj } from '../util/formatos.js';

/** Condições SQL (alias `d` = documentos) para cada filtro de retenção. */
const CSRF = '((d.pis_cofins_retido = 1 AND (COALESCE(d.valor_pis,0) + COALESCE(d.valor_cofins,0)) > 0) OR COALESCE(d.valor_csll,0) > 0)';
const FEDERAL = `(COALESCE(d.valor_irrf,0) > 0 OR COALESCE(d.valor_inss,0) > 0 OR ${CSRF})`;
const QUALQUER = `(d.iss_retido = 1 OR ${FEDERAL})`;
export const FILTROS_RETENCAO = {
  qualquer: QUALQUER,
  iss: '(d.iss_retido = 1)',
  federal: FEDERAL,
  irrf: '(COALESCE(d.valor_irrf,0) > 0)',
  csrf: CSRF,
  inss: '(COALESCE(d.valor_inss,0) > 0)',
  nenhuma: `(NOT ${QUALQUER})`,
};

/** Somas por tributo retido (só conta PIS/COFINS quando marcados como retidos e ISS quando retido). */
export const SOMAS_RETENCAO_SQL = `
  COALESCE(SUM(CASE WHEN d.iss_retido = 1 THEN d.valor_iss ELSE 0 END),0) AS ret_iss,
  COALESCE(SUM(d.valor_irrf),0) AS ret_irrf,
  COALESCE(SUM(d.valor_csll),0) AS ret_csll,
  COALESCE(SUM(CASE WHEN d.pis_cofins_retido = 1 THEN d.valor_pis ELSE 0 END),0) AS ret_pis,
  COALESCE(SUM(CASE WHEN d.pis_cofins_retido = 1 THEN d.valor_cofins ELSE 0 END),0) AS ret_cofins,
  COALESCE(SUM(d.valor_inss),0) AS ret_inss`;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const MES = /^\d{4}-\d{2}$/;

/** Último dia do mês AAAA-MM (para filtrar competências gravadas como AAAA-MM-DD). */
const fimDoMes = (m) => {
  const [a, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(a, mm, 0)).toISOString().slice(0, 10);
};

/**
 * Consolida as retenções das notas TOMADAS (papel "recebida", situação normal) por
 * empresa declarante × competência × beneficiário (prestador).
 * @param {import('better-sqlite3').Database} db
 * @param {{ empresaId?:number, de?:string, ate?:string }} f  de/ate no formato AAAA-MM
 */
export function consolidarRetencoes(db, f = {}) {
  const cond = ["d.papel = 'recebida'", "d.situacao = 'normal'", FILTROS_RETENCAO.qualquer];
  const params = {};
  if (f.empresaId) { cond.push('d.empresa_id = @empresaId'); params.empresaId = Number(f.empresaId); }
  if (f.de) {
    if (!MES.test(f.de)) throw new Error('Mês inicial no formato AAAA-MM.');
    cond.push('d.competencia >= @de'); params.de = `${f.de}-01`;
  }
  if (f.ate) {
    if (!MES.test(f.ate)) throw new Error('Mês final no formato AAAA-MM.');
    cond.push('d.competencia <= @ate'); params.ate = fimDoMes(f.ate);
  }
  const linhas = db.prepare(`
    SELECT e.cnpj AS empresa_cnpj, e.razao_social AS empresa_nome,
           substr(d.competencia, 1, 7) AS competencia,
           d.prestador_doc AS beneficiario_doc, MAX(d.prestador_nome) AS beneficiario_nome,
           COUNT(*) AS notas, COALESCE(SUM(d.valor_servico),0) AS valor_bruto,
           ${SOMAS_RETENCAO_SQL},
           GROUP_CONCAT(COALESCE(d.numero, d.chave), ', ') AS numeros
      FROM documentos d JOIN empresas e ON e.id = d.empresa_id
     WHERE ${cond.join(' AND ')}
     GROUP BY e.cnpj, substr(d.competencia, 1, 7), d.prestador_doc
     ORDER BY substr(d.competencia, 1, 7) DESC, e.razao_social, valor_bruto DESC`).all(params);

  const totais = { notas: 0, valor_bruto: 0, ret_iss: 0, ret_irrf: 0, ret_csll: 0, ret_pis: 0, ret_cofins: 0, ret_inss: 0 };
  const saida = linhas.map((l) => {
    const doc = String(l.beneficiario_doc ?? '').replace(/\D/g, '');
    const tipo = doc.length === 11 ? 'PF' : 'PJ';
    const federais = r2(l.ret_irrf + l.ret_csll + l.ret_pis + l.ret_cofins);
    const eventos = [];
    if (federais > 0) eventos.push(tipo === 'PF' ? 'R-4010' : 'R-4020');
    if (l.ret_inss > 0) eventos.push('R-2010');
    for (const k of Object.keys(totais)) totais[k] = r2(totais[k] + (l[k] ?? 0));
    return {
      ...l,
      beneficiario_doc: doc,
      beneficiario_tipo: tipo,
      valor_bruto: r2(l.valor_bruto),
      ret_iss: r2(l.ret_iss), ret_irrf: r2(l.ret_irrf), ret_csll: r2(l.ret_csll),
      ret_pis: r2(l.ret_pis), ret_cofins: r2(l.ret_cofins), ret_inss: r2(l.ret_inss),
      ret_csrf: r2(l.ret_csll + l.ret_pis + l.ret_cofins),
      ret_federais: federais,
      eventos_reinf: eventos,
    };
  });
  totais.ret_csrf = r2(totais.ret_csll + totais.ret_pis + totais.ret_cofins);
  totais.beneficiarios = new Set(saida.map((l) => l.beneficiario_doc)).size;
  totais.r4000 = saida.filter((l) => l.ret_federais > 0).length;
  totais.r2010 = saida.filter((l) => l.ret_inss > 0).length;
  return { linhas: saida, totais };
}

function celula(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
  s = s.replace(/\r?\n/g, ' ');
  return /[";]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUNAS = [
  ['Empresa declarante (CNPJ)', (l) => formatarCnpj(l.empresa_cnpj)],
  ['Empresa', (l) => l.empresa_nome],
  ['Competência NFS-e', (l) => l.competencia ? l.competencia.split('-').reverse().join('/') : ''],
  ['Evento(s) Reinf', (l) => l.eventos_reinf.join(' + ')],
  ['Beneficiário CNPJ/CPF', (l) => formatarCnpj(l.beneficiario_doc)],
  ['Tipo', (l) => l.beneficiario_tipo],
  ['Beneficiário', (l) => l.beneficiario_nome],
  ['Qtd. notas', (l) => l.notas],
  ['Valor bruto', (l) => decimalBR(l.valor_bruto)],
  ['IRRF retido', (l) => decimalBR(l.ret_irrf)],
  ['CSLL retida', (l) => decimalBR(l.ret_csll)],
  ['PIS retido', (l) => decimalBR(l.ret_pis)],
  ['COFINS retida', (l) => decimalBR(l.ret_cofins)],
  ['CSRF (CSLL+PIS+COFINS)', (l) => decimalBR(l.ret_csrf)],
  ['INSS retido (R-2010)', (l) => decimalBR(l.ret_inss)],
  ['ISS retido', (l) => decimalBR(l.ret_iss)],
  ['Natureza do rendimento (preencher)', () => ''],
  ['Data do pagamento (preencher)', () => ''],
  ['Notas', (l) => l.numeros],
];

/** CSV (";" + BOM UTF-8) da consolidação, pronto para conferência no Excel. */
export function gerarCsvRetencoes({ linhas, totais }, { geradoEm = new Date() } = {}) {
  const out = [COLUNAS.map(([t]) => celula(t)).join(';')];
  for (const l of linhas) out.push(COLUNAS.map(([, fn]) => celula(fn(l))).join(';'));
  out.push('');
  out.push(['TOTAL', '', '', '', '', '', `${totais.beneficiarios} beneficiário(s)`, totais.notas, decimalBR(totais.valor_bruto),
    decimalBR(totais.ret_irrf), decimalBR(totais.ret_csll), decimalBR(totais.ret_pis), decimalBR(totais.ret_cofins),
    decimalBR(totais.ret_csrf), decimalBR(totais.ret_inss), decimalBR(totais.ret_iss)].map(celula).join(';'));
  out.push('');
  out.push(celula(`Gerado em ${dataBR(geradoEm.toISOString())}. Base de conferência: a série R-4000 da EFD-Reinf é declarada pela data do pagamento/crédito; ajuste o mês e informe a natureza do rendimento antes de transmitir.`));
  return '﻿' + out.join('\r\n') + '\r\n';
}
