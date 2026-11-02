// Planilha CSV (separador ";" + BOM UTF-8 → abre direto no Excel em pt-BR).
import { decimalBR, dataBR, formatarCnpj } from '../util/formatos.js';

const SIM_NAO = (v) => (v ? 'Sim' : 'Não');

export const COLUNAS = [
  ['Empresa (CNPJ)', (d) => formatarCnpj(d.empresa_cnpj)],
  ['Papel', (d) => d.papel],
  ['Situação', (d) => d.situacao],
  ['Chave de acesso', (d) => d.chave],
  ['Número', (d) => d.numero],
  ['Data emissão', (d) => dataBR(d.data_emissao)],
  ['Competência', (d) => dataBR(d.competencia)],
  ['Prestador CNPJ/CPF', (d) => formatarCnpj(d.prestador_doc)],
  ['Prestador', (d) => d.prestador_nome],
  ['Tomador CNPJ/CPF', (d) => formatarCnpj(d.tomador_doc)],
  ['Tomador', (d) => d.tomador_nome],
  ['Município incidência', (d) => d.municipio_incidencia],
  ['Cód. serviço (cTribNac)', (d) => d.codigo_servico],
  ['Descrição', (d) => d.descricao],
  ['Valor serviço', (d) => decimalBR(d.valor_servico)],
  ['Deduções', (d) => decimalBR(d.valor_deducoes)],
  ['Base de cálculo', (d) => decimalBR(d.base_calculo)],
  ['Alíquota ISS (%)', (d) => decimalBR(d.aliquota)],
  ['ISS', (d) => decimalBR(d.valor_iss)],
  ['ISS retido', (d) => SIM_NAO(d.iss_retido)],
  ['PIS', (d) => decimalBR(d.valor_pis)],
  ['COFINS', (d) => decimalBR(d.valor_cofins)],
  ['PIS/COFINS retido', (d) => SIM_NAO(d.pis_cofins_retido)],
  ['CSLL retido', (d) => decimalBR(d.valor_csll)],
  ['IRRF retido', (d) => decimalBR(d.valor_irrf)],
  ['INSS retido', (d) => decimalBR(d.valor_inss)],
  ['Total retenções', (d) => decimalBR(d.valor_total_retencoes)],
  ['Valor líquido', (d) => decimalBR(d.valor_liquido)],
];

function celula(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Evita injeção de fórmula ao abrir no Excel
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
  s = s.replace(/\r?\n/g, ' ');
  return /[";]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function gerarCsv(documentos) {
  const linhas = [COLUNAS.map(([t]) => celula(t)).join(';')];
  for (const d of documentos) linhas.push(COLUNAS.map(([, f]) => celula(f(d))).join(';'));
  return '﻿' + linhas.join('\r\n') + '\r\n';
}
