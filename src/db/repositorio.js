// Acesso a dados: empresas, cursor NSU, documentos, eventos e execuções.
import { registrarAuditoria } from '../auditoria.js';

const CAMPOS_DOC = [
  'empresa_id', 'chave', 'nsu', 'origem', 'papel', 'situacao', 'numero', 'data_emissao',
  'competencia', 'municipio_emissao', 'municipio_incidencia', 'prestador_doc', 'prestador_nome',
  'prestador_im', 'tomador_doc', 'tomador_nome', 'intermediario_doc', 'codigo_servico',
  'codigo_nbs', 'descricao', 'valor_servico', 'valor_deducoes', 'base_calculo', 'aliquota',
  'valor_iss', 'iss_retido', 'valor_pis', 'valor_cofins', 'pis_cofins_retido', 'valor_csll',
  'valor_irrf', 'valor_inss', 'valor_total_retencoes', 'valor_liquido', 'xml_path',
  'prestador_regime', 'tp_ret_issqn', 'codigo_municipio_incidencia',
  'sistema', 'codigo_verificacao', 'municipio_gerador', 'codigo_servico_municipal',
];

// Colunas que o painel/API podem ver de uma empresa (nunca o certificado).
const COLS_EMPRESA_PUBLICA = `e.id, e.cnpj, e.razao_social, e.cert_cn, e.cert_emissor, e.cert_valido_ate,
  e.ativo, e.trava_ate, e.criado_em, e.atualizado_em, COALESCE(c.ultimo_nsu, 0) AS ultimo_nsu,
  (SELECT COUNT(*) FROM documentos d WHERE d.empresa_id = e.id) AS total_documentos,
  (SELECT MAX(x.fim) FROM execucoes x WHERE x.empresa_id = e.id AND x.status = 'ok') AS ultima_busca,
  (SELECT COUNT(*) FROM vinculos_municipais v WHERE v.empresa_id = e.id AND v.ativo = 1) AS prefeituras`;

export class Repositorio {
  constructor(db) {
    this.db = db;
  }

  // ---------- empresas ----------
  listarEmpresas({ somenteAtivas = false } = {}) {
    return this.db
      .prepare(
        `SELECT ${COLS_EMPRESA_PUBLICA} FROM empresas e LEFT JOIN cursor_nsu c ON c.empresa_id = e.id
         ${somenteAtivas ? 'WHERE e.ativo = 1' : ''} ORDER BY e.razao_social`,
      )
      .all();
  }

  obterEmpresa(id) {
    return this.db
      .prepare(`SELECT ${COLS_EMPRESA_PUBLICA} FROM empresas e LEFT JOIN cursor_nsu c ON c.empresa_id = e.id WHERE e.id = ?`)
      .get(id);
  }

  obterEmpresaPorCnpj(cnpj) {
    const r = this.db.prepare('SELECT id FROM empresas WHERE cnpj = ?').get(cnpj);
    return r ? this.obterEmpresa(r.id) : undefined;
  }

  /** Inclui os campos cifrados — uso interno (cliente mTLS). */
  obterCredenciais(id) {
    return this.db.prepare('SELECT id, cnpj, cert_cifrado, senha_cifrada FROM empresas WHERE id = ?').get(id);
  }

  salvarEmpresa(e) {
    const existente = this.db.prepare('SELECT id FROM empresas WHERE cnpj = ?').get(e.cnpj);
    if (existente) {
      this.db
        .prepare(
          `UPDATE empresas SET razao_social=@razao_social, cert_cifrado=@cert_cifrado, senha_cifrada=@senha_cifrada,
           cert_cn=@cert_cn, cert_emissor=@cert_emissor, cert_valido_ate=@cert_valido_ate, ativo=1,
           atualizado_em=datetime('now') WHERE id=@id`,
        )
        .run({ ...e, id: existente.id });
      return existente.id;
    }
    const info = this.db
      .prepare(
        `INSERT INTO empresas (cnpj, razao_social, cert_cifrado, senha_cifrada, cert_cn, cert_emissor, cert_valido_ate)
         VALUES (@cnpj, @razao_social, @cert_cifrado, @senha_cifrada, @cert_cn, @cert_emissor, @cert_valido_ate)`,
      )
      .run(e);
    const id = Number(info.lastInsertRowid);
    this.db.prepare('INSERT OR IGNORE INTO cursor_nsu (empresa_id, ultimo_nsu) VALUES (?, 0)').run(id);
    return id;
  }

  atualizarEmpresa(id, { razao_social, ativo }) {
    if (razao_social !== undefined)
      this.db.prepare("UPDATE empresas SET razao_social=?, atualizado_em=datetime('now') WHERE id=?").run(razao_social, id);
    if (ativo !== undefined)
      this.db.prepare("UPDATE empresas SET ativo=?, atualizado_em=datetime('now') WHERE id=?").run(ativo ? 1 : 0, id);
  }

  excluirEmpresa(id, { motivo = null } = {}) {
    const e = this.obterEmpresa(id);
    const ok = this.db.prepare('DELETE FROM empresas WHERE id = ?').run(id).changes > 0;
    if (ok && e) {
      registrarAuditoria(this.db, {
        tipo: 'empresa.excluida',
        empresaCnpj: e.cnpj,
        payload: { empresa_id: id, cnpj: e.cnpj, razao_social: e.razao_social, notas_apagadas: e.total_documentos, motivo },
      });
    }
    return ok;
  }

  definirTrava(id, ateIso) {
    this.db.prepare('UPDATE empresas SET trava_ate = ? WHERE id = ?').run(ateIso, id);
  }

  // ---------- cursor NSU ----------
  obterCursor(empresaId) {
    return this.db.prepare('SELECT ultimo_nsu FROM cursor_nsu WHERE empresa_id = ?').get(empresaId)?.ultimo_nsu ?? 0;
  }

  /** Só avança (nunca retrocede), salvo `forcar`. */
  salvarCursor(empresaId, nsu, { forcar = false } = {}) {
    this.db
      .prepare(
        `INSERT INTO cursor_nsu (empresa_id, ultimo_nsu, atualizado_em) VALUES (@id, @nsu, datetime('now'))
         ON CONFLICT(empresa_id) DO UPDATE SET
           ultimo_nsu = CASE WHEN @forcar = 1 OR excluded.ultimo_nsu > ultimo_nsu THEN excluded.ultimo_nsu ELSE ultimo_nsu END,
           atualizado_em = datetime('now')`,
      )
      .run({ id: empresaId, nsu, forcar: forcar ? 1 : 0 });
  }

  // ---------- documentos ----------
  /** Insere ou atualiza; devolve true se o documento é novo. */
  salvarDocumento(doc) {
    const linha = Object.fromEntries(CAMPOS_DOC.map((c) => [c, doc[c] ?? null]));
    const existe = this.db.prepare('SELECT id, situacao FROM documentos WHERE empresa_id=? AND chave=?').get(linha.empresa_id, linha.chave);
    if (existe) {
      // Preserva situação de cancelamento já registrada por evento.
      if (existe.situacao !== 'normal') linha.situacao = existe.situacao;
      const sets = CAMPOS_DOC.filter((c) => !['empresa_id', 'chave'].includes(c)).map((c) => `${c}=COALESCE(@${c}, ${c})`);
      this.db.prepare(`UPDATE documentos SET ${sets.join(', ')} WHERE id=@id`).run({ ...linha, id: existe.id });
      return false;
    }
    this.db
      .prepare(`INSERT INTO documentos (${CAMPOS_DOC.join(', ')}) VALUES (${CAMPOS_DOC.map((c) => '@' + c).join(', ')})`)
      .run(linha);
    return true;
  }

  marcarSituacao(empresaId, chave, situacao) {
    return this.db.prepare('UPDATE documentos SET situacao=? WHERE empresa_id=? AND chave=?').run(situacao, empresaId, chave).changes;
  }

  obterDocumento(id) {
    return this.db.prepare('SELECT * FROM documentos WHERE id = ?').get(id);
  }

  chavesDaEmpresa(empresaId) {
    return new Set(this.db.prepare('SELECT chave FROM documentos WHERE empresa_id=?').pluck().all(empresaId));
  }

  /**
   * Filtros: empresaId, papel, situacao, de, ate (competência YYYY-MM-DD), busca (texto), limite, offset
   */
  listarDocumentos(f = {}) {
    const { where, params } = this.#filtroDocs(f);
    const limite = Math.min(Number(f.limite) || 100, 100_000);
    const offset = Number(f.offset) || 0;
    const itens = this.db
      .prepare(
        `SELECT d.*, e.razao_social AS empresa_nome, e.cnpj AS empresa_cnpj,
           (SELECT COUNT(*) FROM divergencias v WHERE v.documento_id = d.id AND v.status = 'aberta' AND v.severidade = 'BLOQUEANTE') AS div_bloqueantes,
           (SELECT COUNT(*) FROM divergencias v WHERE v.documento_id = d.id AND v.status = 'aberta' AND v.severidade = 'ALERTA') AS div_alertas,
           (SELECT COUNT(*) FROM divergencias v WHERE v.documento_id = d.id AND v.status = 'aberta' AND v.severidade = 'INFO') AS div_info
         FROM documentos d
         JOIN empresas e ON e.id = d.empresa_id ${where}
         ORDER BY d.competencia DESC, d.data_emissao DESC, d.id DESC LIMIT ${limite} OFFSET ${offset}`,
      )
      .all(params);
    const totais = this.db
      .prepare(
        `SELECT COUNT(*) AS quantidade, COALESCE(SUM(valor_servico),0) AS valor_servico, COALESCE(SUM(valor_iss),0) AS valor_iss,
          COALESCE(SUM(valor_total_retencoes),0) AS valor_retencoes, COALESCE(SUM(valor_liquido),0) AS valor_liquido
         FROM documentos d ${where}`,
      )
      .get(params);
    return { itens, totais };
  }

  #filtroDocs(f) {
    const cond = [];
    const params = {};
    if (f.empresaId) { cond.push('d.empresa_id = @empresaId'); params.empresaId = Number(f.empresaId); }
    if (f.papel) { cond.push('d.papel = @papel'); params.papel = f.papel; }
    if (f.situacao) { cond.push('d.situacao = @situacao'); params.situacao = f.situacao; }
    if (f.de) { cond.push('d.competencia >= @de'); params.de = f.de; }
    if (f.ate) { cond.push('d.competencia <= @ate'); params.ate = f.ate; }
    if (f.divergencia === 'bloqueante') cond.push("EXISTS (SELECT 1 FROM divergencias v WHERE v.documento_id = d.id AND v.status = 'aberta' AND v.severidade = 'BLOQUEANTE')");
    else if (f.divergencia === 'qualquer') cond.push("EXISTS (SELECT 1 FROM divergencias v WHERE v.documento_id = d.id AND v.status = 'aberta')");
    if (f.busca) {
      cond.push(`(d.chave LIKE @busca OR d.numero LIKE @busca OR d.prestador_nome LIKE @busca OR d.tomador_nome LIKE @busca
        OR d.prestador_doc LIKE @busca OR d.tomador_doc LIKE @busca OR d.descricao LIKE @busca)`);
      params.busca = `%${f.busca}%`;
    }
    return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params };
  }

  // ---------- eventos ----------
  salvarEvento(ev) {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO eventos (empresa_id, chave, nsu, tipo_evento, descricao, data_evento, xml_path)
           VALUES (@empresa_id, @chave, @nsu, @tipo_evento, @descricao, @data_evento, @xml_path)`,
        )
        .run({ descricao: null, data_evento: null, xml_path: null, ...ev }).changes > 0
    );
  }

  listarEventos(empresaId, chave) {
    return this.db.prepare('SELECT * FROM eventos WHERE empresa_id=? AND chave=? ORDER BY nsu').all(empresaId, chave);
  }

  // ---------- execuções ----------
  iniciarExecucao(empresaId, tipo, { loteId = null } = {}) {
    return Number(
      this.db
        .prepare("INSERT INTO execucoes (empresa_id, tipo, status, codigo, lote_id) VALUES (?, ?, 'executando', 'EM_EXECUCAO', ?)")
        .run(empresaId, tipo, loteId).lastInsertRowid,
    );
  }

  atualizarExecucao(id, dados) {
    const d = { ...dados };
    if (d.detalhes !== undefined && typeof d.detalhes !== 'string') d.detalhes = JSON.stringify(d.detalhes);
    const campos = ['status', 'codigo', 'subcodigo', 'detalhes', 'lotes', 'novos', 'eventos', 'ultimo_nsu', 'mensagem'].filter((c) => d[c] !== undefined);
    const sets = campos.map((c) => `${c}=@${c}`);
    if (d.finalizar) sets.push("fim=datetime('now')");
    if (!sets.length) return;
    this.db.prepare(`UPDATE execucoes SET ${sets.join(', ')} WHERE id=@id`).run({ ...d, id });
  }

  obterExecucao(id) {
    const x = this.db.prepare('SELECT x.*, e.razao_social AS empresa_nome, e.cnpj AS empresa_cnpj FROM execucoes x LEFT JOIN empresas e ON e.id = x.empresa_id WHERE x.id = ?').get(id);
    return x ? { ...x, detalhes: x.detalhes ? JSON.parse(x.detalhes) : null } : undefined;
  }

  execucaoEmAndamento(empresaId) {
    return this.db.prepare("SELECT * FROM execucoes WHERE empresa_id=? AND status='executando' ORDER BY id DESC LIMIT 1").get(empresaId);
  }

  listarExecucoes({ empresaId, limite = 30 } = {}) {
    return this.db
      .prepare(
        `SELECT x.*, e.razao_social AS empresa_nome, json_extract(x.detalhes, '$.municipio.nome') AS municipio_nome
         FROM execucoes x LEFT JOIN empresas e ON e.id = x.empresa_id
         ${empresaId ? 'WHERE x.empresa_id = @empresaId' : ''} ORDER BY x.id DESC LIMIT @limite`,
      )
      .all(empresaId ? { empresaId: Number(empresaId), limite: Number(limite) } : { limite: Number(limite) });
  }

  resumo() {
    return this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM empresas) AS empresas, (SELECT COUNT(*) FROM documentos) AS documentos,
         (SELECT COUNT(*) FROM documentos WHERE papel='emitida') AS emitidas,
         (SELECT COUNT(*) FROM documentos WHERE papel='recebida') AS recebidas,
         (SELECT COUNT(*) FROM documentos WHERE situacao='cancelada') AS canceladas,
         (SELECT COUNT(*) FROM divergencias WHERE status='aberta' AND severidade='BLOQUEANTE') AS divergencias_bloqueantes,
         (SELECT COUNT(*) FROM divergencias WHERE status='aberta' AND severidade='ALERTA') AS divergencias_alertas,
         (SELECT COUNT(*) FROM divergencias WHERE status='aberta' AND severidade='INFO') AS divergencias_info`,
      )
      .get();
  }

  // ---------- municípios e vínculos (conectores municipais) ----------
  listarMunicipios() {
    return this.db
      .prepare(`SELECT m.*, (SELECT COUNT(*) FROM vinculos_municipais v WHERE v.ibge = m.ibge) AS vinculos FROM municipios m ORDER BY m.nome`)
      .all()
      .map((m) => ({ ...m, opcoes: m.opcoes ? JSON.parse(m.opcoes) : {} }));
  }

  obterMunicipio(ibge) {
    const m = this.db.prepare('SELECT * FROM municipios WHERE ibge = ?').get(String(ibge));
    return m ? { ...m, opcoes: m.opcoes ? JSON.parse(m.opcoes) : {} } : undefined;
  }

  salvarMunicipio({ ibge, nome, uf = null, perfil, url, opcoes = {}, observacoes = null }) {
    this.db
      .prepare(
        `INSERT INTO municipios (ibge, nome, uf, perfil, url, opcoes, observacoes) VALUES (@ibge, @nome, @uf, @perfil, @url, @opcoes, @observacoes)
         ON CONFLICT(ibge) DO UPDATE SET nome=excluded.nome, uf=excluded.uf, perfil=excluded.perfil, url=excluded.url,
           opcoes=excluded.opcoes, observacoes=excluded.observacoes, atualizado_em=datetime('now')`,
      )
      .run({ ibge: String(ibge), nome, uf, perfil, url, opcoes: JSON.stringify(opcoes ?? {}), observacoes });
    return this.obterMunicipio(ibge);
  }

  excluirMunicipio(ibge) {
    if (this.db.prepare('SELECT COUNT(*) AS n FROM vinculos_municipais WHERE ibge = ?').get(String(ibge)).n) {
      throw new Error('Há empresas vinculadas a este município. Remova os vínculos antes.');
    }
    return this.db.prepare('DELETE FROM municipios WHERE ibge = ?').run(String(ibge)).changes > 0;
  }

  listarVinculos({ empresaId, somenteAtivos = false } = {}) {
    const cond = [];
    const p = {};
    if (empresaId) { cond.push('v.empresa_id = @empresaId'); p.empresaId = Number(empresaId); }
    if (somenteAtivos) cond.push('v.ativo = 1');
    return this.db
      .prepare(
        `SELECT v.*, m.nome AS municipio_nome, m.uf, m.perfil, m.url, e.razao_social AS empresa_nome, e.cnpj AS empresa_cnpj,
           (SELECT x.codigo FROM execucoes x WHERE x.empresa_id = v.empresa_id AND x.tipo = 'busca_municipal'
              AND json_extract(x.detalhes, '$.vinculo_id') = v.id ORDER BY x.id DESC LIMIT 1) AS ultimo_codigo,
           (SELECT x.fim FROM execucoes x WHERE x.empresa_id = v.empresa_id AND x.tipo = 'busca_municipal'
              AND json_extract(x.detalhes, '$.vinculo_id') = v.id ORDER BY x.id DESC LIMIT 1) AS ultima_execucao
         FROM vinculos_municipais v JOIN municipios m ON m.ibge = v.ibge JOIN empresas e ON e.id = v.empresa_id
         ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY e.razao_social, m.nome`,
      )
      .all(p);
  }

  obterVinculo(id) {
    return this.listarVinculos().find((v) => v.id === Number(id));
  }

  salvarVinculo({ empresaId, ibge, inscricaoMunicipal = null, ativo = true }) {
    this.db
      .prepare(
        `INSERT INTO vinculos_municipais (empresa_id, ibge, inscricao_municipal, ativo) VALUES (?, ?, ?, ?)
         ON CONFLICT(empresa_id, ibge) DO UPDATE SET inscricao_municipal=excluded.inscricao_municipal, ativo=excluded.ativo`,
      )
      .run(Number(empresaId), String(ibge), inscricaoMunicipal || null, ativo ? 1 : 0);
    return this.db.prepare('SELECT id FROM vinculos_municipais WHERE empresa_id = ? AND ibge = ?').get(Number(empresaId), String(ibge)).id;
  }

  excluirVinculo(id) {
    return this.db.prepare('DELETE FROM vinculos_municipais WHERE id = ?').run(Number(id)).changes > 0;
  }

  avancarVinculo(id, ultimaData) {
    this.db
      .prepare('UPDATE vinculos_municipais SET ultima_data = ? WHERE id = ? AND (ultima_data IS NULL OR ultima_data < ?)')
      .run(ultimaData, Number(id), ultimaData);
  }

  // ---------- divergências ----------
  #filtroDiv(f) {
    const cond = [];
    const p = {};
    if (f.empresaId) { cond.push('v.empresa_id = @empresaId'); p.empresaId = Number(f.empresaId); }
    if (f.status) { cond.push('v.status = @status'); p.status = f.status; }
    if (f.severidade) { cond.push('v.severidade = @severidade'); p.severidade = f.severidade; }
    if (f.codigo) { cond.push('v.codigo = @codigo'); p.codigo = f.codigo; }
    if (f.documentoId) { cond.push('v.documento_id = @documentoId'); p.documentoId = Number(f.documentoId); }
    if (f.de) { cond.push('v.competencia >= @de'); p.de = f.de; }
    if (f.ate) { cond.push('v.competencia <= @ate'); p.ate = f.ate; }
    return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', p };
  }

  listarDivergencias(f = {}) {
    const { where, p } = this.#filtroDiv(f);
    const limite = Math.min(Number(f.limite) || 200, 100_000);
    const offset = Number(f.offset) || 0;
    const itens = this.db
      .prepare(
        `SELECT v.*, d.numero, d.chave, d.papel, d.prestador_nome, d.prestador_doc, d.tomador_nome, d.tomador_doc,
           d.valor_servico, d.valor_iss, d.situacao, e.razao_social AS empresa_nome, e.cnpj AS empresa_cnpj
         FROM divergencias v JOIN documentos d ON d.id = v.documento_id JOIN empresas e ON e.id = v.empresa_id
         ${where}
         ORDER BY CASE v.severidade WHEN 'BLOQUEANTE' THEN 0 WHEN 'ALERTA' THEN 1 ELSE 2 END, v.competencia DESC, v.id DESC
         LIMIT ${limite} OFFSET ${offset}`,
      )
      .all(p)
      .map((v) => ({ ...v, detalhes: v.detalhes ? JSON.parse(v.detalhes) : {} }));
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM divergencias v ${where}`).get(p).n;
    return { itens, total };
  }

  /** Contagem por severidade (abertas, salvo outro status). */
  contarDivergencias({ empresaId, status = 'aberta' } = {}) {
    const { where, p } = this.#filtroDiv({ empresaId, status });
    const linhas = this.db.prepare(`SELECT v.severidade, COUNT(*) AS n FROM divergencias v ${where} GROUP BY v.severidade`).all(p);
    const r = { BLOQUEANTE: 0, ALERTA: 0, INFO: 0 };
    for (const l of linhas) r[l.severidade] = l.n;
    return r;
  }

  obterDivergencia(id) {
    const v = this.db.prepare('SELECT v.*, e.cnpj AS empresa_cnpj FROM divergencias v JOIN empresas e ON e.id = v.empresa_id WHERE v.id = ?').get(id);
    return v ? { ...v, detalhes: v.detalhes ? JSON.parse(v.detalhes) : {} } : undefined;
  }

  definirStatusDivergencia(id, status, motivo) {
    return this.db
      .prepare("UPDATE divergencias SET status = ?, motivo = ?, atualizado_em = datetime('now') WHERE id = ?")
      .run(status, motivo ?? null, id).changes > 0;
  }
}
