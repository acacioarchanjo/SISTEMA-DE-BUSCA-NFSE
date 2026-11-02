// Pacote para importação no Domínio Escrita Fiscal (Thomson Reuters) — instalação local.
//
// A importação de NFS-e por XML no Domínio é feita por empresa e usa um modelo de leitura para cada
// padrão de XML (NFS-e Padrão Nacional ou o leiaute da prefeitura). Por isso o pacote separa:
//   {CNPJ} - {empresa}/{AAAA-MM}/1-servicos-tomados/{padrao-nacional | municipal-IBGE-cidade}/{chave}.xml
//   {CNPJ} - {empresa}/{AAAA-MM}/2-servicos-prestados/...
//   {CNPJ} - {empresa}/{AAAA-MM}/NAO-IMPORTAR-canceladas-substituidas/...
//   conferencia-dominio.csv  → totais para bater com o relatório do Domínio depois da importação
//   LEIA-ME.txt
import JSZip from 'jszip';
import fs from 'node:fs';
import { config } from '../config.js';
import { caminhoAbsoluto } from '../nfse/armazenamento.js';
import { decimalBR, formatarCnpj } from '../util/formatos.js';

const PAPEL = { recebida: '1-servicos-tomados', emitida: '2-servicos-prestados', intermediario: '3-intermediario', outro: '9-outros' };
const NOME_PAPEL = { recebida: 'Tomadas', emitida: 'Prestadas', intermediario: 'Intermediário', outro: 'Outras' };

/** Nome seguro para pasta no Windows (sem acentos, sem caracteres reservados, até 40 caracteres). */
export function nomePasta(s, max = 40) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, max).trim().replace(/[. ]+$/, '') || 'sem-nome';
}

/** Pasta do padrão do XML: o Domínio lê cada padrão com um modelo de importação diferente. */
function pastaPadrao(d) {
  if (d.sistema === 'abrasf' || d.origem === 'prefeitura') {
    const ibge = d.municipio_gerador || d.codigo_municipio_incidencia || 'sem-ibge';
    return `municipal-${ibge}-${nomePasta(d.municipio_emissao || d.municipio_incidencia || 'prefeitura', 30).replace(/ /g, '-')}`;
  }
  return 'padrao-nacional';
}

function celula(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const LEIA_ME = `PACOTE PARA IMPORTAÇÃO NO DOMÍNIO ESCRITA FISCAL
================================================

Como está organizado
- Uma pasta por empresa (CNPJ - nome) e, dentro, uma por mês de competência (AAAA-MM).
- 1-servicos-tomados   = notas em que a empresa é TOMADORA (entradas de serviço).
- 2-servicos-prestados = notas em que a empresa é PRESTADORA (saídas de serviço).
- padrao-nacional      = XML da NFS-e Padrão Nacional (baixado do ADN).
- municipal-IBGE-...   = XML da prefeitura (padrão ABRASF), baixado do webservice municipal.
- NAO-IMPORTAR-canceladas-substituidas = notas canceladas/substituídas, só para arquivo.

Como importar (por empresa)
1. No Domínio Escrita Fiscal, abra a empresa correspondente ao CNPJ da pasta.
2. Use a importação de NFS-e por XML e aponte para UMA pasta de padrão por vez
   (ex.: 2026-09/1-servicos-tomados/padrao-nacional). Escolha o modelo/layout
   compatível com aquela pasta: Padrão Nacional, ou o da prefeitura nas pastas municipal-*.
3. Repita para cada pasta de padrão e para os prestados.
4. Confira: o arquivo conferencia-dominio.csv traz, por empresa/mês/tipo/padrão,
   a quantidade de notas e os totais (serviços, ISS, ISS retido, IRRF, PIS, COFINS,
   CSLL, INSS). Compare com o relatório de notas de serviço do Domínio.

Atenção
- Os nomes de menu e de modelo de importação variam com a versão do Domínio.
  Se uma pasta não for reconhecida, verifique se o modelo de importação daquela
  prefeitura/padrão está habilitado na sua instalação.
- O mesmo serviço pode existir no ADN e na prefeitura (a Conferência do Buscador avisa
  com a regra DUP-001). Não importe as duas versões.
- Canceladas e substituídas ficam fora das pastas de importação.
`;

/**
 * Gera o ZIP para o Domínio.
 * @param {object[]} documentos linhas de repo.listarDocumentos (com empresa_cnpj e empresa_nome)
 */
export async function gerarPacoteDominio(documentos, { dataDir = config.dataDir } = {}) {
  const zip = new JSZip();
  const faltando = [];
  const grupos = new Map();

  for (const d of documentos) {
    const mes = d.competencia ? d.competencia.slice(0, 7) : 'sem-competencia';
    const empresa = `${d.empresa_cnpj} - ${nomePasta(d.empresa_nome)}`;
    const ativa = !d.situacao || d.situacao === 'normal';
    const padrao = pastaPadrao(d);
    const pasta = ativa
      ? `${empresa}/${mes}/${PAPEL[d.papel] ?? PAPEL.outro}/${padrao}`
      : `${empresa}/${mes}/NAO-IMPORTAR-canceladas-substituidas/${PAPEL[d.papel] ?? PAPEL.outro}`;

    let ok = false;
    if (d.xml_path) {
      try {
        zip.file(`${pasta}/${nomePasta(d.chave, 80)}.xml`, fs.readFileSync(caminhoAbsoluto(d.xml_path, dataDir)));
        ok = true;
      } catch { /* registrado abaixo */ }
    }
    if (!ok) faltando.push(`${d.empresa_cnpj} ${mes} nº ${d.numero ?? '?'} (${d.chave})`);
    if (!ativa || !ok) continue;

    const k = [d.empresa_cnpj, d.empresa_nome, mes, d.papel, padrao].join('\u0000');
    const g = grupos.get(k) ?? { cnpj: d.empresa_cnpj, nome: d.empresa_nome, mes, papel: d.papel, padrao, notas: 0, servico: 0, iss: 0, issRet: 0, irrf: 0, pis: 0, cofins: 0, csll: 0, inss: 0 };
    g.notas++;
    g.servico += d.valor_servico || 0;
    g.iss += d.valor_iss || 0;
    if (d.iss_retido) g.issRet += d.valor_iss || 0;
    g.irrf += d.valor_irrf || 0;
    if (d.pis_cofins_retido) { g.pis += d.valor_pis || 0; g.cofins += d.valor_cofins || 0; }
    g.csll += d.valor_csll || 0;
    g.inss += d.valor_inss || 0;
    grupos.set(k, g);
  }

  const cab = ['Empresa (CNPJ)', 'Empresa', 'Competência', 'Tipo', 'Pasta / padrão do XML', 'Qtd. notas', 'Valor serviços', 'ISS', 'ISS retido', 'IRRF retido', 'PIS retido', 'COFINS retida', 'CSLL retida', 'INSS retido'];
  const linhas = [cab.map(celula).join(';')];
  const ordenados = [...grupos.values()].sort((a, b) => a.cnpj.localeCompare(b.cnpj) || a.mes.localeCompare(b.mes) || a.papel.localeCompare(b.papel) || a.padrao.localeCompare(b.padrao));
  for (const g of ordenados) {
    linhas.push([formatarCnpj(g.cnpj), g.nome, g.mes.split('-').reverse().join('/'), NOME_PAPEL[g.papel] ?? g.papel, g.padrao, g.notas,
      decimalBR(g.servico), decimalBR(g.iss), decimalBR(g.issRet), decimalBR(g.irrf), decimalBR(g.pis), decimalBR(g.cofins), decimalBR(g.csll), decimalBR(g.inss)].map(celula).join(';'));
  }
  zip.file('conferencia-dominio.csv', '﻿' + linhas.join('\r\n') + '\r\n');
  zip.file('LEIA-ME.txt', LEIA_ME.replace(/\n/g, '\r\n'));
  if (faltando.length) zip.file('XML-AUSENTES.txt', `XMLs não encontrados em disco (não foram para o pacote):\r\n${faltando.join('\r\n')}\r\n`);

  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
    grupos: ordenados,
    faltando,
  };
}
