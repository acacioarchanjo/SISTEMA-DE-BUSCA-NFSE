// Restauração de um backup gerado por src/backup.js.
// Segurança: nada é apagado. A pasta "data" atual e o ".env" atual são
// RENOMEADOS (…-antes-restauracao-<data>) antes de extrair o backup; se algo
// falhar no meio, a situação anterior é devolvida automaticamente.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { decifrar, carregarChave } from './crypto/cofre.js';

export class ErroRestauracao extends Error {}

function carimbo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** true se o painel parece estar rodando (porta local aberta). */
export function painelRodando(host = config.servidor.host, porta = config.servidor.porta) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: porta });
    const fim = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(700, () => fim(false));
    s.on('connect', () => fim(true));
    s.on('error', () => fim(false));
  });
}

const chaveDoEnv = (texto) => texto.match(/^NFSE_MASTER_KEY=(.*)$/m)?.[1]?.trim() ?? '';

/** Lista os backups de uma pasta, do mais novo para o mais antigo. */
export function listarBackups(pasta) {
  if (!fs.existsSync(pasta)) return [];
  return fs
    .readdirSync(pasta)
    .filter((f) => /^backup-nfse-.*\.zip$/i.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const abs = path.join(pasta, f);
      return { arquivo: abs, nome: f, tamanho: fs.statSync(abs).size };
    });
}

/** Lê e valida o ZIP; devolve o plano de restauração (sem alterar nada). */
export async function analisarBackup(arquivoZip) {
  if (!fs.existsSync(arquivoZip)) throw new ErroRestauracao(`Arquivo não encontrado: ${arquivoZip}`);
  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(arquivoZip));
  } catch {
    throw new ErroRestauracao('O arquivo não é um ZIP válido.');
  }
  const entradas = Object.values(zip.files).filter((f) => !f.dir);
  const bancos = entradas.filter((f) => /^data\/[^/]+\.db$/i.test(f.name));
  if (bancos.length !== 1) {
    throw new ErroRestauracao('Este ZIP não parece um backup do Buscador NFS-e (banco "data/*.db" não encontrado).');
  }
  const envZip = zip.file('.env');
  return {
    zip,
    banco: bancos[0],
    dados: entradas.filter((f) => f.name.startsWith('data/') && f !== bancos[0]),
    env: envZip ? await envZip.async('string') : null,
  };
}

/** Escreve dentro de `raiz`, bloqueando caminhos que escapem dela (zip slip). */
function destinoSeguro(raiz, relativo) {
  const abs = path.resolve(raiz, relativo);
  if (abs !== path.resolve(raiz) && !abs.startsWith(path.resolve(raiz) + path.sep)) {
    throw new ErroRestauracao(`Caminho inválido dentro do ZIP: ${relativo}`);
  }
  return abs;
}

/**
 * Restaura o backup.
 * @param {string} arquivoZip
 * @param {{dataDir?:string, dbPath?:string, arquivoEnv?:string, verificarPainel?:boolean}} [opcoes]
 */
export async function restaurarBackup(arquivoZip, opcoes = {}) {
  const {
    dataDir = config.dataDir,
    dbPath = config.dbPath,
    arquivoEnv = process.env.DOTENV_CONFIG_PATH ?? path.resolve('.env'),
    verificarPainel = true,
  } = opcoes;

  if (verificarPainel && (await painelRodando())) {
    throw new ErroRestauracao('O sistema está aberto. Clique em "Encerrar" no painel (ou feche a janela do iniciar.bat) e tente de novo.');
  }

  const plano = await analisarBackup(arquivoZip);
  const sufixo = `antes-restauracao-${carimbo()}`;
  const dataAntiga = `${dataDir}-${sufixo}`;
  const envAntigo = `${arquivoEnv}.${sufixo}`;
  // banco fora da pasta data (configuração personalizada) também é preservado
  const dbFora = !path.resolve(dbPath).startsWith(path.resolve(dataDir) + path.sep);
  const dbAntigo = `${dbPath}.${sufixo}`;
  const movidos = [];
  let extraindo = false; // só vira true depois que o estado atual foi preservado

  const desfazer = () => {
    // Nunca apaga nada se a preservação do estado atual não terminou.
    if (extraindo) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (dbFora) fs.rmSync(dbPath, { force: true });
    }
    for (const [de, para] of movidos.reverse()) fs.renameSync(para, de);
  };

  try {
    // 1) Preserva o estado atual (renomeia, não apaga)
    if (fs.existsSync(dataDir)) {
      try {
        fs.renameSync(dataDir, dataAntiga);
      } catch (e) {
        throw new ErroRestauracao(
          `Não foi possível preservar a pasta de dados atual (${e.code ?? e.message}). ` +
            'Feche o painel, a busca agendada e qualquer programa usando a pasta "data" e tente de novo.',
        );
      }
      movidos.push([dataDir, dataAntiga]);
    }
    if (dbFora && fs.existsSync(dbPath)) { fs.renameSync(dbPath, dbAntigo); movidos.push([dbPath, dbAntigo]); }
    if (plano.env !== null && fs.existsSync(arquivoEnv)) { fs.copyFileSync(arquivoEnv, envAntigo); }

    // 2) Extrai os dados
    if (fs.existsSync(dataDir)) throw new ErroRestauracao(`A pasta ${dataDir} ainda existe (está em uso?).`);
    if (dbFora && fs.existsSync(dbPath)) throw new ErroRestauracao(`O banco ${dbPath} ainda existe (está em uso?).`);
    extraindo = true;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, await plano.banco.async('nodebuffer'));
    for (const f of plano.dados) {
      const abs = destinoSeguro(dataDir, f.name.slice('data/'.length));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, await f.async('nodebuffer'));
    }
    if (!fs.existsSync(path.join(dataDir, '.gitkeep'))) fs.writeFileSync(path.join(dataDir, '.gitkeep'), '');

    // 3) .env do backup (contém a chave que decifra os certificados do backup)
    let chave = config.masterKey;
    if (plano.env !== null) {
      fs.writeFileSync(arquivoEnv, plano.env);
      chave = chaveDoEnv(plano.env) || chave;
    }

    // 4) Confere o banco restaurado e se a chave abre os certificados
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let resumo;
    try {
      const integridade = db.pragma('integrity_check', { simple: true });
      if (integridade !== 'ok') throw new ErroRestauracao(`Banco do backup corrompido: ${integridade}`);
      resumo = db.prepare('SELECT (SELECT COUNT(*) FROM empresas) AS empresas, (SELECT COUNT(*) FROM documentos) AS documentos').get();
      const certs = db.prepare('SELECT razao_social, cert_cifrado FROM empresas').all();
      resumo.certificadosSemChave = [];
      let chaveBuf = null;
      try { chaveBuf = carregarChave(chave); } catch { /* chave ausente/inválida */ }
      for (const c of certs) {
        try {
          if (!chaveBuf) throw new Error();
          decifrar(c.cert_cifrado, chaveBuf);
        } catch {
          resumo.certificadosSemChave.push(c.razao_social);
        }
      }
    } finally {
      db.close();
    }

    return {
      ...resumo,
      envRestaurado: plano.env !== null,
      dataAnterior: movidos.some(([de]) => de === dataDir) ? dataAntiga : null,
      envAnterior: plano.env !== null && fs.existsSync(envAntigo) ? envAntigo : null,
    };
  } catch (e) {
    try {
      desfazer();
      if (plano.env !== null && fs.existsSync(envAntigo)) fs.copyFileSync(envAntigo, arquivoEnv);
    } catch (e2) {
      e.message += ` | ATENÇÃO: não foi possível desfazer automaticamente (${e2.message}). Os dados anteriores estão em ${dataAntiga}`;
    }
    throw e;
  }
}
