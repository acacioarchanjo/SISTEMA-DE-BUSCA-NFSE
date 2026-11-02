// npm run init-db — cria/atualiza o banco local.
import { config } from '../config.js';
import { abrirBanco } from './index.js';

const db = abrirBanco();
const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(`Banco pronto em ${config.dbPath}`);
console.log('Tabelas:', tabelas.map((t) => t.name).join(', '));
db.close();
