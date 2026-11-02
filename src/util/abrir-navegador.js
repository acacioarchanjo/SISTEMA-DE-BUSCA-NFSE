// Espera o painel responder e então abre o navegador.
// Uso: node src/util/abrir-navegador.js [porta] [--ja-rodando]
// Sai com código 0 quando abriu; 1 se o painel não respondeu a tempo.
import net from 'node:net';
import { exec } from 'node:child_process';

const porta = Number(process.argv[2]) || 3000;
const url = `http://127.0.0.1:${porta}`;
const limiteMs = 180_000; // primeira execução pode demorar (npm install)

const portaAberta = () =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: porta });
    const fim = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(800, () => fim(false));
    s.on('connect', () => fim(true));
    s.on('error', () => fim(false));
  });

function abrir() {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, { windowsHide: true });
}

const inicio = Date.now();
while (Date.now() - inicio < limiteMs) {
  if (await portaAberta()) {
    abrir();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 700));
}
process.exit(1);
