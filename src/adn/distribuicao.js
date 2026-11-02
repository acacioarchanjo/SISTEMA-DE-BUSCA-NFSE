// Loop de distribuição por NSU: baixa tudo o que ainda não veio, lote a lote,
// avançando o cursor persistente a cada lote processado.
import { config } from '../config.js';
import { ClienteAdn, ErroAdn } from './cliente.js';
import { abrirCredenciais } from '../crypto/credenciais.js';
import { parseNfse, parseEvento, lerXml, tipoDoXml, papelDaEmpresa, EVENTOS } from '../nfse/parser.js';
import { salvarXmlNfse, salvarXmlEvento } from '../nfse/armazenamento.js';
import { esperar } from '../util/formatos.js';

export class ErroTrava extends Error {}

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
  } = opcoes;

  const empresa = repo.obterEmpresa(empresaId);
  if (!empresa) throw new Error(`Empresa ${empresaId} não encontrada.`);

  if (!ignorarTrava && empresa.trava_ate && new Date(empresa.trava_ate) > new Date()) {
    throw new ErroTrava(
      `Empresa travada até ${new Date(empresa.trava_ate).toLocaleString('pt-BR')} (proteção contra consumo indevido).`,
    );
  }
  if (repo.execucaoEmAndamento(empresaId)) throw new ErroTrava('Já existe uma busca em andamento para esta empresa.');

  const execId = repo.iniciarExecucao(empresaId, 'busca_adn');
  const estado = { execucaoId: execId, lotes: 0, novos: 0, eventos: 0, ignorados: 0, erros: [], ultimoNsu: repo.obterCursor(empresaId) };
  let cliente;

  try {
    cliente = criarCliente(abrirCredenciais(repo, empresaId));

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

    const msg =
      `${estado.novos} nota(s) nova(s), ${estado.eventos} evento(s), ${estado.lotes} lote(s).` +
      (estado.erros.length ? ` ${estado.erros.length} documento(s) com erro: ${estado.erros.slice(0, 5).join(' | ')}` : '');
    repo.atualizarExecucao(execId, { status: 'ok', mensagem: msg, finalizar: true, lotes: estado.lotes, novos: estado.novos, eventos: estado.eventos, ultimo_nsu: estado.ultimoNsu });
    return { ...estado, status: 'ok', mensagem: msg };
  } catch (e) {
    let status = 'erro';
    if (e instanceof ErroAdn && e.consumoIndevido) {
      const ate = new Date(Date.now() + config.adn.travaMinutos * 60_000).toISOString();
      repo.definirTrava(empresaId, ate);
      status = 'travada';
    }
    repo.atualizarExecucao(execId, {
      status,
      mensagem: e.message,
      finalizar: true,
      lotes: estado.lotes,
      novos: estado.novos,
      eventos: estado.eventos,
      ultimo_nsu: estado.ultimoNsu,
    });
    e.estado = { ...estado, status };
    throw e;
  } finally {
    cliente?.fechar?.();
  }
}

/** Sincroniza todas as empresas ativas, em sequência (uma por vez, sem paralelismo). */
export async function sincronizarTodas(repo, opcoes = {}) {
  const resultados = [];
  for (const emp of repo.listarEmpresas({ somenteAtivas: true })) {
    try {
      const r = await sincronizarEmpresa(repo, emp.id, opcoes);
      resultados.push({ empresa: emp.razao_social, ok: true, mensagem: r.mensagem });
    } catch (e) {
      resultados.push({ empresa: emp.razao_social, ok: false, mensagem: e.message });
    }
  }
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
