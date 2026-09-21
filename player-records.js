import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { modelPreset } from './public/model-presets.js';

function identity(seat) {
  const preset = seat.kind === 'ai' && seat.ai?.protocol === 'codex' ? modelPreset(seat.ai.model) : null;
  const signature = seat.kind === 'human'
    ? `human:${seat.name.trim().normalize('NFC')}`
    : preset ? `codex:${preset.id}` : `ai:${seat.ai?.protocol}:${seat.ai?.baseUrl}:${seat.ai?.model}:${seat.name}`;
  return {
    id: crypto.createHash('sha256').update(signature).digest('hex').slice(0, 24),
    name: seat.name,
    kind: seat.kind,
    model: preset?.label || (seat.kind === 'ai' ? seat.ai?.model || '自定义 AI' : '真人'),
  };
}

export class PlayerRecords {
  constructor(file) {
    this.file = file;
    this.error = '';
    this.blocked = false;
    this.data = { version: 1, trackingSince: new Date().toISOString(), players: {}, matches: {} };
    try {
      if (file && fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.version !== 1 || !saved.players || !saved.matches) throw new Error('Invalid records');
        this.data = saved;
      }
    } catch {
      this.error = '战绩文件读取失败，原文件已保留。';
      this.blocked = true;
    }
  }

  observe(room) {
    if (this.blocked || !room?.matchId || room.phase === 'lobby' || !room.round) return;
    let changed = false;
    let match = this.data.matches[room.matchId];
    if (!match) {
      match = { participants: [], startedAt: new Date().toISOString(), completedAt: null, winnerId: null };
      this.data.matches[room.matchId] = match;
      changed = true;
    }
    if (!match.completedAt) {
      for (const seat of room.players) {
        if (!['human', 'ai'].includes(seat.kind)) continue;
        const player = identity(seat);
        const prior = this.data.players[player.id];
        if (!prior || prior.name !== player.name || prior.model !== player.model) {
          this.data.players[player.id] = player;
          changed = true;
        }
        if (!match.participants.includes(player.id)) { match.participants.push(player.id); changed = true; }
      }
      if (room.phase === 'ended' && Number.isInteger(room.winnerSeat)) {
        match.completedAt = new Date().toISOString();
        match.winnerId = identity(room.players[room.winnerSeat]).id;
        changed = true;
      }
    }
    if (changed || this.error) this.save();
  }

  save() {
    if (!this.file || this.blocked) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.error = '';
    } catch { this.error = '战绩暂未写入磁盘；本次运行的数据仍在内存中。'; }
  }

  summary() {
    const rows = Object.values(this.data.players).map((player) => {
      const matches = Object.values(this.data.matches).filter((match) => match.participants.includes(player.id));
      const completed = matches.filter((match) => match.completedAt);
      const wins = completed.filter((match) => match.winnerId === player.id).length;
      return { ...player, joined: matches.length, played: completed.length, wins, losses: completed.length - wins,
        winRate: completed.length ? Math.round(100 * wins / completed.length) : null };
    }).sort((a, b) => b.wins - a.wins || b.played - a.played || a.name.localeCompare(b.name, 'zh-CN'));
    return { trackingSince: this.data.trackingSince, error: this.error, players: rows };
  }
}
