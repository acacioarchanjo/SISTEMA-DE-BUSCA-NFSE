// Espera o painel responder e então abre o navegador.
// Uso: node src/util/abrir-navegador.js [porta] [segundos]
// Sai com código 0 quando abriu; 1 se o painel não respondeu a tempo.
import net from 'node:net';
import { spawn } from 'node:child_process';

const porta = Number(process.argv[2]) || 3000;
const url = `http://127.0.0.1:${porta}`;
const limiteMs = (Number(process.argv[3]) || 180) * 1000; // 2º argumento: segundos de espera (padrão 180)

const portaAberta = () =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: porta });
    const fim = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(800, () => fim(false));
    s.on('connect', () => fim(true));
    s.on('error', () => fim(false));
  });

/** Abre a URL no navegador padrão e espera o comando terminar (senão o Windows pode não abrir). */
function abrir() {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => {
      // alternativa no Windows
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '""', url], { windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true })
          .on('exit', resolve)
          .on('error', resolve);
      } else resolve();
    });
    p.on('exit', resolve);
  });
}

const inicio = Date.now();
while (Date.now() - inicio < limiteMs) {
  if (await portaAberta()) {
    await abrir();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 700));
}
process.exit(1);
