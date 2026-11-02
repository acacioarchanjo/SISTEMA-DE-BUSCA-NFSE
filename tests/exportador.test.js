import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { gerarCsv } from '../src/exportador/planilha.js';
import { gerarZip } from '../src/exportador/zip.js';
import { gerarDanfse } from '../src/exportador/danfse.js';
import { registrarNfse, registrarEvento } from '../src/adn/distribuicao.js';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { parseNfse } from '../src/nfse/parser.js';
import { ambienteTeste, gerarPfx, fixture, xmlRecebida, CHAVE_TESTE, CNPJ_TESTE, limpar } from './ajuda.js';

function preparar() {
  const amb = ambienteTeste();
  const { id } = cadastrarEmpresa(amb.repo, { pfx: gerarPfx(), senha: '1234' });
  const empresa = amb.repo.obterEmpresa(id);
  registrarNfse(amb.repo, empresa, { xml: fixture('nfse-exemplo.xml'), nsu: 1 });
  registrarNfse(amb.repo, empresa, { xml: xmlRecebida(), nsu: 2 });
  registrarEvento(amb.repo, empresa, { xml: fixture('evento-cancelamento.xml'), nsu: 3 });
  return { ...amb, id };
}

test('CSV: BOM, separador ; e decimais com vírgula, sem injeção de fórmula', () => {
  const csv = gerarCsv([{ ...parseNfse(fixture('nfse-exemplo.xml')), empresa_cnpj: CNPJ_TESTE, papel: 'emitida', situacao: 'normal', descricao: '=HYPERLINK("x")' }]);
  assert.ok(csv.startsWith('﻿'));
  const [cab, linha] = csv.slice(1).split('\r\n');
  assert.ok(cab.startsWith('Empresa (CNPJ);Papel;'));
  assert.ok(linha.includes(';10000,00;'));
  assert.ok(linha.includes('"\'=HYPERLINK(""x"")"'));
});

test('ZIP: XMLs organizados por empresa/papel/competência + planilha', async () => {
  const { repo, dataDir, id } = preparar();
  try {
    const { itens } = repo.listarDocumentos({ empresaId: id });
    const zip = await JSZip.loadAsync(await gerarZip(itens, { incluirPdf: true, dataDir }));
    const nomes = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    assert.ok(nomes.includes(`${CNPJ_TESTE}/emitidas/2026-03/canceladas/${CHAVE_TESTE}.xml`), nomes.join('\n'));
    assert.ok(nomes.some((n) => n.startsWith(`${CNPJ_TESTE}/recebidas/2026-03/`) && n.endsWith('.xml')));
    assert.ok(nomes.some((n) => n.endsWith('.pdf')));
    assert.ok(nomes.includes('planilha-nfse.csv'));
    assert.match(await zip.file(`${CNPJ_TESTE}/emitidas/2026-03/canceladas/${CHAVE_TESTE}.xml`).async('string'), /infNFSe/);
  } finally {
    limpar(dataDir);
  }
});

test('DANFSe: gera PDF válido', async () => {
  const pdf = await gerarDanfse({ ...parseNfse(fixture('nfse-exemplo.xml')), situacao: 'cancelada' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 2000);
});
