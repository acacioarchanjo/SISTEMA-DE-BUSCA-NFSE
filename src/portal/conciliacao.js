// Conciliação via Portal Emissor Nacional (EXPERIMENTAL).
// O ADN é a fonte principal. Este módulo entra no portal com o certificado A1,
// lista as chaves de notas emitidas/recebidas de um período e baixa as que
// não vieram pelo ADN. O portal é HTML (não é API oficial) e pode mudar sem aviso.
import * as cheerio from 'cheerio';
import { config, debug } from '../config.js';
import { requisicao, ClienteAdn } from '../adn/cliente.js';
import { abrirCredenciais } from '../crypto/credenciais.js';
import { registrarNfse } from '../adn/distribuicao.js';
import { esperar } from '../util/formatos.js';
import { classificarErro, statusLegado } from '../execucao/catalogo.js';
import { registrarAuditoria } from '../auditoria.js';
import { validarDocumentos } from '../fiscal/validacao.js';

const RX_CHAVE = /\b\d{50}\b/g;

/** Extrai chaves de acesso (50 dígitos) de uma página HTML da listagem. */
export function extrairChaves(html) {
  const $ = cheerio.load(html);
  const chaves = new Set();
  $('[href], [data-chave], [data-id], [onclick]').each((_, el) => {
    for (const attr of ['href', 'data-chave', 'data-id', 'onclick']) {
      for (const m of String($(el).attr(attr) ?? '').matchAll(RX_CHAVE)) chaves.add(m[0]);
    }
  });
  for (const m of $('body').text().matchAll(RX_CHAVE)) chaves.add(m[0]);
  return [...chaves];
}

const fmt = (iso) => {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
};

class SessaoPortal {
  constructor({ cert, key }) {
    this.cert = cert;
    this.key = key;
    this.cookies = new Map();
    this.host = config.portal.host;
    this.base = config.portal.basePath;
  }

  #guardarCookies(headers) {
    for (const c of [].concat(headers['set-cookie'] ?? [])) {
      const [par] = c.split(';');
      const i = par.indexOf('=');
      if (i > 0) this.cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
  }

  async get(caminho, { seguirRedirecionamentos = 5 } = {}) {
    let path = caminho;
    for (let i = 0; i <= seguirRedirecionamentos; i++) {
      const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const r = await requisicao({
        host: this.host,
        path,
        cert: this.cert,
        key: this.key,
        headers: { Accept: 'text/html,application/xml,*/*', ...(cookie ? { Cookie: cookie } : {}) },
      });
      this.#guardarCookies(r.headers);
      debug('portal', r.status, path);
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        const u = new URL(r.headers.location, `https://${this.host}${path}`);
        if (u.host !== this.host) throw new Error(`Redirecionamento inesperado para ${u.host}`);
        path = u.pathname + u.search;
        continue;
      }
      return { ...r, path };
    }
    throw new Error('Redirecionamentos demais no portal.');
  }

  async entrar() {
    const r = await this.get(`${this.base}/Certificado`);
    if (r.status >= 400 || /\/Login/i.test(r.path)) {
      throw new Error(`Não foi possível autenticar no portal com o certificado (HTTP ${r.status}).`);
    }
  }

  /** Percorre as páginas da listagem e devolve as chaves encontradas. */
  async listarChaves(tipo, de, ate, maxPaginas = 50) {
    const todas = new Set();
    for (let pg = 1; pg <= maxPaginas; pg++) {
      const qs = new URLSearchParams({ executar: '1', busca: '', datainicio: fmt(de), datafim: fmt(ate), pg: String(pg) });
      const r = await this.get(`${this.base}/Notas/${tipo}?${qs}`);
      if (r.status >= 400) throw new Error(`Falha ao listar notas ${tipo} (HTTP ${r.status}).`);
      const chaves = extrairChaves(r.corpo.toString('utf8'));
      const antes = todas.size;
      chaves.forEach((c) => todas.add(c));
      if (todas.size === antes) break; // página sem novidade = fim
      await esperar(800);
    }
    return [...todas];
  }

  async baixarXml(chave) {
    const r = await this.get(`${this.base}/Notas/Download/NFSe/${chave}`);
    const txt = r.corpo.toString('utf8');
    return r.status === 200 && txt.includes('infNFSe') ? txt : null;
  }
}

/**
 * Concilia um período: compara chaves do portal x banco e baixa as que faltam.
 * @param {{de:string, ate:string}} periodo datas ISO (AAAA-MM-DD)
 */
export async function conciliarEmpresa(repo, empresaId, { de, ate }, opcoes = {}) {
  const empresa = repo.obterEmpresa(empresaId);
  if (!empresa) throw new Error(`Empresa ${empresaId} não encontrada.`);
  const execId = repo.iniciarExecucao(empresaId, 'conciliacao');
  let clienteSefin;
  try {
    const cred = abrirCredenciais(repo, empresaId);
    const sessao = opcoes.sessao ?? new SessaoPortal(cred);
    await sessao.entrar();

    const noPortal = new Set([
      ...(await sessao.listarChaves('Emitidas', de, ate)),
      ...(await sessao.listarChaves('Recebidas', de, ate)),
    ]);
    const noBanco = repo.chavesDaEmpresa(empresaId);
    const faltantes = [...noPortal].filter((c) => !noBanco.has(c));

    let baixadas = 0;
    const falhas = [];
    for (const chave of faltantes) {
      try {
        let xml = await sessao.baixarXml(chave);
        if (!xml) {
          clienteSefin ??= opcoes.clienteSefin ?? new ClienteAdn(cred);
          xml = await clienteSefin.consultarNfse(chave);
        }
        if (!xml) throw new Error('XML indisponível');
        registrarNfse(repo, empresa, { xml, origem: 'conciliacao' });
        baixadas++;
      } catch (e) {
        falhas.push(`${chave}: ${e.message}`);
      }
      await esperar(opcoes.intervaloMs ?? 800);
    }

    const msg = `Portal: ${noPortal.size} nota(s) no período; ${faltantes.length} faltando no banco; ${baixadas} baixada(s).` +
      (falhas.length ? ` Falhas: ${falhas.slice(0, 5).join(' | ')}` : '');
    if (baixadas) validarDocumentos(repo, { empresaId });
    const codigo = falhas.length ? 'SUCESSO_PARCIAL' : baixadas ? 'SUCESSO' : 'SEM_MOVIMENTO';
    repo.atualizarExecucao(execId, { status: statusLegado(codigo), codigo, novos: baixadas, mensagem: msg, finalizar: true, detalhes: { periodo: { de, ate }, faltantes, falhas } });
    registrarAuditoria(repo.db, {
      tipo: 'execucao.finalizada', empresaCnpj: empresa.cnpj, execucaoId: execId,
      payload: { execucao_id: execId, rotina: 'conciliacao', conector: 'portal-emissor-nacional@experimental', metodo: 'WEB', empresa: { cnpj: empresa.cnpj, razao_social: empresa.razao_social }, status: codigo, periodo: { de, ate }, no_portal: noPortal.size, faltantes: faltantes.length, baixadas, falhas },
    });
    return { noPortal: noPortal.size, faltantes, baixadas, falhas, mensagem: msg, codigo };
  } catch (e) {
    const { codigo, subcodigo } = classificarErro(e);
    repo.atualizarExecucao(execId, { status: statusLegado(codigo), codigo, subcodigo, mensagem: e.message, finalizar: true });
    try {
      registrarAuditoria(repo.db, {
        tipo: 'execucao.finalizada', empresaCnpj: empresa.cnpj, execucaoId: execId,
        payload: { execucao_id: execId, rotina: 'conciliacao', empresa: { cnpj: empresa.cnpj }, status: codigo, subcodigo, mensagem: e.message, periodo: { de, ate } },
      });
    } catch { /* não esconder o erro original */ }
    throw e;
  } finally {
    clienteSefin?.fechar?.();
  }
}

/** Período do mês anterior (usado pelo agendador mensal). */
export function mesAnterior(hoje = new Date()) {
  const ini = new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth() - 1, 1));
  const fim = new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth(), 0));
  return { de: ini.toISOString().slice(0, 10), ate: fim.toISOString().slice(0, 10) };
}
