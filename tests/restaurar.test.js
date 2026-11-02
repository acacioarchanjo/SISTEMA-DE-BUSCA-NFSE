import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { gerarBackup } from '../src/backup.js';
import { restaurarBackup, analisarBackup, listarBackups, ErroRestauracao } from '../src/restaurar.js';
import { abrirBanco } from '../src/db/index.js';
import { Repositorio } from '../src/db/repositorio.js';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { registrarNfse } from '../src/adn/distribuicao.js';
import { config } from '../src/config.js';
import { ambienteTeste, gerarPfx, fixture, xmlRecebida, CNPJ_TESTE, limpar } from './ajuda.js';

async function cenario() {
  const { dataDir: raiz } = ambienteTeste();
  const dataDir = path.join(raiz, 'data');
  const dbPath = path.join(dataDir, 'nfse-robo.db');
  const arquivoEnv = path.join(raiz, '.env');
  fs.writeFileSync(arquivoEnv, `NFSE_MASTER_KEY=${config.masterKey}\n`);
  const db = abrirBanco(dbPath);
  const repo = new Repositorio(db);
  const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
  registrarNfse(repo, repo.obterEmpresa(id), { xml: fixture('nfse-exemplo.xml'), nsu: 1 }, dataDir);
  const bk = await gerarBackup({ destino: path.join(raiz, 'backups'), db, dataDir, dbPath, arquivoEnv });
  // depois do backup, os dados mudam (nota nova) e a chave muda
  registrarNfse(repo, repo.obterEmpresa(id), { xml: xmlRecebida(), nsu: 2 }, dataDir);
  db.close();
  const chaveOriginal = config.masterKey;
  fs.writeFileSync(arquivoEnv, `NFSE_MASTER_KEY=${crypto.randomBytes(32).toString('base64')}\n`);
  return { raiz, dataDir, dbPath, arquivoEnv, bk, chaveOriginal, opcoes: { dataDir, dbPath, arquivoEnv, verificarPainel: false } };
}

test('restaurar: volta os dados e o .env, preservando o estado anterior', async () => {
  const c = await cenario();
  try {
    assert.equal(listarBackups(path.join(c.raiz, 'backups')).length, 1);
    const r = await restaurarBackup(c.bk.arquivo, c.opcoes);
    assert.equal(r.empresas, 1);
    assert.equal(r.documentos, 1, 'nota criada depois do backup não existe mais');
    assert.deepEqual(r.certificadosSemChave, []);
    assert.match(fs.readFileSync(c.arquivoEnv, 'utf8'), new RegExp(c.chaveOriginal.replace(/[+/=]/g, '\\$&')));
    assert.ok(fs.existsSync(r.dataAnterior) && fs.existsSync(path.join(r.dataAnterior, 'nfse-robo.db')), 'dados anteriores preservados');
    assert.ok(fs.existsSync(r.envAnterior));
    const xmls = fs.readdirSync(path.join(c.dataDir, 'xml', CNPJ_TESTE, '2026-03'));
    assert.equal(xmls.length, 1);

    const repo = new Repositorio(abrirBanco(c.dbPath));
    assert.equal(repo.listarEmpresas()[0].cnpj, CNPJ_TESTE);
    repo.db.close();
  } finally {
    limpar(c.raiz);
  }
});

test('restaurar: backup sem .env avisa quando a chave atual não abre os certificados', async () => {
  const c = await cenario();
  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(c.bk.arquivo));
    zip.remove('.env');
    const semEnv = path.join(c.raiz, 'sem-env.zip');
    fs.writeFileSync(semEnv, await zip.generateAsync({ type: 'nodebuffer' }));
    config.masterKey = crypto.randomBytes(32).toString('base64'); // chave "atual" diferente
    const r = await restaurarBackup(semEnv, c.opcoes);
    assert.equal(r.envRestaurado, false);
    assert.deepEqual(r.certificadosSemChave, ['EMPRESA TESTE LTDA']);
  } finally {
    limpar(c.raiz);
  }
});

test('restaurar: ZIP inválido ou malicioso não altera nada', async () => {
  const c = await cenario();
  try {
    const qualquer = path.join(c.raiz, 'qualquer.zip');
    const z = new JSZip();
    z.file('foto.jpg', 'x');
    fs.writeFileSync(qualquer, await z.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(analisarBackup(qualquer), ErroRestauracao);

    // caminho com ".." é neutralizado (JSZip + checagem própria): nada é escrito fora da pasta
    const malicioso = path.join(c.raiz, 'malicioso.zip');
    const m = new JSZip();
    m.file('data/nfse-robo.db', fs.readFileSync(c.dbPath));
    m.file('data/../../fora.txt', 'invasão');
    fs.writeFileSync(malicioso, await m.generateAsync({ type: 'nodebuffer' }));
    await restaurarBackup(malicioso, c.opcoes);
    assert.ok(!fs.existsSync(path.join(c.raiz, 'fora.txt')));
    assert.ok(!fs.existsSync(path.join(path.dirname(c.raiz), 'fora.txt')));

    // banco corrompido: falha na conferência e DESFAZ, devolvendo os dados atuais
    const corrompido = path.join(c.raiz, 'corrompido.zip');
    const k = new JSZip();
    k.file('data/nfse-robo.db', 'isto não é um banco sqlite'.repeat(50));
    fs.writeFileSync(corrompido, await k.generateAsync({ type: 'nodebuffer' }));
    const dataAntes = fs.readdirSync(c.raiz).filter((f) => f.startsWith('data')).sort();
    const dbAntes = fs.readFileSync(c.dbPath);
    await assert.rejects(restaurarBackup(corrompido, c.opcoes));
    assert.deepEqual(fs.readFileSync(c.dbPath), dbAntes, 'banco atual devolvido');
    assert.deepEqual(fs.readdirSync(c.raiz).filter((f) => f.startsWith('data')).sort(), dataAntes, 'sem sobras após desfazer');
  } finally {
    limpar(c.raiz);
  }
});
