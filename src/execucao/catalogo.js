// Catálogo de status de execução (docs/arquitetura-rpa-iss-nfse.md, seção 11).
// Toda execução termina num destes códigos — nunca em "erro genérico".
import { ErroAdn } from '../adn/cliente.js';
import { ErroCertificado } from '../crypto/certificado.js';
import { ErroCofre } from '../crypto/cofre.js';

export const CATALOGO = {
  SUCESSO: {
    rotulo: 'Sucesso', tipo: 'ok', retentavel: false, exigeAcao: false,
    descricao: 'Rotina completa, sem documentos com erro.',
  },
  SUCESSO_PARCIAL: {
    rotulo: 'Sucesso parcial', tipo: 'alerta', retentavel: true, exigeAcao: false,
    descricao: 'Parte dos documentos não pôde ser processada (ex.: XML ilegível).',
    acao: 'Veja os itens com erro nos detalhes. Se persistir em 3 buscas seguidas, avise o suporte.',
  },
  SEM_MOVIMENTO: {
    rotulo: 'Sem movimento', tipo: 'neutro', retentavel: false, exigeAcao: false,
    descricao: 'Nenhum documento novo desde a última busca.',
  },
  ERRO_AUTENTICACAO: {
    rotulo: 'Erro de autenticação', tipo: 'erro', retentavel: false, exigeAcao: true,
    descricao: 'O governo recusou o acesso. O robô não repete o login para não bloquear o certificado.',
    acao: 'Confira o certificado da empresa (validade, senha, se é o e-CNPJ certo) e importe o novo se necessário.',
  },
  PORTAL_INDISPONIVEL: {
    rotulo: 'Portal indisponível', tipo: 'alerta', retentavel: true, exigeAcao: false,
    descricao: 'Servidor do governo fora do ar, lento ou sem conexão com a internet.',
    acao: 'Tente de novo mais tarde. A busca automática retoma do ponto onde parou.',
  },
  LIMITE_CONSUMO: {
    rotulo: 'Limite de consultas', tipo: 'alerta', retentavel: true, exigeAcao: false,
    descricao: 'O governo sinalizou excesso de consultas (consumo indevido). A empresa fica pausada por um tempo.',
    acao: 'Aguarde o fim da pausa. Evite buscar a mesma empresa várias vezes seguidas.',
  },
  EXIGE_ACAO_USUARIO: {
    rotulo: 'Exige ação', tipo: 'erro', retentavel: false, exigeAcao: true,
    descricao: 'O robô precisa de uma decisão ou ação de uma pessoa para continuar.',
  },
  DADO_INCONSISTENTE: {
    rotulo: 'Dado inconsistente', tipo: 'erro', retentavel: true, exigeAcao: true,
    descricao: 'O governo devolveu uma resposta inesperada ou rejeitou a consulta.',
    acao: 'Veja a mensagem. Se repetir, pode ser mudança no serviço do governo: avise o suporte.',
  },
  ERRO_CONFIGURACAO: {
    rotulo: 'Erro de configuração', tipo: 'erro', retentavel: false, exigeAcao: true,
    descricao: 'Problema na configuração do sistema (chave mestra, endereço, cadastro).',
    acao: 'Confira o arquivo .env e o cadastro da empresa.',
  },
  ERRO_INTERNO: {
    rotulo: 'Erro interno', tipo: 'erro', retentavel: true, exigeAcao: true,
    descricao: 'Falha inesperada do robô.',
    acao: 'Tente de novo. Se repetir, envie a mensagem e o arquivo data\\logs\\servidor.log ao suporte.',
  },
  CANCELADO: {
    rotulo: 'Interrompida', tipo: 'neutro', retentavel: true, exigeAcao: false,
    descricao: 'A execução foi interrompida (sistema encerrado no meio).',
    acao: 'Rode a busca de novo: ela continua de onde parou.',
  },
  EM_EXECUCAO: { rotulo: 'Executando', tipo: 'executando', retentavel: false, exigeAcao: false, descricao: 'Em andamento.' },
};

export const SUBCODIGOS = {
  CERT_VENCIDO: 'Certificado vencido',
  CERT_SENHA: 'Senha do certificado incorreta',
  CERT_INVALIDO: 'Certificado ilegível ou inválido',
  ACESSO_NEGADO: 'Acesso negado pelo servidor (certificado de outro CNPJ, revogado ou sem procuração)',
  SEM_CONEXAO: 'Sem conexão com o servidor (internet ou DNS)',
  TIMEOUT: 'Tempo esgotado',
  SERVIDOR_FORA: 'Servidor do governo com erro (5xx)',
  CONSUMO_INDEVIDO: 'Consumo indevido informado pelo governo',
  PAUSA_ATIVA: 'Empresa em pausa por consumo indevido',
  BUSCA_EM_ANDAMENTO: 'Já existe uma busca em andamento',
  REJEICAO_ADN: 'Consulta rejeitada pelo ADN',
  CHAVE_MESTRA: 'NFSE_MASTER_KEY ausente ou incorreta',
  CERT_TLS: 'Erro de TLS/certificado do servidor',
  INTERROMPIDA: 'Processo encerrado durante a execução',
};

/**
 * Classifica uma exceção num código do catálogo.
 * @returns {{codigo:string, subcodigo:string|null}}
 */
export function classificarErro(e) {
  const msg = String(e?.message ?? e);
  if (e?.name === 'ErroTrava' || e?.constructor?.name === 'ErroTrava') {
    return /andamento/i.test(msg)
      ? { codigo: 'EXIGE_ACAO_USUARIO', subcodigo: 'BUSCA_EM_ANDAMENTO' }
      : { codigo: 'LIMITE_CONSUMO', subcodigo: 'PAUSA_ATIVA' };
  }
  if (e instanceof ErroCertificado) {
    if (/vencido/i.test(msg)) return { codigo: 'ERRO_AUTENTICACAO', subcodigo: 'CERT_VENCIDO' };
    if (/senha/i.test(msg)) return { codigo: 'ERRO_AUTENTICACAO', subcodigo: 'CERT_SENHA' };
    return { codigo: 'ERRO_AUTENTICACAO', subcodigo: 'CERT_INVALIDO' };
  }
  if (e instanceof ErroCofre) return { codigo: 'ERRO_CONFIGURACAO', subcodigo: 'CHAVE_MESTRA' };
  if (e instanceof ErroAdn) {
    if (e.consumoIndevido) return { codigo: 'LIMITE_CONSUMO', subcodigo: 'CONSUMO_INDEVIDO' };
    if (e.status === 401 || e.status === 403) return { codigo: 'ERRO_AUTENTICACAO', subcodigo: 'ACESSO_NEGADO' };
    if (e.status >= 500) return { codigo: 'PORTAL_INDISPONIVEL', subcodigo: 'SERVIDOR_FORA' };
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|ECONNRESET|EHOSTUNREACH/i.test(msg)) return { codigo: 'PORTAL_INDISPONIVEL', subcodigo: 'SEM_CONEXAO' };
    if (/tempo esgotado|timeout|ETIMEDOUT/i.test(msg)) return { codigo: 'PORTAL_INDISPONIVEL', subcodigo: 'TIMEOUT' };
    if (/CERT|SSL|EPROTO|self.signed/i.test(msg)) return { codigo: 'ERRO_CONFIGURACAO', subcodigo: 'CERT_TLS' };
    if (/rejeitou/i.test(msg)) return { codigo: 'DADO_INCONSISTENTE', subcodigo: 'REJEICAO_ADN' };
    if (e.temporario) return { codigo: 'PORTAL_INDISPONIVEL', subcodigo: null };
    return { codigo: 'DADO_INCONSISTENTE', subcodigo: null };
  }
  return { codigo: 'ERRO_INTERNO', subcodigo: null };
}

/** Classifica uma execução concluída sem exceção. */
export function classificarSucesso({ novos = 0, eventos = 0, erros = [] }) {
  if (erros.length) return { codigo: 'SUCESSO_PARCIAL', subcodigo: null };
  if (!novos && !eventos) return { codigo: 'SEM_MOVIMENTO', subcodigo: null };
  return { codigo: 'SUCESSO', subcodigo: null };
}

/** Status legado (coluna `status`) a partir do código do catálogo. */
export function statusLegado(codigo) {
  if (codigo === 'EM_EXECUCAO') return 'executando';
  if (codigo === 'LIMITE_CONSUMO') return 'travada';
  if (['SUCESSO', 'SUCESSO_PARCIAL', 'SEM_MOVIMENTO'].includes(codigo)) return 'ok';
  return 'erro';
}
