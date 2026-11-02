import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { salvarXmlNfse } from '../src/nfse/armazenamento.js';
import { gerarPacoteDominio, nomePasta } from '../src/exportador/dominio.js';
import { criarServidor } from '../src/server/app.js';
import { ambienteTeste, gerarPfx, limpar, CNPJ_TESTE } from './ajuda.js';

function popular(repo, dataDir, empresaId) {
  let n = 0;
  const nota = (o) => {
    const chave = o.chave ?? `CH${++n}`;
    const competencia = o.competencia ?? '2026-09-10';
    const xml_path = o.semXml ? null : salvarXmlNfse({ cnpj: CNPJ_TESTE, competencia, chave, xml: `<NFSe id="${chave}"/>` }, dataDir);
    repo.salvarDocumento({
      empresa_id: empresaId, chave, numero: String(n), origem: 'adn', sistema: 'adn', papel: 'recebida', situacao: 'normal',
      competencia, prestador_doc: '04252011000110', tomador_doc: CNPJ_TESTE, valor_servico: 1000, valor_iss: 50,
      iss_retido: 0, valor_irrf: 0, valor_pis: 0, valor_cofins: 0, pis_cofins_retido: 0, valor_csll: 0, valor_inss: 0, xml_path, ...o,
    });
  };
  nota({ iss_retido: 1, valor_irrf: 15 });                                        // tomada nacional
  nota({ valor_pis: 6.5, valor_cofins: 30, pis_cofins_retido: 1 });                // tomada nacional
  nota({ chave: 'NFSM-3509502-04252011000110-77', origem: 'prefeitura', sistema: 'abrasf', municipio_gerador: '3509502', municipio_emissao: 'Campinas' }); // tomada municipal
  nota({ papel: 'emitida', prestador_doc: CNPJ_TESTE, tomador_doc: '04252011000110' });  // prestada
  nota({ situacao: 'cancelada', valor_irrf: 999 });                                 // cancelada: fora da importação e dos totais
  nota({ competencia: '2026-10-05' });                                              // outro mês
  nota({ semXml: true });                                                           // XML ausente
}

test('Domínio: pacote separa empresa/mês/tipo/padrão, isola canceladas e traz a conferência', async () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    popular(repo, dataDir, id);
    const { itens } = repo.listarDocumentos({ empresaId: id, limite: 1000 });
    const { buffer, grupos, faltando } = await gerarPacoteDominio(itens, { dataDir });
    const zip = await JSZip.loadAsync(buffer);
    const arquivos = Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort();
    const emp = arquivos.find((f) => f.endsWith('.xml')).split('/')[0];
    assert.match(emp, new RegExp(`^${CNPJ_TESTE} - `));
    const em = (mes, resto) => arquivos.filter((f) => f.startsWith(`${emp}/${mes}/${resto}`));
    assert.equal(em('2026-09', '1-servicos-tomados/padrao-nacional/').length, 2);
    assert.deepEqual(em('2026-09', '1-servicos-tomados/municipal-3509502-Campinas/'), [`${emp}/2026-09/1-servicos-tomados/municipal-3509502-Campinas/NFSM-3509502-04252011000110-77.xml`]);
    assert.equal(em('2026-09', '2-servicos-prestados/padrao-nacional/').length, 1);
    assert.equal(em('2026-09', 'NAO-IMPORTAR-canceladas-substituidas/').length, 1);
    assert.equal(em('2026-10', '1-servicos-tomados/padrao-nacional/').length, 1);
    assert.ok(arquivos.includes('LEIA-ME.txt') && arquivos.includes('conferencia-dominio.csv') && arquivos.includes('XML-AUSENTES.txt'));
    assert.equal(faltando.length, 1);
    assert.equal(await zip.file(`${emp}/2026-09/1-servicos-tomados/municipal-3509502-Campinas/NFSM-3509502-04252011000110-77.xml`).async('string'), '<NFSe id="NFSM-3509502-04252011000110-77"/>', 'XML original, sem alteração');

    const nac = grupos.find((g) => g.mes === '2026-09' && g.papel === 'recebida' && g.padrao === 'padrao-nacional');
    assert.equal(nac.notas, 2, 'nota sem XML não entra na conferência');
    assert.equal(nac.issRet, 50);
    assert.equal(nac.irrf, 15);
    assert.equal(nac.pis, 6.5);
    const csv = await zip.file('conferencia-dominio.csv').async('string');
    assert.ok(csv.startsWith('﻿'));
    assert.match(csv, /09\/2026;Tomadas;padrao-nacional;2;2000,00;100,00;50,00;15,00;6,50;30,00;0,00;0,00/);
    assert.doesNotMatch(csv, /999/, 'cancelada fora dos totais');
  } finally {
    limpar(dataDir);
  }
});

test('Domínio: nome de pasta seguro no Windows e rota da API', async () => {
  assert.equal(nomePasta('INSTITUTO HÁ ESPERANÇA: <Filial>/SP.'), 'INSTITUTO HA ESPERANCA Filial SP');
  assert.equal(nomePasta(''), 'sem-nome');
  const amb = ambienteTeste();
  const srv = criarServidor(amb.repo, { dataDir: amb.dataDir, sincronizar: async () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { id } = cadastrarEmpresa(amb.repo, { pfx: gerarPfx(), senha: '1234' });
    const url = `http://127.0.0.1:${srv.address().port}/api/exportar/dominio?empresa=${id}`;
    assert.equal((await fetch(url, { headers: { 'X-Buscador': '1' } })).status, 404, 'sem notas');
    popular(amb.repo, amb.dataDir, id);
    const r = await fetch(url, { headers: { 'X-Buscador': '1' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /zip/);
    const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
    assert.ok(zip.file('LEIA-ME.txt'));
  } finally {
    srv.close();
    limpar(amb.dataDir);
  }
});
