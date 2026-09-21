// Show only the public claim; never inspect the actual cards played.
export function createCardCallouts({ overlay, getContext, isEnabled, getVolume, onError }) {
  let initialized = false;
  let lastKey = null;
  let generation = 0;
  let source = null;
  let gain = null;
  let bufferPromise = null;
  let reportedError = false;
  let hideTimer = null;
  let animation = null;
  const art = overlay.querySelector('.card-play-callout-art');
  const text = overlay.querySelector('.card-play-callout-text');

  function mute() {
    generation += 1;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* already ended */ }
      source.disconnect();
      source = null;
    }
    gain?.disconnect();
    gain = null;
  }

  function hide() {
    clearTimeout(hideTimer);
    animation?.cancel();
    animation = null;
    overlay.hidden = true;
    text.textContent = '';
  }

  function stop() { mute(); hide(); }

  function show(rank, count) {
    hide();
    const noun = { A: 'Ace', K: 'King', Q: 'Queen' }[rank];
    text.textContent = `${['One', 'Two', 'Three'][count - 1]} ${noun}${count > 1 ? 's' : ''}`;
    art.style.backgroundPosition = `${(count - 1) * 50}% ${['A', 'K', 'Q'].indexOf(rank) * 50}%`;
    overlay.hidden = false;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animation = art.animate([
        { opacity: 0, transform: 'translateY(7px)', offset: 0 },
        { opacity: 1, transform: 'translateY(0)', offset: 0.1 },
        { opacity: 1, transform: 'translateY(0)', offset: 0.75 },
        { opacity: 0, transform: 'translateY(-4px)', offset: 1 },
      ], { duration: 2300, easing: 'ease-out', fill: 'both' });
    }
    hideTimer = setTimeout(hide, 2300);
  }

  async function playSound() {
    mute();
    const ticket = generation;
    const context = getContext();
    if (!context || context.state !== 'running') return;
    try {
      if (!bufferPromise) {
        bufferPromise = fetch(new URL('./assets/audio/card-place-v1.wav', import.meta.url))
          .then((response) => {
            if (!response.ok) throw new Error('Card sound unavailable');
            return response.arrayBuffer();
          })
          .then((data) => context.decodeAudioData(data));
        bufferPromise.catch(() => { bufferPromise = null; });
      }
      const buffer = await bufferPromise;
      if (ticket !== generation || !isEnabled() || document.hidden) return;
      source = context.createBufferSource();
      gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = getVolume();
      source.connect(gain).connect(context.destination);
      const playing = source;
      const level = gain;
      playing.onended = () => {
        playing.disconnect();
        level.disconnect();
        if (source === playing) { source = null; gain = null; }
      };
      playing.start();
      reportedError = false;
    } catch {
      if (!reportedError && ticket === generation) {
        reportedError = true;
        onError?.('出牌音效暂未加载；牌局可以继续。');
      }
    }
  }

  function observe(state) {
    const lastPlay = state.lastPlay;
    const playEvent = [...(state.events || [])].reverse().find((event) => event.type === 'play');
    const key = lastPlay ? [state.round, state.targetRank, state.pileCount, lastPlay.seatIndex, lastPlay.count, playEvent?.id ?? ''].join(':') : null;
    if (!initialized) { initialized = true; lastKey = key; return; }
    const changed = key !== lastKey;
    lastKey = key;
    if (state.paused || state.soloPaused || state.phase === 'lobby' || state.phase === 'ended') { stop(); return; }
    if (!lastPlay) { stop(); return; }
    if (!changed || document.hidden) return;
    if (!['A', 'K', 'Q'].includes(state.targetRank) || ![1, 2, 3].includes(lastPlay.count)) return;
    show(state.targetRank, lastPlay.count);
    if (isEnabled()) void playSound();
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', stop);
  return {
    observe, stop, mute,
    reset() { stop(); initialized = false; lastKey = null; },
    updateVolume() { if (gain) gain.gain.value = getVolume(); },
  };
}
