import test from 'node:test';
import assert from 'node:assert/strict';
import { LiarRoom, isAIConfigured } from '../game.js';
import { createGameServer } from '../server.js';

const host = { name: '测试玩家', gender: 'female', skin: 0 };
const actor = { isHost: true, seatIndex: 0 };

test('Codex seats require an explicit local server capability', () => {
  const room = new LiarRoom({ host, autoTimers: false });
  assert.throws(() => room.configureAI(actor, {
    seatIndex: 1, protocol: 'codex', codexEnabled: true,
  }), /only enabled/);
  assert.equal(room.publicStateFor(0).codexAvailable, false);
  assert.equal(isAIConfigured(room.players[1].ai), false);
  assert.equal(isAIConfigured({ protocol: 'codex', model: 'gpt-5.6-luna' }), false);
  room.destroy();
});

test('local Codex defaults fill three real AI seats without pretend API keys', () => {
  const room = new LiarRoom({ host, autoTimers: false, allowCodex: true,
    aiDefaults: { protocol: 'codex', model: 'gpt-5.6-luna' } });
  assert.equal(room.publicStateFor(0).codexAvailable, true);
  for (const seat of room.players.slice(1)) {
    assert.equal(seat.kind, 'ai');
    assert.equal(isAIConfigured(seat.ai), true);
    assert.equal(room.publicAIFor(seat.seatIndex).hasKey, false);
    assert.equal(seat.ai.apiKey, '');
  }
  room.configureAI(actor, { seatIndex: 1, protocol: 'codex', model: 'arbitrary-model', apiKey: 'should-not-be-kept' });
  assert.equal(room.players[1].ai.model, 'gpt-5.6-luna');
  assert.equal(room.players[1].ai.apiKey, '');
  room.start(actor);
  assert.equal(room.phase, 'playing');
  assert.equal(room.players[0].hand.length, 5);
  const view = JSON.stringify(room.aiView(1));
  assert.equal(view.includes(room.hostToken), false);
  for (const card of room.players[0].hand) assert.equal(view.includes(card.id), false);
  room.destroy();
});

test('host config reports Codex readiness and changing back to API requires real credentials', async () => {
  const room = new LiarRoom({ host, autoTimers: false, allowCodex: true,
    aiDefaults: { protocol: 'codex' } });
  const server = createGameServer({ rooms: new Map([[room.code, room]]) });
  try {
    const state = server.stateFor(room, { isHost: true, seatIndex: 0 });
    assert.equal(state.hostConfigs.length, 3);
    assert.equal(state.hostConfigs.every((ai) => ai.configured && !ai.hasKey), true);
    room.configureAI(actor, { seatIndex: 1, protocol: 'chat', baseUrl: 'https://example.com/v1', model: 'example' });
    assert.equal(isAIConfigured(room.players[1].ai), false);
    room.configureAI(actor, { seatIndex: 1, apiKey: 'test-only-key' });
    assert.equal(isAIConfigured(room.players[1].ai), true);
    assert.equal(room.players[1].ai.protocol, 'chat');
  } finally {
    await server.close();
  }
});
