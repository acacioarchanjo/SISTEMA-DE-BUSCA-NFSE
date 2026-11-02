// Busca de notas nas prefeituras (conectores municipais), no mesmo molde da busca no ADN:
// período incremental por vínculo, gravação no modelo canônico, conferência fiscal,
// catálogo de status e log de auditoria.
import { config } from '../config.js';
import { abrirCredenciais } from '../crypto/credenciais.js';
import { papelDaEmpresa } from '../nfse/parser.js';
import { salvarXmlNfse } from '../nfse/armazenamento.js';
import { classificarErro, classificarSucesso, statusLegado, CATALOGO } from '../execucao/catalogo.js';
import { ErroTrava } from '../execucao/erros.js';
import { registrarAuditoria } from '../auditoria.js';
import { validarDocumentos } from '../fiscal/validacao.js';
import { REGRAS_VERSAO } from '../fiscal/regras.js';
import { criarConectorMunicipal } from './registro.js';
import { METODO } from './contrato.js';

const DIA = 86_400_000;
const isoDia = (d) => d.toISOString().slice(0, 10);
const hojeIso = () => isoDia(new Date());

/** Período padrão: desde a última data consultada (com sobreposição) ou N dias para trás na primeira vez. */
export function periodoPadrao(vinculo, hoje = new Date()) {
  const ate = isoDia(hoje);
  if (vinculo.ultima_data) {
    // reconsulta alguns dias para pegar notas emitidas com atraso e cancelamentos recentes
    const de = new Date(new Date(`${vinculo.ultima_data}T00:00:00Z`).getTime() - config.municipal.sobreposicaoDias * DIA);
    return { de: isoDia(de), ate };
  }
  return { de: isoDia(new Date(hoje.getTime() - config.municipal.retroativoDias * DIA)), ate };
}

/** Grava uma nota municipal (XML + modelo canônico + eventos). Devolve true se nova. */
export function registrarNotaMunicipal(repo, empresa, { xml, nota }, dataDir = config.dataDir) {
  const xmlPath = salvarXmlNfse({ cnpj: empresa.cnpj, competencia: nota.competencia, chave: nota.chave, xml }, dataDir);
  const novo = repo.salvarDocumento({
    ...nota,
    empresa_id: empresa.id,
    nsu: null,
    origem: 'prefeitura',
    papel: papelDaEmpresa(nota, empresa.cnpj),
    iss_retido: nota.iss_retido ? 1 : 0,
    pis_cofins_retido: nota.pis_cofins_retido ? 1 : 0,
    xml_path: xmlPath,
  });
  for (const ev of nota.eventos ?? []) {
    // nsu = 0 para eventos municipais (evita duplicar a cada busca: NULL não é único no SQLite)
    repo.salvarEvento({ empresa_id: empresa.id, chave: nota.chave, nsu: 0, tipo_evento: ev.tipo_evento, descricao: ev.descricao, data_evento: ev.data_evento });
  }
  return novo;
}

/**
 * Busca as notas de um vínculo empresa × município.
 * @param {object} opcoes { de, ate, loteId, criarConector (testes), dataDir }
 */
export async function sincronizarMunicipal(repo, vinculoId, opcoes = {}) {
  const { loteId = null, dataDir = config.dataDir, criarConector = criarConectorMunicipal } = opcoes;
  const vinculo = repo.obterVinculo(vinculoId);
  if (!vinculo) throw new Error(`Vínculo ${vinculoId} não encontrado.`);
  const empresa = repo.obterEmpresa(vinculo.empresa_id);
  const municipio = repo.obterMunicipio(vinculo.ibge);
  if (repo.execucaoEmAndamento(empresa.id)) throw new ErroTrava('Já existe uma busca em andamento para esta empresa.');

  const periodo = { ...periodoPadrao(vinculo), ...(opcoes.de ? { de: opcoes.de } : {}), ...(opcoes.ate ? { ate: opcoes.ate } : {}) };
  const execId = repo.iniciarExecucao(empresa.id, 'busca_municipal', { loteId });
  const inicio = Date.now();
  const estado = { execucaoId: execId, novos: 0, atualizados: 0, eventos: 0, erros: [], porPapel: {}, requisicoes: 0, falhasTransitorias: [] };
  const base = {
    vinculo_id: vinculo.id,
    municipio: { ibge: municipio.ibge, nome: municipio.nome, uf: municipio.uf },
    perfil: municipio.perfil,
    periodo,
  };
  let conector;

  const auditar = (codigo, subcodigo, mensagem, validacao) =>
    registrarAuditoria(repo.db, {
      tipo: 'execucao.finalizada',
      empresaCnpj: empresa.cnpj,
      execucaoId: execId,
      loteId,
      payload: {
        execucao_id: execId, lote_id: loteId, rotina: 'busca_municipal', conector: conector?.id ?? municipio.perfil, metodo: 'API',
        empresa: { cnpj: empresa.cnpj, razao_social: empresa.razao_social }, ...base,
        status: codigo, subcodigo, mensagem, duracao_ms: Date.now() - inicio,
        notas_novas: estado.novos, notas_atualizadas: estado.atualizados, por_papel: estado.porPapel,
        requisicoes: estado.requisicoes, documentos_com_erro: estado.erros, falhas_transitorias: estado.falhasTransitorias,
        validacao: validacao ?? null, regras_versao: validacao ? REGRAS_VERSAO : null,
      },
    });

  try {
    conector = criarConector({ municipio, credenciais: abrirCredenciais(repo, empresa.id), inscricaoMunicipal: vinculo.inscricao_municipal });
    const cap = conector.capacidades();
    for (const [papel, operacao] of [['prestadas', 'notas_prestadas'], ['tomadas', 'notas_tomadas']]) {
      if (cap[operacao] !== METODO.API) {
        estado.porPapel[papel] = cap[operacao];
        continue;
      }
      const c = { notas: 0, novas: 0 };
      const vistas = new Set(); // a mesma nota pode voltar em janelas sobrepostas
      for await (const item of conector.listarNotas({ papel, ...periodo })) {
        if (item.erro) {
          estado.erros.push(`${papel}, ${item.janela.de}..${item.janela.ate} p.${item.pagina}: ${item.erro}`);
          continue;
        }
        try {
          if (vistas.has(item.nota.chave)) continue;
          vistas.add(item.nota.chave);
          c.notas++;
          if (registrarNotaMunicipal(repo, empresa, item, dataDir)) {
            c.novas++;
            estado.novos++;
          } else estado.atualizados++;
          estado.eventos += item.nota.eventos?.length ?? 0;
        } catch (e) {
          estado.erros.push(`${papel} nº ${item.nota?.numero ?? '?'}: ${e.message}`);
        }
      }
      estado.porPapel[papel] = c;
    }
    estado.requisicoes = conector.requisicoes ?? 0;
    estado.falhasTransitorias = conector.falhasTransitorias ?? [];
    if (conector.assinaturaDetectada) lembrarAssinatura(repo, municipio);

    let validacao = null;
    try {
      validacao = validarDocumentos(repo, { empresaId: empresa.id, dataDir });
    } catch (e) {
      estado.erros.push(`validação fiscal: ${e.message}`);
    }
    repo.avancarVinculo(vinculo.id, periodo.ate > hojeIso() ? hojeIso() : periodo.ate);

    const { codigo, subcodigo } = classificarSucesso({ novos: estado.novos, eventos: 0, erros: estado.erros });
    const div = validacao?.abertas;
    const papeis = Object.entries(estado.porPapel)
      .map(([p, v]) => (typeof v === 'object' ? `${v.notas} ${p} (${v.novas} nova(s))` : `${p}: não disponível neste município`))
      .join(', ');
    const msg = `${municipio.nome}: ${papeis}. Período ${periodo.de.split('-').reverse().join('/')} a ${periodo.ate.split('-').reverse().join('/')}.` +
      (div && (div.BLOQUEANTE || div.ALERTA) ? ` Conferência: ${div.BLOQUEANTE} bloqueante(s), ${div.ALERTA} alerta(s).` : '') +
      (estado.erros.length ? ` ${estado.erros.length} item(ns) com erro: ${estado.erros.slice(0, 3).join(' | ')}` : '');
    repo.atualizarExecucao(execId, {
      status: statusLegado(codigo), codigo, subcodigo, mensagem: msg, finalizar: true, novos: estado.novos, lotes: estado.requisicoes,
      detalhes: { ...base, por_papel: estado.porPapel, requisicoes: estado.requisicoes, documentos_com_erro: estado.erros, falhas_transitorias: estado.falhasTransitorias, validacao },
    });
    auditar(codigo, subcodigo, msg, validacao);
    return { ...estado, codigo, subcodigo, mensagem: msg, validacao, status: statusLegado(codigo) };
  } catch (e) {
    const { codigo, subcodigo } = classificarErro(e);
    estado.requisicoes = conector?.requisicoes ?? estado.requisicoes;
    estado.falhasTransitorias = conector?.falhasTransitorias ?? [];
    repo.atualizarExecucao(execId, {
      status: statusLegado(codigo), codigo, subcodigo, mensagem: `${municipio.nome}: ${e.message}`, finalizar: true, novos: estado.novos, lotes: estado.requisicoes,
      detalhes: { ...base, por_papel: estado.porPapel, documentos_com_erro: estado.erros, falhas_transitorias: estado.falhasTransitorias, acao_sugerida: CATALOGO[codigo]?.acao ?? null, resposta: e.resposta ?? null },
    });
    try { auditar(codigo, subcodigo, e.message, null); } catch { /* não esconder o erro original */ }
    e.codigo = codigo;
    e.subcodigo = subcodigo;
    e.estado = { ...estado, codigo, subcodigo };
    throw e;
  } finally {
    conector?.fechar?.();
  }
}

/** A prefeitura exigiu consulta assinada: grava no cadastro do município para as próximas buscas. */
function lembrarAssinatura(repo, municipio) {
  const atual = repo.obterMunicipio(municipio.ibge);
  if (atual?.opcoes?.assinarConsulta) return;
  repo.salvarMunicipio({ ...atual, opcoes: { ...atual.opcoes, assinarConsulta: true } });
  registrarAuditoria(repo.db, { tipo: 'municipio.assinatura_detectada', payload: { ibge: municipio.ibge, nome: municipio.nome } });
}

/** Testa a configuração de um vínculo (consulta mínima, sem gravar nada). */
export async function testarVinculo(repo, vinculoId, { criarConector = criarConectorMunicipal } = {}) {
  const vinculo = repo.obterVinculo(vinculoId);
  if (!vinculo) throw new Error(`Vínculo ${vinculoId} não encontrado.`);
  const municipio = repo.obterMunicipio(vinculo.ibge);
  const conector = criarConector({ municipio, credenciais: abrirCredenciais(repo, vinculo.empresa_id), inscricaoMunicipal: vinculo.inscricao_municipal });
  try {
    const r = await conector.testar();
    if (r.assinaturaDetectada) lembrarAssinatura(repo, municipio);
    return { ...r, capacidades: conector.capacidades(), conector: conector.id };
  } finally {
    conector.fechar();
  }
}
