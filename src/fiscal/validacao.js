// Aplica as regras fiscais às notas gravadas e mantém a tabela de divergências.
import { config } from '../config.js';
import { avaliarNota, REGRAS_VERSAO } from './regras.js';
import { parseNfse } from '../nfse/parser.js';
import { lerXmlSalvo } from '../nfse/armazenamento.js';
import { registrarAuditoria } from '../auditoria.js';

/** Notas gravadas antes destes campos existirem: completa a partir do XML guardado. */
function completarMetadados(repo, doc, dataDir) {
  if (doc.prestador_regime != null || doc.tp_ret_issqn != null || !doc.xml_path) return doc;
  try {
    const n = parseNfse(lerXmlSalvo(doc.xml_path, dataDir));
    repo.db
      .prepare('UPDATE documentos SET prestador_regime=?, tp_ret_issqn=?, codigo_municipio_incidencia=? WHERE id=?')
      .run(n.prestador_regime, n.tp_ret_issqn, n.codigo_municipio_incidencia, doc.id);
    return { ...doc, prestador_regime: n.prestador_regime, tp_ret_issqn: n.tp_ret_issqn, codigo_municipio_incidencia: n.codigo_municipio_incidencia };
  } catch {
    return doc; // XML ausente/ilegível: valida com o que tiver
  }
}

/**
 * Valida as notas (todas, de uma empresa, ou uma lista de ids).
 * Divergências que deixam de se aplicar viram "resolvida"; as "ignoradas" por uma pessoa continuam ignoradas.
 * @returns {{documentos:number, novas:number, reabertas:number, resolvidas:number, abertas:{BLOQUEANTE:number, ALERTA:number, INFO:number}}}
 */
export function validarDocumentos(repo, { empresaId, documentoIds, dataDir = config.dataDir, auditar = false } = {}) {
  const db = repo.db;
  const cond = [];
  const p = {};
  if (empresaId) { cond.push('empresa_id = @empresaId'); p.empresaId = Number(empresaId); }
  if (documentoIds?.length) cond.push(`id IN (${documentoIds.map(Number).filter(Number.isFinite).join(',') || '0'})`);
  const docs = db.prepare(`SELECT * FROM documentos ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}`).all(p);

  const res = { documentos: docs.length, novas: 0, reabertas: 0, resolvidas: 0 };
  const existentesDe = db.prepare('SELECT * FROM divergencias WHERE documento_id = ?');
  const inserir = db.prepare(
    `INSERT INTO divergencias (empresa_id, documento_id, codigo, severidade, mensagem, detalhes, competencia, regras_versao)
     VALUES (@empresa_id, @documento_id, @codigo, @severidade, @mensagem, @detalhes, @competencia, @regras_versao)`,
  );
  const atualizar = db.prepare(
    `UPDATE divergencias SET severidade=@severidade, mensagem=@mensagem, detalhes=@detalhes, competencia=@competencia,
       regras_versao=@regras_versao, status=@status, motivo=@motivo, atualizado_em=datetime('now') WHERE id=@id`,
  );
  const marcarValidado = db.prepare("UPDATE documentos SET validado_em = datetime('now') WHERE id = ?");

  db.transaction(() => {
    for (const bruto of docs) {
      const doc = completarMetadados(repo, bruto, dataDir);
      const achadas = avaliarNota(doc, { eventos: repo.listarEventos(doc.empresa_id, doc.chave) });
      const existentes = new Map(existentesDe.all(doc.id).map((d) => [d.codigo, d]));

      for (const a of achadas) {
        const base = {
          severidade: a.severidade, mensagem: a.mensagem, detalhes: JSON.stringify({ ...a.detalhes, fonte_legal: a.fonte_legal }),
          competencia: doc.competencia, regras_versao: REGRAS_VERSAO,
        };
        const ex = existentes.get(a.codigo);
        if (!ex) {
          inserir.run({ ...base, empresa_id: doc.empresa_id, documento_id: doc.id, codigo: a.codigo });
          res.novas++;
        } else {
          // ignorada continua ignorada; resolvida volta a abrir porque a regra voltou a se aplicar
          const status = ex.status === 'ignorada' ? 'ignorada' : 'aberta';
          if (ex.status === 'resolvida') res.reabertas++;
          atualizar.run({ ...base, id: ex.id, status, motivo: status === 'ignorada' ? ex.motivo : null });
        }
        existentes.delete(a.codigo);
      }
      for (const ex of existentes.values()) {
        if (ex.status !== 'aberta') continue;
        atualizar.run({
          id: ex.id, severidade: ex.severidade, mensagem: ex.mensagem, detalhes: ex.detalhes, competencia: ex.competencia,
          regras_versao: REGRAS_VERSAO, status: 'resolvida', motivo: 'A regra deixou de se aplicar (dados da nota atualizados).',
        });
        res.resolvidas++;
      }
      marcarValidado.run(doc.id);
    }
  })();

  res.abertas = repo.contarDivergencias({ empresaId, status: 'aberta' });
  if (auditar) {
    registrarAuditoria(db, { tipo: 'validacao.executada', payload: { empresa_id: empresaId ?? null, regras_versao: REGRAS_VERSAO, ...res } });
  }
  return res;
}
