// Front-end do painel (JS puro, sem framework).
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const moeda = (v) => Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const dataHora = (s) => (s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR') : '—');
const doc = (d) => {
  const c = String(d ?? '').replace(/\D/g, '');
  if (c.length === 14) return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (c.length === 11) return c.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d ?? '—';
};
const PAPEL = { emitida: 'Emitida', recebida: 'Recebida', intermediario: 'Intermediário', outro: 'Outro' };

async function api(url, { metodo = 'GET', corpo } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: { 'X-Buscador': '1', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `Erro HTTP ${r.status}`);
  return dados;
}

function avisar(msg, tipo = 'ok') {
  const el = $('#aviso');
  el.textContent = msg;
  el.className = `aviso ${tipo}`;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => el.classList.add('oculto'), 7000);
}

const arquivoParaBase64 = (f) =>
  new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] ?? '');
    r.onerror = falha;
    r.readAsDataURL(f);
  });

// ---------------- Abas ----------------
let abaAtual = 'empresas';
document.querySelectorAll('[data-aba]').forEach((b) =>
  b.addEventListener('click', () => {
    abaAtual = b.dataset.aba;
    document.querySelectorAll('[data-aba]').forEach((x) => x.classList.toggle('ativa', x === b));
    document.querySelectorAll('.aba').forEach((a) => a.classList.toggle('oculto', a.id !== `aba-${abaAtual}`));
    atualizar();
  }),
);
document.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------------- Resumo ----------------
async function carregarResumo() {
  const r = await api('/api/resumo');
  $('#ambiente').textContent = r.ambiente;
  $('#resumo').innerHTML = [
    ['Empresas', r.empresas], ['Notas', r.documentos], ['Emitidas', r.emitidas], ['Recebidas', r.recebidas], ['Canceladas', r.canceladas],
  ].map(([t, v]) => `<div><b>${esc(v)}</b><span>${t}</span></div>`).join('');
}

// ---------------- Empresas ----------------
let empresas = [];
async function carregarEmpresas() {
  empresas = await api('/api/empresas');
  const sel = $('#filtro-empresa');
  const atual = sel.value;
  sel.innerHTML = '<option value="">Todas as empresas</option>' +
    empresas.map((e) => `<option value="${e.id}">${esc(e.razao_social)}</option>`).join('');
  sel.value = atual;

  $('#lista-empresas').innerHTML = empresas.length
    ? empresas.map((e) => {
        const dias = e.dias_para_vencer;
        const cert = dias == null ? '<span class="tag">?</span>'
          : dias < 0 ? '<span class="tag erro">vencido</span>'
          : dias <= 30 ? `<span class="tag alerta">vence em ${dias}d</span>`
          : `<span class="tag ok">até ${dataBR(e.cert_valido_ate)}</span>`;
        const travada = e.trava_ate && new Date(e.trava_ate) > new Date();
        return `<tr>
          <td>${esc(e.razao_social)} ${e.ativo ? '' : '<span class="tag">inativa</span>'} ${travada ? `<span class="tag alerta" title="Proteção contra consumo indevido">travada até ${esc(dataHora(e.trava_ate))}</span>` : ''}</td>
          <td>${esc(doc(e.cnpj))}</td>
          <td>${cert}</td>
          <td class="num">${esc(e.ultimo_nsu)}</td>
          <td class="num">${esc(e.total_documentos)}</td>
          <td>${esc(dataHora(e.ultima_busca))}</td>
          <td><div class="acoes">
            <button class="mini" data-acao="buscar" data-id="${e.id}" ${e.ativo ? '' : 'disabled'}>▶ Buscar</button>
            <button class="mini secundario" data-acao="notas" data-id="${e.id}">Notas</button>
            <button class="mini secundario" data-acao="conciliar" data-id="${e.id}">Conciliar</button>
            <button class="mini secundario" data-acao="importar" data-id="${e.id}">Importar XML</button>
            ${travada ? `<button class="mini secundario" data-acao="destravar" data-id="${e.id}">Destravar</button>` : ''}
            <button class="mini secundario" data-acao="ativo" data-id="${e.id}" data-ativo="${e.ativo ? 0 : 1}">${e.ativo ? 'Desativar' : 'Ativar'}</button>
            <button class="mini secundario perigo" data-acao="excluir" data-id="${e.id}">Excluir</button>
          </div></td></tr>`;
      }).join('')
    : '<tr><td colspan="7" class="vazio">Nenhuma empresa cadastrada. Clique em “+ Nova empresa”.</td></tr>';
}

let empresaSelecionada = null;
$('#lista-empresas').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-acao]');
  if (!b) return;
  const id = Number(b.dataset.id);
  const emp = empresas.find((e) => e.id === id);
  try {
    switch (b.dataset.acao) {
      case 'buscar':
        avisar((await api(`/api/empresas/${id}/buscar`, { metodo: 'POST' })).mensagem);
        setTimeout(atualizar, 800);
        break;
      case 'notas':
        $('#filtro-empresa').value = String(id);
        document.querySelector('[data-aba="notas"]').click();
        break;
      case 'conciliar': {
        empresaSelecionada = id;
        const f = $('#form-conciliar');
        const hoje = new Date();
        f.de.value = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1).toISOString().slice(0, 10);
        f.ate.value = new Date(hoje.getFullYear(), hoje.getMonth(), 0).toISOString().slice(0, 10);
        $('#dlg-conciliar').showModal();
        break;
      }
      case 'importar':
        empresaSelecionada = id;
        $('#arquivo-importar').click();
        break;
      case 'destravar':
        await api(`/api/empresas/${id}/destravar`, { metodo: 'POST' });
        atualizar();
        break;
      case 'ativo':
        await api(`/api/empresas/${id}`, { metodo: 'PATCH', corpo: { ativo: b.dataset.ativo === '1' } });
        atualizar();
        break;
      case 'excluir':
        if (!confirm(`Excluir "${emp.razao_social}" e todas as notas do banco?`)) return;
        await api(`/api/empresas/${id}?apagarXml=${confirm('Apagar também os XMLs salvos em disco?') ? 1 : 0}`, { metodo: 'DELETE' });
        avisar('Empresa excluída.');
        atualizar();
        break;
    }
  } catch (e) {
    avisar(e.message, 'erro');
  }
});

$('#btn-nova-empresa').addEventListener('click', () => {
  $('#form-empresa').reset();
  $('#erro-empresa').textContent = '';
  $('#dlg-empresa').showModal();
});

$('#form-empresa').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const botao = f.querySelector('button[type=submit]');
  botao.disabled = true;
  try {
    const r = await api('/api/empresas', {
      metodo: 'POST',
      corpo: { pfxBase64: await arquivoParaBase64(f.pfx.files[0]), senha: f.senha.value, cnpj: f.cnpj.value, razaoSocial: f.razaoSocial.value },
    });
    $('#dlg-empresa').close();
    avisar(`Empresa ${r.empresa.razao_social} salva. Certificado válido até ${dataBR(r.certificado.validoAte)}.`);
    atualizar();
  } catch (e) {
    $('#erro-empresa').textContent = e.message;
  } finally {
    botao.disabled = false;
  }
});

$('#form-conciliar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api(`/api/empresas/${empresaSelecionada}/conciliar`, { metodo: 'POST', corpo: { de: f.de.value, ate: f.ate.value } });
    $('#dlg-conciliar').close();
    avisar(r.mensagem + ' Acompanhe na aba Execuções.');
  } catch (e) {
    avisar(e.message, 'erro');
  }
});

$('#arquivo-importar').addEventListener('change', async (ev) => {
  const arquivos = [...ev.target.files];
  ev.target.value = '';
  if (!arquivos.length) return;
  try {
    const corpo = { arquivos: await Promise.all(arquivos.map(async (a) => ({ nome: a.name, conteudoBase64: await arquivoParaBase64(a) }))) };
    const r = await api(`/api/empresas/${empresaSelecionada}/importar`, { metodo: 'POST', corpo });
    avisar(`${r.novos} nota(s) nova(s) de ${r.total} arquivo(s).${r.erros.length ? ' Erros: ' + r.erros.join(' | ') : ''}`, r.erros.length ? 'erro' : 'ok');
    atualizar();
  } catch (e) {
    avisar(e.message, 'erro');
  }
});

$('#btn-buscar-todas').addEventListener('click', async () => {
  try {
    avisar((await api('/api/buscar-todas', { metodo: 'POST' })).mensagem);
    setTimeout(atualizar, 800);
  } catch (e) {
    avisar(e.message, 'erro');
  }
});

// ---------------- Notas ----------------
const POR_PAGINA = 100;
let pagina = 0;
const paramsFiltro = () => {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData($('#filtros'))) if (v) p.set(k, v);
  return p;
};

async function carregarNotas() {
  const p = paramsFiltro();
  p.set('limite', POR_PAGINA);
  p.set('offset', pagina * POR_PAGINA);
  const { itens, totais } = await api(`/api/documentos?${p}`);
  $('#totais').innerHTML = `<span><b>${totais.quantidade}</b> nota(s)</span>
    <span>Serviços: <b>${moeda(totais.valor_servico)}</b></span><span>ISS: <b>${moeda(totais.valor_iss)}</b></span>
    <span>Retenções: <b>${moeda(totais.valor_retencoes)}</b></span><span>Líquido: <b>${moeda(totais.valor_liquido)}</b></span>`;
  $('#lista-notas').innerHTML = itens.length
    ? itens.map((d) => `<tr>
        <td>${dataBR(d.competencia)}</td>
        <td>${esc(d.numero)}</td>
        <td class="nome">${PAPEL[d.papel] ?? esc(d.papel)}<span class="sub">${esc(d.empresa_nome)}</span></td>
        <td class="nome">${esc(d.prestador_nome)}<span class="sub">${esc(doc(d.prestador_doc))}</span></td>
        <td class="nome">${esc(d.tomador_nome ?? '—')}<span class="sub">${esc(d.tomador_doc ? doc(d.tomador_doc) : '')}</span></td>
        <td class="num">${moeda(d.valor_servico)}</td>
        <td class="num">${moeda(d.valor_iss)}${d.iss_retido ? '<span class="sub">retido</span>' : ''}</td>
        <td class="num">${moeda(d.valor_total_retencoes)}</td>
        <td class="num">${moeda(d.valor_liquido)}</td>
        <td>${d.situacao === 'normal' ? '<span class="tag ok">normal</span>' : `<span class="tag erro">${esc(d.situacao)}</span>`}</td>
        <td><div class="acoes">
          <button class="mini secundario" data-ver="${d.id}">Detalhes</button>
          <a class="mini" href="/api/documentos/${d.id}/xml">XML</a>
          <a class="mini" href="/api/documentos/${d.id}/pdf">PDF</a>
        </div></td></tr>`).join('')
    : '<tr><td colspan="11" class="vazio">Nenhuma nota encontrada.</td></tr>';
  const total = totais.quantidade;
  $('#pag-info').textContent = total ? `${pagina * POR_PAGINA + 1}–${Math.min((pagina + 1) * POR_PAGINA, total)} de ${total}` : '';
  $('#pag-ant').disabled = pagina === 0;
  $('#pag-prox').disabled = (pagina + 1) * POR_PAGINA >= total;
}

$('#filtros').addEventListener('submit', (ev) => {
  ev.preventDefault();
  pagina = 0;
  carregarNotas().catch((e) => avisar(e.message, 'erro'));
});
$('#pag-ant').addEventListener('click', () => { pagina--; carregarNotas(); });
$('#pag-prox').addEventListener('click', () => { pagina++; carregarNotas(); });
$('#btn-csv').addEventListener('click', () => { location.href = `/api/exportar/csv?${paramsFiltro()}`; });
$('#btn-zip').addEventListener('click', async () => {
  const p = paramsFiltro();
  if ($('#zip-pdf').checked) p.set('pdf', '1');
  // checa antes para mostrar erro amigável se não houver notas
  const { totais } = await api(`/api/documentos?${paramsFiltro()}&limite=1`);
  if (!totais.quantidade) return avisar('Nenhuma nota para exportar com esses filtros.', 'erro');
  location.href = `/api/exportar/zip?${p}`;
});

$('#lista-notas').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-ver]');
  if (!b) return;
  const d = await api(`/api/documentos/${b.dataset.ver}`);
  const linhas = [
    ['Chave', d.chave], ['Número', d.numero], ['Emissão', dataHora(d.data_emissao)], ['Competência', dataBR(d.competencia)],
    ['Origem', d.origem], ['NSU', d.nsu], ['Prestador', `${d.prestador_nome ?? ''} — ${doc(d.prestador_doc)}`],
    ['Tomador', `${d.tomador_nome ?? '—'} ${d.tomador_doc ? '— ' + doc(d.tomador_doc) : ''}`],
    ['Município incidência', d.municipio_incidencia], ['Serviço', `${d.codigo_servico ?? ''} ${d.descricao ?? ''}`],
    ['Valor do serviço', moeda(d.valor_servico)], ['Deduções', moeda(d.valor_deducoes)], ['Base de cálculo', moeda(d.base_calculo)],
    ['Alíquota', `${d.aliquota}%`], ['ISS', `${moeda(d.valor_iss)}${d.iss_retido ? ' (retido)' : ''}`],
    ['PIS / COFINS', `${moeda(d.valor_pis)} / ${moeda(d.valor_cofins)}${d.pis_cofins_retido ? ' (retidos)' : ''}`],
    ['CSLL / IRRF / INSS', `${moeda(d.valor_csll)} / ${moeda(d.valor_irrf)} / ${moeda(d.valor_inss)}`],
    ['Total retenções', moeda(d.valor_total_retencoes)], ['Valor líquido', moeda(d.valor_liquido)], ['Situação', d.situacao],
  ];
  $('#detalhe-nota').innerHTML = `<h3>NFS-e ${esc(d.numero ?? '')}</h3>
    <dl class="detalhe">${linhas.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${d.eventos.length ? `<h4>Eventos</h4><ul>${d.eventos.map((e) => `<li>${esc(dataHora(e.data_evento))} — ${esc(e.tipo_evento)} ${esc(e.descricao)}</li>`).join('')}</ul>` : ''}`;
  $('#dlg-nota').showModal();
});

// ---------------- Execuções ----------------
let haExecutando = false;
async function carregarExecucoes() {
  const lista = await api('/api/execucoes?limite=50');
  haExecutando = lista.some((x) => x.status === 'executando');
  const cls = { ok: 'ok', erro: 'erro', travada: 'alerta', executando: 'alerta' };
  $('#lista-execucoes').innerHTML = lista.length
    ? lista.map((x) => `<tr>
        <td>${x.id}</td><td>${esc(x.empresa_nome ?? '—')}</td><td>${esc(x.tipo)}</td>
        <td><span class="tag ${cls[x.status] ?? ''}">${esc(x.status)}</span></td>
        <td>${esc(dataHora(x.inicio))}</td><td>${esc(dataHora(x.fim))}</td>
        <td class="num">${x.lotes ?? 0}</td><td class="num">${x.novos ?? 0}</td><td class="quebra">${esc(x.mensagem ?? '')}</td></tr>`).join('')
    : '<tr><td colspan="9" class="vazio">Nenhuma execução ainda.</td></tr>';
}

// ---------------- Encerrar ----------------
$('#btn-encerrar').addEventListener('click', async () => {
  const rodando = haExecutando ? '\n\nATENÇÃO: há uma busca em andamento; ela será interrompida e continua de onde parou na próxima vez.' : '';
  if (!confirm('Encerrar o Buscador NFS-e?' + rodando)) return;
  try {
    await api('/api/encerrar', { metodo: 'POST' });
  } catch (e) {
    return avisar(e.message, 'erro');
  }
  encerrado = true;
  document.querySelectorAll('main, .resumo, .topo nav').forEach((el) => el.classList.add('oculto'));
  $('#tela-encerrado').classList.remove('oculto');
});
let encerrado = false;

// ---------------- Ciclo ----------------
async function atualizar() {
  try {
    await carregarResumo();
    await carregarEmpresas();
    await carregarExecucoes();
    if (abaAtual === 'notas') await carregarNotas();
  } catch (e) {
    avisar(e.message, 'erro');
  }
}
setInterval(() => { if (haExecutando && !encerrado) atualizar(); }, 3000);
atualizar();
