// Apuração do ISS de uma empresa num município, por competência (AAAA-MM).
//
//  • ISS próprio  : notas PRESTADAS normais, com incidência no município e ISS NÃO retido pelo tomador.
//                   Empresa do Simples Nacional (ME/EPP/MEI) recolhe no DAS → não gera guia municipal.
//  • ISS retido   : notas TOMADAS normais, com incidência no município, ISS retido pelo tomador (tpRetISSQN 2):
//                   a empresa é substituta tributária e recolhe a guia.
//  • Retido pelo intermediário (tpRetISSQN 3) e prestadas retidas pelo cliente: só informativo.
//  • Pendências   : impedem (BLOQUEANTE) ou pedem atenção (ALERTA) antes do encerramento.
//
// A apuração é DETERMINÍSTICA: o snapshot (lista de notas + valores) tem hash SHA-256; se uma nota chegar ou mudar
// depois da aprovação, o hash muda e a competência fica "desatualizada" até nova aprovação.
import crypto from 'node:crypto';
import { municipioConhecido } from '../conectores/municipios-conhecidos.js';

export const APURACAO_VERSAO = 'apuracao-iss-2026.11.1';
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export function limitesDoMes(competencia) {
  if (!MES.test(competencia)) throw new Error('Competência no formato AAAA-MM.');
  const [a, m] = competencia.split('-').map(Number);
  return { de: `${competencia}-01`, ate: new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10) };
}

const SIMPLES = { 2: 'MEI', 3: 'ME/EPP (Simples Nacional)' };

/** Incidência no município? Usa o código IBGE; nas notas municipais sem código, a nota do próprio município conta. */
function incideNo(d, ibge) {
  if (d.codigo_municipio_incidencia) return String(d.codigo_municipio_incidencia) === String(ibge);
  return d.sistema === 'abrasf' && String(d.municipio_gerador) === String(ibge);
}

function resumoNota(d) {
  return {
    id: d.id, chave: d.chave, numero: d.numero, data_emissao: d.data_emissao, competencia: d.competencia,
    prestador_doc: d.prestador_doc, prestador_nome: d.prestador_nome, tomador_doc: d.tomador_doc, tomador_nome: d.tomador_nome,
    codigo_servico: d.codigo_servico, base_calculo: r2(d.base_calculo || d.valor_servico), aliquota: r2(d.aliquota), valor_iss: r2(d.valor_iss),
    tp_ret_issqn: d.tp_ret_issqn ?? null, sistema: d.sistema ?? null, municipio_gerador: d.municipio_gerador ?? null,
  };
}

function somar(notas) {
  const porAliquota = new Map();
  let base = 0, iss = 0;
  for (const n of notas) {
    base += n.base_calculo; iss += n.valor_iss;
    const k = n.aliquota.toFixed(2);
    const a = porAliquota.get(k) ?? { aliquota: n.aliquota, notas: 0, base: 0, iss: 0 };
    a.notas++; a.base = r2(a.base + n.base_calculo); a.iss = r2(a.iss + n.valor_iss);
    porAliquota.set(k, a);
  }
  return { notas: notas.length, base: r2(base), iss: r2(iss), porAliquota: [...porAliquota.values()].sort((x, y) => x.aliquota - y.aliquota) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ empresaId:number, ibge:string, competencia:string, agora?:Date }} q
 */
export function apurarCompetencia(db, { empresaId, ibge, competencia, agora = new Date() }) {
  const { de, ate } = limitesDoMes(competencia);
  const empresa = db.prepare('SELECT id, cnpj, razao_social FROM empresas WHERE id = ?').get(empresaId);
  if (!empresa) throw new Error('Empresa não encontrada.');
  const municipio = db.prepare('SELECT ibge, nome, uf FROM municipios WHERE ibge = ?').get(String(ibge)) ?? (() => {
    const c = municipioConhecido(ibge);
    return c ? { ibge: c.ibge, nome: c.nome, uf: c.uf } : { ibge: String(ibge), nome: String(ibge), uf: null };
  })();
  const docs = db.prepare(`SELECT * FROM documentos WHERE empresa_id = ? AND competencia BETWEEN ? AND ? ORDER BY competencia, numero`).all(empresaId, de, ate);

  const normais = docs.filter((d) => d.situacao === 'normal');
  const prestadas = normais.filter((d) => d.papel === 'emitida');
  const tomadas = normais.filter((d) => d.papel === 'recebida');

  // regime da empresa: o que ela mesma declara nas notas que emite (opSimpNac)
  const regimes = [...new Set(prestadas.map((d) => d.prestador_regime).filter(Boolean).map(String))];
  const simples = regimes.length > 0 && regimes.every((r) => SIMPLES[r]);

  const proprioNotas = prestadas.filter((d) => incideNo(d, ibge) && !d.iss_retido).map(resumoNota);
  const retidoPeloCliente = prestadas.filter((d) => incideNo(d, ibge) && d.iss_retido).map(resumoNota);
  const retidoNotas = tomadas.filter((d) => incideNo(d, ibge) && d.iss_retido && String(d.tp_ret_issqn ?? '2') !== '3').map(resumoNota);
  const retidoIntermediario = tomadas.filter((d) => incideNo(d, ibge) && d.iss_retido && String(d.tp_ret_issqn) === '3').map(resumoNota);

  const proprio = { ...somar(proprioNotas), simplesNacional: simples, regime: simples ? SIMPLES[regimes[0]] : regimes.length ? 'normal' : 'não identificado (sem notas prestadas)' };
  proprio.aRecolher = simples ? 0 : proprio.iss;
  const porPrestador = new Map();
  for (const n of retidoNotas) {
    const p = porPrestador.get(n.prestador_doc) ?? { prestador_doc: n.prestador_doc, prestador_nome: n.prestador_nome, notas: 0, base: 0, iss: 0 };
    p.notas++; p.base = r2(p.base + n.base_calculo); p.iss = r2(p.iss + n.valor_iss);
    porPrestador.set(n.prestador_doc, p);
  }
  const retido = { ...somar(retidoNotas), aRecolher: 0, porPrestador: [...porPrestador.values()].sort((a, b) => b.iss - a.iss) };
  retido.aRecolher = retido.iss;

  // ---------- pendências ----------
  const pend = [];
  const add = (severidade, codigo, mensagem, extra = {}) => pend.push({ severidade, codigo, mensagem, ...extra });
  const ids = docs.map((d) => d.id);
  if (ids.length) {
    const bloq = db.prepare(`SELECT v.codigo, COUNT(*) AS n FROM divergencias v WHERE v.status = 'aberta' AND v.severidade = 'BLOQUEANTE'
      AND v.documento_id IN (${ids.map(() => '?').join(',')}) GROUP BY v.codigo`).all(...ids);
    for (const b of bloq) add('BLOQUEANTE', `DIV-${b.codigo}`, `${b.n} nota(s) com divergência bloqueante ${b.codigo} em aberto na Conferência.`, { regra: b.codigo });
  }
  // cobertura: as buscas precisam ter rodado depois do fim do mês (notas emitidas no último dia, cancelamentos)
  const limite = `${ate} 23:59:59`;
  const adn = db.prepare(`SELECT MAX(fim) AS fim FROM execucoes WHERE empresa_id = ? AND tipo = 'busca_adn'
    AND codigo IN ('SUCESSO','SEM_MOVIMENTO','SUCESSO_PARCIAL')`).get(empresaId)?.fim;
  if (!adn || adn <= limite) add('BLOQUEANTE', 'COBERTURA-ADN', `A busca no ADN ainda não rodou depois de ${ate.split('-').reverse().join('/')}: rode "Buscar" antes de encerrar.`);
  const vinc = db.prepare('SELECT ultima_data FROM vinculos_municipais WHERE empresa_id = ? AND ibge = ? AND ativo = 1').get(empresaId, String(ibge));
  if (vinc && (!vinc.ultima_data || vinc.ultima_data < ate)) {
    add('BLOQUEANTE', 'COBERTURA-PREFEITURA', `A busca na prefeitura de ${municipio.nome} só cobre até ${vinc.ultima_data ? vinc.ultima_data.split('-').reverse().join('/') : 'nunca'}: rode "Buscar agora" no vínculo.`);
  }
  const fimMes = new Date(`${ate}T23:59:59Z`);
  if (agora <= fimMes) add('BLOQUEANTE', 'COMPETENCIA-ABERTA', 'A competência ainda não terminou.');

  const semIncidencia = normais.filter((d) => !d.codigo_municipio_incidencia && d.sistema !== 'abrasf');
  if (semIncidencia.length) add('ALERTA', 'SEM-INCIDENCIA', `${semIncidencia.length} nota(s) sem município de incidência: confira manualmente se o ISS é de ${municipio.nome}.`, { notas: semIncidencia.map((d) => d.numero ?? d.chave) });
  // tomadas de prestador de fora do município com ISS devido ao município e sem retenção: declarar/recolher como tomador
  const foraSemRetencao = tomadas.filter((d) => incideNo(d, ibge) && !d.iss_retido && d.municipio_gerador && String(d.municipio_gerador) !== String(ibge));
  const cfg = municipioConhecido(ibge)?.fiscal;
  if (foraSemRetencao.length) {
    add('ALERTA', 'TOMADOR-FORA', `${foraSemRetencao.length} nota(s) tomada(s) de prestador de fora com ISS devido a ${municipio.nome} e sem retenção. ` +
      (cfg?.declaracaoTomador ?? 'Verifique a declaração de serviços tomados e a responsabilidade pelo recolhimento.'),
    { notas: foraSemRetencao.map((d) => d.numero ?? d.chave) });
  }
  const foraTodas = tomadas.filter((d) => d.municipio_gerador && String(d.municipio_gerador) !== String(ibge));
  if (foraTodas.length && cfg?.declaracaoTomador) add('INFO', 'DECLARACAO-TOMADOR', `${foraTodas.length} nota(s) tomada(s) de prestador de fora do município. ${cfg.declaracaoTomador}`);
  if (simples && proprio.iss > 0) add('INFO', 'SIMPLES', `ISS próprio de ${proprio.notas} nota(s) é recolhido no DAS (Simples Nacional): não gera guia municipal.`);
  if (retidoIntermediario.length) add('INFO', 'RETIDO-INTERMEDIARIO', `${retidoIntermediario.length} nota(s) com ISS retido pelo intermediário: não entram na guia da empresa.`);
  if (!prestadas.length && !tomadas.length) add('INFO', 'SEM-MOVIMENTO', 'Nenhuma nota na competência: confira se é preciso declarar "sem movimento" no portal.');

  const snapshot = {
    versao: APURACAO_VERSAO, empresa: empresa.cnpj, ibge: String(ibge), competencia,
    proprio: proprioNotas.map((n) => [n.chave, n.base_calculo, n.aliquota, n.valor_iss]),
    retido: retidoNotas.map((n) => [n.chave, n.base_calculo, n.aliquota, n.valor_iss]),
    simples,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

  return {
    versao: APURACAO_VERSAO,
    empresa: { id: empresa.id, cnpj: empresa.cnpj, razao_social: empresa.razao_social },
    municipio,
    competencia, periodo: { de, ate },
    proprio: { ...proprio, notasDetalhe: proprioNotas },
    retido: { ...retido, notasDetalhe: retidoNotas },
    informativo: {
      retidoPeloCliente: somar(retidoPeloCliente),
      retidoIntermediario: somar(retidoIntermediario),
      canceladas: docs.filter((d) => d.situacao !== 'normal').length,
    },
    totalARecolher: r2(proprio.aRecolher + retido.aRecolher),
    guiasEsperadas: [
      ...(proprio.aRecolher > 0 ? [{ tipo: 'ISS_PROPRIO', valor: proprio.aRecolher }] : []),
      ...(retido.aRecolher > 0 ? [{ tipo: 'ISS_RETIDO', valor: retido.aRecolher }] : []),
    ],
    pendencias: pend,
    bloqueantes: pend.filter((p) => p.severidade === 'BLOQUEANTE').length,
    fiscal: cfg ?? null,
    hash,
    gerado_em: agora.toISOString(),
  };
}
