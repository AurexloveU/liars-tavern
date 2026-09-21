import { PlayerRecords } from './player-records.js';
import { MODEL_PRESETS } from './public/model-presets.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { LiarRoom, randomRoomCode, isAIConfigured } from './game.js';
import { createAIProvider } from './ai.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT || 3279);
const SOCKET_LIMIT = 32 * 1024;
const ALLOWED_GENDERS = new Set(['male', 'female']);

function profileFrom(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('profile required');
  if (typeof payload.name !== 'string' || payload.name.trim().length < 1 || payload.name.trim().length > 40) throw new Error('name invalid');
  if (!ALLOWED_GENDERS.has(payload.gender)) throw new Error('gender invalid');
  if (!Number.isInteger(payload.skin) || payload.skin < 0 || payload.skin > 1) throw new Error('skin invalid');
  return { name: payload.name.trim(), gender: payload.gender, skin: payload.skin };
}

function normalizeCode(code) {
  if (typeof code !== 'string' || !/^[A-Z2-9]{6}$/i.test(code)) throw new Error('room code invalid');
  return code.toUpperCase();
}

function normalizeToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) throw new Error('token invalid');
  return token;
}

function safeErrorMessage(error) {
  const message = String(error?.message || error || 'action failed');
  // Provider bodies and key material never enter this path. Game errors are
  // already short, but cap unknown errors before they reach a browser.
  return message.replace(/[\r\n\t]/g, ' ')
    .replace(/(?:sk-|api[_-]?key[=: ]+|bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .slice(0, 240);
}

function randomSocketActionId() {
  return crypto.randomBytes(8).toString('hex');
}

function roomHostConfig(room) {
  return room.players.filter((seat) => seat.kind === 'ai').map((seat) => ({
    seatIndex: seat.seatIndex,
    baseUrl: seat.ai.baseUrl,
    model: seat.ai.model,
    effort: seat.ai.effort,
    protocol: seat.ai.protocol,
    tokenLimitField: seat.ai.tokenLimitField,
    maxOutputTokens: seat.ai.maxOutputTokens,
    persona: seat.ai.persona,
    systemPrompt: seat.ai.systemPrompt,
    personaSet: Boolean(seat.ai.persona),
    systemPromptSet: Boolean(seat.ai.systemPrompt),
    configured: isAIConfigured(seat.ai),
    hasKey: Boolean(seat.ai.apiKey),
    error: seat.ai.error,
    thinking: seat.ai.thinking,
  }));
}

export function createApplication(options = {}) {
  const app = express();
  const publicDir = options.publicDir || path.join(HERE, 'public');
  const threeDir = options.threeDir || path.join(HERE, 'node_modules', 'three', 'build');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'liars-tavern', rooms: options.rooms?.size || 0 }));
  app.get('/api/config', (_req, res) => res.json({
    ok: true,
    soloMode: options.soloMode === true,
    codexAvailable: options.allowCodex === true,
  }));
  app.use('/vendor/three', express.static(threeDir, { fallthrough: false, index: false }));
  app.use(express.static(publicDir, { extensions: ['html'] }));
  return app;
}

export function createGameServer(options = {}) {
  const rooms = options.rooms || new Map();
  const soloMode = options.soloMode === true;
  const soloRoomCode = typeof options.soloRoomCode === 'string' && options.soloRoomCode.length > 0
    ? options.soloRoomCode
    : '__local_solo__';
  const soloStatePath = soloMode && typeof options.soloStatePath === 'string' && options.soloStatePath.length > 0
    ? path.resolve(options.soloStatePath)
    : null;
  let soloRoom = options.soloRoom || null;
  const app = options.app || createApplication({ ...options, rooms, soloMode });
  const httpServer = options.httpServer || http.createServer(app);
  const io = options.io || new SocketIOServer(httpServer, {
    maxHttpBufferSize: SOCKET_LIMIT,
    serveClient: true,
    cors: options.cors || { origin: true, credentials: false },
    ...(options.allowRequest ? { allowRequest: options.allowRequest } : {}),
  });
  const roomTTL = Number(options.roomTTL || 6 * 60 * 60 * 1000);
  const maxRooms = Number(options.maxRooms || 256);
  const aiProvider = options.aiProvider || createAIProvider({
    fetchImpl: options.fetchImpl,
    timeoutMs: options.aiTimeoutMs || 25_000,
  });
  const sessions = new Map();
  const records = soloMode ? new PlayerRecords(options.recordsPath || (soloStatePath ? path.join(path.dirname(soloStatePath), 'player-records.json') : null), options.modelNames) : null;
  if (soloMode) {
    app.get('/api/player-records', (_req, res) => res.json(records.summary()));
    app.get('/api/model-players', (_req, res) => res.json({ players: MODEL_PRESETS.map((preset) => ({ ...preset, name: options.modelNames?.[preset.id]?.name || preset.label })) }));
  }
  const sweepEvery = Number(options.sweepEvery || 250);

  function stateFor(room, session) {
    const state = room.publicStateFor(Number.isInteger(session?.seatIndex) ? session.seatIndex : null);
    const isSoloRoom = soloMode && room === soloRoom;
    state.soloMode = isSoloRoom;
    state.paused = isSoloRoom ? Boolean(room.soloPaused) : false;
    if (isSoloRoom) { state.code = null; state.playerRecords = records.summary(); }
    state.isHost = isSoloRoom ? Boolean(session) : Boolean(session?.isHost);
    if (session?.isHost || isSoloRoom) state.hostConfigs = roomHostConfig(room);
    return state;
  }

  function emitState(room) {
    for (const [socketId, session] of sessions) {
      if (session.roomCode !== room.code) continue;
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      socket.emit('state', stateFor(room, session));
    }
  }

  function roomFor(code) {
    const room = rooms.get(normalizeCode(code));
    if (!room) throw new Error('room not found');
    return room;
  }

  function roomForSession(session) {
    if (!session) return null;
    if (soloMode && soloRoom?.code === session.roomCode) return soloRoom;
    return rooms.get(session.roomCode) || null;
  }

  function actorFor(session) {
    if (!session) throw new Error('join or resume required');
    return { isHost: Boolean(session.isHost), seatIndex: session.seatIndex, token: session.token, profile: session.profile };
  }

  function attachRoom(room) {
    room.onState = (target) => {
      if (soloMode) records.observe(target);
      persistSoloRoom(target);
      emitState(target);
    };
    room.onNeedAI = ({ room: target, seatIndex, phase }) => {
      if (target.soloPaused) return;
      const hasConnectedClient = [...sessions.values()].some((session) => session.roomCode === target.code);
      if (!hasConnectedClient) return;
      if (phase === 'roulette') {
        target.requestAITrigger(seatIndex, async (context) => aiProvider({
          ai: target.players[seatIndex].ai,
          room: target,
          seatIndex,
          publicState: target.publicStateFor(null),
          selfHand: [],
          phase: 'roulette',
          ...context,
        })).then(() => emitState(target)).catch(() => emitState(target));
      } else {
        target.requestAIDecision(seatIndex, async (context) => aiProvider({
          ai: target.players[seatIndex].ai,
          room: target,
          seatIndex,
          publicState: target.publicStateFor(null),
          selfHand: target.players[seatIndex].hand,
          phase: 'playing',
          ...context,
        })).then(() => emitState(target)).catch(() => emitState(target));
      }
    };
  }

  function createRoom(profile) {
    let code;
    do code = randomRoomCode(); while (rooms.has(code));
    const room = new LiarRoom({
      modelNames: options.modelNames,
      code,
      host: { ...profile, connected: true },
      autoTimers: options.autoTimers,
      durations: options.durations,
      now: options.now,
      allowCodex: options.allowCodex === true,
      aiDefaults: options.aiDefaults,
    });
    attachRoom(room);
    rooms.set(code, room);
    return room;
  }

  function createSoloRoom(profile, previousRoom = null) {
    if (!soloMode) throw new Error('solo mode unavailable');
    const room = new LiarRoom({
      modelNames: options.modelNames,
      code: soloRoomCode,
      host: { ...profile, connected: true },
      autoTimers: options.autoTimers,
      durations: options.durations,
      now: options.now,
      allowCodex: true,
      aiDefaults: options.aiDefaults || { protocol: 'codex', model: 'gpt-5.6-luna' },
      soloMode: true,
    });
    attachRoom(room);
    // A "new game" resets rules and hidden state but keeps the local AI
    // settings the host already entered.  Codex has no secret key; for the
    // normal-compatible path configureAI remains responsible for validation.
    if (!previousRoom && Array.isArray(options.aiRoster)) {
      for (let index = 0; index < 3; index++) {
        const model = options.aiRoster[index];
        if (model) room.configureAI({ isHost: true, seatIndex: 0 }, { seatIndex: index + 1, protocol: 'codex', model });
      }
    }
    if (previousRoom) {
      const hostActor = { isHost: true, seatIndex: 0, token: room.hostToken, profile };
      for (const prior of previousRoom.players.filter((seat) => seat.kind === 'ai')) {
        try {
          room.configureAI(hostActor, {
            seatIndex: prior.seatIndex,
            baseUrl: prior.ai.baseUrl,
            model: prior.ai.model,
            protocol: prior.ai.protocol,
            tokenLimitField: prior.ai.tokenLimitField,
            maxOutputTokens: prior.ai.maxOutputTokens,
            persona: prior.ai.persona,
            systemPrompt: prior.ai.systemPrompt,
            apiKey: prior.ai.apiKey,
          });
        } catch {
          // Local Codex defaults are always valid.  A stale incompatible
          // setting must never prevent starting a fresh local game.
        }
      }
    }
    soloRoom = room;
    records?.observe(room);
    persistSoloRoom(room);
    return room;
  }

  function resetSoloRoom() {
    if (!soloRoom) return;
    const old = soloRoom;
    for (const [socketId, session] of sessions) {
      if (session.roomCode !== old.code) continue;
      old.unbindConnection(session, socketId);
      sessions.delete(socketId);
    }
    old.destroy();
    soloRoom = null;
  }

  function hasConnectedSoloClient() {
    return soloMode && [...sessions.values()].some((session) => session.roomCode === soloRoom?.code);
  }

  function persistSoloRoom(room) {
    if (!soloStatePath || !soloMode || room !== soloRoom || typeof room.snapshot !== 'function') return;
    try {
      fs.mkdirSync(path.dirname(soloStatePath), { recursive: true });
      const temporaryPath = `${soloStatePath}.tmp-${process.pid}`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(room.snapshot())}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, soloStatePath);
      fs.chmodSync(soloStatePath, 0o600);
    } catch {
      // Persistence is a convenience for the local entry. A full disk must
      // not turn a valid in-memory turn into a server error.
    }
  }

  function loadSoloRoom() {
    if (!soloStatePath || !soloMode || soloRoom) return;
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(soloStatePath, 'utf8'));
    } catch {
      return;
    }
    try {
      const room = new LiarRoom({
        modelNames: options.modelNames,
        code: soloRoomCode,
        autoTimers: options.autoTimers,
        durations: options.durations,
        now: options.now,
        allowCodex: true,
        aiDefaults: options.aiDefaults || { protocol: 'codex', model: 'gpt-5.6-luna' },
        soloMode: true,
        snapshot,
      });
      attachRoom(room);
      soloRoom = room;
      // A process restart has no live browser.  The restored room remains
      // paused until the explicit soloResume action binds seat 0.
      room.pauseSolo();
      persistSoloRoom(room);
    } catch {
      // Corrupt or incompatible local state is ignored; soloStart can make a
      // fresh game without touching any other project data.
      soloRoom = null;
    }
  }

  loadSoloRoom();

  function detachSession(socket, { keepRoom = true } = {}) {
    const session = sessions.get(socket.id);
    if (!session) return;
    const room = roomForSession(session);
    if (room) room.unbindConnection(session, socket.id);
    sessions.delete(socket.id);
    if (!keepRoom && room) removeRoom(room.code);
    else if (room) {
      if (soloMode && room === soloRoom && !hasConnectedSoloClient()) room.pauseSolo();
      emitState(room);
    }
  }

  function removeRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    room.destroy();
    rooms.delete(code);
    for (const [socketId, session] of sessions) {
      if (session.roomCode === code) {
        sessions.delete(socketId);
        io.sockets.sockets.get(socketId)?.disconnect(true);
      }
    }
  }

  function connectSession(socket, room, identity, profile = null) {
    // A resumed token replaces its previous socket. The token itself stays
    // server-side and is never sent to any other client.
    if (identity.host && room.hostSession?.socketId && room.hostSession.socketId !== socket.id) {
      io.sockets.sockets.get(room.hostSession.socketId)?.disconnect(true);
    }
    const previous = room.players[identity.seatIndex]?.socketId;
    if (Number.isInteger(identity.seatIndex) && previous && previous !== socket.id) {
      io.sockets.sockets.get(previous)?.disconnect(true);
    }
    const session = {
      roomCode: room.code,
      token: identity.token,
      seatIndex: identity.seatIndex,
      isHost: Boolean(identity.host || identity.seatIndex === room.hostSeat),
      profile: profile || (Number.isInteger(identity.seatIndex) ? {
        name: room.players[identity.seatIndex].name,
        gender: room.players[identity.seatIndex].gender,
        skin: room.players[identity.seatIndex].skin,
      } : null),
      actions: [],
    };
    sessions.set(socket.id, session);
    room.bindConnection(session, socket.id);
    // Reconnecting a host/spectator must resume an AI turn that was paused
    // while no human socket was present. The room keeps all scheduling rules;
    // this only re-kicks the current phase through the same provider route.
    if (room.phase === 'playing' || room.phase === 'roulette') room.kickAI();
    return session;
  }

  function acceptAction(socket, payload, ack) {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply({ ok: false, error: 'payload invalid' });
    let encoded;
    try { encoded = JSON.stringify(payload); } catch { return reply({ ok: false, error: 'payload invalid' }); }
    if (encoded.length > SOCKET_LIMIT) return reply({ ok: false, error: 'payload too large' });
    const type = typeof payload.type === 'string' ? payload.type : '';
    const session = sessions.get(socket.id);
    const soloEntry = soloMode && ['soloStart', 'soloResume', 'solo/start', 'solo/resume'].includes(type);
    const now = Date.now();
    const actionStamps = Array.isArray(socket.data.actionStamps)
      ? socket.data.actionStamps.filter((stamp) => now - stamp < 1000)
      : [];
    if (actionStamps.length >= 40) return reply({ ok: false, error: 'rate limit' });
    actionStamps.push(now);
    socket.data.actionStamps = actionStamps;
    if (!soloEntry && type !== 'create' && type !== 'join' && type !== 'resume' && !session) {
      return reply({ ok: false, error: 'join or resume required' });
    }
    try {
      let shouldDetach = false;
      let room;
      let result;
      if (soloMode && (type === 'soloStart' || type === 'solo/start')) {
        const profile = profileFrom(payload);
        const localPlayerDead = soloRoom?.players?.[0]?.kind === 'human' && soloRoom.players[0].alive === false && soloRoom.phase === 'playing';
        if (soloRoom && !['lobby', 'ended'].includes(soloRoom.phase) && !localPlayerDead) throw new Error('solo game already running');
        const previous = soloRoom;
        resetSoloRoom();
        room = createSoloRoom(profile, previous);
        const identity = { seatIndex: 0, token: room.players[0].token, host: true };
        const attached = connectSession(socket, room, identity, profile);
        room.start(actorFor(attached), { starterSeat: 0 });
        reply({ ok: true, mySeat: 0 });
        socket.emit('state', stateFor(room, attached));
        return;
      }
      if (soloMode && (type === 'soloResume' || type === 'solo/resume')) {
        if (!soloRoom) return reply({ ok: true, empty: true });
        room = soloRoom;
        if (room.players[0]?.kind !== 'human') throw new Error('solo player seat unavailable');
        const identity = { seatIndex: 0, token: room.players[0].token, host: true };
        const attached = connectSession(socket, room, identity);
        reply({ ok: true, mySeat: 0 });
        socket.emit('state', stateFor(room, attached));
        return;
      }
      if (soloMode && ['create', 'join', 'resume'].includes(type)) throw new Error('solo server uses soloStart or soloResume');
      if (type === 'create') {
        if (rooms.size >= maxRooms) throw new Error('room capacity reached');
        const profile = profileFrom(payload);
        room = createRoom(profile);
        const identity = { seatIndex: 0, token: room.players[0].token, host: true };
        const attached = connectSession(socket, room, identity, profile);
        result = { code: room.code, token: attached.token, mySeat: attached.seatIndex };
        reply({ ok: true, ...result });
        socket.emit('state', stateFor(room, attached));
        return;
      }
      if (type === 'join') {
        room = roomFor(payload.code);
        const profile = profileFrom(payload);
        const identity = room.join({ ...profile, token: payload.token });
        const attached = connectSession(socket, room, identity, profile);
        result = { code: room.code, token: attached.token, mySeat: attached.seatIndex };
        reply({ ok: true, ...result });
        emitState(room);
        return;
      }
      if (type === 'resume') {
        room = roomFor(payload.code);
        const token = normalizeToken(payload.token);
        const identity = room.resume(token);
        const attached = connectSession(socket, room, identity);
        result = { code: room.code, token: attached.token, mySeat: attached.seatIndex };
        reply({ ok: true, ...result });
        emitState(room);
        return;
      }
      room = roomForSession(session);
      if (!room) throw new Error('room not found');
      const actor = actorFor(session);
      switch (type) {
        case 'profile':
          if (!Number.isInteger(session.seatIndex)) throw new Error('spectator cannot profile');
          room.profile(session.seatIndex, profileFrom(payload));
          session.profile = profileFrom(payload);
          break;
        case 'setSeat': {
          if (soloMode && room === soloRoom) throw new Error('solo seat layout is fixed');
          room.setSeat(actor, payload);
          if (payload.seatIndex === room.hostSeat && (payload.kind === 'ai' || payload.kind === 'bot')) {
            session.seatIndex = null;
            session.token = room.hostToken;
          }
          if (payload.seatIndex === room.hostSeat && payload.kind === 'human') {
            session.seatIndex = room.hostSeat;
            session.token = room.hostToken;
          }
          break;
        }
        case 'configureAI':
        case 'aiConfig':
        case 'setAIConfig':
          room.configureAI(actor, payload);
          break;
        case 'retryAI':
          room.retryAI(actor, payload);
          break;
        case 'start':
          room.start(actor, { starterSeat: soloMode && room === soloRoom ? 0 : null });
          break;
        case 'soloPause':
        case 'solo/pause':
          if (!soloMode || room !== soloRoom) throw new Error('solo mode unavailable');
          if (!actor.isHost) throw new Error('host required');
          room.pauseSolo();
          break;
        case 'soloContinue':
        case 'solo/continue':
          if (!soloMode || room !== soloRoom) throw new Error('solo mode unavailable');
          if (!actor.isHost) throw new Error('host required');
          room.resumeSolo();
          break;
        case 'play':
          if (!Number.isInteger(session.seatIndex)) throw new Error('spectator cannot play');
          room.play(session.seatIndex, payload.cardIds);
          break;
        case 'challenge':
          if (!Number.isInteger(session.seatIndex)) throw new Error('spectator cannot challenge');
          room.challenge(session.seatIndex);
          break;
        case 'pullTrigger':
          if (!Number.isInteger(session.seatIndex)) throw new Error('spectator cannot pull trigger');
          room.pullTrigger(session.seatIndex);
          break;
        case 'restart':
          if (soloMode && room === soloRoom) {
            if (room.phase !== 'ended') throw new Error('restart only after ended');
            const previous = room;
            resetSoloRoom();
            room = createSoloRoom(actor.profile || { name: '玩家1', gender: 'male', skin: 0 }, previous);
            const attached = connectSession(socket, room, { seatIndex: 0, token: room.players[0].token, host: true }, actor.profile);
            room.start(actorFor(attached), { starterSeat: 0 });
            break;
          }
          room.restart(actor);
          break;
        case 'leave':
          if (!Number.isInteger(session.seatIndex)) {
            if (!session.isHost) throw new Error('spectator cannot leave');
            room.addEvent('房主旁观连接离开，保留房间', 'leave');
          } else {
            room.leave(session.seatIndex);
          }
          shouldDetach = true;
          break;
        case 'takeSeat':
          throw new Error('use join with a room code to take an open seat');
        default:
          throw new Error('unknown action');
      }
      reply({ ok: true });
      emitState(room);
      if (shouldDetach) {
        detachSession(socket);
        socket.disconnect(true);
      }
    } catch (error) {
      reply({ ok: false, error: safeErrorMessage(error) });
    }
  }

  io.on('connection', (socket) => {
    socket.on('action', (payload, ack) => acceptAction(socket, payload, ack));
    socket.on('disconnect', () => detachSession(socket));
  });

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    const activeRooms = [...rooms.values()];
    if (soloRoom) activeRooms.push(soloRoom);
    for (const room of activeRooms) {
      const connected = [...sessions.values()].some((session) => session.roomCode === room.code);
      if (room.phase === 'playing' && room.deadline && now >= room.deadline && Number.isInteger(room.turnSeat) && room.players[room.turnSeat]?.kind !== 'ai') {
        try {
          room.timeoutTurn(room.turnSeat);
          emitState(room);
        } catch (error) {
          room.addEvent(`回合计时器错误：${safeErrorMessage(error)}`, 'error');
          emitState(room);
        }
      } else if (connected && room.phase === 'roulette' && room.deadline && now >= room.deadline && !room.lastShot && Number.isInteger(room.loserSeat)) {
        const loser = room.players[room.loserSeat];
        try {
          if (loser.kind === 'ai') {
            loser.ai.error = 'AI roulette turn timed out; retry required';
            room.deadline = null;
            room.addEvent(`${loser.name} 的 AI 轮盘超时，等待房主重试`, 'ai_error');
          } else {
            room.addEvent(`${loser.name} 轮盘超时，自动扣扳机（真人超时）`, 'timeout');
            room.pullTrigger(room.loserSeat);
          }
          emitState(room);
        } catch (error) {
          room.addEvent(`轮盘计时器错误：${safeErrorMessage(error)}`, 'error');
          emitState(room);
        }
      }
      if (!soloMode || room !== soloRoom) {
        if (!connected && now - room.lastActivityAt > roomTTL) removeRoom(room.code);
      }
    }
  }, sweepEvery);
  sweepTimer.unref?.();

  async function listen(port = options.port ?? DEFAULT_PORT, host = options.host ?? DEFAULT_HOST) {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, resolve);
    });
    return httpServer.address();
  }

  async function close() {
    clearInterval(sweepTimer);
    for (const room of rooms.values()) room.destroy();
    soloRoom?.destroy();
    for (const socket of io.sockets.sockets.values()) socket.disconnect(true);
    await new Promise((resolve) => io.close(() => resolve()));
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return { app, httpServer, io, rooms, sessions, listen, close, emitState, acceptAction, stateFor };
}

export function createServer(options = {}) {
  return createGameServer(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createGameServer();
  server.listen().then((address) => {
    const shown = typeof address === 'object' ? `${address.address}:${address.port}` : address;
    console.log(`Liar's Tavern listening on http://${shown}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
