import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './server.js';
import { createAIProvider } from './ai.js';
import { createCodexProvider } from './codex-provider.js';

// This entry point is local-only and opt-in. The normal server never acquires
// access to a logged-in Codex account, including when deployed to a VPS.
export async function createLocalCodexServer(options = {}) {
  const port = Number(options.port ?? process.env.LIARS_CODEX_PORT ?? 3280);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const codex = options.codexProvider || createCodexProvider({
    logger: (record) => console.log(JSON.stringify({ at: new Date().toISOString(), ...record })),
    ...options.codexOptions,
  });
  try {
    await codex.ready();
  } catch (error) {
    await codex.close();
    throw error;
  }
  const external = createAIProvider();
  const server = createGameServer({
    host: '127.0.0.1', port,
    allowCodex: true,
    aiDefaults: { protocol: 'codex', model: 'gpt-5.6-luna' },
    // Give a first-time player time to read the cards and controls.
    durations: { turnMs: 300_000, triggerMs: 60_000 },
    cors: { origin: [...origins], credentials: false },
    allowRequest: (req, callback) => {
      const host = req.headers.host;
      const validHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
      callback(null, validHost && (!req.headers.origin || origins.has(req.headers.origin)));
    },
    aiProvider: (request) => request.ai?.protocol === 'codex' ? codex(request) : external(request),
  });
  const closeGame = server.close;
  server.close = async () => {
    await closeGame();
    await codex.close();
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let server;
  createLocalCodexServer().then(async (value) => {
    server = value;
    const address = await server.listen();
    console.log(`Codex Liar's Tavern ready: http://127.0.0.1:${address.port} (3 × gpt-5.6-luna, max)`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }).catch(async (error) => {
    console.error(`Local Codex game startup failed: ${error.message}`);
    await server?.close();
    process.exitCode = 1;
  });
}
