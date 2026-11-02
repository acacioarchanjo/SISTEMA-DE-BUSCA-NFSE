// Gravação dos XMLs em disco: data/xml/{cnpj}/{AAAA-MM}/{chave}.xml
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const seguro = (s) => String(s ?? '').replace(/[^0-9A-Za-z_-]/g, '');

export function caminhoAbsoluto(relativo, dataDir = config.dataDir) {
  const abs = path.resolve(dataDir, relativo);
  // impede path traversal
  if (!abs.startsWith(path.resolve(dataDir) + path.sep)) throw new Error('Caminho fora do diretório de dados.');
  return abs;
}

function gravar(relativo, conteudo, dataDir) {
  const abs = caminhoAbsoluto(relativo, dataDir);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, conteudo, { encoding: 'utf8', mode: 0o600 });
  return relativo;
}

export function salvarXmlNfse({ cnpj, competencia, chave, xml }, dataDir = config.dataDir) {
  const mes = /^\d{4}-\d{2}/.test(competencia ?? '') ? competencia.slice(0, 7) : 'sem-competencia';
  return gravar(path.join('xml', seguro(cnpj), mes, `${seguro(chave)}.xml`), xml, dataDir);
}

export function salvarXmlEvento({ cnpj, chave, tipoEvento, nsu, xml }, dataDir = config.dataDir) {
  const nome = `${seguro(chave) || 'sem-chave'}_${seguro(tipoEvento) || 'evento'}_${seguro(nsu)}.xml`;
  return gravar(path.join('xml', seguro(cnpj), 'eventos', nome), xml, dataDir);
}

export function lerXmlSalvo(relativo, dataDir = config.dataDir) {
  return fs.readFileSync(caminhoAbsoluto(relativo, dataDir), 'utf8');
}

export function excluirXmlsDaEmpresa(cnpj, dataDir = config.dataDir) {
  fs.rmSync(path.join(dataDir, 'xml', seguro(cnpj)), { recursive: true, force: true });
}
