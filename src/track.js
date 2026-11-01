import * as THREE from './lib.js';

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

// ---------------------------------------------------------------------------
// Path：在太空中弯曲的管道中心线 + 平行移动标架 + 扭转角
// ---------------------------------------------------------------------------
export class Path {
  constructor(seed, difficultyFn) {
    const rnd = mulberry32(seed * 7 + 13);
    this.ph = Array.from({ length: 8 }, () => rnd() * Math.PI * 2);
    this.diff = difficultyFn;
    const t0 = this.heading(0);
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

  heading(s) {
    const ph = this.ph;
    const ramp = clamp(s / 500, 0, 1);
    const yaw = ramp * (1.4 * Math.sin(s * 0.0012 + ph[0]) + 0.7 * Math.sin(s * 0.0029 + ph[1]));
    const pitch = ramp * (0.25 * Math.sin(s * 0.0016 + ph[2]) + 0.14 * Math.sin(s * 0.0037 + ph[3]));
    return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
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
      const tNext = this.heading((i + 1) * STEP);
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
    this.path = new Path(seed, (s) => this.difficulty(s));
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

  pickType(d) {
    const w = [
      [TYPE.NORMAL, 1.0],
      [TYPE.BOOST, 0.12 + 0.08 * d],
      [TYPE.SLOW, 0.08 + 0.1 * d],
      [TYPE.OBSTACLE, 0.07 + 0.32 * d],
      [TYPE.SHORT, 0.05 + 0.24 * d],
      [TYPE.CRUMBLE, 0.02 + 0.26 * d],
      [TYPE.BOUNCE, 0.06 + 0.04 * d],
    ];
    let sum = 0;
    for (const [, x] of w) sum += x;
    let r = this.rand() * sum;
    for (const [t, x] of w) { if ((r -= x) <= 0) return t; }
    return TYPE.NORMAL;
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

  generate() {
    const r = this.rand;
    const idx = this.sections.length;
    const prev = this.sections[idx - 1];
    const d = this.difficulty(this.genS);
    const dc = Math.min(d, 1);
    const first = idx === 0;
    const gap = first ? 0 : lerp(11, 30, dc) * (0.75 + 0.5 * r()) + Math.max(0, d - 1) * 25;
    let len = first ? 320 : lerp(125, 34, dc) * (0.7 + 0.6 * r());
    const s0 = this.genS + gap;
    let isFinish = false;
    if (s0 + len >= this.raceLength) { isFinish = true; len = 340; }
    const s1 = s0 + len;

    // 哪些赛道存在
    let present = new Array(LANES).fill(true);
    if (idx >= 3 && !isFinish) {
      let count = Math.round(lerp(10, 3, dc) + (r() - 0.5) * 3);
      count = clamp(count, d > 1 ? 2 : 3, 10);
      if (count < 10) present = this.lanePattern(count);
    }
    // 保证至少有一条从上一节可达的路线
    let forcedSafe = -1;
    if (prev) {
      const prevLanes = prev.lanes.map((L, i) => (L ? i : -1)).filter((i) => i >= 0);
      const reachable = present.some((ok, i) => ok && prevLanes.some((j) => Math.min((i - j + LANES) % LANES, (j - i + LANES) % LANES) <= 2));
      if (!reachable) {
        const j = prevLanes[Math.floor(r() * prevLanes.length)];
        forcedSafe = (j + Math.floor(r() * 5) - 2 + LANES) % LANES;
        present[forcedSafe] = true;
      }
    }

    const lanes = new Array(LANES).fill(null);
    for (let i = 0; i < LANES; i++) {
      if (!present[i]) continue;
      let type = idx < 2 || isFinish ? TYPE.NORMAL : this.pickType(d);
      if (i === forcedSafe) type = TYPE.NORMAL;
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

    const sec = { s0, s1, lanes, isFinish, mesh: null, extras: [] };
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
