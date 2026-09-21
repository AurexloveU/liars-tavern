import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server.js';

function action(socket, payload) {
  return new Promise((resolve) => socket.emit('action', payload, resolve));
}

function nextState(socket, predicate = () => true, timeout = 2000) {
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

async function waitUntil(predicate, timeout = 5000, interval = 10) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('condition wait timeout');
}

async function openServer(options = {}) {
  const server = createGameServer({ host: '127.0.0.1', port: 0, ...options });
  const address = await server.listen(0, '127.0.0.1');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function profile(name) { return { name, gender: 'male', skin: 0 }; }

test('create, AI configuration, host seat conversion, resume, and host restore preserve authority', async () => {
  const { server, url } = await openServer({ aiProvider: async () => ({ action: 'play', cardIds: [] }) });
  const socket = connect(url, { transports: ['websocket'] });
  const socket2 = connect(url, { transports: ['websocket'] });
  try {
    await new Promise((resolve) => socket.once('connect', resolve));
    const created = await action(socket, { type: 'create', ...profile('Host') });
    assert.equal(created.ok, true);
    const token = created.token;
    await action(socket, {
      type: 'configureAI', seatIndex: 1, baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'k',
      persona: '保留的人格', systemPrompt: '保留的系统提示', maxOutputTokens: 8192,
    });
    await action(socket, { type: 'configureAI', seatIndex: 1, model: 'm2' });
    const patchedAI = server.rooms.get(created.code).players[1].ai;
    assert.equal(patchedAI.baseUrl, 'https://provider.example/v1');
    assert.equal(patchedAI.model, 'm2');
    assert.equal(patchedAI.apiKey, 'k');
    assert.equal(patchedAI.persona, '保留的人格');
    assert.equal(patchedAI.systemPrompt, '保留的系统提示');
    assert.equal(patchedAI.maxOutputTokens, 8192);
    await action(socket, { type: 'configureAI', seatIndex: 2, baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'k' });
    await action(socket, { type: 'configureAI', seatIndex: 3, baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'k' });
    const spectatorState = nextState(socket, (state) => state.phase === 'lobby' && state.selfSeat === null && state.hostConfigs?.some((config) => config.seatIndex === 0 && config.hasKey));
    const switched = await action(socket, { type: 'setSeat', seatIndex: 0, kind: 'ai' });
    assert.equal(switched.ok, true);
    const configuredSelf = await action(socket, { type: 'configureAI', seatIndex: 0, baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'k' });
    assert.equal(configuredSelf.ok, true);
    const spectator = await spectatorState;
    assert.equal(spectator.isHost, true);
    assert.equal(spectator.hand.length, 0);
    assert.equal(spectator.hostConfigs[0].hasKey, true);
    assert.equal(Object.hasOwn(spectator.hostConfigs[0], 'apiKey'), false);

    socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await new Promise((resolve) => (socket2.connected ? resolve() : socket2.once('connect', resolve)));
    const resumed = await action(socket2, { type: 'resume', code: created.code, token });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.mySeat, null);
    const restored = await action(socket2, { type: 'setSeat', seatIndex: 0, kind: 'human' });
    assert.equal(restored.ok, true);
    const ownStatePromise = nextState(socket2, (state) => state.phase === 'playing' && state.selfSeat === 0 && state.isHost === true);
    const started = await action(socket2, { type: 'start' });
    assert.equal(started.ok, true);
    const ownState = await ownStatePromise;
    assert.equal(ownState.hand.length, 5);
  } finally {
    socket.disconnect();
    socket2.disconnect();
    await server.close();
  }
});

test('human socket states are isolated and non-host cannot change seats', async () => {
  const { server, url } = await openServer({ autoTimers: false });
  const sockets = [connect(url, { transports: ['websocket'] }), connect(url, { transports: ['websocket'] }), connect(url, { transports: ['websocket'] }), connect(url, { transports: ['websocket'] })];
  try {
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.once('connect', resolve))));
    const created = await action(sockets[0], { type: 'create', ...profile('P0') });
    for (let seat = 1; seat < 4; seat += 1) {
      const opened = await action(sockets[0], { type: 'setSeat', seatIndex: seat, kind: 'open' });
      assert.equal(opened.ok, true);
      const joined = await action(sockets[seat], { type: 'join', code: created.code, ...profile(`P${seat}`) });
      assert.equal(joined.ok, true);
    }
    const denied = await action(sockets[1], { type: 'setSeat', seatIndex: 2, kind: 'ai' });
    assert.equal(denied.ok, false);
    const playingStates = sockets.map((socket) => nextState(socket, (value) => value.phase === 'playing'));
    const started = await action(sockets[0], { type: 'start' });
    assert.equal(started.ok, true);
    for (const statePromise of playingStates) {
      const state = await statePromise;
      assert.equal(state.hand.length, 5);
      for (const player of state.players) assert.equal(Object.hasOwn(player, 'hand'), false);
      assert.equal(state.players.filter((player) => player.handCount === 5).length, 4);
    }
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await server.close();
  }
});

test('real socket timer path broadcasts reveal, roulette, shot, and next round', async () => {
  const { server, url } = await openServer({
    durations: { revealMs: 20, rouletteVisibleMs: 25, triggerMs: 1000, turnMs: 10000 },
  });
  const sockets = [connect(url, { transports: ['websocket'] }), connect(url, { transports: ['websocket'] }), connect(url, { transports: ['websocket'] }), connect(url, { transports: ['websocket'] })];
  const states = [null, null, null, null];
  try {
    await Promise.all(sockets.map((socket, index) => new Promise((resolve) => {
      socket.once('connect', resolve);
      socket.on('state', (state) => { states[index] = state; });
    })));
    const created = await action(sockets[0], { type: 'create', ...profile('P0') });
    for (let seat = 1; seat < 4; seat += 1) {
      await action(sockets[0], { type: 'setSeat', seatIndex: seat, kind: 'open' });
      await action(sockets[seat], { type: 'join', code: created.code, ...profile(`P${seat}`) });
    }
    await action(sockets[0], { type: 'start' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const playing = states.find((state) => state?.phase === 'playing');
    assert.ok(playing);
    const turn = playing.turnSeat;
    const turnSocket = sockets[turn];
    const nextTurnState = nextState(turnSocket, (state) => state.phase === 'playing' && state.turnSeat !== turn && state.lastPlay?.seatIndex === turn);
    const played = await action(turnSocket, { type: 'play', cardIds: [states[turn].hand[0].id] });
    assert.equal(played.ok, true);
    const next = await nextTurnState;
    const challenger = next.turnSeat;
    const revealState = nextState(turnSocket, (state) => state.phase === 'reveal');
    const rouletteState = nextState(turnSocket, (state) => state.phase === 'roulette');
    const challengeAction = await action(sockets[challenger], { type: 'challenge' });
    assert.equal(challengeAction.ok, true, JSON.stringify(challengeAction));
    await revealState;
    const roulette = await rouletteState;
    assert.equal(roulette.loserSeat === turn || roulette.loserSeat === challenger, true);
    const loser = roulette.loserSeat;
    const shotState = nextState(turnSocket, (state) => state.phase === 'roulette' && state.lastShot);
    const afterShotState = nextState(turnSocket, (state) => state.phase === 'playing' || state.phase === 'ended', 2000);
    assert.equal((await action(sockets[loser], { type: 'pullTrigger' })).ok, true);
    const shot = await shotState;
    assert.equal(Number.isInteger(shot.lastShot.shot), true);
    const after = await afterShotState;
    assert.ok(after.phase === 'playing' || after.phase === 'ended');
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await server.close();
  }
});

test('all-human-connections-gone pauses new AI calls', async () => {
  let calls = 0;
  const { server, url } = await openServer({
    durations: { aiDelayMinMs: 10, aiDelayMaxMs: 10 },
    aiProvider: async () => { calls += 1; return { action: 'challenge', cardIds: [] }; },
  });
  const socket = connect(url, { transports: ['websocket'] });
  try {
    await new Promise((resolve) => socket.once('connect', resolve));
    const created = await action(socket, { type: 'create', ...profile('Host') });
    await action(socket, { type: 'setSeat', seatIndex: 0, kind: 'ai' });
    for (let seat = 0; seat < 4; seat += 1) {
      await action(socket, { type: 'configureAI', seatIndex: seat, baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'k' });
    }
    assert.equal((await action(socket, { type: 'start' })).ok, true);
    assert.equal((await action(socket, { type: 'leave' })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls, 0);
    assert.ok(server.rooms.has(created.code));
  } finally {
    socket.disconnect();
    await server.close();
  }
});

test('injected provider drives multi-turn play, roulette, speech, and resume through Socket.IO', async () => {
  let calls = 0;
  const phases = [];
  const provider = async ({ phase, publicState, selfHand, ai }) => {
    calls += 1;
    phases.push(phase);
    assert.equal(ai.apiKey, 'test-key', 'server provider route receives private config in memory');
    assert.equal(ai.baseUrl, 'https://provider.example/v1');
    assert.equal(publicState.players.some((player) => Object.hasOwn(player.ai || {}, 'apiKey')), false);
    if (phase === 'roulette') return { action: 'pullTrigger', speech: '扳机。' };
    if (publicState.mustChallenge) return { action: 'challenge', cardIds: [], speech: '我质疑。' };
    assert.ok(selfHand.length > 0, 'AI turn must expose its own hand');
    return { action: 'play', cardIds: [selfHand[0].id], speech: '出牌。' };
  };
  const { server, url } = await openServer({
    aiProvider: provider,
    durations: {
      aiDelayMinMs: 35,
      aiDelayMaxMs: 35,
      revealMs: 12,
      rouletteVisibleMs: 80,
      triggerMs: 1000,
      turnMs: 40,
    },
    sweepEvery: 10,
  });
  const socket = connect(url, { transports: ['websocket'] });
  const resumedSocket = connect(url, { transports: ['websocket'] });
  const states = [];
  socket.on('state', (state) => states.push(state));
  resumedSocket.on('state', (state) => states.push(state));
  let token;
  let code;
  try {
    await new Promise((resolve) => socket.once('connect', resolve));
    const created = await action(socket, { type: 'create', ...profile('Observer') });
    assert.equal(created.ok, true);
    ({ code, token } = created);
    await action(socket, { type: 'setSeat', seatIndex: 0, kind: 'ai' });
    for (let seatIndex = 0; seatIndex < 4; seatIndex += 1) {
      const configured = await action(socket, {
        type: 'configureAI',
        seatIndex,
        baseUrl: 'https://provider.example/v1',
        model: 'test-model',
        apiKey: 'test-key',
        persona: `seat-${seatIndex}`,
      });
      assert.equal(configured.ok, true);
    }
    assert.equal((await action(socket, { type: 'start' })).ok, true);
    await waitUntil(() => calls >= 1);
    await waitUntil(() => phases.filter((phase) => phase === 'playing').length >= 3);
    const callsBeforeDisconnect = calls;
    socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(calls, callsBeforeDisconnect, 'no new provider call while every human connection is gone');

    await new Promise((resolve) => (resumedSocket.connected ? resolve() : resumedSocket.once('connect', resolve)));
    const resumed = await action(resumedSocket, { type: 'resume', code, token });
    assert.deepEqual({ ok: resumed.ok, mySeat: resumed.mySeat }, { ok: true, mySeat: null });
    await waitUntil(() => calls > callsBeforeDisconnect);
    await waitUntil(() => phases.includes('roulette'));
    await waitUntil(() => states.some((state) => state.lastShot));
    assert.ok(phases.filter((phase) => phase === 'playing').length >= 3);
    assert.ok(states.some((state) => state.events.some((event) => event.type === 'speech')));
    assert.ok(states.some((state) => state.phase === 'roulette'));
    const latestHostState = states.at(-1);
    assert.equal(latestHostState.isHost, true);
    assert.equal(latestHostState.hand.length, 0);
    assert.equal(Object.hasOwn(latestHostState.players[0].ai, 'apiKey'), false);
  } finally {
    socket.disconnect();
    resumedSocket.disconnect();
    await server.close();
  }
});
