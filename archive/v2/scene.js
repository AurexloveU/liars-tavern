import * as THREE from './vendor/three/three.module.js';

const TAU = Math.PI * 2;
const SEAT_RELATIVE_POSITIONS = [
  new THREE.Vector3(0, 0.2, 7.65),
  new THREE.Vector3(-7.65, 0.2, 0),
  new THREE.Vector3(0, 0.2, -7.65),
  new THREE.Vector3(7.65, 0.2, 0),
];
const SEAT_YAWS = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
const SKIN_TONES = [0xc98e6b, 0xe2ab86, 0x9b5f42, 0x6b3d2e];
const MALE_COATS = [0x1c2b39, 0x5b1e29];
const FEMALE_OUTFITS = [0x3d283f, 0x1e5556];
const BRASS = 0xc6964d;
const FELT = 0x123b35;

function material(color, roughness = 0.72, metalness = 0.05) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function roundedRectShape(width, depth, radius) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const corner = Math.min(radius, halfWidth, halfDepth);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + corner, -halfDepth);
  shape.lineTo(halfWidth - corner, -halfDepth);
  shape.quadraticCurveTo(halfWidth, -halfDepth, halfWidth, -halfDepth + corner);
  shape.lineTo(halfWidth, halfDepth - corner);
  shape.quadraticCurveTo(halfWidth, halfDepth, halfWidth - corner, halfDepth);
  shape.lineTo(-halfWidth + corner, halfDepth);
  shape.quadraticCurveTo(-halfWidth, halfDepth, -halfWidth, halfDepth - corner);
  shape.lineTo(-halfWidth, -halfDepth + corner);
  shape.quadraticCurveTo(-halfWidth, -halfDepth, -halfWidth + corner, -halfDepth);
  return shape;
}

function roundedRectGeometry(width, depth, radius, thickness, bevel = 0) {
  const geometry = new THREE.ExtrudeGeometry(roundedRectShape(width, depth, radius), {
    depth: thickness,
    curveSegments: 8,
    bevelEnabled: bevel > 0,
    bevelSegments: bevel > 0 ? 3 : 0,
    bevelSize: bevel,
    bevelThickness: bevel * 0.65,
  });
  geometry.translate(0, 0, -thickness / 2);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function roundedRectPoints(width, depth, radius, segments = 10) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const corner = Math.min(radius, halfWidth, halfDepth);
  const corners = [
    [halfWidth - corner, -halfDepth + corner, -Math.PI / 2],
    [halfWidth - corner, halfDepth - corner, 0],
    [-halfWidth + corner, halfDepth - corner, Math.PI / 2],
    [-halfWidth + corner, -halfDepth + corner, Math.PI],
  ];
  const points = [];
  for (const [x, z, start] of corners) {
    for (let index = 0; index <= segments; index += 1) {
      const angle = start + (Math.PI / 2) * (index / segments);
      points.push(new THREE.Vector3(x + Math.cos(angle) * corner, 0, z + Math.sin(angle) * corner));
    }
  }
  return points;
}

function segmentBetween(start, end, radius, mat) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.04, length, 10), mat);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function makeCardTexture(back, label = '') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (back) {
    ctx.fillStyle = '#1e3934';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#c79a52';
    ctx.lineWidth = 7;
    ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
    ctx.lineWidth = 2;
    ctx.strokeRect(23, 23, canvas.width - 46, canvas.height - 46);
    ctx.fillStyle = '#c79a52';
    ctx.font = 'bold 38px Georgia';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♠', canvas.width / 2, canvas.height / 2 - 24);
    ctx.font = 'bold 16px Georgia';
    ctx.fillText('LIAR\'S DECK', canvas.width / 2, canvas.height / 2 + 30);
  } else {
    ctx.fillStyle = '#eadfc6';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#755c41';
    ctx.lineWidth = 5;
    ctx.strokeRect(9, 9, canvas.width - 18, canvas.height - 18);
    ctx.fillStyle = '#30271f';
    ctx.font = 'bold 66px Georgia';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class TavernScene {
  constructor(container, hooks = {}) {
    this.container = container;
    this.hooks = hooks;
    this.state = null;
    this.selfSeat = 0;
    this.seatGroups = [];
    this.avatarGroups = [];
    this.gunGroups = [];
    this.bloodGroups = [];
    this.cardMeshes = [];
    this.effects = [];
    this.clock = new THREE.Clock();
    this.tableGroup = null;
    this.tableAspect = 1;
    this.isReady = false;
    this._resizeObserver = null;
    this._boundResize = () => this.resize();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x100f0e);
    this.camera = new THREE.OrthographicCamera(-9, 9, 9, -9, 0.1, 60);
    this.camera.position.set(0, 18, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'tavern-canvas';
    this.renderer.domElement.setAttribute('aria-label', '骗子酒馆三维桌面');
    container.replaceChildren(this.renderer.domElement);

    this.buildLights();
    this.buildRoom();
    this.buildTable();
    this.buildSeats();
    this.resize();
    this.isReady = true;
    window.addEventListener('resize', this._boundResize, { passive: true });
    if ('ResizeObserver' in window) {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      // Observe the actual canvas whose CSS box is used for both the renderer
      // and the orthographic projection. This keeps rotation/resizing from
      // leaving the drawing buffer and camera with different aspect ratios.
      this._resizeObserver.observe(this.renderer.domElement);
    }
    this.animate();
  }

  buildLights() {
    const ambient = new THREE.AmbientLight(0xffe3ba, 1.6);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffdca8, 2.5);
    key.position.set(1, 14, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -11;
    key.shadow.camera.right = 11;
    key.shadow.camera.top = 11;
    key.shadow.camera.bottom = -11;
    this.scene.add(key);
    const rim = new THREE.PointLight(0x688d83, 2.4, 22, 2);
    rim.position.set(-5, 4, -3);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xe9a15d, 1.8, 18, 2);
    warm.position.set(5, 5, 4);
    this.scene.add(warm);
  }

  buildRoom() {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), material(0x2a1d17, 0.98, 0));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.0;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const boards = new THREE.Group();
    const plankMat = material(0x3c271d, 0.98, 0);
    for (let i = -12; i <= 12; i += 1) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(60, 0.05, 1.65), plankMat);
      plank.position.set(0, -0.94, i * 1.68);
      plank.receiveShadow = true;
      boards.add(plank);
    }
    this.scene.add(boards);
  }

  buildTable() {
    this.tableGroup = new THREE.Group();
    this.tableGroup.name = 'tabletop';
    this.scene.add(this.tableGroup);
    const apron = new THREE.Mesh(roundedRectGeometry(15.1, 15.1, 1.5, 0.85, 0.16), material(0x3c251a, 0.82, 0.02));
    apron.position.y = -0.42;
    apron.castShadow = true;
    apron.receiveShadow = true;
    this.tableGroup.add(apron);
    const top = new THREE.Mesh(roundedRectGeometry(14.55, 14.55, 1.45, 0.35, 0.1), material(0x70482b, 0.8, 0.02));
    top.position.y = 0.06;
    top.castShadow = true;
    top.receiveShadow = true;
    this.tableGroup.add(top);
    const felt = new THREE.Mesh(roundedRectGeometry(13.05, 13.05, 1.22, 0.075), material(FELT, 0.9, 0));
    felt.position.y = 0.27;
    felt.receiveShadow = true;
    this.tableGroup.add(felt);
    const brassRim = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(roundedRectPoints(13.35, 13.35, 1.26, 12)),
      new THREE.LineBasicMaterial({ color: BRASS }),
    );
    brassRim.position.y = 0.29;
    this.tableGroup.add(brassRim);
    for (let i = 0; i < 4; i += 1) {
      const angle = i * Math.PI / 2 + Math.PI / 4;
      const inlay = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.9), material(BRASS, 0.3, 0.75));
      inlay.position.set(Math.sin(angle) * 6.63, 0.34, Math.cos(angle) * 6.63);
      inlay.rotation.y = -angle;
      this.tableGroup.add(inlay);
    }
    const center = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 0.055, 48), material(0x0e2f2b, 0.92, 0));
    center.position.y = 0.335;
    this.scene.add(center);
    const centerRing = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.035, 8, 48), material(BRASS, 0.3, 0.8));
    centerRing.rotation.x = Math.PI / 2;
    centerRing.position.y = 0.37;
    this.scene.add(centerRing);
  }

  buildSeats() {
    for (let seat = 0; seat < 4; seat += 1) {
      const group = new THREE.Group();
      group.name = `seat-${seat}`;
      this.scene.add(group);
      this.seatGroups.push(group);
      const avatar = this.createAvatar(seat, { gender: seat % 2 ? 'female' : 'male', skin: seat });
      avatar.visible = false;
      group.add(avatar);
      this.avatarGroups.push(avatar);
      const gun = this.createGun();
      group.add(gun);
      this.gunGroups.push(gun);
      const blood = this.createBlood();
      group.add(blood);
      this.bloodGroups.push(blood);
      this.layoutSeat(seat);
    }
  }

  createAvatar(seat, player = {}) {
    const gender = player.gender === 'female' ? 'female' : 'male';
    const skin = Math.max(0, Math.min(1, Number(player.skin) || 0));
    const tone = gender === 'female' ? SKIN_TONES[skin + 2] : SKIN_TONES[skin];
    const avatar = new THREE.Group();
    avatar.userData = { gender, skin, alive: true };
    const coat = material(gender === 'female' ? FEMALE_OUTFITS[skin] : MALE_COATS[skin], 0.82, 0.02);
    const skinMat = material(tone, 0.72, 0.02);
    const cuff = material(gender === 'female' ? 0xe5d4ba : 0xbda884, 0.84, 0.02);
    const torsoWidth = gender === 'female' ? 1.7 : 2.12;
    const torsoDepth = gender === 'female' ? 1.28 : 1.5;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth, 0.72, torsoDepth), coat);
    torso.position.set(0, 0.72, 0.15);
    torso.castShadow = true;
    avatar.add(torso);
    if (gender === 'female') {
      const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.82, 0.38, 12), coat);
      waist.position.set(0, 0.27, 0.22);
      waist.scale.z = 0.85;
      waist.castShadow = true;
      avatar.add(waist);
      const collar = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.12, 4), cuff);
      collar.position.set(0, 1.1, -0.34);
      collar.rotation.x = Math.PI / 2;
      avatar.add(collar);
    } else {
      const lapelMat = material(0xd5bf93, 0.8, 0.02);
      for (const side of [-1, 1]) {
        const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.46), lapelMat);
        lapel.position.set(side * 0.27, 0.94, -0.79);
        lapel.rotation.y = side * 0.18;
        avatar.add(lapel);
      }
      const collar = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.08, 0.25), cuff);
      collar.position.set(0, 1.09, -0.74);
      avatar.add(collar);
    }
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(gender === 'female' ? 0.38 : 0.43, 12, 8), coat);
      shoulder.position.set(side * (torsoWidth / 2 - 0.08), 0.95, -0.04);
      shoulder.scale.set(1.0, 0.84, 1.14);
      shoulder.castShadow = true;
      avatar.add(shoulder);
      const upperStart = new THREE.Vector3(side * (torsoWidth / 2 - 0.07), 0.86, -0.02);
      const upperEnd = new THREE.Vector3(side * 1.10, 0.58, -0.37);
      avatar.add(segmentBetween(upperStart, upperEnd, gender === 'female' ? 0.24 : 0.29, coat));
      avatar.add(segmentBetween(upperEnd, new THREE.Vector3(side * 1.24, 0.39, -0.75), gender === 'female' ? 0.19 : 0.22, cuff));
      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.23, 12, 8), skinMat);
      palm.position.set(side * 1.25, 0.32, -0.98);
      palm.scale.set(0.82, 0.68, 1.12);
      palm.castShadow = true;
      avatar.add(palm);
      for (let finger = 0; finger < 3; finger += 1) {
        const fingertip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), skinMat);
        fingertip.position.set(side * (1.16 + finger * 0.09), 0.27 + (finger % 2) * 0.06, -1.13);
        fingertip.castShadow = true;
        avatar.add(fingertip);
      }
    }
    return avatar;
  }

  createGun() {
    const gun = new THREE.Group();
    gun.userData = { baseRotation: 0 };
    const gunMat = material(0x1d2020, 0.34, 0.76);
    const gripMat = material(0x3b2119, 0.7, 0.04);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.18, 12), gunMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.53, 0.6);
    barrel.castShadow = true;
    gun.add(barrel);
    const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.25, 16), gunMat);
    cylinder.rotation.z = Math.PI / 2;
    cylinder.position.set(0, 0.5, 0.05);
    cylinder.castShadow = true;
    gun.add(cylinder);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.65, 0.34), gripMat);
    grip.position.set(0, 0.18, -0.22);
    grip.rotation.x = -0.16;
    grip.castShadow = true;
    gun.add(grip);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.035, 6, 12, Math.PI), gunMat);
    guard.rotation.x = Math.PI / 2;
    guard.position.set(0, 0.31, -0.03);
    gun.add(guard);
    gun.visible = false;
    return gun;
  }

  createBlood() {
    const blood = new THREE.Group();
    const pool = new THREE.Mesh(new THREE.CircleGeometry(0.9, 32), material(0x4d1418, 0.94, 0));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.345, 0.5);
    pool.scale.set(1.15, 0.58, 1);
    blood.add(pool);
    const dark = material(0x321016, 0.92, 0);
    for (let i = 0; i < 6; i += 1) {
      const drop = new THREE.Mesh(new THREE.CircleGeometry(0.05 + (i % 3) * 0.025, 10), dark);
      const angle = (i / 6) * TAU;
      drop.rotation.x = -Math.PI / 2;
      drop.position.set(Math.cos(angle) * (1.1 + (i % 2) * 0.22), 0.35, 0.5 + Math.sin(angle) * (0.52 + (i % 3) * 0.1));
      blood.add(drop);
    }
    blood.visible = false;
    return blood;
  }

  layoutSeat(seat) {
    const relative = (seat - this.selfSeat + 4) % 4;
    const position = SEAT_RELATIVE_POSITIONS[relative];
    const group = this.seatGroups[seat];
    if (!group) return;
    group.position.set(position.x * this.tableAspect, position.y, position.z);
    group.rotation.y = SEAT_YAWS[relative];
    const gun = this.gunGroups[seat];
    if (gun) {
      gun.position.set(0, 0, 0.5);
      gun.rotation.y = Math.PI;
    }
  }

  updatePlayer(seat, player) {
    const avatar = this.avatarGroups[seat];
    const group = this.seatGroups[seat];
    if (!avatar || !group) return;
    const inLobby = this.state?.phase === 'lobby';
    const alive = inLobby || player?.alive !== false;
    avatar.visible = alive;
    avatar.userData.alive = alive;
    const nextGender = player?.gender === 'female' ? 'female' : 'male';
    const nextSkin = Math.max(0, Math.min(1, Number(player?.skin) || 0));
    if (player && (avatar.userData.gender !== nextGender || avatar.userData.skin !== nextSkin)) {
      const old = avatar;
      const rebuilt = this.createAvatar(seat, player);
      rebuilt.visible = alive;
      rebuilt.userData.alive = alive;
      group.remove(old);
      group.add(rebuilt);
      this.avatarGroups[seat] = rebuilt;
    }
    this.bloodGroups[seat].visible = !inLobby && !alive;
    const gun = this.gunGroups[seat];
    if (gun) gun.visible = !inLobby && alive && Boolean(player?.shots !== undefined || player?.kind === 'ai');
  }

  rebuildCards(state) {
    for (const mesh of this.cardMeshes) this.scene.remove(mesh);
    this.cardMeshes = [];
    if (!state?.players) return;
    const backTexture = this.backTexture || (this.backTexture = makeCardTexture(true));
    for (const player of state.players) {
      const count = Number(player.handCount) || 0;
      if (count < 1 || player.alive === false) continue;
      const relative = (player.seatIndex - this.selfSeat + 4) % 4;
      const pos = SEAT_RELATIVE_POSITIONS[relative];
      for (let i = 0; i < Math.min(count, 7); i += 1) {
        const card = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.06, 0.9), new THREE.MeshStandardMaterial({ map: backTexture, roughness: 0.72 }));
        const spread = (i - (Math.min(count, 7) - 1) / 2) * 0.35;
        const yaw = SEAT_YAWS[relative];
        card.position.set(pos.x * this.tableAspect + Math.cos(yaw) * spread, 0.46 + i * 0.01, pos.z - Math.sin(yaw) * spread - 0.55);
        card.rotation.set(0, yaw, 0);
        card.castShadow = true;
        this.scene.add(card);
        this.cardMeshes.push(card);
      }
    }
  }

  setState(state) {
    this.state = state || null;
    if (Number.isInteger(state?.selfSeat) && state.selfSeat >= 0 && state.selfSeat < 4) {
      this.selfSeat = state.selfSeat;
    }
    for (let seat = 0; seat < 4; seat += 1) {
      this.layoutSeat(seat);
      const player = state?.players?.find((candidate) => candidate.seatIndex === seat);
      if (player) this.updatePlayer(seat, player);
      else {
        this.avatarGroups[seat].visible = false;
        this.bloodGroups[seat].visible = false;
        this.gunGroups[seat].visible = false;
      }
    }
    this.rebuildCards(state);
  }

  playShot(shot) {
    if (!shot || !Number.isInteger(shot.seatIndex)) return;
    const gun = this.gunGroups[shot.seatIndex];
    if (gun) {
      gun.visible = true;
      gun.userData.recoil = 1;
    }
    const relative = (shot.seatIndex - this.selfSeat + 4) % 4;
    const pos = SEAT_RELATIVE_POSITIONS[relative];
    const flash = new THREE.PointLight(shot.fatal ? 0xffb05a : 0xe5edf0, 9, 4, 2);
    flash.position.set(pos.x * this.tableAspect, 1.0, pos.z + 0.7);
    this.scene.add(flash);
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), material(0xa8a69d, 0.95, 0));
    smoke.position.set(pos.x * this.tableAspect, 0.65, pos.z + 0.95);
    smoke.scale.set(0.8, 0.55, 0.8);
    this.scene.add(smoke);
    this.effects.push({ type: 'shot', age: 0, flash, smoke, seat: shot.seatIndex, fatal: Boolean(shot.fatal) });
    const avatar = this.avatarGroups[shot.seatIndex];
    if (shot.fatal && avatar) {
      avatar.userData.pendingDeath = true;
      const blood = this.bloodGroups[shot.seatIndex];
      if (blood) {
        blood.visible = true;
        blood.scale.setScalar(0.12);
      }
    }
  }

  updateEffects(delta) {
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
    const effect = this.effects[i];
    effect.age += delta;
    if (effect.type === 'shot') {
        effect.flash.intensity = Math.max(0, 9 * (1 - effect.age * 10));
        effect.smoke.scale.multiplyScalar(1 + delta * 1.4);
        effect.smoke.material.opacity = Math.max(0, 0.7 - effect.age * 0.5);
        if (effect.age > 0.12) effect.flash.visible = false;
        if (effect.fatal) {
          const blood = this.bloodGroups[effect.seat];
          if (blood) blood.scale.setScalar(Math.min(1, effect.age * 2.2));
        }
        if (effect.age > 1.6) {
          this.scene.remove(effect.flash);
          this.scene.remove(effect.smoke);
          if (effect.fatal) {
            const avatar = this.avatarGroups[effect.seat];
            if (avatar) avatar.visible = false;
            this.bloodGroups[effect.seat].visible = true;
          }
          this.effects.splice(i, 1);
        }
      }
    }
    for (const gun of this.gunGroups) {
      if (gun.userData.recoil > 0) {
        gun.userData.recoil = Math.max(0, gun.userData.recoil - delta * 6);
        gun.position.z = 0.5 + gun.userData.recoil * 0.15;
      }
    }
  }

  resize() {
    if (!this.renderer || !this.container) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || this.container.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(rect.height || this.container.clientHeight || window.innerHeight));
    const aspect = width / height;
    // The tabletop is intentionally a rounded rectangle whose world-space ratio
    // follows the viewport. The camera remains a true top-down orthographic
    // projection; adapting the table shape keeps it close to a 90% fill on
    // both a 16:9 desktop and a narrow portrait window without stretching the
    // canvas or its projection.
    this.tableAspect = Math.max(0.38, Math.min(2.2, aspect));
    if (this.tableGroup) this.tableGroup.scale.set(this.tableAspect, 1, 1);
    for (let seat = 0; seat < 4; seat += 1) this.layoutSeat(seat);
    const tabletopDepth = 15.1;
    const viewHeight = tabletopDepth / 0.95;
    const viewWidth = viewHeight * aspect;
    this.camera.position.set(0, 18, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.left = -viewWidth / 2;
    this.camera.right = viewWidth / 2;
    this.camera.top = viewHeight / 2;
    this.camera.bottom = -viewHeight / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    if (!this.renderer) return;
    requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.updateEffects(delta);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._boundResize);
    this._resizeObserver?.disconnect();
    this.renderer?.dispose();
    this.container?.replaceChildren();
  }
}
