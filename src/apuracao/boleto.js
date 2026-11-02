// Validação de linha digitável / código de barras (padrões FEBRABAN).
//
// 1) ARRECADAÇÃO (guias de tributos, concessionárias): código de barras com 44 dígitos começando com "8";
//    linha digitável com 48 dígitos = 4 blocos de 11 + 1 DV cada.
//    pos 1  = "8" (produto arrecadação)        pos 2 = segmento (1 = prefeituras)
//    pos 3  = identificador de valor: 6/7 → DVs em módulo 10; 8/9 → módulo 11 (6/8 = valor em reais)
//    pos 4  = DV geral (calculado sobre as outras 43 posições)
//    pos 5-15 = valor (11 dígitos, centavos)   pos 16-19 = identificação do órgão/empresa
// 2) COBRANÇA BANCÁRIA (boleto): código de barras com 44 dígitos; linha digitável com 47.
//    código: banco(3) moeda(1) DV(1) fator vencimento(4) valor(10) campo livre(25)
//    DV dos campos 1-3 da linha em módulo 10; DV geral em módulo 11.
//    Fator de vencimento: dias desde 07/10/1997; ao chegar em 9999 (21/02/2025) recomeça em 1000 = 22/02/2025.

const so = (s) => String(s ?? '').replace(/\D/g, '');

/** Módulo 10 (pesos 2,1 da direita para a esquerda; soma dos algarismos dos produtos). */
export function modulo10(num) {
  let soma = 0;
  let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    let p = Number(num[i]) * peso;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    soma += p;
    peso = peso === 2 ? 1 : 2;
  }
  return (10 - (soma % 10)) % 10;
}

/** Módulo 11 da arrecadação (pesos 2..9; resto 0 ou 1 → DV 0; resto 10 → DV 1). */
export function modulo11Arrecadacao(num) {
  let soma = 0;
  let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    soma += Number(num[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const r = soma % 11;
  return r === 0 || r === 1 ? 0 : 11 - r;
}

/** Módulo 11 do DV geral do boleto bancário (pesos 2..9; resultado 0, 10 ou 11 → DV 1). */
export function modulo11Boleto(num) {
  let soma = 0;
  let peso = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    soma += Number(num[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const dv = 11 - (soma % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

const SEGMENTOS = { 1: 'Prefeituras', 2: 'Saneamento', 3: 'Energia elétrica e gás', 4: 'Telecomunicações', 5: 'Órgãos governamentais', 6: 'Carnês e assemelhados', 7: 'Multas de trânsito', 9: 'Uso exclusivo do banco' };
const DIA = 86_400_000;
const BASE_1 = Date.UTC(1997, 9, 7);
const BASE_2 = Date.UTC(2025, 1, 22); // fator 1000 do 2º ciclo

/** Data de vencimento do fator, escolhendo o ciclo mais próximo da data de referência. */
export function dataDoFator(fator, referencia = new Date()) {
  if (!fator) return null; // fator 0000 = sem vencimento
  const c1 = BASE_1 + fator * DIA;
  const c2 = fator >= 1000 ? BASE_2 + (fator - 1000) * DIA : null;
  const ref = referencia.getTime();
  const escolhido = c2 !== null && Math.abs(c2 - ref) < Math.abs(c1 - ref) ? c2 : c1;
  return new Date(escolhido).toISOString().slice(0, 10);
}

/** Arrecadação: linha (48) → código de barras (44), validando o DV de cada bloco. */
function arrecadacaoDaLinha(l) {
  const mod = ['6', '7'].includes(l[2]) ? modulo10 : modulo11Arrecadacao;
  const blocos = [];
  for (let b = 0; b < 4; b++) {
    const bloco = l.slice(b * 12, b * 12 + 11);
    const dv = Number(l[b * 12 + 11]);
    if (mod(bloco) !== dv) throw new ErroBoleto(`Dígito do bloco ${b + 1} não confere: confira a digitação.`);
    blocos.push(bloco);
  }
  return blocos.join('');
}

function analisarArrecadacao(cod) {
  if (cod[0] !== '8') throw new ErroBoleto('Código de arrecadação deve começar com 8.');
  const idValor = cod[2];
  if (!['6', '7', '8', '9'].includes(idValor)) throw new ErroBoleto(`Identificador de valor inválido (${idValor}).`);
  const mod = ['6', '7'].includes(idValor) ? modulo10 : modulo11Arrecadacao;
  const semDv = cod.slice(0, 3) + cod.slice(4);
  if (mod(semDv) !== Number(cod[3])) throw new ErroBoleto('Dígito verificador geral não confere: código de barras inválido.');
  const emReais = idValor === '6' || idValor === '8';
  const segmento = Number(cod[1]);
  return {
    tipo: 'arrecadacao',
    codigoBarras: cod,
    segmento,
    segmentoNome: SEGMENTOS[segmento] ?? 'Desconhecido',
    valor: emReais ? Number(cod.slice(4, 15)) / 100 : null,
    valorEhReferencia: !emReais,
    orgao: cod.slice(15, 19),
    vencimento: null, // arrecadação não tem fator de vencimento padronizado (fica no campo livre do órgão)
  };
}

/** Cobrança bancária: linha (47) → código de barras (44), validando os DVs dos campos 1-3. */
function cobrancaDaLinha(l) {
  const c1 = l.slice(0, 9), d1 = Number(l[9]);
  const c2 = l.slice(10, 20), d2 = Number(l[20]);
  const c3 = l.slice(21, 31), d3 = Number(l[31]);
  if (modulo10(c1) !== d1) throw new ErroBoleto('Dígito do campo 1 não confere: confira a digitação.');
  if (modulo10(c2) !== d2) throw new ErroBoleto('Dígito do campo 2 não confere: confira a digitação.');
  if (modulo10(c3) !== d3) throw new ErroBoleto('Dígito do campo 3 não confere: confira a digitação.');
  const dvGeral = l[32];
  const fatorValor = l.slice(33, 47);
  return c1.slice(0, 4) + dvGeral + fatorValor + c1.slice(4) + c2 + c3;
}

function analisarCobranca(cod, referencia) {
  const semDv = cod.slice(0, 4) + cod.slice(5);
  if (modulo11Boleto(semDv) !== Number(cod[4])) throw new ErroBoleto('Dígito verificador geral não confere: código de barras inválido.');
  const fator = Number(cod.slice(5, 9));
  return {
    tipo: 'cobranca',
    codigoBarras: cod,
    banco: cod.slice(0, 3),
    moeda: cod[3],
    valor: Number(cod.slice(9, 19)) / 100,
    valorEhReferencia: false,
    fatorVencimento: fator,
    vencimento: dataDoFator(fator, referencia),
  };
}

export class ErroBoleto extends Error {
  name = 'ErroBoleto';
}

/**
 * Analisa uma linha digitável (47/48 dígitos) ou código de barras (44 dígitos).
 * @returns {{ tipo:'arrecadacao'|'cobranca', codigoBarras:string, linhaDigitavel:string, valor:number|null, vencimento:string|null, ... }}
 */
export function analisarBoleto(entrada, { referencia = new Date() } = {}) {
  const d = so(entrada);
  let r;
  if (d.length === 48) {
    if (d[0] !== '8') throw new ErroBoleto('Linha de 48 dígitos deve ser de arrecadação (começa com 8).');
    r = analisarArrecadacao(arrecadacaoDaLinha(d));
  } else if (d.length === 47) {
    r = analisarCobranca(cobrancaDaLinha(d), referencia);
  } else if (d.length === 44) {
    r = d[0] === '8' ? analisarArrecadacao(d) : analisarCobranca(d, referencia);
  } else {
    throw new ErroBoleto(`Quantidade de dígitos inválida (${d.length}). Use a linha digitável (47 ou 48 dígitos) ou o código de barras (44).`);
  }
  return { ...r, linhaDigitavel: linhaDe(r.codigoBarras) };
}

/** Código de barras (44) → linha digitável formatada. */
export function linhaDe(cod) {
  if (cod[0] === '8') {
    const mod = ['6', '7'].includes(cod[2]) ? modulo10 : modulo11Arrecadacao;
    return [0, 1, 2, 3].map((b) => { const x = cod.slice(b * 11, b * 11 + 11); return `${x}-${mod(x)}`; }).join(' ');
  }
  const c1 = cod.slice(0, 4) + cod.slice(19, 24);
  const c2 = cod.slice(24, 34);
  const c3 = cod.slice(34, 44);
  const f = (c) => `${c}${modulo10(c)}`;
  const a = f(c1), b = f(c2), c = f(c3);
  return `${a.slice(0, 5)}.${a.slice(5)} ${b.slice(0, 5)}.${b.slice(5)} ${c.slice(0, 5)}.${c.slice(5)} ${cod[4]} ${cod.slice(5, 19)}`;
}

/** Monta um código de barras de arrecadação válido (usado nos testes e em simulações). */
export function montarArrecadacao({ segmento = 1, idValor = '6', valor, orgao = '0000', livre = '' }) {
  const v = String(Math.round(valor * 100)).padStart(11, '0');
  const corpo = `8${segmento}${idValor}` + v + String(orgao).padStart(4, '0') + String(livre).padEnd(25, '0').slice(0, 25);
  const mod = ['6', '7'].includes(idValor) ? modulo10 : modulo11Arrecadacao;
  return corpo.slice(0, 3) + mod(corpo) + corpo.slice(3);
}

/** Monta um código de barras de cobrança válido (testes). */
export function montarCobranca({ banco = '001', valor, vencimento, livre = '' }) {
  const v = Date.UTC(...vencimento.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  let fator = Math.round((v - BASE_1) / DIA);
  if (fator > 9999) fator = 1000 + Math.round((v - BASE_2) / DIA);
  const corpo = `${banco}9` + String(fator).padStart(4, '0') + String(Math.round(valor * 100)).padStart(10, '0') + String(livre).padEnd(25, '0').slice(0, 25);
  return corpo.slice(0, 4) + modulo11Boleto(corpo) + corpo.slice(4);
}
