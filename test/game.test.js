import test from 'node:test';
import assert from 'node:assert/strict';
import { LiarRoom, calculateNextRisk } from '../game.js';

const profile = (name) => ({ name, gender: 'male', skin: 0 });
const aiDefaults = { baseUrl: 'https://provider.example/v1', model: 'test-model', apiKey: 'test-key' };

function room(options = {}) {
  return new LiarRoom({
    host: profile('Host'),
    aiDefaults,
    autoTimers: false,
    rng: () => 0.17,
    ...options,
  });
}

function hostActor(r) { return { isHost: true, seatIndex: 0, profile: profile('Host') }; }

test('new room has four fixed occupied seats, and public state hides every hidden card', () => {
  const r = room();
  assert.deepEqual(r.players.map((p) => p.kind), ['human', 'ai', 'ai', 'ai']);
  assert.equal(r.players[1].hand.length, 0);
  assert.equal(r.publicStateFor(0).hand.length, 0);
  r.start(hostActor(r));
  assert.equal(r.players.every((p) => p.hand.length === 5), true);
  const state = r.publicStateFor(0);
  assert.equal(state.hand.length, 5);
  assert.equal(Object.hasOwn(state.players[1], 'hand'), false);
  assert.equal(Object.hasOwn(state.players[1].ai, 'apiKey'), false);
  assert.equal(state.players[1].ai.baseUrl, undefined);
});

test('play accepts only own unique 1-3 cards and challenge reveals only after the claim', () => {
  const r = room();
  r.start(hostActor(r));
  const first = r.turnSeat;
  const other = r.players.find((p) => p.seatIndex !== first && p.alive && p.hand.length > 0).seatIndex;
  const card = r.players[first].hand[0];
  assert.throws(() => r.play(first, [card.id, card.id]), /duplicate/);
  assert.throws(() => r.play(first, ['not-owned']), /not in hand/);
  r.play(first, [card.id]);
  assert.deepEqual(r.lastPlay, { seatIndex: first, count: 1 });
  assert.equal(r.reveal, null);
  const challenger = r.turnSeat;
  assert.notEqual(challenger, first);
  r.challenge(challenger);
  assert.equal(r.phase, 'reveal');
  assert.equal(r.reveal.playedBy, first);
  assert.equal(r.reveal.cards.length, 1);
  assert.equal(r.reveal.cards[0], card.rank);
  assert.equal(r.players[other].hand.length, 5);
});

test('only remaining hand holder must challenge the previous player', () => {
  const r = room();
  r.start(hostActor(r));
  const playedBy = r.turnSeat;
  for (const p of r.players) if (p.seatIndex !== playedBy && p.seatIndex !== (playedBy + 1) % 4) p.hand = [];
  const card = r.players[playedBy].hand[0];
  r.players[playedBy].hand = [card];
  r.play(playedBy, [card.id]);
  const sole = r.players.find((p) => p.alive && p.hand.length > 0);
  assert.ok(sole);
  assert.equal(r.turnSeat, sole.seatIndex);
  assert.equal(r.mustChallenge, sole.seatIndex !== playedBy);
  assert.throws(() => r.play(sole.seatIndex, [sole.hand[0].id]), /must challenge/);
});

test('risk is 1/6 then rises to certain on the sixth chamber; shots persist across rounds', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(calculateNextRisk), [1 / 6, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 1]);
  const r = room({ rng: Math.random });
  r.start(hostActor(r));
  const seat = r.players[0];
  seat.chamber = 6;
  for (let shot = 1; shot <= 5; shot += 1) {
    r.phase = 'roulette';
    r.loserSeat = seat.seatIndex;
    r.lastShot = null;
    r.pullTrigger(seat.seatIndex);
    assert.equal(seat.shots, shot);
    assert.equal(r.lastShot.fatal, false);
  }
  assert.equal(seat.shots, 5);
  r.phase = 'roulette';
  r.loserSeat = seat.seatIndex;
  r.lastShot = null;
  r.pullTrigger(seat.seatIndex);
  assert.equal(r.lastShot.shot, 6);
  assert.equal(r.lastShot.fatal, true);
  assert.equal(seat.alive, false);
});

test('leaving during a match keeps a disconnected human placeholder for timeout control', () => {
  const r = room();
  r.start(hostActor(r));
  r.turnSeat = 0;
  r.deadline = Date.now() + 30_000;
  r.leave(0);
  assert.equal(r.players[0].kind, 'human');
  assert.equal(r.players[0].connected, false);
  assert.equal(r.players[0].alive, true);
  assert.equal(r.players[0].token, r.hostToken);
  r.timeoutTurn(0);
  assert.equal(r.players[0].kind, 'human');
  assert.match(r.events.at(-2).text + r.events.at(-1).text, /超时/);
});

test('injected deterministic strategy can drive a complete all-AI simulation without a product bot', async () => {
  const r = room({ rng: Math.random });
  r.setSeat(hostActor(r), { seatIndex: 0, kind: 'ai' });
  r.configureAI(hostActor(r), { seatIndex: 0, baseUrl: aiDefaults.baseUrl, model: aiDefaults.model, apiKey: aiDefaults.apiKey });
  const strategy = async ({ room: target, seatIndex, phase }) => {
    if (phase === 'roulette') return { action: 'pullTrigger' };
    if (target.mustChallenge) return { action: 'challenge' };
    return { action: 'play', cardIds: [target.players[seatIndex].hand[0].id] };
  };
  r.start({ isHost: true, seatIndex: null });
  let steps = 0;
  while (r.phase !== 'ended' && steps < 1000) {
    steps += 1;
    if (r.phase === 'playing') await r.requestAIDecision(r.turnSeat, strategy);
    else if (r.phase === 'reveal') r.enterRoulette();
    else if (r.phase === 'roulette') {
      if (!r.lastShot) await r.requestAITrigger(r.loserSeat, strategy);
      else r.afterShot();
    }
  }
  assert.ok(steps < 1000, `simulation stalled after ${steps}`);
  assert.equal(r.phase, 'ended');
  assert.ok(Number.isInteger(r.winnerSeat));
});

test('AI call accounting honors zero and does not double count an invalid action', async () => {
  const r = room();
  r.setSeat(hostActor(r), { seatIndex: 0, kind: 'ai' });
  r.configureAI(hostActor(r), { seatIndex: 0, baseUrl: aiDefaults.baseUrl, model: aiDefaults.model, apiKey: aiDefaults.apiKey });
  r.start({ isHost: true, seatIndex: null });

  const firstSeat = r.turnSeat;
  const firstCard = r.players[firstSeat].hand[0];
  await r.requestAIDecision(firstSeat, async () => ({ action: 'play', cardIds: [firstCard.id], calls: 0 }));
  assert.equal(r.players[firstSeat].aiCalls, 0);
  assert.equal(r.totalAICalls, 0);

  const invalidSeat = r.turnSeat;
  await r.requestAIDecision(invalidSeat, async () => ({ action: 'play', cardIds: ['missing'], calls: 1 }));
  assert.equal(r.players[invalidSeat].aiCalls, 1);
  assert.equal(r.totalAICalls, 1);
});
