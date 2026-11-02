// Loop de distribuição por NSU: baixa tudo o que ainda não veio, lote a lote,
// avançando o cursor persistente a cada lote processado.
import { config } from '../config.js';
import { ClienteAdn, ErroAdn } from './cliente.js';
import { abrirCredenciais } from '../crypto/credenciais.js';
import { parseNfse, parseEvento, lerXml, tipoDoXml, papelDaEmpresa, EVENTOS } from '../nfse/parser.js';
import { salvarXmlNfse, salvarXmlEvento } from '../nfse/armazenamento.js';
import { esperar } from '../util/formatos.js';
import { classificarErro, classificarSucesso, statusLegado, CATALOGO } from '../execucao/catalogo.js';
import { registrarAuditoria } from '../auditoria.js';
import { validarDocumentos } from '../fiscal/validacao.js';
import { REGRAS_VERSAO } from '../fiscal/regras.js';
import { sincronizarMunicipal } from '../conectores/sincronizacao.js';
import crypto from 'node:crypto';

export const novoLoteId = () => `lote_${new Date().toISOString()}_${crypto.randomBytes(3).toString('hex')}`;

import { ErroTrava } from '../execucao/erros.js';
import { espelharDepoisDaBusca } from '../espelho/drive.js';
export { ErroTrava };

/**
 * Grava uma NFS-e (XML) para a empresa. Devolve true se for documento novo.
 */
export function registrarNfse(repo, empresa, { xml, nsu = null, origem = 'adn' }, dataDir = config.dataDir) {
  const nota = parseNfse(xml);
  if (!nota.chave) throw new Error('NFS-e sem chave de acesso.');
  const xmlPath = salvarXmlNfse({ cnpj: empresa.cnpj, competencia: nota.competencia, chave: nota.chave, xml }, dataDir);
  const novo = repo.salvarDocumento({
    ...nota,
    empresa_id: empresa.id,
    nsu,
    origem,
    sistema: 'adn',
    papel: papelDaEmpresa(nota, empresa.cnpj),
    situacao: 'normal',
    iss_retido: nota.iss_retido ? 1 : 0,
    pis_cofins_retido: nota.pis_cofins_retido ? 1 : 0,
    xml_path: xmlPath,
  });
  // Evento (ex.: cancelamento) pode ter chegado antes da própria nota.
  for (const ev of repo.listarEventos(empresa.id, nota.chave)) {
    const efeito = EVENTOS[ev.tipo_evento]?.situacao;
    if (efeito) repo.marcarSituacao(empresa.id, nota.chave, efeito);
  }
  return novo;
}

/** Grava um evento e aplica o efeito na nota (cancelada/substituída). */
export function registrarEvento(repo, empresa, { xml, nsu = null, chave: chaveLote, tipoEvento }, dataDir = config.dataDir) {
  const ev = parseEvento(xml);
  const chave = ev.chave || chaveLote;
  const tipo = ev.tipo_evento || tipoEvento;
  const xmlPath = salvarXmlEvento({ cnpj: empresa.cnpj, chave, tipoEvento: tipo, nsu, xml }, dataDir);
  const novo = repo.salvarEvento({
    empresa_id: empresa.id,
    chave,
    nsu,
    tipo_evento: tipo,
    descricao: ev.descricao,
    data_evento: ev.data_evento,
    xml_path: xmlPath,
  });
  if (ev.situacao && chave) repo.marcarSituacao(empresa.id, chave, ev.situacao);
  return novo;
}

/**
 * Sincroniza uma empresa com o ADN.
 * @param {import('../db/repositorio.js').Repositorio} repo
 * @param {number} empresaId
 * @param {object} [opcoes]
 * @param {(cred)=>ClienteAdn} [opcoes.criarCliente] injeção p/ testes
 * @param {(p)=>void} [opcoes.aoProgredir]
 * @param {boolean} [opcoes.ignorarTrava]
 */
export async function sincronizarEmpresa(repo, empresaId, opcoes = {}) {
  const {
    criarCliente = (cred) => new ClienteAdn(cred),
    aoProgredir = () => {},
    ignorarTrava = false,
    intervaloMs = config.adn.intervaloLotesMs,
    maxLotes = config.adn.maxLotesPorExecucao,
    dataDir = config.dataDir,
    loteId = null,
  } = opcoes;

  const empresa = repo.obterEmpresa(empresaId);
  if (!empresa) throw new Error(`Empresa ${empresaId} não encontrada.`);

  if (!ignorarTrava && empresa.trava_ate && new Date(empresa.trava_ate) > new Date()) {
    throw new ErroTrava(
      `Empresa travada até ${new Date(empresa.trava_ate).toLocaleString('pt-BR')} (proteção contra consumo indevido).`,
    );
  }
  if (repo.execucaoEmAndamento(empresaId)) throw new ErroTrava('Já existe uma busca em andamento para esta empresa.');

  const execId = repo.iniciarExecucao(empresaId, 'busca_adn', { loteId });
  const inicio = Date.now();
  const nsuInicial = repo.obterCursor(empresaId);
  const estado = { execucaoId: execId, lotes: 0, novos: 0, eventos: 0, ignorados: 0, erros: [], ultimoNsu: nsuInicial, falhasTransitorias: [] };
  let cliente;

  // Registro de auditoria da execução (seção 12 da arquitetura). Nunca inclui segredos.
  const auditar = (codigo, subcodigo, mensagem, validacao) =>
    registrarAuditoria(repo.db, {
      tipo: 'execucao.finalizada',
      empresaCnpj: empresa.cnpj,
      execucaoId: execId,
      loteId,
      payload: {
        execucao_id: execId,
        lote_id: loteId,
        rotina: 'busca_adn',
        conector: 'adn-nacional@1.0.0',
        metodo: 'API',
        empresa: { cnpj: empresa.cnpj, razao_social: empresa.razao_social },
        status: codigo,
        subcodigo,
        mensagem,
        duracao_ms: Date.now() - inicio,
        cursor: { tipo: 'NSU', de: nsuInicial, ate: estado.ultimoNsu },
        lotes: estado.lotes,
        notas_novas: estado.novos,
        eventos_novos: estado.eventos,
        ignorados: estado.ignorados,
        documentos_com_erro: estado.erros,
        falhas_transitorias: estado.falhasTransitorias,
        validacao: validacao ?? null,
        regras_versao: validacao ? REGRAS_VERSAO : null,
      },
    });

  try {
    cliente = criarCliente(abrirCredenciais(repo, empresaId));
    cliente.aoRetentar = (f) => estado.falhasTransitorias.push(f);

    while (estado.lotes < maxLotes) {
      const cursor = repo.obterCursor(empresaId);
      const r = await cliente.distribuicao(cursor);
      estado.lotes++;

      const novosDocs = r.documentos.filter((d) => Number.isFinite(d.nsu) && d.nsu > cursor).sort((a, b) => a.nsu - b.nsu);
      if (!novosDocs.length) break;

      // Cada lote é gravado em transação: documentos + cursor juntos.
      let maiorNsu = cursor;
      repo.db.transaction(() => {
        for (const d of novosDocs) {
          try {
            if (!d.xml) throw new Error('lote sem XML');
            const tipo = d.tipo.includes('EVENTO') ? 'evento' : d.tipo.includes('NFSE') ? 'nfse' : tipoDoXml(lerXml(d.xml));
            if (tipo === 'nfse') {
              if (registrarNfse(repo, empresa, { xml: d.xml, nsu: d.nsu }, dataDir)) estado.novos++;
            } else if (tipo === 'evento') {
              if (registrarEvento(repo, empresa, { xml: d.xml, nsu: d.nsu, chave: d.chave, tipoEvento: d.tipoEvento }, dataDir)) estado.eventos++;
            } else {
              estado.ignorados++; // DPS, pedidos, etc.
            }
          } catch (e) {
            // Documento problemático não trava a fila: registra e segue.
            estado.erros.push(`NSU ${d.nsu}: ${e.message}`);
          }
          maiorNsu = Math.max(maiorNsu, d.nsu);
        }
        repo.salvarCursor(empresaId, maiorNsu);
      })();
      estado.ultimoNsu = maiorNsu;

      repo.atualizarExecucao(execId, { lotes: estado.lotes, novos: estado.novos, eventos: estado.eventos, ultimo_nsu: maiorNsu });
      aoProgredir({ ...estado });

      if (intervaloMs > 0) await esperar(intervaloMs);
    }

    // Conferência fiscal das notas da empresa (regras da fase 1).
    let validacao = null;
    try {
      validacao = validarDocumentos(repo, { empresaId, dataDir });
    } catch (e) {
      estado.erros.push(`validação fiscal: ${e.message}`);
    }

    const { codigo, subcodigo } = classificarSucesso(estado);
    const div = validacao?.abertas;
    const msg =
      `${estado.novos} nota(s) nova(s), ${estado.eventos} evento(s), ${estado.lotes} lote(s).` +
      (div && (div.BLOQUEANTE || div.ALERTA) ? ` Conferência: ${div.BLOQUEANTE} bloqueante(s), ${div.ALERTA} alerta(s).` : '') +
      (estado.erros.length ? ` ${estado.erros.length} documento(s) com erro: ${estado.erros.slice(0, 5).join(' | ')}` : '');
    repo.atualizarExecucao(execId, {
      status: statusLegado(codigo), codigo, subcodigo, mensagem: msg, finalizar: true,
      lotes: estado.lotes, novos: estado.novos, eventos: estado.eventos, ultimo_nsu: estado.ultimoNsu,
      detalhes: { documentos_com_erro: estado.erros, falhas_transitorias: estado.falhasTransitorias, validacao, cursor: { de: nsuInicial, ate: estado.ultimoNsu } },
    });
    auditar(codigo, subcodigo, msg, validacao);
    return { ...estado, status: statusLegado(codigo), codigo, subcodigo, mensagem: msg, validacao };
  } catch (e) {
    const { codigo, subcodigo } = classificarErro(e);
    if (codigo === 'LIMITE_CONSUMO' && e instanceof ErroAdn) {
      const ate = new Date(Date.now() + config.adn.travaMinutos * 60_000).toISOString();
      repo.definirTrava(empresaId, ate);
    }
    const acao = CATALOGO[codigo]?.acao;
    repo.atualizarExecucao(execId, {
      status: statusLegado(codigo),
      codigo,
      subcodigo,
      mensagem: e.message,
      finalizar: true,
      lotes: estado.lotes,
      novos: estado.novos,
      eventos: estado.eventos,
      ultimo_nsu: estado.ultimoNsu,
      detalhes: { documentos_com_erro: estado.erros, falhas_transitorias: estado.falhasTransitorias, acao_sugerida: acao ?? null, cursor: { de: nsuInicial, ate: estado.ultimoNsu } },
    });
    try { auditar(codigo, subcodigo, e.message, null); } catch { /* auditoria não pode esconder o erro original */ }
    e.estado = { ...estado, status: statusLegado(codigo), codigo, subcodigo };
    e.codigo = codigo;
    e.subcodigo = subcodigo;
    throw e;
  } finally {
    cliente?.fechar?.();
    // copia as notas para a pasta do Google Drive, se configurada (nunca derruba a busca)
    await espelharDepoisDaBusca(repo, empresaId, { dataDir, origem: 'busca_adn' });
  }
}

/**
 * Sincroniza todas as empresas ativas, em sequência (uma por vez, sem paralelismo),
 * e grava o registro de auditoria do lote.
 */
export async function sincronizarTodas(repo, opcoes = {}) {
  const loteId = opcoes.loteId ?? novoLoteId();
  const iniciado = new Date();
  const resultados = [];
  for (const emp of repo.listarEmpresas({ somenteAtivas: true })) {
    try {
      const r = await sincronizarEmpresa(repo, emp.id, { ...opcoes, loteId });
      resultados.push({ empresa: emp.razao_social, cnpj: emp.cnpj, fonte: 'ADN', ok: true, codigo: r.codigo, mensagem: r.mensagem, novos: r.novos, eventos: r.eventos, validacao: r.validacao?.abertas ?? null });
    } catch (e) {
      const c = e.codigo ? { codigo: e.codigo, subcodigo: e.subcodigo } : classificarErro(e);
      resultados.push({ empresa: emp.razao_social, cnpj: emp.cnpj, fonte: 'ADN', ok: false, ...c, mensagem: e.message, novos: e.estado?.novos ?? 0, eventos: e.estado?.eventos ?? 0 });
    }
    // Prefeituras vinculadas à empresa (conectores municipais)
    if (opcoes.municipal === false) continue;
    for (const v of repo.listarVinculos({ empresaId: emp.id, somenteAtivos: true })) {
      try {
        const r = await sincronizarMunicipal(repo, v.id, { loteId, dataDir: opcoes.dataDir, criarConector: opcoes.criarConectorMunicipal });
        resultados.push({ empresa: emp.razao_social, cnpj: emp.cnpj, fonte: v.municipio_nome, ok: true, codigo: r.codigo, mensagem: r.mensagem, novos: r.novos, eventos: 0, validacao: r.validacao?.abertas ?? null });
      } catch (e) {
        const c = e.codigo ? { codigo: e.codigo, subcodigo: e.subcodigo } : classificarErro(e);
        resultados.push({ empresa: emp.razao_social, cnpj: emp.cnpj, fonte: v.municipio_nome, ok: false, ...c, mensagem: e.message, novos: e.estado?.novos ?? 0, eventos: 0 });
      }
    }
  }
  const porStatus = {};
  for (const r of resultados) porStatus[r.codigo] = (porStatus[r.codigo] ?? 0) + 1;
  const soma = (k) => resultados.reduce((t, r) => t + (r[k] ?? 0), 0);
  const divergencias = { BLOQUEANTE: 0, ALERTA: 0, INFO: 0 };
  for (const r of resultados) for (const k in divergencias) divergencias[k] += r.validacao?.[k] ?? 0;
  registrarAuditoria(repo.db, {
    tipo: 'lote.finalizado',
    loteId,
    payload: {
      lote_id: loteId,
      disparo: opcoes.disparo ?? { origem: 'manual' },
      iniciado_em: iniciado.toISOString(),
      finalizado_em: new Date().toISOString(),
      duracao_ms: Date.now() - iniciado.getTime(),
      resumo: { empresas: resultados.length, status: porStatus, notas_novas: soma('novos'), eventos_novos: soma('eventos'), divergencias_abertas: divergencias },
      empresas: resultados.map(({ empresa, cnpj, fonte, codigo, subcodigo, mensagem }) => ({ empresa, cnpj, fonte, status: codigo, subcodigo: subcodigo ?? null, mensagem })),
    },
  });
  return resultados;
}

/**
 * Importa um XML avulso (NFS-e ou evento). Devolve 'nova' | 'existente' | 'evento'.
 */
export function importarXml(repo, empresa, xml, dataDir = config.dataDir) {
  const tipo = tipoDoXml(lerXml(xml));
  if (tipo === 'nfse') return registrarNfse(repo, empresa, { xml, origem: 'importacao' }, dataDir) ? 'nova' : 'existente';
  if (tipo === 'evento') {
    registrarEvento(repo, empresa, { xml }, dataDir);
    return 'evento';
  }
  throw new Error('XML não é NFS-e nem evento do padrão nacional.');
}
