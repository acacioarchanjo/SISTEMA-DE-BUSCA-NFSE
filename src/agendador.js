// Agendador (node-cron): busca diária no ADN e conciliação mensal opcional.
import cron from 'node-cron';
import { config } from './config.js';
import { sincronizarTodas } from './adn/distribuicao.js';
import { conciliarEmpresa, mesAnterior } from './portal/conciliacao.js';

export function iniciarAgendador(repo, log = console.log) {
  const tarefas = [];
  const { cronAdn, cronConciliacao } = config.agendador;

  if (cronAdn) {
    if (!cron.validate(cronAdn)) throw new Error(`NFSE_ADN_CRON inválido: ${cronAdn}`);
    let rodando = false;
    tarefas.push(
      cron.schedule(cronAdn, async () => {
        if (rodando) return;
        rodando = true;
        log('[agendador] busca ADN iniciada');
        try {
          for (const r of await sincronizarTodas(repo)) log(`[agendador] ${r.empresa}: ${r.ok ? 'OK' : 'ERRO'} — ${r.mensagem}`);
        } finally {
          rodando = false;
        }
      }),
    );
    log(`[agendador] busca ADN agendada: "${cronAdn}"`);
  }

  if (cronConciliacao) {
    if (!cron.validate(cronConciliacao)) throw new Error(`NFSE_SCHEDULE_CRON inválido: ${cronConciliacao}`);
    tarefas.push(
      cron.schedule(cronConciliacao, async () => {
        const periodo = mesAnterior();
        log(`[agendador] conciliação ${periodo.de} a ${periodo.ate}`);
        for (const emp of repo.listarEmpresas({ somenteAtivas: true })) {
          try {
            const r = await conciliarEmpresa(repo, emp.id, periodo);
            log(`[agendador] ${emp.razao_social}: ${r.mensagem}`);
          } catch (e) {
            log(`[agendador] ${emp.razao_social}: ERRO — ${e.message}`);
          }
        }
      }),
    );
    log(`[agendador] conciliação mensal agendada: "${cronConciliacao}"`);
  }

  return { parar: () => tarefas.forEach((t) => t.stop()) };
}
