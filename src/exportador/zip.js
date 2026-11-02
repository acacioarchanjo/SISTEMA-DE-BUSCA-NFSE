// Exportação em ZIP: XMLs organizados por empresa/papel/competência + planilha (+ PDFs opcionais).
// Estrutura pensada para importação em sistemas contábeis (ex.: Domínio/Onvio):
//   {CNPJ}/{emitidas|recebidas|...}/{AAAA-MM}/{chave}.xml
//   {CNPJ}/{papel}/{AAAA-MM}/canceladas/{chave}.xml
//   planilha-nfse.csv
import JSZip from 'jszip';
import fs from 'node:fs';
import { config } from '../config.js';
import { caminhoAbsoluto } from '../nfse/armazenamento.js';
import { gerarCsv } from './planilha.js';
import { gerarDanfse } from './danfse.js';

const PASTA_PAPEL = { emitida: 'emitidas', recebida: 'recebidas', intermediario: 'intermediario', outro: 'outras' };

export async function gerarZip(documentos, { incluirPdf = false, dataDir = config.dataDir } = {}) {
  const zip = new JSZip();
  const faltando = [];

  for (const d of documentos) {
    const mes = d.competencia ? d.competencia.slice(0, 7) : 'sem-competencia';
    let pasta = `${d.empresa_cnpj}/${PASTA_PAPEL[d.papel] ?? 'outras'}/${mes}`;
    if (d.situacao && d.situacao !== 'normal') pasta += `/${d.situacao === 'cancelada' ? 'canceladas' : 'substituidas'}`;

    if (d.xml_path) {
      try {
        zip.file(`${pasta}/${d.chave}.xml`, fs.readFileSync(caminhoAbsoluto(d.xml_path, dataDir)));
      } catch {
        faltando.push(d.chave);
      }
    } else {
      faltando.push(d.chave);
    }
    if (incluirPdf) zip.file(`${pasta}/pdf/${d.chave}.pdf`, await gerarDanfse(d));
  }

  zip.file('planilha-nfse.csv', gerarCsv(documentos));
  if (faltando.length) zip.file('LEIA-ME-xml-ausentes.txt', `XMLs não encontrados em disco:\r\n${faltando.join('\r\n')}\r\n`);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
