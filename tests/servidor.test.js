import test from 'node:test';
import assert from 'node:assert/strict';
import { criarServidor } from '../src/server/app.js';
import { ambienteTeste, gerarPfx, fixture, CNPJ_TESTE, limpar } from './ajuda.js';

async function subir(opcoes = {}) {
  const amb = ambienteTeste();
  const chamadas = [];
  const srv = criarServidor(amb.repo, {
    dataDir: amb.dataDir,
    sincronizar: async (repo, id) => chamadas.push(id),
    ...opcoes,
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (caminho, { metodo = 'GET', corpo, headers = {} } = {}) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'X-Buscador': '1', 'Content-Type': 'application/json', ...headers },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const tipo = r.headers.get('content-type') ?? '';
    return { status: r.status, tipo, dados: tipo.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { ...amb, srv, req, base, chamadas, fechar: () => { srv.close(); limpar(amb.dataDir); } };
}

test('servidor: fluxo completo empresa → importar → listar → exportar', async () => {
  const s = await subir();
  try {
    const pagina = await fetch(s.base + '/');
    assert.equal(pagina.status, 200);
    assert.match(await pagina.text(), /Buscador NFS-e/);

    const criada = await s.req('/api/empresas', { metodo: 'POST', corpo: { pfxBase64: gerarPfx().toString('base64'), senha: '1234' } });
    assert.equal(criada.status, 201, JSON.stringify(criada.dados));
    const id = criada.dados.id;

    const senhaErrada = await s.req('/api/empresas', { metodo: 'POST', corpo: { pfxBase64: gerarPfx().toString('base64'), senha: 'x' } });
    assert.equal(senhaErrada.status, 400);
    assert.match(senhaErrada.dados.erro, /Senha/);

    const lista = await s.req('/api/empresas');
    assert.equal(lista.dados[0].cnpj, CNPJ_TESTE);
    assert.ok(!('cert_cifrado' in lista.dados[0]));
    assert.ok(lista.dados[0].dias_para_vencer > 300);

    const imp = await s.req(`/api/empresas/${id}/importar`, {
      metodo: 'POST',
      corpo: { arquivos: [{ nome: 'a.xml', conteudoBase64: Buffer.from(fixture('nfse-exemplo.xml')).toString('base64') }] },
    });
    assert.equal(imp.dados.novos, 1);

    const docs = await s.req(`/api/documentos?empresa=${id}&papel=emitida&de=2026-03-01&ate=2026-03-31`);
    assert.equal(docs.dados.totais.quantidade, 1);
    assert.equal(docs.dados.totais.valor_liquido, 9185);
    const docId = docs.dados.itens[0].id;

    const xml = await s.req(`/api/documentos/${docId}/xml`);
    assert.match(xml.dados.toString(), /infNFSe/);
    const pdf = await s.req(`/api/documentos/${docId}/pdf`);
    assert.equal(pdf.dados.subarray(0, 4).toString(), '%PDF');
    const zip = await s.req(`/api/exportar/zip?empresa=${id}`);
    assert.equal(zip.dados.subarray(0, 2).toString(), 'PK');
    const csv = await s.req(`/api/exportar/csv?empresa=${id}`);
    assert.match(csv.dados.toString(), /Valor líquido/);

    const busca = await s.req(`/api/empresas/${id}/buscar`, { metodo: 'POST' });
    assert.equal(busca.status, 202);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(s.chamadas, [id]);

    const exc = await s.req(`/api/empresas/${id}`, { metodo: 'DELETE' });
    assert.equal(exc.status, 200);
    assert.equal((await s.req('/api/empresas')).dados.length, 0);
  } finally {
    s.fechar();
  }
});

test('servidor: bloqueia CSRF, Host estranho e path traversal', async () => {
  const s = await subir();
  try {
    const semCabecalho = await fetch(s.base + '/api/buscar-todas', { method: 'POST' });
    assert.equal(semCabecalho.status, 403);

    const http = await import('node:http');
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: s.srv.address().port, path: '/api/resumo', headers: { Host: 'malicioso.com' } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
    });
    assert.equal(status, 403);

    const trav = await fetch(s.base + '/..%2f..%2fpackage.json');
    assert.equal(trav.status, 404);
    assert.equal((await s.req('/api/documentos/999/xml')).status, 404);
  } finally {
    s.fechar();
  }
});
