import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lerPlanilhaSenhas, senhaPara } from '../src/util/senhas.js';
import { analisarCertificado, cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { criarServidor } from '../src/server/app.js';
import { config } from '../src/config.js';
import { ambienteTeste, gerarPfx, CNPJ_TESTE, limpar } from './ajuda.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('planilha de senhas: arquivo ou CNPJ, separadores, cabeçalho, aspas e BOM', () => {
  const mapa = lerPlanilhaSenhas('\uFEFFarquivo;senha\r\nEmpresa A.pfx;abc;123\r\n"Empresa; B";"x""y"\r\n11.222.333/0001-81\tsenha-cnpj\r\nc,123\r\n\r\n');
  assert.equal(senhaPara(mapa, 'C:\\certs\\empresa a.PFX'), 'abc', 'sem diferenciar maiúsculas e com caminho');
  assert.equal(senhaPara(mapa, 'Empresa; B.p12'), 'x"y');
  assert.equal(senhaPara(mapa, 'c.pfx'), '123');
  assert.equal(senhaPara(mapa, 'qualquer.pfx', '11222333000181'), 'senha-cnpj', 'pelo CNPJ já conhecido');
  assert.equal(senhaPara(mapa, 'Cert 11222333000181.pfx'), 'senha-cnpj', 'CNPJ no nome do arquivo');
  assert.equal(senhaPara(mapa, 'nao-existe.pfx'), undefined);
  assert.equal(mapa.has('arquivo'), false, 'cabeçalho ignorado');
});

test('análise de certificado: nova, mesmo, renovação e mais antigo; renovação mantém a razão social', () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const atual = gerarPfx({ diasValidade: 200 });
    assert.equal(analisarCertificado(repo, { pfx: atual, senha: '1234' }).situacao, 'nova');
    assert.equal(repo.listarEmpresas().length, 0, 'analisar não grava');

    const { id } = cadastrarEmpresa(repo, { pfx: atual, senha: '1234', razaoSocial: 'NOME QUE EU ESCOLHI' });
    assert.equal(analisarCertificado(repo, { pfx: atual, senha: '1234' }).situacao, 'mesmo');
    assert.equal(analisarCertificado(repo, { pfx: gerarPfx({ diasValidade: 30 }), senha: '1234' }).situacao, 'mais_antigo');

    const novo = gerarPfx({ diasValidade: 600 });
    const a = analisarCertificado(repo, { pfx: novo, senha: '1234' });
    assert.equal(a.situacao, 'renovacao');
    assert.equal(a.empresaId, id);
    const r = cadastrarEmpresa(repo, { pfx: novo, senha: '1234' });
    assert.equal(r.id, id);
    assert.equal(r.renovacao, true);
    assert.equal(repo.obterEmpresa(id).razao_social, 'NOME QUE EU ESCOLHI');
    assert.equal(repo.obterEmpresa(id).cert_valido_ate.slice(0, 10), a.validoAte.slice(0, 10));
    assert.throws(() => analisarCertificado(repo, { pfx: novo, senha: 'errada' }), /Senha/);
  } finally {
    limpar(dataDir);
  }
});

test('API: /api/certificados/analisar e módulo compartilhado de senhas servido ao navegador', async () => {
  const { repo, dataDir } = ambienteTeste();
  const srv = criarServidor(repo, { dataDir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const post = (corpo) => fetch(base + '/api/certificados/analisar', {
      method: 'POST', headers: { 'X-Buscador': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    });
    const ok = await post({ pfxBase64: gerarPfx().toString('base64'), senha: '1234' });
    assert.equal(ok.status, 200);
    const dados = await ok.json();
    assert.equal(dados.cnpj, CNPJ_TESTE);
    assert.equal(dados.situacao, 'nova');
    assert.equal(repo.listarEmpresas().length, 0);
    const erro = await post({ pfxBase64: gerarPfx().toString('base64'), senha: 'x' });
    assert.equal(erro.status, 400);

    const mod = await fetch(base + '/compartilhado/senhas.js');
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get('content-type'), /javascript/);
    assert.match(await mod.text(), /export function lerPlanilhaSenhas/);
    assert.equal((await fetch(base + '/compartilhado/../config.js')).status, 404);
  } finally {
    srv.close();
    limpar(dataDir);
  }
});

test('CLI: importar-certificados com pasta, planilha de senhas e --simular', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-lote-'));
  try {
    fs.mkdirSync(path.join(pasta, 'certs', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(pasta, 'certs', 'empresa-a.pfx'), gerarPfx({ senha: 'aaa' }));
    fs.writeFileSync(path.join(pasta, 'certs', 'sub', 'empresa-b.p12'), gerarPfx({ cnpj: '04252011000110', senha: 'bbb' }));
    fs.writeFileSync(path.join(pasta, 'certs', 'sem-senha.pfx'), gerarPfx({ cnpj: '19131243000197', senha: 'zzz' }));
    fs.writeFileSync(path.join(pasta, 'certs', 'leia-me.txt'), 'ignorar');
    fs.writeFileSync(path.join(pasta, 'senhas.csv'), 'arquivo;senha\nempresa-a;aaa\n04.252.011/0001-10;bbb\nempresa-b.p12;bbb\n');
    const env = {
      ...process.env,
      NFSE_MASTER_KEY: config.masterKey,
      NFSE_DATA_DIR: path.join(pasta, 'data'),
      NFSE_DB_PATH: path.join(pasta, 'data', 'nfse.db'),
      DOTENV_CONFIG_PATH: path.join(pasta, '.env-inexistente'),
    };
    const rodar = (...args) => {
      try {
        return { saida: execFileSync('node', ['src/cli/index.js', ...args], { cwd: RAIZ, env, encoding: 'utf8' }), codigo: 0 };
      } catch (e) {
        return { saida: e.stdout + e.stderr, codigo: e.status };
      }
    };
    const sim = rodar('importar-certificados', path.join(pasta, 'certs'), '--senhas', path.join(pasta, 'senhas.csv'), '--simular');
    assert.match(sim.saida, /2 nova\(s\), 0 renovação\(ões\), 0 ignorada\(s\), 1 com erro\. Nada foi gravado/);
    assert.equal(sim.codigo, 1, 'código 1 quando algum certificado falha');
    assert.match(rodar('empresas').saida, /Nenhuma empresa/);

    const real = rodar('importar-certificados', path.join(pasta, 'certs'), '--senhas', path.join(pasta, 'senhas.csv'), '--senha', 'zzz');
    assert.match(real.saida, /3 nova\(s\), 0 renovação\(ões\), 0 ignorada\(s\), 0 com erro/);
    assert.equal(real.codigo, 0);
    const de_novo = rodar('importar-certificados', path.join(pasta, 'certs'), '--senhas', path.join(pasta, 'senhas.csv'), '--senha', 'zzz');
    assert.match(de_novo.saida, /0 nova\(s\), 0 renovação\(ões\), 3 ignorada\(s\)/);
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});
