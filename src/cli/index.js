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
      for (const x of await sincronizarTodas(r, { ignorarTrava: o.ignorarTrava })) console.log(`${x.ok ? '✔' : '✖'} ${x.empresa}: ${x.mensagem}`);
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
  .option('--de <data>', 'competência inicial AAAA-MM-DD')
  .option('--ate <data>', 'competência final AAAA-MM-DD')
  .option('-p, --papel <papel>', 'emitida | recebida | intermediario')
  .option('--pdf', 'inclui DANFSe em PDF no ZIP')
  .option('--csv', 'gera só a planilha CSV')
  .option('-o, --saida <arquivo>', 'arquivo de saída')
  .action(async (o) => {
    const r = repo();
    const empresaId = o.empresa ? empresaPor(r, o.empresa).id : undefined;
    const { itens } = r.listarDocumentos({ empresaId, de: o.de, ate: o.ate, papel: o.papel, limite: 100_000 });
    if (!itens.length) return console.log('Nenhuma nota para os filtros informados.');
    const ext = o.csv ? 'csv' : 'zip';
    const saida = o.saida ?? `nfse-${new Date().toISOString().slice(0, 10)}.${ext}`;
    fs.writeFileSync(saida, o.csv ? gerarCsv(itens) : await gerarZip(itens, { incluirPdf: !!o.pdf }));
    console.log(`${itens.length} nota(s) exportada(s) para ${saida}`);
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
