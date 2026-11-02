import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import { gerarBackup } from '../src/backup.js';
import { abrirBanco } from '../src/db/index.js';
import { Repositorio } from '../src/db/repositorio.js';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { registrarNfse } from '../src/adn/distribuicao.js';
import { config } from '../src/config.js';
import { ambienteTeste, gerarPfx, fixture, CHAVE_TESTE, CNPJ_TESTE, limpar } from './ajuda.js';

test('backup: ZIP com banco consistente, XMLs, .env e rotação', async () => {
  const { dataDir } = ambienteTeste();
  const dbPath = path.join(dataDir, 'nfse-robo.db');
  const db = abrirBanco(dbPath);
  const repo = new Repositorio(db);
  const destino = path.join(dataDir, 'backups');
  const arquivoEnv = path.join(dataDir, '.env');
  fs.writeFileSync(arquivoEnv, `NFSE_MASTER_KEY=${config.masterKey}\n`);
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    registrarNfse(repo, repo.obterEmpresa(id), { xml: fixture('nfse-exemplo.xml'), nsu: 1 }, dataDir);

    const r = await gerarBackup({ destino, db, dataDir, dbPath, arquivoEnv, manter: 2 });
    assert.ok(r.incluiuEnv);
    const zip = await JSZip.loadAsync(fs.readFileSync(r.arquivo));
    assert.ok(zip.file(`data/xml/${CNPJ_TESTE}/2026-03/${CHAVE_TESTE}.xml`));
    assert.match(await zip.file('.env').async('string'), /NFSE_MASTER_KEY=/);
    assert.ok(zip.file('LEIA-ME.txt'));

    // o banco do backup abre e tem os dados (banco aberto durante o backup, em WAL)
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-rest-')), 'r.db');
    fs.writeFileSync(tmp, await zip.file('data/nfse-robo.db').async('nodebuffer'));
    const restaurado = new Database(tmp, { readonly: true });
    assert.equal(restaurado.prepare('SELECT COUNT(*) n FROM documentos').get().n, 1);
    assert.equal(restaurado.prepare('SELECT cnpj FROM empresas').get().cnpj, CNPJ_TESTE);
    restaurado.close();

    // sem .env
    const r2 = await gerarBackup({ destino, db, dataDir, dbPath, arquivoEnv, incluirEnv: false, manter: 2 });
    assert.equal((await JSZip.loadAsync(fs.readFileSync(r2.arquivo))).file('.env'), null);

    // rotação: mantém só 2
    await new Promise((res) => setTimeout(res, 1100));
    const r3 = await gerarBackup({ destino, db, dataDir, dbPath, arquivoEnv, manter: 2 });
    const restantes = fs.readdirSync(destino).filter((f) => f.endsWith('.zip'));
    assert.equal(restantes.length, 2);
    assert.ok(restantes.includes(path.basename(r3.arquivo)));
    assert.ok(!fs.readdirSync(destino).some((f) => f.endsWith('.parcial')));
  } finally {
    db.close();
    limpar(dataDir);
  }
});
