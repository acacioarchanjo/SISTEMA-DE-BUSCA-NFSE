// Backup dos dados locais em um único ZIP:
//   data/<nome>.db    cópia consistente do SQLite (API de backup, funciona com o painel aberto)
//   data/xml/...      XMLs das notas e eventos
//   data/logs/...     logs da busca diária
//   .env              configuração com a NFSE_MASTER_KEY (opcional)
//   LEIA-ME.txt       como restaurar
// A estrutura espelha a pasta do projeto: restaurar = extrair o ZIP na pasta do projeto.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { config } from './config.js';

const PREFIXO = 'backup-nfse-';

function carimbo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Adiciona uma pasta inteira ao ZIP como streams (não carrega tudo na memória de uma vez). */
function adicionarPasta(zip, origem, prefixoZip) {
  if (!fs.existsSync(origem)) return 0;
  let n = 0;
  for (const rel of fs.readdirSync(origem, { recursive: true })) {
    const abs = path.join(origem, String(rel));
    if (!fs.statSync(abs).isFile()) continue;
    zip.file(`${prefixoZip}/${String(rel).split(path.sep).join('/')}`, fs.createReadStream(abs));
    n++;
  }
  return n;
}

const LEIA_ME = (incluiuEnv) => `BACKUP DO BUSCADOR NFS-e
Gerado em: ${new Date().toLocaleString('pt-BR')}

CONTEÚDO
  data\\*.db      banco de dados SQLite (empresas, certificados CIFRADOS, notas, cursor NSU)
  data\\xml\\      XMLs das notas e eventos
  data\\logs\\     logs da busca diária
  ${incluiuEnv ? '.env           configuração, incluindo a NFSE_MASTER_KEY' : '(.env NÃO incluído: guarde a NFSE_MASTER_KEY separadamente)'}

COMO RESTAURAR
  1. Feche o sistema (janela do iniciar.bat) e desligue a busca agendada, se houver.
  2. Na pasta do projeto, renomeie a pasta "data" atual (ex.: data-antiga).
  3. Extraia TODO o conteúdo deste ZIP direto na pasta do projeto
     (vai recriar a pasta "data" e o arquivo ".env").
  4. Abra o iniciar.bat. Se der certo, pode apagar a "data-antiga".
  Importante: a NFSE_MASTER_KEY do .env precisa ser a MESMA da época do backup.

SEGURANÇA (LGPD)
  ${incluiuEnv ? 'Este ZIP contém a chave que decifra os certificados A1. Guarde-o em local protegido.' : 'Sem a NFSE_MASTER_KEY original os certificados não podem ser decifrados.'}
`;

/**
 * Gera o backup.
 * @param {{destino?:string, incluirEnv?:boolean, manter?:number, db?:import('better-sqlite3').Database, arquivoEnv?:string}} opcoes
 */
export async function gerarBackup(opcoes = {}) {
  const {
    destino = path.join(path.dirname(config.dataDir), 'backups'),
    incluirEnv = true,
    manter = 10,
    arquivoEnv = process.env.DOTENV_CONFIG_PATH ?? path.resolve('.env'),
    dataDir = config.dataDir,
    dbPath = config.dbPath,
  } = opcoes;

  fs.mkdirSync(destino, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-backup-'));
  try {
    const zip = new JSZip();
    let arquivos = 0;

    // 1) Banco: cópia consistente via API de backup do SQLite
    if (opcoes.db || fs.existsSync(dbPath)) {
      const copia = path.join(temp, path.basename(dbPath));
      let db = opcoes.db;
      let abriuAqui = false;
      if (!db) {
        const { default: Database } = await import('better-sqlite3');
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        abriuAqui = true;
      }
      try {
        await db.backup(copia);
      } finally {
        if (abriuAqui) db.close();
      }
      zip.file(`data/${path.basename(dbPath)}`, fs.createReadStream(copia));
      arquivos++;
    }

    // 2) XMLs e logs
    arquivos += adicionarPasta(zip, path.join(dataDir, 'xml'), 'data/xml');
    arquivos += adicionarPasta(zip, path.join(dataDir, 'logs'), 'data/logs');

    // 3) .env
    const temEnv = incluirEnv && fs.existsSync(arquivoEnv);
    if (temEnv) {
      zip.file('.env', fs.readFileSync(arquivoEnv));
      arquivos++;
    }
    zip.file('LEIA-ME.txt', LEIA_ME(temEnv));

    // 4) Grava o ZIP em streaming; renomeia só no fim (backup incompleto nunca fica com nome final)
    const final = path.join(destino, `${PREFIXO}${carimbo()}.zip`);
    const parcial = final + '.parcial';
    await new Promise((resolve, reject) => {
      zip
        .generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } })
        .on('error', reject)
        .pipe(fs.createWriteStream(parcial))
        .on('finish', resolve)
        .on('error', reject);
    });
    fs.renameSync(parcial, final);

    // 5) Rotação: mantém só os N mais recentes nesta pasta
    const removidos = [];
    if (manter > 0) {
      const antigos = fs
        .readdirSync(destino)
        .filter((f) => f.startsWith(PREFIXO) && f.endsWith('.zip'))
        .sort()
        .reverse()
        .slice(manter);
      for (const f of antigos) {
        fs.rmSync(path.join(destino, f), { force: true });
        removidos.push(f);
      }
    }

    return { arquivo: final, tamanho: fs.statSync(final).size, arquivos, incluiuEnv: temEnv, removidos };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
