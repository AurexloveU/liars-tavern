import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  CODEX_EFFORT,
  CODEX_MODEL,
  CodexAppServerClient,
  createCodexProvider,
  parseAction,
} from '../codex-provider.js';

function viewFor(seatIndex, phase = 'playing') {
  const cardId = `seat-${seatIndex}-card`;
  return {
    state: {
      code: 'TEST01',
      phase,
      round: 2,
      targetRank: 'K',
      turnSeat: seatIndex,
      players: [0, 1, 2, 3].map((index) => ({
        seatIndex: index,
        name: `席位${index + 1}`,
        kind: 'ai',
        alive: true,
        connected: true,
        handCount: 5,
        shots: 0,
        nextRisk: 1 / 6,
      })),
      lastPlay: phase === 'playing' ? null : { seatIndex: 0, count: 1 },
      mustChallenge: false,
      pileCount: 0,
      loserSeat: phase === 'roulette' ? seatIndex : null,
      reveal: null,
      lastShot: null,
      winnerSeat: null,
      events: [],
      deadline: null,
      legalActions: phase === 'roulette' ? ['pullTrigger'] : ['play'],
    },
    selfSeat: seatIndex,
    selfHand: [{ id: cardId, rank: 'A' }],
  };
}

function makeRoom() {
  return {
    code: 'TEST01',
    aiView(seatIndex) {
      return viewFor(seatIndex, this.phase || 'playing');
    },
  };
}

class FakeClient {
  constructor(responses = []) {
    this.responses = [...responses];
    this.turns = [];
    this.stats = { turns: 0, inputTokens: 0, outputTokens: 0 };
  }

  async ready() {
    this.readyCount = (this.readyCount || 0) + 1;
    return { ok: true };
  }

  async runTurn(options) {
    this.turns.push(options);
    this.stats.turns += 1;
    const text = this.responses.shift();
    if (text instanceof Error) throw text;
    return { text, tokenUsage: { last: { inputTokens: 12, outputTokens: 8 } } };
  }

  async close() {
    this.closed = true;
  }
}

test('Codex provider sends only the private view and uses fixed model contract', async () => {
  const client = new FakeClient(['{"action":"play","cardIds":["seat-1-card"],"speech":"我出一张。"}']);
  const provider = createCodexProvider({ client, maxCallsPerRoom: 6 });
  const room = makeRoom();
  const result = await provider({ room, seatIndex: 1, phase: 'playing' });
  assert.deepEqual(result, { action: 'play', cardIds: ['seat-1-card'], speech: '我出一张。', calls: 1 });
  assert.equal(client.turns.length, 1);
  const request = client.turns[0];
  assert.match(request.text, /seat-1-card/);
  assert.doesNotMatch(request.text, /seat-0-card/);
  assert.equal(request.outputSchema.properties.action.enum.includes('play'), true);
  assert.equal(request.outputSchema.properties.action.enum.includes('pullTrigger'), false);
  assert.equal(request.timeoutMs, 120_000);
  await provider.ready();
  assert.equal(client.readyCount, 1);
  await provider.close();
  assert.equal(client.closed, true);
});

test('Codex provider allows one bounded JSON repair and counts both real requests', async () => {
  const client = new FakeClient([
    'not json',
    '{"action":"play","cardIds":["seat-2-card"],"speech":"试探。"}',
  ]);
  const provider = createCodexProvider({ client, maxCallsPerRoom: 6 });
  const room = makeRoom();
  const result = await provider({ room, seatIndex: 2 });
  assert.equal(result.calls, 2);
  assert.equal(client.turns.length, 2);
  assert.match(client.turns[1].text, /previous response was invalid/i);
  assert.match(client.turns[1].text, /invalid/i);
});

test('Codex provider fails closed after one invalid repair and never falls back', async () => {
  const client = new FakeClient(['{}', '{"action":"play","cardIds":["opponent-card"],"speech":"越界。"}']);
  const provider = createCodexProvider({ client, maxCallsPerRoom: 6 });
  const room = makeRoom();
  await assert.rejects(
    provider({ room, seatIndex: 0 }),
    (error) => error.code === 'CODEX_OUTPUT_INVALID' && error.calls === 2,
  );
  assert.equal(client.turns.length, 2);
});

test('Codex provider enforces a per-room turn request cap across seats', async () => {
  const client = new FakeClient([
    '{"action":"play","cardIds":["seat-0-card"],"speech":"一。"}',
    '{"action":"play","cardIds":["seat-1-card"],"speech":"二。"}',
  ]);
  const provider = createCodexProvider({ client, maxCallsPerRoom: 2 });
  const room = makeRoom();
  await provider({ room, seatIndex: 0 });
  await provider({ room, seatIndex: 1 });
  await assert.rejects(provider({ room, seatIndex: 2 }), (error) => error.code === 'CODEX_ROOM_CALL_LIMIT' && error.calls === 0);
  assert.equal(client.turns.length, 2);
});

test('Codex roulette schema only permits pullTrigger', async () => {
  const client = new FakeClient(['{"action":"pullTrigger","cardIds":[],"speech":"扣下扳机。"}']);
  const provider = createCodexProvider({ client, maxCallsPerRoom: 6 });
  const room = makeRoom();
  room.phase = 'roulette';
  const result = await provider({ room, seatIndex: 3, phase: 'roulette' });
  assert.equal(result.action, 'pullTrigger');
  assert.deepEqual(client.turns[0].outputSchema.properties.action.enum, ['pullTrigger']);
  assert.equal(client.turns[0].outputSchema.properties.cardIds.maxItems, 0);
});

test('JSONL client uses isolated read-only app-server settings and consumes notifications', async () => {
  const requests = [];
  let child;
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.killed = false;
      this.stdin = {
        writable: true,
        write: (line) => {
          const message = JSON.parse(line);
          requests.push(message);
          if (message.id == null) return true;
          let result = {};
          if (message.method === 'thread/start') result = { model: CODEX_MODEL, thread: { id: 'thread-test', model: CODEX_MODEL } };
          if (message.method === 'turn/start') {
            result = { turn: { id: 'turn-test' } };
            setImmediate(() => {
              this.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'item-test', delta: '{"action":"play","cardIds":["seat-0-card"],"speech":"测试。"}' } })}\n`);
              this.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } })}\n`);
            });
          }
          if (message.method === 'account/read') result = { account: { type: 'chatgpt' }, requiresOpenaiAuth: false };
          if (message.method === 'model/list') result = { data: [{ id: CODEX_MODEL }] };
          setImmediate(() => this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
          return true;
        },
      };
    }

    kill() {
      this.killed = true;
      this.emit('exit', 0, 'SIGTERM');
      return true;
    }
  }
  const client = new CodexAppServerClient({
    codexPath: '/fake/codex',
    cwd: '/tmp/liars-codex-runtime-test',
    spawnImpl: (_path, args, options) => {
      child = new FakeChild();
      assert.deepEqual(args, [
        'app-server', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'plugins',
        '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'hooks', '--disable', 'memories',
        '--disable', 'multi_agent', '--disable', 'skill_search', '--disable', 'view_image', '--disable', 'workspace_dependencies',
        '--disable', 'image_generation', '--disable', 'tool_suggest', '--disable', 'code_mode_host', '--stdio',
        '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-c', 'features.shell_tool=false',
        '-c', 'features.apps=false',
        '-c', 'mcp_servers.openaiDeveloperDocs.enabled=false', '-c', 'mcp_servers.health-collar.enabled=false',
        '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'mcp_servers.computer-use.enabled=false',
      ]);
      assert.equal(options.cwd, '/tmp/liars-codex-runtime-test');
      return child;
    },
  });
  const output = await client.runTurn({ text: 'return game action JSON' });
  assert.match(output.text, /seat-0-card/);
  assert.equal(requests.some((request) => request.method === 'account/read'), true);
  assert.equal(requests.some((request) => request.method === 'model/list'), true);
  assert.equal(requests.some((request) => request.method === 'turn/start' && request.params.model === CODEX_MODEL && request.params.effort === CODEX_EFFORT), true);
  const turnStart = requests.find((request) => request.method === 'turn/start');
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turnStart.params.outputSchema.type, 'object');
  await client.close();
  assert.equal(child.killed, true);
});

test('parseAction accepts a bounded fenced JSON object only', () => {
  assert.deepEqual(parseAction('```json\n{"action":"challenge","cardIds":[],"speech":"质疑。"}\n```'), {
    action: 'challenge', cardIds: [], speech: '质疑。',
  });
  assert.throws(() => parseAction('not-json'), (error) => error.code === 'CODEX_OUTPUT_INVALID');
});
