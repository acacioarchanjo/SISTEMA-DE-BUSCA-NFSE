// Cliente HTTPS com autenticação mútua (mTLS) usando o certificado A1.
// Fala com o ADN (distribuição por NSU) e com a API SEFIN Nacional.
import https from 'node:https';
import zlib from 'node:zlib';
import { config, debug } from '../config.js';

export class ErroAdn extends Error {
  constructor(mensagem, { status, codigo, corpo, consumoIndevido = false, temporario = false } = {}) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
    this.corpo = corpo;
    this.consumoIndevido = consumoIndevido;
    this.temporario = temporario;
  }
}

/**
 * Faz uma requisição HTTPS com mTLS e devolve { status, headers, corpo(Buffer) }.
 */
export function requisicao({ host, port, path, metodo = 'GET', cert, key, ca, headers = {}, corpo, timeoutMs = config.adn.timeoutMs, agent }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path,
        method: metodo,
        cert,
        key,
        ca,
        agent,
        headers: { Accept: 'application/json', 'User-Agent': 'buscador-nfse/1.0', ...headers },
        timeout: timeoutMs,
        minVersion: 'TLSv1.2',
      },
      (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new ErroAdn('Tempo esgotado na comunicação com o servidor.', { temporario: true })));
    req.on('error', (e) =>
      reject(
        e instanceof ErroAdn
          ? e
          : new ErroAdn(`Falha de rede: ${e.code ?? ''} ${e.message}`.trim(), {
              // DNS inexistente e erros de certificado não melhoram com nova tentativa
              temporario: !/ENOTFOUND|CERT|SSL|EPROTO/i.test(`${e.code} ${e.message}`),
            }),
      ),
    );
    if (corpo) req.write(corpo);
    req.end();
  });
}

/** Lê uma propriedade sem diferenciar maiúsculas/minúsculas e camelCase/PascalCase. */
export function prop(obj, ...nomes) {
  if (!obj || typeof obj !== 'object') return undefined;
  const mapa = Object.fromEntries(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of nomes) {
    const k = mapa[n.toLowerCase()];
    if (k !== undefined) return obj[k];
  }
  return undefined;
}

/** Decodifica o campo "ArquivoXml": base64 de GZip (com fallback para base64 puro / texto). */
export function decodificarXml(valor) {
  if (!valor) return null;
  const s = String(valor).trim();
  if (s.startsWith('<')) return s;
  const buf = Buffer.from(s, 'base64');
  if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
}

// Indícios de "consumo indevido" (excesso de consultas) nas mensagens do governo.
const RX_CONSUMO_INDEVIDO = /consumo indevido|656|too many|limite de (requisi|consult)/i;

export class ClienteAdn {
  /**
   * @param {{cert:string, key:string, cnpj:string}} credenciais PEMs + CNPJ consultado
   */
  constructor({ cert, key, cnpj }, opcoes = {}) {
    this.cert = cert;
    this.key = key;
    this.cnpj = cnpj;
    this.host = opcoes.host ?? config.adn.host;
    this.basePath = opcoes.basePath ?? config.adn.basePath;
    this.porta = opcoes.porta; // só para testes
    this.ca = opcoes.ca; // só para testes (servidor local autoassinado)
    this.sefinHost = opcoes.sefinHost ?? config.sefin.host;
    this.agent = new https.Agent({ keepAlive: true, cert, key, ca: opcoes.ca, maxSockets: 1 });
    this.tentativas = opcoes.tentativas ?? 4;
    this.esperaBaseMs = opcoes.esperaBaseMs ?? 2000;
  }

  fechar() {
    this.agent.destroy();
  }

  async #getJson(host, path) {
    let ultimoErro;
    for (let t = 0; t < this.tentativas; t++) {
      try {
        debug('GET', `https://${host}${path}`);
        const r = await requisicao({ host, port: this.porta, path, cert: this.cert, key: this.key, ca: this.ca, agent: this.agent });
        const texto = r.corpo.toString('utf8');
        let json = null;
        try {
          json = texto ? JSON.parse(texto) : null;
        } catch {
          /* corpo não-JSON */
        }
        debug('HTTP', r.status, texto.slice(0, 500));

        // Só inspeciona a mensagem em respostas de erro (um lote OK traz XML em base64,
        // que pode conter qualquer sequência de caracteres).
        if (r.status === 429 || (r.status >= 400 && RX_CONSUMO_INDEVIDO.test(texto))) {
          throw new ErroAdn('Consumo indevido / limite de consultas atingido. Aguarde antes de nova busca.', {
            status: r.status,
            corpo: texto,
            consumoIndevido: true,
          });
        }
        if (r.status === 401 || r.status === 403) {
          throw new ErroAdn(
            'Acesso negado pelo servidor (HTTP ' + r.status + '). Verifique se o certificado é válido e pertence ao CNPJ consultado.',
            { status: r.status, corpo: texto },
          );
        }
        if (r.status >= 500) {
          throw new ErroAdn(`Servidor do governo indisponível (HTTP ${r.status}).`, { status: r.status, corpo: texto, temporario: true });
        }
        return { status: r.status, json, texto };
      } catch (e) {
        ultimoErro = e;
        if (!(e instanceof ErroAdn) || !e.temporario || t === this.tentativas - 1) throw e;
        const espera = this.esperaBaseMs * 2 ** t;
        debug(`tentativa ${t + 1} falhou (${e.message}); nova tentativa em ${espera}ms`);
        await new Promise((r) => setTimeout(r, espera));
      }
    }
    throw ultimoErro;
  }

  /**
   * Distribuição de DF-e por NSU (lote de até 50 documentos a partir do NSU informado).
   * GET /contribuintes/DFe/{NSU}?cnpjConsulta={cnpj}&lote=true
   * @returns {{ status:string, documentos:Array<{nsu:number, chave:string, tipo:string, tipoEvento:string, xml:string, dataHora:string}>, erros:Array, alertas:Array }}
   */
  async distribuicao(nsu) {
    const qs = new URLSearchParams({ cnpjConsulta: this.cnpj, lote: 'true' });
    const { status: http, json, texto } = await this.#getJson(this.host, `${this.basePath}/DFe/${nsu}?${qs}`);

    const statusProc = String(prop(json, 'StatusProcessamento') ?? '');
    const lote = prop(json, 'LoteDFe') ?? [];
    const erros = prop(json, 'Erros') ?? [];
    const alertas = prop(json, 'Alertas') ?? [];

    if (http === 404 || /NENHUM_DOCUMENTO/i.test(statusProc)) {
      return { status: 'NENHUM_DOCUMENTO', documentos: [], erros, alertas };
    }
    if (/REJEICAO/i.test(statusProc) || (http >= 400 && !lote.length)) {
      const msg = erros.map((e) => `${prop(e, 'Codigo') ?? ''} ${prop(e, 'Descricao') ?? ''}`.trim()).join('; ');
      throw new ErroAdn(`ADN rejeitou a consulta: ${msg || texto.slice(0, 300) || 'HTTP ' + http}`, {
        status: http,
        codigo: prop(erros[0], 'Codigo'),
        corpo: texto,
        consumoIndevido: RX_CONSUMO_INDEVIDO.test(msg),
      });
    }

    const documentos = lote.map((d) => ({
      nsu: Number(prop(d, 'NSU')),
      chave: prop(d, 'ChaveAcesso') ?? null,
      tipo: String(prop(d, 'TipoDocumento') ?? '').toUpperCase(),
      tipoEvento: prop(d, 'TipoEvento') ?? null,
      dataHora: prop(d, 'DataHoraGeracao') ?? null,
      xml: decodificarXml(prop(d, 'ArquivoXml')),
    }));
    return { status: 'DOCUMENTOS_LOCALIZADOS', documentos, erros, alertas };
  }

  /**
   * Consulta uma NFS-e pela chave de acesso (API SEFIN Nacional).
   * GET /SefinNacional/nfse/{chave} → { nfseXmlGZipB64 }
   */
  async consultarNfse(chave) {
    const { status, json, texto } = await this.#getJson(this.sefinHost, `${config.sefin.basePath}/nfse/${chave}`);
    if (status === 404) return null;
    if (status >= 400) throw new ErroAdn(`Consulta da NFS-e ${chave} falhou (HTTP ${status}): ${texto.slice(0, 300)}`, { status });
    return decodificarXml(prop(json, 'nfseXmlGZipB64', 'NfseXmlGZipB64', 'ArquivoXml'));
  }
}
