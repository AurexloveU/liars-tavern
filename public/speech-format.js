// Sender identity and life status are assigned by the game, never by model text.
export function participationStatus(player, phase) {
  if (player?.alive === false) return 'spectator';
  return phase === 'ended' ? 'finished' : 'playing';
}

export function speakerSuffix(name, status) {
  const tag = status === 'spectator' ? '（已淘汰·旁观）' : status === 'finished' ? '（本局结束）' : '';
  return `— ${name || '未知玩家'}${tag}`;
}

export function attributedSpeech(text, name, status) {
  return `${text} ${speakerSuffix(name, status)}`;
}
