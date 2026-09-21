const $ = (id) => document.getElementById(id);

const SESSION_KEY = 'liars-tavern:session';
const PREFS_KEY = 'liars-tavern:prefs';
const roomFromUrl = new URLSearchParams(window.location.search).get('room') || '';
const savedSession = readStorage(SESSION_KEY) || {};
const savedPrefs = readStorage(PREFS_KEY) || {};

let socket = null;
let tavernScene = null;
let currentState = null;
let entryMode = roomFromUrl ? 'join' : 'create';
let selectedCards = new Set();
let selectedAiSeat = 1;
let lastShotId = null;
let toastTimer = null;
let audioContext = null;
let soundEnabled = false;
let leavingRoom = false;
let roomPanelCollapsed = false;
let profile = {
  name: savedPrefs.name || '',
  gender: savedPrefs.gender === 'female' ? 'female' : 'male',
  skin: Number.isInteger(savedPrefs.skin) ? savedPrefs.skin : 0,
};

function readStorage(key) {
  try {
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

function escText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function errorText(error) {
  if (!error) return '操作没有完成。';
  if (typeof error === 'string') return error;
  return error.message || error.error || '操作没有完成。';
}

function setConnection(text, mode = '') {
  const banner = $('connection-banner');
  banner.textContent = text;
  banner.classList.toggle('is-good', mode === 'good');
  banner.classList.toggle('is-bad', mode === 'bad');
}

function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function setFormError(target, text) {
  const node = $(target);
  node.textContent = text || '';
  node.hidden = !text;
}

function setRoomPanelCollapsed(collapsed) {
  roomPanelCollapsed = Boolean(collapsed);
  const inLobby = Boolean(currentState?.code && currentState.phase === 'lobby');
  $('room-panel').hidden = !inLobby || roomPanelCollapsed;
  $('room-collapse-button').hidden = !inLobby || roomPanelCollapsed;
  $('room-toggle-button').hidden = !inLobby || !roomPanelCollapsed;
  $('room-collapse-button').setAttribute('aria-expanded', String(!roomPanelCollapsed));
  $('room-toggle-button').setAttribute('aria-expanded', String(!roomPanelCollapsed));
}

function setEntryMode(mode) {
  entryMode = mode;
  const isJoin = mode === 'join';
  $('create-tab').classList.toggle('is-active', !isJoin);
  $('join-tab').classList.toggle('is-active', isJoin);
  $('create-tab').setAttribute('aria-selected', String(!isJoin));
  $('join-tab').setAttribute('aria-selected', String(isJoin));
  $('join-code-field').hidden = !isJoin;
  $('join-code').required = isJoin;
  $('entry-submit-label').textContent = isJoin ? '加入房间' : '开一桌';
  if (isJoin && roomFromUrl && !$('join-code').value) $('join-code').value = roomFromUrl.toUpperCase();
}

function saveProfileFromForm() {
  profile = {
    name: $('profile-name').value.trim(),
    gender: $('profile-gender').value === 'female' ? 'female' : 'male',
    skin: Math.max(0, Math.min(1, Number($('profile-skin').value) || 0)),
  };
  writeStorage(PREFS_KEY, profile);
  return profile;
}

function updateSkinOptions() {
  const select = $('profile-skin');
  const female = $('profile-gender').value === 'female';
  const labels = female ? ['紫罗兰绸衣', '深青短外套'] : ['炭黑礼服', '酒红夹克'];
  const previous = select.value;
  select.replaceChildren(...labels.map((label, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = label;
    return option;
  }));
  select.value = labels[Number(previous)] ? previous : '0';
}

function storeSession(ack) {
  if (!ack?.code || !ack?.token) return;
  writeStorage(SESSION_KEY, { code: ack.code, token: ack.token });
  history.replaceState(null, '', `${window.location.pathname}?room=${encodeURIComponent(ack.code)}`);
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}

function sendAction(type, payload = {}) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) {
      resolve({ ok: false, error: '还没有连接到牌桌。' });
      return;
    }
    let finished = false;
    const finish = (ack) => {
      if (finished) return;
      finished = true;
      resolve(ack || { ok: false, error: '服务器没有返回结果。' });
    };
    socket.emit('action', { type, ...payload }, finish);
    window.setTimeout(() => finish({ ok: false, error: '请求超时，请检查连接后再试。' }), 9000);
  });
}

function maybeStartAudio() {
  if (!soundEnabled) return;
  if (!audioContext) {
    try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioContext = null; }
  }
  if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
}

function tone(frequency, duration = 0.07, type = 'sine', gainValue = 0.025) {
  if (!soundEnabled) return;
  maybeStartAudio();
  if (!audioContext) return;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(gainValue, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
  osc.connect(gain).connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + duration);
}

function showDialog(dialog) {
  if (dialog?.showModal) dialog.showModal();
  else dialog?.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (dialog?.close) dialog.close();
  else dialog?.removeAttribute('open');
}

function phaseLabel(phase) {
  return ({ lobby: '大厅', playing: '进行中', reveal: '翻牌', roulette: '轮盘', ended: '已结束' }[phase] || '大厅');
}

function kindLabel(kind) {
  return ({ ai: 'AI', human: '真人', open: '空位' }[kind] || '空位');
}

function rankLabel(rank) {
  return rank === 'JOKER' ? '★' : (rank || '—');
}

function riskLabel(nextRisk) {
  const value = Number(nextRisk);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1) return '1/1';
  return `1/${Math.round(1 / value)}`;
}

function playerAt(seatIndex) {
  return currentState?.players?.find((player) => player.seatIndex === seatIndex) || null;
}

function renderSeatList() {
  const list = $('seat-list');
  list.replaceChildren();
  const isHost = Boolean(currentState?.isHost || currentState?.hostSeat === currentState?.selfSeat);
  for (let seatIndex = 0; seatIndex < 4; seatIndex += 1) {
    const player = playerAt(seatIndex);
    const row = document.createElement('div');
    row.className = `seat-row${seatIndex === currentState?.selfSeat ? ' is-self' : ''}`;
    const index = document.createElement('span');
    index.className = 'seat-index';
    index.textContent = String(seatIndex + 1);
    row.append(index);

    const details = document.createElement('div');
    details.className = 'seat-name';
    details.textContent = player?.name || (seatIndex === 0 ? '房主席位' : '等待入座');
    const meta = document.createElement('small');
    meta.className = 'seat-meta';
    if (player) {
      const connection = player.connected === false ? ' · 断线' : '';
      const dead = currentState?.phase !== 'lobby' && player.alive === false ? ' · 已出局' : '';
      const lobbyState = currentState?.phase === 'lobby' ? ' · 待开局' : '';
      meta.textContent = `${player.gender === 'female' ? '女' : '男'}${connection}${dead}${lobbyState}`;
      if (currentState?.phase !== 'lobby') {
        const risk = document.createElement('small');
        risk.className = 'seat-meta';
        risk.textContent = `轮盘 ${player.shots || 0}/6 · 下一次风险 ${riskLabel(player.nextRisk)}`;
        details.append(risk);
      }
    } else {
      meta.textContent = '每名玩家从自己的南面看桌子';
    }
    details.append(meta);
    row.append(details);

    const state = document.createElement('div');
    state.className = 'seat-state';
    const kind = document.createElement('span');
    kind.className = `seat-kind ${player?.kind || 'open'}`;
    kind.textContent = player?.kind === 'ai' ? `AI · ${player.ai?.model || '待配置'}` : kindLabel(player?.kind || 'open');
    state.append(kind);
    if (player?.kind === 'ai') {
      const aiStatus = document.createElement('small');
      aiStatus.className = 'seat-meta';
      aiStatus.textContent = player.ai?.error ? `错误：${player.ai.error}` : (player.ai?.configured ? '已配置' : '待配置');
      state.append(aiStatus);
      const aiButton = document.createElement('button');
      aiButton.type = 'button';
      aiButton.className = 'subtle-button';
      aiButton.textContent = '设置';
      aiButton.addEventListener('click', () => openSettings(seatIndex));
      state.append(aiButton);
      if (isHost && player.ai?.error) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'subtle-button';
        retry.textContent = '重试';
        retry.addEventListener('click', async () => {
          const ack = await sendAction('retryAI', { seatIndex });
          if (!ack.ok) showToast(errorText(ack.error));
        });
        state.append(retry);
      }
    }
    if (isHost && currentState?.phase === 'lobby' && !(player?.kind === 'human' && player.connected && seatIndex !== currentState.selfSeat)) {
      const select = document.createElement('select');
      select.className = 'seat-control';
      select.setAttribute('aria-label', `第 ${seatIndex + 1} 席类型`);
      const options = seatIndex === 0 ? [['ai', 'AI'], ['human', '真人']] : [['open', '空位'], ['ai', 'AI']];
      for (const [value, label] of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = (player?.kind || 'open') === value;
        select.append(option);
      }
      select.addEventListener('change', async () => {
        const ack = await sendAction('setSeat', { seatIndex, kind: select.value });
        if (!ack.ok) {
          showToast(errorText(ack.error));
          renderSeatList();
        } else {
          tone(580, 0.05);
        }
      });
      state.append(select);
    }
    row.append(state);
    list.append(row);
  }
  const configuredCount = (currentState?.players || []).filter((player) => player.kind !== 'open' && (player.kind !== 'ai' ? player.connected !== false : player.ai?.configured)).length;
  const ready = configuredCount >= 4;
  $('lobby-readiness').textContent = ready ? '四席已就绪' : `${configuredCount}/4 席已就绪`;
  $('lobby-readiness').classList.toggle('ready', ready);
  $('start-button').disabled = !isHost || !ready;
  $('start-help').textContent = ready ? '可以开局。AI 会使用各自的配置做决定。' : '真人需入座；AI 席位需先填写接口配置。';
}

function renderSeatHud() {
  const hud = $('seat-hud');
  const state = currentState;
  hud.replaceChildren();
  if (!state?.code || state.phase === 'lobby') {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;
  const selfSeat = Number.isInteger(state.selfSeat) ? state.selfSeat : 0;
  const isHost = Boolean(state.isHost || state.hostSeat === state.selfSeat);
  const relativeNames = ['南', '西', '北', '东'];
  for (const player of state.players || []) {
    if (!player || player.kind === 'open') continue;
    const relative = (player.seatIndex - selfSeat + 4) % 4;
    const badge = document.createElement('div');
    badge.className = `seat-badge rel-${relative}${player.seatIndex === state.turnSeat ? ' is-turn' : ''}${player.alive === false ? ' is-dead' : ''}${player.ai?.error ? ' is-error' : ''}`;
    badge.setAttribute('aria-label', `第 ${player.seatIndex + 1} 席 ${player.name || kindLabel(player.kind)}`);
    const name = document.createElement('strong');
    name.className = 'seat-badge-name';
    name.textContent = player.name || `第 ${player.seatIndex + 1} 席`;
    const kind = document.createElement('span');
    kind.className = 'seat-badge-kind';
    kind.textContent = `${relativeNames[relative]}${player.seatIndex === state.selfSeat ? ' · 自己' : ''} · ${player.kind === 'ai' ? `AI · ${player.ai?.model || '待配置'}` : '真人'}`;
    const stats = document.createElement('span');
    stats.className = 'seat-badge-stats';
    stats.textContent = player.alive === false
      ? `手牌 0 · 空枪 ${player.shots || 0}/6 · 已淘汰`
      : `手牌 ${player.handCount || 0} · 轮盘 ${player.shots || 0}/6 · 下一次 ${riskLabel(player.nextRisk)}`;
    badge.append(name, kind, stats);
    if (player.ai?.error) {
      const error = document.createElement('span');
      error.className = 'seat-badge-error';
      error.textContent = player.ai.error;
      badge.append(error);
      if (isHost) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'subtle-button seat-retry';
        retry.textContent = '重试 AI';
        retry.addEventListener('click', async () => {
          const ack = await sendAction('retryAI', { seatIndex: player.seatIndex });
          if (!ack.ok) showToast(errorText(ack.error));
        });
        badge.append(retry);
      }
    }
    hud.append(badge);
  }
}

function renderAiSeatPicker() {
  const picker = $('ai-seat-picker');
  picker.replaceChildren();
  for (let seatIndex = 0; seatIndex < 4; seatIndex += 1) {
    const player = playerAt(seatIndex);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ai-seat-button${seatIndex === selectedAiSeat ? ' is-active' : ''}`;
    button.textContent = `第 ${seatIndex + 1} 席 · ${player?.kind === 'ai' ? 'AI' : kindLabel(player?.kind || 'open')}`;
    button.disabled = player?.kind !== 'ai';
    button.addEventListener('click', () => { selectedAiSeat = seatIndex; renderAiSeatPicker(); fillAiSettings(); });
    picker.append(button);
  }
}

function fillAiSettings() {
  const player = playerAt(selectedAiSeat);
  const ai = player?.ai || {};
  const hostConfig = Array.isArray(currentState?.hostConfigs)
    ? currentState.hostConfigs.find((config) => config.seatIndex === selectedAiSeat) || {}
    : {};
  $('ai-base-url').value = hostConfig.baseUrl || ai.baseUrl || '';
  $('ai-model').value = hostConfig.model || ai.model || '';
  $('ai-protocol').value = hostConfig.protocol || ai.protocol || 'chat';
  $('ai-max-output').value = String(hostConfig.maxOutputTokens ?? ai.maxOutputTokens ?? 4096);
  $('ai-key').value = '';
  $('ai-clear-key').checked = false;
  $('ai-persona').value = hostConfig.persona || '';
  setFormError('settings-error', '');
}

function openSettings(seatIndex = selectedAiSeat) {
  selectedAiSeat = seatIndex;
  renderAiSeatPicker();
  fillAiSettings();
  showDialog($('settings-dialog'));
}

function aiPayload() {
  const maxOutputTokens = Math.max(256, Math.min(32768, Number($('ai-max-output').value) || 4096));
  return {
    baseUrl: $('ai-base-url').value.trim(),
    model: $('ai-model').value.trim(),
    protocol: $('ai-protocol').value,
    maxOutputTokens,
    apiKey: $('ai-key').value,
    clearKey: $('ai-clear-key').checked,
    persona: $('ai-persona').value.trim(),
  };
}

async function configureAiSeat(seatIndex, payload) {
  return sendAction('configureAI', { seatIndex, ...payload });
}

function renderHand() {
  const list = $('hand-list');
  list.replaceChildren();
  const hand = Array.isArray(currentState?.hand) ? currentState.hand : [];
  const handIds = new Set(hand.map((card) => card.id));
  selectedCards = new Set([...selectedCards].filter((id) => handIds.has(id)));
  $('hand-count-label').textContent = `${hand.length} 张`;
  hand.forEach((card, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `hand-card${selectedCards.has(card.id) ? ' is-selected' : ''}${card.rank === 'JOKER' ? ' is-joker' : ''}`;
    button.setAttribute('aria-label', `第 ${index + 1} 张，${card.rank}`);
    button.setAttribute('aria-pressed', String(selectedCards.has(card.id)));
    const number = document.createElement('span');
    number.className = 'card-number';
    number.textContent = String(index + 1);
    const rank = document.createElement('span');
    rank.className = 'card-rank';
    rank.textContent = rankLabel(card.rank);
    button.append(number, rank);
    button.addEventListener('click', () => toggleCard(card.id));
    list.append(button);
  });
  renderActionState();
}

function toggleCard(cardId) {
  maybeStartAudio();
  if (selectedCards.has(cardId)) selectedCards.delete(cardId);
  else if (selectedCards.size < 3) selectedCards.add(cardId);
  else { showToast('最多选择 3 张牌。'); return; }
  tone(520, 0.035);
  renderHand();
}

function actionContext() {
  const selfSeat = currentState?.selfSeat;
  const me = playerAt(selfSeat);
  const alive = me?.alive !== false;
  const ownTurn = currentState?.turnSeat === selfSeat;
  return { me, alive, ownTurn };
}

function renderActionState() {
  const state = currentState;
  const { alive, ownTurn } = actionContext();
  const phase = state?.phase;
  const canPlay = Boolean(state && phase === 'playing' && alive && ownTurn && !state.mustChallenge && selectedCards.size >= 1 && selectedCards.size <= 3);
  const canChallenge = Boolean(state && phase === 'playing' && alive && ownTurn && state.lastPlay);
  const canTrigger = Boolean(state && phase === 'roulette' && alive && state.loserSeat === state.selfSeat && !state.lastShot);
  $('play-button').disabled = !canPlay;
  $('challenge-button').disabled = !canChallenge;
  $('trigger-button').disabled = !canTrigger;
  $('must-challenge').hidden = !state?.mustChallenge;
  let help = '等待你的回合……';
  if (!state) help = '进入房间后，手牌会出现在这里。';
  else if (!alive) help = '你已出局，可以继续旁观桌边记录。';
  else if (phase === 'roulette') help = state.lastShot ? (state.lastShot.fatal ? '枪响已处理，等待淘汰结算……' : '空响已处理，等待下一轮……') : (canTrigger ? '轮盘在你面前；扣下扳机。' : '等待轮盘结果……');
  else if (state.mustChallenge) help = canChallenge ? '必须质疑上一手。' : '桌上需要有人质疑上一手。';
  else if (phase === 'playing' && ownTurn) help = selectedCards.size ? `已选 ${selectedCards.size} 张，可以出牌。` : '轮到你了，选 1–3 张牌。';
  else if (phase === 'playing') help = `等待 ${state.players?.find((p) => p.seatIndex === state.turnSeat)?.name || '下一位'}。`;
  $('action-help').textContent = help;
  $('play-button').title = canPlay ? '按 Enter 出牌' : help;
  $('challenge-button').title = canChallenge ? '按 X 质疑' : help;
  $('trigger-button').title = canTrigger ? '按 Space 扣扳机' : help;
}

function renderEvents() {
  const list = $('event-list');
  list.replaceChildren();
  const events = Array.isArray(currentState?.events) ? currentState.events.slice(-24) : [];
  for (const event of events) {
    const item = document.createElement('div');
    item.className = `event-item ${event.type === 'danger' || event.type === 'shot' || event.type === 'fatal' || event.type === 'ai_error' ? 'is-danger' : event.type === 'good' ? 'is-good' : ''}`;
    const text = document.createElement('div');
    text.textContent = event.text || '';
    item.append(text);
    if (event.createdAt || event.time) {
      const time = document.createElement('time');
      time.textContent = event.time || new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      text.append(time);
    }
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
}

function renderThinking() {
  const thinking = currentState?.players?.find((player) => player.ai?.thinking);
  $('thinking-line').hidden = !thinking;
  if (thinking) $('thinking-label').textContent = `${thinking.name || `第 ${thinking.seatIndex + 1} 席`} 正在思考……`;
}

function renderState(rawState) {
  if (leavingRoom) return;
  const state = rawState?.state || rawState;
  if (!state || typeof state !== 'object') return;
  currentState = state;
  if (Number.isInteger(state.selfSeat)) selectedAiSeat = state.selfSeat === 0 ? 1 : selectedAiSeat;
  if (socket?.connected) setConnection(state.phase === 'lobby' ? '已连接 · 房间已建立' : '已连接 · 牌局同步中', 'good');
  $('phase-chip').textContent = phaseLabel(state.phase);
  $('room-chip').hidden = !state.code;
  $('room-chip').querySelector('b').textContent = state.code || '----';
  $('room-code-label').textContent = state.code || '----';
  $('room-title').textContent = state.phase === 'lobby' ? '等待入座' : phaseLabel(state.phase);
  const inRoom = Boolean(state.code);
  const inLobby = state.phase === 'lobby';
  const ended = state.phase === 'ended';
  $('lobby-panel').hidden = inRoom;
  setRoomPanelCollapsed(roomPanelCollapsed);
  $('table-inspector').hidden = !inRoom || inLobby;
  $('event-panel').hidden = !inRoom || inLobby;
  $('hand-panel').hidden = !inRoom || inLobby || !Number.isInteger(state.selfSeat);
  $('host-tools').hidden = !(inLobby && (state.isHost || state.hostSeat === state.selfSeat));
  $('leave-button').hidden = !inRoom;
  $('restart-button').hidden = !(ended && (state.isHost || state.hostSeat === state.selfSeat));
  if (inLobby) renderSeatList();
  renderSeatHud();
  $('target-rank').textContent = rankLabel(state.targetRank);
  $('pile-count').textContent = String(state.pileCount ?? 0);
  $('turn-label').textContent = state.turnSeat === null || state.turnSeat === undefined ? '—' : (state.players?.find((p) => p.seatIndex === state.turnSeat)?.name || `第 ${state.turnSeat + 1} 席`);
  const lastPlay = state.lastPlay;
  const lastPlayLine = $('last-play-line');
  if (lastPlay) {
    const playedBy = state.players?.find((p) => p.seatIndex === lastPlay.seatIndex)?.name || `第 ${lastPlay.seatIndex + 1} 席`;
    lastPlayLine.textContent = `上一手：${playedBy} · ${lastPlay.count} 张`;
    lastPlayLine.hidden = false;
  } else {
    lastPlayLine.hidden = true;
  }
  const revealCallout = $('reveal-callout');
  if (state.reveal) {
    const playedBy = state.players?.find((p) => p.seatIndex === state.reveal.playedBy)?.name || `第 ${state.reveal.playedBy + 1} 席`;
    const loser = state.players?.find((p) => p.seatIndex === state.reveal.loserSeat)?.name || `第 ${state.reveal.loserSeat + 1} 席`;
    revealCallout.textContent = `翻牌：${playedBy} · ${state.reveal.cards.map(rankLabel).join(' ')}；${state.reveal.lie ? '诈唬' : '真实'} · ${loser} 受罚`;
    revealCallout.hidden = false;
  } else {
    revealCallout.hidden = true;
  }
  renderHand();
  renderActionState();
  renderEvents();
  renderThinking();
  const me = playerAt(state.selfSeat);
  const dead = state.phase !== 'lobby' && me?.alive === false;
  $('dead-overlay').hidden = !(dead || ended);
  $('dead-overlay').classList.toggle('is-spectator', dead && !ended);
  if (dead || ended) {
    const winner = state.players?.find((p) => p.seatIndex === state.winnerSeat);
    $('dead-title').textContent = ended ? '牌局结束' : '你已淘汰，可继续旁观';
    $('dead-copy').textContent = ended ? (winner ? `${winner.name} 留在了桌边。` : '等待房主重新开局。') : '';
    $('dead-copy').hidden = !ended;
  }
  if (state.lastShot?.id && state.lastShot.id !== lastShotId) {
    lastShotId = state.lastShot.id;
    tavernScene?.playShot(state.lastShot);
    tone(state.lastShot.fatal ? 110 : 300, state.lastShot.fatal ? 0.26 : 0.12, 'sawtooth', state.lastShot.fatal ? 0.06 : 0.03);
  }
  tavernScene?.setState(state);
}

async function enterRoom(event) {
  event.preventDefault();
  maybeStartAudio();
  setFormError('entry-error', '');
  const nextProfile = saveProfileFromForm();
  const payload = { ...nextProfile };
  if (entryMode === 'join') payload.code = $('join-code').value.trim().toUpperCase();
  $('entry-form').querySelector('button[type="submit"]').disabled = true;
  const ack = await sendAction(entryMode === 'join' ? 'join' : 'create', payload);
  $('entry-form').querySelector('button[type="submit"]').disabled = false;
  if (!ack.ok) {
    setFormError('entry-error', errorText(ack.error));
    return;
  }
  storeSession(ack);
  tone(660, 0.08);
  if (Number.isInteger(ack.mySeat)) showToast(`已坐下，第 ${ack.mySeat + 1} 席。`);
}

async function resumeRoom() {
  if (!savedSession?.code || !savedSession?.token) return;
  const ack = await sendAction('resume', { code: savedSession.code, token: savedSession.token });
  if (!ack.ok) {
    clearSession();
    setConnection('连接已建立 · 需要重新入座', 'good');
    return;
  }
  if (ack.code && ack.token) storeSession(ack);
}

async function playCards() {
  if (!currentState || selectedCards.size < 1 || selectedCards.size > 3) return;
  const ack = await sendAction('play', { cardIds: [...selectedCards] });
  if (!ack.ok) showToast(errorText(ack.error));
  else { selectedCards.clear(); tone(690, 0.08); }
}

async function challenge() {
  const ack = await sendAction('challenge');
  if (!ack.ok) showToast(errorText(ack.error));
  else tone(180, 0.11);
}

async function pullTrigger() {
  const ack = await sendAction('pullTrigger');
  if (!ack.ok) showToast(errorText(ack.error));
}

async function restartRoom() {
  const ack = await sendAction('restart');
  if (!ack.ok) showToast(errorText(ack.error));
  else showToast('房间已回到大厅。');
}

function resetClientRoom() {
  clearSession();
  currentState = null;
  roomPanelCollapsed = false;
  selectedCards.clear();
  lastShotId = null;
  history.replaceState(null, '', window.location.pathname);
  $('phase-chip').textContent = '大厅';
  $('room-chip').hidden = true;
  $('lobby-panel').hidden = false;
  $('room-panel').hidden = true;
  $('room-collapse-button').hidden = true;
  $('room-toggle-button').hidden = true;
  $('table-inspector').hidden = true;
  $('event-panel').hidden = true;
  $('hand-panel').hidden = true;
  $('seat-hud').hidden = true;
  $('dead-overlay').hidden = true;
  $('leave-button').hidden = true;
  setConnection(socket?.connected ? '已连接 · 可以开桌' : '正在重连……', socket?.connected ? 'good' : 'bad');
  tavernScene?.setState(null);
  socket?.disconnect();
  window.setTimeout(() => {
    leavingRoom = false;
    socket?.connect();
  }, 80);
}

async function leaveRoom() {
  leavingRoom = true;
  const ack = await sendAction('leave');
  if (!ack.ok) {
    const message = errorText(ack.error);
    if (/spectator|leave only in lobby/i.test(message)) {
      resetClientRoom();
      showToast('已离开房间。');
    } else {
      leavingRoom = false;
      showToast(message);
    }
    return;
  }
  resetClientRoom();
  showToast('已离开房间。');
}

function setupSocket() {
  if (typeof window.io !== 'function') {
    setConnection('等待联机组件……', 'bad');
    return;
  }
  const socketPath = new URL('./socket.io', window.location.href).pathname;
  socket = window.io({ path: socketPath, transports: ['websocket', 'polling'], autoConnect: true });
  socket.on('connect', () => {
    setConnection('已连接 · 可以开桌', 'good');
    resumeRoom();
  });
  socket.on('disconnect', (reason) => setConnection(`连接中断 · ${reason || '等待重连'}`, 'bad'));
  socket.on('connect_error', (error) => setConnection(`连接失败 · ${error?.message || '服务器未响应'}`, 'bad'));
  socket.on('state', renderState);
  socket.on('room:error', (error) => showToast(errorText(error)));
  socket.on('action:error', (error) => showToast(errorText(error)));
}

function setupUi() {
  $('profile-name').value = profile.name;
  $('profile-gender').value = profile.gender;
  $('profile-skin').value = String(profile.skin);
  updateSkinOptions();
  setEntryMode(entryMode);
  $('create-tab').addEventListener('click', () => setEntryMode('create'));
  $('join-tab').addEventListener('click', () => setEntryMode('join'));
  $('entry-form').addEventListener('submit', enterRoom);
  $('profile-gender').addEventListener('change', updateSkinOptions);
  $('rules-button').addEventListener('click', () => showDialog($('rules-dialog')));
  $('rules-dialog').addEventListener('click', (event) => { if (event.target === $('rules-dialog')) closeDialog($('rules-dialog')); });
  $('settings-button').addEventListener('click', () => openSettings(selectedAiSeat));
  $('settings-close').addEventListener('click', () => closeDialog($('settings-dialog')));
  $('sound-toggle').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    $('sound-toggle').setAttribute('aria-pressed', String(soundEnabled));
    $('sound-toggle').setAttribute('aria-label', soundEnabled ? '关闭音效' : '开启音效');
    $('sound-toggle').title = soundEnabled ? '关闭音效' : '开启音效';
    if (soundEnabled) { maybeStartAudio(); tone(660, 0.06); }
  });
  $('copy-room-button').addEventListener('click', async () => {
    const code = currentState?.code;
    if (!code) return;
    const link = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(code)}`;
    try { await navigator.clipboard.writeText(link); showToast('房间链接已复制。'); }
    catch { showToast(`房间号：${code}`); }
  });
  $('room-collapse-button').addEventListener('click', () => setRoomPanelCollapsed(true));
  $('room-toggle-button').addEventListener('click', () => setRoomPanelCollapsed(false));
  $('start-button').addEventListener('click', async () => {
    const ack = await sendAction('start');
    if (!ack.ok) showToast(errorText(ack.error));
    else tone(520, 0.12);
  });
  $('leave-button').addEventListener('click', leaveRoom);
  $('restart-button').addEventListener('click', restartRoom);
  $('hand-list').addEventListener('contextmenu', (event) => event.preventDefault());
  $('play-button').addEventListener('click', playCards);
  $('challenge-button').addEventListener('click', challenge);
  $('trigger-button').addEventListener('click', pullTrigger);
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError('settings-error', '');
    const player = playerAt(selectedAiSeat);
    if (player?.kind !== 'ai') { setFormError('settings-error', '先把该席位设为 AI。'); return; }
    const payload = aiPayload();
    if (!payload.baseUrl || !payload.model) { setFormError('settings-error', 'Base URL 和模型名都要填写。'); return; }
    const ack = await configureAiSeat(selectedAiSeat, payload);
    if (!ack.ok) { setFormError('settings-error', errorText(ack.error)); return; }
    closeDialog($('settings-dialog'));
    showToast(`第 ${selectedAiSeat + 1} 席 AI 配置已保存。`);
  });
  $('apply-ai-button').addEventListener('click', async () => {
    const payload = aiPayload();
    if (!payload.baseUrl || !payload.model) { setFormError('settings-error', 'Base URL 和模型名都要填写。'); return; }
    const seats = (currentState?.players || []).filter((player) => player.kind === 'ai' && player.seatIndex !== selectedAiSeat).map((player) => player.seatIndex);
    if (!seats.length) { showToast('没有其他 AI 席位。'); return; }
    const results = await Promise.all(seats.map((seatIndex) => configureAiSeat(seatIndex, payload)));
    const failed = results.find((ack) => !ack.ok);
    if (failed) setFormError('settings-error', errorText(failed.error));
    else showToast(`已应用到 ${seats.length} 个 AI 席位。`);
  });
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (event.key >= '1' && event.key <= '5') {
      const card = currentState?.hand?.[Number(event.key) - 1];
      if (card) { event.preventDefault(); toggleCard(card.id); }
    } else if (event.key === 'Enter') {
      if (!$('play-button').disabled) { event.preventDefault(); playCards(); }
    } else if (event.key.toLowerCase() === 'x') {
      if (!$('challenge-button').disabled) { event.preventDefault(); challenge(); }
    } else if (event.code === 'Space') {
      if (!$('trigger-button').disabled) { event.preventDefault(); pullTrigger(); }
    }
  });
}

async function setupScene() {
  try {
    const module = await import('./scene.js');
    tavernScene = new module.TavernScene($('scene-root'), { onError: (error) => setConnection(`3D桌面异常 · ${error.message}`, 'bad') });
    if (currentState) tavernScene.setState(currentState);
  } catch (error) {
    console.error(error);
    setConnection('3D 桌面加载失败 · 仍可使用房间面板', 'bad');
    $('scene-root').classList.add('scene-failed');
  }
}

setupUi();
setupSocket();
setupScene();
