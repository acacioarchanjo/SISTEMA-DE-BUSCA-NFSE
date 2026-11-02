// Front-end do painel (JS puro, sem framework).
import { lerPlanilhaSenhas, senhaPara } from './compartilhado/senhas.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const moeda = (v) => Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const moedaCurta = (v) => Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', notation: Math.abs(v) >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(v) >= 1e6 ? 1 : 2 });
const numero = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const dataBR = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const paraData = (s) => (s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') : null);
const dataHora = (s) => (s ? paraData(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const doc = (d) => {
  const c = String(d ?? '').replace(/\D/g, '');
  if (c.length === 14) return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (c.length === 11) return c.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d || '—';
};
const icone = (nome) => `<svg><use href="#i-${nome}"/></svg>`;
const PAPEL = { emitida: 'Emitida', recebida: 'Recebida', intermediario: 'Intermediário', outro: 'Outro' };
const TIPO_EXEC = { busca_adn: 'Busca no ADN', conciliacao: 'Conciliação', busca_municipal: 'Busca na prefeitura' };
const STATUS_EXEC = { ok: 'Concluída', erro: 'Erro', travada: 'Travada', executando: 'Executando' };
const SEVERIDADE = { BLOQUEANTE: 'Bloqueante', ALERTA: 'Alerta', INFO: 'Informativa' };
const STATUS_DIV = { aberta: 'aberta', ignorada: 'ignorada', resolvida: 'resolvida' };
// Catálogo de status e regras (carregado do servidor uma vez)
let catalogo = { status: {}, subcodigos: {}, regras: [] };
const infoStatus = (x) => catalogo.status[x.codigo] ?? { rotulo: STATUS_EXEC[x.status] ?? x.status, tipo: x.status };
const classeStatus = (tipo) => ({ ok: 'ok', alerta: 'alerta', erro: 'erro', executando: 'executando', neutro: '' })[tipo] ?? '';

function relativo(s) {
  const d = paraData(s);
  if (!d) return '—';
  const seg = Math.round((Date.now() - d) / 1000);
  if (seg < 60) return 'agora';
  if (seg < 3600) return `há ${Math.floor(seg / 60)} min`;
  if (seg < 86400) return `há ${Math.floor(seg / 3600)} h`;
  if (seg < 86400 * 7) return `há ${Math.floor(seg / 86400)} d`;
  return dataHora(s);
}
function duracao(ini, fim) {
  const a = paraData(ini);
  const b = fim ? paraData(fim) : new Date();
  if (!a) return '—';
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}min ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`;
}
const iniciais = (nome) =>
  String(nome || '?').replace(/\b(LTDA|ME|EPP|S\/?A|EIRELI)\b\.?/gi, '').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

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

// ---------------- Avisos (toasts) ----------------
function avisar(msg, tipo = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.innerHTML = `<span class="ic">${icone(tipo === 'erro' ? 'alert' : 'check')}</span><p>${esc(msg)}</p><button title="Fechar">${icone('x')}</button>`;
  const fechar = () => { el.classList.add('saindo'); setTimeout(() => el.remove(), 250); };
  el.querySelector('button').addEventListener('click', fechar);
  const caixa = $('#toasts');
  caixa.append(el);
  // Traz os avisos para a frente de janelas abertas (diálogos ficam na "top layer").
  if (caixa.showPopover) { try { caixa.hidePopover(); } catch { /* fechado */ } caixa.showPopover(); }
  setTimeout(fechar, tipo === 'erro' ? 10000 : 6000);
}

const arquivoParaBase64 = (f) =>
  new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] ?? '');
    r.onerror = falha;
    r.readAsDataURL(f);
  });

// ---------------- Tema ----------------
const lerTema = () => { try { return localStorage.getItem('tema'); } catch { return null; } };
function aplicarTema(t) {
  if (t) document.documentElement.dataset.tema = t;
  else delete document.documentElement.dataset.tema;
  const escuro = t ? t === 'escuro' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('#btn-tema').innerHTML = `${icone(escuro ? 'sun' : 'moon')}<span>${escuro ? 'Tema claro' : 'Tema escuro'}</span>`;
}
aplicarTema(lerTema());
$('#btn-tema').addEventListener('click', () => {
  const atual = document.documentElement.dataset.tema || (matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro');
  const novo = atual === 'escuro' ? 'claro' : 'escuro';
  try { localStorage.setItem('tema', novo); } catch { /* sem armazenamento */ }
  aplicarTema(novo);
});

// ---------------- Navegação ----------------
let abaAtual = 'inicio';
function irPara(aba) {
  abaAtual = aba;
  $$('.menu [data-aba]').forEach((x) => x.classList.toggle('ativa', x.dataset.aba === aba));
  $$('.aba').forEach((a) => a.classList.toggle('oculto', a.id !== `aba-${aba}`));
  window.scrollTo({ top: 0 });
  atualizar();
}
$$('[data-aba]').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.aba)));
document.addEventListener('click', (ev) => {
  const ir = ev.target.closest('[data-ir]');
  if (ir) irPara(ir.dataset.ir);
  if (ev.target.closest('[data-nova-empresa]')) abrirNovaEmpresa();
  // fecha menus "mais ações" ao clicar fora
  $$('details.mais[open]').forEach((d) => { if (!d.contains(ev.target)) d.open = false; });
});
$$('[data-fechar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog').forEach((d) => d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); })); // clique no fundo fecha

// ---------------- Início ----------------
function saudacao() {
  const h = new Date().getHours();
  $('#saudacao').textContent = h < 12 ? 'Bom dia!' : h < 18 ? 'Boa tarde!' : 'Boa noite!';
}

async function carregarInicio(resumo) {
  saudacao();
  const [emit, receb] = await Promise.all([
    api('/api/documentos?papel=emitida&limite=1'),
    api('/api/documentos?papel=recebida&limite=1'),
  ]);
  const kpis = [
    ['', 'building', 'Empresas', numero(resumo.empresas), 'com certificado cadastrado'],
    ['info', 'file', 'Notas baixadas', numero(resumo.documentos), `${numero(resumo.emitidas)} emitidas · ${numero(resumo.recebidas)} recebidas`],
    ['ok', 'arrow-up', 'Serviços prestados', moedaCurta(emit.totais.valor_servico), `retenções ${moedaCurta(emit.totais.valor_retencoes)}`],
    ['', 'arrow-down', 'Serviços tomados', moedaCurta(receb.totais.valor_servico), `ISS ${moedaCurta(receb.totais.valor_iss)}`],
    ['erro', 'x', 'Canceladas', numero(resumo.canceladas), 'notas com evento de cancelamento'],
    [resumo.divergencias_bloqueantes ? 'erro' : resumo.divergencias_alertas ? 'alerta' : 'ok', 'shield', 'Conferência fiscal',
      numero(resumo.divergencias_bloqueantes),
      resumo.divergencias_bloqueantes || resumo.divergencias_alertas
        ? `bloqueante(s) · ${numero(resumo.divergencias_alertas)} alerta(s)`
        : 'nenhuma pendência'],
  ];
  $('#kpis').innerHTML = kpis
    .map(([cls, ic, t, v, s]) => `<div class="cartao kpi ${cls}" ${t === 'Conferência fiscal' ? 'data-ir="conferencia" role="button" tabindex="0"' : ''}><div class="kpi-topo"><span class="kpi-icone">${icone(ic)}</span>${t}</div><b>${esc(v)}</b><small>${esc(s)}</small></div>`)
    .join('');
  $('#boas-vindas').classList.toggle('oculto', resumo.empresas > 0);

  // Alertas
  const alertas = [];
  if (resumo.divergencias_bloqueantes)
    alertas.push(['erro', 'shield', `${numero(resumo.divergencias_bloqueantes)} divergência(s) fiscal(is) bloqueante(s)`, 'Retenção, alíquota ou cancelamento a conferir antes de fechar a competência. Abra “Conferência”.']);
  for (const e of empresas) {
    const d = e.dias_para_vencer;
    if (d != null && d < 0) alertas.push(['erro', 'alert', `Certificado vencido — ${e.razao_social}`, 'Cadastre o certificado novo em “Nova empresa”.']);
    else if (d != null && d <= 30) alertas.push(['alerta', 'alert', `Certificado vence em ${d} dia(s) — ${e.razao_social}`, `Válido até ${dataBR(e.cert_valido_ate)}.`]);
    if (e.trava_ate && new Date(e.trava_ate) > new Date())
      alertas.push(['alerta', 'alert', `Busca pausada — ${e.razao_social}`, `Proteção contra consumo indevido até ${dataHora(e.trava_ate)}.`]);
    const ult = execucoes.find((x) => x.empresa_id === e.id && x.status !== 'executando');
    if (ult?.status === 'erro') {
      const info = infoStatus(ult);
      alertas.push(['erro', 'alert', `${info.rotulo} — ${e.razao_social}`, info.acao ?? ult.mensagem ?? '']);
    }
  }
  $('#alertas').innerHTML = alertas.length
    ? alertas.map(([c, ic, t, s]) => `<li class="${c}"><span class="ic">${icone(ic)}</span><div><b>${esc(t)}</b><span>${esc(s)}</span></div></li>`).join('')
    : `<li class="ok"><span class="ic">${icone('check')}</span><div><b>Tudo certo</b><span>Nenhum certificado vencendo e nenhuma busca com erro.</span></div></li>`;

  // Últimas execuções
  const ult = execucoes.slice(0, 6);
  $('#ultimas-execucoes').innerHTML = ult.length
    ? ult.map((x) => `<li class="${classeStatus(infoStatus(x).tipo)}"><span class="marcador"></span><div class="texto"><b>${esc(x.empresa_nome ?? '—')} · ${esc(infoStatus(x).rotulo)}</b><span>${esc(TIPO_EXEC[x.tipo] ?? x.tipo)} · ${esc(x.status === 'executando' ? 'em andamento…' : x.mensagem ?? '')}</span></div><time>${esc(relativo(x.inicio))}</time></li>`).join('')
    : '<li class="vazio-mini">Nenhuma busca ainda.</li>';
}

// ---------------- Empresas ----------------
let empresas = [];
async function carregarEmpresas() {
  empresas = await api('/api/empresas');
  $('#cont-empresas').textContent = empresas.length || '';
  const sel = $('#filtro-empresa');
  const atual = sel.value;
  sel.innerHTML = '<option value="">Todas as empresas</option>' + empresas.map((e) => `<option value="${e.id}">${esc(e.razao_social)}</option>`).join('');
  sel.value = atual;
  const selConf = $('#conf-empresa');
  const atualConf = selConf.value;
  selConf.innerHTML = sel.innerHTML;
  selConf.value = atualConf;

  $('#lista-empresas').innerHTML = empresas.length
    ? empresas.map(cartaoEmpresa).join('')
    : `<div class="cartao vazio-grande">${icone('building')}<h3>Nenhuma empresa cadastrada</h3><p>Cadastre o certificado A1 de uma empresa para começar a baixar as notas.</p><button class="botao" data-nova-empresa>${icone('plus')}Nova empresa</button></div>`;
}

function cartaoEmpresa(e) {
  const d = e.dias_para_vencer;
  const cert = d == null ? '<span class="pilula">certificado ?</span>'
    : d < 0 ? '<span class="pilula erro">certificado vencido</span>'
    : d <= 30 ? `<span class="pilula alerta">vence em ${d}d</span>`
    : `<span class="pilula ok">válido até ${dataBR(e.cert_valido_ate)}</span>`;
  const travada = e.trava_ate && new Date(e.trava_ate) > new Date();
  const rodando = execucoes.some((x) => x.empresa_id === e.id && x.status === 'executando');
  return `<article class="cartao empresa ${e.ativo ? '' : 'inativa'}">
    <div class="empresa-topo">
      <span class="avatar">${esc(iniciais(e.razao_social))}</span>
      <div class="empresa-nome"><b title="${esc(e.razao_social)}">${esc(e.razao_social)}</b><span>${esc(doc(e.cnpj))}</span></div>
    </div>
    <div class="empresa-selos">${cert}
      ${e.ativo ? '' : '<span class="pilula">inativa</span>'}
      ${travada ? `<span class="pilula alerta" title="Proteção contra consumo indevido">pausada até ${esc(dataHora(e.trava_ate))}</span>` : ''}
      ${rodando ? '<span class="pilula executando">buscando…</span>' : ''}
      ${e.prefeituras ? `<span class="pilula primaria sem-ponto" title="Prefeituras com webservice consultadas">+ ${e.prefeituras} prefeitura(s)</span>` : ''}
    </div>
    <div class="empresa-numeros">
      <div><small>Notas</small><b>${numero(e.total_documentos)}</b></div>
      <div><small>Último NSU</small><b>${numero(e.ultimo_nsu)}</b></div>
      <div><small>Última busca</small><b title="${esc(dataHora(e.ultima_busca))}">${esc(e.ultima_busca ? relativo(e.ultima_busca) : 'nunca')}</b></div>
    </div>
    <div class="empresa-acoes">
      <button class="botao" data-acao="buscar" data-id="${e.id}" ${e.ativo && !rodando ? '' : 'disabled'}>${icone('play')}${rodando ? 'Buscando…' : 'Buscar notas'}</button>
      <button class="botao secundario" data-acao="notas" data-id="${e.id}">Ver notas</button>
      <details class="mais">
        <summary class="botao secundario icone-so" title="Mais ações">${icone('dots')}</summary>
        <div class="mais-menu">
          <button class="botao-fantasma" data-acao="prefeituras" data-id="${e.id}">Prefeituras (webservice municipal)…</button>
          <button class="botao-fantasma" data-acao="conciliar" data-id="${e.id}">Conciliar com o portal</button>
          <button class="botao-fantasma" data-acao="importar" data-id="${e.id}">Importar XMLs</button>
          ${travada ? `<button class="botao-fantasma" data-acao="destravar" data-id="${e.id}">Liberar busca agora</button>` : ''}
          <button class="botao-fantasma" data-acao="ativo" data-id="${e.id}" data-ativo="${e.ativo ? 0 : 1}">${e.ativo ? 'Desativar empresa' : 'Ativar empresa'}</button>
          <hr>
          <button class="botao-fantasma perigo" data-acao="excluir" data-id="${e.id}">Excluir empresa</button>
        </div>
      </details>
    </div>
  </article>`;
}

let empresaSelecionada = null;
$('#lista-empresas').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-acao]');
  if (!b) return;
  b.closest('details')?.removeAttribute('open');
  const id = Number(b.dataset.id);
  const emp = empresas.find((e) => e.id === id);
  try {
    switch (b.dataset.acao) {
      case 'buscar':
        avisar((await api(`/api/empresas/${id}/buscar`, { metodo: 'POST' })).mensagem + ' Acompanhe em Execuções.');
        setTimeout(atualizar, 600);
        break;
      case 'notas':
        $('#filtro-empresa').value = String(id);
        irPara('notas');
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
      case 'prefeituras':
        await abrirPrefeituras(id);
        break;
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

// Nova empresa (com arrastar e soltar do .pfx)
function abrirNovaEmpresa() {
  $('#form-empresa').reset();
  $('#erro-empresa').textContent = '';
  $('#area-pfx').classList.remove('escolhido');
  $('#nome-pfx').innerHTML = '<b>Escolha o certificado</b> ou arraste aqui<br><small>.pfx ou .p12</small>';
  $('#dlg-empresa').showModal();
}
$('#btn-nova-empresa').addEventListener('click', abrirNovaEmpresa);

const inputPfx = $('#form-empresa').pfx;
function mostrarPfx() {
  const f = inputPfx.files[0];
  $('#area-pfx').classList.toggle('escolhido', !!f);
  if (f) $('#nome-pfx').innerHTML = `<b>${esc(f.name)}</b><br><small>${(f.size / 1024).toFixed(1)} KB · clique para trocar</small>`;
}
inputPfx.addEventListener('change', mostrarPfx);
const area = $('#area-pfx');
['dragenter', 'dragover'].forEach((t) => area.addEventListener(t, (ev) => { ev.preventDefault(); area.classList.add('arrastando'); }));
['dragleave', 'drop'].forEach((t) => area.addEventListener(t, () => area.classList.remove('arrastando')));
area.addEventListener('drop', (ev) => {
  ev.preventDefault();
  if (ev.dataTransfer.files.length) {
    inputPfx.files = ev.dataTransfer.files;
    mostrarPfx();
  }
});

$('#form-empresa').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const botao = f.querySelector('button[type=submit]');
  botao.disabled = true;
  botao.textContent = 'Validando certificado…';
  try {
    const r = await api('/api/empresas', {
      metodo: 'POST',
      corpo: { pfxBase64: await arquivoParaBase64(f.pfx.files[0]), senha: f.senha.value, cnpj: f.cnpj.value, razaoSocial: f.razaoSocial.value },
    });
    $('#dlg-empresa').close();
    avisar(`${r.empresa.razao_social} cadastrada. Certificado válido até ${dataBR(r.certificado.validoAte)}.`);
    irPara('empresas');
  } catch (e) {
    $('#erro-empresa').textContent = e.message;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Salvar empresa';
  }
});

$('#form-conciliar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api(`/api/empresas/${empresaSelecionada}/conciliar`, { metodo: 'POST', corpo: { de: f.de.value, ate: f.ate.value } });
    $('#dlg-conciliar').close();
    avisar(r.mensagem + ' Acompanhe em Execuções.');
    setTimeout(atualizar, 600);
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

async function buscarTodas() {
  try {
    avisar((await api('/api/buscar-todas', { metodo: 'POST' })).mensagem);
    setTimeout(atualizar, 600);
  } catch (e) {
    avisar(e.message, 'erro');
  }
}
$('#btn-buscar-todas').addEventListener('click', buscarTodas);
$('#btn-buscar-todas-inicio').addEventListener('click', buscarTodas);

// ---------------- Notas ----------------
const POR_PAGINA = 100;
let pagina = 0;
const paramsFiltro = () => {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData($('#filtros'))) if (v) p.set(k, v);
  return p;
};

function pontoConferencia(d) {
  if (d.div_bloqueantes) return `<span class="conf-ponto BLOQUEANTE" title="${d.div_bloqueantes} divergência(s) bloqueante(s)">${d.div_bloqueantes}</span>`;
  if (d.div_alertas) return `<span class="conf-ponto ALERTA" title="${d.div_alertas} alerta(s)">${d.div_alertas}</span>`;
  if (d.div_info) return `<span class="conf-ponto INFO" title="${d.div_info} informativa(s)">${d.div_info}</span>`;
  return d.validado_em ? `<span class="conf-ponto ok" title="Conferida sem divergências">${icone('check')}</span>` : '<span class="sub" title="Ainda não conferida">—</span>';
}

async function carregarNotas() {
  const p = paramsFiltro();
  p.set('limite', POR_PAGINA);
  p.set('offset', pagina * POR_PAGINA);
  const { itens, totais } = await api(`/api/documentos?${p}`);
  const chip = (t, v) => `<div class="chip"><small>${t}</small><b>${v}</b></div>`;
  $('#totais').innerHTML =
    chip('Notas', numero(totais.quantidade)) + chip('Valor dos serviços', moeda(totais.valor_servico)) +
    chip('ISS', moeda(totais.valor_iss)) + chip('Retenções', moeda(totais.valor_retencoes)) + chip('Valor líquido', moeda(totais.valor_liquido));

  $('#lista-notas').innerHTML = itens.length
    ? itens.map((d) => `<tr class="${d.situacao !== 'normal' ? 'cancelada-linha' : ''}">
        <td>${dataBR(d.competencia)}</td>
        <td><b>${esc(d.numero ?? '—')}</b><span class="sub papel ${esc(d.papel)}">${icone(d.papel === 'recebida' ? 'arrow-down' : 'arrow-up')}${esc(PAPEL[d.papel] ?? d.papel)}</span></td>
        <td class="nome"><b>${esc(d.prestador_nome ?? '—')}</b><span class="sub">${esc(doc(d.prestador_doc))}</span></td>
        <td class="nome"><b>${esc(d.tomador_nome ?? '—')}</b><span class="sub">${esc(d.tomador_doc ? doc(d.tomador_doc) : '')}</span></td>
        <td class="num">${moeda(d.valor_servico)}</td>
        <td class="num">${moeda(d.valor_iss)}${d.iss_retido ? '<span class="sub">retido</span>' : ''}</td>
        <td class="num col-ret">${moeda(d.valor_total_retencoes)}</td>
        <td class="num"><b>${moeda(d.valor_liquido)}</b></td>
        <td><div class="situacao-conf">${d.situacao === 'normal' ? '<span class="pilula ok">normal</span>' : `<span class="pilula erro">${esc(d.situacao)}</span>`}${pontoConferencia(d)}</div></td>
        <td><div class="acoes">
          <button class="icone-acao" data-ver="${d.id}" title="Detalhes">${icone('search')}</button>
          <a class="icone-acao" href="/api/documentos/${d.id}/xml" title="Baixar XML">XML</a>
          <a class="icone-acao" href="/api/documentos/${d.id}/pdf" title="Baixar PDF">PDF</a>
        </div></td></tr>`).join('')
    : '<tr><td colspan="10" class="vazio">Nenhuma nota encontrada com esses filtros.</td></tr>';
  const total = totais.quantidade;
  $('#pag-info').textContent = total ? `${numero(pagina * POR_PAGINA + 1)}–${numero(Math.min((pagina + 1) * POR_PAGINA, total))} de ${numero(total)}` : '';
  $('#pag-ant').disabled = pagina === 0;
  $('#pag-prox').disabled = (pagina + 1) * POR_PAGINA >= total;
}

$('#filtros').addEventListener('submit', (ev) => {
  ev.preventDefault();
  pagina = 0;
  carregarNotas().catch((e) => avisar(e.message, 'erro'));
});
$$('#filtros input[type=radio], #filtros select').forEach((el) =>
  el.addEventListener('change', () => { pagina = 0; carregarNotas().catch((e) => avisar(e.message, 'erro')); }),
);
$('#pag-ant').addEventListener('click', () => { pagina--; carregarNotas(); });
$('#pag-prox').addEventListener('click', () => { pagina++; carregarNotas(); });
$('#btn-csv').addEventListener('click', () => { location.href = `/api/exportar/csv?${paramsFiltro()}`; });
$('#btn-zip').addEventListener('click', async () => {
  const p = paramsFiltro();
  if ($('#zip-pdf').checked) p.set('pdf', '1');
  const { totais } = await api(`/api/documentos?${paramsFiltro()}&limite=1`);
  if (!totais.quantidade) return avisar('Nenhuma nota para exportar com esses filtros.', 'erro');
  avisar(`Gerando ZIP com ${numero(totais.quantidade)} nota(s)…`);
  location.href = `/api/exportar/zip?${p}`;
});

$('#lista-notas').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-ver]');
  if (!b) return;
  try {
    abrirNota(await api(`/api/documentos/${b.dataset.ver}`));
  } catch (e) {
    avisar(e.message, 'erro');
  }
});

function abrirNota(d) {
  const dl = (linhas) => `<dl class="detalhe">${linhas.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  $('#titulo-nota').textContent = `NFS-e nº ${d.numero ?? '—'}`;
  $('#detalhe-nota').innerHTML = `
    <div class="nota-cabecalho">
      <small class="sub">Valor líquido</small>
      <div class="valor">${moeda(d.valor_liquido)}</div>
      <div class="linha">
        <span class="pilula ${d.papel === 'emitida' ? 'ok' : 'primaria'}">${esc(PAPEL[d.papel] ?? d.papel)}</span>
        <span class="pilula ${d.situacao === 'normal' ? 'ok' : 'erro'}">${esc(d.situacao)}</span>
        <span class="pilula sem-ponto">competência ${dataBR(d.competencia)}</span>
      </div>
    </div>
    ${d.divergencias?.length ? `<div class="secao-nota"><h4>Conferência fiscal</h4><div class="lista-div">${d.divergencias.map((v) => itemDivergencia({ ...v, empresa_nome: undefined })).join('')}</div></div>`
      : `<div class="secao-nota"><h4>Conferência fiscal</h4><p class="sub">${d.validado_em ? '✓ Nenhuma divergência nas regras nacionais.' : 'Ainda não conferida.'}</p></div>`}
    <div class="secao-nota"><h4>Partes</h4>${dl([
      ['Prestador', `${esc(d.prestador_nome ?? '—')}<span class="sub">${esc(doc(d.prestador_doc))}</span>`],
      ['Tomador', `${esc(d.tomador_nome ?? '—')}<span class="sub">${esc(d.tomador_doc ? doc(d.tomador_doc) : '')}</span>`],
    ])}</div>
    <div class="secao-nota"><h4>Serviço</h4>${dl([
      ['Código', esc(d.codigo_servico ?? '—')],
      ['Descrição', esc(d.descricao ?? '—')],
      ['Município (ISS)', esc(d.municipio_incidencia ?? '—')],
      ['Emissão', esc(dataHora(d.data_emissao))],
    ])}</div>
    <div class="secao-nota"><h4>Valores</h4>${dl([
      ['Valor do serviço', moeda(d.valor_servico)],
      ['Deduções', moeda(d.valor_deducoes)],
      ['Base de cálculo', moeda(d.base_calculo)],
      ['ISS', `${moeda(d.valor_iss)} · ${esc(d.aliquota)}%${d.iss_retido ? ' <span class="pilula alerta sem-ponto">retido</span>' : ''}`],
      ['PIS / COFINS', `${moeda(d.valor_pis)} / ${moeda(d.valor_cofins)}${d.pis_cofins_retido ? ' <span class="pilula alerta sem-ponto">retidos</span>' : ''}`],
      ['CSLL / IRRF / INSS', `${moeda(d.valor_csll)} / ${moeda(d.valor_irrf)} / ${moeda(d.valor_inss)}`],
      ['Total de retenções', `<b>${moeda(d.valor_total_retencoes)}</b>`],
    ])}</div>
    <div class="secao-nota"><h4>Identificação</h4>${dl([
      [d.sistema === 'abrasf' ? 'Identificador' : 'Chave de acesso', `<span class="chave">${esc(d.chave)}</span>`],
      ...(d.codigo_verificacao ? [['Código de verificação', `<span class="chave">${esc(d.codigo_verificacao)}</span>`]] : []),
      ['Origem', esc({ adn: 'ADN (distribuição)', conciliacao: 'Conciliação', importacao: 'Importação manual', prefeitura: 'Prefeitura (webservice ABRASF)' }[d.origem] ?? d.origem)],
      ['NSU', esc(d.nsu ?? '—')],
    ])}</div>
    ${d.eventos.length ? `<div class="secao-nota"><h4>Eventos</h4><ul class="linha-tempo">${d.eventos
      .map((e) => `<li class="erro"><span class="marcador"></span><div class="texto"><b>${esc(e.descricao)}</b><span>código ${esc(e.tipo_evento)}</span></div><time>${esc(dataHora(e.data_evento))}</time></li>`)
      .join('')}</ul></div>` : ''}
    <div class="acoes">
      <a class="botao secundario" href="/api/documentos/${d.id}/xml">${icone('download')}XML</a>
      <a class="botao secundario" href="/api/documentos/${d.id}/pdf">${icone('download')}PDF</a>
    </div>`;
  $('#dlg-nota').showModal();
}

// ---------------- Execuções ----------------
let execucoes = [];
let haExecutando = false;
async function carregarExecucoes() {
  execucoes = await api('/api/execucoes?limite=50');
  haExecutando = execucoes.some((x) => x.status === 'executando');
  $('#indicador-exec').classList.toggle('oculto', !haExecutando);
  $('#lista-execucoes').innerHTML = execucoes.length
    ? execucoes.map((x) => `<tr class="clicavel" data-exec="${x.id}" title="Ver detalhes">
        <td><span class="pilula ${classeStatus(infoStatus(x).tipo)}" title="${esc(catalogo.subcodigos[x.subcodigo] ?? '')}">${esc(infoStatus(x).rotulo)}</span></td>
        <td class="nome"><b>${esc(x.empresa_nome ?? '—')}</b>${x.municipio_nome ? `<span class="sub">${esc(x.municipio_nome)}</span>` : ''}</td>
        <td>${esc(TIPO_EXEC[x.tipo] ?? x.tipo)}</td>
        <td title="${esc(dataHora(x.inicio))}">${esc(relativo(x.inicio))}</td>
        <td>${esc(duracao(x.inicio, x.fim))}</td>
        <td class="num">${numero(x.lotes)}</td><td class="num">${numero(x.novos)}</td>
        <td class="quebra">${esc(x.mensagem ?? '')}</td></tr>`).join('')
    : '<tr><td colspan="8" class="vazio">Nenhuma execução ainda. Clique em “Buscar notas” numa empresa.</td></tr>';
}

$('#lista-execucoes').addEventListener('click', async (ev) => {
  const tr = ev.target.closest('[data-exec]');
  if (!tr) return;
  try {
    const x = await api(`/api/execucoes/${tr.dataset.exec}`);
    const info = x.catalogo ?? infoStatus(x);
    const det = x.detalhes ?? {};
    const lista = (itens) => `<ul class="lista-simples">${itens.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    const v = det.validacao;
    $('#titulo-exec').textContent = `${TIPO_EXEC[x.tipo] ?? x.tipo} · ${x.empresa_nome ?? ''}`;
    $('#detalhe-exec').innerHTML = `
      <div class="nota-cabecalho">
        <span class="pilula ${classeStatus(info.tipo)}">${esc(info.rotulo)}</span>
        ${x.subcodigo ? `<span class="pilula sem-ponto">${esc(x.subcodigo_descricao ?? x.subcodigo)}</span>` : ''}
        <p>${esc(info.descricao ?? '')}</p>
        ${info.acao ? `<div class="acao-sugerida"><b>O que fazer</b>${esc(info.acao)}</div>` : ''}
      </div>
      <div class="secao-nota"><h4>Resumo</h4><dl class="detalhe">
        <dt>Início</dt><dd>${esc(dataHora(x.inicio))}</dd>
        <dt>Duração</dt><dd>${esc(duracao(x.inicio, x.fim))}</dd>
        ${x.tipo === 'busca_municipal' ? `
        <dt>Prefeitura</dt><dd>${esc(det.municipio?.nome ?? '—')}${det.municipio?.uf ? '/' + esc(det.municipio.uf) : ''} · ${esc(det.perfil ?? '')}</dd>
        <dt>Período</dt><dd>${dataBR(det.periodo?.de)} a ${dataBR(det.periodo?.ate)}</dd>
        <dt>Consultas feitas</dt><dd>${numero(x.lotes)}</dd>
        ${Object.entries(det.por_papel ?? {}).map(([p, v]) => `<dt>Notas ${esc(p)}</dt><dd>${typeof v === 'object' ? `${numero(v.notas)} (${numero(v.novas)} nova(s))` : 'não disponível neste município'}</dd>`).join('')}`
        : `<dt>Lotes / notas novas</dt><dd>${numero(x.lotes)} / ${numero(x.novos)}</dd>
        <dt>Eventos novos</dt><dd>${numero(x.eventos)}</dd>`}
        ${det.cursor ? `<dt>NSU</dt><dd>${numero(det.cursor.de)} → ${numero(det.cursor.ate)}</dd>` : ''}
        ${x.lote_id ? `<dt>Lote</dt><dd><span class="chave">${esc(x.lote_id)}</span></dd>` : ''}
        <dt>Mensagem</dt><dd>${esc(x.mensagem ?? '—')}</dd>
      </dl></div>
      ${v ? `<div class="secao-nota"><h4>Conferência fiscal</h4><dl class="detalhe"><dt>Notas conferidas</dt><dd>${numero(v.documentos)}</dd>
        <dt>Abertas</dt><dd>${numero(v.abertas.BLOQUEANTE)} bloqueante(s) · ${numero(v.abertas.ALERTA)} alerta(s) · ${numero(v.abertas.INFO)} info</dd>
        <dt>Nesta execução</dt><dd>${numero(v.novas)} nova(s) · ${numero(v.resolvidas)} resolvida(s)</dd></dl></div>` : ''}
      ${det.documentos_com_erro?.length ? `<div class="secao-nota"><h4>Documentos com erro</h4>${lista(det.documentos_com_erro)}</div>` : ''}
      ${det.falhas_transitorias?.length ? `<div class="secao-nota"><h4>Falhas temporárias (repetidas automaticamente)</h4>${lista(det.falhas_transitorias.map((f) => `${dataHora(f.em)} — ${f.erro} (nova tentativa em ${Math.round(f.esperaMs / 1000)}s)`))}</div>` : ''}
      ${det.falhas?.length ? `<div class="secao-nota"><h4>Falhas</h4>${lista(det.falhas)}</div>` : ''}
      ${det.resposta ? `<div class="secao-nota"><h4>Resposta da prefeitura (início)</h4><pre class="resposta-bruta">${esc(det.resposta)}</pre></div>` : ''}`;
    $('#dlg-exec').showModal();
  } catch (e) {
    avisar(e.message, 'erro');
  }
});

// Faixa do log de auditoria
async function carregarAuditoria(mostrar = false) {
  const v = await api('/api/auditoria/verificar');
  const faixa = $('#faixa-auditoria');
  faixa.classList.toggle('integra', v.integra);
  faixa.classList.toggle('quebrada', !v.integra);
  $('#aud-texto').textContent = v.integra
    ? `${numero(v.total)} registro(s) · cadeia de hash íntegra ✓`
    : `ATENÇÃO: cadeia quebrada no registro ${v.problemaEm}. ${v.motivo}`;
  if (mostrar) avisar(v.integra ? `Auditoria íntegra: ${numero(v.total)} registro(s) conferidos.` : `Auditoria adulterada no registro ${v.problemaEm}.`, v.integra ? 'ok' : 'erro');
}
$('#btn-aud-verificar').addEventListener('click', () => carregarAuditoria(true).catch((e) => avisar(e.message, 'erro')));

// ---------------- Conferência fiscal ----------------
function itemDivergencia(v) {
  const status = v.status !== 'aberta' ? `<span class="pilula ${v.status === 'resolvida' ? 'ok' : ''}">${esc(STATUS_DIV[v.status] ?? v.status)}</span>` : '';
  const nota = v.empresa_nome !== undefined
    ? `<div class="meta">NFS-e ${esc(v.numero ?? '—')} · ${esc(PAPEL[v.papel] ?? v.papel ?? '')} · competência ${dataBR(v.competencia).slice(3)} · ${esc(v.prestador_nome ?? '')} → ${esc(v.tomador_nome ?? '—')} · ${moeda(v.valor_servico)} · <b>${esc(v.empresa_nome)}</b></div>`
    : '';
  return `<article class="cartao div-item ${esc(v.severidade)}">
    <span class="sev"></span>
    <div>
      <div class="div-topo"><span class="pilula ${esc(v.severidade)}">${esc(SEVERIDADE[v.severidade] ?? v.severidade)}</span><code>${esc(v.codigo)}</code>${status}</div>
      <p>${esc(v.mensagem)}</p>
      ${nota}
      ${v.detalhes?.fonte_legal ? `<div class="meta">Base: ${esc(v.detalhes.fonte_legal)}</div>` : ''}
      ${v.motivo ? `<div class="motivo">${v.status === 'ignorada' ? 'Ignorada: ' : ''}${esc(v.motivo)}</div>` : ''}
    </div>
    <div class="div-acoes">
      ${nota ? `<button class="botao secundario pequeno" data-div-nota="${v.documento_id}">Ver nota</button>` : ''}
      ${v.status === 'aberta' ? `<button class="botao secundario pequeno" data-div-ignorar="${v.id}">Ignorar…</button>` : ''}
      ${v.status === 'ignorada' ? `<button class="botao secundario pequeno" data-div-reabrir="${v.id}">Reabrir</button>` : ''}
    </div>
  </article>`;
}

async function carregarConferencia() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData($('#filtros-conf'))) if (v) p.set(k, v);
  p.set('limite', 300);
  const { itens, total, contagem } = await api(`/api/divergencias?${p}`);
  const kpi = (cls, t, v, s) => `<div class="cartao kpi ${cls}"><div class="kpi-topo"><span class="kpi-icone">${icone('shield')}</span>${t}</div><b>${numero(v)}</b><small>${s}</small></div>`;
  $('#conf-kpis').innerHTML =
    kpi('erro', 'Bloqueantes', contagem.BLOQUEANTE, 'resolver antes de fechar a competência') +
    kpi('alerta', 'Alertas', contagem.ALERTA, 'conferir com o cliente ou a lei municipal') +
    kpi('info', 'Informativas', contagem.INFO, 'para conhecimento');
  $('#lista-divergencias').innerHTML = itens.length
    ? itens.map(itemDivergencia).join('') + (total > itens.length ? `<p class="sub">Mostrando ${numero(itens.length)} de ${numero(total)}.</p>` : '')
    : `<div class="cartao vazio-grande">${icone('check')}<h3>Nada por aqui</h3><p>Nenhuma divergência com esses filtros.</p></div>`;
}
$$('#filtros-conf input, #filtros-conf select').forEach((el) => el.addEventListener('change', () => carregarConferencia().catch((e) => avisar(e.message, 'erro'))));

async function acaoDivergencia(ev) {
  const nota = ev.target.closest('[data-div-nota]');
  const ign = ev.target.closest('[data-div-ignorar]');
  const reab = ev.target.closest('[data-div-reabrir]');
  try {
    if (nota) return abrirNota(await api(`/api/documentos/${nota.dataset.divNota}`));
    if (ign) {
      const motivo = prompt('Por que esta divergência pode ser ignorada? (fica registrado na auditoria)\nEx.: "Lei municipal dispensa a retenção", "Prestador imune — documento arquivado".');
      if (motivo === null) return;
      await api(`/api/divergencias/${ign.dataset.divIgnorar}/ignorar`, { metodo: 'POST', corpo: { motivo } });
      avisar('Divergência ignorada. A justificativa ficou registrada na auditoria.');
    }
    if (reab) {
      await api(`/api/divergencias/${reab.dataset.divReabrir}/reabrir`, { metodo: 'POST' });
      avisar('Divergência reaberta.');
    }
    if (ign || reab) {
      if ($('#dlg-nota').open) $('#dlg-nota').close();
      atualizar();
    }
  } catch (e) {
    avisar(e.message, 'erro');
  }
}
$('#lista-divergencias').addEventListener('click', acaoDivergencia);
$('#detalhe-nota').addEventListener('click', acaoDivergencia);

$('#btn-revalidar').addEventListener('click', async () => {
  try {
    const v = await api('/api/validar', { metodo: 'POST', corpo: {} });
    avisar(`${numero(v.documentos)} nota(s) conferida(s): ${v.novas} nova(s), ${v.resolvidas} resolvida(s). Abertas: ${v.abertas.BLOQUEANTE} bloqueante(s), ${v.abertas.ALERTA} alerta(s).`);
    atualizar();
  } catch (e) {
    avisar(e.message, 'erro');
  }
});
$('#btn-regras').addEventListener('click', () => {
  $('#lista-regras').innerHTML = catalogo.regras
    .map((r) => `<tr><td><code>${esc(r.codigo)}</code></td><td class="quebra">${esc(r.titulo)}</td><td><span class="pilula ${esc(r.severidade)}">${esc(SEVERIDADE[r.severidade])}</span></td><td class="quebra">${esc(r.fonte_legal)}</td><td>${esc(r.vigencia_inicio.split('-').reverse().join('/'))}</td></tr>`)
    .join('');
  $('#dlg-regras').showModal();
});


// ---------------- Importação em lote ----------------
const SITUACAO_LOTE = {
  nova: ['ok', 'Nova empresa'],
  renovacao: ['primaria', 'Renovação'],
  mesmo: ['', 'Já cadastrado'],
  mais_antigo: ['alerta', 'Cadastrado vence depois'],
};
let lote = []; // { arquivo:File, senha, estado:'pendente'|'validando'|'valido'|'erro'|'gravando'|'feito', analise, erro }
let loteOcupado = false;
const importavel = (l) => l.estado === 'valido' && ['nova', 'renovacao'].includes(l.analise?.situacao);

function adicionarAoLote(arquivos) {
  const novos = [...arquivos].filter((f) => /\.(pfx|p12)$/i.test(f.name));
  const ignorados = arquivos.length - novos.length;
  for (const f of novos) {
    if (lote.some((l) => l.arquivo.name === f.name && l.arquivo.size === f.size)) continue;
    lote.push({ arquivo: f, senha: $('#lote-senha-todos').value, estado: 'pendente' });
  }
  if (ignorados > 0 && novos.length === 0) avisar('Nenhum arquivo .pfx ou .p12 encontrado.', 'erro');
  desenharLote();
}

function desenharLote() {
  $('#lote-tabela').classList.toggle('oculto', !lote.length);
  $('#lote-linhas').innerHTML = lote.map((l, i) => {
    let empresa = '<span class="sub">—</span>';
    let validade = '';
    let situacao = '<span class="pilula">aguardando validação</span>';
    if (l.estado === 'validando' || l.estado === 'gravando') situacao = `<span class="pilula executando">${l.estado === 'validando' ? 'validando…' : 'gravando…'}</span>`;
    if (l.estado === 'erro') situacao = `<span class="pilula erro" title="${esc(l.erro)}">${esc(l.erro)}</span>`;
    if (l.analise) {
      empresa = `<b>${esc(l.analise.nome)}</b><span class="sub">${esc(doc(l.analise.cnpj))}</span>`;
      validade = dataBR(l.analise.validoAte);
      if (l.estado === 'valido') { const [c, t] = SITUACAO_LOTE[l.analise.situacao]; situacao = `<span class="pilula ${c}">${t}</span>`; }
      if (l.estado === 'feito') situacao = `<span class="pilula ok">${l.analise.situacao === 'renovacao' ? 'renovada' : 'cadastrada'} ✓</span>`;
    }
    const travado = loteOcupado || l.estado === 'feito';
    return `<tr>
      <td class="nome"><b>${esc(l.arquivo.name)}</b><span class="sub">${(l.arquivo.size / 1024).toFixed(1)} KB</span></td>
      <td><input type="password" data-senha="${i}" value="${esc(l.senha)}" placeholder="senha" autocomplete="off" ${travado ? 'disabled' : ''}></td>
      <td class="nome">${empresa}</td>
      <td>${validade}</td>
      <td class="quebra">${situacao}</td>
      <td><button class="icone-acao" data-remover="${i}" title="Remover da lista" ${travado ? 'disabled' : ''}>${icone('x')}</button></td>
    </tr>`;
  }).join('');
  const n = (f) => lote.filter(f).length;
  const prontos = n(importavel);
  const feitos = n((l) => l.estado === 'feito');
  const erros = n((l) => l.estado === 'erro');
  const pendentes = n((l) => l.estado === 'pendente');
  $('#lote-resumo').textContent = lote.length
    ? `${lote.length} certificado(s) · ${prontos} pronto(s) para cadastrar · ${pendentes} a validar · ${erros} com erro${feitos ? ` · ${feitos} gravado(s)` : ''}`
    : '';
  $('#btn-lote-validar').disabled = loteOcupado || !pendentes;
  $('#btn-lote-cadastrar').disabled = loteOcupado || !prontos;
  $('#btn-lote-cadastrar').textContent = prontos ? `Cadastrar ${prontos}` : 'Cadastrar';
}

$('#btn-lote').addEventListener('click', () => {
  if (!loteOcupado && lote.every((l) => l.estado === 'feito')) lote = [];
  desenharLote();
  $('#dlg-lote').showModal();
});
$('#lote-arquivos').addEventListener('change', (ev) => { adicionarAoLote(ev.target.files); ev.target.value = ''; });
$('#lote-pasta').addEventListener('change', (ev) => { adicionarAoLote(ev.target.files); ev.target.value = ''; });
$('#btn-lote-pasta').addEventListener('click', (ev) => { ev.preventDefault(); $('#lote-pasta').click(); });
const areaLote = $('#area-lote');
['dragenter', 'dragover'].forEach((t) => areaLote.addEventListener(t, (ev) => { ev.preventDefault(); areaLote.classList.add('arrastando'); }));
['dragleave', 'drop'].forEach((t) => areaLote.addEventListener(t, () => areaLote.classList.remove('arrastando')));
areaLote.addEventListener('drop', (ev) => { ev.preventDefault(); adicionarAoLote(ev.dataTransfer.files); });

$('#lote-linhas').addEventListener('input', (ev) => {
  const i = ev.target.dataset.senha;
  if (i === undefined) return;
  const l = lote[Number(i)];
  l.senha = ev.target.value;
  if (l.estado !== 'feito') { l.estado = 'pendente'; l.analise = null; l.erro = null; }
  // atualiza só o resumo/botões, sem redesenhar (para não perder o foco do campo)
  const prontos = lote.filter(importavel).length;
  $('#btn-lote-validar').disabled = loteOcupado;
  $('#btn-lote-cadastrar').disabled = loteOcupado || !prontos;
});
$('#lote-linhas').addEventListener('change', (ev) => { if (ev.target.dataset.senha !== undefined) desenharLote(); });
$('#lote-linhas').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-remover]');
  if (!b) return;
  lote.splice(Number(b.dataset.remover), 1);
  desenharLote();
});

$('#btn-lote-aplicar').addEventListener('click', () => {
  const senha = $('#lote-senha-todos').value;
  let n = 0;
  for (const l of lote) if (!l.senha && l.estado !== 'feito') { l.senha = senha; l.estado = 'pendente'; l.analise = null; n++; }
  desenharLote();
  avisar(n ? `Senha aplicada a ${n} certificado(s) sem senha.` : 'Todos os certificados já têm senha preenchida.');
});

$('#btn-lote-csv').addEventListener('click', () => $('#lote-csv').click());
$('#lote-csv').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const mapa = lerPlanilhaSenhas(await f.text());
  let n = 0;
  for (const l of lote) {
    if (l.estado === 'feito') continue;
    const senha = senhaPara(mapa, l.arquivo.name, l.analise?.cnpj);
    if (senha !== undefined) { l.senha = senha; l.estado = 'pendente'; l.analise = null; n++; }
  }
  desenharLote();
  avisar(`Planilha lida: ${mapa.size} linha(s); senha preenchida em ${n} de ${lote.length} certificado(s).`, n ? 'ok' : 'erro');
});

async function validarLote() {
  loteOcupado = true;
  for (const l of lote) {
    if (l.estado !== 'pendente') continue;
    l.estado = 'validando';
    desenharLote();
    try {
      l.base64 ??= await arquivoParaBase64(l.arquivo);
      l.analise = await api('/api/certificados/analisar', { metodo: 'POST', corpo: { pfxBase64: l.base64, senha: l.senha } });
      l.estado = 'valido';
    } catch (e) {
      l.estado = 'erro';
      l.erro = e.message;
    }
  }
  loteOcupado = false;
  desenharLote();
}
$('#btn-lote-validar').addEventListener('click', validarLote);

$('#btn-lote-cadastrar').addEventListener('click', async () => {
  const fila = lote.filter(importavel);
  if (!fila.length) return;
  const renov = fila.filter((l) => l.analise.situacao === 'renovacao').length;
  if (!confirm(`Cadastrar ${fila.length - renov} empresa(s) nova(s) e renovar ${renov} certificado(s)?`)) return;
  loteOcupado = true;
  let ok = 0;
  for (const l of fila) {
    l.estado = 'gravando';
    desenharLote();
    try {
      await api('/api/empresas', { metodo: 'POST', corpo: { pfxBase64: l.base64, senha: l.senha } });
      l.estado = 'feito';
      ok++;
    } catch (e) {
      l.estado = 'erro';
      l.erro = e.message;
    }
  }
  loteOcupado = false;
  desenharLote();
  avisar(`${ok} de ${fila.length} certificado(s) gravado(s).`, ok === fila.length ? 'ok' : 'erro');
  atualizar();
});

// ---------------- Encerrar ----------------
let encerrado = false;
$('#btn-encerrar').addEventListener('click', async () => {
  const rodando = haExecutando ? '\n\nATENÇÃO: há uma busca em andamento; ela será interrompida e continua de onde parou na próxima vez.' : '';
  if (!confirm('Encerrar o Buscador NFS-e?' + rodando)) return;
  try {
    await api('/api/encerrar', { metodo: 'POST' });
  } catch (e) {
    return avisar(e.message, 'erro');
  }
  encerrado = true;
  document.body.classList.add('desligado');
  $$('main').forEach((el) => el.classList.add('oculto'));
  $('#tela-encerrado').classList.remove('oculto');
});

// ---------------- Ciclo ----------------
async function atualizar() {
  if (encerrado) return;
  try {
    const resumo = await api('/api/resumo');
    $('#ambiente').textContent = { producao: 'Produção', homologacao: 'Homologação' }[resumo.ambiente] ?? resumo.ambiente;
    $('#cont-notas').textContent = resumo.documentos ? numero(resumo.documentos) : '';
    $('#cont-conferencia').textContent = resumo.divergencias_bloqueantes ? numero(resumo.divergencias_bloqueantes) : '';
    if (!catalogo.regras.length) catalogo = await api('/api/catalogo');
    await carregarExecucoes();
    await carregarEmpresas();
    if (abaAtual === 'inicio') await carregarInicio(resumo);
    if (abaAtual === 'notas') await carregarNotas();
    if (abaAtual === 'conferencia') await carregarConferencia();
    if (abaAtual === 'execucoes') await carregarAuditoria();
  } catch (e) {
    avisar(e.message, 'erro');
  }
}
setInterval(() => { if (haExecutando && !encerrado) atualizar(); }, 3000);
atualizar();

// ---------------- Prefeituras (conectores municipais) ----------------
let empresaPrefeituras = null;
let perfisMunicipais = [];
const NOVO_MUNICIPIO = '__novo__';

async function abrirPrefeituras(empresaId) {
  empresaPrefeituras = empresas.find((e) => e.id === empresaId);
  $('#titulo-prefeituras').textContent = `Prefeituras — ${empresaPrefeituras?.razao_social ?? ''}`;
  $('#form-vinculo').reset();
  $('#erro-vinculo').textContent = '';
  $('#novo-municipio').classList.add('oculto');
  if (!perfisMunicipais.length) perfisMunicipais = (await api('/api/perfis')).perfis;
  $('#vinc-perfil').innerHTML = perfisMunicipais
    .map((p) => `<option value="${esc(p.id)}" ${p.id === 'abrasf-2.02' ? 'selected' : ''}>${esc(p.nome)}${p.tomadas ? '' : ' (só notas prestadas)'}</option>`).join('');
  await carregarVinculos();
  $('#dlg-prefeituras').showModal();
}

async function carregarVinculos() {
  const [vinculos, municipios] = await Promise.all([api(`/api/vinculos?empresa=${empresaPrefeituras.id}`), api('/api/municipios')]);
  const jaVinculados = new Set(vinculos.map((v) => v.ibge));
  $('#vinc-municipio').innerHTML = '<option value="">Escolha…</option>' +
    municipios.filter((m) => !jaVinculados.has(m.ibge))
      .map((m) => `<option value="${esc(m.ibge)}">${esc(m.nome)}${m.uf ? '/' + esc(m.uf) : ''} — ${esc(m.perfil)}</option>`).join('') +
    `<option value="${NOVO_MUNICIPIO}">+ Cadastrar novo município…</option>`;
  $('#lista-vinculos').innerHTML = vinculos.length
    ? vinculos.map((v) => {
        const st = v.ultimo_codigo ? catalogo.status[v.ultimo_codigo] : null;
        return `<div class="vinculo" data-vinculo="${v.id}">
          <div>
            <b>${esc(v.municipio_nome)}${v.uf ? '/' + esc(v.uf) : ''}</b>
            ${st ? `<span class="pilula ${classeStatus(st.tipo)}">${esc(st.rotulo)}</span>` : '<span class="pilula">nunca buscado</span>'}
            ${v.ativo ? '' : '<span class="pilula">inativo</span>'}
            <div class="meta">IBGE ${esc(v.ibge)} · ${esc(v.perfil)}${v.inscricao_municipal ? ` · IM ${esc(v.inscricao_municipal)}` : ''} · consultado até ${v.ultima_data ? dataBR(v.ultima_data) : '—'}</div>
            <div class="meta">${esc(v.url)}</div>
          </div>
          <div class="div-acoes">
            <button class="botao secundario pequeno" data-vacao="testar">Testar conexão</button>
            <button class="botao pequeno" data-vacao="buscar">${icone('play')}Buscar agora</button>
            <button class="botao-fantasma perigo pequeno" data-vacao="remover" title="Remover vínculo">${icone('x')}</button>
          </div>
          <div class="resultado oculto"></div>
        </div>`;
      }).join('')
    : '<p class="sub">Nenhuma prefeitura vinculada a esta empresa.</p>';
}

$('#vinc-municipio').addEventListener('change', (ev) => $('#novo-municipio').classList.toggle('oculto', ev.target.value !== NOVO_MUNICIPIO));

$('#form-vinculo').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  $('#erro-vinculo').textContent = '';
  try {
    let ibge = f.get('ibge');
    if (ibge === NOVO_MUNICIPIO) {
      const opcoes = {};
      for (const [k, v] of f) if (k.startsWith('op_') && k !== 'op_semSoapAction' && v !== '') opcoes[k.slice(3)] = v;
      if (f.get('op_semSoapAction')) opcoes.soapAction = '';
      const m = await api('/api/municipios', {
        metodo: 'POST',
        corpo: { ibge: f.get('novo_ibge'), nome: f.get('novo_nome'), uf: f.get('novo_uf'), perfil: f.get('novo_perfil'), url: f.get('novo_url'), opcoes },
      });
      ibge = m.ibge;
    }
    if (!ibge) throw new Error('Escolha o município.');
    await api('/api/vinculos', { metodo: 'POST', corpo: { empresa: empresaPrefeituras.id, ibge, inscricaoMunicipal: f.get('inscricaoMunicipal') } });
    ev.target.reset();
    $('#novo-municipio').classList.add('oculto');
    avisar('Prefeitura vinculada. Use “Testar conexão” antes da primeira busca.');
    await carregarVinculos();
    atualizar();
  } catch (e) {
    $('#erro-vinculo').textContent = e.message;
  }
});

$('#lista-vinculos').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-vacao]');
  if (!b) return;
  const caixa = b.closest('[data-vinculo]');
  const id = caixa.dataset.vinculo;
  const resultado = caixa.querySelector('.resultado');
  const mostrar = (cls, txt) => { resultado.className = `resultado ${cls}`; resultado.textContent = txt; };
  try {
    if (b.dataset.vacao === 'testar') {
      b.disabled = true;
      mostrar('', 'Testando… (pode levar alguns segundos)');
      const t = await api(`/api/vinculos/${id}/testar`, { metodo: 'POST' });
      if (t.ok) mostrar('ok', `✓ ${t.mensagem}`);
      else mostrar('erro', `${catalogo.status[t.codigo]?.rotulo ?? t.codigo}: ${t.mensagem}${t.acao ? ` — ${t.acao}` : ''}`);
      b.disabled = false;
    } else if (b.dataset.vacao === 'buscar') {
      const r = await api(`/api/vinculos/${id}/buscar`, { metodo: 'POST', corpo: {} });
      avisar(`${r.mensagem} Acompanhe em Execuções.`);
      setTimeout(atualizar, 600);
    } else if (b.dataset.vacao === 'remover') {
      if (!confirm('Remover este vínculo? As notas já baixadas continuam no sistema.')) return;
      await api(`/api/vinculos/${id}`, { metodo: 'DELETE' });
      await carregarVinculos();
      atualizar();
    }
  } catch (e) {
    b.disabled = false;
    mostrar('erro', e.message);
  }
});
