import { attributedSpeech } from './public/speech-format.js';
import fs from 'node:fs';
import path from 'node:path';

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id);
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知时间';

// Separate from the rolling public event feed: archives retain every utterance.
export class ChatHistory {
  constructor(directory) {
    this.directory = directory;
    this.cache = new Map();
    this.saved = new Map();
    this.error = null;
  }

  read(id) {
    if (!validId(id)) throw new Error('牌局编号无效');
    if (this.cache.has(id)) return this.cache.get(id);
    const file = path.join(this.directory, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.matchId !== id || !Array.isArray(data.messages)) throw new Error('聊天存档损坏，原文件已保留');
    this.cache.set(id, data);
    this.saved.set(id, JSON.stringify(data));
    return data;
  }

  observe(room, abandoned = false) {
    if (room.phase === 'lobby') return;
    try {
      let archive = this.read(room.matchId);
      if (!archive) {
        archive = {
          version: 1, matchId: room.matchId, startedAt: room.createdAt,
          savedSince: Date.now(), partial: room.round > 1 || room.events.some((event) => event.type === 'speech'),
          endedAt: null, status: 'playing', players: [], messages: [],
        };
        this.cache.set(room.matchId, archive);
      }
      archive.round = room.round;
      archive.players = room.players.filter((p) => p.kind !== 'open').map((p) => ({
        seatIndex: p.seatIndex, name: p.name, kind: p.kind,
        ...(p.kind === 'ai' ? { model: p.ai.model, effort: p.ai.effort } : {}),
      }));
      if (room.phase === 'ended' || abandoned) {
        archive.status = room.phase === 'ended' ? 'ended' : 'abandoned';
        archive.endedAt ||= Date.now();
        archive.winner = room.players[room.winnerSeat]?.name || null;
      }
      const ids = new Set(archive.messages.map((message) => message.id));
      for (const event of room.events) {
        if (event.type !== 'speech' || ids.has(event.id) || (event.matchId && event.matchId !== room.matchId)) continue;
        const separator = event.text.indexOf('：');
        archive.messages.push({
          id: event.id, createdAt: event.createdAt, round: event.round ?? null,
          seatIndex: event.seatIndex,
          name: event.speakerName ?? (separator >= 0 ? event.text.slice(0, separator) : '玩家'),
          speakerStatus: event.speakerStatus ?? null,
          kind: event.speakerKind ?? room.players[event.seatIndex]?.kind ?? 'unknown',
          text: event.message ?? (separator >= 0 ? event.text.slice(separator + 1) : event.text),
        });
        ids.add(event.id);
      }
      const encoded = JSON.stringify(archive);
      if (this.saved.get(room.matchId) !== encoded) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, `${room.matchId}.json`);
        fs.writeFileSync(`${file}.tmp`, `${encoded}\n`, { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
        this.saved.set(room.matchId, encoded);
      }
      this.error = null;
    } catch {
      this.error = '聊天自动保存失败，请下载当前记录；已有文件保留。';
    }
  }

  list() {
    const ids = new Set(this.cache.keys());
    if (fs.existsSync(this.directory)) {
      for (const file of fs.readdirSync(this.directory)) {
        if (file.endsWith('.json') && validId(file.slice(0, -5))) ids.add(file.slice(0, -5));
      }
    }
    const matches = [];
    const errors = [];
    for (const id of ids) {
      try {
        const archive = this.read(id);
        const { messages, ...metadata } = archive;
        matches.push({ ...metadata, messageCount: messages.length });
      } catch { errors.push(`存档 ${id} 读取失败，原文件已保留。`); }
    }
    return { matches: matches.sort((a, b) => b.startedAt - a.startedAt), error: [this.error, ...errors].filter(Boolean).join(' ') };
  }

  text(id) {
    const archive = this.read(id);
    if (!archive) return null;
    return '\uFEFF' + [
      '骗子酒馆 · 聊天记录', `牌局：${archive.matchId}`, `开始：${date(archive.startedAt)}`,
      `玩家：${archive.players.map((p) => p.name).join(' / ')}`,
      `状态：${({ playing: '进行中', ended: '已结束', abandoned: '中途离开' })[archive.status]}`,
      ...(archive.winner ? [`赢家：${archive.winner}`] : []),
      ...(archive.partial ? ['本局从启用聊天存档时开始记录；更早的发言可能缺失。'] : []), '',
      ...archive.messages.map((message) => `[${date(message.createdAt)}${message.round ? ` · 第 ${message.round} 轮` : ''}] ${attributedSpeech(message.text, message.name, message.speakerStatus)}`),
      '',
    ].join('\n');
  }
}
