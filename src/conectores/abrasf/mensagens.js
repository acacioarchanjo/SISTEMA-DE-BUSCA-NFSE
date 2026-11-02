// Montagem das requisições SOAP e leitura das respostas ABRASF.
import { XMLParser } from 'fast-xml-parser';
import { ErroConector } from '../contrato.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

export const escaparXml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const tag = (nome, conteudo) => (conteudo === undefined || conteudo === null || conteudo === '' ? '' : `<${nome}>${conteudo}</${nome}>`);
const docTag = (doc) => (String(doc).length === 11 ? tag('Cpf', doc) : tag('Cnpj', doc));

/**
 * Corpo da consulta (o XML "Envio" do padrão).
 * @param {object} perfil
 * @param {'prestadas'|'tomadas'} papel
 * @param {{cnpj:string, im?:string, de:string, ate:string, pagina?:number, periodo:'emissao'|'competencia'}} q
 */
export function montarEnvio(perfil, papel, q) {
  const op = perfil.operacoes[papel];
  // namespace do XML de dados: o do padrão, ou nenhum ('' — ex.: Campinas/IMA usa elementos sem namespace)
  const ns = q.namespace ?? perfil.namespace;
  const raiz = (conteudo) => `<${op.envio}${ns ? ` xmlns="${ns}"` : ''}>${conteudo}</${op.envio}>`;
  const nomePeriodo = q.periodo === 'competencia' ? 'PeriodoCompetencia' : 'PeriodoEmissao';
  const periodo = `<${nomePeriodo}>${tag('DataInicial', q.de)}${tag('DataFinal', q.ate)}</${nomePeriodo}>`;
  if (perfil.versao === '1.00') {
    // 1.00: Prestador(Cnpj, InscricaoMunicipal) obrigatório; só emissão
    return raiz(`<Prestador>${tag('Cnpj', q.cnpj)}${tag('InscricaoMunicipal', q.im)}</Prestador><PeriodoEmissao>${tag('DataInicial', q.de)}${tag('DataFinal', q.ate)}</PeriodoEmissao>`);
  }
  const id = `<CpfCnpj>${docTag(q.cnpj)}</CpfCnpj>${tag('InscricaoMunicipal', q.im)}`;
  if (papel === 'prestadas') return raiz(`<Prestador>${id}</Prestador>${periodo}${tag('Pagina', q.pagina ?? 1)}`);
  // tomadas: o consulente é a própria empresa, filtrando como tomadora
  return raiz(`<Consulente>${id}</Consulente>${periodo}<Tomador>${id}</Tomador>${tag('Pagina', q.pagina ?? 1)}`);
}

/**
 * Envelope SOAP conforme as opções do município. Devolve { corpo, headers }.
 * Os namespaces do envelope ficam declarados no Envelope com prefixo (soapenv:, nfse:), e o elemento da
 * operação usa o prefixo nfse:. Assim o XML de dados NÃO herda namespace nenhum (essencial quando ele é
 * sem namespace e quando é assinado — a assinatura é calculada sobre o XML de dados isolado).
 */
export function montarEnvelope(perfil, papel, envio, opcoes) {
  const op = perfil.operacoes[papel].soap;
  const elemento = `nfse:${opcoes.elementoOperacao.replace('{op}', op)}`;
  const embutir = (xml) => (opcoes.embutir === 'cdata' ? `<![CDATA[${xml}]]>` : escaparXml(xml));
  const cabecalho = `<cabecalho versao="${perfil.versao}" xmlns="${perfil.namespace}"><versaoDados>${perfil.versao}</versaoDados></cabecalho>`;
  const conteudo = opcoes.estilo === 'direto'
    ? envio
    : `<nfse:nfseCabecMsg>${embutir(cabecalho)}</nfse:nfseCabecMsg><nfse:nfseDadosMsg>${embutir(envio)}</nfse:nfseDadosMsg>`;
  const soap12 = opcoes.soapVersao === '1.2';
  const nsEnv = soap12 ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
  const corpo = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${nsEnv}" xmlns:nfse="${opcoes.nsServico}"><soapenv:Header/><soapenv:Body><${elemento}>${conteudo}</${elemento}></soapenv:Body></soapenv:Envelope>`;
  const acao = opcoes.soapAction ? opcoes.soapAction.replace('{ns}', opcoes.nsServico).replace('{op}', op) : '';
  const headers = soap12
    ? { 'Content-Type': `application/soap+xml; charset=utf-8${acao ? `; action="${acao}"` : ''}` }
    : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${acao}"` }; // SOAP 1.1: cabeçalho sempre presente (vazio = "")
  return { corpo, headers };
}

/** Busca profunda pela primeira chave com o nome dado. */
export function achar(obj, nome) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const i of obj) { const r = achar(i, nome); if (r !== undefined) return r; }
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

/** Procura uma string que contenha o XML da resposta (estilo "outputXML"/"return" com XML escapado). */
function acharTextoXml(obj, nomeResposta) {
  if (typeof obj === 'string') return obj.includes(nomeResposta) && obj.includes('<') ? obj : undefined;
  if (!obj || typeof obj !== 'object') return undefined;
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const r = acharTextoXml(v, nomeResposta);
    if (r) return r;
  }
  return undefined;
}

/**
 * Classifica as MensagemRetorno de uma consulta sem notas.
 * A ordem importa: "Assinatura ... não encontrada" é ERRO, não "nenhuma nota encontrada".
 */
export function classificarMensagens(mensagens) {
  const texto = mensagens.map((m) => `${m.codigo} ${m.mensagem}`).join(' | ');
  if (/assinatura|assinad|signature/i.test(texto)) return { texto, codigo: 'DADO_INCONSISTENTE', subcodigo: 'ASSINATURA_EXIGIDA' };
  if (/certificad|autoriz|permiss|n[ãa]o\s+habilitad|procura[çc]|credencia/i.test(texto)) return { texto, codigo: 'ERRO_AUTENTICACAO', subcodigo: 'ACESSO_NEGADO' };
  const semNotas =
    /nenhum[ao]?\s+(nfs-?e|nota|registro|documento|resultado)/i.test(texto) ||
    /(nfs-?e|notas?|registros?|documentos?|resultados?)\b[^|]{0,60}?n[ãa]o\s+(foi\s+|foram\s+)?(encontrad|localizad)/i.test(texto) ||
    /n[ãa]o\s+(foi|foram)\s+(encontrad|localizad)[ao]s?\s+(nfs-?e|notas?|registros?|documentos?)/i.test(texto) ||
    /n[ãa]o\s+(h[áa]|existe[m]?)\s+(nfs-?e|notas?|registros?|documentos?)/i.test(texto) ||
    /sem\s+(registros?|notas?|nfs-?e|movimento)/i.test(texto);
  if (semNotas) return { texto, vazio: true };
  return { texto, codigo: 'DADO_INCONSISTENTE', subcodigo: 'MENSAGEM_RETORNO' };
}

const comoLista = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const texto = (v) => (v && typeof v === 'object' ? v['#text'] ?? '' : v ?? '');

/**
 * Lê a resposta HTTP de uma consulta.
 * @returns {{ compNfse: string[], proximaPagina: number|null, mensagens: Array<{codigo,mensagem,correcao}> }}
 * Lança ErroConector já classificado.
 */
export function lerResposta(perfil, papel, { status, corpo }) {
  const bruto = Buffer.isBuffer(corpo) ? corpo.toString('utf8') : String(corpo ?? '');
  const nomeResposta = perfil.operacoes[papel].resposta;

  if (/^\s*<!doctype html|^\s*<html/i.test(bruto)) {
    throw new ErroConector(status >= 500 || status === 404 ? 'PORTAL_INDISPONIVEL' : 'MUDANCA_LAYOUT', 'HTML_NO_LUGAR_DE_XML',
      `A prefeitura devolveu uma página HTML (HTTP ${status}) em vez de XML: serviço em manutenção ou URL errada.`, { status, resposta: bruto, temporario: status >= 500 });
  }
  if (status === 401 || status === 403) {
    throw new ErroConector('ERRO_AUTENTICACAO', 'ACESSO_NEGADO', `Acesso negado pela prefeitura (HTTP ${status}). Confira o certificado e se ele está habilitado no município.`, { status, resposta: bruto });
  }
  if (status === 429) throw new ErroConector('LIMITE_CONSUMO', 'CONSUMO_INDEVIDO', 'A prefeitura limitou as consultas (HTTP 429).', { status });

  let envelope;
  try {
    envelope = parser.parse(bruto);
  } catch {
    throw new ErroConector(status >= 500 ? 'PORTAL_INDISPONIVEL' : 'MUDANCA_LAYOUT', 'RESPOSTA_INESPERADA', `Resposta não é XML válido (HTTP ${status}).`, { status, resposta: bruto, temporario: status >= 500 });
  }

  const fault = achar(envelope, 'Fault');
  if (fault) {
    const msg = texto(achar(fault, 'faultstring')) || texto(achar(fault, 'Text')) || texto(achar(fault, 'Reason')) || 'erro SOAP';
    const auth = /certificad|autoriz|permiss|credencia|acesso negado/i.test(msg);
    const codigoFault = String(texto(achar(fault, 'faultcode')) || texto(achar(achar(fault, 'Code') ?? {}, 'Value')) || '');
    // "Ocorreu um erro imprevisto em nossos servidores. Tente mais tarde" (Campinas) e afins: falha do lado da prefeitura
    if (!auth && /imprevist|tente (mais tarde|novamente)|indispon|temporariamente|sobrecarg|timeout|tempo (limite|esgotado)|internal server error/i.test(msg)) {
      throw new ErroConector('PORTAL_INDISPONIVEL', 'SERVIDOR_FORA', `Servidor da prefeitura com erro: ${String(msg).slice(0, 300)}`, { status, resposta: bruto, temporario: true, faultcode: codigoFault });
    }
    throw new ErroConector(auth ? 'ERRO_AUTENTICACAO' : 'DADO_INCONSISTENTE', auth ? 'ACESSO_NEGADO' : 'SOAP_FAULT', `Erro SOAP da prefeitura: ${String(msg).slice(0, 300)}`, { status, resposta: bruto });
  }
  if (status >= 500) {
    throw new ErroConector('PORTAL_INDISPONIVEL', 'SERVIDOR_FORA', `Servidor da prefeitura com erro (HTTP ${status}).`, { status, resposta: bruto, temporario: true });
  }

  // A resposta pode vir como XML direto no Body ou como texto (XML escapado) dentro de um elemento.
  let textoResposta = bruto;
  let resposta = achar(envelope, nomeResposta);
  if (resposta === undefined || typeof resposta === 'string') {
    const embutido = typeof resposta === 'string' ? resposta : acharTextoXml(envelope, nomeResposta);
    if (embutido) {
      textoResposta = embutido;
      resposta = achar(parser.parse(embutido), nomeResposta);
    }
  }
  if (resposta === undefined) {
    // Alguns sistemas devolvem só ListaMensagemRetorno/ListaNfse sem o elemento raiz esperado
    const alternativa = achar(envelope, 'ListaNfse') !== undefined || achar(envelope, 'ListaMensagemRetorno') !== undefined;
    if (!alternativa) {
      throw new ErroConector('MUDANCA_LAYOUT', 'RESPOSTA_INESPERADA', `A resposta não contém ${nomeResposta}. Confira a versão ABRASF e o estilo do envelope do município.`, { status, resposta: bruto });
    }
    resposta = envelope;
  }

  const mensagens = comoLista(achar(achar(resposta, 'ListaMensagemRetorno') ?? {}, 'MensagemRetorno')).map((m) => ({
    codigo: texto(m.Codigo), mensagem: texto(m.Mensagem), correcao: texto(m.Correcao),
  }));
  const lista = achar(resposta, 'ListaNfse');
  const prox = lista ? texto(lista.ProximaPagina) : '';

  // XML original de cada CompNfse (guardado como evidência e para reprocessar)
  const compNfse = [...textoResposta.matchAll(/<((?:[\w-]+:)?)CompNfse[\s>][\s\S]*?<\/\1CompNfse>/g)].map((m) => m[0]);

  if (!compNfse.length && mensagens.length) {
    const c = classificarMensagens(mensagens);
    if (c.vazio) return { compNfse: [], proximaPagina: null, mensagens };
    throw new ErroConector(c.codigo, c.subcodigo, `A prefeitura recusou a consulta: ${c.texto.slice(0, 400)}`, { status, resposta: bruto });
  }

  return { compNfse, proximaPagina: prox && /^\d+$/.test(prox) ? Number(prox) : null, mensagens };
}
