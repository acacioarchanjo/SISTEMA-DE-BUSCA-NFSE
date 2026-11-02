// Configurações conhecidas de municípios (envelope SOAP já mapeado).
// Fontes: manuais das prefeituras e bibliotecas abertas que já integram cada município.
// Sempre conferir com o manual vigente: prefeituras mudam versão/URL sem aviso.

export const MUNICIPIOS_CONHECIDOS = {
  3509502: {
    nome: 'Campinas',
    uf: 'SP',
    perfil: 'abrasf-2.03',
    url: 'https://novanfse.campinas.sp.gov.br/notafiscal-abrasfv203-ws/NotaFiscalSoap',
    urlHomologacao: 'https://homol-rps.ima.sp.gov.br/notafiscal-abrasfv203-ws/NotaFiscalSoap',
    // SOAP 1.1, SOAPAction vazio, <nfse:ConsultarNfseServicoPrestado> com o XML direto (sem nfseCabecMsg/nfseDadosMsg)
    opcoes: { soapVersao: '1.1', estilo: 'direto', elementoOperacao: '{op}', soapAction: '', nsServico: 'http://nfse.abrasf.org.br' },
    observacoes:
      'NFS-e Campinas (sistema IMA), padrão ABRASF 2.03. Exige certificado ICP-Brasil. Se a prefeitura pedir consulta assinada, ' +
      'o sistema detecta e passa a assinar sozinho. Campinas também publicou uma API no padrão nacional (nfseapi.campinas.sp.gov.br): ' +
      'se as notas já chegam pelo ADN, a conferência sinaliza duplicidade (DUP-001).',
    fontes: ['Unimake DFe — Servicos/Config/NFSe/CampinasSP.xml', 'OpenAC.Net.NFSe — Providers/ISSCampinas'],
  },
};

export const municipioConhecido = (ibge) => {
  const m = MUNICIPIOS_CONHECIDOS[String(ibge)];
  return m ? { ibge: String(ibge), ...m } : null;
};

/** A configuração salva difere da recomendada? (ignora opções extras que o usuário acrescentou, como assinarConsulta) */
export function difereDaRecomendada(municipio) {
  const r = municipioConhecido(municipio?.ibge);
  if (!r) return false;
  if (municipio.perfil !== r.perfil || municipio.url.replace(/\?wsdl$/i, '') !== r.url) return true;
  const atuais = municipio.opcoes ?? {};
  return Object.entries(r.opcoes).some(([k, v]) => atuais[k] !== v);
}
