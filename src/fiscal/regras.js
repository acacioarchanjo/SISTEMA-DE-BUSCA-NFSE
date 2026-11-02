// Regras fiscais da fase 1 (docs/arquitetura-rpa-iss-nfse.md, seção 6):
// retenção (RET-*), alíquota (ALQ-*), competência (CMP-*) e cancelamento (CAN-*).
//
// O robô NÃO decide o tributo: ele aponta divergências para um analista conferir.
// Cada regra tem fonte legal e início de vigência; regras municipais específicas
// (listas próprias de retenção, CPOM etc.) entram nas próximas fases.

export const REGRAS_VERSAO = 'regras-2026.11.1';

/** Subitens da LC 116/2003, art. 6º, §2º, II: PJ tomadora/intermediária é responsável pela retenção. */
export const SUBITENS_RETENCAO_TOMADOR_PJ = new Set([
  '3.05', '7.02', '7.04', '7.05', '7.09', '7.10', '7.12', '7.16', '7.17', '7.19', '11.02', '17.05', '17.10',
]);

/** Subitens com exceção à alíquota mínima de 2% (LC 116, art. 8º-A, §1º). */
export const SUBITENS_EXCECAO_ALIQUOTA_MINIMA = new Set(['7.02', '7.05', '16.01']);

/** Eventos que cancelam ou substituem a nota. */
const EVENTOS_CANCELAMENTO = new Set(['101101', '105102', '105104', '305101']);

const REGIME = { 1: 'não optante do Simples', 2: 'MEI', 3: 'ME/EPP do Simples Nacional' };

/** "070201" (cTribNac) → "7.02" */
export function subitemDe(codigoServico) {
  const c = String(codigoServico ?? '').replace(/\D/g, '');
  if (c.length < 4) return null;
  return `${Number(c.slice(0, 2))}.${c.slice(2, 4)}`;
}

const tipoDoc = (doc) => {
  const d = String(doc ?? '').replace(/\D/g, '');
  return d.length === 14 ? 'PJ' : d.length === 11 ? 'PF' : null;
};
const mesDe = (data) => (data ? String(data).slice(0, 7) : null); // AAAA-MM
const mesesEntre = (a, b) => {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
};
const mmaaaa = (aaaamm) => (aaaamm ? `${aaaamm.slice(5, 7)}/${aaaamm.slice(0, 4)}` : '?');
const pct = (v) => `${Number(v ?? 0).toFixed(2).replace('.', ',')}%`;
const ativa = (nota) => nota.situacao === 'normal';

/**
 * Cada regra: avaliar(nota, ctx) → null (ok) | { severidade?, mensagem, detalhes? }
 * ctx = { eventos: [...] } (eventos da nota já gravados)
 */
export const REGRAS = [
  {
    codigo: 'RET-001',
    titulo: 'Retenção obrigatória do tomador não destacada',
    severidade: 'BLOQUEANTE',
    fonte_legal: 'LC 116/2003, art. 6º, §2º, II',
    vigencia_inicio: '2003-08',
    avaliar(n) {
      const sub = subitemDe(n.codigo_servico);
      if (!ativa(n) || !sub || !SUBITENS_RETENCAO_TOMADOR_PJ.has(sub)) return null;
      if (tipoDoc(n.tomador_doc) !== 'PJ' || n.iss_retido) return null;
      if (n.prestador_regime === '2') return null; // MEI: em regra não sofre retenção
      const quem = n.papel === 'recebida' ? 'A empresa (tomadora PJ)' : n.papel === 'intermediario' ? 'A empresa (intermediária)' : 'O tomador PJ';
      return {
        // Para a tomadora, a responsabilidade é dela; para a prestadora, é um alerta de conferência.
        severidade: n.papel === 'emitida' ? 'ALERTA' : 'BLOQUEANTE',
        mensagem: `Serviço do subitem ${sub} prestado a PJ sem ISS retido. ${quem} é responsável pela retenção (LC 116, art. 6º, §2º, II), salvo lei municipal diferente ou imunidade/isenção comprovada.`,
        detalhes: { subitem: sub, papel: n.papel, tomador: 'PJ', iss_retido: false },
      };
    },
  },
  {
    codigo: 'RET-002',
    titulo: 'Retenção destacada sem responsabilidade prevista na LC 116',
    severidade: 'ALERTA',
    fonte_legal: 'LC 116/2003, art. 6º, §2º',
    vigencia_inicio: '2003-08',
    avaliar(n) {
      if (!ativa(n) || !n.iss_retido) return null;
      const sub = subitemDe(n.codigo_servico);
      const tomador = tipoDoc(n.tomador_doc);
      if (tomador === 'PJ' && sub && SUBITENS_RETENCAO_TOMADOR_PJ.has(sub)) return null;
      if (!sub && tomador === 'PJ') return null; // sem código de serviço não dá para concluir
      const motivo = tomador === 'PF'
        ? 'o tomador é pessoa física, que em regra não é responsável pela retenção'
        : !tomador
          ? 'a nota não identifica o tomador'
          : `o subitem ${sub} não está na lista do art. 6º, §2º, II`;
      return {
        mensagem: `ISS retido, mas ${motivo}. Confirme se há lei municipal que exija a retenção; caso contrário, há risco de o ISS ser recolhido duas vezes.`,
        detalhes: { subitem: sub, tomador, tp_ret_issqn: n.tp_ret_issqn },
      };
    },
  },
  {
    codigo: 'RET-004',
    titulo: 'Retenção de prestador do Simples com alíquota fora da faixa',
    severidade: 'ALERTA',
    fonte_legal: 'LC 123/2006, art. 21, §4º; LC 116, arts. 8º e 8º-A',
    vigencia_inicio: '2009-01',
    avaliar(n) {
      if (!ativa(n) || !n.iss_retido || n.prestador_regime !== '3') return null;
      const a = Number(n.aliquota ?? 0);
      if (a >= 2 && a <= 5) return null;
      return {
        mensagem: `Prestador ME/EPP do Simples Nacional com ISS retido à alíquota de ${pct(a)}. A alíquota da retenção deve ser a informada pelo prestador conforme o Anexo do Simples, entre 2% e 5%.`,
        detalhes: { aliquota: a, regime: REGIME[3] },
      };
    },
  },
  {
    codigo: 'RET-005',
    titulo: 'ISS retido de prestador MEI',
    severidade: 'ALERTA',
    fonte_legal: 'LC 123/2006, art. 18-A',
    vigencia_inicio: '2009-07',
    avaliar(n) {
      if (!ativa(n) || !n.iss_retido || n.prestador_regime !== '2') return null;
      return {
        mensagem: 'Prestador MEI com ISS retido. O MEI recolhe ISS em valor fixo no DAS-MEI e, em regra, não sofre retenção.',
        detalhes: { regime: REGIME[2] },
      };
    },
  },
  {
    codigo: 'ALQ-001',
    titulo: 'Alíquota abaixo do mínimo de 2%',
    severidade: 'ALERTA',
    fonte_legal: 'LC 116/2003, art. 8º-A (LC 157/2016)',
    vigencia_inicio: '2017-01',
    avaliar(n) {
      const a = Number(n.aliquota ?? 0);
      if (!ativa(n) || !(a > 0 && a < 2)) return null;
      if (['2', '3'].includes(n.prestador_regime)) return null; // Simples: alíquota segue os Anexos
      const sub = subitemDe(n.codigo_servico);
      if (sub && SUBITENS_EXCECAO_ALIQUOTA_MINIMA.has(sub)) return null;
      return {
        mensagem: `Alíquota de ${pct(a)}, abaixo do mínimo de 2% (exceções: subitens 7.02, 7.05 e 16.01). Confira o cadastro do serviço no município.`,
        detalhes: { aliquota: a, subitem: sub },
      };
    },
  },
  {
    codigo: 'ALQ-002',
    titulo: 'Alíquota acima do máximo de 5%',
    severidade: 'BLOQUEANTE',
    fonte_legal: 'LC 116/2003, art. 8º, II',
    vigencia_inicio: '2003-08',
    avaliar(n) {
      const a = Number(n.aliquota ?? 0);
      if (!ativa(n) || a <= 5) return null;
      return { mensagem: `Alíquota de ${pct(a)}, acima do máximo legal de 5%. Provável erro de cadastro do serviço.`, detalhes: { aliquota: a } };
    },
  },
  {
    codigo: 'CMP-001',
    titulo: 'Nota emitida depois do mês de competência',
    severidade: 'INFO',
    fonte_legal: 'Leiaute NFS-e Nacional (dCompet)',
    vigencia_inicio: '2003-08',
    avaliar(n) {
      const comp = mesDe(n.competencia);
      const emi = mesDe(n.data_emissao);
      if (!comp || !emi) return null;
      const d = mesesEntre(comp, emi);
      if (d < 1) return null;
      return {
        severidade: d >= 3 ? 'ALERTA' : 'INFO',
        mensagem: `Emitida em ${mmaaaa(emi)} para a competência ${mmaaaa(comp)} (${d} mês(es) depois). Se a competência já foi declarada ou o livro fechado, pode ser preciso retificar.`,
        detalhes: { competencia: comp, emissao: emi, meses: d },
      };
    },
  },
  {
    codigo: 'CAN-001',
    titulo: 'Nota cancelada ou substituída depois do mês de competência',
    severidade: 'BLOQUEANTE',
    fonte_legal: 'Leiaute NFS-e Nacional (eventos 101101, 105102, 105104, 305101)',
    vigencia_inicio: '2003-08',
    avaliar(n, ctx) {
      if (ativa(n)) return null;
      const comp = mesDe(n.competencia);
      const evs = (ctx.eventos ?? []).filter((e) => EVENTOS_CANCELAMENTO.has(String(e.tipo_evento)));
      const datas = evs.map((e) => mesDe(e.data_evento)).filter(Boolean).sort();
      if (!comp) return null;
      if (!datas.length) {
        return {
          severidade: 'ALERTA',
          mensagem: `Nota ${n.situacao} sem data do evento registrada. Confira se ela foi escriturada ou declarada na competência ${mmaaaa(comp)}.`,
          detalhes: { situacao: n.situacao },
        };
      }
      const mesEvento = datas[0];
      if (mesesEntre(comp, mesEvento) < 1) return null; // cancelada no próprio mês: sem impacto
      return {
        mensagem: `Nota ${n.situacao} em ${mmaaaa(mesEvento)}, depois da competência ${mmaaaa(comp)}. Se ela já foi escriturada ou declarada, a declaração precisa ser retificada.`,
        detalhes: { situacao: n.situacao, competencia: comp, mes_evento: mesEvento, eventos: evs.map((e) => e.tipo_evento) },
      };
    },
  },
];

/** Metadados públicos das regras (para o painel e a CLI). */
export const catalogoRegras = () =>
  REGRAS.map(({ codigo, titulo, severidade, fonte_legal, vigencia_inicio }) => ({ codigo, titulo, severidade, fonte_legal, vigencia_inicio }));

/** Aplica as regras vigentes na competência da nota. */
export function avaliarNota(nota, ctx = {}) {
  const comp = mesDe(nota.competencia) ?? '9999-12';
  const resultado = [];
  for (const r of REGRAS) {
    if (r.vigencia_inicio > comp) continue;
    const d = r.avaliar(nota, ctx);
    if (d) resultado.push({ codigo: r.codigo, titulo: r.titulo, severidade: d.severidade ?? r.severidade, fonte_legal: r.fonte_legal, mensagem: d.mensagem, detalhes: d.detalhes ?? {} });
  }
  return resultado;
}
