// Utilitários de formatação/validação comuns.

export const somenteDigitos = (s) => String(s ?? '').replace(/\D/g, '');

export function validarCnpj(cnpj) {
  const c = somenteDigitos(cnpj);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (base) => {
    let soma = 0;
    let peso = base.length - 7;
    for (const d of base) {
      soma += Number(d) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(c.slice(0, 12));
  const d2 = calc(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

export function validarCpf(cpf) {
  const c = somenteDigitos(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

export function formatarCnpj(cnpj) {
  const c = somenteDigitos(cnpj);
  if (c.length === 14) return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (c.length === 11) return c.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return cnpj ?? '';
}

export function formatarMoeda(v) {
  return Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Decimal com vírgula, sem separador de milhar (padrão de planilha/importação BR). */
export function decimalBR(v, casas = 2) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toFixed(casas).replace('.', ',');
}

/** "2026-03-15T10:00:00-03:00" -> "15/03/2026" */
export function dataBR(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
