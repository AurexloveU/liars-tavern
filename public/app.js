import { MODEL_PRESETS, modelPreset } from './model-presets.js';
import { setupBackgroundMusic } from './music.js';
import { createCardCallouts } from './card-callouts.js?v=gold-claims-1';

const $ = (id) => document.getElementById(id);

const PREFS_KEY = 'liars-tavern:prefs';
let modelPlayers = MODEL_PRESETS.map((preset) => ({ ...preset, name: preset.label }));
let speechTimer = null;
let chatSending = false;
let chatListRequest = 0;
let chatReadRequest = 0;
let chatSignature = '';
const savedPrefs = readStorage(PREFS_KEY) || {};
const SOUND_PREFS_KEY = 'liars-tavern:sound';
const savedSoundPrefs = readStorage(SOUND_PREFS_KEY) || {};

let socket = null;
let tavernScene = null;
let currentState = null;
let selectedCards = new Set();
let selectedAiSeat = 1;
let lastShotId = null;
let toastTimer = null;
let audioContext = null;
let soundEnabled = savedSoundPrefs.enabled !== false;
let cardSoundVolume = Number.isFinite(savedSoundPrefs.cardSoundVolume) ? Math.max(0, Math.min(1, savedSoundPrefs.cardSoundVolume)) : 0.5;
let cardCallouts = null;
let profile = {
  name: savedPrefs.name || 'Aurex',
  gender: savedPrefs.gender === 'female' ? 'female' : 'male',
  skin: Number.isInteger(savedPrefs.skin) ? savedPrefs.skin : 0,
};

function readStorage(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
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
  const labels = female ? ['紫色长袖', '墨绿长袖'] : ['墨蓝外套', '酒红马甲'];
  const previous = select.value;
  select.replaceChildren(...labels.map((label, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = label;
    return option;
  }));
  select.value = labels[Number(previous)] ? previous : '0';
}

function sendAction(type, payload = {}) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) {
      resolve({ ok: false, error: '本机牌局服务尚未连接。' });
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

function saveSoundSettings() {
  writeStorage(SOUND_PREFS_KEY, { enabled: soundEnabled, cardSoundVolume });
}

function renderSoundToggle() {
  const label = soundEnabled ? '关闭音效' : '开启音效';
  $('sound-toggle').setAttribute('aria-pressed', String(soundEnabled));
  $('sound-toggle').setAttribute('aria-label', label);
  $('sound-toggle').title = label;
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

function aiSeatLabel(ai) {
  return ai?.protocol === 'codex' ? (modelPreset(ai.model)?.label || 'Codex') : (ai?.model || '待配置');
}

function rankLabel(rank) {
  return rank === 'JOKER' ? '★' : (rank || '—');
}

function cardArtClass(rank) {
  const key = rank === 'JOKER' ? 'joker' : String(rank || '').toLowerCase();
  return ['a', 'k', 'q', 'joker'].includes(key) ? `card-art-${key}` : 'card-art-fallback';
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

function renderSelfStatus() {
  const state = currentState;
  const me = playerAt(state?.selfSeat);
  const panel = $('self-status');
  panel.hidden = !me || state.phase === 'lobby';
  if (panel.hidden) return;
  const dead = me.alive === false;
  panel.classList.toggle('is-dead', dead);
  $('self-life-label').textContent = dead ? '你：已出局' : '你：存活';
  const shots = Number(me.shots) || 0;
  const risk = Number(me.nextRisk) >= 1 ? '100%' : riskLabel(me.nextRisk);
  $('self-risk-label').textContent = dead
    ? `空枪 ${shots} · 本局淘汰`
    : `空枪 ${shots} · 下枪风险 ${risk}`;
  panel.title = dead ? `本局已淘汰，此前响过 ${shots} 次空枪` : `已响空枪 ${shots} 次；下一枪死亡概率 ${risk}`;
}

function renderSeatHud() {
  const hud = $('seat-hud');
  const state = currentState;
  hud.replaceChildren();
  clearTimeout(speechTimer);
  let nextSpeechExpiry = Infinity;
  const inSolo = Boolean(state?.soloMode || state?.singleplayer);
  if (!inSolo || state.phase === 'lobby') {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;
  const selfSeat = Number.isInteger(state.selfSeat) ? state.selfSeat : 0;
  const isHost = Boolean(state.soloMode || state.singleplayer || state.isHost || state.hostSeat === state.selfSeat);
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
    kind.textContent = `${relativeNames[relative]}${player.seatIndex === state.selfSeat ? ' · 自己' : ''} · ${player.kind === 'ai' ? `AI · ${aiSeatLabel(player.ai)}` : '真人'}`;
    const stats = document.createElement('span');
    stats.className = 'seat-badge-stats';
    stats.textContent = player.alive === false
      ? `手牌 0 · 空枪 ${player.shots || 0}/6 · 已淘汰`
      : `手牌 ${player.handCount || 0} · 轮盘 ${player.shots || 0}/6 · 下一次 ${riskLabel(player.nextRisk)}`;
    badge.append(name, kind, stats);
    const remaining = (player.speech?.createdAt || 0) + 8000 - Date.now();
    if (player.speech?.text && remaining > 0) {
      const bubble = document.createElement('span');
      bubble.className = 'seat-speech';
      bubble.textContent = player.speech.text;
      bubble.setAttribute('role', 'status');
      badge.append(bubble);
      nextSpeechExpiry = Math.min(nextSpeechExpiry, remaining);
    }
    if (player.ai?.error) {
      const error = document.createElement('span');
      error.className = 'seat-badge-error';
      error.textContent = player.ai.error;
      badge.append(error);
      if (isHost) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'subtle-button seat-retry';
        retry.textContent = player.ai?.protocol === 'codex' ? '重试 Codex' : '重试 AI';
        retry.addEventListener('click', async () => {
          const ack = await sendAction('retryAI', { seatIndex: player.seatIndex });
          if (!ack.ok) showToast(errorText(ack.error));
        });
        badge.append(retry);
      }
    }
    hud.append(badge);
  }
  if (Number.isFinite(nextSpeechExpiry)) speechTimer = setTimeout(renderSeatHud, nextSpeechExpiry + 30);
}

function renderPlayerRecords(records) {
  const body = $('records-body');
  body.replaceChildren();
  const players = records.players || [];
  $('records-empty').hidden = players.length > 0;
  $('records-error').textContent = records.error || '';
  $('records-error').hidden = !records.error;
  if (records.trackingSince) $('records-note').textContent = `从 ${new Date(records.trackingSince).toLocaleDateString()} 开始记录。未结束牌局仅记参与，胜率按已结算牌局计算。`;
  for (const player of players) {
    const row = document.createElement('tr');
    const label = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = player.name;
    const model = document.createElement('small');
    model.textContent = player.model;
    label.append(name, model);
    row.append(label);
    for (const value of [player.joined, player.played, player.wins, player.losses, player.winRate == null ? '—' : `${player.winRate}%`]) {
      const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
    }
    body.append(row);
  }
}

async function loadPlayerRecords() {
  try {
    const response = await fetch('./api/player-records', { cache: 'no-store' });
    if (!response.ok) throw new Error('records unavailable');
    renderPlayerRecords(await response.json());
  } catch { $('records-error').textContent = '战绩暂未加载，请稍后刷新。'; $('records-error').hidden = false; }
}

function renderAiSeatPicker() {
  const picker = $('ai-seat-picker');
  picker.replaceChildren();
  for (let seatIndex = 0; seatIndex < 4; seatIndex += 1) {
    const player = playerAt(seatIndex);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ai-seat-button${seatIndex === selectedAiSeat ? ' is-active' : ''}`;
    button.textContent = `${player?.name || `第 ${seatIndex + 1} 席`} · ${player?.kind === 'ai' ? aiSeatLabel(player.ai) : kindLabel(player?.kind || 'open')}`;
    button.disabled = player?.kind !== 'ai';
    button.addEventListener('click', () => { selectedAiSeat = seatIndex; renderAiSeatPicker(); fillAiSettings(); });
    picker.append(button);
  }
}

function syncCodexSettings() {
  const option = $('ai-protocol-codex');
  const protocol = $('ai-protocol');
  if (!option || !protocol) return;
  const available = currentState?.codexAvailable === true;
  option.hidden = !available;
  option.disabled = !available;
  if (!available && protocol.value === 'codex') protocol.value = 'chat';
  const isCodex = available && protocol.value === 'codex';
  const baseField = $('ai-base-url-field');
  const keyField = $('ai-key-field');
  const clearKeyField = $('ai-clear-key-field');
  const model = $('ai-model');
  $('ai-base-url').disabled = isCodex;
  $('ai-key').disabled = isCodex;
  $('ai-clear-key').disabled = isCodex;
  $('ai-max-output').disabled = isCodex;
  $('ai-max-output-field').hidden = isCodex;
  model.disabled = isCodex;
  $('ai-model-field').hidden = isCodex;
  $('codex-preset-field').hidden = !isCodex;
  if (baseField) baseField.hidden = isCodex;
  if (keyField) keyField.hidden = isCodex;
  if (clearKeyField) clearKeyField.hidden = isCodex;
  $('codex-help').hidden = !isCodex;
  if (isCodex) model.value = modelPreset($('codex-preset').value)?.model || 'gpt-5.6-luna';
}

function fillAiSettings() {
  const player = playerAt(selectedAiSeat);
  const ai = player?.ai || {};
  const hostConfig = Array.isArray(currentState?.hostConfigs)
    ? currentState.hostConfigs.find((config) => config.seatIndex === selectedAiSeat) || {}
    : {};
  $('ai-base-url').value = hostConfig.baseUrl || ai.baseUrl || '';
  $('ai-model').value = hostConfig.model || ai.model || '';
  $('codex-preset').value = modelPreset(hostConfig.model || ai.model)?.id || 'luna';
  $('ai-protocol').value = hostConfig.protocol || ai.protocol || 'chat';
  $('ai-max-output').value = String(hostConfig.maxOutputTokens ?? ai.maxOutputTokens ?? 4096);
  $('ai-key').value = '';
  $('ai-clear-key').checked = false;
  $('ai-persona').value = hostConfig.persona || '';
  syncCodexSettings();
  setFormError('settings-error', '');
}

function renderChatControls() {
  const state = currentState;
  const eligible = state && state.soloMode && state.phase !== 'lobby' && playerAt(state.selfSeat)?.kind === 'human';
  $('chat-form').hidden = !eligible;
  document.body.classList.toggle('has-chat', Boolean(eligible));
  $('chat-send').disabled = !socket?.connected || chatSending || !$('chat-input').value.trim();
  $('chat-count').textContent = `${Array.from($('chat-input').value).length} / 200`;
  const error = state?.chatArchiveError;
  $('chat-save-status').textContent = error || (chatSending ? '发送中……' : '本局聊天自动保存');
  $('chat-save-status').classList.toggle('form-error', Boolean(error));
}

async function sendSpeech(event) {
  event.preventDefault();
  const input = $('chat-input');
  const draft = input.value;
  if (chatSending || !draft.trim()) return;
  chatSending = true;
  renderChatControls();
  const ack = await sendAction('speak', { text: draft });
  chatSending = false;
  if (ack.ok) {
    if (input.value === draft) input.value = '';
  } else showToast(errorText(ack.error));
  renderChatControls();
  input.focus();
}

function selectSettingsTab(name) {
  for (const tab of document.querySelectorAll('[data-settings-tab]')) {
    const active = tab.dataset.settingsTab === name;
    tab.setAttribute('aria-selected', String(active));
    $(`settings-${tab.dataset.settingsTab}-panel`).hidden = !active;
  }
  if (name === 'records') void loadPlayerRecords();
  if (name === 'chat') void loadChatMatches();
}

async function loadChatMatches() {
  const request = ++chatListRequest;
  try {
    const response = await fetch('./api/chat-history', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '聊天存档读取失败');
    if (request !== chatListRequest) return;
    const select = $('chat-match-select');
    const selected = select.value || currentState?.matchId;
    select.replaceChildren(...data.matches.map((match) => {
      const option = document.createElement('option');
      option.value = match.matchId;
      const status = { playing: '进行中', ended: '已结束', abandoned: '中途离开' }[match.status] || '';
      option.textContent = `${new Date(match.startedAt).toLocaleString('zh-CN', { hour12: false })} · ${status} · ${match.messageCount} 条${match.matchId === currentState?.matchId ? '（当前局）' : ''}`;
      return option;
    }));
    if (data.matches.some((match) => match.matchId === selected)) select.value = selected;
    setFormError('chat-history-error', data.error || '');
    await loadChatMessages();
  } catch (error) {
    if (request === chatListRequest) setFormError('chat-history-error', errorText(error));
  }
}

async function loadChatMessages() {
  const request = ++chatReadRequest;
  const id = $('chat-match-select').value;
  const list = $('chat-messages');
  $('chat-download').hidden = true;
  list.replaceChildren();
  $('chat-history-note').textContent = '';
  if (!id) { list.textContent = '还没有聊天记录。开始牌局后自动保存。'; return; }
  list.textContent = '读取中……';
  try {
    const response = await fetch(`./api/chat-history/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const archive = await response.json();
    if (!response.ok) throw new Error(archive.error || '聊天存档读取失败');
    if (request !== chatReadRequest) return;
    $('chat-history-note').textContent = `${archive.players.map((p) => p.name).join(' / ')}${archive.partial ? ' · 本局早期发言未完整保存' : ''}`;
    list.replaceChildren(...archive.messages.map((message) => {
      const row = document.createElement('div');
      row.className = `chat-message${message.kind === 'human' ? ' is-human' : ''}`;
      const header = document.createElement('small');
      header.textContent = `${message.name} · ${new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}${message.round ? ` · 第 ${message.round} 轮` : ''}`;
      const text = document.createElement('p');
      text.textContent = message.text;
      row.append(header, text);
      return row;
    }));
    if (!archive.messages.length) list.textContent = '这一局还没有人发言。';
    list.scrollTop = list.scrollHeight;
    $('chat-download').href = `./api/chat-history/${encodeURIComponent(id)}/download`;
    $('chat-download').hidden = false;
  } catch (error) {
    if (request === chatReadRequest) { list.textContent = ''; setFormError('chat-history-error', errorText(error)); }
  }
}

function openSettings(seatIndex = selectedAiSeat) {
  selectedAiSeat = seatIndex;
  renderAiSeatPicker();
  fillAiSettings();
  showDialog($('settings-dialog'));
  void loadPlayerRecords();
  if (!$('settings-chat-panel').hidden) void loadChatMatches();
}

function aiPayload() {
  const maxOutputTokens = Math.max(256, Math.min(32768, Number($('ai-max-output').value) || 4096));
  const protocol = $('ai-protocol').value;
  const isCodex = protocol === 'codex';
  return {
    baseUrl: isCodex ? '' : $('ai-base-url').value.trim(),
    model: isCodex ? modelPreset($('codex-preset').value).model : $('ai-model').value.trim(),
    protocol,
    maxOutputTokens,
    apiKey: isCodex ? '' : $('ai-key').value,
    clearKey: isCodex ? false : $('ai-clear-key').checked,
    persona: $('ai-persona').value.trim(),
  };
}

function aiPayloadError(payload) {
  if (payload.protocol === 'codex') return currentState?.codexAvailable === true ? '' : '本机 Codex 当前不可用。';
  if (!payload.baseUrl || !payload.model) return 'Base URL 和模型名都要填写。';
  return '';
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
    button.className = `hand-card card-face ${cardArtClass(card.rank)}${selectedCards.has(card.id) ? ' is-selected' : ''}${card.rank === 'JOKER' ? ' is-joker' : ''}`;
    button.dataset.rank = card.rank || '';
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
  const paused = Boolean(currentState?.soloPaused ?? currentState?.paused);
  return { me, alive, ownTurn, paused };
}

function renderActionState() {
  const state = currentState;
  const { alive, ownTurn, paused } = actionContext();
  const phase = state?.phase;
  const canChooseCards = Boolean(state && !paused && phase === 'playing' && alive && ownTurn && !state.mustChallenge && state.hand?.length);
  const canPlay = canChooseCards && selectedCards.size >= 1 && selectedCards.size <= 3;
  const canChallenge = Boolean(state && !paused && phase === 'playing' && alive && ownTurn && state.lastPlay);
  const canTrigger = Boolean(state && !paused && phase === 'roulette' && alive && state.loserSeat === state.selfSeat && !state.lastShot);
  $('play-button').disabled = !canChooseCards;
  $('challenge-button').disabled = !canChallenge;
  $('trigger-button').disabled = !canTrigger;
  const acceptingPreviousPlay = canChooseCards && Boolean(state.lastPlay);
  $('play-button-label').textContent = acceptingPreviousPlay
    ? (selectedCards.size ? `不质疑，出这 ${selectedCards.size} 张` : '不质疑，选牌')
    : (selectedCards.size ? `出这 ${selectedCards.size} 张` : '选择手牌');
  $('must-challenge').hidden = !state?.mustChallenge;
  const handsRemaining = state?.players?.filter((player) => player.alive && player.handCount > 0).length ?? 0;
  const challengeReason = handsRemaining === 0
    ? '所有人都已出完手牌，这一手必须质疑后结算。'
    : '其他存活玩家都已出完手牌，这一手必须质疑后结算。';
  $('must-challenge').textContent = challengeReason;
  let help = '等待你的回合……';
  if (!state) help = '开始单机牌局后，手牌会出现在这里。';
  else if (!alive) help = '你已出局，可以继续旁观桌边记录。';
  else if (paused) help = '牌局已暂停；点击右上角“继续”恢复。';
  else if (phase === 'roulette') help = state.lastShot ? (state.lastShot.fatal ? '枪响已处理，等待淘汰结算……' : '空响已处理，等待下一轮……') : (canTrigger ? '轮盘在你面前；扣下扳机。' : '等待轮盘结果……');
  else if (phase === 'playing' && state.mustChallenge && ownTurn) help = challengeReason;
  else if (phase === 'playing' && ownTurn) help = acceptingPreviousPlay
    ? (selectedCards.size ? `已选 ${selectedCards.size} 张；可以不质疑并出牌，也可以质疑上一手。` : '不质疑就选 1–3 张继续出牌；也可以直接质疑上一手。')
    : (selectedCards.size ? `已选 ${selectedCards.size} 张，可以出牌。` : '轮到你了，选 1–3 张牌。');
  else if (phase === 'playing') {
    const turnPlayer = state.players?.find((player) => player.seatIndex === state.turnSeat);
    if (turnPlayer?.ai?.error) help = `${turnPlayer.name || 'AI'} 的 Codex 回合失败；点击座位旁的“重试 Codex”。`;
    else if (turnPlayer?.ai?.thinking) help = `${turnPlayer.name || 'AI'} 正在思考……`;
    else help = `等待 ${turnPlayer?.name || '下一位'} 的 AI 回合……`;
  }
  $('action-help').textContent = help;
  $('play-button').title = canPlay ? '按 Enter 出牌' : (canChooseCards ? '点选 1–3 张手牌，再按此按钮出牌' : help);
  $('challenge-button').title = canChallenge ? '按 X 质疑' : help;
  $('trigger-button').title = canTrigger ? '按 Space 扣扳机' : help;
}

function renderSoloPauseButton() {
  const button = $('solo-pause-button');
  const state = currentState;
  const inSolo = Boolean(state?.soloMode || state?.singleplayer);
  const paused = Boolean(state?.soloPaused ?? state?.paused);
  const active = inSolo && state.phase !== 'lobby' && state.phase !== 'ended';
  button.hidden = !active;
  button.textContent = paused ? '继续' : '暂停';
  button.setAttribute('aria-label', paused ? '继续单机牌局' : '暂停单机牌局');
  button.title = paused ? '继续单机牌局' : '暂停单机牌局';
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
  const state = rawState?.state || rawState;
  if (!state || typeof state !== 'object') return;
  cardCallouts?.observe(state);
  currentState = state;
  renderChatControls();
  const nextChatSignature = `${state.matchId}:${state.events?.filter((event) => event.type === 'speech').map((event) => event.id).join(',')}:${state.phase}`;
  if (nextChatSignature !== chatSignature) {
    chatSignature = nextChatSignature;
    if ($('settings-dialog').open && !$('settings-chat-panel').hidden) void loadChatMatches();
  }
  syncCodexSettings();
  if (playerAt(selectedAiSeat)?.kind !== 'ai') selectedAiSeat = state.players?.find((player) => player.kind === 'ai')?.seatIndex ?? 1;
  if (state.playerRecords) renderPlayerRecords(state.playerRecords);
  const inSolo = Boolean(state.soloMode || state.singleplayer);
  const paused = Boolean(state.soloPaused ?? state.paused);
  if (socket?.connected) setConnection(inSolo ? (paused ? '已连接 · 单机牌局已暂停' : '已连接 · 本机牌局 · AI 通过网络') : '已连接 · 可以开始单机牌局', 'good');
  $('phase-chip').textContent = phaseLabel(state.phase);
  const inLobby = state.phase === 'lobby';
  const ended = state.phase === 'ended';
  const selfEliminated = state.phase !== 'lobby' && state.players?.find((player) => player.seatIndex === state.selfSeat)?.alive === false;
  $('lobby-panel').hidden = inSolo;
  $('table-inspector').hidden = !inSolo || inLobby;
  $('event-panel').hidden = !inSolo || inLobby;
  $('hand-panel').hidden = !inSolo || inLobby || !Number.isInteger(state.selfSeat) || selfEliminated;
  $('restart-button').hidden = !(ended || selfEliminated);
  renderSoloPauseButton();
  renderSeatHud();
  renderSelfStatus();
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

async function startSolo(event) {
  event.preventDefault();
  maybeStartAudio();
  setFormError('entry-error', '');
  const nextProfile = saveProfileFromForm();
  const submit = $('entry-form').querySelector('button[type="submit"]');
  submit.disabled = true;
  const ack = await sendAction('soloStart', nextProfile);
  submit.disabled = false;
  if (!ack.ok) {
    setFormError('entry-error', errorText(ack.error));
    return;
  }
  tone(660, 0.08);
  if (ack.state) renderState(ack.state);
  showToast('单机牌局已开始。');
}

async function resumeSolo() {
  const ack = await sendAction('soloResume');
  if (!ack.ok) {
    setConnection('已连接 · 可以开始单机牌局', 'good');
    return;
  }
  if (ack.state) renderState(ack.state);
}

async function playCards() {
  if (!currentState || $('play-button').disabled || selectedCards.size > 3) return;
  if (selectedCards.size === 0) {
    $('hand-list').querySelector('.hand-card')?.focus();
    showToast('点选 1–3 张手牌，再点击出牌。');
    return;
  }
  const ack = await sendAction('play', { cardIds: [...selectedCards] });
  if (!ack.ok) showToast(errorText(ack.error));
  else { selectedCards.clear(); }
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

async function toggleSoloPause() {
  const paused = Boolean(currentState?.soloPaused ?? currentState?.paused);
  const ack = await sendAction(paused ? 'soloContinue' : 'soloPause');
  if (!ack.ok) showToast(errorText(ack.error));
  else if (ack.state) renderState(ack.state);
}

async function restartSolo() {
  selectedCards.clear();
  const ack = await sendAction('soloStart', { ...profile });
  if (!ack.ok) showToast(errorText(ack.error));
  else {
    if (ack.state) renderState(ack.state);
    showToast('新单机牌局已开始。');
  }
}

function setupSocket() {
  if (typeof window.io !== 'function') {
    setConnection('等待联机组件……', 'bad');
    return;
  }
  const socketPath = new URL('./socket.io', window.location.href).pathname;
  socket = window.io({ path: socketPath, transports: ['websocket', 'polling'], autoConnect: true });
  socket.on('connect', () => {
    cardCallouts?.reset();
    setConnection('已连接 · 可以开始单机牌局', 'good');
    resumeSolo();
  });
  socket.on('disconnect', (reason) => {
    cardCallouts?.reset();
    setConnection(`连接中断 · ${reason || '等待重连'}`, 'bad');
    renderChatControls();
  });
  socket.on('connect_error', (error) => setConnection(`连接失败 · ${error?.message || '服务器未响应'}`, 'bad'));
  socket.on('state', renderState);
  socket.on('solo:error', (error) => showToast(errorText(error)));
  socket.on('action:error', (error) => showToast(errorText(error)));
}

function setupUi() {
  cardCallouts = createCardCallouts({
    overlay: $('card-play-callout'),
    getContext: () => { maybeStartAudio(); return audioContext; },
    isEnabled: () => soundEnabled,
    getVolume: () => cardSoundVolume,
    onError: showToast,
  });
  renderSoundToggle();
  $('card-sound-volume').value = String(Math.round(cardSoundVolume * 100));
  $('card-sound-volume-label').textContent = `${Math.round(cardSoundVolume * 100)}%`;
  $('card-sound-volume').addEventListener('input', () => {
    cardSoundVolume = Number($('card-sound-volume').value) / 100;
    $('card-sound-volume-label').textContent = `${Math.round(cardSoundVolume * 100)}%`;
    saveSoundSettings();
    cardCallouts.updateVolume();
  });
  document.addEventListener('pointerdown', maybeStartAudio);
  document.addEventListener('keydown', (event) => {
    if (!event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) maybeStartAudio();
  });
  setupBackgroundMusic({
    button: $('music-toggle'),
    volumeInput: $('music-volume'),
    volumeLabel: $('music-volume-label'),
    onError: showToast,
  });
  $('profile-name').value = profile.name;
  $('profile-gender').value = profile.gender;
  $('profile-skin').value = String(profile.skin);
  updateSkinOptions();
  $('entry-form').addEventListener('submit', startSolo);
  $('profile-gender').addEventListener('change', updateSkinOptions);
  $('rules-button').addEventListener('click', () => showDialog($('rules-dialog')));
  $('rules-dialog').addEventListener('click', (event) => { if (event.target === $('rules-dialog')) closeDialog($('rules-dialog')); });
  $('settings-button').addEventListener('click', () => openSettings(selectedAiSeat));
  $('settings-close').addEventListener('click', () => closeDialog($('settings-dialog')));
  $('ai-protocol').addEventListener('change', syncCodexSettings);
  $('codex-preset').addEventListener('change', syncCodexSettings);
  $('records-refresh').addEventListener('click', loadPlayerRecords);
  for (const tab of document.querySelectorAll('[data-settings-tab]')) {
    tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settingsTab));
  }
  $('chat-form').addEventListener('submit', sendSpeech);
  $('chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  const limitChatInput = (event) => {
    const input = $('chat-input');
    if (!event.isComposing && Array.from(input.value).length > 200) input.value = Array.from(input.value).slice(0, 200).join('');
    renderChatControls();
  };
  $('chat-input').addEventListener('input', limitChatInput);
  $('chat-input').addEventListener('compositionend', limitChatInput);
  $('chat-history-open').addEventListener('click', () => {
    openSettings();
    $('chat-match-select').value = currentState?.matchId || '';
    selectSettingsTab('chat');
  });
  $('chat-refresh').addEventListener('click', loadChatMatches);
  $('chat-match-select').addEventListener('change', loadChatMessages);
  fetch('./api/model-players', { cache: 'no-store' }).then((response) => response.json()).then((data) => {
    if (!Array.isArray(data.players)) return;
    modelPlayers = data.players;
    for (const option of $('codex-preset').options) {
      const player = modelPlayers.find((entry) => entry.id === option.value);
      if (player) option.textContent = player.label.startsWith(`${player.name} ·`) ? player.label : `${player.name} · ${player.label}`;
    }
  }).catch(() => {});
  $('solo-pause-button').addEventListener('click', toggleSoloPause);
  $('sound-toggle').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    saveSoundSettings();
    renderSoundToggle();
    if (!soundEnabled) cardCallouts.mute();
    if (soundEnabled) { maybeStartAudio(); tone(660, 0.06); }
  });
  $('restart-button').addEventListener('click', restartSolo);
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
    const payloadError = aiPayloadError(payload);
    if (payloadError) { setFormError('settings-error', payloadError); return; }
    const ack = await configureAiSeat(selectedAiSeat, payload);
    if (!ack.ok) { setFormError('settings-error', errorText(ack.error)); return; }
    closeDialog($('settings-dialog'));
    showToast(`第 ${selectedAiSeat + 1} 席 AI 配置已保存。`);
  });
  $('apply-ai-button').addEventListener('click', async () => {
    const payload = aiPayload();
    const payloadError = aiPayloadError(payload);
    if (payloadError) { setFormError('settings-error', payloadError); return; }
    const seats = (currentState?.players || []).filter((player) => player.kind === 'ai' && player.seatIndex !== selectedAiSeat).map((player) => player.seatIndex);
    if (!seats.length) { showToast('没有其他 AI 席位。'); return; }
    const results = await Promise.all(seats.map((seatIndex) => configureAiSeat(seatIndex, payload)));
    const failed = results.find((ack) => !ack.ok);
    if (failed) setFormError('settings-error', errorText(failed.error));
    else showToast(`已应用到 ${seats.length} 个 AI 席位。`);
  });
  document.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    const target = event.target;
    if (target?.closest?.('dialog[open]')) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (target?.isContentEditable) return;
    const focusedInteractive = target?.closest?.('button, a');
    if (focusedInteractive && !focusedInteractive.classList.contains('hand-card')) return;
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
    tavernScene = new module.TavernScene($('scene-root'), { onError: (error) => setConnection(`2D桌面异常 · ${error.message}`, 'bad') });
    if (currentState) tavernScene.setState(currentState);
  } catch (error) {
    console.error(error);
    setConnection('2D 桌面加载失败 · 仍可使用开始界面', 'bad');
    $('scene-root').classList.add('scene-failed');
  }
}

setupUi();
setupSocket();
setupScene();
