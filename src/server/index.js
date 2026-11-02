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
const servidor = criarServidor(repo);
const agendador = iniciarAgendador(repo);

servidor.listen(config.servidor.porta, config.servidor.host, () => {
  console.log(`\n🔎 Buscador NFS-e rodando em http://${config.servidor.host}:${config.servidor.porta}`);
  console.log(`   Ambiente: ${config.ambiente} | ADN: ${config.adn.host} | Banco: ${config.dbPath}\n`);
});

const encerrar = () => {
  agendador.parar();
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
