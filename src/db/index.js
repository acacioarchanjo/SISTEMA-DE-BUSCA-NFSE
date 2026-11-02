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

-- Divergências fiscais encontradas pelo motor de regras (src/fiscal/)
CREATE TABLE IF NOT EXISTS divergencias (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  documento_id     INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  codigo           TEXT NOT NULL,           -- RET-001, ALQ-001...
  severidade       TEXT NOT NULL,           -- BLOQUEANTE | ALERTA | INFO
  mensagem         TEXT NOT NULL,
  detalhes         TEXT,                    -- JSON
  competencia      TEXT,
  status           TEXT NOT NULL DEFAULT 'aberta', -- aberta | resolvida | ignorada
  motivo           TEXT,                    -- justificativa de quem ignorou / motivo da resolução
  regras_versao    TEXT,
  criado_em        TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (documento_id, codigo)
);
CREATE INDEX IF NOT EXISTS ix_div_empresa ON divergencias(empresa_id, status, severidade);

-- Cadastro de municípios com webservice próprio (conectores da fase 2)
CREATE TABLE IF NOT EXISTS municipios (
  ibge           TEXT PRIMARY KEY,          -- código IBGE (7 dígitos)
  nome           TEXT NOT NULL,
  uf             TEXT,
  perfil         TEXT NOT NULL,             -- abrasf-1.00 | abrasf-2.01..2.04
  url            TEXT NOT NULL,             -- endpoint do webservice (https)
  opcoes         TEXT,                      -- JSON com variações do envelope SOAP
  observacoes    TEXT,
  criado_em      TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Empresa × município: quais prefeituras consultar para cada empresa
CREATE TABLE IF NOT EXISTS vinculos_municipais (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id           INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ibge                 TEXT NOT NULL REFERENCES municipios(ibge),
  inscricao_municipal  TEXT,
  ativo                INTEGER NOT NULL DEFAULT 1,
  ultima_data          TEXT,                -- última data (AAAA-MM-DD) consultada com sucesso
  criado_em            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (empresa_id, ibge)
);

-- Log de auditoria append-only, encadeado por hash (src/auditoria.js)
CREATE TABLE IF NOT EXISTS auditoria (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  criado_em      TEXT NOT NULL,
  tipo           TEXT NOT NULL,
  empresa_cnpj   TEXT,
  execucao_id    INTEGER,
  lote_id        TEXT,
  payload        TEXT NOT NULL,
  hash_anterior  TEXT NOT NULL,
  hash_registro  TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS auditoria_sem_update BEFORE UPDATE ON auditoria
BEGIN SELECT RAISE(ABORT, 'auditoria: registros não podem ser alterados'); END;
CREATE TRIGGER IF NOT EXISTS auditoria_sem_delete BEFORE DELETE ON auditoria
BEGIN SELECT RAISE(ABORT, 'auditoria: registros não podem ser apagados'); END;

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

-- Apuração do ISS por empresa × município × competência e o fluxo até o pagamento (com aprovação humana)
CREATE TABLE IF NOT EXISTS competencias_iss (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ibge                TEXT NOT NULL,
  competencia         TEXT NOT NULL,             -- AAAA-MM
  status              TEXT NOT NULL,             -- APROVADA | ENCERRADA | GUIA_EMITIDA | PAGA
  apuracao            TEXT NOT NULL,             -- JSON da apuração aprovada (snapshot)
  hash                TEXT NOT NULL,             -- SHA-256 do snapshot (detecta nota que chegou depois)
  aprovado_por        TEXT NOT NULL,
  aprovado_em         TEXT NOT NULL,
  justificativa       TEXT,                      -- obrigatória se aprovada com pendência bloqueante
  encerramento        TEXT,                      -- JSON { protocolo, data, por, observacao }
  guias               TEXT NOT NULL DEFAULT '[]',-- JSON [{ tipo, valor, vencimento, codigoBarras, linhaDigitavel, arquivo, pagamento }]
  atualizado_em       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (empresa_id, ibge, competencia)
);

-- Usuários do painel (acesso pela rede do escritório). Senha com scrypt + sal; nunca em texto.
CREATE TABLE IF NOT EXISTS usuarios (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nome           TEXT NOT NULL,
  login          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash     TEXT NOT NULL,
  perfil         TEXT NOT NULL DEFAULT 'operador',   -- admin | operador
  ativo          INTEGER NOT NULL DEFAULT 1,
  trocar_senha   INTEGER NOT NULL DEFAULT 0,          -- senha provisória: obriga a trocar no 1º acesso
  falhas         INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate  TEXT,
  ultimo_acesso  TEXT,
  criado_em      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessões: só o SHA-256 do token fica no banco (o token vai no cookie HttpOnly)
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash   TEXT PRIMARY KEY,
  usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em    TEXT NOT NULL,
  expira_em    TEXT NOT NULL,
  ultimo_uso   TEXT NOT NULL,
  ip           TEXT,
  navegador    TEXT
);

-- Preferências gravadas pelo painel (ex.: pasta do Google Drive)
CREATE TABLE IF NOT EXISTS configuracoes (
  chave         TEXT PRIMARY KEY,
  valor         TEXT,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Onde cada nota foi copiada na pasta espelho (Google Drive): permite mover quando a nota é cancelada
CREATE TABLE IF NOT EXISTS espelho (
  documento_id  INTEGER PRIMARY KEY REFERENCES documentos(id) ON DELETE CASCADE,
  caminho       TEXT NOT NULL,           -- relativo à pasta espelho
  pdf           INTEGER NOT NULL DEFAULT 0,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function abrirBanco(arquivo = config.dbPath) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new Database(arquivo);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(ESQUEMA);
  migrar(db);
  // Execuções interrompidas (processo morto) não ficam "executando" para sempre.
  db.prepare(
    `UPDATE execucoes SET status='erro', codigo='CANCELADO', subcodigo='INTERROMPIDA', fim=datetime('now'),
       mensagem='Interrompida (o sistema foi encerrado durante a busca). Rode de novo: continua de onde parou.'
     WHERE status='executando'`,
  ).run();
  return db;
}

// Colunas acrescentadas depois da primeira versão: bancos antigos são atualizados ao abrir.
const COLUNAS_NOVAS = {
  execucoes: {
    codigo: 'TEXT',        // catálogo de status (src/execucao/catalogo.js)
    subcodigo: 'TEXT',
    detalhes: 'TEXT',      // JSON: documentos com erro, falhas transitórias etc.
    lote_id: 'TEXT',
  },
  documentos: {
    prestador_regime: 'TEXT',            // opSimpNac: 1 não optante | 2 MEI | 3 ME/EPP
    tp_ret_issqn: 'TEXT',                // 1 não retido | 2 retido pelo tomador | 3 retido pelo intermediário
    codigo_municipio_incidencia: 'TEXT',
    validado_em: 'TEXT',
    sistema: 'TEXT',                     // adn | abrasf (origem do documento)
    codigo_verificacao: 'TEXT',          // notas municipais
    municipio_gerador: 'TEXT',           // IBGE do município emissor (notas municipais)
    codigo_servico_municipal: 'TEXT',
  },
};

function migrar(db) {
  for (const [tabela, colunas] of Object.entries(COLUNAS_NOVAS)) {
    const existentes = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
    for (const [coluna, tipo] of Object.entries(colunas)) {
      if (!existentes.has(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
    }
  }
  // Execuções antigas, anteriores ao catálogo: deriva um código aproximado.
  db.exec(`UPDATE execucoes SET codigo = CASE status
             WHEN 'ok' THEN CASE WHEN COALESCE(novos,0)=0 AND COALESCE(eventos,0)=0 THEN 'SEM_MOVIMENTO' ELSE 'SUCESSO' END
             WHEN 'travada' THEN 'LIMITE_CONSUMO'
             WHEN 'executando' THEN 'EM_EXECUCAO'
             ELSE 'ERRO_INTERNO' END
           WHERE codigo IS NULL`);
}

let instancia = null;
export function obterBanco() {
  if (!instancia) instancia = abrirBanco();
  return instancia;
}
