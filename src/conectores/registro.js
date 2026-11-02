// Fábrica de conectores municipais a partir do cadastro (perfil + município + vínculo).
import { obterPerfil } from './abrasf/perfis.js';
import { ConectorAbrasf } from './abrasf/conector.js';
import { verificarContrato } from './contrato.js';

export function criarConectorMunicipal({ municipio, credenciais, inscricaoMunicipal }, teste = {}) {
  const perfil = obterPerfil(municipio.perfil);
  let conector;
  if (perfil.id.startsWith('abrasf-')) conector = new ConectorAbrasf({ perfil, municipio, credenciais, inscricaoMunicipal }, teste);
  else throw new Error(`Sem conector para o perfil ${perfil.id}`);
  verificarContrato(conector);
  return conector;
}
