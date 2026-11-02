// Contexto da requisição (quem está agindo). Propaga por promessas e tarefas em segundo plano,
// então a auditoria sabe qual usuário disparou uma busca mesmo depois que a resposta HTTP já foi enviada.
import { AsyncLocalStorage } from 'node:async_hooks';

const armazem = new AsyncLocalStorage();

export const comContexto = (ctx, fn) => armazem.run(ctx, fn);
export const usuarioAtual = () => armazem.getStore()?.usuario ?? null;
