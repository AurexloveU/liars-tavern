// Opt-in live test: one AI decision, at most one format repair (2 calls total).
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createLocalCodexServer } from '../codex-server.js';

const server = await createLocalCodexServer({
  port: 3282,
  soloStatePath: new URL('./codex-runtime/solo-live-verification.json', import.meta.url).pathname,
  codexOptions: { maxCallsPerRoom: 2 },
});
const action = (socket, payload) => new Promise((resolve, reject) => {
  socket.timeout(5000).emit('action', payload, (error, reply) => error ? reject(error) : resolve(reply));
});
let socket;
let latest;
try {
  await server.listen();
  socket = io('http://127.0.0.1:3282', { transports: ['websocket'] });
  socket.on('state', (state) => { latest = state; });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  assert.deepEqual(await action(socket, { type: 'soloStart', name: 'Live acceptance', gender: 'female', skin: 0 }), { ok: true, mySeat: 0 });
  assert.equal(latest.turnSeat, 0);
  assert.equal(latest.deadline, null);
  const decision = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Live decision timed out')), 150000);
    const listener = (state) => {
      if (state.players[1]?.ai?.error) {
        clearTimeout(timer);
        socket.off('state', listener);
        reject(new Error(state.players[1].ai.error));
      } else if (state.lastPlay?.seatIndex === 1 || state.phase === 'reveal') {
        clearTimeout(timer);
        socket.off('state', listener);
        // Pause before another seat is scheduled. Preserve the actual accepted action.
        socket.emit('action', { type: 'soloPause' });
        resolve(state);
      }
    };
    socket.on('state', listener);
  });
  assert.deepEqual(await action(socket, { type: 'play', cardIds: [latest.hand[0].id] }), { ok: true });
  const accepted = await decision;
  assert.equal(accepted.hand.length, 4);
  await action(socket, { type: 'soloPause' });
  console.log(JSON.stringify({ event: 'solo-live-verified', model: 'gpt-5.6-luna', effort: 'max', humanCardsAfterPlay: accepted.hand.length, phase: accepted.phase, lastPlaySeat: accepted.lastPlay?.seatIndex, aiCalls: accepted.players[1]?.aiCalls, pausedAfterDecision: latest.paused }));
} finally {
  socket?.disconnect();
  await server.close();
}
