// Linha de comando: npm run cli -- <comando>
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { obterBanco } from '../db/index.js';
import { Repositorio } from '../db/repositorio.js';
import { cadastrarEmpresa } from '../crypto/credenciais.js';
import { lerCertificado } from '../crypto/certificado.js';
import { sincronizarEmpresa, sincronizarTodas, importarXml } from '../adn/distribuicao.js';
import { conciliarEmpresa, mesAnterior } from '../portal/conciliacao.js';
import { gerarZip } from '../exportador/zip.js';
import { gerarCsv } from '../exportador/planilha.js';
import { iniciarAgendador } from '../agendador.js';
import { gerarBackup } from '../backup.js';
import { restaurarBackup, listarBackups, analisarBackup } from '../restaurar.js';
import { formatarCnpj, somenteDigitos } from '../util/formatos.js';

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
      const resultados = await sincronizarTodas(r, { ignorarTrava: o.ignorarTrava });
      if (!resultados.length) console.log('Nenhuma empresa ativa cadastrada.');
      for (const x of resultados) console.log(`${x.ok ? '✔' : '✖'} ${x.empresa}: ${x.mensagem}`);
      // código de saída ≠ 0 se alguma empresa falhou (aparece no Agendador de Tarefas)
      if (resultados.some((x) => !x.ok)) process.exitCode = 1;
      return;
    }
    const e = empresaPor(r, ref);
    const res = await sincronizarEmpresa(r, e.id, {
      ignorarTrava: o.ignorarTrava,
      aoProgredir: (p) => process.stdout.write(`\r  lote ${p.lotes} | NSU ${p.ultimoNsu} | novas ${p.novos} | eventos ${p.eventos}   `),
    });
    console.log(`\n✔ ${e.razao_social}: ${res.mensagem}`);
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
