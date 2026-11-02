// Configuração central: lê o .env uma única vez e expõe valores tipados.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ_PROJETO = path.resolve(__dirname, '..');

function env(nome, padrao) {
  const v = process.env[nome];
  return v === undefined || v === '' ? padrao : v;
}

function caminho(valor) {
  return path.isAbsolute(valor) ? valor : path.resolve(RAIZ_PROJETO, valor);
}

const ambiente = env('NFSE_DEFAULT_AMBIENTE', 'producao');

export const config = {
  ambiente,
  debug: env('NFSE_DEBUG', '') === '1',

  // ADN — Ambiente de Dados Nacional (distribuição de DF-e por NSU para contribuintes)
  adn: {
    host: env(
      ambiente === 'producao' ? 'NFSE_ADN_HOST_PROD' : 'NFSE_ADN_HOST_HOMOLOG',
      ambiente === 'producao' ? 'adn.nfse.gov.br' : 'adn.producaorestrita.nfse.gov.br',
    ),
    basePath: env('NFSE_ADN_BASE_PATH', '/contribuintes'),
    // pausa entre lotes consecutivos (ms) — evita "consumo indevido"
    intervaloLotesMs: Number(env('NFSE_ADN_INTERVALO_MS', '1500')),
    // quantos lotes no máximo por execução (proteção contra loop infinito)
    maxLotesPorExecucao: Number(env('NFSE_ADN_MAX_LOTES', '500')),
    // trava após consumo indevido / HTTP 429 (minutos)
    travaMinutos: Number(env('NFSE_ADN_TRAVA_MIN', '60')),
    timeoutMs: Number(env('NFSE_ADN_TIMEOUT_MS', '60000')),
  },

  // SEFIN Nacional — consulta de NFS-e por chave (usada na conciliação)
  sefin: {
    host: env(
      ambiente === 'producao' ? 'NFSE_API_HOST_SEFIN_PROD' : 'NFSE_API_HOST_SEFIN_HOMOLOG',
      ambiente === 'producao' ? 'sefin.nfse.gov.br' : 'sefin.producaorestrita.nfse.gov.br',
    ),
    basePath: env('NFSE_API_SEFIN_BASE_PATH', '/SefinNacional'),
  },

  // Portal Emissor Nacional (HTML) — usado só para descobrir chaves na conciliação
  portal: {
    host: env('NFSE_PORTAL_HOST', 'www.nfse.gov.br'),
    basePath: env('NFSE_PORTAL_BASE_PATH', '/EmissorNacional'),
  },

  masterKey: env('NFSE_MASTER_KEY', ''),

  servidor: {
    host: env('NFSE_SERVER_HOST', '127.0.0.1'),
    porta: Number(env('NFSE_SERVER_PORT', '3000')),
  },

  agendador: {
    // busca diária no ADN
    cronAdn: env('NFSE_ADN_CRON', ''),
    // conciliação mensal via portal (mês anterior)
    cronConciliacao: env('NFSE_SCHEDULE_CRON', ''),
  },

  dataDir: caminho(env('NFSE_DATA_DIR', './data')),
  dbPath: caminho(env('NFSE_DB_PATH', './data/nfse-robo.db')),
};

export function debug(...args) {
  if (config.debug) console.error('[debug]', ...args);
}
