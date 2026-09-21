import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDecision, validateDecision, validateProviderEndpoint } from '../ai.js';

function fakeFetchFactory(outputs, seen) {
  let index = 0;
  return async (url, init) => {
    seen.push({ url, init: JSON.parse(init.body) });
    const text = outputs[Math.min(index++, outputs.length - 1)];
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: text } }] }; } };
  };
}

const config = { baseUrl: 'https://provider.example/v1', model: 'luna', apiKey: 'room-secret', protocol: 'chat' };
const view = { state: { phase: 'playing', targetRank: 'A', players: [{ seatIndex: 0, handCount: 2 }], events: [] }, selfSeat: 0, selfHand: [{ id: 'r1-A-1', rank: 'A' }] };

test('AI adapter sends only public view and own hand, never key or hidden chamber', async () => {
  const seen = [];
  const result = await requestDecision(config, view, {
    hand: view.selfHand,
    fetchImpl: fakeFetchFactory(['{"action":"play","cardIds":["r1-A-1"],"speech":"call"}'], seen),
  });
  assert.equal(result.action, 'play');
  assert.equal(result.calls, 1);
  const request = JSON.stringify(seen[0].init.messages[1]);
  assert.match(seen[0].url, /chat\/completions$/);
  assert.match(request, /r1-A-1/);
  assert.doesNotMatch(request, /room-secret/);
  assert.doesNotMatch(request, /chamber|lethal/i);
  assert.equal(seen[0].init.response_format, undefined);
});

test('malformed model output receives one bounded repair call, then succeeds', async () => {
  const seen = [];
  const result = await requestDecision(config, view, {
    hand: view.selfHand,
    fetchImpl: fakeFetchFactory(['not json', '{"action":"challenge","cardIds":[],"speech":"sure"}'], seen),
  });
  assert.equal(result.action, 'challenge');
  assert.equal(result.calls, 2);
  assert.equal(seen.length, 2);
  assert.match(seen[1].init.messages[1].content, /previous response was invalid/i);
});

test('decision validation rejects opponent card ids and preserves roulette action', () => {
  assert.throws(() => validateDecision({ action: 'play', cardIds: ['other'], speech: '' }, { hand: [{ id: 'mine' }] }), /not in own hand/);
  assert.deepEqual(validateDecision({ action: 'pullTrigger', cardIds: [], speech: '' }, { phase: 'roulette' }), { action: 'pullTrigger', cardIds: [], speech: '' });
  assert.throws(() => validateDecision({ action: 'pullTrigger', cardIds: ['card'], speech: '' }, { phase: 'roulette' }), /card ids must be empty/);
  assert.throws(() => validateDecision({ action: 'challenge', cardIds: [], speech: '' }, { legalActions: ['play'] }), /not legal/);
});

test('provider endpoint rejects credentials and private hosts', async () => {
  await assert.rejects(() => validateProviderEndpoint('http://user:pass@example.com/v1'), /rejected/);
  await assert.rejects(() => validateProviderEndpoint('http://127.0.0.1:9/v1'), /rejected/);
  await assert.rejects(() => validateProviderEndpoint('http://[::ffff:7f00:1]:9/v1'), /rejected/);
  await assert.rejects(() => validateProviderEndpoint('http://[::ffff:127.0.0.1]:9/v1'), /rejected/);
});

test('provider response body is bounded before JSON parsing', async () => {
  const huge = 'x'.repeat(256 * 1024 + 1);
  const fetchImpl = async () => ({ ok: true, status: 200, async text() { return huge; } });
  await assert.rejects(() => requestDecision(config, view, { fetchImpl }), /too large/);
});

test('streaming provider response is cancelled as soon as it exceeds the body cap', async () => {
  let cancelled = false;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let index = 0;
        return {
          async read() {
            index += 1;
            if (index === 1) return { done: false, value: new Uint8Array(256 * 1024) };
            return { done: false, value: new Uint8Array(1) };
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
  });
  await assert.rejects(() => requestDecision(config, view, { fetchImpl }), /too large/);
  assert.equal(cancelled, true);
});

test('stream abort is reported as a timeout without a format-repair retry', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              const error = new Error('aborted');
              error.name = 'TimeoutError';
              throw error;
            },
            releaseLock() {},
          };
        },
      },
    };
  };
  await assert.rejects(() => requestDecision(config, view, { fetchImpl }), /timed out/);
  assert.equal(calls, 1);
});

test('chat token budget selects compatible field for reasoning model and remains configurable', async () => {
  const seen = [];
  await requestDecision({ ...config, model: 'gpt-5.6-luna', maxOutputTokens: 2048, tokenLimitField: 'auto' }, view, {
    hand: view.selfHand,
    fetchImpl: fakeFetchFactory(['{"action":"challenge","cardIds":[],"speech":"ok"}'], seen),
  });
  assert.equal(seen[0].init.max_completion_tokens, 2048);
  assert.equal(seen[0].init.max_tokens, undefined);
  const ordinary = [];
  await requestDecision({ ...config, model: 'provider-chat', maxOutputTokens: 3072, tokenLimitField: 'auto' }, view, {
    hand: view.selfHand,
    fetchImpl: fakeFetchFactory(['{"action":"challenge","cardIds":[],"speech":"ok"}'], ordinary),
  });
  assert.equal(ordinary[0].init.max_tokens, 3072);
});
