import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server.js';

const PROVIDER_DELAY_MS = 80;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function action(socket, payload, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`action timeout: ${payload.type}`)), timeout);
    socket.emit('action', payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function connected(socket) {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }
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

async function waitUntil(predicate, timeout = 8000, interval = 5) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(interval);
  }
  throw new Error('condition wait timeout');
}

function profile(name) {
  return { name, gender: 'male', skin: 0 };
}

test('all-AI socket flow pauses without humans and resumes with host token', async () => {
  const providerRequests = [];
  const providerErrors = [];
  let activeProviders = 0;
  const provider = async ({ room, seatIndex, phase }) => {
    activeProviders += 1;
    try {
      const view = room.aiView(seatIndex);
      const legalActions = Array.isArray(view?.state?.legalActions) ? view.state.legalActions : [];
      providerRequests.push({
        phase,
        seatIndex,
        round: view?.state?.round,
        legalActions: [...legalActions],
      });
      if (!view || view.state.phase !== phase) {
        providerErrors.push(`view phase mismatch for seat ${seatIndex}`);
      }
      if (phase === 'roulette') {
        if (!legalActions.includes('pullTrigger')) providerErrors.push('roulette legalActions missing pullTrigger');
        await sleep(PROVIDER_DELAY_MS);
        return {
          action: 'pullTrigger',
          cardIds: [],
          speech: `第${seatIndex + 1}席扣下扳机`,
        };
      }
      if (legalActions.includes('challenge') && view.state.lastPlay) {
        await sleep(PROVIDER_DELAY_MS);
        return {
          action: 'challenge',
          cardIds: [],
          speech: `第${seatIndex + 1}席提出质疑`,
        };
      }
      if (!legalActions.includes('play') || !view.selfHand?.[0]?.id) {
        providerErrors.push(`playing view has no legal play for seat ${seatIndex}`);
        await sleep(PROVIDER_DELAY_MS);
        return { action: 'challenge', cardIds: [], speech: '等待公开记录' };
      }
      await sleep(PROVIDER_DELAY_MS);
      return {
        action: 'play',
        cardIds: [view.selfHand[0].id],
        speech: `第${seatIndex + 1}席出牌`,
      };
    } finally {
      activeProviders -= 1;
    }
  };

  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    aiProvider: provider,
    durations: {
      aiDelayMinMs: 1,
      aiDelayMaxMs: 1,
      revealMs: 4,
      rouletteVisibleMs: 4,
      turnMs: 20,
      triggerMs: 20,
    },
    sweepEvery: 2,
  });
  const address = await server.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
  const socket = connect(url, { transports: ['websocket'] });
  const states = [];
  socket.on('state', (state) => states.push(state));
  let resumeSocket = null;
  let token;
  let code;

  try {
    await connected(socket);
    const created = await action(socket, { type: 'create', ...profile('AI 旁观房主') });
    assert.equal(created?.ok, true, JSON.stringify(created));
    ({ code, token } = created);

    const switched = await action(socket, { type: 'setSeat', seatIndex: 0, kind: 'ai' });
    assert.equal(switched?.ok, true, JSON.stringify(switched));
    for (let seatIndex = 0; seatIndex < 4; seatIndex += 1) {
      const configured = await action(socket, {
        type: 'configureAI',
        seatIndex,
        baseUrl: 'https://provider.example/v1',
        model: 'deterministic-test-model',
        apiKey: 'test-only-key',
        protocol: 'chat',
        persona: `seat-${seatIndex}`,
      });
      assert.equal(configured?.ok, true, JSON.stringify(configured));
    }

    const started = await action(socket, { type: 'start' });
    assert.equal(started?.ok, true, JSON.stringify(started));
    await waitUntil(() => providerRequests.length >= 6, 8000);
    await waitUntil(() => activeProviders === 0, 3000);

    assert.deepEqual(providerErrors, []);
    assert.ok(providerRequests.length >= 6, `provider requests: ${providerRequests.length}`);
    assert.ok(providerRequests.some((request) => request.phase === 'playing'));
    assert.ok(providerRequests.some((request) => request.phase === 'roulette'));
    assert.ok(new Set(providerRequests.map((request) => request.seatIndex)).size >= 2, 'AI requests should involve multiple seats');
    assert.ok(new Set(providerRequests.map((request) => request.round)).size >= 2, 'AI requests should cross rounds');
    assert.ok(providerRequests.some((request) => request.legalActions.includes('play')));
    assert.ok(providerRequests.some((request) => request.legalActions.includes('challenge')));
    assert.ok(providerRequests.some((request) => request.legalActions.includes('pullTrigger')));
    assert.ok(states.some((state) => state.events?.some((event) => event.type === 'speech')), 'speech must be public in state events');

    const callsBeforeDisconnect = providerRequests.length;
    socket.disconnect();
    await waitUntil(() => server.sessions.size === 0, 1000);
    await sleep(PROVIDER_DELAY_MS + 50);
    assert.equal(providerRequests.length, callsBeforeDisconnect, 'all-human disconnect must stop new provider calls');

    resumeSocket = connect(url, { transports: ['websocket'] });
    const resumedStates = [];
    resumeSocket.on('state', (state) => resumedStates.push(state));
    await connected(resumeSocket);
    const resumed = await action(resumeSocket, { type: 'resume', code, token });
    assert.deepEqual({ ok: resumed?.ok, mySeat: resumed?.mySeat }, { ok: true, mySeat: null });
    await waitUntil(() => providerRequests.length > callsBeforeDisconnect, 4000);
    assert.ok(resumedStates.length > 0, 'resume must receive current state');
  } finally {
    socket.disconnect();
    resumeSocket?.disconnect();
    await waitUntil(() => activeProviders === 0, 3000).catch(() => {});
    await server.close();
  }
});
