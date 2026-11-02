import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { salvarXmlNfse } from '../src/nfse/armazenamento.js';
import { sincronizarEspelho, salvarPreferencias, lerPreferencias, espelharDepoisDaBusca, caminhoNoEspelho } from '../src/espelho/drive.js';
import { criarServidor } from '../src/server/app.js';
import { ambienteTeste, gerarPfx, limpar, CNPJ_TESTE } from './ajuda.js';

const drive = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
const listar = (raiz) => {
  const out = [];
  const andar = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? andar(p) : out.push(path.relative(raiz, p).split(path.sep).join('/')); } };
  andar(raiz);
  return out.sort();
};

function nota(repo, dataDir, empresaId, o) {
  const competencia = o.competencia ?? '2026-09-10';
  const xml_path = salvarXmlNfse({ cnpj: CNPJ_TESTE, competencia, chave: o.chave, xml: o.xml ?? `<NFSe id="${o.chave}"/>` }, dataDir);
  repo.salvarDocumento({
    empresa_id: empresaId, numero: o.chave.slice(-2), origem: 'adn', sistema: 'adn', papel: 'recebida', situacao: 'normal', competencia,
    prestador_doc: '04252011000110', tomador_doc: CNPJ_TESTE, valor_servico: 1000, valor_iss: 50, iss_retido: 0, valor_irrf: 0, pis_cofins_retido: 0, xml_path, ...o,
  });
}

test('espelho: organiza por empresa/ano/mês/tipo, é incremental e move a nota cancelada', async () => {
  const { repo, dataDir } = ambienteTeste();
  const pasta = drive();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    nota(repo, dataDir, id, { chave: 'CHAVE01', valor_irrf: 15 });
    nota(repo, dataDir, id, { chave: 'CHAVE02', papel: 'emitida', prestador_doc: CNPJ_TESTE, tomador_doc: '04252011000110' });
    nota(repo, dataDir, id, { chave: 'CHAVE03', competencia: '2026-10-01' });

    assert.throws(() => salvarPreferencias(repo.db, { pasta: path.join(pasta, 'nao-existe') }), /não encontrada/);
    assert.throws(() => salvarPreferencias(repo.db, { pasta: 'relativa' }), /caminho completo/);
    salvarPreferencias(repo.db, { pasta, pdf: false });

    const r1 = await sincronizarEspelho(repo, { dataDir });
    assert.equal(r1.novos, 3);
    const arqs = listar(pasta);
    const emp = arqs[0].split('/')[0];
    assert.match(emp, new RegExp(`^${CNPJ_TESTE} - `));
    assert.deepEqual(arqs.map((a) => a.slice(emp.length + 1)), [
      '2026/2026-09/Prestadas/CHAVE02.xml',
      '2026/2026-09/Tomadas/CHAVE01.xml',
      '2026/2026-09/planilha-2026-09.csv',
      '2026/2026-09/retencoes-2026-09.csv',
      '2026/2026-10/Tomadas/CHAVE03.xml',
      '2026/2026-10/planilha-2026-10.csv',
    ]);
    assert.equal(fs.readFileSync(path.join(pasta, emp, '2026/2026-09/Tomadas/CHAVE01.xml'), 'utf8'), '<NFSe id="CHAVE01"/>');

    // 2ª vez: nada muda
    const r2 = await sincronizarEspelho(repo, { dataDir });
    assert.deepEqual([r2.novos, r2.atualizados, r2.movidos, r2.iguais, r2.planilhas], [0, 0, 0, 3, 0]);

    // cancelamento → move para Canceladas; PDF ligado → gera PDFs
    repo.marcarSituacao(id, 'CHAVE01', 'cancelada');
    salvarPreferencias(repo.db, { pdf: true });
    const r3 = await sincronizarEspelho(repo, { dataDir });
    assert.equal(r3.movidos, 1);
    assert.equal(r3.pdfs, 3);
    const depois = listar(pasta).map((a) => a.slice(emp.length + 1));
    assert.ok(depois.includes('2026/2026-09/Canceladas/Tomadas/CHAVE01.xml'));
    assert.ok(depois.includes('2026/2026-09/Canceladas/Tomadas/CHAVE01.pdf'));
    assert.ok(!depois.includes('2026/2026-09/Tomadas/CHAVE01.xml'), 'saiu de Tomadas');
    assert.ok(!depois.some((a) => a.includes('.tmp-')), 'sem temporários');
    assert.equal(lerPreferencias(repo.db).ultimo.movidos, 1);

    // apagado no Drive por engano → volta na próxima cópia
    fs.rmSync(path.join(pasta, emp, '2026/2026-10/Tomadas/CHAVE03.xml'));
    assert.equal((await sincronizarEspelho(repo, { dataDir })).novos, 1);
  } finally {
    limpar(dataDir);
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('espelho: depois da busca só roda se configurado, e falha do Drive não derruba nada', async () => {
  const { repo, dataDir } = ambienteTeste();
  const pasta = drive();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    nota(repo, dataDir, id, { chave: 'CHAVE09' });
    assert.equal(await espelharDepoisDaBusca(repo, id, { dataDir }), null, 'sem pasta: não faz nada');
    salvarPreferencias(repo.db, { pasta, automatico: false });
    assert.equal(await espelharDepoisDaBusca(repo, id, { dataDir }), null, 'automático desligado');
    salvarPreferencias(repo.db, { automatico: true });
    assert.equal((await espelharDepoisDaBusca(repo, id, { dataDir })).novos, 1);
    fs.rmSync(pasta, { recursive: true, force: true }); // Drive desconectado
    assert.equal(await espelharDepoisDaBusca(repo, id, { dataDir }), null);
    assert.match(lerPreferencias(repo.db).ultimo.erro, /Google Drive/);
    assert.match(caminhoNoEspelho({ empresa_cnpj: '1', empresa_nome: 'A/B: C', competencia: '2026-01-02', papel: 'emitida', chave: 'X' }), /^1 - A B C\/2026\/2026-01\/Prestadas\/X\.xml$/);
  } finally {
    limpar(dataDir);
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('espelho: API de configuração e cópia manual', async () => {
  const amb = ambienteTeste();
  const pasta = drive();
  const srv = criarServidor(amb.repo, { dataDir: amb.dataDir, sincronizar: async () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (c, corpo) => {
    const r = await fetch(base + c, { method: corpo !== undefined ? 'POST' : 'GET', headers: { 'X-Buscador': '1', 'Content-Type': 'application/json' }, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
    return { status: r.status, dados: await r.json() };
  };
  try {
    const { id } = cadastrarEmpresa(amb.repo, { pfx: gerarPfx(), senha: '1234' });
    nota(amb.repo, amb.dataDir, id, { chave: 'CHAVE21' });
    assert.equal((await req('/api/espelho/sincronizar', {})).status, 400, 'sem pasta');
    assert.equal((await req('/api/espelho', { pasta: 'Z:\\nao\\existe' })).status, 400);
    const ok = await req('/api/espelho', { pasta, pdf: false, automatico: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.dados.pasta, pasta);
    assert.equal((await req('/api/espelho/sincronizar', {})).status, 202);
    let st;
    for (let i = 0; i < 50; i++) {
      st = (await req('/api/espelho')).dados;
      if (!st.rodando && st.ultimo) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(st.ultimo.novos, 1);
    assert.equal((await req('/api/espelho', { pasta: '' })).dados.pasta, '', 'desligar');
  } finally {
    srv.close();
    limpar(amb.dataDir);
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});
