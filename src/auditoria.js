// Log de auditoria append-only, encadeado por hash (docs/arquitetura-rpa-iss-nfse.md, seção 12).
// Cada registro guarda o hash do anterior; alterar ou apagar qualquer linha quebra a cadeia.
// O banco também impede UPDATE/DELETE na tabela (triggers em db/index.js).
import crypto from 'node:crypto';

export const HASH_INICIAL = 'sha256:' + '0'.repeat(64);
export const VERSAO_SCHEMA = '1.0.0';

const calcularHash = ({ hash_anterior, criado_em, tipo, payload }) =>
  'sha256:' + crypto.createHash('sha256').update(`${hash_anterior}\n${criado_em}\n${tipo}\n${payload}`).digest('hex');

// Nunca grava segredos, mesmo que venham por engano no payload.
const CHAVES_PROIBIDAS = /senha|password|pfx|cert_cifrado|senha_cifrada|chave_privada|private|master_?key|pin/i;
function limpar(valor) {
  if (Array.isArray(valor)) return valor.map(limpar);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, CHAVES_PROIBIDAS.test(k) ? '[removido]' : limpar(v)]),
    );
  }
  return valor;
}

/** Mascara CPF (pessoa física) mantendo só os dígitos do meio: ***.456.789-** */
export function mascararDocumento(doc) {
  const d = String(doc ?? '').replace(/\D/g, '');
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : doc ?? null;
}

/**
 * Grava um registro de auditoria.
 * @param {import('better-sqlite3').Database} db
 * @param {{tipo:string, payload:object, empresaCnpj?:string, execucaoId?:number, loteId?:string}} r
 */
export function registrarAuditoria(db, { tipo, payload, empresaCnpj = null, execucaoId = null, loteId = null }) {
  const gravar = db.transaction(() => {
    const ultimo = db.prepare('SELECT hash_registro FROM auditoria ORDER BY id DESC LIMIT 1').get();
    const hash_anterior = ultimo?.hash_registro ?? HASH_INICIAL;
    const criado_em = new Date().toISOString();
    const texto = JSON.stringify({ versao_schema: VERSAO_SCHEMA, tipo, ...limpar(payload) });
    const hash_registro = calcularHash({ hash_anterior, criado_em, tipo, payload: texto });
    const info = db
      .prepare(
        `INSERT INTO auditoria (criado_em, tipo, empresa_cnpj, execucao_id, lote_id, payload, hash_anterior, hash_registro)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(criado_em, tipo, empresaCnpj, execucaoId, loteId, texto, hash_anterior, hash_registro);
    return { id: Number(info.lastInsertRowid), hash_registro };
  });
  return gravar.immediate();
}

/** Confere a cadeia inteira. */
export function verificarAuditoria(db) {
  let anterior = HASH_INICIAL;
  let total = 0;
  for (const r of db.prepare('SELECT * FROM auditoria ORDER BY id').iterate()) {
    total++;
    if (r.hash_anterior !== anterior) {
      return { integra: false, total, problemaEm: r.id, motivo: 'Elo quebrado: registro anterior foi alterado ou apagado.' };
    }
    if (calcularHash(r) !== r.hash_registro) {
      return { integra: false, total, problemaEm: r.id, motivo: 'Conteúdo do registro foi alterado.' };
    }
    anterior = r.hash_registro;
  }
  return { integra: true, total, ultimoHash: anterior };
}

export function listarAuditoria(db, { limite = 50, tipo, empresaCnpj } = {}) {
  const cond = [];
  const p = {};
  if (tipo) { cond.push('tipo = @tipo'); p.tipo = tipo; }
  if (empresaCnpj) { cond.push('empresa_cnpj = @cnpj'); p.cnpj = empresaCnpj; }
  return db
    .prepare(`SELECT * FROM auditoria ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(Number(limite) || 50, 10000)}`)
    .all(p)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

/** Exporta tudo (para arquivo JSON / perícia). */
export function exportarAuditoria(db) {
  return {
    exportado_em: new Date().toISOString(),
    verificacao: verificarAuditoria(db),
    registros: db.prepare('SELECT * FROM auditoria ORDER BY id').all().map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
  };
}
