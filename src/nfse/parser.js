// Parser do XML da NFS-e do Padrão Nacional (leiaute SPED NFS-e v1.x)
// e dos XMLs de evento (cancelamento, substituição, manifestação...).
import { XMLParser } from 'fast-xml-parser';
import { somenteDigitos } from '../util/formatos.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false, // mantém tudo como texto (CNPJ com zero à esquerda!)
  parseAttributeValue: false,
  trimValues: true,
});

export class ErroParser extends Error {}

/** Busca (em profundidade) o primeiro nó com o nome dado. */
function achar(obj, nome) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = achar(item, nome);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(obj, nome)) return obj[nome];
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@')) continue;
    const r = achar(v, nome);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Valor textual por caminho "a.b.c" (cada passo é busca direta, não profunda). */
function campo(obj, caminho) {
  let atual = obj;
  for (const parte of caminho.split('.')) {
    if (atual === undefined || atual === null) return undefined;
    if (Array.isArray(atual)) atual = atual[0];
    atual = atual[parte];
  }
  if (atual && typeof atual === 'object') return atual['#text'];
  return atual;
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const docDe = (o) => somenteDigitos(campo(o, 'CNPJ') ?? campo(o, 'CPF') ?? campo(o, 'NIF') ?? '') || null;

export function lerXml(xml) {
  const texto = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml);
  try {
    return parser.parse(texto);
  } catch (e) {
    throw new ErroParser(`XML inválido: ${e.message}`);
  }
}

/** Identifica o tipo do documento XML: 'nfse' | 'evento' | 'desconhecido'. */
export function tipoDoXml(arvore) {
  if (achar(arvore, 'infNFSe')) return 'nfse';
  if (achar(arvore, 'infEvento') || achar(arvore, 'pedRegEvento')) return 'evento';
  return 'desconhecido';
}

/**
 * Extrai os metadados de uma NFS-e nacional.
 * @param {string|Buffer|object} xml texto do XML ou árvore já parseada
 */
export function parseNfse(xml) {
  const arvore = typeof xml === 'object' && !Buffer.isBuffer(xml) ? xml : lerXml(xml);
  const inf = achar(arvore, 'infNFSe');
  if (!inf) throw new ErroParser('XML não contém <infNFSe> (não é uma NFS-e do padrão nacional).');

  const id = inf['@Id'] ?? '';
  const chave = somenteDigitos(id) || null;
  const infDps = achar(inf, 'infDPS') ?? {};
  const prest = infDps.prest ?? {};
  const emit = inf.emit ?? {};
  const toma = infDps.toma ?? null;
  const interm = infDps.interm ?? null;
  const serv = infDps.serv ?? {};
  const valDps = infDps.valores ?? {};
  const valNfse = inf.valores ?? {};
  const trib = valDps.trib ?? {};
  const tribMun = trib.tribMun ?? {};
  const tribFed = trib.tribFed ?? {};
  const piscofins = tribFed.piscofins ?? {};

  const valorServico = num(campo(valDps, 'vServPrest.vServ'));
  const valorDeducoes = num(campo(valDps, 'vDedRed.vDR')) || num(campo(valNfse, 'vCalcDR'));
  const baseCalculo = num(campo(valNfse, 'vBC')) || Math.max(valorServico - valorDeducoes, 0);
  const aliquota = num(campo(valNfse, 'pAliqAplic')) || num(campo(tribMun, 'pAliq'));
  const valorIss = num(campo(valNfse, 'vISSQN'));

  // tpRetISSQN: 1 = não retido | 2 = retido pelo tomador | 3 = retido pelo intermediário
  const tpRetIss = String(campo(tribMun, 'tpRetISSQN') ?? '1');
  const issRetido = tpRetIss === '2' || tpRetIss === '3';

  const valorPis = num(campo(piscofins, 'vPis'));
  const valorCofins = num(campo(piscofins, 'vCofins'));
  // tpRetPisCofins: 1 = retido | 2 = não retido
  const pisCofinsRetido = String(campo(piscofins, 'tpRetPisCofins') ?? '2') === '1';
  const valorInss = num(campo(tribFed, 'vRetCP'));
  const valorIrrf = num(campo(tribFed, 'vRetIRRF'));
  const valorCsll = num(campo(tribFed, 'vRetCSLL'));

  const retCalculada =
    (issRetido ? valorIss : 0) + (pisCofinsRetido ? valorPis + valorCofins : 0) + valorInss + valorIrrf + valorCsll;
  const totalRetencoes = campo(valNfse, 'vTotalRet') !== undefined ? num(campo(valNfse, 'vTotalRet')) : retCalculada;
  const valorLiquido =
    campo(valNfse, 'vLiq') !== undefined
      ? num(campo(valNfse, 'vLiq'))
      : valorServico - totalRetencoes - num(campo(valDps, 'vDescCondIncond.vDescIncond')) - num(campo(valDps, 'vDescCondIncond.vDescCond'));

  const arred = (v) => Math.round(v * 100) / 100;
  const dhEmi = campo(infDps, 'dhEmi') ?? campo(inf, 'dhProc') ?? null;

  return {
    chave,
    numero: campo(inf, 'nNFSe') ?? null,
    numero_dps: campo(infDps, 'nDPS') ?? null,
    serie_dps: campo(infDps, 'serie') ?? null,
    status: campo(inf, 'cStat') ?? null,
    data_emissao: dhEmi,
    data_processamento: campo(inf, 'dhProc') ?? null,
    competencia: campo(infDps, 'dCompet') ?? (dhEmi ? String(dhEmi).slice(0, 10) : null),
    ambiente: campo(infDps, 'tpAmb') ?? null,
    municipio_emissao: campo(inf, 'xLocEmi') ?? null,
    municipio_incidencia: campo(inf, 'xLocIncid') ?? null,
    codigo_municipio_incidencia: campo(inf, 'cLocIncid') ?? null,
    prestador_doc: docDe(prest) ?? docDe(emit),
    prestador_nome: campo(emit, 'xNome') ?? campo(prest, 'xNome') ?? null,
    prestador_im: campo(emit, 'IM') ?? campo(prest, 'IM') ?? null,
    tomador_doc: toma ? docDe(toma) : null,
    tomador_nome: toma ? (campo(toma, 'xNome') ?? null) : null,
    intermediario_doc: interm ? docDe(interm) : null,
    intermediario_nome: interm ? (campo(interm, 'xNome') ?? null) : null,
    codigo_servico: campo(serv, 'cServ.cTribNac') ?? null,
    codigo_servico_municipal: campo(serv, 'cServ.cTribMun') ?? null,
    codigo_nbs: campo(serv, 'cServ.cNBS') ?? null,
    descricao_servico_nacional: campo(inf, 'xTribNac') ?? null,
    descricao: campo(serv, 'cServ.xDescServ') ?? null,
    valor_servico: arred(valorServico),
    valor_deducoes: arred(valorDeducoes),
    base_calculo: arred(baseCalculo),
    aliquota: arred(aliquota),
    valor_iss: arred(valorIss),
    iss_retido: issRetido,
    valor_pis: arred(valorPis),
    valor_cofins: arred(valorCofins),
    pis_cofins_retido: pisCofinsRetido,
    valor_csll: arred(valorCsll),
    valor_irrf: arred(valorIrrf),
    valor_inss: arred(valorInss),
    valor_total_retencoes: arred(totalRetencoes),
    valor_liquido: arred(valorLiquido),
  };
}

// Códigos de evento da NFS-e nacional → efeito na situação da nota
export const EVENTOS = {
  101101: { descricao: 'Cancelamento de NFS-e', situacao: 'cancelada' },
  105102: { descricao: 'Cancelamento por substituição', situacao: 'substituida' },
  101103: { descricao: 'Solicitação de análise fiscal para cancelamento' },
  105104: { descricao: 'Cancelamento deferido por análise fiscal', situacao: 'cancelada' },
  105105: { descricao: 'Cancelamento indeferido por análise fiscal' },
  202201: { descricao: 'Confirmação do prestador' },
  203202: { descricao: 'Confirmação do tomador' },
  204203: { descricao: 'Confirmação do intermediário' },
  205204: { descricao: 'Confirmação tácita' },
  202205: { descricao: 'Rejeição do prestador' },
  203206: { descricao: 'Rejeição do tomador' },
  204207: { descricao: 'Rejeição do intermediário' },
  205208: { descricao: 'Anulação da rejeição' },
  305101: { descricao: 'Cancelamento de NFS-e por ofício', situacao: 'cancelada' },
  305102: { descricao: 'Bloqueio de NFS-e por ofício' },
  305103: { descricao: 'Desbloqueio de NFS-e por ofício' },
};

/** Extrai chave, tipo e data de um XML de evento. */
export function parseEvento(xml) {
  const arvore = typeof xml === 'object' && !Buffer.isBuffer(xml) ? xml : lerXml(xml);
  const infPed = achar(arvore, 'infPedReg') ?? achar(arvore, 'infEvento') ?? {};
  const chave = somenteDigitos(campo(infPed, 'chNFSe') ?? achar(arvore, 'chNFSe') ?? '') || null;
  let codigo = null;
  let detalhe = {};
  for (const [k, v] of Object.entries(infPed)) {
    const m = k.match(/^e(\d{6})$/);
    if (m) {
      codigo = m[1];
      detalhe = v ?? {};
      break;
    }
  }
  if (!codigo) {
    // procura em profundidade por um nó eNNNNNN
    const busca = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        const m = k.match(/^e(\d{6})$/);
        if (m) { codigo = m[1]; detalhe = v ?? {}; return; }
        busca(v);
        if (codigo) return;
      }
    };
    busca(arvore);
  }
  const info = EVENTOS[codigo] ?? {};
  return {
    chave,
    tipo_evento: codigo,
    descricao: campo(detalhe, 'xDesc') ?? info.descricao ?? (codigo ? `Evento ${codigo}` : 'Evento'),
    motivo: campo(detalhe, 'xMotivo') ?? null,
    data_evento: campo(infPed, 'dhEvento') ?? achar(arvore, 'dhProc') ?? null,
    situacao: info.situacao ?? null,
  };
}

/** Classifica o papel da empresa na nota. */
export function papelDaEmpresa(nota, cnpjEmpresa) {
  const c = somenteDigitos(cnpjEmpresa);
  const raiz = c.slice(0, 8);
  const igual = (doc) => doc && doc === c;
  const mesmaRaiz = (doc) => doc && doc.length === 14 && doc.slice(0, 8) === raiz;
  if (igual(nota.prestador_doc)) return 'emitida';
  if (igual(nota.tomador_doc)) return 'recebida';
  if (igual(nota.intermediario_doc)) return 'intermediario';
  if (mesmaRaiz(nota.prestador_doc)) return 'emitida';
  if (mesmaRaiz(nota.tomador_doc)) return 'recebida';
  if (mesmaRaiz(nota.intermediario_doc)) return 'intermediario';
  return 'outro';
}
