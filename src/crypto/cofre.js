// Cofre: cifra/decifra dados sensíveis (certificado .pfx e senha) com AES-256-GCM.
// Formato do blob: "v1:" + base64( iv(12) | tag(16) | ciphertext )
import crypto from 'node:crypto';
import { config } from '../config.js';

const VERSAO = 'v1:';

export class ErroCofre extends Error {}

export function carregarChave(chaveBase64 = config.masterKey) {
  if (!chaveBase64 || chaveBase64.startsWith('COLE_AQUI')) {
    throw new ErroCofre(
      'NFSE_MASTER_KEY não configurada. Gere com: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const chave = Buffer.from(chaveBase64, 'base64');
  if (chave.length !== 32) {
    throw new ErroCofre(`NFSE_MASTER_KEY deve ter 32 bytes em base64 (tem ${chave.length}).`);
  }
  return chave;
}

export function cifrar(dados, chave = carregarChave()) {
  const buf = Buffer.isBuffer(dados) ? dados : Buffer.from(String(dados), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return VERSAO + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decifrar(blob, chave = carregarChave()) {
  if (typeof blob !== 'string' || !blob.startsWith(VERSAO)) {
    throw new ErroCofre('Formato de dado cifrado desconhecido.');
  }
  const raw = Buffer.from(blob.slice(VERSAO.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', chave, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new ErroCofre('Falha ao decifrar: NFSE_MASTER_KEY incorreta ou dado corrompido.');
  }
}

export const decifrarTexto = (blob, chave) => decifrar(blob, chave).toString('utf8');
