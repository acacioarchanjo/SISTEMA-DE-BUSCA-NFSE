// Converte uma CompNfse ABRASF (1.00 ou 2.0x) para o modelo canônico usado pelo sistema
// (mesmos campos de src/nfse/parser.js#parseNfse), para que regras fiscais, exportação e
// painel funcionem igual para notas do ADN e das prefeituras.
import { XMLParser } from 'fast-xml-parser';
import { achar } from './mensagens.js';
import { somenteDigitos } from '../../util/formatos.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true });

const texto = (v) => (v === undefined || v === null ? undefined : typeof v === 'object' ? v['#text'] : String(v));
const num = (v) => {
  const t = texto(v);
  if (t === undefined || t === '') return 0;
  const n = Number(String(t).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const arred = (v) => Math.round(v * 100) / 100;
const de = (obj, ...nomes) => {
  for (const n of nomes) {
    const v = achar(obj, n);
    if (v !== undefined) return v;
  }
  return undefined;
};
const docDe = (o) => {
  if (!o) return null;
  const d = somenteDigitos(texto(de(o, 'Cnpj')) ?? texto(de(o, 'Cpf')) ?? '');
  return d || null;
};

/**
 * Alíquota ABRASF: a 1.00 usa fração (0.05 = 5%); várias implementações 2.0x usam percentual (5.00).
 * Regra: valores entre 0 e 1 (exclusive) são tratados como fração.
 */
export function normalizarAliquota(v) {
  const n = num(v);
  return n > 0 && n < 1 ? arred(n * 100) : arred(n);
}

/** ItemListaServico ("7.02", "0702", "702", "07.02.01") → código no formato cTribNac "070200". */
export function normalizarItemLista(item) {
  const t = String(item ?? '').trim();
  if (!t) return null;
  let i, s;
  const m = t.match(/^(\d{1,2})\.(\d{1,2})/);
  if (m) [, i, s] = m;
  else {
    const d = t.replace(/\D/g, '');
    if (d.length === 3) { i = d.slice(0, 1); s = d.slice(1); }
    else if (d.length >= 4) { i = d.slice(0, 2); s = d.slice(2, 4); }
    else return null;
  }
  return `${String(i).padStart(2, '0')}${String(s).padStart(2, '0')}00`;
}

/** Chave canônica de nota municipal (ABRASF não tem chave de acesso nacional). */
export const chaveMunicipal = ({ ibge, prestadorDoc, numero }) => `NFSM-${ibge || '0000000'}-${prestadorDoc || 'sem-doc'}-${numero}`;

/**
 * @param {string} xml CompNfse
 * @param {{ ibge?: string, municipioNome?: string }} ctx dados do vínculo (município consultado)
 * @returns {object} nota canônica + { eventos: [{tipo_evento, data_evento, descricao}] }
 */
export function parseCompNfse(xml, ctx = {}) {
  const arvore = parser.parse(xml);
  const comp = achar(arvore, 'CompNfse') ?? arvore;
  const inf = achar(comp, 'InfNfse');
  if (!inf) throw new Error('CompNfse sem InfNfse');

  const declaracao = de(inf, 'InfDeclaracaoPrestacaoServico') ?? {};
  const servico = de(declaracao, 'Servico') ?? de(inf, 'Servico') ?? {};
  const valoresServ = de(servico, 'Valores') ?? {};
  const valoresNfse = de(inf, 'ValoresNfse') ?? {};

  const prestadorServico = de(inf, 'PrestadorServico') ?? {};
  const prestadorDecl = de(declaracao, 'Prestador') ?? {};
  const prestadorDoc = docDe(de(prestadorServico, 'IdentificacaoPrestador') ?? prestadorServico) ?? docDe(prestadorDecl);
  const tomadorNo = de(declaracao, 'TomadorServico', 'Tomador') ?? de(inf, 'TomadorServico', 'Tomador') ?? null;
  const intermNo = de(declaracao, 'Intermediario', 'IntermediarioServico') ?? de(inf, 'IntermediarioServico', 'Intermediario') ?? null;

  const numero = texto(de(inf, 'Numero'));
  const ibgeGerador = texto(de(de(inf, 'OrgaoGerador') ?? {}, 'CodigoMunicipio')) ?? ctx.ibge ?? null;
  const dataEmissao = texto(de(inf, 'DataEmissao')) ?? null;
  const competencia = (texto(de(declaracao, 'Competencia')) ?? texto(de(inf, 'Competencia')) ?? dataEmissao ?? '').slice(0, 10) || null;

  const valorServico = num(de(valoresServ, 'ValorServicos'));
  const valorDeducoes = num(de(valoresServ, 'ValorDeducoes'));
  const baseCalculo = num(de(valoresNfse, 'BaseCalculo')) || num(de(valoresServ, 'BaseCalculo')) || Math.max(valorServico - valorDeducoes, 0);
  const aliquota = normalizarAliquota(de(valoresNfse, 'Aliquota') ?? de(valoresServ, 'Aliquota'));
  const valorIss = num(de(valoresNfse, 'ValorIss')) || num(de(valoresServ, 'ValorIss'));
  // IssRetido: 1 = sim, 2 = não (2.0x fica em Servico; 1.00 em Servico/Valores)
  const issRetido = String(texto(de(servico, 'IssRetido')) ?? texto(de(valoresServ, 'IssRetido')) ?? '2') === '1';
  const responsavel = String(texto(de(servico, 'ResponsavelRetencao')) ?? '1'); // 1 tomador | 2 intermediário

  const pis = num(de(valoresServ, 'ValorPis'));
  const cofins = num(de(valoresServ, 'ValorCofins'));
  const inss = num(de(valoresServ, 'ValorInss'));
  const irrf = num(de(valoresServ, 'ValorIr'));
  const csll = num(de(valoresServ, 'ValorCsll'));
  const outras = num(de(valoresServ, 'OutrasRetencoes'));
  const descontos = num(de(valoresServ, 'DescontoIncondicionado')) + num(de(valoresServ, 'DescontoCondicionado'));
  // No ABRASF os campos PIS/COFINS/INSS/IR/CSLL são valores retidos.
  const totalRetencoes = pis + cofins + inss + irrf + csll + outras + (issRetido ? valorIss : 0);
  const valorLiquido = num(de(valoresNfse, 'ValorLiquidoNfse')) || num(de(valoresServ, 'ValorLiquidoNfse')) || valorServico - totalRetencoes - descontos;

  // Regime: OptanteSimplesNacional (1 sim, 2 não); RegimeEspecialTributacao 5 = MEI
  const optante = texto(de(declaracao, 'OptanteSimplesNacional')) ?? texto(de(inf, 'OptanteSimplesNacional'));
  const regimeEspecial = texto(de(declaracao, 'RegimeEspecialTributacao')) ?? texto(de(inf, 'RegimeEspecialTributacao'));
  const prestadorRegime = regimeEspecial === '5' ? '2' : optante === '1' ? '3' : optante === '2' ? '1' : null;

  const itemLista = texto(de(servico, 'ItemListaServico'));
  const municipioIncidencia = texto(de(servico, 'MunicipioIncidencia')) ?? texto(de(servico, 'CodigoMunicipio')) ?? null;

  // Cancelamento / substituição informados dentro da própria CompNfse
  const eventos = [];
  let situacao = 'normal';
  const canc = achar(comp, 'NfseCancelamento');
  if (canc) {
    situacao = 'cancelada';
    eventos.push({
      tipo_evento: '101101',
      descricao: 'Cancelamento de NFS-e (prefeitura)',
      data_evento: texto(de(canc, 'DataHora', 'DataHoraCancelamento')) ?? null,
    });
  }
  const subst = achar(comp, 'NfseSubstituicao');
  if (subst && situacao === 'normal') {
    situacao = 'substituida';
    eventos.push({ tipo_evento: '105102', descricao: 'Substituição de NFS-e (prefeitura)', data_evento: dataEmissao });
  }

  return {
    chave: chaveMunicipal({ ibge: ibgeGerador, prestadorDoc, numero }),
    sistema: 'abrasf',
    numero: numero ?? null,
    codigo_verificacao: texto(de(inf, 'CodigoVerificacao')) ?? null,
    municipio_gerador: ibgeGerador,
    data_emissao: dataEmissao,
    competencia,
    municipio_emissao: ctx.municipioNome ?? null,
    municipio_incidencia: municipioIncidencia && municipioIncidencia === ctx.ibge ? ctx.municipioNome ?? municipioIncidencia : municipioIncidencia,
    codigo_municipio_incidencia: municipioIncidencia,
    prestador_doc: prestadorDoc,
    prestador_nome: texto(de(prestadorServico, 'RazaoSocial')) ?? null,
    prestador_im: texto(de(de(prestadorServico, 'IdentificacaoPrestador') ?? prestadorServico, 'InscricaoMunicipal')) ?? texto(de(prestadorDecl, 'InscricaoMunicipal')) ?? null,
    prestador_regime: prestadorRegime,
    tomador_doc: tomadorNo ? docDe(tomadorNo) : null,
    tomador_nome: tomadorNo ? texto(de(tomadorNo, 'RazaoSocial')) ?? null : null,
    intermediario_doc: intermNo ? docDe(intermNo) : null,
    codigo_servico: normalizarItemLista(itemLista),
    codigo_servico_municipal: texto(de(servico, 'CodigoTributacaoMunicipio')) ?? itemLista ?? null,
    codigo_nbs: null,
    descricao: texto(de(servico, 'Discriminacao')) ?? null,
    valor_servico: arred(valorServico),
    valor_deducoes: arred(valorDeducoes),
    base_calculo: arred(baseCalculo),
    aliquota,
    valor_iss: arred(valorIss),
    iss_retido: issRetido,
    tp_ret_issqn: issRetido ? (responsavel === '2' ? '3' : '2') : '1',
    valor_pis: arred(pis),
    valor_cofins: arred(cofins),
    pis_cofins_retido: pis + cofins > 0,
    valor_csll: arred(csll),
    valor_irrf: arred(irrf),
    valor_inss: arred(inss),
    valor_total_retencoes: arred(totalRetencoes),
    valor_liquido: arred(valorLiquido),
    situacao,
    eventos,
  };
}
