// Gerador de CompNfse ABRASF 2.02 para os testes.
export function compNfse202({
  numero = 1001, prestador = '04252011000110', prestadorNome = 'CONSTRUTORA EXEMPLO LTDA', tomador = '11222333000181',
  tomadorNome = 'EMPRESA TESTE LTDA', item = '7.02', retido = false, data = '2026-03-10', valor = 2000, aliquota = '5.00',
  ibge = '4205407', cancelada = null, optante = '2',
} = {}) {
  const iss = (valor * Number(aliquota)) / 100;
  const pis = valor * 0.0065, cofins = valor * 0.03, ir = valor * 0.015, csll = valor * 0.01;
  const liquido = valor - pis - cofins - ir - csll - (retido ? iss : 0);
  const f = (v) => v.toFixed(2);
  return `<CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd"><Nfse versao="2.02"><InfNfse Id="nfse${numero}">
<Numero>${numero}</Numero><CodigoVerificacao>CV-${numero}</CodigoVerificacao><DataEmissao>${data}T14:30:00</DataEmissao>
<ValoresNfse><BaseCalculo>${f(valor)}</BaseCalculo><Aliquota>${aliquota}</Aliquota><ValorIss>${f(iss)}</ValorIss><ValorLiquidoNfse>${f(liquido)}</ValorLiquidoNfse></ValoresNfse>
<PrestadorServico><IdentificacaoPrestador><CpfCnpj><Cnpj>${prestador}</Cnpj></CpfCnpj><InscricaoMunicipal>55667</InscricaoMunicipal></IdentificacaoPrestador><RazaoSocial>${prestadorNome}</RazaoSocial></PrestadorServico>
<OrgaoGerador><CodigoMunicipio>${ibge}</CodigoMunicipio><Uf>SC</Uf></OrgaoGerador>
<DeclaracaoPrestacaoServico><InfDeclaracaoPrestacaoServico Id="dps${numero}">
<Rps><IdentificacaoRps><Numero>${numero + 5000}</Numero><Serie>A</Serie><Tipo>1</Tipo></IdentificacaoRps><DataEmissao>${data}</DataEmissao><Status>1</Status></Rps>
<Competencia>${data}</Competencia>
<Servico><Valores><ValorServicos>${f(valor)}</ValorServicos><ValorDeducoes>0.00</ValorDeducoes><ValorPis>${f(pis)}</ValorPis><ValorCofins>${f(cofins)}</ValorCofins><ValorInss>0.00</ValorInss><ValorIr>${f(ir)}</ValorIr><ValorCsll>${f(csll)}</ValorCsll><ValorIss>${f(iss)}</ValorIss><Aliquota>${aliquota}</Aliquota></Valores>
<IssRetido>${retido ? 1 : 2}</IssRetido>${retido ? '<ResponsavelRetencao>1</ResponsavelRetencao>' : ''}<ItemListaServico>${item}</ItemListaServico><CodigoTributacaoMunicipio>${item.replace('.', '')}01</CodigoTributacaoMunicipio><Discriminacao>Serviço ${numero}</Discriminacao><CodigoMunicipio>${ibge}</CodigoMunicipio><ExigibilidadeISS>1</ExigibilidadeISS><MunicipioIncidencia>${ibge}</MunicipioIncidencia></Servico>
<Prestador><CpfCnpj><Cnpj>${prestador}</Cnpj></CpfCnpj><InscricaoMunicipal>55667</InscricaoMunicipal></Prestador>
<Tomador><IdentificacaoTomador><CpfCnpj><Cnpj>${tomador}</Cnpj></CpfCnpj></IdentificacaoTomador><RazaoSocial>${tomadorNome}</RazaoSocial></Tomador>
<OptanteSimplesNacional>${optante}</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>
</InfDeclaracaoPrestacaoServico></DeclaracaoPrestacaoServico></InfNfse></Nfse>${cancelada ? `<NfseCancelamento><Confirmacao><Pedido><InfPedidoCancelamento Id="c1"><CodigoCancelamento>1</CodigoCancelamento></InfPedidoCancelamento></Pedido><DataHora>${cancelada}T09:00:00</DataHora></Confirmacao></NfseCancelamento>` : ''}</CompNfse>`;
}
