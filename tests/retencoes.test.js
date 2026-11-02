import test from 'node:test';
import assert from 'node:assert/strict';
import { criarServidor } from '../src/server/app.js';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { consolidarRetencoes, gerarCsvRetencoes } from '../src/fiscal/retencoes.js';
import { ambienteTeste, gerarPfx, limpar, CNPJ_TESTE } from './ajuda.js';

const PJ_A = '04252011000110';
const PJ_B = '11444777000161';
const PF = '52998224725';

function popular(repo, empresaId) {
  let n = 0;
  const nota = (o) => repo.salvarDocumento({
    empresa_id: empresaId, chave: `CH${++n}`, numero: String(100 + n), origem: 'adn', sistema: 'adn', papel: 'recebida', situacao: 'normal',
    competencia: '2026-09-15', data_emissao: '2026-09-15', prestador_doc: PJ_A, prestador_nome: 'Limpeza A Ltda',
    tomador_doc: CNPJ_TESTE, valor_servico: 1000, valor_iss: 50, iss_retido: 0, valor_pis: 0, valor_cofins: 0, pis_cofins_retido: 0,
    valor_csll: 0, valor_irrf: 0, valor_inss: 0, ...o,
  });
  nota({ valor_irrf: 15, valor_csll: 10, valor_pis: 6.5, valor_cofins: 30, pis_cofins_retido: 1, valor_inss: 110 }); // PJ A: federais + INSS
  nota({ valor_irrf: 15, iss_retido: 1 });                                                                         // PJ A: IRRF + ISS
  nota({ prestador_doc: PJ_B, prestador_nome: 'Consultoria B', iss_retido: 1 });                                  // PJ B: só ISS
  nota({ prestador_doc: PF, prestador_nome: 'Fulano', valor_irrf: 75 });                                          // PF: IRRF → R-4010
  nota({ valor_pis: 6.5, valor_cofins: 30, pis_cofins_retido: 0 });                                               // PIS/COFINS NÃO retidos
  nota({ valor_irrf: 99, situacao: 'cancelada' });                                                                 // cancelada: fora
  nota({ valor_irrf: 99, papel: 'emitida', prestador_doc: CNPJ_TESTE });                                           // prestada: fora do relatório
  nota({ valor_irrf: 20, competencia: '2026-10-02' });                                                             // outro mês
}

test('retenções: consolidação por fornecedor e mês, com eventos R-4020/R-4010/R-2010', () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    popular(repo, id);
    const { linhas, totais } = consolidarRetencoes(repo.db, { empresaId: id, de: '2026-09', ate: '2026-09' });
    const por = Object.fromEntries(linhas.map((l) => [l.beneficiario_doc, l]));
    assert.deepEqual(Object.keys(por).sort(), [PJ_A, PJ_B, PF].sort(), 'canceladas, prestadas, sem retenção e outro mês ficam fora');
    assert.equal(por[PJ_A].notas, 2);
    assert.equal(por[PJ_A].ret_irrf, 30);
    assert.equal(por[PJ_A].ret_csrf, 46.5);
    assert.equal(por[PJ_A].ret_inss, 110);
    assert.equal(por[PJ_A].ret_iss, 50);
    assert.deepEqual(por[PJ_A].eventos_reinf, ['R-4020', 'R-2010']);
    assert.deepEqual(por[PF].eventos_reinf, ['R-4010']);
    assert.equal(por[PF].beneficiario_tipo, 'PF');
    assert.deepEqual(por[PJ_B].eventos_reinf, [], 'só ISS retido não gera Reinf');
    assert.equal(totais.ret_irrf, 105);
    assert.equal(totais.ret_pis, 6.5, 'PIS não retido não entra');
    assert.equal(totais.beneficiarios, 3);
    assert.equal(totais.r4000, 2);
    assert.equal(totais.r2010, 1);

    const outubro = consolidarRetencoes(repo.db, { empresaId: id, de: '2026-10', ate: '2026-10' });
    assert.equal(outubro.totais.ret_irrf, 20);
    assert.throws(() => consolidarRetencoes(repo.db, { de: '09/2026' }), /AAAA-MM/);

    const csv = gerarCsvRetencoes(consolidarRetencoes(repo.db, { empresaId: id, de: '2026-09', ate: '2026-09' }));
    assert.ok(csv.startsWith('﻿'));
    assert.match(csv, /R-4020 \+ R-2010/);
    assert.match(csv, /529\.982\.247-25;PF/);
    assert.match(csv, /data do pagamento/);
  } finally {
    limpar(dataDir);
  }
});

test('retenções: filtros de 1 clique na listagem e API do relatório', async () => {
  const amb = ambienteTeste();
  const srv = criarServidor(amb.repo, { dataDir: amb.dataDir, sincronizar: async () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (c) => {
    const r = await fetch(base + c, { headers: { 'X-Buscador': '1' } });
    const tipo = r.headers.get('content-type') ?? '';
    return { status: r.status, tipo, dados: tipo.includes('json') ? await r.json() : await r.text() };
  };
  try {
    const { id } = cadastrarEmpresa(amb.repo, { pfx: gerarPfx(), senha: '1234' });
    popular(amb.repo, id);
    const qtd = async (ret) => (await get(`/api/documentos?empresa=${id}&retencao=${ret}`)).dados.totais.quantidade;
    assert.equal(await qtd('qualquer'), 7);
    assert.equal(await qtd('iss'), 2);
    assert.equal(await qtd('irrf'), 6);
    assert.equal(await qtd('csrf'), 1, 'PIS/COFINS só contam quando retidos');
    assert.equal(await qtd('inss'), 1);
    assert.equal(await qtd('federal'), 6);
    assert.equal(await qtd('nenhuma'), 1);
    const tot = (await get(`/api/documentos?empresa=${id}&retencao=federal&situacao=normal&papel=recebida`)).dados.totais;
    assert.equal(tot.ret_irrf, 125);
    assert.equal(tot.ret_inss, 110);
    assert.equal((await get('/api/documentos?retencao=xpto')).status, 400);

    const rel = await get(`/api/retencoes?empresa=${id}&de=2026-09&ate=2026-09`);
    assert.equal(rel.status, 200);
    assert.equal(rel.dados.linhas.length, 3);
    assert.equal((await get('/api/retencoes?de=2026-9')).status, 400);
    const csv = await get(`/api/exportar/retencoes?empresa=${id}&de=2026-09&ate=2026-09`);
    assert.match(csv.tipo, /text\/csv/);
    assert.match(csv.dados, /Limpeza A Ltda/);
  } finally {
    srv.close();
    limpar(amb.dataDir);
  }
});
