import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNfse, parseEvento, papelDaEmpresa, tipoDoXml, lerXml, ErroParser } from '../src/nfse/parser.js';
import { validarCnpj, validarCpf, formatarCnpj, decimalBR } from '../src/util/formatos.js';
import { fixture, CHAVE_TESTE, CNPJ_TESTE, CNPJ_CLIENTE } from './ajuda.js';

test('parser: extrai metadados e retenções da NFS-e nacional', () => {
  const n = parseNfse(fixture('nfse-exemplo.xml'));
  assert.equal(n.chave, CHAVE_TESTE);
  assert.equal(n.numero, '12');
  assert.equal(n.competencia, '2026-03-15');
  assert.equal(n.prestador_doc, CNPJ_TESTE);
  assert.equal(n.prestador_nome, 'EMPRESA TESTE LTDA');
  assert.equal(n.tomador_doc, CNPJ_CLIENTE);
  assert.equal(n.tomador_nome, 'CLIENTE TOMADOR S.A.');
  assert.equal(n.codigo_servico, '010101');
  assert.equal(n.municipio_incidencia, 'São Paulo');
  assert.equal(n.valor_servico, 10000);
  assert.equal(n.base_calculo, 10000);
  assert.equal(n.aliquota, 2);
  assert.equal(n.valor_iss, 200);
  assert.equal(n.iss_retido, false);
  assert.equal(n.valor_pis, 65);
  assert.equal(n.valor_cofins, 300);
  assert.equal(n.pis_cofins_retido, true);
  assert.equal(n.valor_irrf, 150);
  assert.equal(n.valor_csll, 100);
  assert.equal(n.valor_inss, 0);
  assert.equal(n.valor_total_retencoes, 815);
  assert.equal(n.valor_liquido, 9185);
});

test('parser: calcula retenções quando vTotalRet/vLiq não vêm no XML', () => {
  const xml = fixture('nfse-exemplo.xml')
    .replace(/<vTotalRet>.*<\/vTotalRet>/, '')
    .replace(/<vLiq>.*<\/vLiq>/, '')
    .replace('<tpRetISSQN>1</tpRetISSQN>', '<tpRetISSQN>2</tpRetISSQN>');
  const n = parseNfse(xml);
  assert.equal(n.iss_retido, true);
  assert.equal(n.valor_total_retencoes, 200 + 65 + 300 + 150 + 100);
  assert.equal(n.valor_liquido, 10000 - 815);
});

test('parser: evento de cancelamento', () => {
  const ev = parseEvento(fixture('evento-cancelamento.xml'));
  assert.equal(ev.chave, CHAVE_TESTE);
  assert.equal(ev.tipo_evento, '101101');
  assert.equal(ev.situacao, 'cancelada');
  assert.equal(ev.motivo, 'Erro na emissão');
  assert.equal(tipoDoXml(lerXml(fixture('evento-cancelamento.xml'))), 'evento');
  assert.equal(tipoDoXml(lerXml(fixture('nfse-exemplo.xml'))), 'nfse');
});

test('parser: papel da empresa e XML inválido', () => {
  const n = parseNfse(fixture('nfse-exemplo.xml'));
  assert.equal(papelDaEmpresa(n, CNPJ_TESTE), 'emitida');
  assert.equal(papelDaEmpresa(n, CNPJ_CLIENTE), 'recebida');
  assert.equal(papelDaEmpresa(n, '11222333000262'), 'emitida', 'filial da mesma raiz');
  assert.equal(papelDaEmpresa(n, '99888777000100'), 'outro');
  assert.throws(() => parseNfse('<a><b>sem nfse</b></a>'), ErroParser);
});

test('formatos: CNPJ/CPF e números', () => {
  assert.ok(validarCnpj('11.222.333/0001-81'));
  assert.ok(!validarCnpj('11.222.333/0001-82'));
  assert.ok(!validarCnpj('00000000000000'));
  assert.ok(validarCpf('123.456.789-09'));
  assert.ok(!validarCpf('123.456.789-00'));
  assert.equal(formatarCnpj('11222333000181'), '11.222.333/0001-81');
  assert.equal(decimalBR(1234.5), '1234,50');
});
