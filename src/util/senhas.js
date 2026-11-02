// Leitura da planilha de senhas para a importação de certificados em lote.
// Formato (CSV, separador ; , ou tab), uma linha por certificado:
//   arquivo;senha            ex.: empresa-abc.pfx;S3nh@
//   CNPJ;senha               ex.: 11.222.333/0001-81;S3nh@
// Cabeçalho opcional (linha cuja 2ª coluna é "senha"). O arquivo pode vir com ou sem extensão.

const semExtensao = (nome) => String(nome).replace(/\.(pfx|p12)$/i, '');
const chaveArquivo = (nome) => semExtensao(String(nome).split(/[\\/]/).pop()).trim().toLowerCase();

function separar(linha) {
  const sep = linha.includes(';') ? ';' : linha.includes('\t') ? '\t' : ',';
  const partes = [];
  let atual = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else aspas = !aspas;
    } else if (c === sep && !aspas) {
      partes.push(atual);
      atual = '';
    } else atual += c;
  }
  partes.push(atual);
  return partes;
}

/** Converte o texto da planilha em Map(chave → senha). Chaves: nome do arquivo (minúsculo, sem extensão) e CNPJ (só dígitos). */
export function lerPlanilhaSenhas(texto) {
  const mapa = new Map();
  const linhas = String(texto ?? '').replace(/^﻿/, '').split(/\r?\n/);
  for (const linha of linhas) {
    if (!linha.trim()) continue;
    const [ref, senha = ''] = separar(linha);
    if (!ref?.trim()) continue;
    if (senha.trim().toLowerCase() === 'senha') continue; // cabeçalho
    const digitos = ref.replace(/\D/g, '');
    if (digitos.length === 14 && /^[\d./\s-]+$/.test(ref.trim())) mapa.set(digitos, senha);
    else mapa.set(chaveArquivo(ref), senha);
  }
  return mapa;
}

/** Procura a senha de um certificado pelo nome do arquivo (ou pelo CNPJ, se já conhecido). */
export function senhaPara(mapa, nomeArquivo, cnpj) {
  if (cnpj && mapa.has(String(cnpj).replace(/\D/g, ''))) return mapa.get(String(cnpj).replace(/\D/g, ''));
  const k = chaveArquivo(nomeArquivo);
  if (mapa.has(k)) return mapa.get(k);
  // CNPJ no nome do arquivo (ex.: "11222333000181.pfx" ou "Empresa 11.222.333-0001-81.pfx")
  const digitos = String(nomeArquivo).replace(/\D/g, '');
  for (const [chave, senha] of mapa) if (chave.length === 14 && /^\d+$/.test(chave) && digitos.includes(chave)) return senha;
  return undefined;
}
