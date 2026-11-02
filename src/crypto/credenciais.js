// Cadastro de empresas a partir do .pfx e abertura das credenciais para o cliente mTLS.
import { cifrar, decifrar, decifrarTexto } from './cofre.js';
import { lerCertificado, certificadoVencido, ErroCertificado } from './certificado.js';
import { somenteDigitos, validarCnpj, formatarCnpj } from '../util/formatos.js';

/**
 * Abre e valida o certificado, sem gravar nada.
 * @returns {{info:object, cnpj:string}}
 */
export function validarCertificado({ pfx, senha, cnpj }) {
  if (!pfx?.length) throw new ErroCertificado('Arquivo .pfx não informado.');
  const info = lerCertificado(pfx, senha);

  if (certificadoVencido(info)) {
    throw new ErroCertificado(`Certificado vencido em ${new Date(info.validoAte).toLocaleDateString('pt-BR')}.`);
  }

  let doc = somenteDigitos(cnpj);
  if (doc && info.cnpj && doc !== info.cnpj) {
    // Permite filial do mesmo grupo (mesma raiz) usando certificado da matriz.
    if (doc.slice(0, 8) !== info.cnpj.slice(0, 8)) {
      throw new ErroCertificado(
        `O certificado pertence ao CNPJ ${formatarCnpj(info.cnpj)}, diferente do informado (${formatarCnpj(doc)}).`,
      );
    }
  }
  if (!doc) doc = info.cnpj;
  if (!doc) throw new ErroCertificado('Não foi possível identificar o CNPJ no certificado. Informe o CNPJ manualmente.');
  if (!validarCnpj(doc)) throw new ErroCertificado(`CNPJ inválido: ${doc}`);
  return { info, cnpj: doc };
}

/**
 * Pré-visualiza o cadastro (usado na importação em lote): valida e diz o que aconteceria.
 * situacao: 'nova' | 'renovacao' (certificado mais novo para empresa já cadastrada)
 *           | 'mesmo' (já cadastrado com esta validade) | 'mais_antigo' (o cadastrado vence depois)
 */
export function analisarCertificado(repo, dados) {
  const { info, cnpj } = validarCertificado(dados);
  const existente = repo.obterEmpresaPorCnpj(cnpj);
  let situacao = 'nova';
  if (existente) {
    const atual = new Date(existente.cert_valido_ate ?? 0).getTime();
    const novo = new Date(info.validoAte).getTime();
    situacao = novo > atual ? 'renovacao' : novo === atual ? 'mesmo' : 'mais_antigo';
  }
  return {
    cnpj,
    nome: (dados.razaoSocial || existente?.razao_social || info.nome || formatarCnpj(cnpj)).trim(),
    emissor: info.emissor,
    validoAte: info.validoAte,
    situacao,
    empresaId: existente?.id ?? null,
    validadeAtual: existente?.cert_valido_ate ?? null,
  };
}

/**
 * Valida o certificado e grava a empresa (certificado e senha cifrados).
 * Se o CNPJ já existe, atualiza o certificado (renovação) e mantém a razão social já cadastrada.
 * @param {import('../db/repositorio.js').Repositorio} repo
 * @param {{pfx:Buffer, senha:string, cnpj?:string, razaoSocial?:string}} dados
 */
export function cadastrarEmpresa(repo, { pfx, senha, cnpj, razaoSocial }) {
  const { info, cnpj: doc } = validarCertificado({ pfx, senha, cnpj });
  const existente = repo.obterEmpresaPorCnpj(doc);

  const id = repo.salvarEmpresa({
    cnpj: doc,
    razao_social: (razaoSocial || existente?.razao_social || info.nome || formatarCnpj(doc)).trim(),
    cert_cifrado: cifrar(pfx),
    senha_cifrada: cifrar(senha ?? ''),
    cert_cn: info.cn,
    cert_emissor: info.emissor,
    cert_valido_ate: info.validoAte,
  });
  return {
    id,
    cnpj: doc,
    renovacao: !!existente,
    certificado: { cn: info.cn, emissor: info.emissor, validoAte: info.validoAte },
  };
}

/** Decifra o .pfx da empresa e devolve PEMs prontos para o mTLS. */
export function abrirCredenciais(repo, empresaId) {
  const reg = repo.obterCredenciais(empresaId);
  if (!reg) throw new Error(`Empresa ${empresaId} não encontrada.`);
  const info = lerCertificado(decifrar(reg.cert_cifrado), decifrarTexto(reg.senha_cifrada));
  if (certificadoVencido(info)) {
    throw new ErroCertificado(`Certificado da empresa vencido em ${new Date(info.validoAte).toLocaleDateString('pt-BR')}.`);
  }
  return { cnpj: reg.cnpj, cert: info.certPem, key: info.chavePem };
}
