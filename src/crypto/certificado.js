// Leitura do certificado digital A1 (.pfx / PKCS#12) com node-forge.
// Converte para PEM (chave + cadeia) — evita problemas do OpenSSL 3 com PFX
// antigos (RC2-40/3DES), muito comuns em certificados ICP-Brasil.
import forge from 'node-forge';
import { somenteDigitos } from '../util/formatos.js';

// OIDs ICP-Brasil gravados no subjectAltName (otherName)
const OID_CNPJ = '2.16.76.1.3.3';
const OID_CPF_TITULAR_PJ = '2.16.76.1.3.4'; // dados do responsável (data nasc + CPF ...)
const OID_CPF_PF = '2.16.76.1.3.1'; // e-CPF: data nasc (8) + CPF (11) + ...

export class ErroCertificado extends Error {}

function textoDoNo(no) {
  if (!no) return '';
  if (typeof no.value === 'string') return no.value;
  if (Array.isArray(no.value)) return no.value.map(textoDoNo).join('');
  return '';
}

/** Percorre a árvore ASN.1 procurando valores associados a OIDs otherName. */
function extrairOtherNames(asn1, saida = {}) {
  if (!asn1 || !Array.isArray(asn1.value)) return saida;
  const filhos = asn1.value;
  for (let i = 0; i < filhos.length; i++) {
    const f = filhos[i];
    if (f.type === forge.asn1.Type.OID && typeof f.value === 'string') {
      const oid = forge.asn1.derToOid(f.value);
      const prox = filhos[i + 1];
      if (prox) saida[oid] = textoDoNo(prox);
    } else {
      extrairOtherNames(f, saida);
    }
  }
  return saida;
}

function extrairDocumento(cert) {
  const ext = cert.extensions.find((e) => e.name === 'subjectAltName');
  let cnpj = null;
  let cpf = null;
  if (ext?.value) {
    try {
      const nomes = extrairOtherNames(forge.asn1.fromDer(ext.value));
      if (nomes[OID_CNPJ]) cnpj = somenteDigitos(nomes[OID_CNPJ]).slice(0, 14);
      if (nomes[OID_CPF_PF]) cpf = somenteDigitos(nomes[OID_CPF_PF]).slice(8, 19);
      else if (nomes[OID_CPF_TITULAR_PJ]) cpf = somenteDigitos(nomes[OID_CPF_TITULAR_PJ]).slice(8, 19);
    } catch {
      /* SAN ilegível — tenta pelo CN abaixo */
    }
  }
  // Fallback: CN no formato "RAZAO SOCIAL:12345678000199"
  const cn = cert.subject.getField('CN')?.value ?? '';
  if (!cnpj) {
    const m = cn.match(/:(\d{14})\s*$/);
    if (m) cnpj = m[1];
  }
  if (!cnpj && !cpf) {
    const m = cn.match(/:(\d{11})\s*$/);
    if (m) cpf = m[1];
  }
  const nome = cn.replace(/:\d{11,14}\s*$/, '').trim();
  return { cnpj, cpf, nome, cn };
}

/**
 * Abre um .pfx e devolve chave/cadeia em PEM + metadados.
 * @param {Buffer} pfx
 * @param {string} senha
 */
export function lerCertificado(pfx, senha) {
  let p12;
  try {
    const der = forge.util.createBuffer(pfx.toString('binary'));
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, senha ?? '');
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/password|MAC|Invalid/i.test(msg)) {
      throw new ErroCertificado('Senha do certificado incorreta (ou arquivo .pfx inválido).');
    }
    throw new ErroCertificado(`Não foi possível ler o certificado: ${msg}`);
  }

  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ].filter((b) => b.key);
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
    .map((b) => b.cert)
    .filter(Boolean);

  if (!chaves.length) throw new ErroCertificado('O .pfx não contém chave privada.');
  if (!certs.length) throw new ErroCertificado('O .pfx não contém certificado.');

  const chave = chaves[0].key;
  // Certificado folha = o que casa com a chave privada
  const folha =
    certs.find((c) => c.publicKey?.n && chave.n && c.publicKey.n.equals(chave.n)) ?? certs[0];
  const cadeia = [folha, ...certs.filter((c) => c !== folha)];

  const doc = extrairDocumento(folha);
  return {
    ...doc,
    emissor: folha.issuer.getField('CN')?.value ?? '',
    numeroSerie: folha.serialNumber,
    validoDe: folha.validity.notBefore.toISOString(),
    validoAte: folha.validity.notAfter.toISOString(),
    chavePem: forge.pki.privateKeyToPem(chave),
    certPem: cadeia.map((c) => forge.pki.certificateToPem(c)).join(''),
  };
}

export function certificadoVencido(info, agora = new Date()) {
  return new Date(info.validoAte) < agora;
}

export function diasParaVencer(validoAte, agora = new Date()) {
  return Math.floor((new Date(validoAte) - agora) / 86_400_000);
}
