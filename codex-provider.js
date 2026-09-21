import { spawn as defaultSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AI_SYSTEM_PROMPT,
  AIProviderError,
  buildMessages,
  validateDecision,
} from './ai.js';

export const CODEX_MODEL = 'gpt-5.6-luna';
export const CODEX_EFFORT = 'max';
export const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_CALLS_PER_ROOM = 150;
const MAX_OUTPUT_TEXT_BYTES = 256 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const CODEX_BIN = '/Users/aurexshen/Desktop/ChatGPT.app/Contents/Resources/codex';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME_CWD = path.join(HERE, 'ops', 'codex-runtime');

// This is the complete system-level game contract for a Codex player. The
// app-server receives this explicitly, so it never needs project instructions.
export const CODEX_BASE_INSTRUCTIONS = [
  'You are a player in a four-seat Liar\'s Deck game, not a coding agent.',
  'The deck has 6 A cards, 6 K cards, 6 Q cards, and 2 Jokers; each living seat starts a round with 5 cards.',
  'Jokers are wild and never make a claim false. Bluffing is allowed: a non-Joker may differ from the public target rank.',
  'The game view contains only public information and your own hand. Never request, invent, or claim hidden opponent cards or lethal chamber information.',
  'Use public history and probability, but never use a hidden card or chamber location.',
  'Return only one JSON object with action, cardIds, and speech. Do not return chain of thought, markdown, or tool calls.',
  'During playing, play 1 to 3 of your own cards or challenge the immediately previous play when legal. If legalActions contains only challenge, challenge.',
  'There is no challenge before the first play. During roulette, the only legal action is pullTrigger with cardIds exactly [].',
  'Speech should be a brief Simplified Chinese sentence and must not disclose hidden information.',
].join(' ');

const ACTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['play', 'challenge', 'pullTrigger'] },
    cardIds: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 3 },
    speech: { type: 'string', maxLength: 240 },
  },
  required: ['action', 'cardIds', 'speech'],
});

function actionSchemaFor(phase) {
  if (phase === 'roulette') {
    return {
      ...ACTION_SCHEMA,
      properties: {
        ...ACTION_SCHEMA.properties,
        action: { type: 'string', enum: ['pullTrigger'] },
        cardIds: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 0 },
      },
    };
  }
  return {
    ...ACTION_SCHEMA,
    properties: {
      ...ACTION_SCHEMA.properties,
      action: { type: 'string', enum: ['play', 'challenge'] },
    },
  };
}

function safeProviderError(message, { code = 'CODEX_ERROR', calls = 0, status = null } = {}) {
  const error = new AIProviderError(String(message).replace(/[\r\n\t]/g, ' ').slice(0, 240), {
    code,
    calls,
    status,
  });
  error.provider = 'codex';
  return error;
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function safeRpcError(error, fallbackCode = 'CODEX_RPC_ERROR') {
  if (error instanceof AIProviderError) return error;
  const code = String(error?.code || fallbackCode).slice(0, 80);
  return safeProviderError('Codex app-server request failed', { code, calls: error?.calls || 0 });
}

function textFromAgentItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text;
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return typeof part?.text === 'string' ? part.text : typeof part?.content === 'string' ? part.content : '';
  }).join('');
}

export function parseAction(text) {
  const source = String(text || '').trim();
  if (Buffer.byteLength(source, 'utf8') > MAX_OUTPUT_TEXT_BYTES) {
    throw safeProviderError('Codex output is too large', { code: 'CODEX_OUTPUT_INVALID' });
  }
  const candidates = [source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(source.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // A single bounded repair request is handled by createCodexProvider.
    }
  }
  throw safeProviderError('Codex output was not valid JSON', { code: 'CODEX_OUTPUT_INVALID' });
}

// Kept as a named alias for callers that use the game adapter vocabulary.
export const validateAction = validateDecision;

function roomKey(room) {
  if (room && (typeof room === 'object' || typeof room === 'function')) return room;
  return String(room || 'unknown');
}

function requestKey(threadId, turnId) {
  return `${String(threadId || '')}:${String(turnId || '')}`;
}

function modelEntryMatches(entry, requestedModel) {
  if (typeof entry === 'string') return entry === requestedModel;
  return [entry?.id, entry?.slug, entry?.model, entry?.name].some((value) => String(value || '') === requestedModel);
}

function approvalResult(method) {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return 'cancel';
  }
  if (method === 'item/permissions/requestApproval') return { permissions: null };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'cancel' };
  if (method === 'item/tool/call') return { content: [], isError: true };
  if (method === 'currentTime/read') return { currentTime: new Date(0).toISOString() };
  return null;
}

/**
 * Small JSONL JSON-RPC client for the local Codex app-server. It intentionally
 * has no dependency on Aevi's production Codex bridge or its caches.
 */
export class CodexAppServerClient {
  constructor({
    codexPath = process.env.LIARS_CODEX_BIN || CODEX_BIN,
    cwd = DEFAULT_RUNTIME_CWD,
    timeoutMs = DEFAULT_CODEX_TIMEOUT_MS,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    spawnImpl = defaultSpawn,
    logger = null,
  } = {}) {
    this.codexPath = codexPath;
    this.cwd = path.resolve(cwd);
    this.timeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_CODEX_TIMEOUT_MS);
    this.rpcTimeoutMs = Math.max(1, Number(rpcTimeoutMs) || DEFAULT_RPC_TIMEOUT_MS);
    this.spawnImpl = spawnImpl;
    this.logger = typeof logger === 'function' ? logger : null;
    this.child = null;
    this.readline = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.earlyEvents = new Map();
    this.seatThreads = new Map();
    this.readyPromise = null;
    this.closed = false;
    this.stats = { turns: 0, inputTokens: 0, outputTokens: 0 };
  }

  appServerArgs() {
    return [
      'app-server',
      '--disable', 'shell_tool',
      '--disable', 'unified_exec',
      '--disable', 'apps',
      '--disable', 'plugins',
      '--disable', 'browser_use',
      '--disable', 'computer_use',
      '--disable', 'hooks',
      '--disable', 'memories',
      '--disable', 'multi_agent',
      '--disable', 'skill_search',
      '--disable', 'view_image',
      '--disable', 'workspace_dependencies',
      '--disable', 'image_generation',
      '--disable', 'tool_suggest',
      '--disable', 'code_mode_host',
      '--stdio',
      '-c', 'project_doc_max_bytes=0',
      '-c', 'web_search="disabled"',
      '-c', 'features.shell_tool=false',
      '-c', 'features.apps=false',
      '-c', 'mcp_servers.openaiDeveloperDocs.enabled=false',
      '-c', 'mcp_servers.health-collar.enabled=false',
      '-c', 'mcp_servers.node_repl.enabled=false',
      '-c', 'mcp_servers.computer-use.enabled=false',
    ];
  }

  emitLog(record) {
    if (!this.logger) return;
    try {
      this.logger({
        event: 'codex-turn',
        seatIndex: Number.isInteger(record?.seatIndex) ? record.seatIndex : null,
        phase: typeof record?.phase === 'string' ? record.phase : '',
        calls: Number(record?.calls || 0),
        latencyMs: numberOrNull(record?.latencyMs),
        inputTokens: numberOrNull(record?.inputTokens),
        outputTokens: numberOrNull(record?.outputTokens),
        cachedInputTokens: numberOrNull(record?.cachedInputTokens),
        reusedThread: record?.reusedThread === true,
      });
    } catch {
      // Observability must never affect a game action.
    }
  }

  async ready() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this._ready().catch((error) => {
      this.readyPromise = null;
      throw safeRpcError(error, 'CODEX_NOT_READY');
    });
    return this.readyPromise;
  }

  async _ready() {
    if (this.closed) throw safeProviderError('Codex provider is closed', { code: 'CODEX_CLOSED' });
    mkdirSync(this.cwd, { recursive: true });
    this.child = this.spawnImpl(this.codexPath, this.appServerArgs(), {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!this.child?.stdin || !this.child?.stdout) throw safeProviderError('Codex app-server did not start', { code: 'CODEX_START_FAILED' });
    this.readline = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.readline.on('line', (line) => this.handleLine(line));
    // The protocol is stdout-only. Drain stderr without retaining or logging
    // it, otherwise a verbose CLI could block the child on a full pipe.
    this.child.stderr?.on?.('data', () => {});
    this.child.once?.('error', (error) => this.handleProcessError(error));
    this.child.once?.('exit', (code, signal) => this.handleProcessError(new Error(`process exited ${code ?? ''}${signal ? ` ${signal}` : ''}`)));

    await this.request('initialize', {
      clientInfo: { name: 'liars_tavern_codex', title: 'Liar\'s Tavern Codex Player', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, this.rpcTimeoutMs);
    this.notify('initialized');
    const account = await this.request('account/read', {}, this.rpcTimeoutMs);
    if (!account?.account || account.account.type !== 'chatgpt') {
      throw safeProviderError('Codex ChatGPT login is not ready', { code: 'CODEX_AUTH_REQUIRED' });
    }
    const listed = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const models = await this.request('model/list', { includeHidden: true, limit: 100, cursor }, this.rpcTimeoutMs);
      const pageItems = Array.isArray(models?.data) ? models.data : [];
      listed.push(...pageItems);
      if (pageItems.some((entry) => modelEntryMatches(entry, CODEX_MODEL))) break;
      const nextCursor = typeof models?.nextCursor === 'string' && models.nextCursor ? models.nextCursor : null;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    if (!listed.some((entry) => modelEntryMatches(entry, CODEX_MODEL))) {
      throw safeProviderError('Configured Codex model is unavailable', { code: 'CODEX_MODEL_UNAVAILABLE' });
    }
    return { ok: true, model: CODEX_MODEL, effort: CODEX_EFFORT, modelCount: listed.length };
  }

  handleProcessError(error) {
    const safe = safeRpcError(error, 'CODEX_PROCESS_EXIT');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(safe);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.done = true;
      turn.reject(safe);
    }
    this.turns.clear();
    this.seatThreads.clear();
    this.earlyEvents.clear();
    this.child = null;
    this.readline?.close?.();
    this.readline = null;
    if (!this.closed) this.readyPromise = null;
  }

  handleLine(line) {
    if (Buffer.byteLength(String(line), 'utf8') > MAX_OUTPUT_TEXT_BYTES) {
      this.handleProcessError(safeProviderError('Codex protocol frame too large', { code: 'CODEX_PROTOCOL_ERROR' }));
      return;
    }
    let message;
    try { message = JSON.parse(line); } catch {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(safeProviderError('Codex RPC returned an error', { code: `CODEX_RPC_${message.error.code || 'ERROR'}` }));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.replyToServerRequest(message);
      return;
    }
    this.handleNotification(message);
  }

  replyToServerRequest(message) {
    if (!this.child?.stdin?.writable) return;
    const result = approvalResult(message.method);
    try {
      this.child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
    } catch {
      // A dead process is handled by its exit callback.
    }
  }

  handleNotification(message) {
    const params = message?.params || {};
    const threadId = params.threadId;
    const turnId = params.turnId || params.turn?.id;
    const key = requestKey(threadId, turnId);
    let event = null;
    if (message.method === 'item/agentMessage/delta') event = { type: 'delta', delta: String(params.delta || '') };
    else if (message.method === 'item/completed' && params.item?.type === 'agentMessage') event = { type: 'agentCompleted', text: textFromAgentItem(params.item) };
    else if (message.method === 'thread/tokenUsage/updated') event = { type: 'tokenUsage', tokenUsage: params.tokenUsage || null };
    else if (message.method === 'turn/completed') event = { type: 'completed', turn: params.turn || null };
    else if (message.method === 'error') event = { type: 'error', error: safeProviderError('Codex turn failed', { code: 'CODEX_TURN_ERROR' }) };
    if (!event || !threadId) return;
    const turn = this.turns.get(key) || (!turnId && message.method === 'thread/tokenUsage/updated'
      ? [...this.turns.values()].find((active) => active.threadId === threadId) : null);
    if (turn) this.applyTurnEvent(turn, event);
    else {
      const queued = this.earlyEvents.get(key) || [];
      queued.push(event);
      this.earlyEvents.set(key, queued);
    }
  }

  applyTurnEvent(turn, event) {
    if (turn.done) return;
    if (event.type === 'delta') {
      turn.text += event.delta;
      return;
    }
    if (event.type === 'agentCompleted') {
      if (!turn.text) turn.text = event.text;
      return;
    }
    if (event.type === 'tokenUsage') {
      turn.tokenUsage = event.tokenUsage || turn.tokenUsage;
      return;
    }
    if (event.type === 'error') {
      turn.done = true;
      clearTimeout(turn.timer);
      this.turns.delete(requestKey(turn.threadId, turn.turnId));
      this.releaseThread(turn.threadId);
      turn.reject(event.error);
      return;
    }
    if (event.type === 'completed') {
      turn.completed = event.turn;
      turn.done = true;
      clearTimeout(turn.timer);
      this.turns.delete(requestKey(turn.threadId, turn.turnId));
      this.releaseThread(turn.threadId, turn.completed?.status === 'completed');
      if (turn.completed?.status !== 'completed') {
        turn.reject(safeProviderError('Codex turn did not complete', { code: 'CODEX_TURN_FAILED', calls: 1 }));
      } else {
        turn.resolve({ text: turn.text, turn: turn.completed, tokenUsage: turn.tokenUsage });
      }
    }
  }

  releaseThread(threadId, keep = false) {
    for (const [key, entry] of this.seatThreads) {
      if (entry.threadId !== threadId) continue;
      if (keep) { entry.busy = false; return; }
      this.seatThreads.delete(key);
      break;
    }
    this.unsubscribeThread(threadId);
  }

  trimSeatThreads() {
    // Keep a small number of independent seats loaded; never evict an active turn.
    for (const [key, entry] of this.seatThreads) {
      if (this.seatThreads.size < 12) break;
      if (entry.busy) continue;
      this.seatThreads.delete(key);
      this.unsubscribeThread(entry.threadId);
    }
  }

  unsubscribeThread(threadId) {
    if (!threadId || !this.child?.stdin?.writable) return;
    void this.request('thread/unsubscribe', { threadId }, this.rpcTimeoutMs).catch(() => {});
  }

  request(method, params = {}, timeoutMs = this.rpcTimeoutMs) {
    if (!this.child?.stdin?.writable) return Promise.reject(safeProviderError('Codex app-server is not running', { code: 'CODEX_NOT_RUNNING' }));
    const id = this.nextId++;
    const payload = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(safeProviderError('Codex RPC request timed out', { code: 'CODEX_RPC_TIMEOUT' }));
      }, Math.max(1, Number(timeoutMs) || this.rpcTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(safeProviderError('Codex app-server write failed', { code: 'CODEX_NOT_RUNNING' }));
      }
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) return;
    try { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); } catch { /* process exit handles state */ }
  }

  async runTurn({ text, outputSchema = ACTION_SCHEMA, timeoutMs = this.timeoutMs, developerInstructions = null, sessionKey = null } = {}) {
    await this.ready();
    const previous = sessionKey ? this.seatThreads.get(sessionKey) : null;
    const reusable = previous && !previous.busy && previous.developerInstructions === developerInstructions;
    let threadId = reusable ? previous.threadId : null;
    if (reusable) previous.busy = true;
    else if (previous && !previous.busy) this.releaseThread(previous.threadId);
    try {
      if (!threadId) {
        const thread = await this.request('thread/start', {
          model: CODEX_MODEL,
          cwd: this.cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          baseInstructions: CODEX_BASE_INSTRUCTIONS,
          developerInstructions,
          personality: 'none',
          ephemeral: true,
          allowProviderModelFallback: false,
          dynamicTools: [],
          runtimeWorkspaceRoots: [this.cwd],
          config: {
            project_doc_max_bytes: 0,
          },
        }, Math.min(this.rpcTimeoutMs, timeoutMs));
        const selectedModel = String(thread?.model || thread?.thread?.model || '');
        if (selectedModel !== CODEX_MODEL) {
          throw safeProviderError('Codex app-server selected an unexpected model', { code: 'CODEX_MODEL_MISMATCH' });
        }
        threadId = String(thread?.thread?.id || thread?.id || '');
        if (!threadId) throw safeProviderError('Codex thread did not return an id', { code: 'CODEX_PROTOCOL_ERROR' });
        if (sessionKey) {
          this.trimSeatThreads();
          this.seatThreads.set(sessionKey, { threadId, developerInstructions, busy: true });
        }
      }
      const started = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: String(text || ''), text_elements: [] }],
        model: CODEX_MODEL,
        effort: CODEX_EFFORT,
        approvalPolicy: 'never',
        cwd: this.cwd,
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        outputSchema,
        personality: 'none',
        runtimeWorkspaceRoots: [this.cwd],
        permissions: null,
      }, Math.min(this.rpcTimeoutMs, timeoutMs));
      const turnId = String(started?.turn?.id || started?.id || '');
      if (!turnId) throw safeProviderError('Codex turn did not return an id', { code: 'CODEX_PROTOCOL_ERROR', calls: 1 });
      return await new Promise((resolve, reject) => {
        const turn = {
          text: '', tokenUsage: null, completed: null, done: false, resolve, reject,
          threadId, turnId,
          timer: setTimeout(() => {
            if (turn.done) return;
            turn.done = true;
            this.turns.delete(requestKey(threadId, turnId));
            void this.request('turn/interrupt', { threadId, turnId }, this.rpcTimeoutMs).catch(() => {});
            this.releaseThread(threadId);
            reject(safeProviderError('Codex turn timed out', { code: 'CODEX_TIMEOUT', calls: 1 }));
          }, Math.max(1, Number(timeoutMs) || this.timeoutMs)),
        };
        const key = requestKey(threadId, turnId);
        this.turns.set(key, turn);
        const early = this.earlyEvents.get(key) || [];
        this.earlyEvents.delete(key);
        for (const event of early) this.applyTurnEvent(turn, event);
      }).then((result) => {
        const usage = result?.tokenUsage || {};
        const last = usage.last || usage;
        const inputTokens = numberOrNull(last.inputTokens ?? last.input_tokens);
        const outputTokens = numberOrNull(last.outputTokens ?? last.output_tokens);
        if (inputTokens != null) this.stats.inputTokens += inputTokens;
        if (outputTokens != null) this.stats.outputTokens += outputTokens;
        this.stats.turns += 1;
        return { ...result, reusedThread: Boolean(reusable) };
      });
    } catch (error) {
      if (threadId) this.releaseThread(threadId);
      throw error;
    }
  }

  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(safeProviderError('Codex provider closed', { code: 'CODEX_CLOSED' }));
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.done = true;
      turn.reject(safeProviderError('Codex provider closed', { code: 'CODEX_CLOSED' }));
    }
    this.turns.clear();
    this.seatThreads.clear();
    this.earlyEvents.clear();
    this.readline?.close?.();
    this.readline = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }
  }
}

function normalizedFailure(error, calls) {
  const currentCalls = Math.max(Number(error?.calls || 0), Number(calls || 0));
  if (error instanceof AIProviderError) {
    error.calls = currentCalls;
    return error;
  }
  const normalized = safeRpcError(error, 'CODEX_TURN_ERROR');
  normalized.calls = currentCalls;
  return normalized;
}

export function createCodexProvider(options = {}) {
  const client = options.client || new CodexAppServerClient(options);
  const maxCallsPerRoom = Math.max(1, Number(options.maxCallsPerRoom ?? options.maxRequestsPerRoom ?? DEFAULT_MAX_CALLS_PER_ROOM) || DEFAULT_MAX_CALLS_PER_ROOM);
  const roomCalls = new WeakMap();
  const roomSessions = new WeakMap();
  const namedRoomCalls = new Map();
  const log = typeof options.logger === 'function' ? options.logger : null;

  function getCalls(room) {
    return room && (typeof room === 'object' || typeof room === 'function')
      ? (roomCalls.get(room) || 0)
      : (namedRoomCalls.get(roomKey(room)) || 0);
  }

  function reserve(room) {
    const current = getCalls(room);
    if (current >= maxCallsPerRoom) throw safeProviderError('Codex room request limit reached', { code: 'CODEX_ROOM_CALL_LIMIT', calls: 0 });
    const next = current + 1;
    if (room && (typeof room === 'object' || typeof room === 'function')) roomCalls.set(room, next);
    else namedRoomCalls.set(roomKey(room), next);
    return next;
  }

  const provider = async ({ room, seatIndex, phase = 'playing', ai = {} } = {}) => {
    if (!room || !Number.isInteger(seatIndex)) throw safeProviderError('Codex request missing room seat', { code: 'CODEX_REQUEST_INVALID' });
    const view = room.aiView(seatIndex);
    const hand = Array.isArray(view?.selfHand) ? view.selfHand : [];
    const legalActions = Array.isArray(view?.state?.legalActions) ? view.state.legalActions : [];
    let sessions = roomSessions.get(room);
    if (!sessions) { sessions = new Map(); roomSessions.set(room, sessions); }
    // Separate every seat, and start a fresh session when a new match resets rounds.
    let session = sessions.get(seatIndex);
    if (!session || Number(view.state.round) < session.round) {
      session = { round: Number(view.state.round), key: {} };
      sessions.set(seatIndex, session);
    }
    session.round = Number(view.state.round);
    const messages = buildMessages(ai || {}, view);
    const messagesFor = (correction = '') => correction
      ? buildMessages(ai || {}, view, correction).user
      : messages.user;
    let calls = 0;
    const startedAt = Date.now();
    const run = async (correction = '') => {
      reserve(room);
      calls += 1;
      try {
        return await client.runTurn({
          text: messagesFor(correction),
          sessionKey: session.key,
          outputSchema: actionSchemaFor(phase),
          developerInstructions: messages.system,
          timeoutMs: options.timeoutMs ?? options.turnTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
          seatIndex,
          phase,
        });
      } catch (error) {
        throw normalizedFailure(error, calls);
      }
    };
    let result;
    try {
      result = await run();
    } catch (error) {
      error.calls = Math.max(Number(error?.calls || 0), calls);
      log?.({ event: 'codex-turn-error', seatIndex, phase, calls, latencyMs: Date.now() - startedAt, code: error.code || 'CODEX_ERROR' });
      throw error;
    }
    try {
      const decision = validateDecision(parseAction(result?.text), { phase, hand, legalActions });
      const usage = result?.tokenUsage || {};
      const last = usage.last || usage;
      client.emitLog?.({
        seatIndex, phase, calls, latencyMs: Date.now() - startedAt,
        inputTokens: last.inputTokens ?? last.input_tokens,
        outputTokens: last.outputTokens ?? last.output_tokens,
        cachedInputTokens: last.cachedInputTokens ?? last.cached_input_tokens,
        reusedThread: result?.reusedThread,
      });
      return { ...decision, calls };
    } catch (firstError) {
      if (!['CODEX_OUTPUT_INVALID', 'AI_OUTPUT_INVALID'].includes(firstError?.code)) throw normalizedFailure(firstError, calls);
      let repair;
      try {
        repair = await run(firstError.message);
      } catch (error) {
        log?.({ event: 'codex-turn-error', seatIndex, phase, calls, latencyMs: Date.now() - startedAt, code: error.code || 'CODEX_ERROR' });
        throw error;
      }
      try {
        const decision = validateDecision(parseAction(repair?.text), { phase, hand, legalActions });
        const usage = repair?.tokenUsage || {};
        const last = usage.last || usage;
        client.emitLog?.({
          seatIndex, phase, calls, latencyMs: Date.now() - startedAt,
          inputTokens: last.inputTokens ?? last.input_tokens,
          outputTokens: last.outputTokens ?? last.output_tokens,
          cachedInputTokens: last.cachedInputTokens ?? last.cached_input_tokens,
          reusedThread: repair?.reusedThread,
        });
        return { ...decision, calls };
      } catch {
        throw safeProviderError('Codex output remained invalid after one repair', { code: 'CODEX_OUTPUT_INVALID', calls });
      }
    }
  };

  provider.ready = (...args) => client.ready(...args);
  provider.close = (...args) => client.close(...args);
  provider.getStats = () => ({ ...client.stats, maxCallsPerRoom });
  provider.client = client;
  return provider;
}

export default createCodexProvider;
