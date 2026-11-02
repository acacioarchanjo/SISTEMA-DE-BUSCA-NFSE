// Assinatura XMLDSig (enveloped) das consultas, para municípios que exigem consulta assinada.
// Padrão ABRASF: RSA-SHA1, C14N inclusiva, Reference URI="" (documento inteiro), certificado em KeyInfo.
import { SignedXml } from 'xml-crypto';

const ALG = {
  sha1: { assinatura: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', digest: 'http://www.w3.org/2000/09/xmldsig#sha1' },
  sha256: { assinatura: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', digest: 'http://www.w3.org/2001/04/xmlenc#sha256' },
};
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/** Primeiro certificado (folha) de um PEM com a cadeia. */
const certificadoFolha = (pem) => (String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/) ?? [pem])[0];

/**
 * Assina o elemento raiz `elemento` do XML e devolve o XML assinado (Signature como último filho).
 * @param {string} xml
 * @param {{cert:string, key:string}} cred PEMs do certificado A1
 * @param {{elemento:string, algoritmo?:'sha1'|'sha256'}} opcoes
 */
export function assinarXml(xml, cred, { elemento, algoritmo = 'sha1' }) {
  const alg = ALG[algoritmo] ?? ALG.sha1;
  const sig = new SignedXml({
    privateKey: cred.key,
    publicCert: certificadoFolha(cred.cert),
    signatureAlgorithm: alg.assinatura,
    canonicalizationAlgorithm: C14N,
  });
  const caminho = `/*[local-name(.)='${elemento}']`;
  sig.addReference({ xpath: caminho, transforms: [ENVELOPED, C14N], digestAlgorithm: alg.digest, isEmptyUri: true });
  sig.computeSignature(xml, { location: { reference: caminho, action: 'append' } });
  return sig.getSignedXml();
}

/** Confere a assinatura (usado nos testes e no diagnóstico). */
export function verificarAssinatura(xmlAssinado, certPem) {
  const assinatura = xmlAssinado.match(/<(?:\w+:)?Signature[\s\S]*<\/(?:\w+:)?Signature>/)?.[0];
  if (!assinatura) return false;
  const sig = new SignedXml({ publicCert: certificadoFolha(certPem) });
  sig.loadSignature(assinatura);
  return sig.checkSignature(xmlAssinado);
}
