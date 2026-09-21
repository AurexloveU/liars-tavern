import { shortSpeech } from './public/model-presets.js';

// Each seat has an independent chat queue. Chat never executes a card action.
export class TableTalk {
  constructor({ provider, history, connected, emit }) {
    this.provider = provider;
    this.history = history;
    this.connected = connected;
    this.emit = emit;
    this.rooms = new Map();
  }

  state(room) {
    const entry = this.rooms.get(room);
    return {
      pending: entry ? [...entry.seats.values()].filter((seat) => seat.busy || seat.pending.length).map((seat) => room.players[seat.index]?.name).filter(Boolean) : [],
      error: entry?.error || null,
    };
  }

  observe(room) {
    if (room.phase === 'lobby') return;
    let entry = this.rooms.get(room);
    if (!entry || entry.matchId !== room.matchId) {
      this.cancel(room);
      entry = { matchId: room.matchId, seen: room.eventSeq, seats: new Map(), error: null };
      this.rooms.set(room, entry);
      return; // Restoring a snapshot must not buy replies to historical messages.
    }
    const fresh = room.events.filter((event) => event.id > entry.seen);
    entry.seen = room.eventSeq;
    if (!this.connected(room)) return;
    for (const event of fresh) {
      const speech = event.type === 'speech';
      const sceneChange = ['challenge', 'fatal', 'empty', 'winner'].includes(event.type) && !room.soloPaused;
      if (!speech && !sceneChange) continue;
      // A reply may invite one follow-up; follow-ups never start another wave.
      if (speech && event.chatDepth >= 1) continue;
      for (const player of room.players) {
        if (player.kind !== 'ai' || (speech && player.seatIndex === event.seatIndex)) continue;
        let seat = entry.seats.get(player.seatIndex);
        if (!seat) {
          seat = { index: player.seatIndex, busy: false, timer: null, pending: [], lastStart: 0 };
          entry.seats.set(player.seatIndex, seat);
        }
        seat.pending.push({ event, depth: event.chatDepth === 0 ? 1 : 0 });
        // A bounded trigger window; the transcript itself retains all speech.
        seat.pending = seat.pending.slice(-40);
        this.schedule(room, entry, seat);
      }
    }
  }

  schedule(room, entry, seat) {
    if (seat.busy || seat.timer || !seat.pending.length) return;
    seat.timer = setTimeout(() => {
      seat.timer = null;
      void this.respond(room, entry, seat);
    }, Math.max(900, 5000 - (Date.now() - seat.lastStart)));
    seat.timer.unref?.();
  }

  async respond(room, entry, seat) {
    if (this.rooms.get(room) !== entry || room.matchId !== entry.matchId) return;
    if (!this.connected(room)) { seat.pending = []; return; }
    const player = room.players[seat.index];
    if (player?.kind !== 'ai') { seat.pending = []; return; }
    const triggers = seat.pending.splice(0);
    if (!triggers.length) return;
    const ai = { ...player.ai };
    const identity = JSON.stringify([ai.model, ai.effort, ai.protocol, ai.persona, ai.systemPrompt, ai.baseUrl]);
    const depth = Math.min(...triggers.map((trigger) => trigger.depth));
    seat.busy = true;
    seat.lastStart = Date.now();
    entry.error = null;
    this.emit(room);
    try {
      let transcript = [];
      try { transcript = this.history?.read(room.matchId)?.messages.slice(-40) || []; } catch { /* public events remain available */ }
      const view = room.aiView(seat.index);
      const chatView = {
        mode: 'chat', selfSeat: seat.index,
        state: { ...view.state, legalActions: [] },
        transcript,
        newEvents: triggers.map(({ event }) => event),
      };
      const decision = await this.provider({ room, seatIndex: seat.index, ai, phase: 'chat', chatView });
      if (this.rooms.get(room) !== entry || room.matchId !== entry.matchId || !this.connected(room)) return;
      const current = room.players[seat.index];
      if (current?.kind !== 'ai' || JSON.stringify([current.ai.model, current.ai.effort, current.ai.protocol, current.ai.persona, current.ai.systemPrompt, current.ai.baseUrl]) !== identity) return;
      const text = shortSpeech(decision.speech);
      if (text) room.say(seat.index, text, { chatDepth: depth });
    } catch (error) {
      if (this.rooms.get(room) === entry) {
        entry.error = `${player.name} 暂未接上话：聊天请求失败，出牌不受影响。`;
      }
    } finally {
      seat.busy = false;
      if (this.rooms.get(room) === entry) {
        if (this.connected(room)) this.schedule(room, entry, seat);
        else seat.pending = [];
        this.emit(room);
      }
    }
  }

  cancel(room) {
    const entry = this.rooms.get(room);
    if (entry) for (const seat of entry.seats.values()) clearTimeout(seat.timer);
    this.rooms.delete(room);
  }

  close() { for (const room of this.rooms.keys()) this.cancel(room); }
}
