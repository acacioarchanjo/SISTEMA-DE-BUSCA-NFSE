// Utilitários de teste: ambiente temporário, certificado A1 de teste e fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import { config } from '../src/config.js';
import { abrirBanco } from '../src/db/index.js';
import { Repositorio } from '../src/db/repositorio.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (nome) => fs.readFileSync(path.join(DIR, 'fixtures', nome), 'utf8');

export const CNPJ_TESTE = '11222333000181';
export const CNPJ_CLIENTE = '04252011000110';
export const CHAVE_TESTE = '35503082112223330001810000000000001226030000000001';

/** Configura chave mestra + diretório de dados temporários e devolve repo em memória. */
export function ambienteTeste() {
  config.masterKey = crypto.randomBytes(32).toString('base64');
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-teste-'));
  const db = abrirBanco(':memory:');
  return { repo: new Repositorio(db), db, dataDir: config.dataDir };
}

/** Monta o SAN com otherName ICP-Brasil (OID 2.16.76.1.3.3 = CNPJ). */
function sanIcpBrasil(cnpj) {
  const { asn1 } = forge;
  const otherName = (oid, valor) =>
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oid).getBytes()),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, valor),
      ]),
    ]);
  const seq = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    otherName('2.16.76.1.3.4', '01011980' + '12345678909' + '0'.repeat(25)),
    otherName('2.16.76.1.3.3', cnpj),
  ]);
  return asn1.toDer(seq).getBytes();
}

let chavesCache;
/** Gera um .pfx (Buffer) de teste. */
export function gerarPfx({ cnpj = CNPJ_TESTE, senha = '1234', comSan = true, cn, vencido = false, algoritmo = '3des' } = {}) {
  chavesCache ??= forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = chavesCache.publicKey;
  cert.serialNumber = '01' + crypto.randomBytes(6).toString('hex');
  const agora = new Date();
  cert.validity.notBefore = new Date(agora.getTime() - (vencido ? 400 : 1) * 86_400_000);
  cert.validity.notAfter = new Date(agora.getTime() + (vencido ? -1 : 365) * 86_400_000);
  const attrs = [
    { name: 'commonName', value: cn ?? `EMPRESA TESTE LTDA:${cnpj}` },
    { name: 'organizationName', value: 'ICP-Brasil' },
    { name: 'countryName', value: 'BR' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer([{ name: 'commonName', value: 'AC TESTE' }]);
  const exts = [{ name: 'basicConstraints', cA: false }];
  if (comSan) exts.push({ id: '2.5.29.17', value: sanIcpBrasil(cnpj) });
  cert.setExtensions(exts);
  cert.sign(chavesCache.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(chavesCache.privateKey, [cert], senha, { algorithm: algoritmo });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

/** Versão "recebida" da nota exemplo (empresa de teste como tomadora). */
export function xmlRecebida() {
  return fixture('nfse-exemplo.xml')
    .replaceAll(CNPJ_TESTE, '99888777000100')
    .replace(CNPJ_CLIENTE, CNPJ_TESTE); // a chave muda junto, pois contém o CNPJ do emitente
}

export function limpar(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
