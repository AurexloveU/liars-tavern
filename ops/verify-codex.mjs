// Explicit live acceptance: 3 initial model calls, up to 3 format repairs.
// This script is opt-in and is never run by npm test or server startup.
import assert from 'node:assert/strict';
import { LiarRoom } from '../game.js';
import { createCodexProvider } from '../codex-provider.js';

const codex = createCodexProvider({ maxCallsPerRoom: 6,
  logger: (record) => console.log(JSON.stringify(record)) });
const room = new LiarRoom({ code: 'VERIFY', autoTimers: false, allowCodex: true,
  host: { name: '连接验收', gender: 'female', skin: 0 },
  aiDefaults: { protocol: 'codex', model: 'gpt-5.6-luna' } });
try {
  await codex.ready();
  room.start({ isHost: true, seatIndex: 0 });
  for (const seatIndex of [1, 2, 3]) {
    room.beginRound({ starterSeat: seatIndex });
    const started = Date.now();
    await room.requestAIDecision(seatIndex, codex);
    assert.equal(room.players[seatIndex].ai.error, null);
    assert.equal(room.lastPlay?.seatIndex, seatIndex);
    console.log(JSON.stringify({ verified: true, seatIndex,
      model: 'gpt-5.6-luna', effort: 'max', action: 'play',
      count: room.lastPlay.count, calls: room.players[seatIndex].aiCalls,
      elapsedMs: Date.now() - started }));
  }
  assert.ok(room.totalAICalls <= 6);
  console.log(JSON.stringify({ verifiedSeats: 3, totalCalls: room.totalAICalls }));
} finally {
  room.destroy();
  await codex.close();
}
