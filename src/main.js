import * as THREE from './lib.js';
import { EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass } from './lib.js';
import { Track, TYPE, TYPE_COLORS, LANES, LANE_ANG, WALL_H, createTrackMaterials, wrapLane, laneIndex, applyTrackArt, TRACK_STYLE, R, TEST_BOOST } from './track.js';
import { createBackground, createCar, Trail, Particles, SpeedLines, STAR_TEX, applyBackgroundArt, applyCarArt } from './scene.js';
import { isRingsTheme, setupRingsTheme } from './themeRings.js';
import { loadManifest, loadImage, loadTexture, swapImage, each, ASSET_BASE } from './assets.js';
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
  ACCEL_TIME_SUPER: 2, // 变身成超跑后 0 → 极速 用时
  SUPER_STEER: 1.3,  // 超跑转向更灵敏
  SUPER_KMH: 500,    // 车速到这么多 km/h 就变身
  SUPER_HOLD: 10,    // 变身后至少保持多少秒，之后车速低于 SUPER_KMH 就变回去
  MAX_FLIPS: 1,      // 翻滚跳（空中连跳）默认最多攒几次
  MAX_FLIPS_SUPER: 2, // 第一次变身之后，这一局的上限一直是这么多
  G: 34,             // 指向管壁的“重力”
  JUMP_V: 12.5,      // 起跳初速度（高度固定 ≈ 2.3）
  BOUNCE_V: 18,      // 弹射平台
  BRAKE: 48,         // 地面刹车减速度
  AIR_BRAKE: 34,     // 空中减速度
  AIR_MIN_V: 6,
  STEER_GROUND: 3.4, // 赛道/秒
  STEER_AIR: 2.5,
  LAND_TOL: 0.35,    // 允许低于平台面多少仍能落上
  SUPPORT_HALF_L: 1.6, // 判定支撑时看车头/车尾离中心多远（车身半长）
  EDGE_LAND_TOL: 0.15, // 只有车头/车尾压上平台时允许低于平台面多少
  START_LAND_TOL: 1.6,  // 刚到一条道的起点时，允许低于路面多少仍算落上去（尽量判存活）
  UNDER_TOL: 1.0,       // 其他地方：低于路面 1 米以内碰到路面都托回路面上，更低才算撞到平台底下
  START_ZONE: 6,        // 道的起点往后这么多米内都算“起点”
  COYOTE: 0.12,      // 开出平台边缘后仍可普通起跳的宽限时间（秒）
  JUMP_BUFFER: 0.15, // 落地前提前按跳，落地瞬间自动起跳的缓冲时间（秒）
  RESCUE_DEPTH: 5,   // 掉出平台后，低于平台面这么多才算坠毁（约 0.54 秒，之前可以翻滚跳自救；翻滚跳最多升高约 5.9 米）
  ENERGY_DIST: 1000, // 在赛道上行驶多远攒满连跳能量
  AIR_JUMP_MUL: 1.6, // 连跳初速度 = 起跳初速度 × 这个倍数（额外升高约 5.9）
  MAX_H: 6.5,        // 离管壁的最大高度，防止飞过管道中心
  FLIP_TIME: 0.55,   // 连跳侧向横滚一圈的用时
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
    uSpeed: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.56) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uSpeed; uniform vec2 uCenter; varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      if (uAmount < 0.001 && uSpeed < 0.001) { gl_FragColor = base; return; }
      vec2 dir = vUv - uCenter;
      // 平时的速度模糊：只在画面四周（近处飞过的地面、岩壁），中间看路的地方保持清楚，没有色差
      float ks = uSpeed * smoothstep(0.28, 0.75, length(dir * vec2(1.0, 1.15)));
      if (uAmount < 0.001) {
        vec3 sum = vec3(0.0);
        for (int i = 0; i < 10; i++) sum += texture2D(tDiffuse, vUv - dir * (float(i) / 9.0) * 0.06 * ks).rgb;
        gl_FragColor = vec4(mix(base.rgb, sum / 10.0, clamp(ks * 1.6, 0.0, 1.0)), base.a);
        return;
      }
      // 中心和下方（赛车与脚下跑道）不受影响，越往四周越虚
      vec2 m = vec2(dir.x * 1.15, dir.y > 0.0 ? dir.y : dir.y * 0.4);
      float mask = smoothstep(0.2, 0.62, length(m));
      float k = uAmount * mask;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float t = float(i) / 11.0;
        vec2 uv = vUv - dir * t * 0.11 * k;
        acc.r += texture2D(tDiffuse, uv - dir * 0.009 * k).r;
        acc.g += texture2D(tDiffuse, uv).g;
        acc.b += texture2D(tDiffuse, uv + dir * 0.009 * k).b;
      }
      // 拖影会把赛道发光边拉成一片白光，稍微压暗一点
      vec3 col = acc / 12.0 * (1.0 - 0.2 * k);
      col += vec3(0.0, 0.3, 0.4) * k * 0.06;
      gl_FragColor = vec4(mix(base.rgb, col, clamp(k, 0.0, 1.0)), base.a);
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
// 赛车金属漆反射用的环境贴图（只给赛车用，不影响赛道和背景）
const carEnv = new THREE.PMREMGenerator(renderer).fromScene(new THREE.RoomEnvironment(), 0.04).texture;
const car = createCar(carEnv);
scene.add(car.group);
// 拖尾最多记 40 个点；实际长度由 maxLen（米）决定，见 car.trailLength
const trails = [new Trail(scene, 0xff3cf0, 40), new Trail(scene, 0xff3cf0, 40)];
const particles = new Particles(scene);
const speedLines = new SpeedLines(scene);
const audio = new SynthAudio();

// 车底接触阴影：贴着路面的一块柔和暗影，车跳起来时变淡、变大
const contactShadow = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,1)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.75)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.8,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  m.renderOrder = 1;
  m.visible = false;
  scene.add(m);
  return m;
})();

// 近处飘过的小碎石（石头主题）：散在管道里的空中，车开过去时从镜头边上飞快地掠过，增加近景速度感
const DEBRIS_N = 70;
const debris = (() => {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x6d655b, roughness: 0.95, flatShading: true }), DEBRIS_N);
  m.frustumCulled = false;
  m.visible = false;
  scene.add(m);
  return { mesh: m, items: Array.from({ length: DEBRIS_N }, () => ({ s: -1e9, a: 0, h: 0, sc: 0, rot: new THREE.Euler() })) };
})();

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
  else if (e.code === 'KeyM') {
    // M：有任何一个开着就全关，全关时就全开
    const on = !(audio.musicOn || audio.sfxOn);
    setSound('music', on);
    setSound('sfx', on);
    showTip(t(on ? 'tipUnmuted' : 'tipMuted'));
  }
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
  steerVis: 0, shake: 0, spin: 0, boostFx: 0, energy: 0, flipT: 0, flipDir: 1, coyote: 0, jumpBuf: 0,
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
  vmax: document.getElementById('hud-vmax'),
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
// 音乐 / 音效开关（左下角两个按钮，选择记在本机）
// ---------------------------------------------------------------------------
const soundBtns = { music: document.getElementById('btn-music'), sfx: document.getElementById('btn-sfx') };

function setSound(kind, on) {
  if (kind === 'music') audio.setMusicOn(on); else audio.setSfxOn(on);
  soundBtns[kind].setAttribute('aria-pressed', String(on));
  store.set(kind + 'On', on);
}

for (const kind of ['music', 'sfx']) {
  setSound(kind, store.get(kind + 'On') !== false);
  soundBtns[kind].addEventListener('click', (e) => {
    setSound(kind, !(kind === 'music' ? audio.musicOn : audio.sfxOn));
    e.currentTarget.blur(); // 不留焦点，免得比赛中按空格又触发这个按钮
  });
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
    board.myName = v;
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

const lbView = { mode: 'endless' };
const board = new Leaderboard(() => renderBoard());
board.myName = nickname;

// 生存模式显示全球榜（连不上时改用本机成绩）；竞速只有本机榜
function renderBoard() {
  const global = board.isGlobal(lbView.mode);
  const scope = global && board.status !== 'error' ? 'global' : 'local';
  document.querySelectorAll('#lb-mode button').forEach((b) => b.classList.toggle('on', b.dataset.lbmode === lbView.mode));

  let note = '';
  if (!global) note = t('lbRaceLocal');
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
    const isMe = scope === 'global' && board.isMe(r);
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
  if (board.status !== 'off') board.refresh();
  demoTrack();
}

function startGame(mode) {
  audio.init();
  audio.click();
  if (game.track) game.track.dispose();
  const seed = mode === 'race' ? PHYS.RACE_SEED : (Math.random() * 1e9) | 0;
  game.track = new Track(seed, mode, scene, mats);
  // 峡谷开场：不倒计时，赛车从远处以极速冲过来、从镜头下面穿过，镜头转身跟上后交给玩家
  const intro = TRACK_STYLE.canyon;
  game.vmaxMul = 1; // 新的一局极速倍数从 1 开始（下面算开场车速要用）
  game.form = 0; game.tf = null; game.superT = 0; game.flips = 0; game.flipCap = PHYS.MAX_FLIPS;
  if (car.setForm) { car.setForm(0); car.setGlow(0, 0, GLOW); car.setGlow(1, 0, GLOW); }
  Object.assign(game, {
    mode, state: intro ? 'intro' : 'countdown', s: intro ? INTRO_CAM.start : 0, a: 5.5, h: 0, v: intro ? vmaxAt(0) : 0, vh: 0, air: false,
    introT: 0, introPassed: false, vmaxMul: 1, brakeHeld: false,
    time: 0, countdown: 3.2, lastBeep: 4, lost: false, lostT: 0, reason: '', boostT: 0, lastTile: null,
    camA: 5.5, camH: 0, camFrozen: false, steerVis: 0, shake: 0, spin: 0, boostFx: 0, energy: 0, flipT: 0, flipDir: 1, coyote: 0, jumpBuf: 0,
  });
  game.camUp.set(0, 1, 0);
  jumpQueued = false;
  car.group.visible = true;
  trails.forEach((t) => { t.reset(); t.mesh.visible = true; });
  audio.musicLevel = 1;
  show(ui.menu, false); show(ui.pause, false); show(ui.result, false); show(ui.hud, !intro);
  if (intro) camera.fov = INTRO_CAM.fov;
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
    if (!TEST_BOOST && (!best || game.time < best)) { store.set('bestRace', game.time); r.record = true; }
    score = game.time;
  } else if (mode === 'endless') {
    const best = store.get('bestEndless');
    if (!TEST_BOOST && (!best || game.s > best)) { store.set('bestEndless', game.s); r.record = true; } // 测试赛道不记最好成绩
    score = Math.floor(game.s);
  }
  r.progress = Math.floor(Math.min(1, game.s / game.track.goal) * 100);
  lastResult = r;
  renderResult();
  show(ui.result, true);
  if (score > 0) {
    r.uploading = true;
    (TEST_BOOST ? Promise.resolve({}) : board.submit(mode, nickname, score, { time: game.time })).then((out) => { // 测试赛道成绩不上传
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
const tmpV3 = new THREE.Vector3();
const tmpV4 = new THREE.Vector3();
const qShadow = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); // 平面躺平到车身底下

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

// 极速 = 基础极速（随难度从 62 涨到 72）× 极速倍数 vmaxMul（开得稳慢慢涨，减速就扣，见 updateVmaxMul）
function vmaxAt(s) { return (PHYS.VMAX + PHYS.VMAX_BONUS * Math.min(1, game.track.difficulty(s))) * (game.vmaxMul || 1); }

// 极速成长：不刹车、不在减速道上时，每 10 秒多基础极速的 3%（没有上限，跳跃不影响）；
// 按下刹车（按住不放只算一次）扣掉当前极速的 25%；开在减速道上每秒扣 25%
function updateVmaxMul(dt, braking, onSlow) {
  if (braking && !game.brakeHeld) game.vmaxMul *= 0.75;
  game.brakeHeld = braking;
  // 变身成超跑：成长翻倍（每 10 秒 +6%），减速道只扣每秒 15%
  const sup = game.form === 1;
  if (onSlow) game.vmaxMul *= Math.pow(sup ? 0.85 : 0.75, dt);
  else if (!braking) game.vmaxMul += (sup ? 0.006 : 0.003) * (TEST_BOOST ? 10 : 1) * dt; // 测试赛道成长快 10 倍
  game.vmaxMul = Math.max(0.3, game.vmaxMul);
}

function airJump() {
  game.vh = PHYS.JUMP_V * PHYS.AIR_JUMP_MUL;
  game.flips--;
  if (game.flips < game.flipCap && game.energy >= 1) game.energy = 0;
  audio.airJump();
  showTip(t('tipAirJump'), 0.8);
  game.shake = Math.max(game.shake, 0.35);
  game.flipT = PHYS.FLIP_TIME;
  // 横滚方向跟着正在按的方向键，没按就默认向左滚
  game.flipDir = game.steerVis < -0.1 ? -1 : 1;
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

// 车身中间一段（中心和左右两侧）下面的平台
function midSupport(s, a) {
  const tr = game.track, W = PHYS.CAR_HALF_W;
  return tr.laneAt(s, laneIndex(a)) || tr.laneAt(s, laneIndex(a - W)) || tr.laneAt(s, laneIndex(a + W));
}

// 车身附近是不是某条道的起点（道的开头，或洞的后沿）：车头已经压上、车身还在起点后 START_ZONE 米以内
function nearLaneStart(s, a) {
  const tr = game.track, W = PHYS.CAR_HALF_W, L = PHYS.CAR_HALF_L;
  for (const aa of [a, a - W, a + W]) {
    const lane = tr.laneRaw(s + L, laneIndex(aa));
    if (!lane || lane.gone) continue;
    let start = lane.s0;
    for (const [h0, h1] of lane.holes || []) if (h1 <= s + L && h1 > start) start = h1;
    if (s + L >= start && s - start < PHYS.START_ZONE) return true;
  }
  return false;
}

// 车身下面有没有平台：中间一段之外，车头已经压上平台、或车尾还在平台上也算
function supportAt(s, a) {
  const L = PHYS.SUPPORT_HALF_L;
  return midSupport(s, a) || midSupport(s + L, a) || midSupport(s - L, a);
}

function groundJump() {
  game.vh = PHYS.JUMP_V;
  game.air = true;
  game.coyote = 0;
  game.jumpBuf = 0;
  audio.jump();
}

// 赛道提示：新赛道第一次出现前说明它的作用；大空隙前提醒走加速赛道或连跳
function trackHints() {
  for (const sec of game.track.upcoming(game.s)) {
    if (sec.intro !== undefined && !sec.introShown && sec.s0 - game.s < 140) {
      sec.introShown = true;
      showTip(t('intro' + sec.intro), 2.6);
    }
    if (sec.bigGapNext && !sec.cliffShown && game.s > sec.s0 && sec.s1 - game.s < 200) {
      sec.cliffShown = true;
      showTip(t('tipCliff'), 2.4);
    }
  }
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

  let nextA = wrapLane(game.a + steer * (game.air ? PHYS.STEER_AIR : PHYS.STEER_GROUND) * (game.form === 1 ? PHYS.SUPER_STEER : 1) * dt);
  // 陨石外表面模式：在地面上开到陨石边缘就按不过去（空中可以左右移动去对准下一块）
  if (TRACK_STYLE.outside && !game.air && steer) {
    const edge = nextA + steer * PHYS.CAR_HALF_W;
    if (!tr.laneAt(game.s, laneIndex(edge)) && tr.laneAt(game.s, laneIndex(game.a))) nextA = game.a;
  }
  // 峡谷里两边是岩壁，开不上去
  const lim = tr.steerRange(game.s, game.a);
  if (lim) nextA = THREE.MathUtils.clamp(nextA, lim[0], lim[1]);
  game.a = nextA;

  if (!game.air) {
    const tile = supportAt(game.s, game.a);
    if (!tile) {
      game.air = true;
      game.vh = 0;
      game.lastTile = null;
      game.coyote = PHYS.COYOTE; // 刚开出边缘的一小段时间里仍可以普通起跳
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
        if (theme && theme.jet) {
          // 石头主题：车底下猛地喷出一股气，把车顶上去
          tr.path.point(game.s, game.a, 0, tmpV);
          theme.jet(tmpV, tmpV2.copy(tr.path.r).negate());
        } else particles.emit(car.group.position, tmpV.set(0, 0, 0), 5, TYPE_COLORS[TYPE.BOUNCE], 0.6, 40);
      }
      if (!game.air) {
        if (braking) game.v = Math.max(0, game.v - PHYS.BRAKE * dt);
        else if (game.v < cap) game.v = Math.min(cap, game.v + (vmax / (game.form === 1 ? PHYS.ACCEL_TIME_SUPER : PHYS.ACCEL_TIME)) * dt);
        else if (game.boostT <= 0 || tile.type === TYPE.SLOW) game.v = Math.max(cap, game.v - (tile.type === TYPE.SLOW ? 90 : 18) * dt);
        if (jumpQueued || game.jumpBuf > 0) {
          groundJump();
          jumped = true;
        }
        // 在赛道上行驶的距离积累连跳能量：攒满一次就多一次翻滚跳，最多攒 flipCap 次（满了能量条停在 100%）
        if (game.flips < game.flipCap) {
          game.energy += (game.v * dt) / PHYS.ENERGY_DIST;
          if (game.energy >= 1) {
            game.flips++;
            game.energy = game.flips < game.flipCap ? 0 : 1;
            audio.ready(); showTip(t('tipReady'), 1.2);
          }
        } else game.energy = 1;
      }
    }
  }
  // 空中按空格：
  // 1. 刚开出边缘（宽限时间内）→ 算普通起跳，不耗能量
  // 2. 快要落地（离平台很近）→ 先记下来，落地瞬间自动起跳，不浪费连跳能量
  // 3. 否则能量满时连跳，用完重新积累
  if (jumpQueued && game.air && !jumped) {
    const nearLanding = game.vh < 0 && game.h > -PHYS.LAND_TOL && game.h < 0.8 && supportAt(game.s + game.v * 0.06, game.a);
    if (game.coyote > 0) groundJump();
    else if (nearLanding) game.jumpBuf = PHYS.JUMP_BUFFER;
    else if (game.flips > 0) airJump();
    else { game.jumpBuf = PHYS.JUMP_BUFFER; showTip(t('tipNoEnergy'), 0.7); }
  }
  jumpQueued = false;
  game.coyote = Math.max(0, game.coyote - dt);
  game.jumpBuf = Math.max(0, game.jumpBuf - dt);

  if (game.air) {
    game.vh -= PHYS.G * dt;
    game.h += game.vh * dt;
    if (game.h > PHYS.MAX_H) { game.h = PHYS.MAX_H; game.vh = Math.min(game.vh, 0); }
    if (braking) game.v = Math.max(PHYS.AIR_MIN_V, game.v - PHYS.AIR_BRAKE * dt);
    if (game.h <= 0 && game.vh <= 0) {
      // 车身中间落在平台上：有一定容差；只有车头/车尾压上：必须几乎齐平，避免直接开过空隙
      const mid = midSupport(game.s, game.a);
      const tile = mid || supportAt(game.s, game.a);
      // 刚到一条道的起点（道的开头、洞的后沿）：车比路面低一些也算落上去，直接托回路面，不判掉落
      const atStart = tile && nearLaneStart(game.s, game.a);
      const tol = atStart ? PHYS.START_LAND_TOL : PHYS.UNDER_TOL;
      if (tile && game.h > -tol) {
        const impact = -game.vh;
        game.h = 0;
        game.vh = 0;
        game.air = false;
        game.coyote = 0;
        game.landK = Math.min(1, impact / 18);
        if (impact > 5) {
          audio.land();
          game.shake = Math.max(game.shake, Math.min(0.5, impact * 0.025));
          // 石头主题：落地扬起一团尘土；霓虹主题：赛道颜色的光点
          if (TRACK_STYLE.slab) particles.emit(car.group.position, tmpV.set(0, 0, 0), 5, '#5a4e42', 0.6, 40);
          else particles.emit(car.group.position, tmpV.set(0, 0, 0), 4, TYPE_COLORS[tile.type], 0.5, 30);
        }
      } else if ((tile && !atStart && game.h <= -PHYS.UNDER_TOL) || game.h <= -PHYS.RESCUE_DEPTH) {
        // 撞到平台底下，或已经掉得太深：没救了。在这之前还能用连跳救回来
        lose('fall');
        return;
      }
    }
  }

  updateVmaxMul(dt, braking, !game.air && !!game.lastTile && game.lastTile.type === TYPE.SLOW);
  game.boostT -= dt;
  trackHints();
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
const FLIP_PIVOT = new THREE.Vector3(0, 0.4, 0); // 横滚绕车身中心转

function shortestLaneDelta(from, to) {
  let d = to - from;
  if (TRACK_STYLE.outside) return d; // 外表面模式赛道不首尾相接
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
  // 前进方向按赛道上前后两点算（分岔时两半往两边分开，方向和管道中轴线不一样）
  const fwd = path.point(game.s + 1, game.a, game.h, tmpV2).sub(car.group.position).normalize();
  up.addScaledVector(fwd, -up.dot(fwd)).normalize();
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
    // 连跳时整车绕车身纵轴侧向横滚一圈（车顶先朝滚动方向倒过去）
    game.flipT = Math.max(0, game.flipT - dt);
    const k = 1 - game.flipT / PHYS.FLIP_TIME;
    const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    car.body.quaternion.setFromAxisAngle(AX_Z, -game.flipDir * ease * Math.PI * 2);
    car.body.position.copy(FLIP_PIVOT).applyQuaternion(car.body.quaternion).negate().add(FLIP_PIVOT);
  } else {
    // 悬挂：车身随石头路面的起伏轻微颠簸、左右晃（按走过的距离算，越快颠得越细碎）；
    // 落地时往下一沉再弹回来
    game.landK = Math.max(0, (game.landK || 0) - dt * 3.5);
    const s = game.s;
    const road = game.air ? 0 : 1;
    const bob = road * (0.022 * Math.sin(s * 2.3) + 0.013 * Math.sin(s * 5.1 + 1) + 0.006 * Math.sin(s * 11.7 + 2))
      - 0.16 * game.landK * Math.cos(game.landK * 9);
    qSpin.setFromAxisAngle(AX_Z, road * (0.007 * Math.sin(s * 1.3 + 2) + 0.003 * Math.sin(s * 4.7)));
    car.body.quaternion.setFromAxisAngle(AX_X, road * 0.005 * Math.sin(s * 1.9) + 0.03 * game.landK);
    car.body.quaternion.multiply(qSpin);
    car.body.position.set(0, bob, 0);
  }

  // 接触阴影
  if (!game.lost && game.h < 6) {
    path.point(game.s, game.a, 0.11, contactShadow.position);
    const fade = THREE.MathUtils.clamp(1 - Math.max(0, game.h) / 5, 0, 1);
    contactShadow.visible = true;
    contactShadow.material.opacity = 0.95 * fade * fade;
    contactShadow.quaternion.copy(car.group.quaternion).multiply(qShadow);
    const k = 1 + Math.max(0, game.h) * 0.12;
    contactShadow.scale.set(2.6 * k, 5.4 * k, 1);
  } else contactShadow.visible = false;

  // 贴地时后轮扬起石屑尘土
  if ((game.state === 'playing' || game.state === 'intro') && !game.air && !game.lost) {
    car.group.updateMatrixWorld();
    const norm0 = game.v / vmaxAt(game.s);
    if (TRACK_STYLE.slab && Math.random() < 0.35 + 0.5 * norm0) {
      for (const sx of [-0.85, 0.85]) {
        tmpV3.set(sx, 0.08, -1.7).applyMatrix4(car.group.matrixWorld);
        particles.emit(tmpV3, tmpV4.copy(up).multiplyScalar(1.5 + Math.random() * 2).addScaledVector(fwd, 4), 1.2, '#2a241f', 0.3, 1);
      }
    }
  }

  // 轮子随车速转动（空中也继续空转）
  for (const w of car.wheels) w.rotation.x += (game.v * dt / car.wheelRadius) * car.wheelDir;

  // 尾焰
  const norm = game.v / vmaxAt(game.s);
  car.engineMat.color.setRGB(0.24, 0.78, 1.0).multiplyScalar(0.9 + norm * 1.3); // 越快喷口越亮
  car.group.updateMatrixWorld();
  const upW = up.clone();
  trails.forEach((tr, i) => {
    const nz = car.nozzles[i];
    tr.mesh.visible = !!nz && !game.lost;
    if (!nz) return;
    if (car.trailColor) tr.color.set(car.trailColor);
    nozzleW.copy(nz).applyMatrix4(car.group.matrixWorld);
    // 拖尾长度随车速变长：加速平台的最高速度（极速 × 1.4）时达到上限 trailLength
    const lenK = THREE.MathUtils.clamp(norm / 1.4, 0, 1);
    tr.push(nozzleW, upW, car.trailWidth ?? 0.22, (0.4 + norm * 1.2) * (car.trailIntensity ?? 1), (car.trailLength ?? 12) * lenK);
  });
  if (game.boostT > 0 && car.nozzles.length && Math.random() < 0.3) {
    particles.emit(nozzleW, fwd.clone().multiplyScalar(-10), 2, '#00a89f', 0.3, 1);
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
    path.point(game.s - 11 - high * 0.8, game.camA, 3.6 + ch * 0.55 + high * 0.45, camera.position); // 固定镜头，离车稍远一点
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
  // 速度模糊：随车速变强（起步几乎没有，极速时明显），先做得偏弱
  boostPass.uniforms.uSpeed.value = game.lost ? 0 : 0.55 * THREE.MathUtils.smoothstep(norm, 0.3, 1.1);
  updateDebris(path);
  bloom.strength = 0.6;
  updateTunnelFocus(dt);
  speedLines.update(dt, path, game.s, game.a, game.lost ? 0 : game.v, game.lost ? 0 : norm, game.boostFx);
}

// 近处碎石：在车前方 40～140 米的管道空中刷出来，离开镜头后面就换到前面去；避开车和镜头正前方的视线
const debrisDummy = new THREE.Object3D();
function spawnDebris(o, ahead) {
  o.s = game.s + ahead;
  do { o.a = Math.random() * LANES; } while (Math.abs(shortestLaneDelta(o.a, game.a)) < 1.3);
  o.h = 1 + Math.random() * 6.5;
  o.sc = 0.06 + Math.pow(Math.random(), 2.5) * 0.35;
  o.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
}
function updateDebris(path) {
  const on = !!TRACK_STYLE.slab && !TRACK_STYLE.outside;
  debris.mesh.visible = on;
  if (!on) return;
  debris.items.forEach((o, i) => {
    if (o.s < game.s - 14 || o.s > game.s + 200) spawnDebris(o, o.s < -1e8 ? 10 + Math.random() * 130 : 40 + Math.random() * 100);
    path.point(o.s, o.a, o.h, debrisDummy.position);
    debrisDummy.rotation.copy(o.rot);
    debrisDummy.scale.setScalar(o.sc);
    debrisDummy.updateMatrix();
    debris.mesh.setMatrixAt(i, debrisDummy.matrix);
  });
  debris.mesh.instanceMatrix.needsUpdate = true;
}

// 隧道中心（前方管道中轴线上的点）在屏幕上的位置：加速残影以它为圆心，
// 管道弯曲、扭转时跟着移动
const tunnelPt = new THREE.Vector3();
const tunnelUv = new THREE.Vector2(0.5, 0.56);
const tunnelUvTarget = new THREE.Vector2();

function updateTunnelFocus(dt) {
  camera.updateMatrixWorld();
  // 管道模式：前方管道中轴线；外表面模式：前方赛道上空一点
  if (TRACK_STYLE.outside) game.track.path.point(game.s + 60, game.camA, 2, tunnelPt);
  else game.track.path.point(game.s + 60, game.camA, R, tunnelPt); // 管道（分岔时是车所在那一半）的中轴线
  const k = 1 - Math.exp(-dt * 6);
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

// 开场运镜：镜头贴着谷底、全程以玩家的极速往前飞（地面流过的速度和玩家接手后完全一样），同时回头看；
// 赛车从后面远处追上来：一开始比镜头快很多，越接近越慢，从镜头斜下方超过去后，
// 正好停在跟车镜头前面 lead 米、和镜头同速——镜头转身就是玩家视角，速度、声音都不用变。
// 赛车相对镜头的位置 x(t) = -gap + (gap + lead)·(1 - (1 - t/T)²)，T 秒时相对速度降到 0
const INTRO_CAM = { cam: -40, gap: 30, lead: 11, T: 1.0, camA: 5.95, camH: 2.2, blend: 0.5, fov: 80 };
INTRO_CAM.start = INTRO_CAM.cam - INTRO_CAM.gap;
const introFix = new THREE.Vector3();
const introLook = new THREE.Vector3();

// 赛车超过镜头的时刻：x(t) = 0
function introPassT() { const c = INTRO_CAM; return c.T * (1 - Math.sqrt(c.lead / (c.gap + c.lead))); }
function introCamS() { return INTRO_CAM.cam + game.v * game.introT; }

// 变身：车速到 SUPER_KMH 时，四面八方的流光冲向车身、把整台车裹成一团光，
// 光里的轮廓变成超跑，光再慢慢褪去。超跑至少保持 SUPER_HOLD 秒，之后车速低于 SUPER_KMH 就用同样的方式变回去
const GLOW = new THREE.Color(0.55, 0.95, 1.0);
const TF = { gather: 1.2, total: 2.8 }; // 流光聚拢 1.2 秒，换车身后光褪去 1.6 秒
function updateTransform(dt) {
  if (!car.forms || car.forms.length < 2 || game.lost) return;
  const kmh = Math.round(game.v * KMH); // 和仪表盘显示的一样：显示到 500 就变
  if (!game.tf) {
    if (game.form === 0 && kmh >= PHYS.SUPER_KMH) game.tf = { t: 0, to: 1, swapped: false };
    else if (game.form === 1) {
      game.superT -= dt;
      if (game.superT <= 0 && kmh < PHYS.SUPER_KMH) game.tf = { t: 0, to: 0, swapped: false };
    }
    if (!game.tf) return;
  }
  const tf = game.tf;
  tf.t += dt;
  const pos = car.group.position;
  const path = game.track.path;
  if (tf.t < TF.gather) {
    // 流光：从车四周一圈往车身冲，跟着车一起往前跑
    const k = tf.t / TF.gather;
    car.setGlow(game.form, k * k, GLOW);
    path.point(game.s, game.a, 0, tmpV);
    const up = tmpV3.copy(path.r).negate();
    const fwd = tmpV4.copy(path.frame(game.s).t);
    const side = tmpV2.crossVectors(up, fwd).normalize();
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2, R = 3 + 5 * (1 - k) + Math.random() * 2;
      const off = new THREE.Vector3().addScaledVector(side, Math.cos(ang) * R).addScaledVector(up, Math.abs(Math.sin(ang)) * R * 0.7 + 0.5).addScaledVector(fwd, (Math.random() - 0.3) * 4);
      const p = off.clone().add(pos);
      const vel = fwd.clone().multiplyScalar(game.v).addScaledVector(off.normalize(), -28);
      particles.emit(p, vel, 0.5, Math.random() < 0.5 ? '#9ff6ff' : '#ffffff', 0.22, 1);
    }
  } else {
    if (!tf.swapped) {
      // 被光完全裹住的一瞬间换车身
      tf.swapped = true;
      car.setGlow(game.form, 0, GLOW);
      game.form = tf.to;
      car.setForm(game.form);
      game.shake = Math.max(game.shake, 0.5);
      particles.emit(pos, tmpV.set(0, 0, 0), 9, '#c8fbff', 0.5, 60);
      audio.boost();
      if (tf.to === 1) {
        game.superT = PHYS.SUPER_HOLD;
        game.flipCap = PHYS.MAX_FLIPS_SUPER; // 第一次变身后上限变成 2，变回 F1 也不降
        game.flips = Math.min(game.flipCap, game.flips + 1);
        if (game.flips < game.flipCap) game.energy = Math.min(game.energy, 0.999);
      }
    }
    const k = Math.min(1, (tf.t - TF.gather) / (TF.total - TF.gather));
    car.setGlow(game.form, 1 - k, GLOW);
    if (tf.t >= TF.total) { car.setGlow(game.form, 0, GLOW); game.tf = null; }
  }
}

function updateIntro(dt) {
  const c = INTRO_CAM;
  game.introT += dt;
  const u = Math.min(1, game.introT / c.T);
  game.s = introCamS() - c.gap + (c.gap + c.lead) * (1 - (1 - u) * (1 - u));
  if (!game.introPassed && game.s > introCamS() - 2) {
    game.introPassed = true;
    game.shake = 0.35;
  }
  if (game.introT >= Math.max(INTRO_CAM.T, introPassT() + INTRO_CAM.blend)) {
    game.state = 'playing';
    show(ui.hud, true);
    show(ui.countdown, true);
    ui.countdown.textContent = 'GO!';
    ui.countdown.classList.remove('pop'); void ui.countdown.offsetWidth; ui.countdown.classList.add('pop');
    setTimeout(() => show(ui.countdown, false), 700);
    jumpQueued = false;
  }
}

function updateIntroCamera(dt) {
  const path = game.track.path;
  const shake = game.shake;
  game.shake = 0;
  updateCamera(dt); // 先算出正常跟车的镜头
  const t = THREE.MathUtils.clamp((game.introT - introPassT() + 0.05) / INTRO_CAM.blend, 0, 1);
  const k = 1 - Math.pow(1 - t, 2.2); // 车一穿过去镜头就跟上，越接近跟车位置越慢
  // 沿赛道方向镜头始终和玩家同速（结束时正好在车后 lead 米 = 跟车位置），只有左右、高度慢慢过渡到跟车镜头
  const chaseH = 3.6 + Math.max(-1, game.camH) * 0.55;
  path.point(introCamS(), INTRO_CAM.camA + (game.camA - INTRO_CAM.camA) * k, INTRO_CAM.camH + (chaseH - INTRO_CAM.camH) * k, introFix);
  introLook.copy(car.group.position).addScaledVector(game.camUp, 0.5);
  camera.position.copy(introFix);
  if (shake > 0) {
    camera.position.add(tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(shake * 0.5));
    game.shake = Math.max(0, shake - dt * 1.5);
  }
  introLook.lerp(lookAt, k);
  camera.lookAt(introLook);
  const vmax = vmaxAt(game.s);
  camera.fov = INTRO_CAM.fov + (70 + 16 * Math.min(game.v / vmax, 1) - INTRO_CAM.fov) * k;
  camera.updateProjectionMatrix();
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
  boostPass.uniforms.uSpeed.value = 0;
  debris.mesh.visible = false;
  contactShadow.visible = false;
  bloom.strength = 0.6;
  speedLines.update(dt, path, game.s, game.camA, 34, 0.55, 0);
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
  if (ui.vmax) {
    const pct = Math.round((game.vmaxMul - 1) * 100);
    ui.vmax.textContent = `${pct >= 0 ? '+' : ''}${pct}%`;
    ui.vmax.classList.toggle('down', pct < 0);
  }
  ui.speedFill.style.width = `${Math.min(100, (game.v / (vmax * 1.4)) * 100)}%`;
  ui.speedFill.classList.toggle('boost', game.v > vmax * 1.02);
  const full = game.flips > 0;
  ui.energyFill.style.width = `${Math.floor(game.energy * 100)}%`;
  ui.energyPct.textContent = `×${game.flips}  ${Math.floor(game.energy * 100)}%`;
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
    } else if (st === 'intro') {
      updateIntro(dt);
    } else if (st === 'playing') {
      const sub = Math.ceil(dt / (1 / 120));
      for (let i = 0; i < sub && game.state === 'playing'; i++) physicsStep(dt / sub);
      if (game.state === 'playing') updateTransform(dt);
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
    if (st === 'intro') updateIntroCamera(dt); else updateCamera(dt);
    const vmax = vmaxAt(game.s);
    audio.setEngine(Math.min(1.3, game.v / vmax), !game.air, keys.has('brake'), (st === 'playing' || st === 'finished' || st === 'intro') && !game.lost);
    updateHud();
  }
  if (st === 'paused' || st === 'menu') audio.setEngine(0, true, false, false);

  particles.update(dt);
  if (theme && game.track) theme.update(dt, game.track.path, game.s, game.track, camera);
  updateShockwave(dt);
  bg.update(camera.position, game.clock);
  composer.render();
}

// 调试用：在控制台查看状态或手动推进帧
window.__game = game;
window.__fx = { THREE, bloom, boostPass, mats, car, speedLines, trails, renderer, scene };
window.__tick = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); };

// ---------------------------------------------------------------------------
// 美术素材：读取 assets/level1/manifest.json，替换美术已经提供的部分（异步，不阻塞开局）
// ---------------------------------------------------------------------------
async function applyArt() {
  const art = await loadManifest();
  const tx = art.textures || {};
  if (!theme) await applyTrackArt(mats, art); // 光环主题用自己的陨石材质
  await applyBackgroundArt(bg, art, scene);
  await applyCarArt(car, art);
  // 提前把两台车的着色器编译好、贴图传到显卡：否则第一次变身时超跑才第一次被画出来，会卡一下
  if (car.forms && car.forms.length > 1) {
    const wasVisible = car.group.visible;
    car.group.visible = true;
    for (const f of car.forms) f.model.visible = true;
    car.group.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (m && m[k]) renderer.initTexture(m[k]);
    });
    // 真的经过后期效果画一帧（后期效果是画到离屏缓冲里的，着色器版本和直接画到屏幕不一样，要按实际流程编译）
    const keepPos = car.group.position.clone();
    camera.getWorldDirection(tmpV);
    car.group.position.copy(camera.position).addScaledVector(tmpV, 30);
    car.group.updateMatrixWorld(true);
    renderer.compile(scene, camera);
    composer.render();
    car.group.position.copy(keepPos);
    car.setForm(game.form || 0);
    car.group.visible = wasVisible;
  }
  await each([['star_particle', tx.star_particle]], async (key, file) => swapImage(STAR_TEX, await loadImage(file)));
  await each([['shockwave', tx.shockwave]], async (key, file) => {
    shockwave.material.map = await loadTexture(file);
    shockwave.material.color.set(0xffffff);
    shockwave.material.needsUpdate = true;
  });
  const ui = art.ui || {};
  await each([['logo', ui.logo]], async (key, file) => {
    const img = await loadImage(file);
    img.className = 'logo';
    img.alt = 'Star Rift 星轨断桥';
    document.querySelector('#menu h1').replaceChildren(img);
  });
  await each([['favicon', ui.favicon]], async (key, file) => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = ASSET_BASE + encodeURI(file);
    document.head.append(link);
  });
}

// 画面主题：网址加 ?theme=rings 是 J1407b 光环主题，要在生成第一条赛道之前设置好
const theme = isRingsTheme() ? setupRingsTheme({ scene, mats, bg, bloom }) : null;

applyArt();
refreshTexts();
toMenu();
frame();
