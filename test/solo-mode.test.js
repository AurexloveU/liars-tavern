import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { LiarRoom } from '../game.js';
import { createGameServer } from '../server.js';

function action(socket, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`action timeout: ${payload.type}`)), 2000);
    socket.emit('action', payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function connected(socket) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 2000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function profile(name = '单机玩家') {
  return { name, gender: 'male', skin: 0 };
}

function waitState(socket, predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('state', listener);
      reject(new Error('state wait timeout'));
    }, timeout);
    const listener = (state) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off('state', listener);
      resolve(state);
    };
    socket.on('state', listener);
  });
}

test('solo entry is local-only, starts seat 0, and resumes without room credentials', async () => {
  let calls = 0;
  const provider = async ({ phase, room, seatIndex, publicState, selfHand }) => {
    calls += 1;
    assert.equal(room.soloMode, true);
    assert.equal(Object.hasOwn(publicState, 'chamber'), false);
    assert.equal(publicState.players.some((player) => Object.hasOwn(player, 'hand')), false);
    if (phase === 'roulette') return { action: 'pullTrigger', speech: '扣扳机' };
    if (publicState.mustChallenge) return { action: 'challenge', cardIds: [], speech: `质疑${seatIndex}` };
    assert.ok(selfHand.length > 0);
    return { action: 'play', cardIds: [selfHand[0].id], speech: `出牌${seatIndex}` };
  };
  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    soloMode: true,
    allowCodex: true,
    aiDefaults: { protocol: 'codex', model: 'gpt-5.6-luna' },
    aiProvider: provider,
    durations: { aiDelayMinMs: 1, aiDelayMaxMs: 1, revealMs: 4, rouletteVisibleMs: 4, triggerMs: 1000 },
    sweepEvery: 2,
  });
  const address = await server.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
  const first = connect(url, { transports: ['websocket'] });
  const second = connect(url, { transports: ['websocket'] });
  try {
    await Promise.all([connected(first), connected(second)]);
    const config = await fetch(`${url}/api/config`).then((response) => response.json());
    assert.deepEqual(config, { ok: true, soloMode: true, codexAvailable: true });

    const startedState = waitState(first, (state) => state.phase === 'playing' && state.round === 1);
    const started = await action(first, { type: 'soloStart', ...profile() });
    assert.deepEqual(started, { ok: true, mySeat: 0 });
    const state = await startedState;
    assert.equal(state.soloMode, true);
    assert.equal(state.code, null);
    assert.equal(state.selfSeat, 0);
    assert.equal(state.isHost, true);
    assert.equal(state.paused, false);
    assert.equal(state.turnSeat, 0, 'the first local turn is always the human');
    assert.equal(state.deadline, null, 'the local human turn has no timeout');
    assert.equal(state.hand.length, 5);
    assert.deepEqual(state.players.map((player) => player.kind), ['human', 'ai', 'ai', 'ai']);
    for (const player of state.players) assert.equal(Object.hasOwn(player, 'hand'), false);

    const pausedState = waitState(first, (value) => value.paused === true);
    assert.deepEqual(await action(first, { type: 'soloPause' }), { ok: true });
    await pausedState;
    assert.equal(calls, 0);

    // A second tab replaces the first seat connection and receives the same
    // private hand; there is no code/token to steal or store.
    const resumedState = waitState(second, (value) => value.soloMode && value.selfSeat === 0);
    assert.deepEqual(await action(second, { type: 'soloResume' }), { ok: true, mySeat: 0 });
    const resumed = await resumedState;
    assert.equal(resumed.hand.length, 5);
    assert.equal(resumed.code, null);
    assert.equal(resumed.paused, true, 'resume only binds the local seat; it does not start AI');
    assert.equal(server.sessions.size, 1);

    const deniedPlay = await action(second, { type: 'play', cardIds: [resumed.hand[0].id] });
    assert.equal(deniedPlay.ok, false);
    assert.match(deniedPlay.error, /paused/);

    assert.deepEqual(await action(second, { type: 'soloContinue' }), { ok: true });

    const playedState = waitState(second, (value) => value.turnSeat !== 0 && value.lastPlay?.seatIndex === 0);
    assert.deepEqual(await action(second, { type: 'play', cardIds: [resumed.hand[0].id] }), { ok: true });
    await playedState;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(calls >= 1, 'an AI request starts only after the connected human acts');
  } finally {
    first.disconnect();
    second.disconnect();
    await server.close();
  }
});

test('paused solo rules reject queued play and trigger actions', () => {
  const room = new LiarRoom({
    soloMode: true,
    allowCodex: true,
    host: profile('暂停测试'),
    aiDefaults: { protocol: 'codex', model: 'gpt-5.6-luna' },
    autoTimers: false,
  });
  room.start({ isHost: true, seatIndex: 0 }, { starterSeat: 0 });
  room.pauseSolo();
  assert.throws(() => room.play(0, [room.players[0].hand[0].id]), /paused/);
  room.phase = 'roulette';
  room.loserSeat = 0;
  room.lastShot = null;
  assert.throws(() => room.pullTrigger(0), /paused/);
});

test('soloResume is idempotent and reports an empty local game before first start', async () => {
  const server = createGameServer({ host: '127.0.0.1', port: 0, soloMode: true, allowCodex: true });
  const address = await server.listen(0, '127.0.0.1');
  const socket = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
  try {
    await connected(socket);
    assert.deepEqual(await action(socket, { type: 'soloResume' }), { ok: true, empty: true });
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test('Codex local entry restores its own paused snapshot across server restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'liars-solo-'));
  const statePath = path.join(directory, 'solo-state.json');
  let server = createGameServer({
    host: '127.0.0.1', port: 0, soloMode: true, allowCodex: true,
    soloStatePath: statePath,
    aiDefaults: { protocol: 'codex', model: 'gpt-5.6-luna' },
    aiProvider: async () => ({ action: 'play', cardIds: [] }),
  });
  const firstAddress = await server.listen(0, '127.0.0.1');
  const first = connect(`http://127.0.0.1:${firstAddress.port}`, { transports: ['websocket'] });
  try {
    await connected(first);
    assert.deepEqual(await action(first, { type: 'soloStart', ...profile('存档玩家') }), { ok: true, mySeat: 0 });
    first.disconnect();
    await server.close();
    server = null;

    const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(saved.players[0].ai.apiKey, '', 'local snapshots never contain provider keys');

    server = createGameServer({
      host: '127.0.0.1', port: 0, soloMode: true, allowCodex: true,
      soloStatePath: statePath,
      aiDefaults: { protocol: 'codex', model: 'gpt-5.6-luna' },
      aiProvider: async () => ({ action: 'play', cardIds: [] }),
    });
    const secondAddress = await server.listen(0, '127.0.0.1');
    const second = connect(`http://127.0.0.1:${secondAddress.port}`, { transports: ['websocket'] });
    try {
      await connected(second);
      const statePromise = waitState(second, (value) => value.soloMode && value.selfSeat === 0);
      assert.deepEqual(await action(second, { type: 'soloResume' }), { ok: true, mySeat: 0 });
      const restored = await statePromise;
      assert.equal(restored.paused, true);
      assert.equal(restored.round, 1);
      assert.equal(restored.hand.length, 5);
      assert.equal(restored.code, null);
    } finally {
      second.disconnect();
      await server.close();
    }
  } finally {
    first.disconnect();
    if (server) await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
