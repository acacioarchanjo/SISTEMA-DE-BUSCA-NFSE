// Banco SQLite local (better-sqlite3): esquema + abertura.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS empresas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  cnpj             TEXT NOT NULL UNIQUE,
  razao_social     TEXT NOT NULL,
  cert_cifrado     TEXT NOT NULL,          -- .pfx cifrado (AES-256-GCM)
  senha_cifrada    TEXT NOT NULL,          -- senha do .pfx cifrada
  cert_cn          TEXT,
  cert_emissor     TEXT,
  cert_valido_ate  TEXT,
  ativo            INTEGER NOT NULL DEFAULT 1,
  trava_ate        TEXT,                   -- bloqueio após consumo indevido
  criado_em        TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cursor persistente da distribuição por NSU (um por empresa)
CREATE TABLE IF NOT EXISTS cursor_nsu (
  empresa_id     INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  ultimo_nsu     INTEGER NOT NULL DEFAULT 0,
  atualizado_em  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documentos (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chave                  TEXT NOT NULL,
  nsu                    INTEGER,
  origem                 TEXT NOT NULL DEFAULT 'adn',   -- adn | conciliacao | importacao
  papel                  TEXT NOT NULL,                 -- emitida | recebida | intermediario | outro
  situacao               TEXT NOT NULL DEFAULT 'normal',-- normal | cancelada | substituida
  numero                 TEXT,
  data_emissao           TEXT,
  competencia            TEXT,
  municipio_emissao      TEXT,
  municipio_incidencia   TEXT,
  prestador_doc          TEXT,
  prestador_nome         TEXT,
  prestador_im           TEXT,
  tomador_doc            TEXT,
  tomador_nome           TEXT,
  intermediario_doc      TEXT,
  codigo_servico         TEXT,
  codigo_nbs             TEXT,
  descricao              TEXT,
  valor_servico          REAL DEFAULT 0,
  valor_deducoes         REAL DEFAULT 0,
  base_calculo           REAL DEFAULT 0,
  aliquota               REAL DEFAULT 0,
  valor_iss              REAL DEFAULT 0,
  iss_retido             INTEGER DEFAULT 0,
  valor_pis              REAL DEFAULT 0,
  valor_cofins           REAL DEFAULT 0,
  pis_cofins_retido      INTEGER DEFAULT 0,
  valor_csll             REAL DEFAULT 0,
  valor_irrf             REAL DEFAULT 0,
  valor_inss             REAL DEFAULT 0,
  valor_total_retencoes  REAL DEFAULT 0,
  valor_liquido          REAL DEFAULT 0,
  xml_path               TEXT,
  criado_em              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (empresa_id, chave)
);
CREATE INDEX IF NOT EXISTS ix_doc_empresa_comp ON documentos(empresa_id, competencia);
CREATE INDEX IF NOT EXISTS ix_doc_chave ON documentos(chave);

CREATE TABLE IF NOT EXISTS eventos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chave        TEXT NOT NULL,
  nsu          INTEGER,
  tipo_evento  TEXT,
  descricao    TEXT,
  data_evento  TEXT,
  xml_path     TEXT,
  criado_em    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (empresa_id, chave, tipo_evento, nsu)
);

CREATE TABLE IF NOT EXISTS execucoes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id  INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,              -- busca_adn | conciliacao
  status      TEXT NOT NULL,              -- executando | ok | erro | travada
  inicio      TEXT NOT NULL DEFAULT (datetime('now')),
  fim         TEXT,
  lotes       INTEGER DEFAULT 0,
  novos       INTEGER DEFAULT 0,
  eventos     INTEGER DEFAULT 0,
  ultimo_nsu  INTEGER,
  mensagem    TEXT
);
`;

export function abrirBanco(arquivo = config.dbPath) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new Database(arquivo);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(ESQUEMA);
  // Execuções interrompidas (processo morto) não ficam "executando" para sempre.
  db.prepare(
    `UPDATE execucoes SET status='erro', fim=datetime('now'), mensagem='Interrompida (processo encerrado)'
     WHERE status='executando'`,
  ).run();
  return db;
}

let instancia = null;
export function obterBanco() {
  if (!instancia) instancia = abrirBanco();
  return instancia;
}
