import * as THREE from './lib.js';
import { EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass } from './lib.js';
import { Track, TYPE, TYPE_COLORS, LANES, LANE_ANG, WALL_H, createTrackMaterials, wrapLane, laneIndex } from './track.js';
import { createBackground, createCar, Trail, Particles, SpeedLines } from './scene.js';
import { SynthAudio } from './audio.js';
import { t, getLang, setLang, applyI18n } from './i18n.js';
import { Leaderboard } from './leaderboard.js';

// ---------------------------------------------------------------------------
// 物理参数
// ---------------------------------------------------------------------------
const PHYS = {
  VMAX: 62,          // 基础极速（单位/秒），难度越高越快
  VMAX_BONUS: 10,
  ACCEL_TIME: 3,     // 0 → 极速 用时
  G: 34,             // 指向管壁的“重力”
  JUMP_V: 12.5,      // 起跳初速度（高度固定 ≈ 2.3）
  BOUNCE_V: 18,      // 弹射平台
  BRAKE: 48,         // 地面刹车减速度
  AIR_BRAKE: 34,     // 空中减速度
  AIR_MIN_V: 6,
  STEER_GROUND: 3.4, // 赛道/秒
  STEER_AIR: 2.5,
  LAND_TOL: 0.35,    // 允许低于平台面多少仍能落上
  RESCUE_DEPTH: 2.2, // 掉出平台后，低于平台面这么多才算坠毁（之前可以连跳自救）
  ENERGY_DIST: 1000, // 在赛道上行驶多远攒满连跳能量
  AIR_JUMP_MUL: 1.6, // 连跳初速度 = 起跳初速度 × 这个倍数（额外升高约 5.9）
  MAX_H: 6.5,        // 离管壁的最大高度，防止飞过管道中心
  FLIP_TIME: 0.55,   // 连跳前空翻用时
  CAR_HALF_W: 0.16,  // 车宽的一半（以赛道为单位）
  CAR_HALF_L: 1.6,
  RACE_SEED: 20261101,
};
const KMH = 4.8; // 显示用：单位/秒 → km/h

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 6000);
scene.add(camera);

scene.add(new THREE.AmbientLight(0x6070a0, 0.6));
scene.add(new THREE.HemisphereLight(0x88aaff, 0x220833, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(600, 500, -600);
scene.add(sun);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.35, 0.6);
composer.addPass(bloom);

// 加速时的“虚幻感”：画面四周径向拉伸模糊 + 色差 + 青色晕边，中间跑道保持清晰
const BoostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.56) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform vec2 uCenter; varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      if (uAmount < 0.001) { gl_FragColor = base; return; }
      vec2 dir = vUv - uCenter;
      // 中心和下方（赛车与脚下跑道）不受影响，越往四周越虚
      vec2 m = vec2(dir.x * 1.15, dir.y > 0.0 ? dir.y : dir.y * 0.4);
      float mask = smoothstep(0.2, 0.62, length(m));
      float k = uAmount * mask;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float t = float(i) / 11.0;
        vec2 uv = vUv - dir * t * 0.16 * k;
        acc.r += texture2D(tDiffuse, uv - dir * 0.012 * k).r;
        acc.g += texture2D(tDiffuse, uv).g;
        acc.b += texture2D(tDiffuse, uv + dir * 0.012 * k).b;
      }
      vec3 col = acc / 12.0;
      col += vec3(0.0, 0.3, 0.4) * k * 0.1;
      gl_FragColor = vec4(mix(base.rgb, col, clamp(k * 1.3, 0.0, 1.0)), base.a);
    }`,
};
const boostPass = new ShaderPass(BoostShader);
composer.addPass(boostPass);
composer.addPass(new OutputPass());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

const bg = createBackground(scene);
const mats = createTrackMaterials();
const car = createCar();
scene.add(car.group);
const trails = [new Trail(scene, 0xff3cf0), new Trail(scene, 0xff3cf0)];
const particles = new Particles(scene);
const speedLines = new SpeedLines(camera);
const audio = new SynthAudio();

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------
const keys = new Set();
let jumpQueued = false;
const KEYMAP = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyS: 'brake', ArrowDown: 'brake', Space: 'jump' };

window.addEventListener('keydown', (e) => {
  audio.init();
  if (e.target instanceof HTMLInputElement) {
    if (e.code === 'Enter' || e.code === 'Escape') e.target.blur();
    return;
  }
  const k = KEYMAP[e.code];
  if (k) {
    e.preventDefault();
    if (k === 'jump' && !e.repeat) jumpQueued = true;
    keys.add(k);
  }
  if (e.repeat) return;
  if (e.code === 'Escape') onEscape();
  else if (e.code === 'KeyR' && (game.state === 'over' || game.state === 'finished' || game.state === 'paused')) startGame(game.mode);
  else if (e.code === 'KeyM') { audio.setMuted(!audio.muted); showTip(t(audio.muted ? 'tipMuted' : 'tipUnmuted')); }
  else if (game.state === 'menu' && e.code === 'Digit1') requestStart('race');
  else if (game.state === 'menu' && e.code === 'Digit2') requestStart('endless');
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); });
window.addEventListener('blur', () => { keys.clear(); if (game.state === 'playing') pause(true); });
window.addEventListener('pointerdown', () => audio.init());

// ---------------------------------------------------------------------------
// 存档
// ---------------------------------------------------------------------------
const store = {
  get(k) { try { const v = localStorage.getItem('starrift.' + k); return v === null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('starrift.' + k, JSON.stringify(v)); } catch { /* 隐私模式等 */ } },
};

// ---------------------------------------------------------------------------
// 游戏状态
// ---------------------------------------------------------------------------
const game = {
  state: 'menu', mode: 'race', track: null,
  s: 0, a: 5.5, h: 0, v: 0, vh: 0, air: false,
  time: 0, clock: 0, countdown: 0, lastBeep: 0,
  lost: false, lostT: 0, reason: '', boostT: 0, lastTile: null,
  camA: 5.5, camH: 0, camUp: new THREE.Vector3(0, 1, 0), camFrozen: false,
  steerVis: 0, shake: 0, spin: 0, boostFx: 0, energy: 0, flipT: 0,
};

const ui = {
  hud: document.getElementById('hud'),
  time: document.getElementById('hud-time'),
  dist: document.getElementById('hud-dist'),
  best: document.getElementById('hud-best'),
  bestLabel: document.getElementById('hud-best-label'),
  modeLabel: document.getElementById('hud-mode'),
  speed: document.getElementById('hud-speed'),
  speedFill: document.getElementById('hud-speed-fill'),
  progress: document.getElementById('hud-progress'),
  progressFill: document.getElementById('hud-progress-fill'),
  radar: document.getElementById('radar'),
  tip: document.getElementById('hud-tip'),
  countdown: document.getElementById('countdown'),
  menu: document.getElementById('menu'),
  pause: document.getElementById('pause'),
  result: document.getElementById('result'),
  resultTitle: document.getElementById('result-title'),
  resultStats: document.getElementById('result-stats'),
  resultRank: document.getElementById('result-rank'),
  energy: document.getElementById('energy'),
  energyFill: document.getElementById('energy-fill'),
  energyPct: document.getElementById('energy-pct'),
  lbList: document.getElementById('lb-list'),
  lbNote: document.getElementById('lb-note'),
  nick: document.getElementById('nick-input'),
  langBtn: document.getElementById('lang-btn'),
};
const radarCtx = ui.radar.getContext('2d');

const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
const show = (el, on) => el.classList.toggle('hidden', !on);

let tipTimer = 0;
function showTip(text, dur = 1.4) { ui.tip.textContent = text; ui.tip.classList.add('on'); tipTimer = dur; }

const fmtScore = (mode, v) => (mode === 'race' ? fmtTime(v) : `${Math.floor(v)} m`);

function refreshMenuBest() {
  const br = store.get('bestRace'), be = store.get('bestEndless');
  document.getElementById('best-race').textContent = br ? t('bestVal', { v: fmtTime(br) }) : t('bestNone');
  document.getElementById('best-endless').textContent = be ? t('bestVal', { v: `${Math.floor(be)} m` }) : t('bestNone');
}

// ---------------------------------------------------------------------------
// 昵称 + 排行榜
// ---------------------------------------------------------------------------
let nickname = store.get('nick');
if (typeof nickname !== 'string' || !nickname.trim()) {
  nickname = `${getLang() === 'zh' ? '车手' : 'Pilot'}${Math.floor(1000 + Math.random() * 9000)}`;
  store.set('nick', nickname);
}
ui.nick.value = nickname;

// 返回是否有效；改名后同步到全球榜上自己的记录
function setNickname(raw) {
  const v = raw.trim().slice(0, 16);
  if (!v) return false;
  store.set('nickConfirmed', true);
  ui.nick.value = v;
  if (v !== nickname) {
    nickname = v;
    store.set('nick', v);
    board.rename(v);
  }
  return true;
}

ui.nick.addEventListener('change', () => { if (!setNickname(ui.nick.value)) ui.nick.value = nickname; });

// 第一次开局前请玩家确认昵称（预填随机名，直接回车也行）
const nickModal = document.getElementById('nick-modal');
const nickModalInput = document.getElementById('nick-modal-input');
let pendingMode = null;

function requestStart(mode) {
  if (store.get('nickConfirmed')) { startGame(mode); return; }
  pendingMode = mode;
  nickModalInput.value = nickname;
  show(nickModal, true);
  nickModalInput.focus();
  nickModalInput.select();
}

function closeNickModal(start) {
  if (start && !setNickname(nickModalInput.value)) { nickModalInput.focus(); return; }
  show(nickModal, false);
  const mode = pendingMode;
  pendingMode = null;
  if (start) startGame(mode);
}

document.getElementById('nick-modal-go').addEventListener('click', () => closeNickModal(true));
document.getElementById('nick-modal-cancel').addEventListener('click', () => closeNickModal(false));
nickModalInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); closeNickModal(true); }
  else if (e.code === 'Escape') { e.preventDefault(); closeNickModal(false); }
});

const lbView = { mode: 'race' };
const board = new Leaderboard(() => renderBoard());

// 只显示全球榜；全球榜连不上时自动改用本机成绩
function renderBoard() {
  const scope = board.hasGlobal ? 'global' : 'local';
  document.querySelectorAll('#lb-mode button').forEach((b) => b.classList.toggle('on', b.dataset.lbmode === lbView.mode));

  let note = '';
  if (board.status === 'local') note = t('lbLocalOnly');
  else if (board.status === 'error') note = t('lbError');
  else if (board.status === 'loading') note = t('lbLoading');
  ui.lbNote.textContent = note;

  const rows = scope === 'global' ? board.global[lbView.mode] : board.local[lbView.mode];
  ui.lbList.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = scope === 'global' && board.status !== 'live' ? '' : t('lbEmpty');
    ui.lbList.append(li);
    return;
  }
  rows.slice(0, scope === 'global' ? 50 : 10).forEach((r, i) => {
    const li = document.createElement('li');
    const isMe = scope === 'global' && board.uid && r.id === board.uid;
    if (isMe) li.className = 'me';
    const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = i + 1;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name;
    if (isMe) { const you = document.createElement('small'); you.textContent = t('lbYou'); nm.append(you); }
    const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = fmtScore(lbView.mode, r.score);
    li.append(rk, nm, sc);
    ui.lbList.append(li);
  });
}

document.querySelectorAll('#lb-mode button').forEach((b) => b.addEventListener('click', () => { lbView.mode = b.dataset.lbmode; renderBoard(); }));

// ---------------------------------------------------------------------------
// 语言切换
// ---------------------------------------------------------------------------
function renderLegend() {
  document.getElementById('legend').innerHTML = TYPE_COLORS.map((c, i) =>
    `<span><i style="background:${c};box-shadow:0 0 8px ${c}"></i>${t('type' + i)}</span>`).join('') +
    `<span><i class="hole"></i>${t('hole')}</span>`;
}

function refreshTexts() {
  applyI18n();
  ui.langBtn.textContent = t('lang');
  renderLegend();
  refreshMenuBest();
  renderBoard();
  ui.modeLabel.textContent = t(game.mode);
  ui.bestLabel.textContent = t(game.mode === 'race' ? 'bestTime' : 'bestDist');
  if (lastResult) renderResult();
}

ui.langBtn.addEventListener('click', () => { setLang(getLang() === 'zh' ? 'en' : 'zh'); refreshTexts(); });

// 菜单背景用的演示赛道
function demoTrack() {
  if (game.track) game.track.dispose();
  game.track = new Track((Math.random() * 1e9) | 0, 'endless', scene, mats);
  game.s = 0;
  game.camA = 5.5;
}

function toMenu() {
  game.state = 'menu';
  lastResult = null;
  document.body.classList.remove('in-run');
  audio.musicLevel = 0;
  show(ui.menu, true); show(ui.hud, false); show(ui.pause, false); show(ui.result, false); show(ui.countdown, false);
  car.group.visible = false;
  trails.forEach((t) => { t.reset(); t.mesh.visible = false; });
  refreshMenuBest();
  renderBoard();
  if (board.status === 'live') board.refresh();
  demoTrack();
}

function startGame(mode) {
  audio.init();
  audio.click();
  if (game.track) game.track.dispose();
  const seed = mode === 'race' ? PHYS.RACE_SEED : (Math.random() * 1e9) | 0;
  game.track = new Track(seed, mode, scene, mats);
  Object.assign(game, {
    mode, state: 'countdown', s: 0, a: 5.5, h: 0, v: 0, vh: 0, air: false,
    time: 0, countdown: 3.2, lastBeep: 4, lost: false, lostT: 0, reason: '', boostT: 0, lastTile: null,
    camA: 5.5, camH: 0, camFrozen: false, steerVis: 0, shake: 0, spin: 0, boostFx: 0, energy: 0, flipT: 0,
  });
  game.camUp.set(0, 1, 0);
  jumpQueued = false;
  car.group.visible = true;
  trails.forEach((t) => { t.reset(); t.mesh.visible = true; });
  audio.musicLevel = 1;
  show(ui.menu, false); show(ui.pause, false); show(ui.result, false); show(ui.hud, true);
  lastResult = null;
  document.body.classList.add('in-run');
  show(ui.progress, mode === 'race');
  ui.modeLabel.textContent = t(mode);
  ui.bestLabel.textContent = t(mode === 'race' ? 'bestTime' : 'bestDist');
  const best = store.get(mode === 'race' ? 'bestRace' : 'bestEndless');
  ui.best.textContent = best ? (mode === 'race' ? fmtTime(best) : `${Math.floor(best)} m`) : '--';
}

function pause(on) {
  if (on && game.state === 'playing') { game.state = 'paused'; show(ui.pause, true); }
  else if (!on && game.state === 'paused') { game.state = 'playing'; show(ui.pause, false); }
}

function onEscape() {
  if (game.state === 'playing') pause(true);
  else if (game.state === 'paused') pause(false);
  else if (game.state === 'over' || game.state === 'finished') toMenu();
}

// 结算结果保存在这里，切换语言时可以重新渲染
let lastResult = null;

function endRun(finished) {
  game.state = finished ? 'finished' : 'over';
  const mode = game.mode;
  const r = { mode, finished, reason: game.reason, time: game.time, s: game.s, record: false, submit: null, uploading: false };
  let score = null;
  if (mode === 'race' && finished) {
    const best = store.get('bestRace');
    if (!best || game.time < best) { store.set('bestRace', game.time); r.record = true; }
    score = game.time;
  } else if (mode === 'endless') {
    const best = store.get('bestEndless');
    if (!best || game.s > best) { store.set('bestEndless', game.s); r.record = true; }
    score = Math.floor(game.s);
  }
  r.progress = Math.floor(Math.min(1, game.s / game.track.goal) * 100);
  lastResult = r;
  renderResult();
  show(ui.result, true);
  if (score > 0) {
    r.uploading = true;
    board.submit(mode, nickname, score).then((out) => {
      r.submit = out;
      r.uploading = false;
      if (lastResult === r) renderResult();
    });
  }
}

function renderResult() {
  const r = lastResult;
  const isRace = r.mode === 'race';
  let title, rows;
  if (r.finished) {
    title = t(r.record ? 'newRecord' : 'finished');
    rows = [[t('time'), fmtTime(r.time)], [t('best'), fmtTime(store.get('bestRace'))]];
  } else if (isRace) {
    title = t(r.reason === 'crash' ? 'crash' : 'fall');
    rows = [[t('progress'), `${r.progress}%`], [t('time'), fmtTime(r.time)]];
  } else {
    title = t(r.record ? 'newRecord' : r.reason === 'crash' ? 'crash' : 'fall');
    rows = [[t('distance'), `${Math.floor(r.s)} m`], [t('survived'), fmtTime(r.time)], [t('best'), `${Math.floor(store.get('bestEndless'))} m`]];
  }
  ui.resultTitle.textContent = title;
  ui.resultStats.replaceChildren(...rows.map(([k, v]) => {
    const d = document.createElement('div');
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('b'); b.textContent = v;
    d.append(a, b);
    return d;
  }));
  ui.result.classList.toggle('record', r.record);
  let line = '';
  const sub = r.submit;
  if (sub) {
    if (sub.global === 'failed') line = t('uploadFail', { m: sub.error });
    else if (sub.global === 'local_only') line = t('localOnly');
    else {
      const rank = sub.globalRank;
      const rankText = rank > 0 ? t('rankLine', { r: rank }) : rank === -1 ? t('rankOut') : '';
      line = [sub.global === 'uploaded' ? t('uploaded') : t('notBetter'), rankText].filter(Boolean).join(' · ');
    }
  }
  ui.resultRank.textContent = line;
}

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => requestStart(b.dataset.mode)));
document.getElementById('btn-retry').addEventListener('click', () => startGame(game.mode));
document.getElementById('btn-menu').addEventListener('click', toMenu);
document.getElementById('btn-resume').addEventListener('click', () => pause(false));
document.getElementById('btn-quit').addEventListener('click', toMenu);


// ---------------------------------------------------------------------------
// 物理
// ---------------------------------------------------------------------------
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

function lose(reason) {
  if (game.lost) return;
  game.lost = true;
  game.reason = reason;
  game.lostT = 0;
  game.camFrozen = true;
  if (reason === 'crash') {
    audio.crash();
    game.shake = 1.2;
    const p = car.group.position;
    particles.emit(p, tmpV.set(0, 0, 0), 14, '#ff4a6a', 1.2, 160);
    particles.emit(p, tmpV.set(0, 0, 0), 8, '#ffd23a', 0.9, 90);
    particles.emit(p, tmpV.set(0, 0, 0), 4, '#ffffff', 0.5, 50);
    car.group.visible = false;
    trails.forEach((t) => (t.mesh.visible = false));
  } else {
    audio.fall();
  }
}

function vmaxAt(s) { return PHYS.VMAX + PHYS.VMAX_BONUS * Math.min(1, game.track.difficulty(s)); }

function airJump() {
  game.vh = PHYS.JUMP_V * PHYS.AIR_JUMP_MUL;
  game.energy = 0;
  audio.airJump();
  showTip(t('tipAirJump'), 0.8);
  game.shake = Math.max(game.shake, 0.35);
  game.flipT = PHYS.FLIP_TIME;
  const p = car.group.position;
  particles.emit(p, tmpV.set(0, 0, 0), 12, '#4dfff4', 0.7, 70);
  particles.emit(p, tmpV.set(0, 0, 0), 8, '#ff3cf0', 0.5, 40);
  // 脚下炸开一圈冲击波，像踩着空气再跳一次
  shockwave.position.copy(p);
  shockwave.quaternion.setFromUnitVectors(AX_Z, tmpV2.copy(game.track.path.r).negate());
  shockwave.userData.t = 0;
  shockwave.visible = true;
}

const shockwave = new THREE.Mesh(
  new THREE.RingGeometry(0.75, 1, 48),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(0x4dfff4).multiplyScalar(2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
);
shockwave.visible = false;
scene.add(shockwave);

function updateShockwave(dt) {
  if (!shockwave.visible) return;
  const k = (shockwave.userData.t += dt) / 0.45;
  if (k >= 1) { shockwave.visible = false; return; }
  shockwave.scale.setScalar(1 + k * 7);
  shockwave.material.opacity = 1 - k;
}

function physicsStep(dt) {
  const tr = game.track;
  const vmax = vmaxAt(game.s);
  const steer = (keys.has('left') ? 1 : 0) - (keys.has('right') ? 1 : 0);
  const braking = keys.has('brake');
  let jumped = false; // 本步已经在地面起跳或被弹射，同一次按键不再触发连跳

  if (game.lost) {
    // 坠落：继续沿惯性飞离管道
    game.vh -= PHYS.G * dt;
    game.h += game.vh * dt;
    game.v *= 1 - 0.3 * dt;
    game.s += game.v * dt;
    game.spin += dt * 2.5;
    return;
  }

  game.a = wrapLane(game.a + steer * (game.air ? PHYS.STEER_AIR : PHYS.STEER_GROUND) * dt);

  if (!game.air) {
    const tile = tr.laneAt(game.s, laneIndex(game.a));
    if (!tile) {
      game.air = true;
      game.vh = 0;
      game.lastTile = null;
    } else {
      const entered = tile !== game.lastTile;
      game.lastTile = tile;
      let cap = vmax;
      if (tile.type === TYPE.SLOW) {
        cap = vmax * 0.45;
        if (entered) { audio.slow(); showTip(t('tipSlow'), 0.8); }
      } else if (tile.type === TYPE.BOOST) {
        if (entered) { audio.boost(); showTip(t('tipBoost'), 0.8); }
        game.v = Math.max(game.v, vmax * 1.4);
        game.boostT = 1.0;
      } else if (tile.type === TYPE.CRUMBLE && tile.crumbleT < 0) {
        tile.crumbleT = game.clock;
        audio.crack();
      } else if (tile.type === TYPE.BOUNCE) {
        game.vh = PHYS.BOUNCE_V;
        game.air = true;
        jumpQueued = false;
        jumped = true;
        audio.bounce();
        particles.emit(car.group.position, tmpV.set(0, 0, 0), 5, TYPE_COLORS[TYPE.BOUNCE], 0.6, 40);
      }
      if (!game.air) {
        if (braking) game.v = Math.max(0, game.v - PHYS.BRAKE * dt);
        else if (game.v < cap) game.v = Math.min(cap, game.v + (vmax / PHYS.ACCEL_TIME) * dt);
        else if (game.boostT <= 0 || tile.type === TYPE.SLOW) game.v = Math.max(cap, game.v - (tile.type === TYPE.SLOW ? 90 : 18) * dt);
        if (jumpQueued) {
          game.vh = PHYS.JUMP_V;
          game.air = true;
          jumped = true;
          audio.jump();
        }
        // 在赛道上行驶的距离积累连跳能量
        if (game.energy < 1) {
          game.energy = Math.min(1, game.energy + (game.v * dt) / PHYS.ENERGY_DIST);
          if (game.energy >= 1) { audio.ready(); showTip(t('tipReady'), 1.2); }
        }
      }
    }
  }
  // 空中再按空格：能量满时连跳，用完重新积累
  if (jumpQueued && game.air && !jumped) {
    if (game.energy >= 1) airJump();
    else showTip(t('tipNoEnergy'), 0.7);
  }
  jumpQueued = false;

  if (game.air) {
    game.vh -= PHYS.G * dt;
    game.h += game.vh * dt;
    if (game.h > PHYS.MAX_H) { game.h = PHYS.MAX_H; game.vh = Math.min(game.vh, 0); }
    if (braking) game.v = Math.max(PHYS.AIR_MIN_V, game.v - PHYS.AIR_BRAKE * dt);
    if (game.h <= 0 && game.vh <= 0) {
      const tile = tr.laneAt(game.s, laneIndex(game.a));
      if (tile && game.h > -PHYS.LAND_TOL) {
        const impact = -game.vh;
        game.h = 0;
        game.vh = 0;
        game.air = false;
        if (impact > 5) {
          audio.land();
          game.shake = Math.max(game.shake, Math.min(0.5, impact * 0.025));
          particles.emit(car.group.position, tmpV.set(0, 0, 0), 4, TYPE_COLORS[tile.type], 0.5, 30);
        }
      } else if ((tile && game.h <= -PHYS.LAND_TOL) || game.h <= -PHYS.RESCUE_DEPTH) {
        // 撞到平台底下，或已经掉得太深：没救了。在这之前还能用连跳救回来
        lose('fall');
        return;
      }
    }
  }

  game.boostT -= dt;
  game.s += game.v * dt;

  // 障碍碰撞
  if (game.h < WALL_H) {
    const base = Math.floor(game.a);
    for (let k = -1; k <= 1; k++) {
      const i = (base + k + LANES) % LANES;
      const lo = base + k + 0.06, hi = base + k + 0.94;
      if (game.a + PHYS.CAR_HALF_W < lo || game.a - PHYS.CAR_HALF_W > hi) continue;
      const L = tr.laneRaw(game.s, i);
      if (!L || !L.obstacles.length) continue;
      for (const os of L.obstacles) {
        if (Math.abs(game.s - os) < 0.5 + PHYS.CAR_HALF_L) { lose('crash'); return; }
      }
    }
  }

  // 终点
  if (game.mode === 'race' && game.s >= tr.finishS) {
    audio.finish();
    endRun(true);
  }
}

// ---------------------------------------------------------------------------
// 每帧更新：车模、镜头、特效、HUD
// ---------------------------------------------------------------------------
const basis = new THREE.Matrix4();
const qRoll = new THREE.Quaternion();
const qSpin = new THREE.Quaternion();
const lookAt = new THREE.Vector3();
const nozzleW = new THREE.Vector3();
const AX_Z = new THREE.Vector3(0, 0, 1);
const AX_X = new THREE.Vector3(1, 0, 0);
const FLIP_PIVOT = new THREE.Vector3(0, 0.5, 0);

function shortestLaneDelta(from, to) {
  let d = to - from;
  if (d > LANES / 2) d -= LANES;
  if (d < -LANES / 2) d += LANES;
  return d;
}

function updateCarPose(dt) {
  const path = game.track.path;
  const steer = game.state === 'playing' && !game.lost ? (keys.has('left') ? 1 : 0) - (keys.has('right') ? 1 : 0) : 0;
  game.steerVis += (steer - game.steerVis) * (1 - Math.exp(-dt * 8));

  path.point(game.s, game.a, game.h, car.group.position);
  const up = tmpV.copy(path.r).negate();
  const fwd = tmpV2.copy(path.frame(game.s).t);
  // 空中俯仰
  const pitch = game.air || game.lost ? THREE.MathUtils.clamp(game.vh * 0.022, -0.4, 0.35) : 0;
  const f2 = fwd.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch));
  const u2 = up.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(fwd, -Math.sin(pitch));
  const x = new THREE.Vector3().crossVectors(u2, f2);
  basis.makeBasis(x, u2, f2);
  car.group.quaternion.setFromRotationMatrix(basis);
  qRoll.setFromAxisAngle(AX_Z, -game.steerVis * 0.28);
  car.group.quaternion.multiply(qRoll);
  if (game.lost) {
    qSpin.setFromAxisAngle(AX_X, game.spin * 0.7);
    car.group.quaternion.multiply(qSpin);
    qSpin.setFromAxisAngle(AX_Z, game.spin);
    car.group.quaternion.multiply(qSpin);
  }
  if (game.flipT > 0) {
    // 连跳时整车绕车身中心向前空翻一圈
    game.flipT = Math.max(0, game.flipT - dt);
    const k = 1 - game.flipT / PHYS.FLIP_TIME;
    const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    car.body.quaternion.setFromAxisAngle(AX_X, ease * Math.PI * 2);
    car.body.position.copy(FLIP_PIVOT).applyQuaternion(car.body.quaternion).negate().add(FLIP_PIVOT);
  } else {
    car.body.quaternion.identity();
    car.body.position.set(0, game.air ? 0 : Math.sin(game.clock * 18) * 0.02, 0);
  }

  // 尾焰
  const norm = game.v / vmaxAt(game.s);
  car.engineMat.color.setRGB(0.4 * 3, 0.9 * 3, 1.0 * 3).multiplyScalar(0.5 + norm * 0.8);
  // 连跳能量满时车底光晕跟着闪
  car.under.material.opacity = game.energy >= 1 ? 0.45 + 0.35 * Math.sin(game.clock * 9) : 0.35;
  car.group.updateMatrixWorld();
  const upW = up.clone();
  car.nozzles.forEach((nz, i) => {
    nozzleW.copy(nz).applyMatrix4(car.group.matrixWorld);
    trails[i].push(nozzleW, upW, 0.22, 0.4 + norm * 1.2);
  });
  if (game.boostT > 0 && Math.random() < 0.6) {
    particles.emit(nozzleW, fwd.clone().multiplyScalar(-10), 2, '#00fff0', 0.35, 2);
  }
}

function updateCamera(dt) {
  const path = game.track.path;
  game.camA += shortestLaneDelta(game.camA, game.a) * (1 - Math.exp(-dt * 5));
  game.camA = wrapLane(game.camA);
  // 上升时镜头跟得快（连跳不会挡住视线），下落时慢一点更平稳
  game.camH += (game.h - game.camH) * (1 - Math.exp(-dt * (game.h > game.camH ? 9 : 4)));
  const vmax = vmaxAt(game.s);
  const norm = THREE.MathUtils.clamp(game.v / vmax, 0, 1.5);

  if (!game.camFrozen) {
    const ch = Math.max(-1, game.camH);
    const high = Math.max(0, ch - 2.3); // 超过普通跳跃高度的部分（连跳/弹射）
    path.point(game.s - 9 - high * 0.8, game.camA, 3.2 + ch * 0.55 + high * 0.45, camera.position);
    path.point(game.s, game.camA, 0, tmpV);
    const up = path.r.clone().negate();
    game.camUp.lerp(up, 1 - Math.exp(-dt * 7)).normalize();
    path.point(game.s + 16, game.camA, 0.9 + ch * 0.3, lookAt);
  } else {
    lookAt.lerp(car.group.position, 1 - Math.exp(-dt * 6));
  }
  if (game.shake > 0) {
    camera.position.add(tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(game.shake * 0.6));
    game.shake = Math.max(0, game.shake - dt * 2);
  }
  camera.up.copy(game.camUp);
  camera.lookAt(lookAt);
  const fov = 70 + 16 * Math.min(norm, 1) + (game.boostT > 0 ? 8 : 0);
  camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt * 4));
  camera.updateProjectionMatrix();
  // 超出极速的部分（加速平台带来的）决定虚幻效果强度，随速度回落自然消退
  const fxTarget = game.lost ? 0 : THREE.MathUtils.clamp((norm - 1) / 0.4, 0, 1);
  game.boostFx += (fxTarget - game.boostFx) * (1 - Math.exp(-dt * (fxTarget > game.boostFx ? 10 : 3)));
  boostPass.uniforms.uAmount.value = game.boostFx;
  bloom.strength = 0.6 + 0.15 * game.boostFx;
  updateTunnelFocus(dt);
  speedLines.update(dt, game.lost ? 0 : game.v, game.lost ? 0 : norm, game.boostFx, tunnelDir);
}

// 隧道中心（前方管道中轴线上的点）在相机里的方向和屏幕位置：
// 速度线沿这个方向飞来，加速残影以它为圆心。管道弯曲、扭转时跟着移动
const tunnelPt = new THREE.Vector3();
const tunnelDir = new THREE.Vector3(0, 0, -1);
const tunnelUv = new THREE.Vector2(0.5, 0.56);
const tunnelUvTarget = new THREE.Vector2();

function updateTunnelFocus(dt) {
  camera.updateMatrixWorld();
  tunnelPt.copy(game.track.path.frame(game.s + 60).p);
  const k = 1 - Math.exp(-dt * 6);
  const local = camera.worldToLocal(tmpV.copy(tunnelPt));
  if (local.z < -1) tunnelDir.lerp(local.normalize(), k).normalize();
  const ndc = tmpV.copy(tunnelPt).project(camera);
  if (ndc.z < 1) {
    tunnelUvTarget.set(
      THREE.MathUtils.clamp(ndc.x * 0.5 + 0.5, 0.15, 0.85),
      THREE.MathUtils.clamp(ndc.y * 0.5 + 0.5, 0.15, 0.85)
    );
    tunnelUv.lerp(tunnelUvTarget, k);
  }
  boostPass.uniforms.uCenter.value.copy(tunnelUv);
}

function updateMenuCamera(dt) {
  const path = game.track.path;
  game.s += 34 * dt;
  game.camA = wrapLane(5.5 + Math.sin(game.clock * 0.15) * 2.5);
  path.point(game.s, game.camA, 4.5, camera.position);
  path.point(game.s, game.camA, 0, tmpV);
  game.camUp.copy(path.r).negate();
  path.point(game.s + 30, game.camA + Math.sin(game.clock * 0.2), 2, lookAt);
  camera.up.copy(game.camUp);
  camera.lookAt(lookAt);
  camera.fov = 75;
  camera.updateProjectionMatrix();
  boostPass.uniforms.uAmount.value = 0;
  bloom.strength = 0.6;
  updateTunnelFocus(dt);
  speedLines.update(dt, 34, 0.4, 0, tunnelDir);
}

function drawRadar() {
  const c = radarCtx, W = ui.radar.width, cx = W / 2, cy = W / 2;
  c.clearRect(0, 0, W, W);
  const secs = game.track.upcoming(game.s);
  const rings = [[44, 60], [66, 82]];
  c.lineWidth = 1;
  for (let r = 0; r < 2; r++) {
    const sec = secs[r];
    const [r0, r1] = rings[r];
    for (let i = 0; i < LANES; i++) {
      const mid = Math.PI / 2 + (i + 0.5 - game.a) * LANE_ANG;
      const a0 = mid - LANE_ANG * 0.45, a1 = mid + LANE_ANG * 0.45;
      c.beginPath();
      c.arc(cx, cy, r1, a0, a1);
      c.arc(cx, cy, r0, a1, a0, true);
      c.closePath();
      const L = sec ? sec.lanes[i] : null;
      if (L && !L.gone) {
        c.fillStyle = TYPE_COLORS[L.type];
        c.globalAlpha = r === 0 ? 0.9 : 0.55;
        c.fill();
      } else {
        c.globalAlpha = 0.5;
        c.strokeStyle = 'rgba(140,160,220,0.35)';
        c.stroke();
      }
    }
  }
  c.globalAlpha = 1;
  // 赛车
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.moveTo(cx, cy + 30); c.lineTo(cx - 7, cy + 42); c.lineTo(cx + 7, cy + 42);
  c.closePath();
  c.fill();
  // 下一个空隙距离
  const cur = game.track.sectionAt(game.s);
  const next = secs.find((x) => x.s0 > game.s);
  c.fillStyle = 'rgba(200,220,255,0.9)';
  c.font = '600 13px Orbitron, sans-serif';
  c.textAlign = 'center';
  const toFinish = cur && cur.isFinish;
  if (toFinish) c.fillText(`${Math.max(0, Math.floor(game.track.finishS - game.s))}`, cx, cy - 2);
  else if (cur) c.fillText(`${Math.max(0, Math.floor(cur.s1 - game.s))}`, cx, cy - 2);
  else c.fillText('AIR', cx, cy - 2);
  c.font = '10px "Noto Sans SC", sans-serif';
  c.fillStyle = 'rgba(200,220,255,0.6)';
  c.fillText(t(toFinish ? 'radarFinish' : cur ? 'radarEnd' : 'radarAir'), cx, cy + 14);
}

function updateHud() {
  const vmax = vmaxAt(game.s);
  ui.time.textContent = fmtTime(game.time);
  ui.dist.textContent = `${Math.floor(game.s)} m`;
  ui.speed.textContent = Math.round(game.v * KMH);
  ui.speedFill.style.width = `${Math.min(100, (game.v / (vmax * 1.4)) * 100)}%`;
  ui.speedFill.classList.toggle('boost', game.v > vmax * 1.02);
  const full = game.energy >= 1;
  ui.energyFill.style.width = `${Math.floor(game.energy * 100)}%`;
  ui.energyPct.textContent = `${Math.floor(game.energy * 100)}%`;
  if (ui.energy.classList.contains('full') !== full) ui.energy.classList.toggle('full', full);
  if (game.mode === 'race') ui.progressFill.style.width = `${Math.min(100, (game.s / game.track.goal) * 100)}%`;
  drawRadar();
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  tick(Math.min(clock.getDelta(), 1 / 30));
}

function tick(dt) {
  game.clock += dt;

  if (tipTimer > 0) { tipTimer -= dt; if (tipTimer <= 0) ui.tip.classList.remove('on'); }

  const st = game.state;
  if (st === 'menu') {
    updateMenuCamera(dt);
    game.track.update(game.s, game.clock, dt);
  } else if (st !== 'paused') {
    if (st === 'countdown') {
      game.countdown -= dt;
      const n = Math.ceil(game.countdown - 0.2);
      if (n !== game.lastBeep) {
        game.lastBeep = n;
        show(ui.countdown, true);
        ui.countdown.textContent = n > 0 ? n : 'GO!';
        ui.countdown.classList.remove('pop'); void ui.countdown.offsetWidth; ui.countdown.classList.add('pop');
        audio.beep(n <= 0);
      }
      if (game.countdown <= 0.2) {
        game.state = 'playing';
        setTimeout(() => show(ui.countdown, false), 600);
      }
    } else if (st === 'playing') {
      const sub = Math.ceil(dt / (1 / 120));
      for (let i = 0; i < sub && game.state === 'playing'; i++) physicsStep(dt / sub);
      if (!game.lost) game.time += dt;
      else {
        game.lostT += dt;
        if (game.lostT > 1.8 && game.state === 'playing') endRun(false);
      }
    } else if (st === 'over') {
      if (game.reason === 'fall') for (let i = 0; i < 2; i++) physicsStep(dt / 2);
    } else if (st === 'finished') {
      // 冲线后自动减速滑行
      game.v = Math.max(0, game.v - 30 * dt);
      game.s += game.v * dt;
    }
    game.track.update(game.s, game.clock, dt);
    if (car.group.visible) updateCarPose(dt);
    updateCamera(dt);
    const vmax = vmaxAt(game.s);
    audio.setEngine(Math.min(1.3, game.v / vmax), !game.air, keys.has('brake'), (st === 'playing' || st === 'finished') && !game.lost);
    updateHud();
  }
  if (st === 'paused' || st === 'menu') audio.setEngine(0, true, false, false);

  particles.update(dt);
  updateShockwave(dt);
  bg.update(camera.position, game.clock);
  composer.render();
}

// 调试用：在控制台查看状态或手动推进帧
window.__game = game;
window.__tick = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); };

refreshTexts();
toMenu();
frame();
