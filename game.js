import { modelPreset, shortSpeech } from './public/model-presets.js';
import crypto from 'node:crypto';

export const RANKS = Object.freeze(['A', 'K', 'Q', 'JOKER']);
export const TARGET_RANKS = Object.freeze(['A', 'K', 'Q']);
export const PHASES = Object.freeze(['lobby', 'playing', 'reveal', 'roulette', 'ended']);
export const SEAT_COUNT = 4;
export const DECK = Object.freeze([
  ...Array.from({ length: 6 }, (_, i) => ({ id: `A-${i + 1}`, rank: 'A' })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `K-${i + 1}`, rank: 'K' })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `Q-${i + 1}`, rank: 'Q' })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `JOKER-${i + 1}`, rank: 'JOKER' })),
]);

const DEFAULT_SYSTEM_PROMPT = [
  'You are a player in a four-seat Liar\'s Deck game.',
  'Use only the public game state and your own hand supplied in this request.',
  'Never infer or request hidden opponent cards or the lethal chamber.',
  'Return one JSON object only: {"action":"play"|"challenge","cardIds":[...],"speech":"..."}.',
  'When action is play, choose 1 to 3 of your own card ids and claim the current target rank.',
  'When mustChallenge is true, use challenge. Do not include chain of thought.',
  'Talk to the table in Simplified Chinese; aim for 10 characters or fewer, and never exceed 20 characters including punctuation.',
].join(' ');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function randomInt(max, rng = Math.random) {
  const n = Number(rng());
  return Math.min(max - 1, Math.max(0, Number.isFinite(n) ? Math.floor(n * max) : 0));
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function validName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 40;
}

function validGender(gender) {
  return gender === 'male' || gender === 'female';
}

function validSkin(skin) {
  return Number.isInteger(skin) && skin >= 0 && skin <= 1;
}

function normalizedProtocol(protocol) {
  return ['chat', 'responses', 'anthropic', 'codex'].includes(protocol) ? protocol : 'chat';
}

function normalizedBaseUrl(baseUrl) {
  if (baseUrl == null || baseUrl === '') return '';
  if (typeof baseUrl !== 'string' || baseUrl.length > 500) throw new Error('baseUrl invalid');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('baseUrl invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('baseUrl rejected');
  return baseUrl.replace(/\/+$/, '');
}

function normalizedModel(model) {
  if (model == null || model === '') return '';
  if (typeof model !== 'string' || model.length > 200) throw new Error('model invalid');
  return model.trim();
}

function normalizedTokenLimitField(field) {
  return ['auto', 'max_tokens', 'max_completion_tokens'].includes(field) ? field : 'auto';
}

function normalizedMaxOutputTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 4096;
  return Math.max(256, Math.min(32768, Math.floor(parsed)));
}

function createAIConfig(source = {}, env = process.env, allowCodex = false) {
  const envBase = typeof env.LIARS_LLM_BASE_URL === 'string' ? env.LIARS_LLM_BASE_URL : '';
  const envModel = typeof env.LIARS_LLM_MODEL === 'string' ? env.LIARS_LLM_MODEL : '';
  const envKey = typeof env.LIARS_LLM_API_KEY === 'string' ? env.LIARS_LLM_API_KEY : '';
  const envProtocol = typeof env.LIARS_LLM_PROTOCOL === 'string' ? env.LIARS_LLM_PROTOCOL : 'chat';
  const envPrompt = typeof env.LIARS_LLM_SYSTEM_PROMPT === 'string' ? env.LIARS_LLM_SYSTEM_PROMPT : '';
  const envTokenField = typeof env.LIARS_LLM_TOKEN_LIMIT_FIELD === 'string' ? env.LIARS_LLM_TOKEN_LIMIT_FIELD : 'auto';
  const envTokenLimit = env.LIARS_LLM_MAX_OUTPUT_TOKENS;
  const result = {
    baseUrl: normalizedBaseUrl(source.baseUrl ?? envBase),
    model: normalizedModel(source.model ?? envModel),
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : envKey,
    protocol: normalizedProtocol(source.protocol ?? envProtocol),
    tokenLimitField: normalizedTokenLimitField(source.tokenLimitField ?? envTokenField),
    maxOutputTokens: normalizedMaxOutputTokens(source.maxOutputTokens ?? envTokenLimit ?? 4096),
    persona: typeof source.persona === 'string' ? source.persona.slice(0, 4000) : '',
    systemPrompt: typeof source.systemPrompt === 'string'
      ? source.systemPrompt.slice(0, 8000)
      : (envPrompt || DEFAULT_SYSTEM_PROMPT),
    error: null,
    thinking: false,
  };
  if (result.protocol === 'codex') {
    if (!allowCodex) throw new Error('Codex is only enabled in the local Codex game server');
    result.baseUrl = '';
    result.apiKey = '';
    const preset = modelPreset(result.model || 'gpt-5.6-luna');
    if (!preset) throw new Error('请选择 Astra、Sol、Terra 或 Luna');
    result.model = preset.model;
    result.effort = preset.effort;
    result.codexEnabled = true;
  }
  if (result.apiKey.length > 1000) throw new Error('apiKey invalid');
  return result;
}

export function isAIConfigured(ai) {
  if (ai?.protocol === 'codex') return ai.codexEnabled === true && Boolean(modelPreset(ai.model));
  return Boolean(ai && ai.baseUrl && ai.model && ai.apiKey);
}

export function createDeck(round = 0, rng = Math.random) {
  const deck = DECK.map((card, index) => ({ id: `r${round}-${index}-${card.id}`, rank: card.rank }));
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1, rng);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export class LiarRoom {
  constructor(options = {}) {
    this.allowCodex = options.allowCodex === true;
    this.soloMode = options.soloMode === true;
    // A local single-player game is deliberately paused whenever its only
    // browser session is gone.  This is a scheduling flag, not a gameplay
    // phase, and therefore never leaks into the rules or hidden state.
    this.soloPaused = false;
    this.aiDefaults = options.aiDefaults || {};
    this.code = options.code || randomRoomCode(options.rng);
    this.rng = options.rng || Math.random;
    this.now = options.now || (() => Date.now());
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.autoTimers = options.autoTimers !== false;
    this.durations = {
      turnMs: 30_000,
      revealMs: 2_300,
      rouletteVisibleMs: 3_000,
      triggerMs: 12_000,
      aiDelayMinMs: 1_300,
      aiDelayMaxMs: 2_400,
      ...(options.durations || {}),
    };
    this.aiProvider = options.aiProvider || null;
    this.onState = options.onState || null;
    this.onNeedAI = options.onNeedAI || null;
    this.timers = new Set();
    this.revision = 0;
    this.eventSeq = 0;
    this.createdAt = this.now();
    this.matchId = crypto.randomUUID();
    this.modelNames = options.modelNames || {};
    this.lastActivityAt = this.createdAt;
    this.hostSeat = 0;
    this.hostToken = options.hostToken || randomToken();
    this.hostSession = null;
    this.phase = 'lobby';
    this.round = 0;
    this.roundStarter = null;
    this.targetRank = null;
    this.turnSeat = null;
    this.lastPlay = null;
    this.currentPlay = null;
    this.mustChallenge = false;
    this.pileCount = 0;
    this.loserSeat = null;
    this.reveal = null;
    this.lastShot = null;
    this.winnerSeat = null;
    this.deadline = null;
    this.turnDeadline = null;
    this.rouletteDeadline = null;
    this.aiRequest = null;
    this.aiRequestSeq = 0;
    this.aiSchedule = null;
    this.totalAICalls = 0;
    this.events = [];
    this.players = Array.from({ length: SEAT_COUNT }, (_, seatIndex) => this._newSeat(seatIndex));
    if (options.host) this._assignHuman(0, options.host, this.hostToken);
    for (let seat = 1; seat < SEAT_COUNT; seat += 1) {
      this._assignAI(seat, options.aiDefaults || {});
      this.players[seat].name = (this.players[seat].ai.protocol === 'codex' ? this.modelNames[modelPreset(this.players[seat].ai.model)?.id]?.name : null) || `AI ${seat}`;
    }
    if (options.host) this.addEvent(
      this.soloMode ? `${this.players[0].name} 坐到桌边，准备开始单机牌局` : `${this.players[0].name} 创建了房间`,
      'system',
    );
    if (options.snapshot) this.restoreSnapshot(options.snapshot);
  }

  _newSeat(seatIndex) {
    return {
      seatIndex,
      kind: 'open',
      name: '',
      gender: 'male',
      skin: 0,
      connected: false,
      socketId: null,
      token: null,
      alive: false,
      hand: [],
      shots: 0,
      chamber: null,
      ai: createAIConfig(this.aiDefaults, process.env, this.allowCodex),
      aiCalls: 0,
      speech: null,
    };
  }

  _assignHuman(seatIndex, profile = {}, token = null) {
    const seat = this.players[seatIndex];
    seat.kind = 'human';
    seat.name = profile.name?.trim() || `玩家${seatIndex + 1}`;
    seat.gender = validGender(profile.gender) ? profile.gender : 'male';
    seat.skin = validSkin(profile.skin) ? profile.skin : 0;
    seat.token = token || seat.token || randomToken();
    seat.connected = profile.connected !== false;
    seat.alive = this.phase !== 'lobby';
    return seat;
  }

  _assignAI(seatIndex, config = {}) {
    const seat = this.players[seatIndex];
    seat.kind = 'ai';
    seat.name = seat.name || `AI ${seatIndex}`;
    seat.gender = validGender(config.gender) ? config.gender : seat.gender;
    seat.skin = validSkin(config.skin) ? config.skin : seat.skin;
    seat.token = null;
    seat.connected = true;
    seat.ai = createAIConfig(config, process.env, this.allowCodex);
    const ownName = this.modelNames[modelPreset(seat.ai.model)?.id]?.name;
    if (seat.ai.protocol === 'codex' && ownName) seat.name = ownName;
    seat.alive = this.phase !== 'lobby';
    return seat;
  }

  _touch() {
    this.lastActivityAt = this.now();
    this.revision += 1;
    if (typeof this.onState === 'function') {
      try { this.onState(this); } catch { /* state observers cannot break the game */ }
    }
  }

  addEvent(text, type = 'system', details = {}) {
    this.events.push({ ...details, id: ++this.eventSeq, text: String(text).slice(0, 300), type: String(type), createdAt: this.now() });
    if (this.events.length > 12) this.events.splice(0, this.events.length - 12);
    this._touch();
  }

  _schedule(callback, delay) {
    if (!this.autoTimers) return null;
    const timer = this.setTimer(() => {
      this.timers.delete(timer);
      if (this.aiSchedule?.timer === timer) this.aiSchedule = null;
      try { callback(); } catch (error) {
        this.addEvent(`服务器计时器错误：${error.message}`, 'error');
      }
    }, Math.max(0, delay));
    this.timers.add(timer);
    return timer;
  }

  clearTimers() {
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
    this.aiSchedule = null;
    this.aiRequest = null;
  }

  _turnDeadline(seatIndex) {
    const seat = Number.isInteger(seatIndex) ? this.players[seatIndex] : null;
    // The local player must be able to read and select cards without a
    // server-side timeout.  AI requests have their own provider timeout and
    // clear this deadline in _requestAIIfNeeded/requestAIDecision.
    if (this.soloMode && seat?.kind === 'human') return null;
    return seat ? this.now() + this.durations.turnMs : null;
  }

  pauseSolo() {
    if (!this.soloMode) return this.publicStateFor(null);
    this.soloPaused = true;
    this.clearTimers();
    this._invalidateAIRequest();
    for (const seat of this.players) {
      if (seat.kind === 'ai') seat.ai.thinking = false;
    }
    this.deadline = null;
    this.turnDeadline = null;
    this.rouletteDeadline = null;
    this._touch();
    return this.publicStateFor(null);
  }

  resumeSolo() {
    if (!this.soloMode) return this.publicStateFor(null);
    this.soloPaused = false;
    this._touch();
    if (this.phase === 'reveal') {
      this._schedule(() => this.enterRoulette(), this.durations.revealMs);
    } else if (this.phase === 'roulette') {
      if (this.lastShot) this._schedule(() => this.afterShot(), this.durations.rouletteVisibleMs);
      else if (this.players[this.loserSeat]?.kind === 'ai') this._requestAITrigger();
      else {
        this.deadline = this.now() + this.durations.triggerMs;
        this.rouletteDeadline = null;
        this._touch();
      }
    } else if (this.phase === 'playing') {
      this._requestAIIfNeeded();
    }
    return this.publicStateFor(null);
  }

  _invalidateAIRequest() {
    this.aiRequestSeq += 1;
    if (this.aiRequest) {
      const seat = this.players[this.aiRequest.seatIndex];
      if (seat?.kind === 'ai') seat.ai.thinking = false;
    }
    this.aiRequest = null;
  }

  destroy() {
    this.clearTimers();
  }

  snapshot() {
    return {
      version: 1,
      matchId: this.matchId,
      phase: this.phase,
      round: this.round,
      roundStarter: this.roundStarter,
      targetRank: this.targetRank,
      turnSeat: this.turnSeat,
      lastPlay: clone(this.lastPlay),
      currentPlay: clone(this.currentPlay),
      mustChallenge: this.mustChallenge,
      pileCount: this.pileCount,
      loserSeat: this.loserSeat,
      reveal: clone(this.reveal),
      lastShot: clone(this.lastShot),
      winnerSeat: this.winnerSeat,
      events: clone(this.events),
      eventSeq: this.eventSeq,
      revision: this.revision,
      totalAICalls: this.totalAICalls,
      createdAt: this.createdAt,
      players: this.players.map((seat) => ({
        seatIndex: seat.seatIndex,
        kind: seat.kind,
        name: seat.name,
        gender: seat.gender,
        skin: seat.skin,
        alive: seat.alive,
        hand: clone(seat.hand),
        shots: seat.shots,
        chamber: seat.chamber,
        // The local Codex mode has no API key, but force this redaction here
        // so the snapshot stays safe if a caller supplies another config.
        ai: { ...clone(seat.ai), apiKey: '' },
        aiCalls: seat.aiCalls,
      })),
    };
  }

  restoreSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.players) || snapshot.players.length !== SEAT_COUNT) {
      throw new Error('solo snapshot invalid');
    }
    if (!PHASES.includes(snapshot.phase)) throw new Error('solo snapshot phase invalid');
    this.clearTimers();
    this._invalidateAIRequest();
    this.matchId = typeof snapshot.matchId === 'string' ? snapshot.matchId : `legacy-${snapshot.createdAt || this.createdAt}`;
    this.phase = snapshot.phase;
    this.round = Number.isInteger(snapshot.round) && snapshot.round >= 0 ? snapshot.round : 0;
    this.roundStarter = Number.isInteger(snapshot.roundStarter) ? snapshot.roundStarter : null;
    this.targetRank = TARGET_RANKS.includes(snapshot.targetRank) ? snapshot.targetRank : null;
    this.turnSeat = Number.isInteger(snapshot.turnSeat) ? snapshot.turnSeat : null;
    this.lastPlay = clone(snapshot.lastPlay);
    this.currentPlay = clone(snapshot.currentPlay);
    this.mustChallenge = Boolean(snapshot.mustChallenge);
    this.pileCount = Number.isInteger(snapshot.pileCount) && snapshot.pileCount >= 0 ? snapshot.pileCount : 0;
    this.loserSeat = Number.isInteger(snapshot.loserSeat) ? snapshot.loserSeat : null;
    this.reveal = clone(snapshot.reveal);
    this.lastShot = clone(snapshot.lastShot);
    this.winnerSeat = Number.isInteger(snapshot.winnerSeat) ? snapshot.winnerSeat : null;
    this.events = Array.isArray(snapshot.events) ? clone(snapshot.events).slice(-12) : [];
    this.eventSeq = Number.isInteger(snapshot.eventSeq) ? snapshot.eventSeq : this.events.reduce((max, event) => Math.max(max, event.id || 0), 0);
    this.revision = Number.isInteger(snapshot.revision) ? snapshot.revision : 0;
    this.totalAICalls = Number.isInteger(snapshot.totalAICalls) ? snapshot.totalAICalls : 0;
    this.createdAt = Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : this.now();
    this.lastActivityAt = this.now();
    this.hostSession = null;
    this.aiRequest = null;
    this.aiSchedule = null;
    this.deadline = null;
    this.turnDeadline = null;
    this.rouletteDeadline = null;
    this.players = snapshot.players.map((saved, seatIndex) => {
      const seat = this._newSeat(seatIndex);
      const savedKind = ['human', 'ai', 'open'].includes(saved?.kind) ? saved.kind : 'open';
      seat.kind = seatIndex === this.hostSeat ? 'human' : savedKind;
      seat.name = validName(saved?.name) ? saved.name.trim() : (seat.kind === 'ai' ? `AI ${seatIndex}` : `玩家${seatIndex + 1}`);
      seat.gender = validGender(saved?.gender) ? saved.gender : 'male';
      seat.skin = validSkin(saved?.skin) ? saved.skin : 0;
      seat.connected = false;
      seat.socketId = null;
      seat.token = seat.kind === 'human' ? this.hostToken : null;
      seat.alive = Boolean(saved?.alive) && seat.kind !== 'open';
      seat.hand = Array.isArray(saved?.hand)
        ? saved.hand.filter((card) => card && typeof card.id === 'string' && RANKS.includes(card.rank)).map((card) => ({ id: card.id, rank: card.rank }))
        : [];
      seat.shots = Number.isInteger(saved?.shots) ? Math.max(0, Math.min(6, saved.shots)) : 0;
      seat.chamber = Number.isInteger(saved?.chamber) && saved.chamber >= 1 && saved.chamber <= 6
        ? saved.chamber
        : (seat.kind === 'human' || seat.kind === 'ai' ? randomInt(6, this.rng) + 1 : null);
      const savedAI = saved?.ai && typeof saved.ai === 'object' ? saved.ai : {};
      // Never restore a persisted API credential.  The local Codex contract
      // remains configured through the process account, not a room secret.
      seat.ai = createAIConfig({ ...savedAI, apiKey: '' }, {}, this.allowCodex);
      seat.ai.error = typeof savedAI.error === 'string' ? savedAI.error.slice(0, 300) : null;
      seat.ai.thinking = false;
      const ownName = this.modelNames[modelPreset(seat.ai.model)?.id]?.name;
      if (seat.kind === 'ai' && seat.ai.protocol === 'codex' && ownName) seat.name = ownName;
      seat.aiCalls = Number.isInteger(saved?.aiCalls) ? saved.aiCalls : 0;
      return seat;
    });
    // No browser is attached after a process restart.  Keep the restored
    // position paused until soloResume binds seat 0 again.
    this.soloPaused = ['playing', 'reveal', 'roulette'].includes(this.phase);
    return this;
  }

  _aliveSeats() {
    return this.players.filter((p) => p.alive && p.kind !== 'open');
  }

  _handSeats() {
    return this._aliveSeats().filter((p) => p.hand.length > 0);
  }

  _nextSeat(afterSeat, predicate = () => true) {
    for (let offset = 1; offset <= SEAT_COUNT; offset += 1) {
      const seat = this.players[(afterSeat + offset + SEAT_COUNT) % SEAT_COUNT];
      if (predicate(seat)) return seat.seatIndex;
    }
    return null;
  }

  _activeParticipants() {
    return this.players.filter((p) => p.kind !== 'open');
  }

  _allAIConfigured() {
    return this._activeParticipants().every((p) => p.kind !== 'ai' || isAIConfigured(p.ai));
  }

  _recordAICalls(seat, calls) {
    if (calls === 0) return;
    const count = Number.isInteger(calls) && calls > 0 ? calls : 1;
    seat.aiCalls += count;
    this.totalAICalls += count;
  }

  _assertSeat(seatIndex) {
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= SEAT_COUNT) {
      throw new Error('seatIndex invalid');
    }
    return this.players[seatIndex];
  }

  profile(seatIndex, payload = {}) {
    const seat = this._assertSeat(seatIndex);
    if (seat.kind !== 'human') throw new Error('only human seat can update profile');
    if (!validName(payload.name)) throw new Error('name invalid');
    if (!validGender(payload.gender)) throw new Error('gender invalid');
    if (!validSkin(payload.skin)) throw new Error('skin invalid');
    seat.name = payload.name.trim();
    seat.gender = payload.gender;
    seat.skin = payload.skin;
    this.addEvent(`${seat.name} 更新了资料`, 'profile');
    return this.publicStateFor(seatIndex);
  }

  configureAI(actor, payload = {}) {
    if (!actor?.isHost) throw new Error('host required');
    const seat = this._assertSeat(payload.seatIndex);
    if (seat.kind !== 'ai') throw new Error('seat is not ai');
    // Configuration updates are PATCH-like: a settings panel may omit a
    // field it does not render, and omission must not erase the saved
    // endpoint, persona, prompt, or token budget.
    const source = {
      baseUrl: seat.ai.baseUrl,
      model: seat.ai.model,
      protocol: seat.ai.protocol,
      tokenLimitField: seat.ai.tokenLimitField,
      maxOutputTokens: seat.ai.maxOutputTokens,
      persona: seat.ai.persona,
      systemPrompt: seat.ai.systemPrompt,
      apiKey: seat.ai.apiKey,
    };
    if (Object.prototype.hasOwnProperty.call(payload, 'baseUrl')) source.baseUrl = payload.baseUrl;
    if (Object.prototype.hasOwnProperty.call(payload, 'model')) source.model = payload.model;
    if (Object.prototype.hasOwnProperty.call(payload, 'protocol')) source.protocol = payload.protocol;
    if (Object.prototype.hasOwnProperty.call(payload, 'tokenLimitField')) source.tokenLimitField = payload.tokenLimitField;
    if (Object.prototype.hasOwnProperty.call(payload, 'maxOutputTokens')) source.maxOutputTokens = payload.maxOutputTokens;
    if (Object.prototype.hasOwnProperty.call(payload, 'persona')) source.persona = payload.persona;
    if (Object.prototype.hasOwnProperty.call(payload, 'systemPrompt')) source.systemPrompt = payload.systemPrompt;
    // An empty/omitted apiKey means "keep the existing key". Clearing a key
    // is an explicit host action so a browser form cannot erase it by accident.
    source.apiKey = payload.clearKey === true
      ? ''
      : (typeof payload.apiKey === 'string' && payload.apiKey.length > 0 ? payload.apiKey : seat.ai.apiKey);
    const changedModel = source.protocol !== seat.ai.protocol || source.model !== seat.ai.model;
    const configuredAI = createAIConfig(source, {}, this.allowCodex);
    if (this.aiRequest?.seatIndex === seat.seatIndex) this._invalidateAIRequest();
    seat.ai = configuredAI;
    if (changedModel) seat.speech = null;
    if (seat.ai.protocol === 'codex') seat.name = this.modelNames[modelPreset(seat.ai.model)?.id]?.name || modelPreset(seat.ai.model).label;
    seat.ai.error = null;
    seat.ai.thinking = false;
    this.addEvent(`AI ${seat.seatIndex + 1} 配置已更新`, 'ai_config');
    if (this.phase === 'playing' && this.turnSeat === seat.seatIndex) this._requestAIIfNeeded();
    return this.publicStateFor(actor.seatIndex);
  }

  retryAI(actor, payload = {}) {
    if (!actor?.isHost) throw new Error('host required');
    const seat = this._assertSeat(payload.seatIndex ?? this.turnSeat);
    if (seat.kind !== 'ai') throw new Error('seat is not ai');
    seat.ai.error = null;
    seat.ai.thinking = false;
    this.addEvent(`AI ${seat.seatIndex + 1} 准备重试`, 'ai_retry');
    if (this.phase === 'playing' && this.turnSeat === seat.seatIndex) this._requestAIIfNeeded();
    if (this.phase === 'roulette' && this.loserSeat === seat.seatIndex) this._requestAITrigger();
    return this.publicStateFor(actor.seatIndex);
  }

  setSeat(actor, payload = {}) {
    if (!actor?.isHost) throw new Error('host required');
    if (this.phase !== 'lobby') throw new Error('seat changes are lobby only');
    const seatIndex = payload.seatIndex;
    const seat = this._assertSeat(seatIndex);
    const kind = payload.kind === 'bot' ? 'ai' : payload.kind;
    if (!['ai', 'open', 'human'].includes(kind)) throw new Error('kind invalid');
    if (seatIndex === this.hostSeat && kind === 'open') {
      // The host keeps a room session and may become a spectator; a host seat is
      // represented as AI or human, never an unowned open slot.
      throw new Error('host seat cannot be open');
    }
    if (seat.kind === 'human' && seat.connected && seatIndex !== actor.seatIndex && seatIndex !== this.hostSeat) {
      throw new Error('connected human seat cannot be replaced');
    }
    if (kind === 'open') {
      Object.assign(seat, this._newSeat(seatIndex));
      this.addEvent(`座位 ${seatIndex + 1} 已开放`, 'seat');
    } else if (kind === 'ai') {
      const prior = { ...seat.ai };
      this._assignAI(seatIndex, prior);
      seat.name = payload.name?.trim() || `AI ${seatIndex}`;
      this.addEvent(`座位 ${seatIndex + 1} 已设为 AI`, 'seat');
    } else {
      if (seatIndex !== actor.seatIndex && seat.kind !== 'human' && !(actor.isHost && seatIndex === this.hostSeat)) throw new Error('only session owner can restore human seat');
      const token = actor.isHost && seatIndex === this.hostSeat ? this.hostToken : (seat.token || randomToken());
      this._assignHuman(seatIndex, actor.profile || { name: seat.name || `玩家${seatIndex + 1}`, gender: seat.gender, skin: seat.skin }, token);
      this.addEvent(`座位 ${seatIndex + 1} 已设为真人`, 'seat');
    }
    return this.publicStateFor(actor.seatIndex ?? null);
  }

  join(profile = {}) {
    if (this.phase !== 'lobby') throw new Error('game already started');
    if (!validName(profile.name)) throw new Error('name invalid');
    if (!validGender(profile.gender)) throw new Error('gender invalid');
    if (!validSkin(profile.skin)) throw new Error('skin invalid');
    if (profile.token && profile.token === this.hostToken) {
      this.hostSession = { connected: true };
      return { seatIndex: this.players[this.hostSeat].kind === 'human' ? this.hostSeat : null, token: this.hostToken, host: true };
    }
    const existing = this.players.find((p) => p.kind === 'human' && p.token === profile.token && profile.token);
    if (existing) {
      existing.name = profile.name.trim();
      existing.gender = profile.gender;
      existing.skin = profile.skin;
      existing.connected = true;
      return { seatIndex: existing.seatIndex, token: existing.token, host: existing.seatIndex === this.hostSeat };
    }
    const seat = this.players.find((p) => p.kind === 'open');
    if (!seat) throw new Error('no open seat');
    this._assignHuman(seat.seatIndex, profile);
    this.addEvent(`${seat.name} 加入了座位 ${seat.seatIndex + 1}`, 'join');
    return { seatIndex: seat.seatIndex, token: seat.token, host: false };
  }

  resume(token) {
    if (typeof token !== 'string' || token.length < 8) throw new Error('token invalid');
    if (token === this.hostToken) {
      this.hostSession = { connected: true };
      return { seatIndex: this.players[this.hostSeat].kind === 'human' ? this.hostSeat : null, token, host: true };
    }
    const seat = this.players.find((p) => p.token === token && p.kind === 'human');
    if (!seat) throw new Error('resume token invalid');
    seat.connected = true;
    seat.socketId = null;
    return { seatIndex: seat.seatIndex, token, host: seat.seatIndex === this.hostSeat };
  }

  bindConnection(identity, socketId) {
    if (!identity) throw new Error('identity required');
    if (identity.host || (identity.isHost && !Number.isInteger(identity.seatIndex))) {
      this.hostSession = { connected: true, socketId };
      // A host connection can still own seat 0.  Keeping the socket on the
      // seat as well as on hostSession is required for the local solo server
      // to pause on disconnect and restore the same human seat on refresh.
      if (Number.isInteger(identity.seatIndex)) {
        const seat = this.players[identity.seatIndex];
        if (seat?.kind === 'human' && seat.token === identity.token) {
          seat.connected = true;
          seat.socketId = socketId;
        }
      }
      return;
    }
    const seat = this._assertSeat(identity.seatIndex);
    if (seat.token !== identity.token) throw new Error('seat token mismatch');
    seat.connected = true;
    seat.socketId = socketId;
    if (identity.isHost) this.hostSession = { connected: true, socketId };
  }

  unbindConnection(identity, socketId) {
    if (!identity) return;
    if (identity.host || (identity.isHost && !Number.isInteger(identity.seatIndex))) {
      if (Number.isInteger(identity.seatIndex)) {
        const seat = this.players[identity.seatIndex];
        if (seat?.socketId === socketId) {
          seat.connected = false;
          seat.socketId = null;
        }
      }
      if (!this.hostSession || this.hostSession.socketId === socketId) this.hostSession = { connected: false, socketId: null };
      return;
    }
    const seat = this.players[identity.seatIndex];
    if (seat?.socketId === socketId) {
      seat.connected = false;
      seat.socketId = null;
    }
    if (identity.isHost && (!this.hostSession || this.hostSession.socketId === socketId)) this.hostSession = { connected: false, socketId: null };
  }

  start(actor, { starterSeat = null } = {}) {
    if (!actor?.isHost) throw new Error('host required');
    if (this.phase !== 'lobby') throw new Error('game already started');
    const active = this._activeParticipants();
    if (active.length !== SEAT_COUNT) throw new Error('four occupied seats required');
    if (!this._allAIConfigured()) throw new Error('all ai seats need configuration');
    this.totalAICalls = 0;
    this.matchId = crypto.randomUUID();
    for (const seat of this.players) {
      if (seat.kind === 'open') continue;
      seat.alive = true;
      seat.shots = 0;
      seat.chamber = randomInt(6, this.rng) + 1;
      seat.hand = [];
      seat.ai.error = null;
      seat.ai.thinking = false;
      seat.aiCalls = 0;
    }
    this.winnerSeat = null;
    for (const seat of this.players) seat.speech = null;
    this.soloPaused = false;
    this.phase = 'playing';
    this.beginRound({ initial: true, starterSeat });
    this.addEvent('游戏开始', 'start');
    return this.publicStateFor(actor.seatIndex ?? null);
  }

  beginRound({ initial = false, starterSeat = null } = {}) {
    if (!initial) {
      this.phase = 'playing';
      this.reveal = null;
      this.loserSeat = null;
      this.lastShot = null;
      this.lastPlay = null;
      this.currentPlay = null;
      this.mustChallenge = false;
      this.pileCount = 0;
    }
    this._invalidateAIRequest();
    this.round += 1;
    this.targetRank = TARGET_RANKS[randomInt(TARGET_RANKS.length, this.rng)];
    const deck = createDeck(this.round, this.rng);
    const alive = this._aliveSeats();
    for (const seat of this.players) seat.hand = [];
    for (let i = 0; i < alive.length * 5; i += 1) alive[i % alive.length].hand.push(deck[i]);
    const requested = Number.isInteger(starterSeat) ? this.players[starterSeat] : null;
    this.roundStarter = requested && requested.alive && requested.kind !== 'open'
      ? requested.seatIndex
      : (alive.length ? alive[randomInt(alive.length, this.rng)].seatIndex : null);
    this.turnSeat = this.roundStarter;
    this.deadline = this._turnDeadline(this.turnSeat);
    this.turnDeadline = this.deadline;
    this.rouletteDeadline = null;
    this._touch();
    this._requestAIIfNeeded();
  }

  _validateActionSeat(seatIndex) {
    const seat = this._assertSeat(seatIndex);
    if (this.soloMode && this.soloPaused) throw new Error('solo game paused');
    if (this.phase !== 'playing') throw new Error('not playing');
    if (this.turnSeat !== seatIndex) throw new Error('not your turn');
    if (!seat.alive || seat.kind === 'open') throw new Error('seat inactive');
    return seat;
  }

  play(seatIndex, cardIds) {
    const seat = this._validateActionSeat(seatIndex);
    if (this.mustChallenge) throw new Error('must challenge');
    if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > 3) throw new Error('play 1 to 3 cards');
    const ids = cardIds.map((id) => String(id));
    if (new Set(ids).size !== ids.length) throw new Error('duplicate card ids');
    if (ids.some((id) => !seat.hand.some((card) => card.id === id))) throw new Error('card not in hand');
    const cards = ids.map((id) => seat.hand.find((card) => card.id === id));
    seat.hand = seat.hand.filter((card) => !ids.includes(card.id));
    this.currentPlay = { seatIndex, cardIds: ids, cards: clone(cards), targetRank: this.targetRank };
    this.lastPlay = { seatIndex, count: ids.length };
    this.pileCount += ids.length;
    this.addEvent(`${seat.name} 打出了 ${ids.length} 张牌并宣称是 ${this.targetRank}`, 'play');
    this._advanceAfterPlay(seatIndex);
    return this.publicStateFor(seatIndex);
  }

  _advanceAfterPlay(playedBy) {
    const hands = this._handSeats();
    let next = null;
    if (hands.length === 0) {
      next = this._nextSeat(playedBy, (p) => p.alive && p.kind !== 'open');
      this.mustChallenge = next != null && next !== playedBy;
    } else if (hands.length === 1) {
      next = hands[0].seatIndex;
      this.mustChallenge = next !== playedBy;
    } else {
      next = this._nextSeat(playedBy, (p) => p.alive && p.kind !== 'open' && p.hand.length > 0);
      this.mustChallenge = false;
    }
    if (next == null) {
      this.phase = 'ended';
      this.winnerSeat = playedBy;
      this.turnSeat = null;
      this.deadline = null;
      this.addEvent(`${this.players[playedBy].name} 获胜`, 'winner');
      return;
    }
    this.turnSeat = next;
    this.deadline = this._turnDeadline(this.turnSeat);
    this.turnDeadline = this.deadline;
    this._touch();
    this._requestAIIfNeeded();
  }

  challenge(seatIndex) {
    this._validateActionSeat(seatIndex);
    if (!this.lastPlay || !this.currentPlay) throw new Error('nothing to challenge');
    const playedBy = this.currentPlay.seatIndex;
    const cards = this.currentPlay.cards;
    const lie = cards.some((card) => card.rank !== this.targetRank && card.rank !== 'JOKER');
    const loserSeat = lie ? playedBy : seatIndex;
    this.phase = 'reveal';
    this._invalidateAIRequest();
    this.reveal = {
      accuserSeat: seatIndex,
      playedBy,
      cards: cards.map((card) => card.rank),
      lie,
      loserSeat,
    };
    this.loserSeat = loserSeat;
    this.deadline = this.now() + this.durations.revealMs;
    this.turnDeadline = null;
    this.addEvent(`${this.players[seatIndex].name} 质疑了 ${this.players[playedBy].name}：${lie ? '诈唬' : '真实'}`, 'challenge');
    this._schedule(() => this.enterRoulette(), this.durations.revealMs);
    return this.publicStateFor(seatIndex);
  }

  enterRoulette() {
    if (this.phase !== 'reveal') return this.publicStateFor(null);
    this.phase = 'roulette';
    this.deadline = this.now() + this.durations.triggerMs;
    this.rouletteDeadline = null;
    this.addEvent(`${this.players[this.loserSeat]?.name || '玩家'} 进入俄罗斯轮盘`, 'roulette');
    this._touch();
    if (this.players[this.loserSeat]?.kind === 'ai') {
      const delay = this.durations.aiDelayMinMs + randomInt(
        Math.max(1, this.durations.aiDelayMaxMs - this.durations.aiDelayMinMs + 1), this.rng,
      );
      const seatIndex = this.loserSeat;
      const round = this.round;
      const timer = this._schedule(() => {
        if (this.phase === 'roulette' && this.loserSeat === seatIndex && this.round === round && !this.lastShot) this._requestAITrigger();
      }, delay);
      if (timer) this.aiSchedule = { timer, phase: 'roulette', seatIndex, round };
    }
    return this.publicStateFor(null);
  }

  pullTrigger(seatIndex) {
    if (this.phase !== 'roulette') throw new Error('not roulette phase');
    if (this.soloMode && this.soloPaused) throw new Error('solo game paused');
    if (seatIndex !== this.loserSeat) throw new Error('only loser can pull trigger');
    const seat = this._assertSeat(seatIndex);
    if (!seat.alive || seat.kind === 'open') throw new Error('seat inactive');
    if (this.lastShot) throw new Error('trigger already pulled');
    this._invalidateAIRequest();
    const shot = seat.shots + 1;
    const fatal = shot === seat.chamber;
    if (!fatal) seat.shots += 1;
    if (fatal) {
      seat.alive = false;
      seat.hand = [];
    }
    this.lastShot = { id: randomToken(8), seatIndex, fatal, shot };
    this.rouletteDeadline = this.now() + this.durations.rouletteVisibleMs;
    this.deadline = this.rouletteDeadline;
    this.addEvent(fatal ? `${seat.name} 中弹，已淘汰` : `${seat.name} 空枪`, fatal ? 'fatal' : 'empty');
    this._schedule(() => this.afterShot(), this.durations.rouletteVisibleMs);
    return this.publicStateFor(seatIndex);
  }

  afterShot() {
    if (this.phase !== 'roulette' || !this.lastShot) return this.publicStateFor(null);
    if (this._aliveSeats().length <= 1) {
      this.phase = 'ended';
      this.winnerSeat = this._aliveSeats()[0]?.seatIndex ?? null;
      this.turnSeat = null;
      this.deadline = null;
      this.addEvent(this.winnerSeat == null ? '游戏结束' : `${this.players[this.winnerSeat].name} 获胜`, 'winner');
      return this.publicStateFor(null);
    }
    const starterSeat = this.lastShot.fatal
      ? this._nextSeat(this.lastShot.seatIndex, (p) => p.alive && p.kind !== 'open')
      : this.lastShot.seatIndex;
    this.beginRound({ starterSeat });
    return this.publicStateFor(null);
  }

  timeoutTurn(seatIndex) {
    if (this.soloMode && this.soloPaused) throw new Error('solo game paused');
    if (this.phase !== 'playing' || this.turnSeat !== seatIndex) throw new Error('turn is not timed out');
    const seat = this._assertSeat(seatIndex);
    if (seat.kind === 'ai') {
      seat.ai.error = 'AI turn timed out; retry required';
      seat.ai.thinking = false;
      this.deadline = null;
      this.addEvent(`${seat.name} 的 AI 超时，等待房主重试`, 'ai_error');
      return this.publicStateFor(null);
    }
    this.addEvent(`${seat.name} 超时，执行自动${this.mustChallenge ? '质疑' : '出牌'}（真人超时）`, 'timeout');
    if (this.mustChallenge) return this.challenge(seatIndex);
    const card = seat.hand[0];
    if (!card) return this.challenge(seatIndex);
    return this.play(seatIndex, [card.id]);
  }

  restart(actor) {
    if (!actor?.isHost) throw new Error('host required');
    if (this.phase !== 'ended') throw new Error('restart only after ended');
    this.clearTimers();
    this.totalAICalls = 0;
    for (const seat of this.players) {
      seat.alive = false;
      seat.hand = [];
      seat.shots = 0;
      seat.chamber = null;
      seat.ai.error = null;
      seat.ai.thinking = false;
      seat.aiCalls = 0;
      if (seat.kind === 'human') seat.connected = Boolean(seat.socketId);
    }
    this.phase = 'lobby';
    this.round = 0;
    this.roundStarter = null;
    this.targetRank = null;
    this.turnSeat = null;
    this.lastPlay = null;
    this.currentPlay = null;
    this.mustChallenge = false;
    this.pileCount = 0;
    this.loserSeat = null;
    this.reveal = null;
    this.lastShot = null;
    this.winnerSeat = null;
    this.deadline = null;
    this.addEvent(this.soloMode ? '单机牌局已重置' : '房主重置了游戏', 'restart');
    return this.publicStateFor(actor.seatIndex ?? null);
  }

  leave(seatIndex) {
    const seat = this._assertSeat(seatIndex);
    if (seat.kind !== 'human') throw new Error('only human seat can leave');
    if (this.phase === 'lobby') {
      Object.assign(seat, this._newSeat(seatIndex));
      this.addEvent(`座位 ${seatIndex + 1} 已离开`, 'leave');
      return this.publicStateFor(null);
    }
    // During a match the seat remains a disconnected human placeholder. The
    // server's ordinary turn/roulette deadline handles it as a declared human
    // timeout; it is never silently converted into an AI player.
    seat.connected = false;
    seat.socketId = null;
    this.addEvent(
      this.soloMode ? `${seat.name} 离开牌桌，局面暂停` : `${seat.name} 离开了房间，保留断线席位`,
      'leave',
    );
    if (this.soloMode) this.pauseSolo();
    return this.publicStateFor(null);
  }

  _requestAIIfNeeded() {
    if (this.phase !== 'playing' || this.turnSeat == null || this.soloPaused) return;
    const seat = this.players[this.turnSeat];
    if (seat?.kind !== 'ai' || seat.ai.error || this.aiRequest) return;
    if (this.aiSchedule?.phase === 'playing' && this.aiSchedule.seatIndex === seat.seatIndex && this.aiSchedule.round === this.round) return;
    if (typeof this.onNeedAI !== 'function' && typeof this.aiProvider !== 'function') return;
    // AI turns are governed by the provider request timeout, not the 30s human
    // turn clock. This also prevents a short test clock from racing a valid
    // provider call or causing a duplicate retry.
    this.deadline = null;
    this.turnDeadline = null;
    this._touch();
    const seatIndex = seat.seatIndex;
    const round = this.round;
    const delay = this.durations.aiDelayMinMs + randomInt(
      Math.max(1, this.durations.aiDelayMaxMs - this.durations.aiDelayMinMs + 1),
      this.rng,
    );
    const timer = this._schedule(() => {
      if (this.phase !== 'playing' || this.turnSeat !== seatIndex || this.round !== round) return;
      if (typeof this.onNeedAI === 'function') this.onNeedAI({ room: this, seatIndex, phase: 'playing' });
      else this.requestAIDecision(seatIndex);
    }, delay);
    if (timer) this.aiSchedule = { timer, phase: 'playing', seatIndex, round };
  }

  _requestAITrigger() {
    if (this.soloPaused) return;
    const seat = this.players[this.loserSeat];
    if (!seat || seat.kind !== 'ai' || seat.ai.error) return;
    if (this.aiRequest) return;
    if (this.aiSchedule?.phase === 'roulette' && this.aiSchedule.seatIndex === seat.seatIndex && this.aiSchedule.round === this.round) return;
    this.deadline = null;
    this.rouletteDeadline = null;
    this._touch();
    if (typeof this.onNeedAI === 'function') {
      this.onNeedAI({ room: this, seatIndex: seat.seatIndex, phase: 'roulette' });
    } else if (typeof this.aiProvider === 'function') {
      this.requestAITrigger(seat.seatIndex);
    }
  }

  kickAI() {
    if (this.soloPaused) return this.publicStateFor(null);
    if (this.phase === 'playing') this._requestAIIfNeeded();
    else if (this.phase === 'roulette' && !this.lastShot) this._requestAITrigger();
  }

  async requestAIDecision(seatIndex = this.turnSeat, provider = this.aiProvider) {
    if (this.soloPaused || this.phase !== 'playing' || this.turnSeat !== seatIndex) return this.publicStateFor(null);
    const seat = this._assertSeat(seatIndex);
    if (seat.kind !== 'ai' || seat.ai.error) return this.publicStateFor(null);
    if (this.aiRequest) return this.publicStateFor(null);
    const requestId = ++this.aiRequestSeq;
    const requestRound = this.round;
    this.aiRequest = { requestId, seatIndex, phase: 'playing', round: requestRound, startedAt: this.now() };
    this.deadline = null;
    this.turnDeadline = null;
    seat.ai.thinking = true;
    this._touch();
    let callsRecorded = false;
    try {
      const decision = await (provider ? provider({ room: this, seatIndex, publicState: this.publicStateFor(null), selfHand: clone(seat.hand), ai: clone(seat.ai), phase: 'playing', requestId }) : Promise.reject(new Error('AI provider unavailable')));
      this._recordAICalls(seat, decision?.calls);
      callsRecorded = true;
      if (!this.aiRequest || this.aiRequest.requestId !== requestId || this.phase !== 'playing' || this.turnSeat !== seatIndex || this.round !== requestRound) return this.publicStateFor(null);
      if (!decision || (decision.action !== 'play' && decision.action !== 'challenge')) throw new Error('AI returned invalid action');
      if (decision.action === 'challenge') this.challenge(seatIndex);
      else this.play(seatIndex, decision.cardIds);
      this.say(seatIndex, decision.speech);
      seat.ai.error = null;
      return this.publicStateFor(null);
    } catch (error) {
      if (!callsRecorded) this._recordAICalls(seat, error?.calls);
      if (this.aiRequest?.requestId === requestId && this.phase === 'playing' && this.turnSeat === seatIndex && this.round === requestRound) {
        seat.ai.error = String(error?.message || error).slice(0, 300);
        this.deadline = null;
        this.addEvent(`${seat.name} 的 AI 出错，等待房主重试`, 'ai_error');
      }
      return this.publicStateFor(null);
    } finally {
      const ownsRequest = this.aiRequest?.requestId === requestId;
      if (ownsRequest) { seat.ai.thinking = false; this.aiRequest = null; }
      this._touch();
      // The action itself advances the turn while this request is still
      // marked in flight. Kick the next AI only after releasing that marker;
      // otherwise a normal multi-AI game stops after its first decision.
      if (ownsRequest && this.phase === 'playing') this._requestAIIfNeeded();
    }
  }

  async requestAITrigger(seatIndex = this.loserSeat, provider = this.aiProvider) {
    if (this.soloPaused || this.phase !== 'roulette' || seatIndex !== this.loserSeat || this.lastShot) return this.publicStateFor(null);
    const seat = this._assertSeat(seatIndex);
    if (seat.kind !== 'ai' || seat.ai.error) return this.publicStateFor(null);
    if (this.aiRequest) return this.publicStateFor(null);
    const requestId = ++this.aiRequestSeq;
    const requestRound = this.round;
    this.aiRequest = { requestId, seatIndex, phase: 'roulette', round: requestRound, startedAt: this.now() };
    this.deadline = null;
    this.rouletteDeadline = null;
    seat.ai.thinking = true;
    let callsRecorded = false;
    try {
      const decision = await (provider ? provider({ room: this, seatIndex, phase: 'roulette', publicState: this.publicStateFor(null), selfHand: [], ai: clone(seat.ai), requestId }) : Promise.reject(new Error('AI provider unavailable')));
      this._recordAICalls(seat, decision?.calls);
      callsRecorded = true;
      if (!this.aiRequest || this.aiRequest.requestId !== requestId || this.phase !== 'roulette' || this.loserSeat !== seatIndex || this.round !== requestRound) return this.publicStateFor(null);
      if (decision?.action !== 'pullTrigger') throw new Error('AI roulette decision invalid');
      const result = this.pullTrigger(seatIndex);
      this.say(seatIndex, decision.speech);
      return result;
    } catch (error) {
      if (!callsRecorded) this._recordAICalls(seat, error?.calls);
      if (this.aiRequest?.requestId === requestId && this.phase === 'roulette' && this.loserSeat === seatIndex && this.round === requestRound) {
        seat.ai.error = String(error?.message || error).slice(0, 300);
        this.deadline = null;
        this.addEvent(`${seat.name} 的 AI 轮盘出错，等待房主重试`, 'ai_error');
      }
      return this.publicStateFor(null);
    } finally {
      if (this.aiRequest?.requestId === requestId) { seat.ai.thinking = false; this.aiRequest = null; }
      this._touch();
    }
  }

  say(seatIndex, value, { chatDepth } = {}) {
    const seat = this._assertSeat(seatIndex);
    const text = seat.kind === 'human'
      ? Array.from(typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '').slice(0, 200).join('')
      : shortSpeech(value);
    if (!text) return;
    seat.speech = { text, createdAt: this.now(), id: this.eventSeq + 1 };
    this.addEvent(`${seat.name}：${text}`, 'speech', {
      seatIndex, message: text, speakerName: seat.name, speakerKind: seat.kind,
      round: this.round, matchId: this.matchId,
      ...(Number.isInteger(chatDepth) ? { chatDepth } : {}),
    });
  }

  publicAIFor(seatIndex, { includeBaseUrl = false } = {}) {
    const seat = this._assertSeat(seatIndex);
    return {
      model: seat.ai.model,
      effort: seat.ai.effort,
      ...(includeBaseUrl ? { baseUrl: seat.ai.baseUrl } : {}),
      protocol: seat.ai.protocol,
      tokenLimitField: seat.ai.tokenLimitField,
      maxOutputTokens: seat.ai.maxOutputTokens,
      configured: isAIConfigured(seat.ai),
      error: seat.ai.error,
      thinking: seat.ai.thinking,
      hasKey: Boolean(seat.ai.apiKey),
      calls: seat.aiCalls,
      personaSet: Boolean(seat.ai.persona || seat.ai.systemPrompt),
    };
  }

  publicStateFor(selfSeat = null) {
    const self = Number.isInteger(selfSeat) ? this.players[selfSeat] : null;
    const state = {
      code: this.code,
      matchId: this.matchId,
      codexAvailable: this.allowCodex,
      phase: this.phase,
      hostSeat: this.hostSeat,
      round: this.round,
      targetRank: this.targetRank,
      turnSeat: this.turnSeat,
      players: this.players.map((seat) => ({
        seatIndex: seat.seatIndex,
        name: seat.name,
        speech: clone(seat.speech),
        kind: seat.kind,
        gender: seat.gender,
        skin: seat.skin,
        connected: seat.kind === 'ai' ? true : Boolean(seat.connected),
        alive: Boolean(seat.alive),
        handCount: seat.hand.length,
        shots: seat.shots,
        nextRisk: seat.shots >= 6 ? 1 : 1 / (6 - seat.shots),
        ai: seat.kind === 'ai' ? this.publicAIFor(seat.seatIndex) : undefined,
      })),
      selfSeat: self && self.kind !== 'open' ? self.seatIndex : null,
      hand: self && self.kind !== 'open' ? clone(self.hand) : [],
      lastPlay: clone(this.lastPlay),
      mustChallenge: Boolean(this.mustChallenge),
      pileCount: this.pileCount,
      loserSeat: this.loserSeat,
      reveal: clone(this.reveal),
      lastShot: clone(this.lastShot),
      winnerSeat: this.winnerSeat,
      events: clone(this.events),
      deadline: this.deadline,
      revision: this.revision,
      totalAICalls: this.totalAICalls,
    };
    return state;
  }

  // AI input is deliberately narrower than publicStateFor: it contains no
  // hidden hand, chamber or per-seat token and gives the model only its own hand.
  aiView(seatIndex) {
    const seat = this._assertSeat(seatIndex);
    const state = this.publicStateFor(null);
    return {
      state: {
        code: state.code,
        phase: state.phase,
        round: state.round,
        targetRank: state.targetRank,
        turnSeat: state.turnSeat,
        players: state.players.map(({ seatIndex: index, name, kind, gender, skin, connected, alive, handCount, shots, nextRisk }) => ({
          seatIndex: index, name, kind, gender, skin, connected, alive, handCount, shots, nextRisk,
        })),
        lastPlay: state.lastPlay,
        mustChallenge: state.mustChallenge,
        pileCount: state.pileCount,
        loserSeat: state.loserSeat,
        reveal: state.reveal,
        lastShot: state.lastShot,
        winnerSeat: state.winnerSeat,
        events: state.events,
        deadline: state.deadline,
        legalActions: state.phase === 'roulette'
          ? ['pullTrigger']
          : (state.mustChallenge
            ? ['challenge']
            : (state.lastPlay ? ['play', 'challenge'] : ['play'])),
      },
      selfSeat: seatIndex,
      selfHand: clone(seat.hand),
    };
  }
}

export function randomRoomCode(rng = Math.random) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) code += alphabet[randomInt(alphabet.length, rng)];
  return code;
}

export function createRoom(options = {}) {
  return new LiarRoom(options);
}

export function calculateNextRisk(shots) {
  if (!Number.isInteger(shots) || shots < 0) return null;
  if (shots >= 6) return 1;
  return 1 / (6 - shots);
}

export default LiarRoom;
