import * as THREE from './lib.js';
import { each, loadImage, swapImage } from './assets.js';

// ---- 管道几何常量 ----
export const LANES = 10;
export const R = 9;                         // 管道半径（赛道所在的面）
export const LANE_ANG = (Math.PI * 2) / LANES;
export const WALL_H = 1.6;                  // 障碍墙高度
const STEP = 1;                             // 中心线采样间隔
const THICK = 0.5;                          // 平台厚度

export const TYPE = { NORMAL: 0, BOOST: 1, SLOW: 2, OBSTACLE: 3, SHORT: 4, CRUMBLE: 5, BOUNCE: 6 };
export const TYPE_COLORS = ['#3aa8ff', '#00fff0', '#b04dff', '#ff3355', '#ffd23a', '#ff8a1f', '#3dff8a'];
export const TYPE_NAMES = ['普通', '加速', '减速', '障碍', '短台', '碎裂', '弹射'];
const SAFE_TYPES = [TYPE.NORMAL, TYPE.BOOST, TYPE.SLOW, TYPE.BOUNCE];
// 认识阶段依次引入的新赛道
const INTRO = [TYPE.BOUNCE, TYPE.SLOW, TYPE.SHORT, TYPE.OBSTACLE, TYPE.CRUMBLE];

// 材质槽位：0..6 平台顶面，7 侧面，8..14 端头发光条，15 障碍墙，16 终点格
const SLOT_SIDE = 7, SLOT_EDGE = 8, SLOT_WALL = 15, SLOT_FINISH = 16;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
export const wrapLane = (a) => ((a % LANES) + LANES) % LANES;
export const laneIndex = (a) => Math.floor(wrapLane(a)) % LANES;
// 两条赛道在圆周上相隔几条
const laneDist = (a, b) => Math.min((a - b + LANES) % LANES, (b - a + LANES) % LANES);

// ---------------------------------------------------------------------------
// Path：在太空中弯曲的管道中心线 + 平行移动标架 + 扭转角
// ---------------------------------------------------------------------------
export class Path {
  // curveAmpFn(s)：弯道强度（0 = 笔直，1 = 断崖阶段的强度），由赛道按难度阶段提供
  constructor(seed, difficultyFn, curveAmpFn = () => 1) {
    const rnd = mulberry32(seed * 7 + 13);
    this.ph = Array.from({ length: 8 }, () => rnd() * Math.PI * 2);
    this.diff = difficultyFn;
    this.curveAmp = curveAmpFn;
    this.calm = []; // 拉直区间 [起点, 终点]：大空隙前后不弯，保证关键跳跃看得见
    this.YAW = [0];
    this.PITCH = [0];
    const t0 = this.dir(0, 0);
    const n0 = new THREE.Vector3(0, -1, 0);
    n0.addScaledVector(t0, -n0.dot(t0)).normalize();
    this.P = [new THREE.Vector3()];
    this.T = [t0];
    this.N = [n0];
    this.TW = [0];
    // 临时变量
    this.f = { p: new THREE.Vector3(), t: new THREE.Vector3(), n: new THREE.Vector3(), b: new THREE.Vector3(), tw: 0 };
    this.r = new THREE.Vector3();
  }

  dir(yaw, pitch) {
    return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  }

  // 拉直程度：在拉直区间里弯道强度降到 15%，边缘 30 米平滑过渡
  calmFactor(s) {
    let k = 1;
    for (const [a, b] of this.calm) {
      const edge = Math.min(clamp((s - (a - 30)) / 30, 0, 1), clamp(((b + 30) - s) / 30, 0, 1));
      k = Math.min(k, 1 - 0.85 * edge);
    }
    return k;
  }

  // 每米转多少弧度（左右、上下），弯道强度 × 拉直程度
  bendRates(s) {
    const ph = this.ph;
    const amp = this.curveAmp(s) * this.calmFactor(s) * clamp(s / 400, 0, 1);
    const yawRate = amp * 0.0038 * (0.45 * Math.sin(s * 0.0012 + ph[0]) + 0.55 * Math.sin(s * 0.0029 + ph[1]));
    const pitchRate = amp * 0.0018 * (Math.sin(s * 0.0016 + ph[2]) + 0.6 * Math.sin(s * 0.0037 + ph[3]));
    return [yawRate, pitchRate];
  }

  twistRate(s) {
    const ph = this.ph;
    const ramp = clamp((s - 250) / 400, 0, 1);
    const d = this.diff(s);
    const amp = ramp * (0.003 + 0.0075 * Math.min(d, 1.2));
    return amp * (Math.sin(s * 0.0021 + ph[4]) + 0.6 * Math.sin(s * 0.0057 + ph[5]));
  }

  ensure(s) {
    while ((this.P.length - 1) * STEP < s + 2) {
      const i = this.P.length - 1;
      // 方向按弯道速率一点点累加；俯仰角带一点回正，不会越爬越陡
      const [yr, pr] = this.bendRates((i + 0.5) * STEP);
      const yaw = this.YAW[i] + yr * STEP;
      const pitch = this.PITCH[i] + (pr - 0.0025 * this.PITCH[i]) * STEP;
      this.YAW.push(yaw);
      this.PITCH.push(pitch);
      const tNext = this.dir(yaw, pitch);
      const p = this.P[i].clone().addScaledVector(this.T[i].clone().add(tNext).normalize(), STEP);
      const n = this.N[i].clone();
      n.addScaledVector(tNext, -n.dot(tNext)).normalize();
      this.P.push(p);
      this.T.push(tNext);
      this.N.push(n);
      this.TW.push(this.TW[i] + this.twistRate((i + 0.5) * STEP) * STEP);
    }
  }

  frame(s) {
    const f = this.f;
    let extra = 0;
    if (s < 0) { extra = s; s = 0; }
    this.ensure(s);
    const x = s / STEP;
    const i = Math.min(Math.floor(x), this.P.length - 2);
    const k = x - i;
    f.p.lerpVectors(this.P[i], this.P[i + 1], k);
    f.t.lerpVectors(this.T[i], this.T[i + 1], k).normalize();
    f.n.lerpVectors(this.N[i], this.N[i + 1], k);
    f.n.addScaledVector(f.t, -f.n.dot(f.t)).normalize();
    f.b.crossVectors(f.t, f.n);
    f.tw = lerp(this.TW[i], this.TW[i + 1], k);
    if (extra) f.p.addScaledVector(f.t, extra);
    return f;
  }

  // 管道坐标 (s 沿程, a 赛道坐标 0..10, h 离开管壁朝中心的高度) → 世界坐标
  // 调用后 this.r 为该点的径向（指向管壁外侧），-r 即“上”
  point(s, a, h, out) {
    const f = this.frame(s);
    const th = (a - 5.5) * LANE_ANG + f.tw;
    this.r.copy(f.n).multiplyScalar(Math.cos(th)).addScaledVector(f.b, Math.sin(th));
    return out.copy(f.p).addScaledVector(this.r, R - h);
  }
}

// ---------------------------------------------------------------------------
// 几何构建：按材质槽位收集三角形，最后合并成一个 BufferGeometry
// ---------------------------------------------------------------------------
class GeoBuilder {
  constructor() { this.pos = []; this.uv = []; this.slots = new Map(); }

  grid(nu, nv, slot, fn) {
    const base = this.pos.length / 3;
    const v = new THREE.Vector3();
    for (let i = 0; i <= nv; i++) {
      for (let j = 0; j <= nu; j++) {
        const uvOut = fn(j / nu, i / nv, v);
        this.pos.push(v.x, v.y, v.z);
        this.uv.push(uvOut[0], uvOut[1]);
      }
    }
    if (!this.slots.has(slot)) this.slots.set(slot, []);
    const idx = this.slots.get(slot);
    const row = nu + 1;
    for (let i = 0; i < nv; i++) {
      for (let j = 0; j < nu; j++) {
        const a = base + i * row + j, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }

  curvedBox(path, a0, a1, s0, s1, h0, h1, topSlot, sideSlot, vScale = 16) {
    const ns = Math.max(1, Math.ceil((s1 - s0) / 3));
    const na = 4;
    const S = (v) => s0 + v * (s1 - s0);
    const A = (u) => a0 + u * (a1 - a0);
    const H = (u) => h0 + u * (h1 - h0);
    // 顶面（朝管道中心）
    this.grid(na, ns, topSlot, (u, v, out) => { path.point(S(v), A(u), h1, out); return [u, (S(v) - s0) / vScale]; });
    // 底面
    this.grid(na, ns, sideSlot, (u, v, out) => { path.point(S(v), A(u), h0, out); return [u, v]; });
    // 两个侧面
    this.grid(1, ns, sideSlot, (u, v, out) => { path.point(S(v), a0, H(u), out); return [u, v]; });
    this.grid(1, ns, sideSlot, (u, v, out) => { path.point(S(v), a1, H(u), out); return [u, v]; });
    // 前后端面
    this.grid(na, 1, sideSlot, (u, v, out) => { path.point(s0, A(u), H(v), out); return [u, v]; });
    this.grid(na, 1, sideSlot, (u, v, out) => { path.point(s1, A(u), H(v), out); return [u, v]; });
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const all = [];
    for (const [slot, idx] of [...this.slots.entries()].sort((x, y) => x[0] - y[0])) {
      g.addGroup(all.length, idx.length, slot);
      for (let k = 0; k < idx.length; k++) all.push(idx[k]);
    }
    g.setIndex(all);
    g.computeVertexNormals();
    return g;
  }
}

// ---------------------------------------------------------------------------
// 材质（程序生成的霓虹贴图）
// ---------------------------------------------------------------------------
function laneTexture(type) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  const col = TYPE_COLORS[type];
  x.fillStyle = '#060a16';
  x.fillRect(0, 0, 128, 256);
  // 细网格
  x.strokeStyle = 'rgba(90,130,220,0.16)';
  x.lineWidth = 2;
  for (let y = 0; y < 256; y += 32) { x.beginPath(); x.moveTo(0, y); x.lineTo(128, y); x.stroke(); }
  x.beginPath(); x.moveTo(64, 0); x.lineTo(64, 256); x.stroke();
  x.fillStyle = col;
  x.strokeStyle = col;
  if (type === TYPE.BOOST) {
    x.lineWidth = 12;
    for (let k = 0; k < 2; k++) {
      const y = 50 + k * 128;
      x.beginPath(); x.moveTo(24, y + 40); x.lineTo(64, y); x.lineTo(104, y + 40); x.stroke();
    }
  } else if (type === TYPE.SLOW) {
    for (let yy = 16; yy < 256; yy += 32) for (let xx = 24; xx < 128; xx += 40) {
      x.beginPath(); x.arc(xx + ((yy / 32) % 2) * 20, yy, 7, 0, Math.PI * 2); x.fill();
    }
  } else if (type === TYPE.CRUMBLE) {
    x.lineWidth = 3;
    const rnd = mulberry32(42);
    for (let k = 0; k < 9; k++) {
      x.beginPath();
      let px = rnd() * 128, py = rnd() * 256;
      x.moveTo(px, py);
      for (let s = 0; s < 4; s++) { px += (rnd() - 0.5) * 60; py += (rnd() - 0.5) * 60; x.lineTo(px, py); }
      x.stroke();
    }
  } else if (type === TYPE.BOUNCE) {
    x.lineWidth = 6;
    for (let k = 0; k < 2; k++) {
      x.beginPath(); x.arc(64, 64 + k * 128, 34, 0, Math.PI * 2); x.stroke();
      x.beginPath(); x.arc(64, 64 + k * 128, 14, 0, Math.PI * 2); x.fill();
    }
  } else if (type === TYPE.SHORT) {
    x.globalAlpha = 0.55;
    for (let y = -128; y < 256; y += 48) {
      x.beginPath(); x.moveTo(0, y); x.lineTo(128, y + 128); x.lineTo(128, y + 148); x.lineTo(0, y + 20); x.fill();
    }
    x.globalAlpha = 1;
  } else if (type === TYPE.OBSTACLE) {
    for (let y = 8; y < 256; y += 32) { x.fillRect(12, y, 10, 14); x.fillRect(106, y, 10, 14); }
  } else {
    x.globalAlpha = 0.5;
    for (let y = 8; y < 256; y += 64) x.fillRect(60, y, 8, 30);
    x.globalAlpha = 1;
  }
  // 两侧发光边
  x.fillStyle = col;
  x.fillRect(0, 0, 7, 256);
  x.fillRect(121, 0, 7, 256);
  return c;
}

function finishTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const x = c.getContext('2d');
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    x.fillStyle = (i + j) % 2 ? '#7a82a0' : '#0a0d18';
    x.fillRect(i * 32, j * 32, 32, 32);
  }
  return c;
}

function wallTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#300410';
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#ff2a4a';
  for (let k = -64; k < 64; k += 22) {
    x.beginPath(); x.moveTo(k, 0); x.lineTo(k + 11, 0); x.lineTo(k + 75, 64); x.lineTo(k + 64, 64); x.fill();
  }
  return c;
}

function toTex(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function createTrackMaterials() {
  const mats = [];
  for (let t = 0; t < 7; t++) {
    const tex = toTex(laneTexture(t));
    mats[t] = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.75,
      roughness: 0.45, metalness: 0.3, side: THREE.DoubleSide,
    });
  }
  mats[SLOT_SIDE] = new THREE.MeshStandardMaterial({ color: 0x0b1122, roughness: 0.7, metalness: 0.4, side: THREE.DoubleSide });
  for (let t = 0; t < 7; t++) {
    mats[SLOT_EDGE + t] = new THREE.MeshBasicMaterial({ color: new THREE.Color(TYPE_COLORS[t]).multiplyScalar(2.2), side: THREE.DoubleSide });
  }
  const wt = toTex(wallTexture());
  wt.repeat.set(3, 1);
  mats[SLOT_WALL] = new THREE.MeshStandardMaterial({
    map: wt, emissiveMap: wt, emissive: 0xffffff, emissiveIntensity: 1.4,
    transparent: true, opacity: 0.92, side: THREE.DoubleSide,
  });
  const ft = toTex(finishTexture());
  mats[SLOT_FINISH] = new THREE.MeshStandardMaterial({
    map: ft, emissiveMap: ft, emissive: 0xffffff, emissiveIntensity: 0.35, side: THREE.DoubleSide,
  });
  return mats;
}

// 美术素材替换：赛道顶面、障碍墙、终点格。只换图片，重复方式和发光设置不变
const ART_SLOTS = {
  lane_0_normal: TYPE.NORMAL, lane_1_boost: TYPE.BOOST, lane_2_slow: TYPE.SLOW, lane_3_obstacle: TYPE.OBSTACLE,
  lane_4_short: TYPE.SHORT, lane_5_crumble: TYPE.CRUMBLE, lane_6_bounce: TYPE.BOUNCE,
  wall_hazard: SLOT_WALL, finish_checker: SLOT_FINISH,
};

export async function applyTrackArt(mats, art) {
  const t = art.textures || {};
  await each(Object.keys(ART_SLOTS).map((k) => [k, t[k]]), async (key, file) => {
    swapImage(mats[ART_SLOTS[key]].map, await loadImage(file));
  });
}

// ---------------------------------------------------------------------------
// Track：分节生成断续的环形平台
// ---------------------------------------------------------------------------
export class Track {
  constructor(seed, mode, scene, mats) {
    this.mode = mode;
    this.scene = scene;
    this.mats = mats;
    this.rand = mulberry32(seed);
    this.raceLength = mode === 'race' ? 7200 : Infinity;
    this.path = new Path(seed, (s) => this.difficulty(s), (s) => this.curveAmp(s));
    this.sections = [];
    this.genS = 0;
    this.finishS = Infinity;
    this.done = false;
    this.crumbling = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.update(0, 0, 0);
  }

  // 终点位置（终点节还没生成时用赛道长度估计）
  get goal() { return Math.min(this.finishS, this.raceLength); }

  difficulty(s) {
    if (this.mode === 'race') return clamp((s - 300) / (this.raceLength - 700), 0, 1);
    return clamp((s - 300) / 9000, 0, 1.35);
  }

  // 弯道强度随阶段增加：热身和认识阶段很缓，组合阶段中等，断崖阶段最急
  curveAmp(x) {
    const P = (a, b) => clamp((x - a) / (b - a), 0, 1);
    if (x < 800) return 0.3;
    if (x < 3000) return lerp(0.3, 0.45, P(800, 3000));
    if (x < 5000) return lerp(0.45, 0.8, P(3000, 5000));
    if (x < 7200) return lerp(0.8, 1.0, P(5000, 7200));
    return lerp(1.0, 1.2, P(7200, 16000));
  }

  // 每条赛道在节末处是“山谷”还是“山顶”：
  // 管道往某个方向弯时，站在弯道外侧的赛道看前方是往上抬（看得见），内侧是往下沉（被挡住）。
  // 返回 { bend: 弯得多厉害（弧度）, score: 每条赛道的分数，正 = 外侧/看得见，负 = 内侧/看不见 }
  valleyScores(s) {
    const t1 = this.path.frame(s - 40).t.clone();
    const t2 = this.path.frame(s + 20).t.clone();
    const k = t2.sub(t1);
    const bend = k.length();
    if (bend > 1e-6) k.divideScalar(bend);
    const score = [];
    const tmp = new THREE.Vector3();
    for (let i = 0; i < LANES; i++) {
      this.path.point(s, i + 0.5, 0, tmp);
      score.push(-k.dot(this.path.r));
    }
    return { bend, score };
  }

  // 用加速赛道引导视野：节末前方有弯时，把加速赛道挪到弯道外侧（看得见下一段的那一侧），
  // 玩家被加速吸引过去，往下沉的弯对他就变成了往上抬。
  // 前中期几乎总是这样引导，并且内侧（看不见）的赛道不放陷阱；断崖阶段引导变少，
  // 有时故意把加速放在内侧：更快，但要冒看不见落点的风险
  lureByBend(types, present, s1, stage, keepType) {
    const { bend, score } = this.valleyScores(s1);
    if (bend < 0.05) return; // 基本是直的，不用引导
    const r = this.rand;
    const lanesNow = present.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0);
    const lure = { warm: 0.95, teach: 0.95, combo: 0.75, cliff: 0.45, beyond: 0.35 }[stage];
    const nb = types.filter((t, i) => present[i] && t === TYPE.BOOST).length;
    let order = null;
    if (r() < lure) order = [...lanesNow].sort((a, b) => score[b] - score[a]); // 外侧优先
    else if ((stage === 'cliff' || stage === 'beyond') && r() < 0.5) order = [...lanesNow].sort((a, b) => score[a] - score[b]); // 冒险：内侧
    if (order) {
      for (const i of lanesNow) if (types[i] === TYPE.BOOST) types[i] = TYPE.NORMAL;
      // 挑分数靠前、彼此不挨着的赛道放加速
      const picked = [];
      for (const i of order) {
        if (picked.length >= nb) break;
        if (picked.every((p) => laneDist(p, i) >= 2)) picked.push(i);
      }
      for (const i of picked) types[i] = TYPE.BOOST;
    }
    // 往下沉的弯先做得简单：前期内侧赛道不放陷阱，组合阶段一半
    const hazard = [TYPE.OBSTACLE, TYPE.CRUMBLE, TYPE.SHORT];
    const calmInner = { warm: 1, teach: 1, combo: 0.5 }[stage] || 0;
    for (const i of lanesNow) {
      if (score[i] < -0.35 && hazard.includes(types[i]) && types[i] !== keepType && r() < calmInner) types[i] = TYPE.NORMAL;
    }
  }

  // 按权重随机挑一种赛道类型，w：[[类型, 权重], ...]
  pickType(w) {
    let sum = 0;
    for (const [, x] of w) sum += x;
    let r = this.rand() * sum;
    for (const [t, x] of w) { if ((r -= x) <= 0) return t; }
    return TYPE.NORMAL;
  }

  // 难度阶段（竞速和生存前 7.2 公里相同）：
  //   热身 0–0.8km：只有普通和加速赛道
  //   认识 0.8–3km：每 440 米引入一种新赛道（弹射→减速→短台→障碍→碎裂），新类型先单独多出现几条
  //   组合 3–5km：各种赛道混合，赛道数 10→7，空隙变大；4.2km 起偶尔出现“加速更轻松”的大空隙
  //   断崖 5–7.2km：赛道数 7→3，大空隙越来越多，5.8km 起出现必须踩加速或连跳才能过的断崖
  //   之后（只有生存模式）：继续缓慢加难
  stage(x) {
    const P = (a, b) => clamp((x - a) / (b - a), 0, 1);
    if (x < 800) return { name: 'warm', t: P(0, 800) };
    if (x < 3000) return { name: 'teach', t: P(800, 3000), intro: Math.min(INTRO.length - 1, Math.floor((x - 800) / 440)) };
    if (x < 5000) return { name: 'combo', t: P(3000, 5000) };
    if (x < 7200) return { name: 'cliff', t: P(5000, 7200) };
    return { name: 'beyond', t: P(7200, 16000) };
  }

  // 每个阶段的空隙、平台长度、赛道数、各类型权重、大空隙
  stageParams(x) {
    const st = this.stage(x);
    const t = st.t;
    const N = TYPE;
    let gap, len, count, weights, bigGap = null;
    if (st.name === 'warm') {
      gap = lerp(13, 16, t); len = 150; count = 10;
      weights = [[N.NORMAL, 1], [N.BOOST, 0.25]];
    } else if (st.name === 'teach') {
      gap = lerp(15, 19, t); len = lerp(150, 120, t); count = 10;
      // 已经学过的类型少量出现，正在学的那种由 generate() 单独多放几条
      weights = [[N.NORMAL, 1], [N.BOOST, 0.2]];
      for (let i = 0; i < st.intro; i++) weights.push([INTRO[i], 0.12]);
    } else if (st.name === 'combo') {
      gap = lerp(19, 25, t); len = lerp(120, 82, t); count = Math.round(lerp(10, 7, t));
      weights = [[N.NORMAL, 1], [N.BOOST, 0.22], [N.SLOW, 0.14], [N.BOUNCE, 0.12],
        [N.SHORT, lerp(0.12, 0.22, t)], [N.OBSTACLE, lerp(0.14, 0.26, t)], [N.CRUMBLE, lerp(0.1, 0.2, t)]];
      // 4.2km 起：偶尔一个 44–48 米的空隙，普通跳要卡准时机，踩加速就很轻松
      if (x > 4200) bigGap = { chance: 0.45, min: 44, max: 48 };
    } else if (st.name === 'cliff') {
      gap = lerp(25, 31, t); len = lerp(82, 56, t); count = Math.round(lerp(7, 3, t));
      weights = [[N.NORMAL, 1], [N.BOOST, 0.25], [N.SLOW, 0.14], [N.BOUNCE, 0.12],
        [N.SHORT, 0.24], [N.OBSTACLE, 0.28], [N.CRUMBLE, 0.24]];
      // 前段先练 46–52 米；5.8km 起逐步变成 60–66 米，必须踩加速或连跳
      bigGap = x < 5800
        ? { chance: 0.3, min: 46, max: 52 }
        : { chance: lerp(0.3, 0.45, t), min: lerp(56, 60, t), max: lerp(60, 66, t) };
    } else {
      gap = lerp(31, 36, t); len = lerp(56, 48, t); count = Math.round(lerp(3, 2, t));
      weights = [[N.NORMAL, 1], [N.BOOST, 0.28], [N.SLOW, 0.14], [N.BOUNCE, 0.12],
        [N.SHORT, 0.26], [N.OBSTACLE, 0.3], [N.CRUMBLE, 0.26]];
      bigGap = { chance: 0.45, min: 60, max: 68 };
    }
    return { st, gap, len, count, weights, bigGap };
  }

  lanePattern(count) {
    const r = this.rand;
    const p = new Array(LANES).fill(false);
    const start = Math.floor(r() * LANES);
    const style = r();
    if (style < 0.35) {
      // 连续一段
      for (let k = 0; k < count; k++) p[(start + k) % LANES] = true;
    } else if (style < 0.6) {
      // 首尾有，中间是坑：两段分布在管道两侧
      const k1 = Math.ceil(count / 2);
      for (let k = 0; k < k1; k++) p[(start + k) % LANES] = true;
      for (let k = 0; k < count - k1; k++) p[(start + 5 + k) % LANES] = true;
    } else if (style < 0.8 && count <= 5) {
      // 间隔分布
      for (let k = 0; k < count; k++) p[(start + k * 2) % LANES] = true;
    } else {
      // 随机散布
      let n = 0;
      while (n < count) {
        const i = Math.floor(r() * LANES);
        if (!p[i]) { p[i] = true; n++; }
      }
    }
    return p;
  }

  // 保证从 sources（上一节可以起跳的赛道）出发，至少有两条“不挨着”的路线能落到这一节
  // （空中左右最多能偏 2 条赛道）。不够就在合适的位置补赛道
  ensureRoutes(present, sources) {
    const reach = () => present.map((ok, i) => ok && sources.some((j) => laneDist(i, j) <= 2) ? i : -1).filter((i) => i >= 0);
    for (let tries = 0; tries < 4; tries++) {
      const R = reach();
      const spread = R.length >= 2 && R.some((a) => R.some((b) => laneDist(a, b) >= 2));
      if (spread) return;
      // 从离已有路线最远的起跳赛道正对面补一条
      const j = sources.reduce((best, s) => {
        const far = R.length ? Math.min(...R.map((x) => laneDist(x, s))) : 99;
        return far > best.far ? { s, far } : best;
      }, { s: sources[0], far: -1 }).s;
      present[j] = true;
      if (sources.length === 1 && R.length >= 1) present[(j + (this.rand() < 0.5 ? 2 : -2) + LANES) % LANES] = true;
    }
  }

  generate() {
    const r = this.rand;
    const idx = this.sections.length;
    const prev = this.sections[idx - 1];
    const first = idx === 0;
    const P = this.stageParams(this.genS);
    // 上一节如果预约了大空隙，这一节前面就是这个大空隙
    const big = prev ? prev.bigGapNext : 0;
    const gap = first ? 0 : big || P.gap * (0.85 + 0.3 * r());
    let len = first ? 320 : P.len * (0.8 + 0.4 * r());
    if (big) len = Math.max(len, 75); // 大空隙后的落脚平台给长一点
    const s0 = this.genS + gap;
    let isFinish = false;
    if (s0 + len >= this.raceLength) { isFinish = true; len = 340; }
    const s1 = s0 + len;

    // 预约这一节后面的空隙要不要是大空隙（预约了，这一节就要准备好加速赛道）
    let bigGapNext = 0;
    if (!first && !big && !isFinish && P.bigGap && r() < P.bigGap.chance && s1 < this.raceLength - 600) {
      bigGapNext = lerp(P.bigGap.min, P.bigGap.max, r());
      // 大空隙前后把管道拉直，关键跳跃一定看得见落点
      this.path.calm.push([s1 - 50, s1 + bigGapNext + 70]);
    }

    // 哪些赛道存在
    // 热身和认识阶段始终 10 条赛道（不出现坑），之后才在目标数量上下浮动
    let count = idx < 3 || isFinish || P.count >= 10 ? 10 : clamp(P.count + Math.round((r() - 0.5) * 2), 2, 10);
    if (big || bigGapNext) count = Math.max(count, 4); // 大空隙前后留足赛道，保证有多条路线
    let present = count < 10 ? this.lanePattern(count) : new Array(LANES).fill(true);
    // 起跳赛道：过大空隙只能从加速赛道起跳（连跳是另一条备用路线）
    if (prev) {
      const prevLanes = prev.lanes.map((L, i) => (L ? i : -1)).filter((i) => i >= 0);
      const boosts = prevLanes.filter((i) => prev.lanes[i].type === TYPE.BOOST);
      this.ensureRoutes(present, big && boosts.length ? boosts : prevLanes);
    }

    // 各条赛道的类型
    const types = new Array(LANES).fill(TYPE.NORMAL);
    if (!(idx < 2 || isFinish)) {
      for (let i = 0; i < LANES; i++) if (present[i]) types[i] = this.pickType(P.weights);
      // 认识阶段：正在学的新赛道连着放 3 条，单独出现，容易看清
      if (P.st.name === 'teach' && r() < 0.85) {
        const start = Math.floor(r() * LANES);
        for (let k = 0; k < 3; k++) {
          const i = (start + k) % LANES;
          if (present[i]) types[i] = INTRO[P.st.intro];
        }
      }
      // 大空隙之后的落脚区只放普通和加速，不让玩家刚飞过来就撞墙或踩塌
      if (big) for (let i = 0; i < LANES; i++) if (types[i] !== TYPE.BOOST) types[i] = TYPE.NORMAL;
      const lanesNow = types.map((t, i) => (present[i] ? i : -1)).filter((i) => i >= 0);
      if (bigGapNext) {
        // 大空隙前：至少两条相隔较远的加速赛道，两条路线任选
        for (let i = 0; i < LANES; i++) if (types[i] === TYPE.BOOST) types[i] = TYPE.NORMAL;
        const a = lanesNow[Math.floor(r() * lanesNow.length)];
        const b = lanesNow.reduce((best, i) => (laneDist(i, a) > laneDist(best, a) ? i : best), a);
        types[a] = TYPE.BOOST;
        types[b] = TYPE.BOOST;
      } else if (!types.some((t, i) => present[i] && t === TYPE.BOOST)) {
        // 加速是核心：每一节都至少有一条加速赛道
        types[lanesNow[Math.floor(r() * lanesNow.length)]] = TYPE.BOOST;
      }
      // 认识阶段正在学的那种赛道不改，保证新类型能被看到
      if (!bigGapNext && !big) this.lureByBend(types, present, s1, P.st.name, P.st.name === 'teach' ? INTRO[P.st.intro] : -1);
    }

    const lanes = new Array(LANES).fill(null);
    for (let i = 0; i < LANES; i++) {
      if (!present[i]) continue;
      const type = types[i];
      const L = { i, type, s0, s1, obstacles: [], crumbleT: -1, gone: false, mesh: null, fallT: 0 };
      if (type === TYPE.SHORT) {
        const l = len * (0.35 + 0.25 * r());
        if (r() < 0.5) L.s1 = s0 + l; else L.s0 = s1 - l;
      } else if (type === TYPE.OBSTACLE) {
        const n = 1 + Math.floor(r() * Math.min(3, len / 40));
        for (let k = 0; k < n; k++) {
          L.obstacles.push(s0 + 14 + (len - 28) * ((k + 0.5) / n + (r() - 0.5) * 0.25 / n));
        }
      }
      lanes[i] = L;
    }
    if (!lanes.some((L) => L && SAFE_TYPES.includes(L.type))) {
      const L = lanes.find((x) => x);
      L.type = TYPE.NORMAL; L.obstacles = []; L.s0 = s0; L.s1 = s1;
    }

    // bigGap：这一节前面是大空隙（用于提示）；bigGapNext：这一节后面预约了大空隙
    const sec = { s0, s1, lanes, isFinish, mesh: null, extras: [], bigGap: big, bigGapNext };
    // 新赛道第一次出现的那一节做个标记，游戏里会弹出说明
    if (idx === 2) sec.intro = TYPE.BOOST;
    if (P.st.name === 'teach' && P.st.intro !== this.lastIntro && types.includes(INTRO[P.st.intro])) {
      sec.intro = INTRO[P.st.intro];
      this.lastIntro = P.st.intro;
    }
    this.buildSection(sec);
    this.sections.push(sec);
    this.genS = s1;
    if (isFinish) {
      this.finishS = s0 + 50;
      this.done = true;
      this.addFinishGate(sec);
    }
  }

  buildSection(sec) {
    const path = this.path;
    const gb = new GeoBuilder();
    for (const L of sec.lanes) {
      if (!L) continue;
      const a0 = L.i + 0.025, a1 = L.i + 0.975;
      const target = L.type === TYPE.CRUMBLE ? new GeoBuilder() : gb;
      const topSlot = sec.isFinish ? SLOT_FINISH : L.type;
      target.curvedBox(path, a0, a1, L.s0, L.s1, -THICK, 0, topSlot, SLOT_SIDE, sec.isFinish ? 4 : 16);
      // 端头发光条
      target.curvedBox(path, a0, a1, L.s0, Math.min(L.s0 + 0.6, L.s1), 0, 0.06, SLOT_EDGE + L.type, SLOT_EDGE + L.type);
      target.curvedBox(path, a0, a1, Math.max(L.s1 - 0.6, L.s0), L.s1, 0, 0.06, SLOT_EDGE + L.type, SLOT_EDGE + L.type);
      for (const os of L.obstacles) {
        target.curvedBox(path, a0 + 0.04, a1 - 0.04, os - 0.5, os + 0.5, 0, WALL_H, SLOT_WALL, SLOT_WALL);
      }
      if (target !== gb) {
        const mats = this.mats.slice();
        for (const k of [TYPE.CRUMBLE, SLOT_SIDE, SLOT_EDGE + TYPE.CRUMBLE]) {
          mats[k] = this.mats[k].clone();
          mats[k].transparent = true;
        }
        L.mesh = new THREE.Mesh(target.build(), mats);
        const mid = new THREE.Vector3();
        path.point((L.s0 + L.s1) / 2, L.i + 0.5, 0, mid);
        L.outward = path.r.clone();
        this.group.add(L.mesh);
      }
    }
    sec.mesh = new THREE.Mesh(gb.build(), this.mats);
    this.group.add(sec.mesh);
  }

  addFinishGate(sec) {
    const f = this.path.frame(this.finishS);
    const m = new THREE.Matrix4().makeBasis(f.n, f.b, f.t);
    const mk = (radius, tube, color) => {
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(radius, tube, 16, 96),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5) })
      );
      mesh.position.copy(f.p);
      mesh.quaternion.setFromRotationMatrix(m);
      this.group.add(mesh);
      sec.extras.push(mesh);
      return mesh;
    };
    mk(R * 0.45, 0.3, '#ff3cf0');
    mk(R + 0.9, 0.35, '#ffffff');
    this.gate = mk(R * 0.25, 0.15, '#00fff0');
  }

  sectionAt(s) {
    for (const sec of this.sections) {
      if (s < sec.s0) return null;
      if (s <= sec.s1) return sec;
    }
    return null;
  }

  // 当前位置及前方的两节（用于雷达）
  upcoming(s) {
    const out = [];
    for (const sec of this.sections) {
      if (sec.s1 < s) continue;
      out.push(sec);
      if (out.length === 2) break;
    }
    return out;
  }

  laneAt(s, i) {
    const sec = this.sectionAt(s);
    if (!sec) return null;
    const L = sec.lanes[i];
    return L && !L.gone && s >= L.s0 && s <= L.s1 ? L : null;
  }

  laneRaw(s, i) {
    const sec = this.sectionAt(s);
    return sec ? sec.lanes[i] : null;
  }

  update(carS, time, dt) {
    while (!this.done && this.genS < carS + 1500) this.generate();
    while (this.sections.length && this.sections[0].s1 < carS - 80) {
      const sec = this.sections.shift();
      this.disposeSection(sec);
    }
    // 碎裂平台
    for (const sec of this.sections) {
      for (const L of sec.lanes) {
        if (!L || L.type !== TYPE.CRUMBLE || L.crumbleT < 0 || !L.mesh) continue;
        const t = time - L.crumbleT;
        if (!L.gone && t > 0.65) L.gone = true;
        if (!L.gone) {
          const k = t * 0.25;
          L.mesh.position.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
        } else {
          L.fallT += dt;
          L.mesh.position.copy(L.outward).multiplyScalar(L.fallT * L.fallT * 14);
          const op = Math.max(0, 1 - L.fallT / 1.5);
          for (const m of L.mesh.material) if (m.transparent) m.opacity = op;
          if (op <= 0) L.mesh.visible = false;
        }
      }
    }
    if (this.gate) this.gate.rotation.z += dt * 2;
  }

  disposeSection(sec) {
    this.group.remove(sec.mesh);
    sec.mesh.geometry.dispose();
    for (const L of sec.lanes) {
      if (L && L.mesh) {
        this.group.remove(L.mesh);
        L.mesh.geometry.dispose();
      }
    }
    for (const e of sec.extras) { this.group.remove(e); e.geometry.dispose(); }
  }

  dispose() {
    for (const sec of this.sections) this.disposeSection(sec);
    this.sections = [];
    this.scene.remove(this.group);
  }
}
