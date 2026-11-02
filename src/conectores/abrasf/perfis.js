// Perfis do padrão ABRASF de NFS-e municipal.
// O mesmo padrão tem versões (1.00, 2.01–2.04) e cada fornecedor/município varia o envelope SOAP.
// Tudo o que varia fica em `opcoes`, configuráveis por município no cadastro — nunca no código.

export const NS_ABRASF_1 = 'http://www.abrasf.org.br/ABRASF/arquivos/nfse.xsd';
export const NS_ABRASF_2 = 'http://www.abrasf.org.br/nfse.xsd';

const OPS_2 = {
  prestadas: { soap: 'ConsultarNfseServicoPrestado', envio: 'ConsultarNfseServicoPrestadoEnvio', resposta: 'ConsultarNfseServicoPrestadoResposta' },
  tomadas: { soap: 'ConsultarNfseServicoTomado', envio: 'ConsultarNfseServicoTomadoEnvio', resposta: 'ConsultarNfseServicoTomadoResposta' },
};

/** Opções padrão (sobrescritas pelo cadastro do município). */
export const OPCOES_PADRAO = {
  soapVersao: '1.1',             // '1.1' (text/xml + SOAPAction) | '1.2' (application/soap+xml)
  estilo: 'cabec-dados',         // 'cabec-dados' (nfseCabecMsg/nfseDadosMsg) | 'direto' (XML no Body)
  embutir: 'escapado',           // como o XML vai dentro de nfseDadosMsg: 'escapado' | 'cdata'
  nsServico: 'http://nfse.abrasf.org.br', // namespace do elemento da operação no Body
  elementoOperacao: '{op}Request',// nome do elemento no Body ({op} = ConsultarNfseServicoPrestado...)
  soapAction: '{ns}/{op}',       // cabeçalho SOAPAction ({ns}, {op}); vazio = sem SOAPAction
  periodo: 'emissao',            // 'emissao' (PeriodoEmissao) | 'competencia' (PeriodoCompetencia)
  janelaDias: 30,                // tamanho máximo do período por consulta
  intervaloMs: 1200,             // pausa entre requisições (respeito ao servidor)
  maxPaginas: 200,               // proteção contra paginação infinita
  assinarConsulta: false,        // assina a consulta (XMLDSig); detectado automaticamente se a prefeitura exigir
  algoritmoAssinatura: 'sha1',   // 'sha1' (padrão ABRASF) | 'sha256'
  namespaceDados: undefined,     // namespace do XML de dados; undefined = o do padrão; '' = sem namespace
  timeoutMs: 60000,
};

export const PERFIS = {
  'abrasf-1.00': {
    id: 'abrasf-1.00',
    nome: 'ABRASF 1.00',
    versao: '1.00',
    namespace: NS_ABRASF_1,
    operacoes: { prestadas: { soap: 'ConsultarNfse', envio: 'ConsultarNfseEnvio', resposta: 'ConsultarNfseResposta' } },
    paginacao: false,
    // Na 1.00 a consulta exige o prestador: notas tomadas não podem ser listadas pelo tomador.
    opcoes: { estilo: 'direto', elementoOperacao: '{op}', periodo: 'emissao' },
  },
  'abrasf-2.01': { id: 'abrasf-2.01', nome: 'ABRASF 2.01', versao: '2.01', namespace: NS_ABRASF_2, operacoes: OPS_2, paginacao: true, opcoes: {} },
  'abrasf-2.02': { id: 'abrasf-2.02', nome: 'ABRASF 2.02', versao: '2.02', namespace: NS_ABRASF_2, operacoes: OPS_2, paginacao: true, opcoes: {} },
  'abrasf-2.03': { id: 'abrasf-2.03', nome: 'ABRASF 2.03', versao: '2.03', namespace: NS_ABRASF_2, operacoes: OPS_2, paginacao: true, opcoes: {} },
  'abrasf-2.04': { id: 'abrasf-2.04', nome: 'ABRASF 2.04', versao: '2.04', namespace: NS_ABRASF_2, operacoes: OPS_2, paginacao: true, opcoes: {} },
};

export function obterPerfil(id) {
  const p = PERFIS[id];
  if (!p) throw new Error(`Perfil desconhecido: ${id}. Disponíveis: ${Object.keys(PERFIS).join(', ')}`);
  return p;
}

/** Opções em que o valor vazio tem significado: soapAction '' = cabeçalho vazio; namespaceDados '' = sem namespace. */
const VAZIO_SIGNIFICA = new Set(['soapAction', 'namespaceDados']);

/** Opções efetivas: padrão < perfil < município. */
export function opcoesEfetivas(perfil, opcoesMunicipio = {}) {
  // '' só é aceito onde vazio tem significado (soapAction vazio = não enviar o cabeçalho)
  const limpas = Object.fromEntries(Object.entries(opcoesMunicipio ?? {}).filter(([k, v]) => v !== null && v !== undefined && (v !== '' || VAZIO_SIGNIFICA.has(k))));
  return { ...OPCOES_PADRAO, ...perfil.opcoes, ...limpas };
}

/** Tipos das opções configuráveis (para validar o que vem do painel/CLI). */
export const TIPOS_OPCOES = {
  soapVersao: ['1.1', '1.2'], estilo: ['cabec-dados', 'direto'], embutir: ['escapado', 'cdata'], periodo: ['emissao', 'competencia'], algoritmoAssinatura: ['sha1', 'sha256'],
  nsServico: 'texto', elementoOperacao: 'texto', soapAction: 'texto', namespaceDados: 'texto',
  janelaDias: 'numero', intervaloMs: 'numero', maxPaginas: 'numero', timeoutMs: 'numero', assinarConsulta: 'booleano',
};

/** Mantém só opções conhecidas, com o tipo certo. Lança erro em valor inválido. */
export function sanitizarOpcoes(opcoes = {}) {
  const r = {};
  for (const [k, v] of Object.entries(opcoes ?? {})) {
    const tipo = TIPOS_OPCOES[k];
    if (!tipo || v === null || v === undefined || (v === '' && !VAZIO_SIGNIFICA.has(k))) continue;
    if (Array.isArray(tipo)) {
      if (!tipo.includes(String(v))) throw new Error(`Opção ${k} inválida: ${v} (use ${tipo.join(' | ')})`);
      r[k] = String(v);
    } else if (tipo === 'numero') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Opção ${k} deve ser um número: ${v}`);
      r[k] = n;
    } else if (tipo === 'booleano') r[k] = v === true || v === 'true' || v === '1' || v === 1;
    else r[k] = String(v);
  }
  return r;
}

export const listaPerfis = () => Object.values(PERFIS).map(({ id, nome, versao, operacoes, paginacao }) => ({
  id, nome, versao, paginacao, tomadas: !!operacoes.tomadas,
}));
