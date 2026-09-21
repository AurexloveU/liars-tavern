const MUSIC_PREFS_KEY = 'liars-tavern:music';

export function setupBackgroundMusic({ button, volumeInput, volumeLabel, onError }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(MUSIC_PREFS_KEY) || '{}') || {}; } catch { /* default preferences */ }
  let enabled = saved.enabled === true;
  let volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : 0.22;
  let starting = false;
  let reportedError = false;
  const audio = new Audio(new URL('./assets/music/tavern-theme.mp3', import.meta.url).href);
  audio.loop = true;
  audio.preload = 'none';
  audio.volume = volume;

  const save = () => {
    try { localStorage.setItem(MUSIC_PREFS_KEY, JSON.stringify({ enabled, volume })); } catch { /* private mode */ }
  };
  const render = () => {
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? '关闭背景配乐' : '开启背景配乐');
    button.title = enabled ? '关闭背景配乐 · 音量可在设置中调节' : '开启背景配乐';
    volumeInput.value = String(Math.round(volume * 100));
    volumeLabel.textContent = `${Math.round(volume * 100)}%`;
  };
  const start = async () => {
    if (!enabled || document.hidden || !audio.paused || starting) return;
    starting = true;
    try {
      await audio.play();
      if (!enabled || document.hidden) audio.pause();
      reportedError = false;
    } catch (error) {
      // Browsers require a click after opening or refreshing the game.
      if (error.name !== 'NotAllowedError' && error.name !== 'AbortError' && !reportedError) {
        reportedError = true;
        onError?.('配乐暂未加载，点击“配乐”可重试。');
      }
    } finally { starting = false; }
  };

  button.addEventListener('click', () => {
    enabled = !enabled;
    save();
    render();
    if (enabled) { reportedError = false; void start(); }
    else audio.pause();
  });
  volumeInput.addEventListener('input', () => {
    volume = Math.max(0, Math.min(1, Number(volumeInput.value) / 100));
    audio.volume = volume;
    save();
    render();
    void start();
  });
  const startFromGesture = (event) => {
    if (event.type === 'keydown' && (event.repeat || event.metaKey || event.ctrlKey || event.altKey)) return;
    if (event.target?.closest?.('#music-toggle')) return;
    void start();
  };
  document.addEventListener('pointerdown', startFromGesture);
  document.addEventListener('keydown', startFromGesture);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.pause();
    else void start();
  });
  window.addEventListener('pagehide', () => audio.pause());
  render();
}
