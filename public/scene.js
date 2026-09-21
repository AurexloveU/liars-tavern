const ASSET_PATHS = Object.freeze({
  table: './assets/art-v3/table.png',
  male0: './assets/art-v3/male-0.png',
  male1: './assets/art-v3/male-1.png',
  female0: './assets/art-v3/female-0.png',
  female1: './assets/art-v3/female-1.png',
  revolver: './assets/art-v3/revolver.png',
  blood: './assets/art-v3/blood.png',
  cardBack: './assets/art-v3/card-back.png',
  cardA: './assets/art-v3/card-a.png',
  cardK: './assets/art-v3/card-k.png',
  cardQ: './assets/art-v3/card-q.png',
  cardJoker: './assets/art-v3/card-joker.png',
});

const RELATIVE_SEATS = Object.freeze([
  { x: 0.5, y: 1, rotation: 0, gunRotation: -Math.PI / 2 },
  { x: 0, y: 0.5, rotation: Math.PI / 2, gunRotation: 0 },
  { x: 0.5, y: 0, rotation: Math.PI, gunRotation: Math.PI / 2 },
  { x: 1, y: 0.5, rotation: -Math.PI / 2, gunRotation: Math.PI },
]);

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundedPath(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function imageSize(image) {
  return {
    width: image?.naturalWidth || image?.width || 1,
    height: image?.naturalHeight || image?.height || 1,
  };
}

function containSize(image, maxWidth, maxHeight) {
  const source = imageSize(image);
  const scale = Math.min(maxWidth / source.width, maxHeight / source.height);
  return { width: source.width * scale, height: source.height * scale };
}

function loadImage(path) {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = new URL(path, import.meta.url).href;
  });
}

export class TavernScene {
  constructor(container, hooks = {}) {
    this.container = container;
    this.hooks = hooks;
    this.state = null;
    this.selfSeat = 0;
    this.effects = [];
    this.playAnimations = [];
    this.assets = new Map();
    this.assetsReady = false;
    this._errorReported = false;
    this._raf = 0;
    this._lastFrame = 0;
    this._hasSeenState = false;
    this._lastPlayKey = null;
    this._resizeObserver = null;
    this._boundResize = () => this.resize();

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tavern-canvas';
    this.canvas.setAttribute('aria-label', '骗子酒馆二维桌面');
    this.context = this.canvas.getContext('2d', { alpha: false });
    if (!this.context) this._reportError(new Error('Canvas 2D 不可用'));
    this.renderer = { domElement: this.canvas, dispose: () => {} };
    container.replaceChildren(this.canvas);

    this.viewport = { width: 1, height: 1, dpr: 1 };
    this.resize();
    window.addEventListener('resize', this._boundResize, { passive: true });
    if ('ResizeObserver' in window) {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.canvas);
    }
    this._loadAssets();
    this.animate();
  }

  _reportError(error) {
    if (this._errorReported) return;
    this._errorReported = true;
    try {
      this.hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Rendering continues even if the status reporter fails.
    }
  }

  async _loadAssets() {
    const entries = Object.entries(ASSET_PATHS);
    const loaded = await Promise.all(entries.map(async ([key, path]) => [key, await loadImage(path)]));
    const missing = [];
    for (const [key, image] of loaded) {
      if (image) this.assets.set(key, image);
      else missing.push(key);
    }
    this.assetsReady = true;
    if (missing.length) this._reportError(new Error(`2D资源未加载：${missing.join('、')}`));
    this.draw();
  }

  asset(key) {
    return this.assets.get(key) || null;
  }

  resize() {
    if (!this.canvas || !this.context) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || this.container.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(rect.height || this.container.clientHeight || window.innerHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewport = { width, height, dpr };
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setState(state) {
    const nextState = state || null;
    const nextPlayKey = this.lastPlayKey(nextState);
    if (nextState && this._hasSeenState && nextPlayKey && nextPlayKey !== this._lastPlayKey) {
      this.startPlayAnimation(nextState.lastPlay);
    }
    this.state = nextState;
    if (Number.isInteger(nextState?.selfSeat) && nextState.selfSeat >= 0 && nextState.selfSeat < 4) {
      this.selfSeat = nextState.selfSeat;
    }
    if (nextState) {
      this._hasSeenState = true;
      this._lastPlayKey = nextPlayKey;
    } else {
      this._hasSeenState = false;
      this._lastPlayKey = null;
    }
    this.draw();
  }

  lastPlayKey(state) {
    const play = state?.lastPlay;
    if (!play || !Number.isInteger(play.seatIndex)) return null;
    return `${state.round ?? ''}:${play.seatIndex}:${Number(play.count) || 0}`;
  }

  relativeSeat(seatIndex) {
    return (seatIndex - this.selfSeat + 4) % 4;
  }

  drawTable() {
    const context = this.context;
    const { width, height } = this.viewport;
    const x = width * 0.025;
    const y = height * 0.025;
    const tableWidth = width * 0.95;
    const tableHeight = height * 0.95;
    const table = this.asset('table');
    if (table) {
      const source = imageSize(table);
      const targetAspect = tableWidth / tableHeight;
      const sourceAspect = source.width / source.height;
      let sourceWidth = source.width;
      let sourceHeight = source.height;
      let sourceX = 0;
      let sourceY = 0;
      if (sourceAspect > targetAspect) {
        sourceWidth = source.height * targetAspect;
        sourceX = (source.width - sourceWidth) / 2;
      } else {
        sourceHeight = source.width / targetAspect;
        sourceY = (source.height - sourceHeight) / 2;
      }
      context.drawImage(table, sourceX, sourceY, sourceWidth, sourceHeight, x, y, tableWidth, tableHeight);
      if (width < height) this.drawPortraitTableFrame(table, x, y, tableWidth, tableHeight);
      return;
    }

    // Quiet 2D fallback while generated assets load; artwork is the normal path.
    context.fillStyle = '#241b16';
    context.fillRect(0, 0, width, height);
    roundedPath(context, x, y, tableWidth, tableHeight, Math.min(tableWidth, tableHeight) * 0.1);
    context.fillStyle = '#684326';
    context.fill();
    roundedPath(context, x + tableWidth * 0.035, y + tableHeight * 0.035, tableWidth * 0.93, tableHeight * 0.93, Math.min(tableWidth, tableHeight) * 0.085);
    context.fillStyle = '#123b35';
    context.fill();
    context.strokeStyle = '#c6964d';
    context.lineWidth = Math.max(1, Math.min(width, height) * 0.004);
    context.stroke();
  }

  drawPortraitTableFrame(table, x, y, tableWidth, tableHeight) {
    const context = this.context;
    const source = imageSize(table);
    const sourceBorderX = Math.max(1, Math.round(source.width * 0.16));
    const sourceBorderY = Math.max(1, Math.round(source.height * 0.16));
    const sourceCenterWidth = Math.max(1, source.width - sourceBorderX * 2);
    const sourceCenterHeight = Math.max(1, source.height - sourceBorderY * 2);
    const destinationBorder = clamp(Math.min(tableWidth, tableHeight) * 0.1, 18, 42);
    const centerWidth = Math.max(1, tableWidth - destinationBorder * 2);
    const centerHeight = Math.max(1, tableHeight - destinationBorder * 2);

    // The cover pass keeps the artwork's center composition. These eight slices
    // restore the original wood edge without stretching the middle artwork.
    context.drawImage(table, 0, 0, sourceBorderX, sourceBorderY, x, y, destinationBorder, destinationBorder);
    context.drawImage(table, sourceBorderX, 0, sourceCenterWidth, sourceBorderY, x + destinationBorder, y, centerWidth, destinationBorder);
    context.drawImage(table, source.width - sourceBorderX, 0, sourceBorderX, sourceBorderY, x + tableWidth - destinationBorder, y, destinationBorder, destinationBorder);
    context.drawImage(table, 0, sourceBorderY, sourceBorderX, sourceCenterHeight, x, y + destinationBorder, destinationBorder, centerHeight);
    context.drawImage(table, source.width - sourceBorderX, sourceBorderY, sourceBorderX, sourceCenterHeight, x + tableWidth - destinationBorder, y + destinationBorder, destinationBorder, centerHeight);
    context.drawImage(table, 0, source.height - sourceBorderY, sourceBorderX, sourceBorderY, x, y + tableHeight - destinationBorder, destinationBorder, destinationBorder);
    context.drawImage(table, sourceBorderX, source.height - sourceBorderY, sourceCenterWidth, sourceBorderY, x + destinationBorder, y + tableHeight - destinationBorder, centerWidth, destinationBorder);
    context.drawImage(table, source.width - sourceBorderX, source.height - sourceBorderY, sourceBorderX, sourceBorderY, x + tableWidth - destinationBorder, y + tableHeight - destinationBorder, destinationBorder, destinationBorder);
  }

  seatPoint(relative, margin = 0.055) {
    const { width, height } = this.viewport;
    const edgeX = width * margin;
    const edgeY = height * margin;
    const point = [
      { x: width * 0.5, y: height - edgeY },
      { x: edgeX, y: height * 0.5 },
      { x: width * 0.5, y: edgeY },
      { x: width - edgeX, y: height * 0.5 },
    ][relative];
    if (width >= height || (relative !== 0 && relative !== 2)) return point;

    const canvasRect = this.canvas?.getBoundingClientRect?.();
    if (!canvasRect) return point;
    const visibleBottom = (id) => {
      const element = document.getElementById(id);
      if (!element || element.hidden) return null;
      const rect = element.getBoundingClientRect();
      return rect.height > 0 ? rect.bottom - canvasRect.top : null;
    };

    if (relative === 0) {
      const handTop = (() => {
        const element = document.getElementById('hand-panel');
        if (!element || element.hidden) return null;
        const rect = element.getBoundingClientRect();
        return rect.height > 0 ? rect.top - canvasRect.top : null;
      })();
      if (Number.isFinite(handTop)) {
        const anchor = handTop - 8;
        point.y = clamp(anchor - (margin - 0.02) * height, edgeY, height - edgeY);
      }
    } else {
      const overlayBottoms = ['seat-hud', 'table-inspector']
        .map(visibleBottom)
        .filter((value) => Number.isFinite(value));
      if (overlayBottoms.length) {
        const anchor = Math.max(...overlayBottoms) + 8;
        point.y = clamp(anchor + (margin - 0.02) * height, edgeY, height - edgeY);
      }
    }
    return point;
  }

  characterSize() {
    const { width, height } = this.viewport;
    return clamp(Math.min(width * 0.48, height * 0.42), 160, 310);
  }

  drawCharacter(player) {
    const relative = this.relativeSeat(player.seatIndex);
    const layout = RELATIVE_SEATS[relative];
    const image = this.asset(`${player.gender === 'female' ? 'female' : 'male'}${Number(player.skin) === 1 ? '1' : '0'}`);
    if (!image) return;
    const longSide = this.characterSize();
    const point = this.seatPoint(relative, 0.02);
    const size = containSize(image, longSide * 0.86, longSide);
    this.context.save();
    this.context.translate(point.x, point.y);
    this.context.rotate(layout.rotation);
    this.context.globalAlpha = player.connected === false ? 0.5 : 1;
    this.context.drawImage(image, -size.width / 2, -size.height * 0.95, size.width, size.height);
    this.context.restore();
  }

  drawBlood(player, scale = 1) {
    const image = this.asset('blood');
    if (!image) return;
    const relative = this.relativeSeat(player.seatIndex);
    const point = this.seatPoint(relative, 0.06);
    const bloodSide = clamp(Math.min(this.viewport.width, this.viewport.height) * 0.19, 70, 150) * scale;
    const size = containSize(image, bloodSide, bloodSide);
    this.context.save();
    this.context.globalAlpha = 0.9;
    this.context.drawImage(image, point.x - size.width / 2, point.y - size.height / 2, size.width, size.height);
    this.context.restore();
  }

  drawCards(player) {
    const image = this.asset('cardBack');
    if (!image || player.alive === false) return;
    const relative = this.relativeSeat(player.seatIndex);
    const layout = RELATIVE_SEATS[relative];
    const count = clamp(Number(player.handCount) || 0, 0, 7);
    if (!count) return;
    const longSide = clamp(Math.min(this.viewport.width * 0.075, this.viewport.height * 0.15), 34, 76);
    const point = this.seatPoint(relative, 0.18);
    const gap = longSide * 0.24;
    const size = containSize(image, longSide * 0.64, longSide);
    for (let index = 0; index < count; index += 1) {
      const offset = (index - (count - 1) / 2) * gap;
      let x = point.x;
      let y = point.y;
      if (relative === 0 || relative === 2) x += offset;
      else y += offset;
      this.context.save();
      this.context.translate(x, y);
      this.context.rotate(layout.rotation);
      this.context.globalAlpha = 0.94;
      this.context.drawImage(image, -size.width / 2, -size.height / 2, size.width, size.height);
      this.context.restore();
    }
  }

  drawRevealCards() {
    const ranks = this.state?.reveal?.cards;
    if (!Array.isArray(ranks) || !ranks.length) return;
    const { width, height } = this.viewport;
    const cardHeight = clamp(Math.min(width * 0.18, height * 0.32), 78, 158);
    const gap = cardHeight * 0.18;
    const rankKey = { A: 'cardA', K: 'cardK', Q: 'cardQ', JOKER: 'cardJoker' };
    const rankText = (rank) => rank === 'JOKER' ? 'JOKER' : (rank || '—');
    const cards = ranks.slice(0, 3);
    cards.forEach((rank, index) => {
      const image = this.asset(rankKey[rank]);
      const centerX = width * 0.5 + (index - (cards.length - 1) / 2) * (cardHeight * 0.67 + gap);
      const centerY = height * 0.5;
      if (image) {
        const size = containSize(image, cardHeight * 0.67, cardHeight);
        this.context.save();
        this.context.drawImage(image, centerX - size.width / 2, centerY - size.height / 2, size.width, size.height);
        this.context.fillStyle = 'rgba(24, 17, 12, 0.82)';
        this.context.fillRect(centerX - size.width / 2 + 5, centerY - size.height / 2 + 5, Math.min(52, size.width * 0.45), 22);
        this.context.fillStyle = '#f6e8ca';
        this.context.font = `600 ${Math.max(12, Math.round(cardHeight * 0.12))}px Georgia, serif`;
        this.context.textAlign = 'left';
        this.context.textBaseline = 'top';
        this.context.fillText(rankText(rank), centerX - size.width / 2 + 9, centerY - size.height / 2 + 8);
        this.context.restore();
      } else {
        const cardWidth = cardHeight * 0.67;
        this.context.save();
        roundedPath(this.context, centerX - cardWidth / 2, centerY - cardHeight / 2, cardWidth, cardHeight, 8);
        this.context.fillStyle = '#eadfc6';
        this.context.fill();
        this.context.strokeStyle = '#755c41';
        this.context.stroke();
        this.context.fillStyle = '#30271f';
        this.context.font = `600 ${Math.max(16, Math.round(cardHeight * 0.2))}px Georgia, serif`;
        this.context.textAlign = 'center';
        this.context.textBaseline = 'middle';
        this.context.fillText(rankText(rank), centerX, centerY);
        this.context.restore();
      }
    });
  }

  drawPile() {
    const phase = this.state?.phase;
    const pileCount = clamp(Number(this.state?.pileCount) || 0, 0, 8);
    const image = this.asset('cardBack');
    if (!image || pileCount <= 0 || (phase !== 'playing' && phase !== 'roulette')) return;
    const { width, height } = this.viewport;
    const cardHeight = clamp(Math.min(width * 0.16, height * 0.14), 44, 78);
    const cardWidth = cardHeight * 0.68;
    const size = containSize(image, cardWidth, cardHeight);
    const centerX = width * 0.5;
    const centerY = height * 0.5;
    for (let index = 0; index < pileCount; index += 1) {
      const offsetX = (index % 3 - 1) * 2.2;
      const offsetY = index * 1.6;
      this.context.save();
      this.context.translate(centerX + offsetX, centerY + offsetY);
      this.context.rotate((index % 3 - 1) * 0.018);
      this.context.globalAlpha = 0.96;
      this.context.drawImage(image, -size.width / 2, -size.height / 2, size.width, size.height);
      this.context.restore();
    }
  }

  startPlayAnimation(play) {
    if (!play || !Number.isInteger(play.seatIndex)) return;
    const relative = this.relativeSeat(play.seatIndex);
    const from = this.seatPoint(relative, 0.18);
    this.playAnimations.push({
      from,
      seatIndex: play.seatIndex,
      count: clamp(Number(play.count) || 1, 1, 3),
      age: 0,
      duration: 0.35,
    });
  }

  drawPlayAnimations() {
    const image = this.asset('cardBack');
    if (!image || !this.playAnimations.length) return;
    const { width, height } = this.viewport;
    const cardHeight = clamp(Math.min(width * 0.16, height * 0.14), 44, 78);
    const size = containSize(image, cardHeight * 0.68, cardHeight);
    const target = { x: width * 0.5, y: height * 0.5 };
    for (const animation of this.playAnimations) {
      const progress = clamp(animation.age / animation.duration, 0, 1);
      const eased = 1 - (1 - progress) ** 3;
      const centerX = animation.from.x + (target.x - animation.from.x) * eased;
      const centerY = animation.from.y + (target.y - animation.from.y) * eased;
      for (let index = 0; index < animation.count; index += 1) {
        const offset = (index - (animation.count - 1) / 2) * 3;
        this.context.save();
        this.context.translate(centerX + offset, centerY + offset * 0.5);
        this.context.rotate((index - (animation.count - 1) / 2) * 0.025);
        this.context.globalAlpha = 1 - progress * 0.12;
        this.context.drawImage(image, -size.width / 2, -size.height / 2, size.width, size.height);
        this.context.restore();
      }
    }
  }

  drawGun(player) {
    const image = this.asset('revolver');
    if (!image || player.alive === false) return;
    const relative = this.relativeSeat(player.seatIndex);
    const layout = RELATIVE_SEATS[relative];
    const point = this.seatPoint(relative, 0.105);
    const longSide = clamp(Math.min(this.viewport.width * 0.11, this.viewport.height * 0.17), 38, 92);
    const size = containSize(image, longSide * 0.8, longSide);
    this.context.save();
    this.context.translate(point.x, point.y);
    this.context.rotate(layout.gunRotation);
    this.context.drawImage(image, -size.width / 2, -size.height / 2, size.width, size.height);
    this.context.restore();
  }

  drawEffects() {
    const context = this.context;
    for (const effect of this.effects) {
      const relative = this.relativeSeat(effect.seat);
      const point = this.seatPoint(relative, 0.105);
      const progress = clamp(effect.age / 1.6, 0, 1);
      if (effect.age < 0.16) {
        const intensity = 1 - effect.age / 0.16;
        context.save();
        context.translate(point.x, point.y);
        context.globalAlpha = intensity;
        context.fillStyle = effect.fatal ? '#ffc56d' : '#e8f0ef';
        context.beginPath();
        context.arc(0, 0, 8 + intensity * 18, 0, TAU);
        context.fill();
        context.strokeStyle = '#ffe1a0';
        context.lineWidth = 2;
        for (let ray = 0; ray < 8; ray += 1) {
          const angle = (ray / 8) * TAU;
          context.beginPath();
          context.moveTo(Math.cos(angle) * 8, Math.sin(angle) * 8);
          context.lineTo(Math.cos(angle) * (18 + intensity * 15), Math.sin(angle) * (18 + intensity * 15));
          context.stroke();
        }
        context.restore();
      }
      if (effect.age < 1.4) {
        context.save();
        context.translate(point.x, point.y - progress * 20);
        context.globalAlpha = Math.max(0, 0.45 - progress * 0.35);
        context.fillStyle = '#b7b3a7';
        context.beginPath();
        context.ellipse(0, 0, 13 + progress * 18, 8 + progress * 12, 0, 0, TAU);
        context.fill();
        context.restore();
      }
    }
  }

  draw() {
    if (!this.context) return;
    const { width, height, dpr } = this.viewport;
    const context = this.context;
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#1b1511';
    context.fillRect(0, 0, width, height);
    this.drawTable();

    const players = Array.isArray(this.state?.players) ? this.state.players : [];
    const inLobby = this.state?.phase === 'lobby';
    if (!inLobby) {
      for (const player of players) {
        if (player?.kind !== 'open' && player?.alive === false) this.drawBlood(player);
      }
    }
    for (const player of players) {
      if (!player || player.kind === 'open') continue;
      const alive = inLobby || player.alive !== false;
      if (alive) this.drawCharacter(player);
    }
    for (const player of players) {
      if (!player || player.kind === 'open' || inLobby) continue;
      this.drawCards(player);
    }
    this.drawPile();
    this.drawPlayAnimations();
    if (!inLobby && this.state?.phase === 'reveal') this.drawRevealCards();
    for (const player of players) {
      if (!player || player.kind === 'open' || inLobby) continue;
      this.drawGun(player);
    }
    this.drawEffects();
    context.restore();
  }

  playShot(shot) {
    if (!shot || !Number.isInteger(shot.seatIndex)) return;
    this.effects.push({ seat: shot.seatIndex, fatal: Boolean(shot.fatal), age: 0 });
    this.draw();
  }

  updateEffects(delta) {
    for (const effect of this.effects) effect.age += delta;
    this.effects = this.effects.filter((effect) => effect.age < 1.6);
    for (const animation of this.playAnimations) animation.age += delta;
    this.playAnimations = this.playAnimations.filter((animation) => animation.age < animation.duration);
  }

  animate() {
    this._raf = requestAnimationFrame((time) => {
      const previous = this._lastFrame || time;
      this._lastFrame = time;
      this.updateEffects(Math.min(0.05, Math.max(0, (time - previous) / 1000)));
      this.draw();
      this.animate();
    });
  }

  dispose() {
    window.removeEventListener('resize', this._boundResize);
    this._resizeObserver?.disconnect();
    cancelAnimationFrame(this._raf);
    this.renderer?.dispose?.();
    this.container?.replaceChildren();
  }
}
