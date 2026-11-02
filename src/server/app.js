// Painel web local — servidor HTTP em Node puro (sem framework).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { cadastrarEmpresa, analisarCertificado } from '../crypto/credenciais.js';
import { sincronizarEmpresa, sincronizarTodas, importarXml } from '../adn/distribuicao.js';
import { validarDocumentos } from '../fiscal/validacao.js';
import { catalogoRegras } from '../fiscal/regras.js';
import { CATALOGO, SUBCODIGOS } from '../execucao/catalogo.js';
import { listaPerfis, OPCOES_PADRAO, PERFIS, sanitizarOpcoes } from '../conectores/abrasf/perfis.js';
import { sincronizarMunicipal, testarVinculo } from '../conectores/sincronizacao.js';
import { MUNICIPIOS_CONHECIDOS, municipioConhecido, difereDaRecomendada } from '../conectores/municipios-conhecidos.js';
import { registrarAuditoria, verificarAuditoria, listarAuditoria, exportarAuditoria } from '../auditoria.js';
import { conciliarEmpresa } from '../portal/conciliacao.js';
import { lerXmlSalvo, excluirXmlsDaEmpresa } from '../nfse/armazenamento.js';
import { gerarZip } from '../exportador/zip.js';
import { gerarCsv } from '../exportador/planilha.js';
import { gerarDanfse } from '../exportador/danfse.js';
import { diasParaVencer, ErroCertificado } from '../crypto/certificado.js';
import { ErroCofre } from '../crypto/cofre.js';
import { ErroParser } from '../nfse/parser.js';
import { consolidarRetencoes, gerarCsvRetencoes, FILTROS_RETENCAO } from '../fiscal/retencoes.js';
import { gerarPacoteDominio } from '../exportador/dominio.js';
import { lerPreferencias, salvarPreferencias, sincronizarEspelho, ErroEspelho } from '../espelho/drive.js';
import { estadoCompetencia, aprovar, reabrir, registrarEncerramento, registrarGuia, registrarPagamento, visaoGeral, ErroFluxo } from '../apuracao/fluxo.js';
import { analisarBoleto } from '../apuracao/boleto.js';

const PUBLICO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
// Módulos usados tanto pelo servidor/CLI quanto pelo navegador (mesma regra nos dois lados).
const COMPARTILHADOS = { 'compartilhado/senhas.js': path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'util', 'senhas.js') };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LIMITE_CORPO = 15 * 1024 * 1024;

class ErroHttp extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

function json(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(corpo);
}

function arquivo(res, buffer, tipo, nome) {
  res.writeHead(200, {
    'Content-Type': tipo,
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${nome}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tam = 0;
    req.on('data', (c) => {
      tam += c.length;
      if (tam > LIMITE_CORPO) {
        reject(new ErroHttp(413, 'Requisição grande demais.'));
        req.destroy();
      } else partes.push(c);
    });
    req.on('end', () => {
      if (!tam) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString('utf8')));
      } catch {
        reject(new ErroHttp(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

const filtrosDe = (q) => ({
  empresaId: q.get('empresa') || undefined,
  papel: q.get('papel') || undefined,
  situacao: q.get('situacao') || undefined,
  de: q.get('de') || undefined,
  ate: q.get('ate') || undefined,
  busca: q.get('busca') || undefined,
  divergencia: q.get('divergencia') || undefined,
  retencao: (() => {
    const r = q.get('retencao') || undefined;
    if (r && !Object.hasOwn(FILTROS_RETENCAO, r)) throw new ErroHttp(400, `Filtro de retenção inválido: ${r}`);
    return r;
  })(),
});

const hoje = () => new Date().toISOString().slice(0, 10);

/** Identificação da competência (query ou corpo): empresa, município (IBGE) e mês AAAA-MM. */
function alvoCompetencia(o) {
  const empresaId = Number(o.empresa);
  const ibge = String(o.ibge ?? '');
  const competencia = String(o.competencia ?? '');
  if (!empresaId || !/^\d{7}$/.test(ibge) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) {
    throw new ErroHttp(400, 'Informe empresa, município (IBGE de 7 dígitos) e competência (AAAA-MM).');
  }
  return { empresaId, ibge, competencia };
}

/** Filtro do relatório de retenções: empresa e meses AAAA-MM (400 se o formato for inválido). */
function filtroRetencoes(q) {
  const mes = /^\d{4}-\d{2}$/;
  const f = { empresaId: q.get('empresa') || undefined, de: q.get('de') || undefined, ate: q.get('ate') || undefined };
  if ((f.de && !mes.test(f.de)) || (f.ate && !mes.test(f.ate))) throw new ErroHttp(400, 'Meses no formato AAAA-MM.');
  return f;
}

/**
 * Cria o servidor. `opcoes` permite injetar dependências nos testes.
 */
export function criarServidor(repo, opcoes = {}) {
  const sincronizar = opcoes.sincronizar ?? sincronizarEmpresa;
  const sincronizarLote = opcoes.sincronizarTodas ?? sincronizarTodas;
  const sincronizarMunicipalFn = opcoes.sincronizarMunicipal ?? sincronizarMunicipal;
  const testarVinculoFn = opcoes.testarVinculo ?? testarVinculo;
  const conciliar = opcoes.conciliar ?? conciliarEmpresa;
  const dataDir = opcoes.dataDir ?? config.dataDir;
  const hostsPermitidos = new Set(['localhost', '127.0.0.1', '[::1]', config.servidor.host]);

  let espelhoRodando = false;
  const emSegundoPlano = (fn) => {
    Promise.resolve()
      .then(fn)
      .catch((e) => console.error('[tarefa]', e.message));
  };

  const empresaOu404 = (id) => {
    const e = repo.obterEmpresa(Number(id));
    if (!e) throw new ErroHttp(404, 'Empresa não encontrada.');
    return e;
  };
  const docOu404 = (id) => {
    const d = repo.obterDocumento(Number(id));
    if (!d) throw new ErroHttp(404, 'Documento não encontrado.');
    return d;
  };

  // [método, regex, handler(req, res, params, query)]
  const rotas = [
    ['GET', /^\/api\/resumo$/, (req, res) => json(res, 200, { ...repo.resumo(), ambiente: config.ambiente })],

    ['POST', /^\/api\/encerrar$/, (req, res) => {
      if (!opcoes.aoEncerrar) throw new ErroHttp(501, 'Encerramento pelo painel indisponível.');
      json(res, 200, { ok: true });
      setTimeout(opcoes.aoEncerrar, 200);
    }],

    ['GET', /^\/api\/empresas$/, (req, res) =>
      json(res, 200, repo.listarEmpresas().map((e) => ({ ...e, dias_para_vencer: e.cert_valido_ate ? diasParaVencer(e.cert_valido_ate) : null })))],

    ['POST', /^\/api\/empresas$/, async (req, res) => {
      const b = await lerCorpo(req);
      if (!b.pfxBase64) throw new ErroHttp(400, 'Envie o certificado .pfx.');
      const r = cadastrarEmpresa(repo, {
        pfx: Buffer.from(b.pfxBase64, 'base64'),
        senha: b.senha ?? '',
        cnpj: b.cnpj,
        razaoSocial: b.razaoSocial,
      });
      json(res, 201, { ...r, empresa: repo.obterEmpresa(r.id) });
    }],

    // Importação em lote: valida um certificado e diz o que aconteceria, sem gravar.
    ['POST', /^\/api\/certificados\/analisar$/, async (req, res) => {
      const b = await lerCorpo(req);
      if (!b.pfxBase64) throw new ErroHttp(400, 'Envie o certificado .pfx.');
      json(res, 200, analisarCertificado(repo, { pfx: Buffer.from(b.pfxBase64, 'base64'), senha: b.senha ?? '', cnpj: b.cnpj }));
    }],

    ['PATCH', /^\/api\/empresas\/(\d+)$/, async (req, res, [id]) => {
      empresaOu404(id);
      const b = await lerCorpo(req);
      repo.atualizarEmpresa(Number(id), { razao_social: b.razao_social, ativo: b.ativo });
      json(res, 200, repo.obterEmpresa(Number(id)));
    }],

    ['DELETE', /^\/api\/empresas\/(\d+)$/, (req, res, [id], q) => {
      const e = empresaOu404(id);
      repo.excluirEmpresa(e.id);
      if (q.get('apagarXml') === '1') excluirXmlsDaEmpresa(e.cnpj, dataDir);
      json(res, 200, { ok: true });
    }],

    ['POST', /^\/api\/empresas\/(\d+)\/buscar$/, (req, res, [id]) => {
      const e = empresaOu404(id);
      if (repo.execucaoEmAndamento(e.id)) throw new ErroHttp(409, 'Já existe uma busca em andamento para esta empresa.');
      if (e.trava_ate && new Date(e.trava_ate) > new Date())
        throw new ErroHttp(429, `Empresa travada até ${new Date(e.trava_ate).toLocaleString('pt-BR')} (consumo indevido).`);
      emSegundoPlano(() => sincronizar(repo, e.id));
      json(res, 202, { ok: true, mensagem: 'Busca iniciada.' });
    }],

    ['POST', /^\/api\/buscar-todas$/, (req, res) => {
      const empresas = repo.listarEmpresas({ somenteAtivas: true });
      emSegundoPlano(async () => {
        for (const r of await sincronizarLote(repo, { disparo: { origem: 'painel' } })) {
          if (!r.ok) console.error(`[busca] ${r.empresa}: ${r.codigo} — ${r.mensagem}`);
        }
      });
      json(res, 202, { ok: true, mensagem: `Busca iniciada para ${empresas.length} empresa(s).` });
    }],

    ['POST', /^\/api\/empresas\/(\d+)\/conciliar$/, async (req, res, [id]) => {
      const e = empresaOu404(id);
      const b = await lerCorpo(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.de ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.ate ?? ''))
        throw new ErroHttp(400, 'Informe o período (de/ate) no formato AAAA-MM-DD.');
      emSegundoPlano(() => conciliar(repo, e.id, { de: b.de, ate: b.ate }));
      json(res, 202, { ok: true, mensagem: 'Conciliação iniciada.' });
    }],

    ['POST', /^\/api\/empresas\/(\d+)\/destravar$/, (req, res, [id]) => {
      empresaOu404(id);
      repo.definirTrava(Number(id), null);
      json(res, 200, { ok: true });
    }],

    ['POST', /^\/api\/empresas\/(\d+)\/cursor$/, async (req, res, [id]) => {
      empresaOu404(id);
      const b = await lerCorpo(req);
      const nsu = Number(b.nsu);
      if (!Number.isInteger(nsu) || nsu < 0) throw new ErroHttp(400, 'NSU inválido.');
      repo.salvarCursor(Number(id), nsu, { forcar: true });
      json(res, 200, repo.obterEmpresa(Number(id)));
    }],

    ['POST', /^\/api\/empresas\/(\d+)\/importar$/, async (req, res, [id]) => {
      const e = empresaOu404(id);
      const b = await lerCorpo(req);
      const arquivos = Array.isArray(b.arquivos) ? b.arquivos : [];
      let novos = 0;
      const erros = [];
      for (const a of arquivos) {
        try {
          if (importarXml(repo, e, Buffer.from(a.conteudoBase64 ?? '', 'base64').toString('utf8'), dataDir) === 'nova') novos++;
        } catch (err) {
          erros.push(`${a.nome ?? 'arquivo'}: ${err.message}`);
        }
      }
      const validacao = arquivos.length > erros.length ? validarDocumentos(repo, { empresaId: e.id, dataDir }) : null;
      json(res, 200, { novos, total: arquivos.length, erros, divergencias: validacao?.abertas ?? null });
    }],

    ['GET', /^\/api\/execucoes$/, (req, res, _, q) =>
      json(res, 200, repo.listarExecucoes({ empresaId: q.get('empresa'), limite: q.get('limite') ?? 30 }))],

    ['GET', /^\/api\/execucoes\/(\d+)$/, (req, res, [id]) => {
      const x = repo.obterExecucao(Number(id));
      if (!x) throw new ErroHttp(404, 'Execução não encontrada.');
      json(res, 200, { ...x, catalogo: CATALOGO[x.codigo] ?? null, subcodigo_descricao: SUBCODIGOS[x.subcodigo] ?? null });
    }],

    // ---------- catálogo, conferência fiscal e auditoria ----------
    // ---------- prefeituras (conectores municipais) ----------
    ['GET', /^\/api\/perfis$/, (req, res) => json(res, 200, { perfis: listaPerfis(), opcoesPadrao: OPCOES_PADRAO })],

    ['GET', /^\/api\/municipios$/, (req, res) =>
      json(res, 200, repo.listarMunicipios().map((m) => ({ ...m, recomendacao_disponivel: difereDaRecomendada(m) })))],

    ['GET', /^\/api\/municipios\/conhecidos$/, (req, res) =>
      json(res, 200, Object.keys(MUNICIPIOS_CONHECIDOS).map((ibge) => municipioConhecido(ibge)))],

    // Aplica a configuração conhecida (perfil, URL e envelope) mantendo o que o sistema aprendeu (ex.: assinatura)
    ['POST', /^\/api\/municipios\/(\d{7})\/recomendada$/, (req, res, [ibge]) => {
      const r = municipioConhecido(ibge);
      if (!r) throw new ErroHttp(404, 'Não há configuração conhecida para este município.');
      const atual = repo.obterMunicipio(ibge);
      const opcoes = { ...r.opcoes, ...(atual?.opcoes?.assinarConsulta ? { assinarConsulta: true, ...(atual.opcoes.algoritmoAssinatura ? { algoritmoAssinatura: atual.opcoes.algoritmoAssinatura } : {}) } : {}) };
      const m = repo.salvarMunicipio({ ibge, nome: r.nome, uf: r.uf, perfil: r.perfil, url: r.url, opcoes, observacoes: r.observacoes });
      registrarAuditoria(repo.db, { tipo: 'municipio.salvo', payload: { ibge, nome: m.nome, perfil: m.perfil, url: m.url, opcoes, origem: 'configuracao_recomendada' } });
      json(res, 200, m);
    }],

    ['POST', /^\/api\/municipios$/, async (req, res) => {
      const b = await lerCorpo(req);
      const ibge = String(b.ibge ?? '').replace(/\D/g, '');
      if (ibge.length !== 7) throw new ErroHttp(400, 'Informe o código IBGE do município (7 dígitos).');
      if (!String(b.nome ?? '').trim()) throw new ErroHttp(400, 'Informe o nome do município.');
      if (!PERFIS[b.perfil]) throw new ErroHttp(400, `Perfil inválido. Use: ${Object.keys(PERFIS).join(', ')}`);
      let url;
      try { url = new URL(String(b.url ?? '')); } catch { throw new ErroHttp(400, 'URL do webservice inválida.'); }
      if (url.protocol !== 'https:') throw new ErroHttp(400, 'O webservice precisa ser HTTPS.');
      let opcoes;
      try { opcoes = sanitizarOpcoes(b.opcoes); } catch (e) { throw new ErroHttp(400, e.message); }
      const m = repo.salvarMunicipio({
        ibge, nome: String(b.nome).trim(), uf: b.uf ? String(b.uf).trim().toUpperCase().slice(0, 2) : null,
        perfil: b.perfil, url: url.toString(), opcoes, observacoes: b.observacoes ?? null,
      });
      registrarAuditoria(repo.db, { tipo: 'municipio.salvo', payload: { ibge, nome: m.nome, perfil: m.perfil, url: m.url, opcoes } });
      json(res, 200, m);
    }],

    ['DELETE', /^\/api\/municipios\/(\d{7})$/, (req, res, [ibge]) => {
      const m = repo.obterMunicipio(ibge);
      if (!m) throw new ErroHttp(404, 'Município não encontrado.');
      try { repo.excluirMunicipio(ibge); } catch (e) { throw new ErroHttp(400, e.message); }
      registrarAuditoria(repo.db, { tipo: 'municipio.excluido', payload: { ibge, nome: m.nome } });
      json(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/vinculos$/, (req, res, _, q) =>
      json(res, 200, repo.listarVinculos({ empresaId: q.get('empresa') || undefined }).map((v) => {
        const m = repo.obterMunicipio(v.ibge);
        return { ...v, assinar_consulta: !!m?.opcoes?.assinarConsulta, recomendacao_disponivel: difereDaRecomendada(m) };
      }))],

    ['POST', /^\/api\/vinculos$/, async (req, res) => {
      const b = await lerCorpo(req);
      const e = empresaOu404(b.empresa);
      if (!repo.obterMunicipio(String(b.ibge ?? ''))) throw new ErroHttp(400, 'Cadastre o município antes de vincular.');
      const id = repo.salvarVinculo({ empresaId: e.id, ibge: String(b.ibge), inscricaoMunicipal: b.inscricaoMunicipal ? String(b.inscricaoMunicipal).trim() : null, ativo: b.ativo !== false });
      registrarAuditoria(repo.db, { tipo: 'vinculo.salvo', empresaCnpj: e.cnpj, payload: { vinculo_id: id, empresa_id: e.id, ibge: String(b.ibge), inscricao_municipal: b.inscricaoMunicipal ?? null, ativo: b.ativo !== false } });
      json(res, 200, repo.obterVinculo(id));
    }],

    ['DELETE', /^\/api\/vinculos\/(\d+)$/, (req, res, [id]) => {
      const v = repo.obterVinculo(Number(id));
      if (!v) throw new ErroHttp(404, 'Vínculo não encontrado.');
      repo.excluirVinculo(v.id);
      registrarAuditoria(repo.db, { tipo: 'vinculo.excluido', empresaCnpj: v.empresa_cnpj, payload: { vinculo_id: v.id, ibge: v.ibge, municipio: v.municipio_nome } });
      json(res, 200, { ok: true });
    }],

    ['POST', /^\/api\/vinculos\/(\d+)\/testar$/, async (req, res, [id]) => {
      if (!repo.obterVinculo(Number(id))) throw new ErroHttp(404, 'Vínculo não encontrado.');
      try {
        json(res, 200, await testarVinculoFn(repo, Number(id)));
      } catch (e) {
        const c = e.codigo ? { codigo: e.codigo, subcodigo: e.subcodigo ?? null } : { codigo: 'ERRO_INTERNO', subcodigo: null };
        json(res, 200, { ok: false, ...c, mensagem: e.message, acao: CATALOGO[c.codigo]?.acao ?? null });
      }
    }],

    ['POST', /^\/api\/vinculos\/(\d+)\/buscar$/, async (req, res, [id]) => {
      const v = repo.obterVinculo(Number(id));
      if (!v) throw new ErroHttp(404, 'Vínculo não encontrado.');
      const b = await lerCorpo(req);
      const data = /^\d{4}-\d{2}-\d{2}$/;
      if ((b.de && !data.test(b.de)) || (b.ate && !data.test(b.ate))) throw new ErroHttp(400, 'Datas no formato AAAA-MM-DD.');
      if (repo.execucaoEmAndamento(v.empresa_id)) throw new ErroHttp(409, 'Já existe uma busca em andamento para esta empresa.');
      emSegundoPlano(() => sincronizarMunicipalFn(repo, v.id, { de: b.de || undefined, ate: b.ate || undefined, dataDir }));
      json(res, 202, { ok: true, mensagem: `Busca em ${v.municipio_nome} iniciada.` });
    }],

    ['GET', /^\/api\/espelho$/, (req, res) => json(res, 200, { ...lerPreferencias(repo.db), rodando: espelhoRodando })],

    ['POST', /^\/api\/espelho$/, async (req, res) => {
      const b = await lerCorpo(req);
      try {
        const p = salvarPreferencias(repo.db, { pasta: b.pasta, pdf: b.pdf, automatico: b.automatico });
        registrarAuditoria(repo.db, { tipo: 'espelho.configurado', payload: { pasta: p.pasta, pdf: p.pdf, automatico: p.automatico } });
        json(res, 200, { ...p, rodando: espelhoRodando });
      } catch (e) {
        if (e instanceof ErroEspelho) throw new ErroHttp(400, e.message);
        throw e;
      }
    }],

    ['POST', /^\/api\/espelho\/sincronizar$/, (req, res) => {
      const p = lerPreferencias(repo.db);
      if (!p.pasta) throw new ErroHttp(400, 'Configure a pasta do Google Drive primeiro.');
      if (espelhoRodando) throw new ErroHttp(409, 'A cópia para o Google Drive já está em andamento.');
      espelhoRodando = true;
      emSegundoPlano(async () => {
        try {
          await sincronizarEspelho(repo, { dataDir, origem: 'manual' });
        } catch (e) {
          // erro (ex.: Drive desconectado) fica no "último resultado"
          repo.db.prepare(`INSERT INTO configuracoes (chave, valor) VALUES ('espelho.ultimo', ?)
            ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = datetime('now')`)
            .run(JSON.stringify({ em: new Date().toISOString(), origem: 'manual', pasta: p.pasta, erro: e.message, total_erros: 1, erros: [e.message] }));
        } finally {
          espelhoRodando = false;
        }
      });
      json(res, 202, { ok: true, mensagem: 'Copiando as notas para a pasta do Google Drive…' });
    }],

    ['GET', /^\/api\/apuracao\/visao$/, (req, res, _, q) => json(res, 200, visaoGeral(repo.db, { meses: Math.min(Number(q.get('meses')) || 3, 12) }))],

    ['GET', /^\/api\/apuracao$/, (req, res, _, q) => {
      const alvo = alvoCompetencia(Object.fromEntries(q));
      empresaOu404(alvo.empresaId);
      json(res, 200, estadoCompetencia(repo.db, alvo));
    }],

    ['GET', /^\/api\/apuracao\/boleto$/, (req, res, _, q) => {
      try {
        json(res, 200, { ok: true, ...analisarBoleto(q.get('linha') ?? '') });
      } catch (e) {
        json(res, 200, { ok: false, erro: e.message });
      }
    }],

    ['GET', /^\/api\/apuracao\/arquivo$/, (req, res, _, q) => {
      const alvo = alvoCompetencia(Object.fromEntries(q));
      const est = estadoCompetencia(repo.db, alvo);
      const g = est.registro?.guias.find((x) => x.tipo === q.get('tipo'));
      const rel = q.get('qual') === 'comprovante' ? g?.pagamento?.comprovante : g?.arquivo;
      if (!rel) throw new ErroHttp(404, 'Arquivo não encontrado.');
      const abs = path.resolve(dataDir, rel);
      if (!abs.startsWith(path.resolve(dataDir) + path.sep)) throw new ErroHttp(400, 'Caminho inválido.');
      arquivo(res, fs.readFileSync(abs), 'application/pdf', path.basename(abs));
    }],

    ['POST', /^\/api\/apuracao\/(aprovar|reabrir|encerramento|guia|pagamento)$/, async (req, res, [acao]) => {
      const b = await lerCorpo(req);
      const alvo = alvoCompetencia(b);
      empresaOu404(alvo.empresaId);
      const fn = { aprovar, reabrir, encerramento: registrarEncerramento, guia: registrarGuia, pagamento: registrarPagamento }[acao];
      try {
        json(res, 200, fn(repo.db, alvo, b, { dataDir }));
      } catch (e) {
        if (e instanceof ErroFluxo) throw new ErroHttp(e.status, e.message);
        throw e;
      }
    }],

    ['GET', /^\/api\/catalogo$/, (req, res) => json(res, 200, { status: CATALOGO, subcodigos: SUBCODIGOS, regras: catalogoRegras() })],

    ['GET', /^\/api\/divergencias$/, (req, res, _, q) => {
      const f = {
        empresaId: q.get('empresa') || undefined,
        status: q.get('status') ?? 'aberta',
        severidade: q.get('severidade') || undefined,
        codigo: q.get('codigo') || undefined,
        de: q.get('de') || undefined,
        ate: q.get('ate') || undefined,
      };
      if (f.status === 'todas') delete f.status;
      json(res, 200, { ...repo.listarDivergencias({ ...f, limite: q.get('limite') ?? 200, offset: q.get('offset') ?? 0 }), contagem: repo.contarDivergencias({ empresaId: f.empresaId }) });
    }],

    ['POST', /^\/api\/divergencias\/(\d+)\/(ignorar|reabrir)$/, async (req, res, [id, acao]) => {
      const v = repo.obterDivergencia(Number(id));
      if (!v) throw new ErroHttp(404, 'Divergência não encontrada.');
      const b = await lerCorpo(req);
      const motivo = String(b.motivo ?? '').trim();
      if (acao === 'ignorar' && motivo.length < 5) throw new ErroHttp(400, 'Informe o motivo (pelo menos 5 caracteres) para ignorar a divergência.');
      repo.definirStatusDivergencia(v.id, acao === 'ignorar' ? 'ignorada' : 'aberta', acao === 'ignorar' ? motivo : null);
      registrarAuditoria(repo.db, {
        tipo: acao === 'ignorar' ? 'divergencia.ignorada' : 'divergencia.reaberta',
        empresaCnpj: v.empresa_cnpj,
        payload: { divergencia_id: v.id, documento_id: v.documento_id, codigo: v.codigo, severidade: v.severidade, competencia: v.competencia, motivo: motivo || null },
      });
      json(res, 200, repo.obterDivergencia(v.id));
    }],

    ['POST', /^\/api\/validar$/, async (req, res) => {
      const b = await lerCorpo(req);
      if (b.empresa) empresaOu404(b.empresa);
      json(res, 200, validarDocumentos(repo, { empresaId: b.empresa ? Number(b.empresa) : undefined, dataDir, auditar: true }));
    }],

    ['GET', /^\/api\/auditoria$/, (req, res, _, q) =>
      json(res, 200, listarAuditoria(repo.db, { limite: q.get('limite') ?? 50, tipo: q.get('tipo') || undefined }))],

    ['GET', /^\/api\/auditoria\/verificar$/, (req, res) => json(res, 200, verificarAuditoria(repo.db))],

    ['GET', /^\/api\/auditoria\/exportar$/, (req, res) =>
      arquivo(res, Buffer.from(JSON.stringify(exportarAuditoria(repo.db), null, 2), 'utf8'), 'application/json; charset=utf-8', `auditoria-${hoje()}.json`)],

    ['GET', /^\/api\/documentos$/, (req, res, _, q) =>
      json(res, 200, repo.listarDocumentos({ ...filtrosDe(q), limite: q.get('limite') ?? 100, offset: q.get('offset') ?? 0 }))],

    ['GET', /^\/api\/documentos\/(\d+)$/, (req, res, [id]) => {
      const d = docOu404(id);
      json(res, 200, {
        ...d,
        eventos: repo.listarEventos(d.empresa_id, d.chave),
        divergencias: repo.listarDivergencias({ documentoId: d.id, limite: 100 }).itens,
      });
    }],

    ['GET', /^\/api\/documentos\/(\d+)\/xml$/, (req, res, [id]) => {
      const d = docOu404(id);
      if (!d.xml_path) throw new ErroHttp(404, 'XML não disponível.');
      arquivo(res, Buffer.from(lerXmlSalvo(d.xml_path, dataDir), 'utf8'), 'application/xml; charset=utf-8', `${d.chave}.xml`);
    }],

    ['GET', /^\/api\/documentos\/(\d+)\/pdf$/, async (req, res, [id]) => {
      const d = docOu404(id);
      arquivo(res, await gerarDanfse(d), 'application/pdf', `NFSe-${d.numero ?? d.chave}.pdf`);
    }],

    ['GET', /^\/api\/retencoes$/, (req, res, _, q) => json(res, 200, consolidarRetencoes(repo.db, filtroRetencoes(q)))],

    ['GET', /^\/api\/exportar\/retencoes$/, (req, res, _, q) => {
      const f = filtroRetencoes(q);
      const nome = `retencoes-reinf-${f.de ?? 'inicio'}${f.ate && f.ate !== f.de ? `_a_${f.ate}` : ''}.csv`;
      arquivo(res, Buffer.from(gerarCsvRetencoes(consolidarRetencoes(repo.db, f)), 'utf8'), 'text/csv; charset=utf-8', nome);
    }],

    ['GET', /^\/api\/exportar\/csv$/, (req, res, _, q) => {
      const { itens } = repo.listarDocumentos({ ...filtrosDe(q), limite: 100_000 });
      arquivo(res, Buffer.from(gerarCsv(itens), 'utf8'), 'text/csv; charset=utf-8', `nfse-${hoje()}.csv`);
    }],

    ['GET', /^\/api\/exportar\/dominio$/, async (req, res, _, q) => {
      const { itens } = repo.listarDocumentos({ ...filtrosDe(q), limite: 100_000 });
      if (!itens.length) throw new ErroHttp(404, 'Nenhum documento para os filtros escolhidos.');
      const { buffer } = await gerarPacoteDominio(itens, { dataDir });
      arquivo(res, buffer, 'application/zip', `dominio-nfse-${hoje()}.zip`);
    }],

    ['GET', /^\/api\/exportar\/zip$/, async (req, res, _, q) => {
      const { itens } = repo.listarDocumentos({ ...filtrosDe(q), limite: 100_000 });
      if (!itens.length) throw new ErroHttp(404, 'Nenhum documento para os filtros escolhidos.');
      const buf = await gerarZip(itens, { incluirPdf: q.get('pdf') === '1', dataDir });
      arquivo(res, buf, 'application/zip', `nfse-${hoje()}.zip`);
    }],
  ];

  async function tratar(req, res) {
    // Proteção contra DNS rebinding: só aceita Host local.
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (!hostsPermitidos.has(host)) throw new ErroHttp(403, 'Host não permitido.');

    const url = new URL(req.url, 'http://localhost');
    const metodo = req.method.toUpperCase();

    if (url.pathname.startsWith('/api/')) {
      // CSRF: requisições que alteram estado precisam do cabeçalho customizado
      // (um site externo não consegue enviá-lo sem preflight CORS, que não é liberado).
      if (metodo !== 'GET' && req.headers['x-buscador'] !== '1') throw new ErroHttp(403, 'Requisição bloqueada (CSRF).');
      for (const [m, rx, handler] of rotas) {
        if (m !== metodo) continue;
        const casou = url.pathname.match(rx);
        if (casou) return handler(req, res, casou.slice(1), url.searchParams);
      }
      throw new ErroHttp(404, 'Rota não encontrada.');
    }

    if (metodo !== 'GET') throw new ErroHttp(405, 'Método não permitido.');
    const nome = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const abs = COMPARTILHADOS[nome] ?? path.resolve(PUBLICO, nome);
    if ((!COMPARTILHADOS[nome] && !abs.startsWith(PUBLICO + path.sep)) || !fs.existsSync(abs)) throw new ErroHttp(404, 'Não encontrado.');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    fs.createReadStream(abs).pipe(res);
  }

  return http.createServer((req, res) => {
    tratar(req, res).catch((e) => {
      const status = e.status ?? (e instanceof ErroCertificado || e instanceof ErroCofre || e instanceof ErroParser ? 400 : 500);
      if (status >= 500) console.error(e);
      if (!res.headersSent) json(res, status, { erro: e.message });
      else res.end();
    });
  });
}
