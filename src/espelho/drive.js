// Pasta espelho para o Google Drive (ou OneDrive/Dropbox/pasta de rede).
//
// Sem API nem senha do Google: o "Google Drive para computador" monta o Drive como uma pasta do Windows
// (ex.: G:\Meu Drive). O sistema grava as notas organizadas nessa pasta e o próprio Drive sobe para a nuvem.
//
// Estrutura:
//   {pasta}/{CNPJ} - {Empresa}/{AAAA}/{AAAA-MM}/Tomadas/{chave}.xml (+ .pdf)
//                                              /Prestadas/...
//                                              /Canceladas/Tomadas|Prestadas/...
//                                              /planilha-{AAAA-MM}.csv
//                                              /retencoes-{AAAA-MM}.csv   (só se houver retenção nas tomadas)
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { caminhoAbsoluto } from '../nfse/armazenamento.js';
import { nomePasta } from '../exportador/dominio.js';
import { gerarCsv } from '../exportador/planilha.js';
import { gerarDanfse } from '../exportador/danfse.js';
import { consolidarRetencoes, gerarCsvRetencoes } from '../fiscal/retencoes.js';
import { registrarAuditoria } from '../auditoria.js';

const PAPEL = { recebida: 'Tomadas', emitida: 'Prestadas', intermediario: 'Intermediario', outro: 'Outras' };

export class ErroEspelho extends Error {
  name = 'ErroEspelho';
}

// ---------- preferências ----------
const CHAVES = { pasta: 'espelho.pasta', pdf: 'espelho.pdf', automatico: 'espelho.automatico', ultimo: 'espelho.ultimo' };

export function lerPreferencias(db) {
  const v = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes WHERE chave LIKE ?').all('espelho.%').map((r) => [r.chave, r.valor]));
  let ultimo = null;
  try { ultimo = v[CHAVES.ultimo] ? JSON.parse(v[CHAVES.ultimo]) : null; } catch { /* ignora */ }
  return {
    pasta: v[CHAVES.pasta] ?? (process.env.NFSE_PASTA_DRIVE || ''),
    pdf: v[CHAVES.pdf] === '1',
    automatico: v[CHAVES.automatico] !== '0', // padrão: espelha depois de cada busca
    ultimo,
  };
}

function gravar(db, chave, valor) {
  db.prepare(`INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES (?, ?, datetime('now'))
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`).run(chave, valor);
}

/** Valida e grava as preferências. A pasta precisa existir (o Drive tem de estar instalado e conectado). */
export function salvarPreferencias(db, { pasta, pdf, automatico }) {
  if (pasta !== undefined) {
    const p = String(pasta ?? '').trim();
    if (p) verificarPasta(p);
    gravar(db, CHAVES.pasta, p);
  }
  if (pdf !== undefined) gravar(db, CHAVES.pdf, pdf ? '1' : '0');
  if (automatico !== undefined) gravar(db, CHAVES.automatico, automatico ? '1' : '0');
  return lerPreferencias(db);
}

export function verificarPasta(pasta) {
  if (!path.isAbsolute(pasta)) throw new ErroEspelho('Informe o caminho completo da pasta (ex.: G:\\Meu Drive\\NFS-e).');
  let st;
  try {
    st = fs.statSync(pasta);
  } catch {
    throw new ErroEspelho(`Pasta não encontrada: ${pasta}. Confira se o Google Drive para computador está aberto e conectado, e se a pasta existe.`);
  }
  if (!st.isDirectory()) throw new ErroEspelho(`Não é uma pasta: ${pasta}`);
  const dentroDoSistema = path.resolve(pasta).toLowerCase().startsWith(path.resolve(config.dataDir).toLowerCase());
  if (dentroDoSistema) throw new ErroEspelho('Escolha uma pasta fora da pasta de dados do sistema.');
  try {
    const teste = path.join(pasta, `.buscador-teste-${process.pid}`);
    fs.writeFileSync(teste, 'ok');
    fs.rmSync(teste, { force: true });
  } catch (e) {
    throw new ErroEspelho(`Sem permissão para gravar em ${pasta}: ${e.message}`);
  }
}

// ---------- caminhos ----------
/** Caminho relativo (com "/") do XML de uma nota dentro da pasta espelho. */
/** Pasta do mês da nota (relativa): {CNPJ} - {Empresa}/{AAAA}/{AAAA-MM}. */
export function pastaDoMes(d) {
  const mes = d.competencia ? d.competencia.slice(0, 7) : 'sem-competencia';
  return `${d.empresa_cnpj} - ${nomePasta(d.empresa_nome)}/${mes.slice(0, 4)}/${mes}`;
}

export function caminhoNoEspelho(d) {
  const papel = PAPEL[d.papel] ?? PAPEL.outro;
  const ativa = !d.situacao || d.situacao === 'normal';
  return `${pastaDoMes(d)}/${ativa ? papel : `Canceladas/${papel}`}/${nomePasta(d.chave, 90)}.xml`;
}

function dentro(raiz, rel) {
  const abs = path.resolve(raiz, ...rel.split('/'));
  if (!abs.startsWith(path.resolve(raiz) + path.sep)) throw new ErroEspelho('Caminho fora da pasta espelho.');
  return abs;
}

/** Grava via arquivo temporário + rename (o Drive não sobe arquivo pela metade). */
function escrever(abs, conteudo) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, conteudo);
  fs.renameSync(tmp, abs);
}

function mover(de, para) {
  if (!fs.existsSync(de)) return false;
  fs.mkdirSync(path.dirname(para), { recursive: true });
  try {
    fs.renameSync(de, para);
  } catch {
    fs.copyFileSync(de, para);
    fs.rmSync(de, { force: true });
  }
  return true;
}

const iguais = (abs, buf) => {
  try {
    const st = fs.statSync(abs);
    return st.size === buf.length && fs.readFileSync(abs).equals(buf);
  } catch {
    return false;
  }
};

// ---------- sincronização ----------
/**
 * Copia/atualiza as notas na pasta espelho. Incremental: só grava o que mudou;
 * nota cancelada depois de copiada é movida para "Canceladas".
 * @param {import('../db/repositorio.js').Repositorio} repo
 * @param {{ empresaId?:number, pasta?:string, pdf?:boolean, dataDir?:string, origem?:string }} opcoes
 */
export async function sincronizarEspelho(repo, opcoes = {}) {
  const pref = lerPreferencias(repo.db);
  const pasta = opcoes.pasta ?? pref.pasta;
  const pdf = opcoes.pdf ?? pref.pdf;
  const dataDir = opcoes.dataDir ?? config.dataDir;
  if (!pasta) throw new ErroEspelho('Pasta do Google Drive não configurada.');
  verificarPasta(pasta);

  const inicio = Date.now();
  const r = { novos: 0, atualizados: 0, movidos: 0, iguais: 0, pdfs: 0, planilhas: 0, erros: [] };
  const { itens } = repo.listarDocumentos({ empresaId: opcoes.empresaId, limite: 1_000_000 });
  const registro = new Map(repo.db.prepare('SELECT documento_id, caminho, pdf FROM espelho').all().map((x) => [x.documento_id, x]));
  const salvar = repo.db.prepare(`INSERT INTO espelho (documento_id, caminho, pdf, atualizado_em) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(documento_id) DO UPDATE SET caminho = excluded.caminho, pdf = excluded.pdf, atualizado_em = excluded.atualizado_em`);
  const mesesTocados = new Map(); // "empresaId|AAAA-MM" → { empresaId, mes, pastaMes }

  for (const d of itens) {
    if (!d.xml_path) continue;
    try {
      const rel = caminhoNoEspelho(d);
      const abs = dentro(pasta, rel);
      const anterior = registro.get(d.id);
      let mudou = false;

      // nota mudou de lugar (ex.: foi cancelada) → move XML e PDF antigos
      if (anterior && anterior.caminho !== rel) {
        const absAnt = dentro(pasta, anterior.caminho);
        if (mover(absAnt, abs)) r.movidos++;
        mover(absAnt.replace(/\.xml$/, '.pdf'), abs.replace(/\.xml$/, '.pdf'));
        mudou = true;
      }
      const xml = fs.readFileSync(caminhoAbsoluto(d.xml_path, dataDir));
      if (iguais(abs, xml)) {
        if (!mudou) r.iguais++;
      } else {
        const existia = fs.existsSync(abs);
        escrever(abs, xml);
        existia ? r.atualizados++ : r.novos++;
        mudou = true;
      }
      const absPdf = abs.replace(/\.xml$/, '.pdf');
      if (pdf && (mudou || !fs.existsSync(absPdf))) {
        escrever(absPdf, await gerarDanfse(d));
        r.pdfs++;
      }
      if (mudou || !anterior || (pdf && !anterior.pdf)) salvar.run(d.id, rel, pdf ? 1 : 0);
      if (mudou) {
        const mes = d.competencia ? d.competencia.slice(0, 7) : null;
        if (mes) mesesTocados.set(`${d.empresa_id}|${mes}`, { empresaId: d.empresa_id, mes, pastaMes: dentro(pasta, pastaDoMes(d)) });
      }
    } catch (e) {
      r.erros.push(`${d.numero ?? d.chave}: ${e.message}`);
    }
  }

  // planilhas do mês (só dos meses que mudaram)
  for (const { empresaId, mes, pastaMes } of mesesTocados.values()) {
    try {
      const [a, m] = mes.split('-').map(Number);
      const fim = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
      const docs = repo.listarDocumentos({ empresaId, de: `${mes}-01`, ate: fim, limite: 1_000_000 }).itens;
      escrever(path.join(pastaMes, `planilha-${mes}.csv`), Buffer.from(gerarCsv(docs), 'utf8'));
      r.planilhas++;
      const ret = consolidarRetencoes(repo.db, { empresaId, de: mes, ate: mes });
      if (ret.linhas.length) {
        escrever(path.join(pastaMes, `retencoes-${mes}.csv`), Buffer.from(gerarCsvRetencoes(ret), 'utf8'));
        r.planilhas++;
      }
    } catch (e) {
      r.erros.push(`planilha ${mes}: ${e.message}`);
    }
  }

  const resumo = {
    em: new Date().toISOString(), origem: opcoes.origem ?? 'manual', pasta, duracao_ms: Date.now() - inicio,
    novos: r.novos, atualizados: r.atualizados, movidos: r.movidos, iguais: r.iguais, pdfs: r.pdfs, planilhas: r.planilhas,
    erros: r.erros.slice(0, 20), total_erros: r.erros.length,
  };
  gravar(repo.db, CHAVES.ultimo, JSON.stringify(resumo));
  if (r.novos || r.atualizados || r.movidos || r.erros.length) {
    try {
      registrarAuditoria(repo.db, { tipo: 'espelho.sincronizado', payload: { ...resumo, empresa_id: opcoes.empresaId ?? null } });
    } catch { /* auditoria não pode derrubar o espelho */ }
  }
  return resumo;
}

/**
 * Chamado ao fim de cada busca: espelha se estiver configurado e automático. Nunca lança erro
 * (a busca já terminou; uma falha no Drive fica registrada no "último resultado").
 */
export async function espelharDepoisDaBusca(repo, empresaId, { dataDir, origem = 'busca' } = {}) {
  let pref;
  try {
    pref = lerPreferencias(repo.db);
    if (!pref.pasta || !pref.automatico) return null;
    return await sincronizarEspelho(repo, { empresaId, dataDir, origem });
  } catch (e) {
    try {
      gravar(repo.db, CHAVES.ultimo, JSON.stringify({ em: new Date().toISOString(), origem, pasta: pref?.pasta ?? '', erro: e.message, novos: 0, atualizados: 0, movidos: 0, total_erros: 1, erros: [e.message] }));
    } catch { /* sem banco: ignora */ }
    return null;
  }
}
