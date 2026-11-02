// DANFSe simplificado em PDF (pdfkit + QR Code de consulta pública).
// Representação gráfica auxiliar para conferência — não substitui o DANFSe oficial.
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { formatarCnpj, formatarMoeda, dataBR } from '../util/formatos.js';

export const urlConsultaPublica = (chave) => `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`;

/**
 * @param {object} nota objeto do parser (ou linha da tabela documentos)
 * @returns {Promise<Buffer>}
 */
export async function gerarDanfse(nota, { situacao = nota.situacao ?? 'normal' } = {}) {
  const qr = await QRCode.toBuffer(urlConsultaPublica(nota.chave), { margin: 1, width: 180 });
  const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: `NFS-e ${nota.numero ?? ''} - ${nota.chave}` } });
  const partes = [];
  doc.on('data', (c) => partes.push(c));
  const fim = new Promise((r) => doc.on('end', () => r(Buffer.concat(partes))));

  const L = doc.page.width - 72;
  const secao = (titulo) => {
    doc.moveDown(0.6);
    const y = doc.y;
    doc.rect(36, y, L, 16).fill('#e8eef5');
    doc.fillColor('#1d3557').font('Helvetica-Bold').fontSize(9).text(titulo.toUpperCase(), 42, y + 4);
    doc.fillColor('black').font('Helvetica').fontSize(9);
    doc.y = y + 20;
  };
  const linha = (rotulo, valor) => {
    doc.font('Helvetica-Bold').text(`${rotulo}: `, 42, doc.y, { continued: true }).font('Helvetica').text(String(valor ?? '-'));
  };

  // Cabeçalho
  doc.font('Helvetica-Bold').fontSize(14).text('DANFSe — Documento Auxiliar da NFS-e', 36, 36);
  doc.font('Helvetica').fontSize(8).fillColor('#555').text('Representação simplificada gerada localmente para conferência.', 36, 54);
  doc.fillColor('black');
  doc.image(qr, 36 + L - 90, 30, { width: 90 });
  doc.y = 72;
  doc.fontSize(10);
  linha('Número', nota.numero);
  linha('Emissão', dataBR(nota.data_emissao));
  linha('Competência', dataBR(nota.competencia));
  doc.fontSize(8);
  linha('Chave de acesso', nota.chave);
  doc.fontSize(9);
  doc.y = Math.max(doc.y, 128);

  secao('Prestador / Emitente');
  linha('CNPJ/CPF', formatarCnpj(nota.prestador_doc));
  linha('Nome', nota.prestador_nome);
  if (nota.prestador_im) linha('Inscrição municipal', nota.prestador_im);
  linha('Município de emissão', nota.municipio_emissao);

  secao('Tomador');
  linha('CNPJ/CPF', nota.tomador_doc ? formatarCnpj(nota.tomador_doc) : 'Não identificado');
  linha('Nome', nota.tomador_nome);

  secao('Serviço');
  linha('Código de tributação nacional', nota.codigo_servico);
  if (nota.codigo_nbs) linha('NBS', nota.codigo_nbs);
  linha('Município de incidência', nota.municipio_incidencia);
  doc.font('Helvetica-Bold').text('Descrição:', 42).font('Helvetica').text(nota.descricao ?? '-', 42, doc.y, { width: L - 12 });

  secao('Valores e tributos');
  const rs = (v) => formatarMoeda(v);
  const pares = [
    ['Valor do serviço', rs(nota.valor_servico)],
    ['Deduções/reduções', rs(nota.valor_deducoes)],
    ['Base de cálculo', rs(nota.base_calculo)],
    ['Alíquota ISS', `${Number(nota.aliquota ?? 0).toFixed(2)}%`],
    ['ISS', `${rs(nota.valor_iss)} ${nota.iss_retido ? '(retido)' : ''}`],
    ['PIS', `${rs(nota.valor_pis)} ${nota.pis_cofins_retido ? '(retido)' : ''}`],
    ['COFINS', `${rs(nota.valor_cofins)} ${nota.pis_cofins_retido ? '(retido)' : ''}`],
    ['CSLL retido', rs(nota.valor_csll)],
    ['IRRF retido', rs(nota.valor_irrf)],
    ['INSS (CP) retido', rs(nota.valor_inss)],
    ['Total de retenções', rs(nota.valor_total_retencoes)],
  ];
  for (const [r, v] of pares) linha(r, v);
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(12).text(`VALOR LÍQUIDO: ${rs(nota.valor_liquido)}`, 42);

  doc.moveDown(1);
  doc.font('Helvetica').fontSize(7).fillColor('#555').text(`Consulte a autenticidade em: ${urlConsultaPublica(nota.chave)}`, 36);

  if (situacao && situacao !== 'normal') {
    doc.save();
    doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.fontSize(80).fillColor('red').opacity(0.18).text(situacao.toUpperCase(), 0, doc.page.height / 2 - 40, {
      width: doc.page.width,
      align: 'center',
    });
    doc.restore();
  }

  doc.end();
  return fim;
}
