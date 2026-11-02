import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { criarServidor } from '../src/server/app.js';
import { hashSenha, conferirSenha, ehPrivado, hostPermitido, entrar, criarUsuario, limparLimitesIp } from '../src/server/auth.js';
import { listarAuditoria, verificarAuditoria } from '../src/auditoria.js';
import { ambienteTeste, limpar } from './ajuda.js';

test('auth: scrypt com sal, faixas de IP e Host', () => {
  const h1 = hashSenha('segredo123');
  assert.notEqual(h1, hashSenha('segredo123'), 'sal aleatório');
  assert.ok(conferirSenha('segredo123', h1));
  assert.ok(!conferirSenha('segredo124', h1));
  assert.ok(!conferirSenha('x', 'texto-puro'));
  for (const ip of ['127.0.0.1', '192.168.0.10', '10.1.2.3', '172.20.0.5', '100.101.102.103', 'fd7a:115c:a1e0::1']) assert.ok(ehPrivado(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '200.150.1.1', '2001:4860::8888']) assert.ok(!ehPrivado(ip), ip);
  assert.ok(hostPermitido('localhost'));
  assert.ok(!hostPermitido('192.168.0.10'), 'rede fechada por padrão');
  assert.ok(hostPermitido('192.168.0.10', { redeLiberada: true }));
  assert.ok(!hostPermitido('evil.com', { redeLiberada: true }), 'DNS rebinding');
  assert.ok(hostPermitido('servidor-escritorio', { extras: ['servidor-escritorio'] }));
});

test('auth: bloqueio após 5 senhas erradas e limite por IP', () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    limparLimitesIp();
    criarUsuario(repo.db, { nome: 'Ana Silva', login: 'ana', senha: 'Escritorio2026', perfil: 'admin', trocarSenha: false });
    for (let i = 0; i < 5; i++) assert.throws(() => entrar(repo.db, { login: 'ana', senha: 'errada000' }, { ip: `10.0.0.${i}` }), /incorretos/);
    assert.throws(() => entrar(repo.db, { login: 'ana', senha: 'Escritorio2026' }, { ip: '10.0.0.9' }), /bloqueado/);
    assert.ok(entrar(repo.db, { login: 'ana', senha: 'Escritorio2026' }, { ip: '10.0.0.9', agora: Date.now() + 16 * 60_000 }).token, 'libera depois de 15 min');
    limparLimitesIp();
    for (let i = 0; i < 20; i++) { try { entrar(repo.db, { login: 'naoexiste', senha: 'x' }, { ip: '10.9.9.9' }); } catch { /* esperado */ } }
    assert.throws(() => entrar(repo.db, { login: 'ana', senha: 'Escritorio2026' }, { ip: '10.9.9.9' }), /Muitas tentativas/);
    assert.throws(() => criarUsuario(repo.db, { nome: 'Bia', login: 'bia', senha: '12345678' }), /letras e números|fácil/);
    assert.throws(() => criarUsuario(repo.db, { nome: 'Bia', login: 'bia', senha: 'bia12345' }), /fácil/);
    assert.throws(() => criarUsuario(repo.db, { nome: 'Bia', login: 'Bia Souza', senha: 'Escritorio2026' }), /Login/);
  } finally {
    limparLimitesIp();
    limpar(dataDir);
  }
});

async function subir(ipSimulado) {
  const amb = ambienteTeste();
  let ip = '127.0.0.1';
  const srv = criarServidor(amb.repo, { dataDir: amb.dataDir, sincronizar: async () => {}, redeLiberada: true, ipDe: () => ip });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cliente = () => {
    let cookie = '';
    return async (c, { metodo = 'GET', corpo, host } = {}) => {
      const r = await fetch(base + c, {
        method: metodo,
        headers: { 'X-Buscador': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(host ? { Host: host } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const t = r.headers.get('content-type') ?? '';
      return { status: r.status, cookie: sc, dados: t.includes('json') ? await r.json() : await r.text() };
    };
  };
  void ipSimulado;
  return { ...amb, srv, cliente, setIp: (v) => (ip = v), fechar: () => { srv.close(); limpar(amb.dataDir); } };
}

test('painel: primeiro acesso só no computador principal; depois login obrigatório; perfis e trocar senha', async () => {
  limparLimitesIp();
  const s = await subir();
  try {
    const anon = s.cliente();
    // sem usuários: local acessa (modo computador único); rede é recusada
    assert.equal((await anon('/api/empresas')).status, 200);
    s.setIp('192.168.0.50');
    assert.equal((await anon('/api/empresas')).status, 401);
    assert.equal((await anon('/api/sessao')).dados.podeCriarAdmin, false);
    assert.equal((await anon('/api/primeiro-acesso', { metodo: 'POST', corpo: { nome: 'Invasor', login: 'inv', senha: 'Invasor2026x' } })).status, 403);
    s.setIp('8.8.8.8');
    assert.equal((await anon('/api/sessao')).status, 403, 'IP público nunca é atendido');
    s.setIp('127.0.0.1');

    // primeiro administrador, no computador principal
    const ana = s.cliente();
    assert.equal((await ana('/api/sessao')).dados.podeCriarAdmin, true);
    const pa = await ana('/api/primeiro-acesso', { metodo: 'POST', corpo: { nome: 'Ana Contadora', login: 'ana', senha: 'Escritorio2026' } });
    assert.equal(pa.status, 201);
    assert.match(pa.cookie, /HttpOnly; SameSite=Strict/);
    assert.equal((await ana('/api/primeiro-acesso', { metodo: 'POST', corpo: { nome: 'X', login: 'x', senha: 'Outra2026x' } })).status, 409);
    // agora até o computador local precisa de login
    assert.equal((await anon('/api/empresas')).status, 401);
    assert.equal((await ana('/api/empresas')).status, 200);

    // admin cria um operador e um segundo admin (todos aprovam competências)
    const op = await ana('/api/usuarios', { metodo: 'POST', corpo: { nome: 'Bruno Lima', login: 'bruno', senha: 'Provisoria2026', perfil: 'operador' } });
    assert.equal(op.status, 201);
    assert.equal((await ana('/api/usuarios', { metodo: 'POST', corpo: { nome: 'Carla Dias', login: 'carla', senha: 'Provisoria2026', perfil: 'admin' } })).status, 201);
    assert.equal((await ana('/api/usuarios', { metodo: 'POST', corpo: { nome: 'Outro', login: 'bruno', senha: 'Provisoria2026' } })).status, 409);

    // Bruno entra pela rede, precisa trocar a senha provisória
    s.setIp('192.168.0.51');
    const bruno = s.cliente();
    assert.equal((await bruno('/api/login', { metodo: 'POST', corpo: { login: 'bruno', senha: 'errada' } })).status, 401);
    assert.equal((await bruno('/api/login', { metodo: 'POST', corpo: { login: 'BRUNO', senha: 'Provisoria2026' } })).status, 200, 'login sem diferenciar maiúsculas');
    assert.equal((await bruno('/api/empresas')).status, 403);
    assert.equal((await bruno('/api/senha', { metodo: 'POST', corpo: { atual: 'Provisoria2026', nova: 'Contab2026Novo' } })).status, 200);
    assert.equal((await bruno('/api/empresas')).status, 200);
    // operador: não gerencia usuários nem encerra o servidor
    assert.equal((await bruno('/api/usuarios')).status, 403);
    assert.equal((await bruno('/api/encerrar', { metodo: 'POST' })).status, 403);
    // Host desconhecido (DNS rebinding) recusado
    const status = await new Promise((ok, falha) => {
      const r = http.request({ host: '127.0.0.1', port: s.srv.address().port, path: '/api/sessao', headers: { Host: 'evil.example.com:3000' } }, (res) => { res.resume(); ok(res.statusCode); });
      r.on('error', falha);
      r.end();
    });
    assert.equal(status, 403);

    // admin desativa o operador → sessão dele cai
    s.setIp('127.0.0.1');
    assert.equal((await ana(`/api/usuarios/${op.dados.id}`, { metodo: 'PATCH', corpo: { ativo: false } })).status, 200);
    s.setIp('192.168.0.51');
    assert.equal((await bruno('/api/empresas')).status, 401);
    // não dá para remover o último admin ativo nem se desativar
    s.setIp('127.0.0.1');
    const lista = (await ana('/api/usuarios')).dados.usuarios;
    const idAna = lista.find((u) => u.login === 'ana').id;
    const idCarla = lista.find((u) => u.login === 'carla').id;
    assert.equal((await ana(`/api/usuarios/${idAna}`, { metodo: 'PATCH', corpo: { ativo: false } })).status, 409);
    assert.equal((await ana(`/api/usuarios/${idCarla}`, { metodo: 'PATCH', corpo: { perfil: 'operador' } })).status, 200);
    assert.equal((await ana(`/api/usuarios/${idAna}`, { metodo: 'PATCH', corpo: { perfil: 'operador' } })).status, 409, 'último admin');
    assert.ok(!JSON.stringify(lista).includes('scrypt'), 'hash da senha nunca sai na API');

    // sair
    assert.equal((await ana('/api/logout', { metodo: 'POST' })).status, 200);
    assert.equal((await ana('/api/empresas')).status, 401);

    // auditoria registra quem fez
    const tipos = listarAuditoria(s.repo.db, { limite: 100 });
    const criado = tipos.find((t) => t.tipo === 'usuario.criado');
    assert.equal(criado.payload.usuario.login, 'ana');
    assert.ok(tipos.some((t) => t.tipo === 'usuario.login_recusado'));
    assert.equal(verificarAuditoria(s.repo.db).integra, true);
  } finally {
    limparLimitesIp();
    s.fechar();
  }
});
