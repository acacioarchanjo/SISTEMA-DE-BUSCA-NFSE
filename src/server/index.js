// npm start — sobe o painel em http://127.0.0.1:3000
import { config } from '../config.js';
import { carregarChave } from '../crypto/cofre.js';
import { obterBanco } from '../db/index.js';
import { Repositorio } from '../db/repositorio.js';
import { criarServidor } from './app.js';
import { iniciarAgendador } from '../agendador.js';

try {
  carregarChave();
} catch (e) {
  console.error(`\n[ERRO] ${e.message}\nConfigure o arquivo .env (veja .env.example) e tente novamente.\n`);
  process.exit(1);
}

const repo = new Repositorio(obterBanco());
let agendador = { parar() {} };
const encerrar = () => {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Sistema encerrado.`);
  agendador.parar();
  servidor.close(() => process.exit(0));
  servidor.closeAllConnections?.();
  setTimeout(() => process.exit(0), 2000).unref();
};
const servidor = criarServidor(repo, { aoEncerrar: encerrar });
agendador = iniciarAgendador(repo);

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[ERRO] A porta ${config.servidor.porta} já está em uso: o sistema provavelmente já está aberto.`);
    console.error(`       Acesse http://${config.servidor.host}:${config.servidor.porta} ou mude NFSE_SERVER_PORT no .env.\n`);
  } else {
    console.error('[ERRO]', e.message);
  }
  process.exit(1);
});

servidor.listen(config.servidor.porta, config.servidor.host, () => {
  console.log(`\n[${new Date().toLocaleString('pt-BR')}] 🔎 Buscador NFS-e rodando em http://${config.servidor.host}:${config.servidor.porta}`);
  console.log(`   Ambiente: ${config.ambiente} | ADN: ${config.adn.host} | Banco: ${config.dbPath}\n`);
});

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
