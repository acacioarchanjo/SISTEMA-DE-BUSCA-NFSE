import test from 'node:test';
import assert from 'node:assert/strict';
import { extrairChaves, mesAnterior, conciliarEmpresa } from '../src/portal/conciliacao.js';
import { cadastrarEmpresa } from '../src/crypto/credenciais.js';
import { ambienteTeste, gerarPfx, fixture, CHAVE_TESTE, limpar } from './ajuda.js';

const OUTRA = '3'.repeat(50);

test('portal: extrai chaves de 50 dígitos do HTML da listagem', () => {
  const html = `<table><tr><td><a href="/EmissorNacional/Notas/Download/NFSe/${CHAVE_TESTE}">XML</a></td></tr>
    <tr><td data-chave="${OUTRA}">x</td></tr><tr><td>123456</td></tr></table>`;
  assert.deepEqual(extrairChaves(html).sort(), [OUTRA, CHAVE_TESTE].sort());
});

test('portal: mês anterior', () => {
  assert.deepEqual(mesAnterior(new Date(2026, 0, 15)), { de: '2025-12-01', ate: '2025-12-31' });
  assert.deepEqual(mesAnterior(new Date(2026, 2, 3)), { de: '2026-02-01', ate: '2026-02-28' });
});

test('conciliação: baixa só as chaves que faltam no banco', async () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const { id } = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    const sessao = {
      entrar: async () => {},
      listarChaves: async (tipo) => (tipo === 'Emitidas' ? [CHAVE_TESTE] : [OUTRA]),
      baixarXml: async (c) => (c === CHAVE_TESTE ? fixture('nfse-exemplo.xml') : null),
    };
    const clienteSefin = { consultarNfse: async () => null, fechar() {} };
    const r = await conciliarEmpresa(repo, id, { de: '2026-03-01', ate: '2026-03-31' }, { sessao, clienteSefin, intervaloMs: 0 });
    assert.equal(r.noPortal, 2);
    assert.equal(r.baixadas, 1);
    assert.equal(r.falhas.length, 1);
    assert.equal(repo.listarDocumentos({ empresaId: id }).itens[0].origem, 'conciliacao');

    const r2 = await conciliarEmpresa(repo, id, { de: '2026-03-01', ate: '2026-03-31' }, { sessao, clienteSefin, intervaloMs: 0 });
    assert.deepEqual(r2.faltantes, [OUTRA]);
  } finally {
    limpar(dataDir);
  }
});
