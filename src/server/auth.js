// Autenticação do painel: usuários, senhas (scrypt), sessões e proteção contra tentativas repetidas.
//
// Modos:
//  • Sem nenhum usuário cadastrado → modo "computador único": só o próprio computador (127.0.0.1) acessa, sem login.
//    Pela rede, o acesso é recusado até que um administrador seja criado (no computador principal).
//  • Com usuários → login obrigatório para todos, inclusive no próprio computador.
import crypto from 'node:crypto';
import os from 'node:os';

export const PERFIS = { admin: 'Administrador', operador: 'Operador' };
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSAO_OCIOSA_MS = 8 * 3600_000;    // expira depois de 8 h sem uso
const SESSAO_MAXIMA_MS = 12 * 3600_000;   // e no máximo 12 h depois do login
const FALHAS_BLOQUEIO = 5;                // 5 senhas erradas seguidas → bloqueia o usuário
const BLOQUEIO_MS = 15 * 60_000;
const IP_JANELA_MS = 15 * 60_000;         // e no máximo 20 tentativas por IP a cada 15 min
const IP_MAX = 20;
export const COOKIE = 'buscador_sessao';

export class ErroAuth extends Error {
  name = 'ErroAuth';
  constructor(mensagem, status = 401) { super(mensagem); this.status = status; }
}

// ---------- senhas ----------
export function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(senha).normalize('NFKC'), sal, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('base64')}$${h.toString('base64')}`;
}

export function conferirSenha(senha, armazenado) {
  const [alg, N, r, p, sal, h] = String(armazenado ?? '').split('$');
  if (alg !== 'scrypt' || !sal || !h) return false;
  const esperado = Buffer.from(h, 'base64');
  const calc = crypto.scryptSync(String(senha).normalize('NFKC'), Buffer.from(sal, 'base64'), esperado.length, { N: Number(N), r: Number(r), p: Number(p) });
  return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}

export function validarNovaSenha(senha, { login, nome } = {}) {
  const s = String(senha ?? '');
  if (s.length < 8) throw new ErroAuth('A senha precisa ter pelo menos 8 caracteres.', 400);
  if (s.length > 200) throw new ErroAuth('Senha longa demais.', 400);
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw new ErroAuth('Use letras e números na senha.', 400);
  const baixa = s.toLowerCase();
  if ((login && baixa.includes(String(login).toLowerCase())) || ['12345678', 'senha123', 'password1', 'abc12345'].includes(baixa)) {
    throw new ErroAuth('Senha fácil demais: não use o login nem sequências óbvias.', 400);
  }
  void nome;
}

const LOGIN_RX = /^[a-z0-9._-]{3,40}$/;
const publico = (u) => u && { id: u.id, nome: u.nome, login: u.login, perfil: u.perfil, ativo: !!u.ativo, trocar_senha: !!u.trocar_senha, ultimo_acesso: u.ultimo_acesso, criado_em: u.criado_em };

// ---------- usuários ----------
export const contarUsuarios = (db) => db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
export const listarUsuarios = (db) => db.prepare('SELECT * FROM usuarios ORDER BY nome').all().map(publico);
export const obterUsuario = (db, id) => publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id));

export function criarUsuario(db, { nome, login, senha, perfil = 'operador', trocarSenha = true }) {
  const n = String(nome ?? '').trim();
  const l = String(login ?? '').trim().toLowerCase();
  if (n.length < 3) throw new ErroAuth('Informe o nome (mín. 3 caracteres).', 400);
  if (!LOGIN_RX.test(l)) throw new ErroAuth('Login: 3 a 40 caracteres, só letras minúsculas, números, ponto, hífen ou sublinhado.', 400);
  if (!PERFIS[perfil]) throw new ErroAuth('Perfil inválido.', 400);
  validarNovaSenha(senha, { login: l, nome: n });
  if (db.prepare('SELECT 1 FROM usuarios WHERE login = ?').get(l)) throw new ErroAuth('Já existe um usuário com esse login.', 409);
  const r = db.prepare('INSERT INTO usuarios (nome, login, senha_hash, perfil, trocar_senha) VALUES (?, ?, ?, ?, ?)')
    .run(n, l, hashSenha(senha), perfil, trocarSenha ? 1 : 0);
  return obterUsuario(db, r.lastInsertRowid);
}

const admins = (db) => db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'admin' AND ativo = 1").get().n;

export function atualizarUsuario(db, id, { nome, perfil, ativo }, porId) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!u) throw new ErroAuth('Usuário não encontrado.', 404);
  const novoPerfil = perfil ?? u.perfil;
  const novoAtivo = ativo === undefined ? u.ativo : ativo ? 1 : 0;
  if (!PERFIS[novoPerfil]) throw new ErroAuth('Perfil inválido.', 400);
  const deixaDeSerAdmin = u.perfil === 'admin' && u.ativo && (novoPerfil !== 'admin' || !novoAtivo);
  if (deixaDeSerAdmin && admins(db) <= 1) throw new ErroAuth('É preciso manter pelo menos um administrador ativo.', 409);
  if (Number(id) === Number(porId) && !novoAtivo) throw new ErroAuth('Você não pode desativar o próprio usuário.', 409);
  const n = nome === undefined ? u.nome : String(nome).trim();
  if (n.length < 3) throw new ErroAuth('Informe o nome (mín. 3 caracteres).', 400);
  db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ? WHERE id = ?').run(n, novoPerfil, novoAtivo, id);
  if (!novoAtivo) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  return obterUsuario(db, id);
}

/** Senha provisória definida por um administrador: derruba as sessões e obriga a trocar no próximo acesso. */
export function redefinirSenha(db, id, novaSenha) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!u) throw new ErroAuth('Usuário não encontrado.', 404);
  validarNovaSenha(novaSenha, { login: u.login });
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1, falhas = 0, bloqueado_ate = NULL WHERE id = ?').run(hashSenha(novaSenha), id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
}

/** O próprio usuário troca a senha (exige a atual). Mantém só a sessão atual. */
export function trocarSenha(db, id, { atual, nova }, tokenHashAtual) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!u || !conferirSenha(atual, u.senha_hash)) throw new ErroAuth('Senha atual incorreta.', 400);
  if (atual === nova) throw new ErroAuth('A nova senha precisa ser diferente da atual.', 400);
  validarNovaSenha(nova, { login: u.login });
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE id = ?').run(hashSenha(nova), id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash <> ?').run(id, tokenHashAtual ?? '');
}

// ---------- sessões ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tentativasIp = new Map(); // ip → [timestamps]

function limitarIp(ip, agora) {
  const lista = (tentativasIp.get(ip) ?? []).filter((t) => agora - t < IP_JANELA_MS);
  if (lista.length >= IP_MAX) throw new ErroAuth('Muitas tentativas deste computador. Aguarde 15 minutos.', 429);
  lista.push(agora);
  tentativasIp.set(ip, lista);
}
export const limparLimitesIp = () => tentativasIp.clear();

/** Confere login e senha e cria a sessão. Devolve { token, usuario }. */
export function entrar(db, { login, senha }, { ip = '', navegador = '', agora = Date.now() } = {}) {
  limitarIp(ip, agora);
  const u = db.prepare('SELECT * FROM usuarios WHERE login = ?').get(String(login ?? '').trim().toLowerCase());
  const generico = new ErroAuth('Login ou senha incorretos.', 401);
  if (!u) {
    conferirSenha(senha, hashSenha('x')); // tempo parecido com o de um login existente
    throw generico;
  }
  if (u.bloqueado_ate && new Date(u.bloqueado_ate).getTime() > agora) {
    const min = Math.ceil((new Date(u.bloqueado_ate).getTime() - agora) / 60_000);
    throw new ErroAuth(`Usuário bloqueado por excesso de tentativas. Tente de novo em ${min} min ou peça a um administrador para redefinir a senha.`, 423);
  }
  if (!conferirSenha(senha, u.senha_hash)) {
    const falhas = u.falhas + 1;
    const bloqueio = falhas >= FALHAS_BLOQUEIO ? new Date(agora + BLOQUEIO_MS).toISOString() : null;
    db.prepare('UPDATE usuarios SET falhas = ?, bloqueado_ate = ? WHERE id = ?').run(bloqueio ? 0 : falhas, bloqueio, u.id);
    throw generico;
  }
  if (!u.ativo) throw new ErroAuth('Usuário desativado. Fale com um administrador.', 403);
  db.prepare("UPDATE usuarios SET falhas = 0, bloqueado_ate = NULL, ultimo_acesso = ? WHERE id = ?").run(new Date(agora).toISOString(), u.id);
  const token = crypto.randomBytes(32).toString('base64url');
  const agoraIso = new Date(agora).toISOString();
  db.prepare('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em, ultimo_uso, ip, navegador) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), u.id, agoraIso, new Date(agora + SESSAO_MAXIMA_MS).toISOString(), agoraIso, ip, String(navegador).slice(0, 200));
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(agoraIso); // faxina
  return { token, usuario: publico(u) };
}

/** Sessão válida → usuário (e renova o "último uso"). Inválida/expirada → null. */
export function sessaoDoToken(db, token, agora = Date.now()) {
  if (!token) return null;
  const th = sha256(token);
  const s = db.prepare('SELECT s.*, u.ativo FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?').get(th);
  if (!s) return null;
  const expirou = new Date(s.expira_em).getTime() <= agora || agora - new Date(s.ultimo_uso).getTime() > SESSAO_OCIOSA_MS || !s.ativo;
  if (expirou) {
    db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(th);
    return null;
  }
  db.prepare('UPDATE sessoes SET ultimo_uso = ? WHERE token_hash = ?').run(new Date(agora).toISOString(), th);
  return { usuario: obterUsuario(db, s.usuario_id), tokenHash: th };
}

export const sair = (db, token) => token && db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sha256(token));

export function lerCookie(req, nome = COOKIE) {
  for (const parte of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

export const cookieSessao = (token) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_MAXIMA_MS / 1000}`;
export const cookieApagar = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

// ---------- rede ----------
/** Endereço da conexão (sem o prefixo IPv4-mapeado). */
export const ipDe = (req) => String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
export const ehLocal = (ip) => ip === '127.0.0.1' || ip === '::1';

/** IP de rede privada (escritório) ou Tailscale/CGNAT. Endereços públicos da internet são recusados. */
export function ehPrivado(ip) {
  if (ehLocal(ip)) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  const v6 = ip.toLowerCase();
  return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80:') || v6.startsWith('fd7a:115c:a1e0'); // ULA, link-local, Tailscale
}

/** Nomes pelos quais o painel pode ser chamado (cabeçalho Host): localhost, nome do computador, IPs privados e extras do .env. */
export function hostPermitido(host, { extras = [], redeLiberada = false } = {}) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(h)) return true;
  if (extras.map((x) => x.toLowerCase()).includes(h)) return true;
  if (!redeLiberada) return false;
  const nome = os.hostname().toLowerCase();
  if (h === nome || h === `${nome}.local` || h.endsWith('.ts.net')) return true;
  return ehPrivado(h);
}

/** Endereços desta máquina na rede (para mostrar ao usuário como acessar de outro computador). */
export function enderecosDaRede(porta) {
  const r = [];
  for (const [nome, lista] of Object.entries(os.networkInterfaces())) {
    for (const i of lista ?? []) {
      if (i.family === 'IPv4' && !i.internal && ehPrivado(i.address)) r.push({ interface: nome, url: `http://${i.address}:${porta}` });
    }
  }
  return r;
}
