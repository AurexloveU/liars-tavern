#!/usr/bin/env node
// Optional manual Socket.IO probe. Every connection is a declared test-human
// operator; this script is not a product AI and is never wired into server.js.
import { io } from 'socket.io-client';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const url = arg('--url', 'http://127.0.0.1:3279');
const roomCode = arg('--room', '');
const prefix = arg('--name', 'ProbeHuman');
const gender = 'male';
const skin = 0;

function action(socket, payload) {
  return new Promise((resolve) => socket.emit('action', payload, resolve));
}

const sockets = Array.from({ length: roomCode ? 3 : 4 }, (_, i) => io(url, { transports: ['websocket'] }));
const states = new Map();
await Promise.all(sockets.map((socket) => new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
})));

sockets.forEach((socket, index) => socket.on('state', (state) => {
  states.set(index, state);
  const self = state.selfSeat == null ? 'spectator' : `seat ${state.selfSeat}`;
  process.stdout.write(`[human-probe ${index}] ${state.phase} ${self} turn=${state.turnSeat ?? '-'} rev=${state.revision}\n`);
}));

let code = roomCode;
if (!code) {
  const created = await action(sockets[0], { type: 'create', name: `${prefix}-0`, gender, skin });
  if (!created.ok) throw new Error(created.error);
  code = created.code;
  for (let seat = 1; seat < 4; seat += 1) {
    const opened = await action(sockets[0], { type: 'setSeat', seatIndex: seat, kind: 'open' });
    if (!opened.ok) throw new Error(opened.error);
    const joined = await action(sockets[seat], { type: 'join', code, name: `${prefix}-${seat}`, gender, skin });
    if (!joined.ok) throw new Error(joined.error);
  }
} else {
  for (let i = 0; i < sockets.length; i += 1) {
    const joined = await action(sockets[i], { type: 'join', code, name: `${prefix}-${i + 1}`, gender, skin });
    if (!joined.ok) throw new Error(joined.error);
  }
}

if (!roomCode) {
  const started = await action(sockets[0], { type: 'start' });
  if (!started.ok) throw new Error(started.error);
} else {
  process.stdout.write(`Joined existing room ${code}; the existing host starts it.\n`);
}

const interval = setInterval(async () => {
  for (let index = 0; index < sockets.length; index += 1) {
    const state = states.get(index);
    if (!state || state.phase === 'ended') continue;
    if (state.phase === 'playing' && state.selfSeat === state.turnSeat) {
      const result = state.mustChallenge
        ? await action(sockets[index], { type: 'challenge' })
        : await action(sockets[index], { type: 'play', cardIds: state.hand.slice(0, 1).map((card) => card.id) });
      if (!result.ok) process.stderr.write(`[human-probe ${index}] ${result.error}\n`);
    } else if (state.phase === 'roulette' && state.selfSeat === state.loserSeat && !state.lastShot) {
      const result = await action(sockets[index], { type: 'pullTrigger' });
      if (!result.ok) process.stderr.write(`[human-probe ${index}] ${result.error}\n`);
    }
  }
}, 400);

process.on('SIGINT', () => {
  clearInterval(interval);
  sockets.forEach((socket) => socket.disconnect());
  process.exit(0);
});
