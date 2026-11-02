// Linha de comando: npm run cli -- <comando>
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { obterBanco } from '../db/index.js';
import { Repositorio } from '../db/repositorio.js';
import { cadastrarEmpresa, analisarCertificado } from '../crypto/credenciais.js';
import { lerPlanilhaSenhas, senhaPara } from '../util/senhas.js';
import { lerCertificado } from '../crypto/certificado.js';
import { sincronizarEmpresa, sincronizarTodas, importarXml } from '../adn/distribuicao.js';
import { conciliarEmpresa, mesAnterior } from '../portal/conciliacao.js';
import { gerarZip } from '../exportador/zip.js';
import { gerarCsv } from '../exportador/planilha.js';
import { iniciarAgendador } from '../agendador.js';
import { gerarBackup } from '../backup.js';
import { restaurarBackup, listarBackups, analisarBackup } from '../restaurar.js';
import { formatarCnpj, somenteDigitos, dataBR } from '../util/formatos.js';
import { validarDocumentos } from '../fiscal/validacao.js';
import { catalogoRegras } from '../fiscal/regras.js';
import { CATALOGO } from '../execucao/catalogo.js';
import { verificarAuditoria, listarAuditoria, exportarAuditoria, registrarAuditoria } from '../auditoria.js';
import { listaPerfis, PERFIS, sanitizarOpcoes, OPCOES_PADRAO } from '../conectores/abrasf/perfis.js';
import { sincronizarMunicipal, testarVinculo } from '../conectores/sincronizacao.js';

const repo = () => new Repositorio(obterBanco());

function empresaPor(r, ref) {
  const e = /^\d{1,6}$/.test(ref) ? r.obterEmpresa(Number(ref)) : r.obterEmpresaPorCnpj(somenteDigitos(ref));
  if (!e) throw new Error(`Empresa não encontrada: ${ref}`);
  return e;
}

const programa = new Command();
programa.name('buscador-nfse').description('Robô local de download de NFS-e do Padrão Nacional (ADN)');

programa
  .command('empresas')
  .description('lista as empresas cadastradas')
  .action(() => {
    const lista = repo().listarEmpresas();
    if (!lista.length) return console.log('Nenhuma empresa cadastrada.');
    console.table(
      lista.map((e) => ({
        id: e.id,
        empresa: e.razao_social,
        cnpj: formatarCnpj(e.cnpj),
        ativa: e.ativo ? 'sim' : 'não',
        'cert. até': e.cert_valido_ate?.slice(0, 10),
        'último NSU': e.ultimo_nsu,
        notas: e.total_documentos,
      })),
    );
  });

programa
  .command('certificado <pfx>')
  .description('mostra os dados de um certificado .pfx (sem cadastrar)')
  .requiredOption('-s, --senha <senha>', 'senha do certificado')
  .action((pfx, o) => {
    const i = lerCertificado(fs.readFileSync(pfx), o.senha);
    console.log({ cn: i.cn, cnpj: i.cnpj, cpf: i.cpf, emissor: i.emissor, validoDe: i.validoDe, validoAte: i.validoAte });
  });

programa
  .command('adicionar <pfx>')
  .description('cadastra (ou atualiza) uma empresa a partir do certificado A1')
  .option('-s, --senha <senha>', 'senha do certificado (ou variável NFSE_PFX_SENHA)')
  .option('-c, --cnpj <cnpj>', 'CNPJ (se não quiser usar o do certificado)')
  .option('-r, --razao <razao>', 'razão social')
  .action((pfx, o) => {
    const r = cadastrarEmpresa(repo(), {
      pfx: fs.readFileSync(pfx),
      senha: o.senha ?? process.env.NFSE_PFX_SENHA ?? '',
      cnpj: o.cnpj,
      razaoSocial: o.razao,
    });
    console.log(`Empresa #${r.id} (${formatarCnpj(r.cnpj)}) salva. Certificado válido até ${r.certificado.validoAte.slice(0, 10)}.`);
  });

programa
  .command('importar-certificados <caminhos...>')
  .description('cadastra/renova várias empresas de uma vez a partir de .pfx (arquivos ou pastas)')
  .option('-s, --senha <senha>', 'senha usada para os certificados sem senha na planilha')
  .option('--senhas <csv>', 'planilha CSV "arquivo;senha" ou "CNPJ;senha"')
  .option('--simular', 'só valida e mostra o resultado, sem gravar')
  .option('--substituir-mais-novo', 'grava mesmo quando o certificado cadastrado vence depois do novo')
  .action((caminhos, o) => {
    const r = repo();
    const senhas = o.senhas ? lerPlanilhaSenhas(fs.readFileSync(o.senhas, 'utf8')) : new Map();
    const arquivos = caminhos.flatMap((c) =>
      fs.statSync(c).isDirectory()
        ? fs.readdirSync(c, { recursive: true }).map(String).filter((f) => /\.(pfx|p12)$/i.test(f)).map((f) => path.join(c, f))
        : [c],
    );
    if (!arquivos.length) return console.log('Nenhum arquivo .pfx/.p12 encontrado.');
    const cont = { nova: 0, renovacao: 0, ignorado: 0, erro: 0 };
    const linhas = [];
    for (const arq of arquivos) {
      const senha = senhaPara(senhas, arq) ?? o.senha ?? '';
      try {
        const pfx = fs.readFileSync(arq);
        const a = analisarCertificado(r, { pfx, senha });
        let resultado;
        if (a.situacao === 'mesmo' || (a.situacao === 'mais_antigo' && !o.substituirMaisNovo)) {
          resultado = a.situacao === 'mesmo' ? 'já cadastrado' : 'ignorado (o cadastrado vence depois)';
          cont.ignorado++;
        } else {
          if (!o.simular) cadastrarEmpresa(r, { pfx, senha });
          resultado = (a.situacao === 'nova' ? 'nova' : 'renovação') + (o.simular ? ' (simulação)' : '');
          cont[a.situacao === 'nova' ? 'nova' : 'renovacao']++;
        }
        linhas.push({ arquivo: path.basename(arq), cnpj: formatarCnpj(a.cnpj), empresa: a.nome.slice(0, 40), validade: a.validoAte.slice(0, 10), resultado });
      } catch (e) {
        cont.erro++;
        linhas.push({ arquivo: path.basename(arq), cnpj: '', empresa: '', validade: '', resultado: `ERRO: ${e.message}` });
      }
    }
    console.table(linhas);
    console.log(`${cont.nova} nova(s), ${cont.renovacao} renovação(ões), ${cont.ignorado} ignorada(s), ${cont.erro} com erro.${o.simular ? ' Nada foi gravado (--simular).' : ''}`);
    if (cont.erro) process.exitCode = 1;
  });

programa
  .command('remover <empresa>')
  .description('remove uma empresa (id ou CNPJ) e suas notas do banco')
  .action((ref) => {
    const r = repo();
    const e = empresaPor(r, ref);
    r.excluirEmpresa(e.id);
    console.log(`Empresa ${e.razao_social} removida.`);
  });

programa
  .command('buscar [empresa]')
  .description('baixa as NFS-e novas do ADN (uma empresa por id/CNPJ, ou todas)')
  .option('--ignorar-trava', 'ignora a trava de consumo indevido')
  .action(async (ref, o) => {
    const r = repo();
    if (!ref) {
      const resultados = await sincronizarTodas(r, { ignorarTrava: o.ignorarTrava, disparo: { origem: 'cli' } });
      if (!resultados.length) console.log('Nenhuma empresa ativa cadastrada.');
      for (const x of resultados) {
        console.log(`${x.ok ? '✔' : '✖'} ${x.empresa} [${x.codigo}${x.subcodigo ? '/' + x.subcodigo : ''}]: ${x.mensagem}`);
        if (!x.ok && CATALOGO[x.codigo]?.acao) console.log(`    → ${CATALOGO[x.codigo].acao}`);
      }
      // código de saída ≠ 0 se alguma empresa falhou (aparece no Agendador de Tarefas)
      if (resultados.some((x) => !x.ok)) process.exitCode = 1;
      return;
    }
    const e = empresaPor(r, ref);
    const res = await sincronizarEmpresa(r, e.id, {
      ignorarTrava: o.ignorarTrava,
      aoProgredir: (p) => process.stdout.write(`\r  lote ${p.lotes} | NSU ${p.ultimoNsu} | novas ${p.novos} | eventos ${p.eventos}   `),
    });
    console.log(`\n✔ ${e.razao_social} [${res.codigo}]: ${res.mensagem}`);
  });

programa
  .command('validar [empresa]')
  .description('roda a conferência fiscal (regras RET/ALQ/CMP/CAN) nas notas já baixadas')
  .action((ref) => {
    const r = repo();
    const empresaId = ref ? empresaPor(r, ref).id : undefined;
    const v = validarDocumentos(r, { empresaId, auditar: true });
    console.log(`${v.documentos} nota(s) conferida(s): ${v.novas} divergência(s) nova(s), ${v.reabertas} reaberta(s), ${v.resolvidas} resolvida(s).`);
    console.log(`Abertas: ${v.abertas.BLOQUEANTE} bloqueante(s), ${v.abertas.ALERTA} alerta(s), ${v.abertas.INFO} informativa(s).`);
    if (v.abertas.BLOQUEANTE) process.exitCode = 1;
  });

programa
  .command('divergencias [empresa]')
  .description('lista as divergências fiscais abertas')
  .option('-s, --severidade <s>', 'BLOQUEANTE | ALERTA | INFO')
  .option('--todas', 'inclui resolvidas e ignoradas')
  .option('--regras', 'mostra só o catálogo de regras')
  .action((ref, o) => {
    if (o.regras) return console.table(catalogoRegras());
    const r = repo();
    const empresaId = ref ? empresaPor(r, ref).id : undefined;
    const { itens, total } = r.listarDivergencias({
      empresaId, severidade: o.severidade?.toUpperCase(), status: o.todas ? undefined : 'aberta', limite: 500,
    });
    if (!itens.length) return console.log('Nenhuma divergência.');
    console.table(itens.map((v) => ({
      id: v.id, regra: v.codigo, severidade: v.severidade, status: v.status, competencia: dataBR(v.competencia).slice(3),
      nota: v.numero, empresa: v.empresa_nome?.slice(0, 25), mensagem: v.mensagem.slice(0, 90),
    })));
    if (total > itens.length) console.log(`(mostrando ${itens.length} de ${total})`);
  });

programa
  .command('auditoria <acao>')
  .description('log de auditoria: verificar | listar | exportar')
  .option('-n, --limite <n>', 'quantos registros listar', '30')
  .option('-o, --saida <arquivo>', 'arquivo de saída (exportar)')
  .action((acao, o) => {
    const db = repo().db;
    if (acao === 'verificar') {
      const v = verificarAuditoria(db);
      console.log(v.integra ? `✔ Cadeia íntegra: ${v.total} registro(s). Último hash: ${v.ultimoHash}` : `✖ CADEIA QUEBRADA no registro ${v.problemaEm}: ${v.motivo}`);
      if (!v.integra) process.exitCode = 2;
    } else if (acao === 'listar') {
      console.table(listarAuditoria(db, { limite: o.limite }).map((x) => ({
        id: x.id, quando: new Date(x.criado_em).toLocaleString('pt-BR'), tipo: x.tipo, cnpj: x.empresa_cnpj ?? '', status: x.payload.status ?? '', hash: x.hash_registro.slice(7, 19),
      })));
    } else if (acao === 'exportar') {
      const saida = o.saida ?? `auditoria-${new Date().toISOString().slice(0, 10)}.json`;
      fs.writeFileSync(saida, JSON.stringify(exportarAuditoria(db), null, 2));
      console.log(`Auditoria exportada para ${saida}`);
    } else {
      throw new Error('Ação inválida. Use: verificar | listar | exportar');
    }
  });

// ---------- prefeituras (conectores municipais) ----------
programa
  .command('perfis')
  .description('lista os perfis de webservice municipal suportados e as opções configuráveis')
  .action(() => {
    console.table(listaPerfis());
    console.log('Opções (padrão):', OPCOES_PADRAO);
  });

programa
  .command('municipios')
  .description('lista os municípios cadastrados (webservices de prefeituras)')
  .action(() => {
    const lista = repo().listarMunicipios();
    if (!lista.length) return console.log('Nenhum município cadastrado. Use: municipio <ibge> --nome ... --perfil ... --url ...');
    console.table(lista.map((m) => ({ ibge: m.ibge, municipio: `${m.nome}${m.uf ? '/' + m.uf : ''}`, perfil: m.perfil, url: m.url, vinculos: m.vinculos, opcoes: JSON.stringify(m.opcoes) })));
  });

programa
  .command('municipio <ibge>')
  .description('cadastra/atualiza o webservice de uma prefeitura')
  .requiredOption('--nome <nome>', 'nome do município')
  .requiredOption('--perfil <perfil>', `perfil (${Object.keys(PERFIS).join(' | ')})`)
  .requiredOption('--url <url>', 'endpoint HTTPS do webservice')
  .option('--uf <uf>', 'UF')
  .option('--opcao <chave=valor...>', 'opções do envelope (ex.: soapVersao=1.2 estilo=direto janelaDias=15)')
  .action((ibge, o) => {
    if (!/^\d{7}$/.test(ibge)) throw new Error('Código IBGE deve ter 7 dígitos.');
    if (!PERFIS[o.perfil]) throw new Error(`Perfil inválido. Use: ${Object.keys(PERFIS).join(', ')}`);
    if (!o.url.startsWith('https://')) throw new Error('O webservice precisa ser HTTPS.');
    const opcoes = sanitizarOpcoes(Object.fromEntries((o.opcao ?? []).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; })));
    const r = repo();
    const m = r.salvarMunicipio({ ibge, nome: o.nome, uf: o.uf?.toUpperCase() ?? null, perfil: o.perfil, url: o.url, opcoes });
    registrarAuditoria(r.db, { tipo: 'municipio.salvo', payload: { ibge, nome: m.nome, perfil: m.perfil, url: m.url, opcoes } });
    console.log(`✔ ${m.nome} (${m.ibge}) salvo: ${m.perfil} em ${m.url}`);
  });

programa
  .command('vincular <empresa> <ibge>')
  .description('passa a consultar as notas da empresa nesta prefeitura')
  .option('--im <inscricao>', 'inscrição municipal da empresa no município')
  .option('--desativar', 'mantém o vínculo, mas sem buscar')
  .action((ref, ibge, o) => {
    const r = repo();
    const e = empresaPor(r, ref);
    if (!r.obterMunicipio(ibge)) throw new Error(`Município ${ibge} não cadastrado. Use o comando "municipio" antes.`);
    const id = r.salvarVinculo({ empresaId: e.id, ibge, inscricaoMunicipal: o.im ?? null, ativo: !o.desativar });
    registrarAuditoria(r.db, { tipo: 'vinculo.salvo', empresaCnpj: e.cnpj, payload: { vinculo_id: id, empresa_id: e.id, ibge, inscricao_municipal: o.im ?? null, ativo: !o.desativar } });
    console.log(`✔ ${e.razao_social} vinculada a ${r.obterMunicipio(ibge).nome} (vínculo #${id}).`);
  });

programa
  .command('desvincular <empresa> <ibge>')
  .description('para de consultar a empresa nesta prefeitura (as notas já baixadas continuam)')
  .action((ref, ibge) => {
    const r = repo();
    const e = empresaPor(r, ref);
    const v = r.listarVinculos({ empresaId: e.id }).find((x) => x.ibge === ibge);
    if (!v) throw new Error('Vínculo não encontrado.');
    r.excluirVinculo(v.id);
    registrarAuditoria(r.db, { tipo: 'vinculo.excluido', empresaCnpj: e.cnpj, payload: { vinculo_id: v.id, ibge, municipio: v.municipio_nome } });
    console.log(`✔ Vínculo com ${v.municipio_nome} removido.`);
  });

programa
  .command('testar-prefeitura <empresa> <ibge>')
  .description('testa URL, envelope e certificado com uma consulta mínima (não grava nada)')
  .action(async (ref, ibge) => {
    const r = repo();
    const e = empresaPor(r, ref);
    const v = r.listarVinculos({ empresaId: e.id }).find((x) => x.ibge === ibge);
    if (!v) throw new Error('Vínculo não encontrado.');
    try {
      const t = await testarVinculo(r, v.id);
      console.log(`✔ ${t.mensagem}`);
    } catch (err) {
      console.log(`✖ [${err.codigo ?? 'ERRO'}${err.subcodigo ? '/' + err.subcodigo : ''}] ${err.message}`);
      if (CATALOGO[err.codigo]?.acao) console.log(`    → ${CATALOGO[err.codigo].acao}`);
      if (err.resposta) console.log(`    Resposta da prefeitura (início): ${err.resposta.slice(0, 300)}`);
      process.exitCode = 1;
    }
  });

programa
  .command('buscar-prefeitura [empresa]')
  .description('baixa as notas das prefeituras vinculadas (uma empresa ou todas)')
  .option('--de <data>', 'AAAA-MM-DD (padrão: desde a última busca, ou 90 dias na primeira)')
  .option('--ate <data>', 'AAAA-MM-DD (padrão: hoje)')
  .action(async (ref, o) => {
    const r = repo();
    const empresaId = ref ? empresaPor(r, ref).id : undefined;
    const vinculos = r.listarVinculos({ empresaId, somenteAtivos: true });
    if (!vinculos.length) return console.log('Nenhuma prefeitura vinculada. Use os comandos "municipio" e "vincular".');
    for (const v of vinculos) {
      try {
        const x = await sincronizarMunicipal(r, v.id, { de: o.de, ate: o.ate });
        console.log(`✔ ${v.empresa_nome} — ${v.municipio_nome} [${x.codigo}]: ${x.mensagem}`);
      } catch (err) {
        console.log(`✖ ${v.empresa_nome} — ${v.municipio_nome} [${err.codigo ?? 'ERRO'}]: ${err.message}`);
        if (CATALOGO[err.codigo]?.acao) console.log(`    → ${CATALOGO[err.codigo].acao}`);
        process.exitCode = 1;
      }
    }
  });

programa
  .command('cursor <empresa> <nsu>')
  .description('redefine o cursor NSU (ex.: 0 para baixar tudo de novo)')
  .action((ref, nsu) => {
    const r = repo();
    const e = empresaPor(r, ref);
    r.salvarCursor(e.id, Number(nsu), { forcar: true });
    console.log(`Cursor de ${e.razao_social} definido em ${nsu}.`);
  });

programa
  .command('conciliar <empresa>')
  .description('(experimental) confere o portal e baixa notas que faltam')
  .option('--de <data>', 'AAAA-MM-DD (padrão: início do mês anterior)')
  .option('--ate <data>', 'AAAA-MM-DD (padrão: fim do mês anterior)')
  .action(async (ref, o) => {
    const r = repo();
    const e = empresaPor(r, ref);
    const p = mesAnterior();
    const res = await conciliarEmpresa(r, e.id, { de: o.de ?? p.de, ate: o.ate ?? p.ate });
    console.log(res.mensagem);
  });

programa
  .command('importar <empresa> <arquivos...>')
  .description('importa XMLs de NFS-e já baixados (arquivos ou pastas)')
  .action((ref, arquivos) => {
    const r = repo();
    const e = empresaPor(r, ref);
    const lista = arquivos.flatMap((a) =>
      fs.statSync(a).isDirectory()
        ? fs.readdirSync(a, { recursive: true }).filter((f) => String(f).toLowerCase().endsWith('.xml')).map((f) => path.join(a, String(f)))
        : [a],
    );
    const cont = { nova: 0, existente: 0, evento: 0 };
    for (const f of lista) {
      try {
        cont[importarXml(r, e, fs.readFileSync(f, 'utf8'))]++;
      } catch (err) {
        console.error(`✖ ${f}: ${err.message}`);
      }
    }
    console.log(`${lista.length} arquivo(s): ${cont.nova} nota(s) nova(s), ${cont.existente} já existente(s), ${cont.evento} evento(s).`);
    const v = validarDocumentos(r, { empresaId: e.id });
    console.log(`Conferência fiscal: ${v.abertas.BLOQUEANTE} bloqueante(s), ${v.abertas.ALERTA} alerta(s), ${v.abertas.INFO} informativa(s) em aberto.`);
  });

programa
  .command('exportar')
  .description('gera ZIP (XMLs + planilha) ou CSV')
  .option('-e, --empresa <empresa>', 'id ou CNPJ')
  .option('-m, --mes <AAAA-MM>', 'competência de um mês inteiro (atalho para --de/--ate)')
  .option('--de <data>', 'competência inicial AAAA-MM-DD')
  .option('--ate <data>', 'competência final AAAA-MM-DD')
  .option('-p, --papel <papel>', 'emitida | recebida | intermediario')
  .option('--pdf', 'inclui DANFSe em PDF no ZIP')
  .option('--csv', 'gera só a planilha CSV')
  .option('-o, --saida <arquivo>', 'arquivo de saída')
  .action(async (o) => {
    const r = repo();
    if (o.mes) {
      const m = String(o.mes).match(/^(\d{4})-(\d{2})$/);
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`Mês inválido: ${o.mes} (use AAAA-MM)`);
      const ultimoDia = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
      o.de = `${o.mes}-01`;
      o.ate = `${o.mes}-${String(ultimoDia).padStart(2, '0')}`;
    }
    const empresaId = o.empresa ? empresaPor(r, o.empresa).id : undefined;
    const { itens } = r.listarDocumentos({ empresaId, de: o.de, ate: o.ate, papel: o.papel, limite: 100_000 });
    if (!itens.length) return console.log('Nenhuma nota para os filtros informados.');
    const ext = o.csv ? 'csv' : 'zip';
    const saida = o.saida ?? `nfse-${o.mes ?? new Date().toISOString().slice(0, 10)}.${ext}`;
    if (path.dirname(saida)) fs.mkdirSync(path.dirname(saida), { recursive: true });
    fs.writeFileSync(saida, o.csv ? gerarCsv(itens) : await gerarZip(itens, { incluirPdf: !!o.pdf }));
    console.log(`${itens.length} nota(s) exportada(s) para ${saida}`);
  });

programa
  .command('backup')
  .description('gera um ZIP com banco, XMLs, logs e .env (funciona com o painel aberto)')
  .option('-d, --destino <pasta>', 'pasta onde salvar (padrão: ./backups)')
  .option('--sem-env', 'não inclui o .env (a NFSE_MASTER_KEY deve ser guardada à parte)')
  .option('--manter <n>', 'quantos backups manter na pasta (0 = todos)', '10')
  .action(async (o) => {
    const r = await gerarBackup({
      destino: o.destino,
      incluirEnv: !o.semEnv,
      manter: Number(o.manter),
      db: obterBanco(),
    });
    const mb = (r.tamanho / 1024 / 1024).toFixed(1);
    console.log(`✔ Backup gerado: ${r.arquivo} (${mb} MB, ${r.arquivos} arquivo(s))`);
    if (!r.incluiuEnv) console.log('⚠ O .env NÃO foi incluído: guarde a NFSE_MASTER_KEY em local seguro.');
    if (r.removidos.length) console.log(`  ${r.removidos.length} backup(s) antigo(s) removido(s).`);
  });

const PASTA_BACKUPS = path.resolve('backups');

programa
  .command('backups')
  .description('lista os backups da pasta ./backups (mais novo primeiro)')
  .option('-d, --pasta <pasta>', 'outra pasta de backups', PASTA_BACKUPS)
  .action((o) => {
    const lista = listarBackups(o.pasta);
    if (!lista.length) return console.log(`Nenhum backup encontrado em ${o.pasta}`);
    lista.forEach((b, i) => console.log(`  [${i + 1}] ${b.nome}  (${(b.tamanho / 1024 / 1024).toFixed(1)} MB)`));
  });

programa
  .command('restaurar <backup>')
  .description('restaura um backup (caminho do ZIP ou número da lista "backups"); exige --sim')
  .option('--sim', 'confirma a restauração (sem isso, só mostra o que seria feito)')
  .action(async (ref, o) => {
    let arquivo = ref;
    if (/^\d+$/.test(ref) && !fs.existsSync(ref)) {
      const item = listarBackups(PASTA_BACKUPS)[Number(ref) - 1];
      if (!item) throw new Error(`Não existe o backup número ${ref} em ${PASTA_BACKUPS}`);
      arquivo = item.arquivo;
    }
    const plano = await analisarBackup(arquivo);
    console.log(`Backup: ${arquivo}`);
    console.log(`  ${plano.dados.length + 1} arquivo(s) de dados; .env ${plano.env !== null ? 'incluído' : 'NÃO incluído'}`);
    if (!o.sim) {
      console.log('Nada foi alterado. Para restaurar de verdade, repita com --sim.');
      process.exitCode = 2;
      return;
    }
    const r = await restaurarBackup(arquivo);
    console.log(`✔ Restaurado: ${r.empresas} empresa(s), ${r.documentos} nota(s).`);
    if (r.dataAnterior) console.log(`  Dados anteriores preservados em: ${r.dataAnterior}`);
    if (r.envAnterior) console.log(`  .env anterior preservado em: ${r.envAnterior}`);
    if (r.certificadosSemChave.length) {
      console.log(`⚠ A NFSE_MASTER_KEY atual NÃO abre o certificado de: ${r.certificadosSemChave.join(', ')}.`);
      console.log('  Coloque no .env a chave da época do backup, ou cadastre esses certificados de novo no painel.');
      process.exitCode = 3;
    }
  });

programa
  .command('agendar')
  .description('fica rodando e executa as buscas conforme NFSE_ADN_CRON / NFSE_SCHEDULE_CRON')
  .action(() => {
    iniciarAgendador(repo());
    console.log('Agendador ativo. Ctrl+C para sair.');
  });

programa.parseAsync().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
