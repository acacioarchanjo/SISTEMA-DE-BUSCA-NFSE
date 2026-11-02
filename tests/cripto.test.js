import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cifrar, decifrar, carregarChave, ErroCofre } from '../src/crypto/cofre.js';
import { lerCertificado, ErroCertificado } from '../src/crypto/certificado.js';
import { cadastrarEmpresa, abrirCredenciais } from '../src/crypto/credenciais.js';
import { ambienteTeste, gerarPfx, CNPJ_TESTE, limpar } from './ajuda.js';

test('cofre: cifra e decifra (AES-256-GCM)', () => {
  const chave = crypto.randomBytes(32);
  const blob = cifrar(Buffer.from('segredo'), chave);
  assert.match(blob, /^v1:/);
  assert.equal(decifrar(blob, chave).toString(), 'segredo');
  assert.notEqual(cifrar('x', chave), cifrar('x', chave), 'IV aleatório');
});

test('cofre: chave errada ou dado adulterado falham', () => {
  const blob = cifrar('segredo', crypto.randomBytes(32));
  assert.throws(() => decifrar(blob, crypto.randomBytes(32)), ErroCofre);
  const chave = crypto.randomBytes(32);
  const b = cifrar('segredo', chave);
  const adulterado = b.slice(0, -4) + (b.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => decifrar(adulterado, chave), ErroCofre);
});

test('cofre: valida a chave mestra', () => {
  assert.throws(() => carregarChave(''), ErroCofre);
  assert.throws(() => carregarChave('COLE_AQUI_UMA_CHAVE'), ErroCofre);
  assert.throws(() => carregarChave(Buffer.alloc(16).toString('base64')), /32 bytes/);
  assert.equal(carregarChave(crypto.randomBytes(32).toString('base64')).length, 32);
});

test('certificado: lê CNPJ do SAN ICP-Brasil e gera PEM', () => {
  const info = lerCertificado(gerarPfx({ cn: 'EMPRESA SEM CNPJ NO CN' }), '1234');
  assert.equal(info.cnpj, CNPJ_TESTE);
  assert.equal(info.cpf, '12345678909');
  assert.match(info.chavePem, /BEGIN RSA PRIVATE KEY/);
  assert.match(info.certPem, /BEGIN CERTIFICATE/);
});

test('certificado: fallback do CNPJ pelo CN e senha errada', () => {
  const pfx = gerarPfx({ comSan: false });
  assert.equal(lerCertificado(pfx, '1234').cnpj, CNPJ_TESTE);
  assert.equal(lerCertificado(pfx, '1234').nome, 'EMPRESA TESTE LTDA');
  assert.throws(() => lerCertificado(pfx, 'errada'), ErroCertificado);
});

test('credenciais: cadastra empresa cifrando o pfx e reabre', () => {
  const { repo, dataDir } = ambienteTeste();
  try {
    const r = cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234' });
    assert.equal(r.cnpj, CNPJ_TESTE);
    const bruto = repo.obterCredenciais(r.id);
    assert.match(bruto.cert_cifrado, /^v1:/);
    assert.ok(!('cert_cifrado' in repo.obterEmpresa(r.id)), 'API pública não expõe o certificado');
    const cred = abrirCredenciais(repo, r.id);
    assert.match(cred.key, /PRIVATE KEY/);
    assert.equal(cred.cnpj, CNPJ_TESTE);

    assert.throws(() => cadastrarEmpresa(repo, { pfx: gerarPfx(), senha: '1234', cnpj: '04252011000110' }), /pertence ao CNPJ/);
    assert.throws(() => cadastrarEmpresa(repo, { pfx: gerarPfx({ vencido: true }), senha: '1234' }), /vencido/);
  } finally {
    limpar(dataDir);
  }
});
