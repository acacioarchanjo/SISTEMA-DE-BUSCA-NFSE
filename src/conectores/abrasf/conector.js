// Conector ABRASF genérico (consulta de NFS-e prestadas e tomadas).
import https from 'node:https';
import { requisicao, ErroAdn } from '../../adn/cliente.js';
import { ErroConector, METODO } from '../contrato.js';
import { montarEnvio, montarEnvelope, lerResposta } from './mensagens.js';
import { parseCompNfse } from './parser.js';
import { opcoesEfetivas } from './perfis.js';
import { esperar } from '../../util/formatos.js';
import { assinarXml } from '../assinatura.js';

export const VERSAO_CONECTOR = '1.0.0';

/** Divide [de, ate] em janelas de até `dias` dias (datas AAAA-MM-DD, inclusive). */
export function janelas(de, ate, dias) {
  const r = [];
  const um = 86_400_000;
  let ini = new Date(`${de}T00:00:00Z`);
  const fim = new Date(`${ate}T00:00:00Z`);
  if (Number.isNaN(ini.getTime()) || Number.isNaN(fim.getTime()) || ini > fim) throw new ErroConector('ERRO_CONFIGURACAO', null, `Período inválido: ${de} a ${ate}`);
  while (ini <= fim) {
    const f = new Date(Math.min(ini.getTime() + (dias - 1) * um, fim.getTime()));
    r.push({ de: ini.toISOString().slice(0, 10), ate: f.toISOString().slice(0, 10) });
    ini = new Date(f.getTime() + um);
  }
  return r;
}

export class ConectorAbrasf {
  /**
   * @param {{ perfil:object, municipio:{ibge,nome,url,opcoes}, credenciais:{cert,key,cnpj}, inscricaoMunicipal?:string }} cfg
   * @param {{ ca?:string, aoRequisitar?:Function, esperar?:Function }} [teste] injeções para testes
   */
  constructor({ perfil, municipio, credenciais, inscricaoMunicipal }, teste = {}) {
    this.perfil = perfil;
    this.municipio = municipio;
    this.cred = credenciais;
    this.im = inscricaoMunicipal || undefined;
    this.opcoes = opcoesEfetivas(perfil, municipio.opcoes);
    this.id = `${perfil.id}@${VERSAO_CONECTOR}`;
    this.esperar = teste.esperar ?? esperar;
    this.aoRequisitar = teste.aoRequisitar ?? null;
    this.requisicoes = 0;
    this.falhasTransitorias = [];
    this.assinar = !!this.opcoes.assinarConsulta;
    this.algoritmo = this.opcoes.algoritmoAssinatura || 'sha1';
    this.assinaturaDetectada = false; // vira true se a prefeitura recusar consulta sem assinatura
    this.sucessos = 0; // depois que uma consulta passa, a assinatura/algoritmo já estão certos

    let url;
    try {
      url = new URL(municipio.url);
    } catch {
      throw new ErroConector('ERRO_CONFIGURACAO', 'URL_INVALIDA', `URL do webservice inválida: ${municipio.url}`);
    }
    if (url.protocol !== 'https:') throw new ErroConector('ERRO_CONFIGURACAO', 'URL_INVALIDA', 'O webservice precisa ser HTTPS (o certificado A1 é enviado na conexão).');
    this.url = url;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 1, cert: credenciais.cert, key: credenciais.key, ca: teste.ca });
    this.ca = teste.ca;
  }

  capacidades() {
    return {
      notas_prestadas: METODO.API,
      notas_tomadas: this.perfil.operacoes.tomadas ? METODO.API : METODO.NAO_SUPORTADO,
      eventos: METODO.API, // cancelamento/substituição vêm dentro da CompNfse
      manifestar: METODO.NAO_SUPORTADO,
      declarar: METODO.NAO_SUPORTADO,
      encerrar: METODO.NAO_SUPORTADO,
      emitir_guia: METODO.NAO_SUPORTADO,
      consultar_debitos: METODO.NAO_SUPORTADO,
      emitir_certidao: METODO.NAO_SUPORTADO,
    };
  }

  fechar() {
    this.agent.destroy();
  }

  /**
   * Chamada com detecção de assinatura: se a prefeitura recusar a consulta por causa da assinatura,
   * (1) sem assinatura → assina (SHA-1) e tenta de novo; (2) assinada com SHA-1 → tenta SHA-256.
   * O que funcionar fica valendo para as próximas consultas (e é gravado no município).
   */
  async #chamar(papel, envio) {
    const problemaAssinatura = (e) => e instanceof ErroConector && /assinatura|assinad|signature/i.test(`${e.message} ${e.resposta ?? ''}`);
    try {
      return await this.#chamarComRetentativa(papel, envio);
    } catch (e) {
      if (!problemaAssinatura(e) || this.sucessos > 0) throw e;
      if (!this.assinar) {
        this.assinar = true;
        this.assinaturaDetectada = true;
        try {
          return await this.#chamarComRetentativa(papel, envio);
        } catch (e2) {
          if (!problemaAssinatura(e2)) throw e2;
        }
      }
      if (this.algoritmo === 'sha1') {
        this.algoritmo = 'sha256';
        this.assinaturaDetectada = true;
        return this.#chamarComRetentativa(papel, envio);
      }
      throw e;
    }
  }

  /** Uma chamada SOAP com até 3 tentativas para falhas temporárias. */
  async #chamarComRetentativa(papel, envioOriginal) {
    const envio = this.assinar
      ? assinarXml(envioOriginal, this.cred, { elemento: this.perfil.operacoes[papel].envio, algoritmo: this.algoritmo })
      : envioOriginal;
    const { corpo, headers } = montarEnvelope(this.perfil, papel, envio, this.opcoes);
    let ultimo;
    for (let t = 0; t < 3; t++) {
      try {
        if (this.requisicoes > 0 && this.opcoes.intervaloMs > 0) await this.esperar(Number(this.opcoes.intervaloMs));
        this.requisicoes++;
        this.aoRequisitar?.({ papel, envio });
        const r = await requisicao({
          host: this.url.hostname,
          port: this.url.port || undefined,
          path: this.url.pathname + this.url.search,
          metodo: 'POST',
          cert: this.cred.cert,
          key: this.cred.key,
          ca: this.ca,
          agent: this.agent,
          headers: { ...headers, Accept: 'text/xml, application/soap+xml, */*', 'Content-Length': Buffer.byteLength(corpo) },
          corpo,
          timeoutMs: Number(this.opcoes.timeoutMs),
        });
        const lida = lerResposta(this.perfil, papel, r);
        this.sucessos++;
        return lida;
      } catch (e) {
        let erro = e;
        if (e instanceof ErroAdn) {
          // falha de rede/TLS vinda do transporte comum
          const tls = /CERT|SSL|EPROTO|alert/i.test(e.message);
          erro = new ErroConector(tls ? 'ERRO_AUTENTICACAO' : 'PORTAL_INDISPONIVEL', tls ? 'ACESSO_NEGADO' : /ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(e.message) ? 'SEM_CONEXAO' : 'TIMEOUT',
            tls ? `Falha de TLS com a prefeitura (certificado recusado?): ${e.message}` : `Prefeitura sem resposta: ${e.message}`, { temporario: !tls && e.temporario !== false });
        }
        ultimo = erro;
        if (!(erro instanceof ErroConector) || !erro.temporario || t === 2) throw erro;
        const espera = 2000 * 2 ** t;
        this.falhasTransitorias.push({ erro: erro.message, tentativa: t + 1, esperaMs: espera, em: new Date().toISOString() });
        await this.esperar(espera);
      }
    }
    throw ultimo;
  }

  /**
   * Lista as notas do período, quebrando em janelas e páginas.
   * @param {{ papel:'prestadas'|'tomadas', de:string, ate:string }} q
   * @returns {AsyncGenerator<{ xml:string, nota:object, janela:{de,ate}, pagina:number }>}
   */
  async *listarNotas({ papel, de, ate }) {
    if (!this.perfil.operacoes[papel]) {
      throw new ErroConector('ERRO_CONFIGURACAO', 'OPERACAO_NAO_SUPORTADA', `${this.perfil.nome} não permite consultar notas ${papel} pelo ${papel === 'tomadas' ? 'tomador' : 'prestador'}.`);
    }
    for (const j of janelas(de, ate, Number(this.opcoes.janelaDias) || 30)) {
      let pagina = 1;
      while (pagina <= this.opcoes.maxPaginas) {
        const envio = montarEnvio(this.perfil, papel, { cnpj: this.cred.cnpj, im: this.im, de: j.de, ate: j.ate, pagina, periodo: this.opcoes.periodo, namespace: this.opcoes.namespaceDados });
        let r;
        try {
          r = await this.#chamar(papel, envio);
        } catch (e) {
          const br = (d) => d.split('-').reverse().join('/');
          if (e instanceof ErroConector && !e.janela) {
            e.papel = papel;
            e.janela = j;
            e.message = `${e.message} [notas ${papel}, ${br(j.de)} a ${br(j.ate)}${pagina > 1 ? `, página ${pagina}` : ''}]`;
          }
          throw e;
        }
        for (const xml of r.compNfse) {
          let nota;
          try {
            nota = parseCompNfse(xml, { ibge: this.municipio.ibge, municipioNome: this.municipio.nome });
          } catch (e) {
            yield { xml, erro: e.message, janela: j, pagina };
            continue;
          }
          yield { xml, nota, janela: j, pagina };
        }
        if (!this.perfil.paginacao || !r.compNfse.length) break;
        // Sem ProximaPagina explícita: segue enquanto vier página cheia de resultados
        const proxima = r.proximaPagina ?? (r.compNfse.length >= 50 ? pagina + 1 : null);
        if (!proxima || proxima <= pagina) break;
        pagina = proxima;
      }
    }
  }

  /** Consulta mínima (último dia) só para validar URL, envelope e certificado. */
  async testar() {
    const hoje = new Date().toISOString().slice(0, 10);
    const envio = montarEnvio(this.perfil, 'prestadas', { cnpj: this.cred.cnpj, im: this.im, de: hoje, ate: hoje, pagina: 1, periodo: this.opcoes.periodo, namespace: this.opcoes.namespaceDados });
    const r = await this.#chamar('prestadas', envio);
    return {
      ok: true,
      assinaturaDetectada: this.assinaturaDetectada,
      algoritmoAssinatura: this.assinar ? this.algoritmo : null,
      mensagem: `Conexão OK com ${this.municipio.nome}: a prefeitura respondeu no formato ${this.perfil.nome} (${r.compNfse.length} nota(s) hoje${r.mensagens.length ? `; mensagem: ${r.mensagens[0].mensagem}` : ''}).` +
        (this.assinaturaDetectada ? ` O município exige consulta assinada: a assinatura (${this.algoritmo.toUpperCase()}) foi ativada automaticamente.` : this.assinar ? ` Consulta enviada assinada (${this.algoritmo.toUpperCase()}).` : ''),
    };
  }
}
