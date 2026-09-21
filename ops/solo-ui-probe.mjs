// Temporary UI acceptance server. Never use this entry point for real play.
// The pending AI prevents test clicks from starting any paid model calls.
import { createGameServer } from '../server.js';
const server = createGameServer({
  port: 3281, host: '127.0.0.1', soloMode: true, allowCodex: true,
  aiDefaults: { protocol: 'codex', model: 'gpt-5.6-luna' },
  aiProvider: () => new Promise(() => {}),
});
await server.listen();
console.log('TEST ONLY: local single-player UI acceptance on 3281; zero model calls');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await server.close();
  process.exit(0);
});
