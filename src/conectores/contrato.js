// Contrato dos conectores municipais (docs/arquitetura-rpa-iss-nfse.md, seção 7.2).
// Cada sistema de prefeitura implementa esta interface e declara o que sabe fazer.
// O orquestrador (sincronizacao.js) não conhece detalhes de tela/SOAP de nenhum sistema.

/** Como uma operação é realizada naquele sistema. */
export const METODO = { API: 'API', ARQUIVO: 'ARQ', WEB: 'WEB', HITL: 'HITL', NAO_SUPORTADO: 'NAO_SUPORTADO' };

/** Operações previstas na arquitetura (fase 2 implementa as de leitura). */
export const OPERACOES = ['notas_prestadas', 'notas_tomadas', 'eventos', 'manifestar', 'declarar', 'encerrar', 'emitir_guia', 'consultar_debitos', 'emitir_certidao'];

/**
 * Erro tipado de conector: já carrega o código do catálogo de status (src/execucao/catalogo.js).
 * Conectores NUNCA lançam erro genérico para situações previstas.
 */
export class ErroConector extends Error {
  name = 'ErroConector';
  /**
   * @param {string} codigo   ERRO_AUTENTICACAO | PORTAL_INDISPONIVEL | LIMITE_CONSUMO | MUDANCA_LAYOUT | DADO_INCONSISTENTE | ERRO_CONFIGURACAO | EXIGE_ACAO_USUARIO
   * @param {string|null} subcodigo
   * @param {string} mensagem
   * @param {{temporario?:boolean, resposta?:string, status?:number}} [extra]
   */
  constructor(codigo, subcodigo, mensagem, extra = {}) {
    super(mensagem);
    this.codigo = codigo;
    this.subcodigo = subcodigo;
    this.temporario = !!extra.temporario;
    this.status = extra.status;
    // trecho da resposta para diagnóstico (nunca a requisição: pode conter dados do certificado)
    this.resposta = extra.resposta ? String(extra.resposta).slice(0, 2000) : undefined;
  }
}

/**
 * Interface (documentação executável). Um conector:
 *  - id: string                         ex.: "abrasf-2.02@1.0.0"
 *  - capacidades(): {operacao: METODO}  matriz de capacidades
 *  - listarNotas({ papel, de, ate }): AsyncIterable<{ xml, nota, eventos? }>
 *      papel: 'prestadas' | 'tomadas'; de/ate: 'AAAA-MM-DD' (o conector quebra em janelas/páginas)
 *  - testar(): Promise<{ ok, mensagem }>  consulta mínima para validar URL/certificado
 *  - fechar(): void
 */
export function verificarContrato(conector) {
  const faltando = ['id', 'capacidades', 'listarNotas', 'testar', 'fechar'].filter((k) => conector[k] === undefined);
  if (faltando.length) throw new Error(`Conector incompleto: falta ${faltando.join(', ')}`);
  const cap = conector.capacidades();
  for (const op of Object.keys(cap)) {
    if (!OPERACOES.includes(op)) throw new Error(`Operação desconhecida na matriz: ${op}`);
    if (!Object.values(METODO).includes(cap[op])) throw new Error(`Método inválido para ${op}: ${cap[op]}`);
  }
  return true;
}
