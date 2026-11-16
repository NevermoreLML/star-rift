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
// 生存模式难度节奏的拉长倍数
const SURVIVAL_STRETCH = 1.5;
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
// 管道模式赛道首尾相接（绕一圈）；陨石外表面模式两边是边缘，不再相接
export const wrapLane = (a) => (TRACK_STYLE.outside ? clamp(a, 0.02, LANES - 0.02) : ((a % LANES) + LANES) % LANES);
export const laneIndex = (a) => Math.floor(wrapLane(a)) % LANES;
// 赛道外观：默认是霓虹发光平台；主题可以改成陨石平台（rocky：底下的厚度，edges：端头发光条，spikes：障碍做成冰刺）
// continuous：连贯管道模式——平时各节首尾相接没有整圈断口，难点来自扣掉的部分（远处扣、整条道缺、道中间的洞、不规则大缺口）
export const TRACK_STYLE = { rocky: 0, slab: 0, edges: true, spikes: false, lines: false, outside: false, radius: R, laneWidth: 0, continuous: false, canyon: false, splits: false };
// 当前赛道面的半径：管道内壁模式是 R；外表面模式（outside）是巨石的半径 TRACK_STYLE.radius
export const trackRadius = () => (TRACK_STYLE.outside ? TRACK_STYLE.radius : R);
// 每条赛道占的角度：管道模式 10 条道绕一整圈；陨石外表面模式只占巨石顶上的一段弧，每条道宽 laneWidth 米
export const laneAng = () => (TRACK_STYLE.outside ? TRACK_STYLE.laneWidth / TRACK_STYLE.radius : LANE_ANG);
let SPIKE_GEO = null; // 冰刺共用一个几何体
let ROCK_GEO = null;  // 障碍岩石块共用一个几何体（不规则的圆滑石头）
function rockLump() {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + 0.22 * Math.sin(v.x * 3.3 + v.y * 2.1) * Math.cos(v.z * 2.7 - v.x * 1.3) + 0.1 * Math.sin(v.y * 6.1 + v.z * 4.3);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y * 0.85 + 0.85, v.z);    // 底部大致在 y = 0，高约 1.7（之后按高度缩放）
  }
  g.computeVertexNormals();
  return g;
}

// 平滑的二维值噪声，返回 0..1
function vnoise(x, y) {
  const h = (a, b) => { const t = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return t - Math.floor(t); };
  const i = Math.floor(x), j = Math.floor(y), f = x - i, g = y - j;
  const fu = f * f * (3 - 2 * f), gu = g * g * (3 - 2 * g);
  return lerp(lerp(h(i, j), h(i + 1, j), fu), lerp(h(i, j + 1), h(i + 1, j + 1), fu), gu);
}

// 石带模式：第 i 条道左（k=0）、右（k=1）边缘往里收多少（赛道宽度单位）。按绝对位置算，前后两段的边缘能接上
const laneInset = (i, s, k) => {
  const j = ((i % LANES) + LANES) % LANES;
  return 0.02 + 0.045 * vnoise(s * 0.07 + j * 13.1 + k * 5.7, j * 3.3 + k);
};

// 开场峡谷（TRACK_STYLE.canyon）：第一节是一块巨大陨石上的 U 形山谷。
//   谷底是管道下半圈（第 3～7 条道）连成的一整块岩石，从 start 一直铺到 canyonFloorEnd(a) 参差地断开，露出下面一条条石带；
//   两侧岩壁在 wall0～wall1 之间逐渐变矮、裂开；管道上半圈的道从 canyonLaneStart 开始一条条长出来
export const CANYON = { start: -700, wall0: 150, wall1: 250 };

// 分岔（TRACK_STYLE.splits）：每隔 2～2.5 公里管道劈成左右两半，各自分开 sep 米、一高一低差 2×drop 米，
// 分开 ramp 米、合拢 ramp 米，整段 len 米。一半是稳路（全是普通道），一半是险路（加速道多但有洞）
const SPLIT = { sep: 24, drop: 9, ramp: 140, len: [380, 520], first: [1600, 2000], every: [2000, 2500] };
const canyonFloorEnd = (a) => 222 + 20 * vnoise(a * 1.1, 4.2) + 7 * vnoise(a * 3.7, 1.7);
const CANYON_GROW = { 2: 228, 8: 232, 1: 252, 9: 256, 0: 278 };
const canyonLaneStart = (i) => CANYON_GROW[i] + 8 * vnoise(i * 3.3, 0.7);

// 测试赛道：网址加 &test=boost，所有道都是加速道，没有洞、没有障碍、没有分岔和大断口（用来测变身）。
// 只在本机（localhost / 127.0.0.1）打开时有效，线上版本加了参数也没用
export const TEST_BOOST = typeof location !== 'undefined'
  && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  && new URLSearchParams(location.search).get('test') === 'boost';

// 第 i 条道的贴图变化：随机错开、左右翻转、转 90°（按道的编号固定，前后两节接得上）
const laneUV = (i) => {
  const j = ((i % LANES) + LANES) % LANES;
  const ox = vnoise(j * 5.3, 1.7) * 3, oy = vnoise(j * 2.9, 8.1) * 3;
  const flip = vnoise(j * 7.7, 3.3) < 0.5, rot = vnoise(j * 4.1, 6.6) < 0.5;
  return (u, v) => { const uu = flip ? 1 - u : u; return rot ? [v + oy, uu + ox] : [uu + ox, v + oy]; };
};

// 把存在的道分成一组组挨在一起的“簇”（管道是一圈，首尾相接），每簇按从左到右的顺序列出道的编号
function laneClusters(present) {
  if (present.every(Boolean)) return [[...Array(LANES).keys()]];
  let start = present.findIndex((ok, i) => ok && !present[(i + LANES - 1) % LANES]);
  if (start < 0) return [];
  const out = [];
  let cur = null;
  for (let k = 0; k < LANES; k++) {
    const i = (start + k) % LANES;
    if (!present[i]) { cur = null; continue; }
    if (!cur) out.push((cur = []));
    cur.push(i);
  }
  return out;
}
const isGoodType = (t) => t === TYPE.NORMAL || t === TYPE.BOOST;

// 两条赛道在圆周上相隔几条
const laneDist = (a, b) => Math.min((a - b + LANES) % LANES, (b - a + LANES) % LANES);
// 从 a 绕到 b 最近的方向和步数（-5..4）
const shortestDelta = (a, b) => ((b - a + LANES * 1.5) % LANES) - LANES / 2;

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
    this.splits = []; // 分岔 { s0, s1, risky 哪一半是险路(-1 左 / 1 右), drop 哪一半往上抬 }
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

  // 管道坐标 (s 沿程, a 赛道坐标 0..10, h 离开赛道面的高度) → 世界坐标
  // 调用后 this.r 为该点“脚下”的方向（指向赛道面里面），-r 即“上”
  // 管道内壁模式：赛道在管壁内侧，上 = 朝管道中心；
  // 外表面模式：赛道在一块巨石的外表面上，上 = 背离中心（角度方向镜像一下，保证 A 还是往左）
  point(s, a, h, out) {
    const f = this.frame(s);
    if (TRACK_STYLE.outside) {
      // 多转半圈：起点那条道在巨石顶上（和管道模式一样，开局时“上”就是世界的上）
      const th = -(a - 5.5) * laneAng() + f.tw + Math.PI;
      this.r.copy(f.n).multiplyScalar(Math.cos(th)).addScaledVector(f.b, Math.sin(th));
      out.copy(f.p).addScaledVector(this.r, TRACK_STYLE.radius + h);
      this.r.negate();
      return out;
    }
    const th = (a - 5.5) * LANE_ANG + f.tw;
    this.r.copy(f.n).multiplyScalar(Math.cos(th)).addScaledVector(f.b, Math.sin(th));
    out.copy(f.p).addScaledVector(this.r, R - h);
    // 分岔：管道沿前进方向劈成左右两半（第 0～4 条道 / 第 5～9 条道），两半往两边分开、一高一低，之后再合拢
    if (this.splits.length) {
      const sp = this.splitAt(s);
      if (sp) {
        const w = this.splitW(sp, s);
        const sg = ((a % LANES) + LANES) % LANES < 5 ? -1 : 1;
        const c = Math.cos(f.tw), si = Math.sin(f.tw);
        // 截面里的“侧”（垂直于劈开的那道缝）和“上”，随管道扭转一起转
        const sideX = sg * w * SPLIT.sep, upY = sg * sp.drop * w * SPLIT.drop;
        out.x += (f.n.x * -si + f.b.x * c) * sideX - (f.n.x * c + f.b.x * si) * upY;
        out.y += (f.n.y * -si + f.b.y * c) * sideX - (f.n.y * c + f.b.y * si) * upY;
        out.z += (f.n.z * -si + f.b.z * c) * sideX - (f.n.z * c + f.b.z * si) * upY;
      }
    }
    return out;
  }

  // s 处所在的分岔（只算劈开到合拢之间），没有返回 null
  splitAt(s) {
    for (const sp of this.splits) if (s > sp.s0 && s < sp.s1) return sp;
    return null;
  }

  // 分开的程度 0～1：两头各 SPLIT.ramp 米平滑地分开、合拢
  splitW(sp, s) {
    const e = Math.min(clamp((s - sp.s0) / SPLIT.ramp, 0, 1), clamp((sp.s1 - s) / SPLIT.ramp, 0, 1));
    return e * e * (3 - 2 * e);
  }

  // 外表面模式：已知某点在 s 处的法平面内，反算它的赛道坐标 (a, h)
  locateOutside(s, P) {
    const f = this.frame(s);
    const vx = P.x - f.p.x, vy = P.y - f.p.y, vz = P.z - f.p.z;
    const x = vx * f.n.x + vy * f.n.y + vz * f.n.z, y = vx * f.b.x + vy * f.b.y + vz * f.b.z;
    let d = Math.atan2(y, x) - f.tw - Math.PI;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return [5.5 - d / laneAng(), Math.hypot(x, y) - TRACK_STYLE.radius];
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

  // 陨石平台：顶面保持平整（车要跑），侧面、底面和前后端面凹凸不平，底下更厚，像一块被削平的岩石
  rockBox(path, a0, a1, s0, s1, h1, depth, topSlot, sideSlot, vScale) {
    const ns = Math.max(2, Math.ceil((s1 - s0) / 2.5));
    const na = 6, nh = 3;
    const S = (v) => s0 + v * (s1 - s0);
    const mid = (a0 + a1) / 2;
    // 底边向里收一点，岩石下半部更窄
    const inL = (s) => a0 + (mid - a0) * 0.22 * (0.5 + vnoise(s * 0.2, 3.1));
    const inR = (s) => a1 - (a1 - mid) * 0.22 * (0.5 + vnoise(s * 0.2, 8.7));
    const bottom = (s, u) => h1 - 0.35 - depth * (0.45 + 0.55 * vnoise(s * 0.18, u * 3.3)) * (0.4 + 0.6 * Math.sin(Math.PI * u));
    // 顶面
    this.grid(na, ns, topSlot, (u, v, out) => { path.point(S(v), a0 + u * (a1 - a0), h1, out); return [u, (S(v) - s0) / vScale]; });
    // 底面
    this.grid(na, ns, sideSlot, (u, v, out) => {
      const s = S(v);
      path.point(s, inL(s) + u * (inR(s) - inL(s)), bottom(s, u), out);
      return [u, (s - s0) / 8];
    });
    // 两个侧面：从底边斜到顶边，中间鼓起
    for (const [side, edge, inner, uB] of [[-1, a0, inL, 0], [1, a1, inR, 1]]) {
      this.grid(nh, ns, sideSlot, (u, v, out) => {
        const s = S(v);
        const bulge = 0.07 * vnoise(s * 0.35, u * 2 + side) * Math.sin(Math.PI * u);
        path.point(s, inner(s) + (edge - inner(s)) * u + side * bulge, bottom(s, uB) + (h1 - bottom(s, uB)) * u, out);
        return [u, (s - s0) / 8];
      });
    }
    // 前后端面：顶边齐平，越往下越参差
    for (const [s, dir] of [[s0, -1], [s1, 1]]) {
      this.grid(na, nh, sideSlot, (u, v, out) => {
        const a = inL(s) + (a0 - inL(s)) * v + u * ((inR(s) + (a1 - inR(s)) * v) - (inL(s) + (a0 - inL(s)) * v));
        const h = bottom(s, u) + (h1 - bottom(s, u)) * v;
        path.point(s + dir * (1 - v) * 1.2 * (vnoise(u * 3, s * 0.1) - 0.3), a, h, out);
        return [u, v];
      });
    }
  }

  // 一块巨大的陨石：一个凹凸不平的“土豆”，顶上被削平的一小片正好托住跑道。
  // a0..a1：这块陨石承载的赛道范围；cs0..cs1：沿前进方向的范围；ins(s, k)：顶面左右两边往里收多少（k=0 左，1 右）
  // 跑道以外的部分都向管外塌下去，不会冒到跑道面上；越往外越宽，看起来是一整块很大的石头
  boulder(path, a0, a1, cs0, cs1, ins, size, slot, seed) {
    const nu = 56, nv = 36;
    const sc = (cs0 + cs1) / 2, ac = (a0 + a1) / 2;
    const Rs = (cs1 - cs0) / 2 + 4 + 6 * vnoise(seed, 2.2);
    const Ra = (a1 - a0) / 2 + 0.35;
    const RR = trackRadius(), LANE_W = RR * laneAng();  // 一条赛道多宽（米）
    // 外表面模式：石头往里（朝中心）长，不能穿过中轴线
    const Rh = TRACK_STYLE.outside ? Math.min(size * (0.75 + 0.6 * vnoise(seed, 5.1)), (RR - 1.5) / 2 + 0.75) : size * (0.75 + 0.6 * vnoise(seed, 5.1));
    const hc = 1.5 - Rh;                               // 球顶在跑道面之上，被削平
    const lim = (s, a) => {
      const A0 = a0 + ins(s, 0), A1 = a1 - ins(s, 1);
      const da = Math.max(A0 - a, a - A1, 0) * LANE_W;
      const ds = Math.max(cs0 - s, s - cs1, 0);
      // 左右方向是一块巨石弧形的表面，慢慢往外弯下去；前后断口处陡一些，免得看起来像能落脚
      const d = Math.hypot(da, ds * 2.5);
      return -0.25 - d * 0.3 - d * d * 0.01;
    };
    this.grid(nu, nv, slot, (u, v, out) => {
      const lon = u * Math.PI * 2, lat = (v - 0.5) * Math.PI;
      const r = 1 + 0.22 * (vnoise(lon * 1.6 + seed, lat * 2.1 + 1) - 0.5) + 0.1 * (vnoise(lon * 4.3 + seed, lat * 5.2 + 7) - 0.5);
      const x = Math.cos(lat) * Math.cos(lon) * r, z = Math.cos(lat) * Math.sin(lon) * r, y = Math.sin(lat) * r;
      const s = sc + x * Rs;
      let h = hc + y * Rh;
      // 往外走石头变宽，但比管道的扇形张开得慢，保持圆鼓鼓的样子
      const a = ac + z * Ra * (TRACK_STYLE.outside ? 1 : Math.pow(R / (R - Math.min(h, 0)), 0.45));
      h = Math.min(h, lim(s, a));
      if (TRACK_STYLE.outside) h = Math.max(h, 1 - RR);
      path.point(s, a, h, out);
      return [u * 6, v * 4];
    });
  }

  // 外表面模式的陨石：在路面下面的一整块巨石（按米算的椭球，跟着赛道弯），
  // 顶部高出路面，被削成和路面贴合的弧形，路面以外是往四周弯下去的岩石表面
  // giant：大石头（左右多出几十米、往下几十米）；否则是分岔用的小石头
  outsideRock(path, a0, a1, cs0, cs1, ins, slot, seed, giant) {
    const nu = 64, nv = 40;
    const W = TRACK_STYLE.laneWidth;
    const sc = (cs0 + cs1) / 2, ac = (a0 + a1) / 2;
    const span = (a1 - a0) * W;
    const Rl = span / 2 + (giant ? 14 + 30 * vnoise(seed, 1.1) : 2.5 + 2 * vnoise(seed, 1.1));
    const Rf = (cs1 - cs0) / 2 + (giant ? 4 + 8 * vnoise(seed, 2.2) : 2 + 2 * vnoise(seed, 2.2));
    const Rv = giant ? 30 + 60 * vnoise(seed, 3.3) : 8 + 6 * vnoise(seed, 3.3);
    const lift = Rv * 0.35;             // 椭球中心在路面上方这么高，路面那一层几乎是椭球最宽的地方
    const steep = giant ? 1 : 3;        // 小石头离开路面就陡陡地掉下去
    const lim = (s, a) => {
      const A0 = a0 + ins(s, 0), A1 = a1 - ins(s, 1);
      const da = Math.max(A0 - a, a - A1, 0) * W;
      const ds = Math.max(cs0 - s, s - cs1, 0);
      const d = Math.hypot(da * steep, ds * 2.5);
      return -0.25 - d * 0.3 - d * d * 0.01;
    };
    const c = new THREE.Vector3(), up = new THREE.Vector3(), lat = new THREE.Vector3();
    this.grid(nu, nv, slot, (u, v, out) => {
      const lon = u * Math.PI * 2, la = (v - 0.5) * Math.PI;
      const rr = 1 + 0.25 * (vnoise(lon * 1.6 + seed, la * 2.1 + 1) - 0.5) + 0.12 * (vnoise(lon * 4.3 + seed, la * 5.2 + 7) - 0.5);
      const x = Math.cos(la) * Math.cos(lon) * rr, z = Math.cos(la) * Math.sin(lon) * rr, y = Math.sin(la) * rr;
      const s = sc + z * Rf;
      path.point(s, ac, 0, c);
      up.copy(path.r).negate();
      lat.crossVectors(up, path.frame(s).t).normalize();
      out.copy(c).addScaledVector(up, lift + y * Rv).addScaledVector(lat, x * Rl);
      // 靠近路面的点：高过“削平面”就压到削平面上
      if (lift + y * Rv > -12) {
        const [a, h] = path.locateOutside(s, out);
        const top = lim(s, a);
        if (h > top) path.point(s, a, top, out);
      }
      return [u * 8, v * 5];
    });
  }

  // 石带：一条道的石头，横截面是一整团圆鼓鼓的岩石（沿着横截面绕一圈做成一整张网格）：
  //   上面是能开车的路面（微微起伏，两边圆滑地倒下去），左右圆鼓，
  //   底部像熔化后往下流淌的石头：几个圆钝的鼓包、长短不一的垂坠，偶尔一根细长的尖，都和石头长成一体。
  // 断开的一头（capStart / capEnd）圆滑地收拢成一个钝头；没断开的一头和前后两段无缝接在一起。
  stoneLane(path, i, s0, s1, depth, topSlot, sideSlot, capStart, capEnd) {
    const W = trackRadius() * laneAng();          // 一条道多宽（米）
    const EL = (s) => i + laneInset(i, s, 0), ER = (s) => i + 1 - laneInset(i, s, 1);
    const relief = (s, xn) => 0.07 * (vnoise(s * 0.8 + i * 3, xn * 3 + 3) - 0.5) + 0.04 * (vnoise(s * 2.1, xn * 6.5 + i) - 0.5);
    const body = (s, xn) => depth * (0.75 + 0.45 * vnoise(s * 0.12 + i * 7.7, xn * 1.6 + 2));   // 石头本体的厚度
    // 往下流淌的部分：圆钝的鼓包 + 偶尔一根细长的尖
    const drip = (s, xn) => {
      const lobe = Math.max(0, vnoise(s * 0.42 + i * 17.3, xn * 2.4 + i) - 0.5) / 0.5;
      const spike = Math.max(0, vnoise(s * 0.5 + i * 5.1, xn * 4.5 + 9) - 0.8) / 0.2;
      return (Math.pow(lobe, 1.3) * (1 + 1.6 * vnoise(s * 0.09, i + 0.5)) + Math.pow(spike, 2.2) * 4.5) * (1 - Math.pow(Math.abs(xn), 4));
    };
    // 断开的一头：在最后 r 米里截面圆滑地缩成一个钝头（r 每条道、每个端头都不一样）
    const rS = 1.6 + 1.4 * vnoise(s0 * 0.11, i + 0.3), rE = 1.6 + 1.4 * vnoise(s1 * 0.11, i + 0.7);
    const sA = capStart ? s0 - 0.3 : s0, sB = capEnd ? s1 + 0.3 : s1;
    const shrink = (s) => {
      let k = 1;
      if (capStart && s < sA + rS) k = Math.min(k, Math.sqrt(Math.max(0, 1 - Math.pow((sA + rS - s) / rS, 2))));
      if (capEnd && s > sB - rE) k = Math.min(k, Math.sqrt(Math.max(0, 1 - Math.pow((s - (sB - rE)) / rE, 2))));
      return k;
    };
    const ns = Math.max(3, Math.ceil((sB - sA) / 1.2));
    const S = (v) => sA + v * (sB - sA);
    // 横截面像压扁的胶囊：顶面平，左右两头是完整的半圆（半径 rr），底面浅浅地鼓一下、带往下流淌的垂坠
    const rr = depth / 2;
    const geo = (s) => {
      const cx = (EL(s) + ER(s)) / 2, hw = (ER(s) - EL(s)) / 2;
      const ra = Math.min(rr / W, hw * 0.45);        // 半圆半径（赛道坐标）
      return { cx, hw, ra, cw: hw - ra, r: ra * W };
    };
    const put = (s, a, h, out) => {                  // 端头收拢：截面朝中心缩小
      const k = shrink(s), g = geo(s), yc = -g.r;
      path.point(s, g.cx + (a - g.cx) * k, yc + (h - yc) * k, out);
    };
    // 路面贴图铺满平顶和左右两个半圆（贴图坐标按沿表面走过的距离算，绕过半圆也不拉伸），
    // 只有底面（和往下垂的部分）用石头侧面的贴图
    const U = (arcM, g) => 0.5 + arcM / (2 * g.hw * W);
    const uv = laneUV(i);
    // 平顶：起伏在两头淡出，和半圆无缝接上
    this.grid(10, ns, topSlot, (u, v, out) => {
      const s = S(v), g = geo(s), a = g.cx - g.cw + 2 * g.cw * u, xn = (a - g.cx) / g.hw;
      const fade = Math.min(1, u / 0.12, (1 - u) / 0.12);
      put(s, a, relief(s, xn) * fade, out);
      return uv(U((a - g.cx) * W, g), s / 6); // 一块贴图 ≈ 一条道宽 × 6 米，纹理不被拉长
    });
    // 右半圆、左半圆（从顶上绕到底下）
    for (const side of [1, -1]) {
      this.grid(8, ns, topSlot, (u, v, out) => {
        const s = S(v), g = geo(s), ph = Math.PI / 2 - u * Math.PI;
        put(s, g.cx + side * (g.cw + g.ra * Math.cos(ph)), -g.r + g.r * Math.sin(ph), out);
        return uv(U(side * (g.cw * W + u * Math.PI * g.r), g), s / 6);
      });
    }
    // 底面：浅浅地鼓一下，带往下流淌的垂坠
    this.grid(14, ns, sideSlot, (u, v, out) => {
      const s = S(v), g = geo(s), a = g.cx + g.cw - 2 * g.cw * u, xn = (a - g.cx) / g.hw;
      const h = -2 * g.r - (Math.max(0, body(s, xn) - depth) + drip(s, xn)) * Math.pow(Math.sin(Math.PI * u), 0.6);
      put(s, a, h, out);
      return [u * 4, s / 8];
    });
    // 两头收拢到的那一点已经是同一个位置，网格自然封口
    void W;
  }

  // 碎裂道：路面碎成很多块不规则的石片，石片之间有真的空隙（能看到下面的太空）。
  // 网格点随机挪动（相邻石片共用，拼起来严丝合缝），每块再往自己中心收一点留出缝。
  // 每块石片是一整团圆滑的石头：顶面中间平、靠边圆滑地倒下去，底下鼓起、往下垂（和其他石带同样的感觉），没有平直的切面
  shardLane(path, i, s0, s1, topSlot, sideSlot) {
    const A0 = i + laneInset(i, s0, 0) + 0.03, A1 = i + 1 - laneInset(i, s0, 1) - 0.03;
    const W = trackRadius() * laneAng();           // 一条道多宽（米）
    const cols = 3, rows = Math.max(2, Math.round((s1 - s0) / 2.4));
    const ds = (s1 - s0) / rows;
    const G = [];
    for (let r = 0; r <= rows; r++) {
      G.push([]);
      for (let c = 0; c <= cols; c++) {
        const ja = c === 0 || c === cols ? 0 : (vnoise(r * 1.7 + i * 3.1, c * 2.3 + s0) - 0.5) * 0.55 / cols;
        const js = r === 0 || r === rows ? 0 : (vnoise(c * 1.3 + i, r * 2.9 + s0 * 0.1) - 0.5) * ds * 0.7;
        G[r].push([A0 + (c / cols) * (A1 - A0) + ja, s0 + r * ds + js]);
      }
    }
    const R = 0.32;                                  // 边缘圆角往下倒的深度（米）
    const uvS = laneUV(i);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let q = [G[r][c], G[r][c + 1], G[r + 1][c + 1], G[r + 1][c]];
        const ca = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cs = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
        const gap = 0.05 + 0.1 * vnoise(r * 3.7 + i, c * 5.1 + s0);
        q = q.map(([a, s]) => {
          const dx = (ca - a) * W, dy = cs - s, d = Math.hypot(dx, dy) || 1;
          return [a + (dx / d) * gap / W, s + (dy / d) * gap];
        });
        const seed = r * 1.37 + c * 4.1 + i * 7.3 + s0 * 0.01;
        const tilt = (vnoise(seed, 1.1) - 0.5) * 0.07;
        const depth = 0.45 + 0.4 * vnoise(seed, 2.7);
        // 四边形内的双线性插值
        const P = (u, v) => [q[0][0] + (q[1][0] - q[0][0]) * u + (q[3][0] - q[0][0]) * v + (q[0][0] - q[1][0] + q[2][0] - q[3][0]) * u * v,
          q[0][1] + (q[1][1] - q[0][1]) * u + (q[3][1] - q[0][1]) * v + (q[0][1] - q[1][1] + q[2][1] - q[3][1]) * u * v];
        // 到最近一条边的距离（0 = 边上，0.5 = 中心）
        const edge = (u, v) => Math.min(u, 1 - u, v, 1 - v);
        const relief = (a, s) => 0.04 * (vnoise(s * 0.9 + i * 3, a * 7) - 0.5);
        // 顶面：靠边 30% 的范围圆滑地倒下去，边上比中间低 R
        const NT = 5;
        this.grid(NT, NT, topSlot, (u, v, o) => {
          const [a, s] = P(u, v), e = edge(u, v);
          const k = Math.max(0, 1 - e / 0.3);
          const h = tilt + relief(a, s) * (1 - k) - R * (1 - Math.sqrt(Math.max(0, 1 - k * k)));
          path.point(s, a, h, o);
          return uvS((a - A0) / (A1 - A0), s / 6);
        });
        // 底面：从边上同一圈开始往下鼓，中间垂得最深，带一点不规则的垂坠
        const NB = 3;
        this.grid(NB, NB, sideSlot, (u, v, o) => {
          const uu = 1 - u, [a, s] = P(uu, v), e = edge(uu, v);
          const sag = Math.pow(Math.min(1, e / 0.5), 0.6) * depth * (0.75 + 0.5 * vnoise(a * 9 + seed, s * 0.7));
          path.point(s, a, tilt - R - sag, o);
          return [uu, v];
        });
      }
    }
  }

  // 石桥：从 a0 到 a1（两条道的边缘之间）的一座短桥，以 sc 为中心沿管道宽 w 米。
  // 两头宽、中间细，桥面比赛道略低并往下凹，底下往下垂，像两根钟乳石长到了一起
  stoneBridge(path, a0, a1, sc, w, depth, sag, slot, seed, topSlot = slot) {
    const nu = 8, nv = 3;
    const e = (u) => Math.abs(2 * u - 1);                       // 0 = 桥中间，1 = 两头
    const half = (u) => (w / 2) * (0.4 + 0.6 * Math.pow(e(u), 1.6));
    const A = (u) => a0 + u * (a1 - a0);
    const top = (u) => -0.03 - sag * Math.pow(1 - e(u), 1.3);
    const bot = (u, t) => top(u) - depth * (0.5 + 0.4 * vnoise(u * 4 + seed, t * 3)) - sag * 1.6 * Math.pow(1 - e(u), 2);
    this.grid(nu, nv, topSlot, (u, v, out) => { path.point(sc + (2 * v - 1) * half(u), A(u), top(u), out); return [u * 0.3, (sc + (2 * v - 1) * half(u)) / 16]; });
    this.grid(nu, nv, slot, (u, v, out) => { path.point(sc + (2 * v - 1) * half(u) * 0.8, A(u), bot(u, v), out); return [u * 2, v]; });
    for (const side of [-1, 1]) {
      this.grid(nu, 2, slot, (u, v, out) => {
        const h = top(u) + (bot(u, side > 0 ? 1 : 0) - top(u)) * v;
        path.point(sc + side * half(u) * (1 - 0.2 * v), A(u), h, out);
        return [u * 2, v];
      });
    }
  }

  // 钟乳石：从 (s, a, h0) 往管道外侧垂下去的一根尖锥，长 len 米，根部半径 r 米
  stalactite(path, s, a, h0, len, r, slot) {
    const W = trackRadius() * laneAng();
    this.grid(7, 3, slot, (u, v, out) => {
      const ang = u * Math.PI * 2, rr = r * Math.pow(1 - v, 1.4);
      path.point(s + Math.cos(ang) * rr, a + Math.sin(ang) * rr / W, h0 - v * len, out);
      return [u, v];
    });
  }

  // 开场峡谷的谷底和两侧岩壁（见 CANYON）
  canyon(path, topSlot, sideSlot) {
    const A0 = 2.75, A1 = 8.25, S0 = CANYON.start, NEAR = -160;
    // 谷底：远处（起点之前）稀一点，近处 0.8 米一排，表面和石带一样有几厘米的起伏；断口处圆滑地往下收
    const relief = (s, a) => 0.06 + 0.07 * (vnoise(s * 0.8, a * 3) - 0.5) + 0.04 * (vnoise(s * 2.1, a * 6.5) - 0.5);
    const floor = (sFn, ns) => this.grid(44, ns, topSlot, (u, v, out) => {
      const a = A0 + u * (A1 - A0), e = canyonFloorEnd(a), s = sFn(v, e);
      const tail = Math.max(0, (s - (e - 3)) / 3);
      path.point(s, a, relief(s, a) - 2.4 * tail * tail, out);
      return [a, s / 6];
    });
    floor((v) => S0 + v * (NEAR - S0), 40);
    floor((v, e) => NEAR + v * (e - NEAR), Math.ceil((250 - NEAR) / 0.8));

    // 岩壁：从谷底边缘往上，越高越往外翻（U 形），顶上再往外铺成一片起伏的谷顶
    const up = new THREE.Vector3(), sd = new THREE.Vector3();
    const W0 = CANYON.wall0, W1 = CANYON.wall1;
    for (const sg of [-1, 1]) {
      const fall = (s) => clamp((s - W0) / (W1 - W0), 0, 1);
      const H = (s) => {
        const t = fall(s);
        const base = 34 + 24 * vnoise(s * 0.011, sg * 3.1 + 1) + 9 * vnoise(s * 0.05, sg * 5);
        const crack = 1 - 0.65 * t * vnoise(s * 0.16, sg * 7.7); // 变矮的同时一道道裂开、参差不齐
        return Math.max(0.4, base * Math.pow(1 - t, 1.4) * crack);
      };
      const faceX = (s, y, h) => {
        const rough = clamp(y / 3, 0, 1); // 贴着谷底的地方和谷底平滑接上
        return R - 0.4 + 0.22 * y + 16 * Math.pow(y / Math.max(h, 1), 2)
          + rough * (6 * (vnoise(s * 0.03, y * 0.05 + sg * 7) - 0.5) + 2.2 * (vnoise(s * 0.12, y * 0.18 + sg) - 0.5) + 0.6 * (vnoise(s * 0.5, y * 0.6 + sg * 3) - 0.5));
      };
      const wall = (sFn, ns) => this.grid(ns, 36, sideSlot, (u, v, out) => {
        const s = sFn(u), h = H(s), t = fall(s);
        let X, Y;
        if (v <= 0.75) {
          Y = -1.6 + (h + 1.6) * (v / 0.75);
          X = faceX(s, Math.max(0, Y), h);
        } else {
          const q = (v - 0.75) / 0.25;
          const X0 = faceX(s, h, h);
          X = X0 + q * (45 + 35 * vnoise(s * 0.02, sg * 2.3)) * (1 - t);
          Y = h + (3 + 7 * vnoise(s * 0.03 + q * 2.5, sg * 2 + q)) * Math.sin(q * Math.PI * 0.6) * clamp(h / 20, 0, 1);
        }
        const f = path.frame(s);
        // 截面里的“上”和“侧”（随管道扭转一起转）
        const c = Math.cos(f.tw), si = Math.sin(f.tw);
        up.copy(f.n).multiplyScalar(-c).addScaledVector(f.b, -si);
        sd.copy(f.n).multiplyScalar(-si * sg).addScaledVector(f.b, c * sg);
        out.copy(f.p).addScaledVector(sd, X).addScaledVector(up, Y);
        return [s / 8, v * 6];
      });
      wall((u) => S0 + u * (NEAR - S0), 40);
      wall((u) => NEAR + u * (W1 - NEAR), Math.ceil((W1 - NEAR) / 1.2));
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
    this.seed = seed;
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
    this.jobs = []; // 等着建几何的节（见 runJobs）
    this.update(0, 0, 0);
  }

  // 终点位置（终点节还没生成时用赛道长度估计）
  get goal() { return Math.min(this.finishS, this.raceLength); }

  // 生存模式的难度节奏整体拉长：走 1.5 米才相当于竞速的 1 米
  pace(dist) { return this.mode === 'race' ? dist : dist / SURVIVAL_STRETCH; }

  difficulty(s) {
    if (this.mode === 'race') return clamp((s - 300) / (this.raceLength - 700), 0, 1);
    return clamp((this.pace(s) - 300) / 9000, 0, 1.35);
  }

  // 弯道强度随阶段增加：热身和认识阶段很缓，组合阶段中等，断崖阶段最急
  curveAmp(dist) {
    const x = this.pace(dist);
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
  stage(dist) { return this.stageAt(this.pace(dist)); }

  stageAt(x) {
    const P = (a, b) => clamp((x - a) / (b - a), 0, 1);
    if (x < 800) return { name: 'warm', t: P(0, 800) };
    if (x < 3000) return { name: 'teach', t: P(800, 3000), intro: Math.min(INTRO.length - 1, Math.floor((x - 800) / 440)) };
    if (x < 5000) return { name: 'combo', t: P(3000, 5000) };
    if (x < 7200) return { name: 'cliff', t: P(5000, 7200) };
    return { name: 'beyond', t: P(7200, 16000) };
  }

  // 每个阶段的空隙、平台长度、赛道数、各类型权重、大空隙
  stageParams(dist) {
    const x = this.pace(dist);
    const st = this.stageAt(x);
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
      gap = lerp(25, 31, t); len = lerp(82, 56, t); count = Math.round(lerp(7, 4, t)); // 至少留 4 条（原来最后只剩 3 条，加上开洞常常只剩 1～2 条）
      weights = [[N.NORMAL, 1], [N.BOOST, 0.25], [N.SLOW, 0.14], [N.BOUNCE, 0.12],
        [N.SHORT, 0.24], [N.OBSTACLE, 0.28], [N.CRUMBLE, 0.24]];
      // 前段先练 46–52 米；5.8km 起逐步变成 60–66 米，必须踩加速或连跳
      // 跨度比原来短 4～6 米：仍然要踩加速或连跳，但不那么卡极限
      bigGap = x < 5800
        ? { chance: 0.3, min: 44, max: 49 }
        : { chance: lerp(0.3, 0.4, t), min: lerp(52, 55, t), max: lerp(56, 60, t) };
    } else {
      gap = lerp(31, 36, t); len = lerp(56, 48, t); count = Math.round(lerp(4, 3, t));
      weights = [[N.NORMAL, 1], [N.BOOST, 0.28], [N.SLOW, 0.14], [N.BOUNCE, 0.12],
        [N.SHORT, 0.26], [N.OBSTACLE, 0.3], [N.CRUMBLE, 0.26]];
      bigGap = { chance: 0.4, min: 55, max: 62 };
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

  // 连贯模式：在这一节里扣洞
  //   道中间的洞：一条道中间缺 10～24 米，旁边至少有一条道在这段是完整的（可以换道绕开，也可以跳过去）
  //   不规则大缺口：横跨 2～4 条相邻的道、斜着错开，每条缺 16～26 米（普通跳就能过）
  // 打断过长的“直路”：任何一条普通/加速道（跨节连起来算）连续能开的长度不超过 LIMIT 米，
  // 超过了就在那里开一个 10～16 米的洞（旁边要有别的完整的普通/加速道），玩家必须换道或起跳。
  // LIMIT 按阶段：热身约 4 秒，越往后越短（约 2.3 秒）
  breakLongRuns(lanes, s0, s1, P, split, canyon) {
    const r = this.rand;
    const LIMIT = { warm: 250, teach: 210, combo: 180, cliff: 150, beyond: 140 }[P.st.name] || 180;
    if (!this.runStart) this.runStart = new Array(LANES).fill(null);
    const good = (L) => L && (L.type === TYPE.NORMAL || L.type === TYPE.BOOST);
    const holeAt = (L, a, b) => L.holes && L.holes.some(([h0, h1]) => h0 < b && h1 > a);
    const solid = (j, a, b) => { const L = lanes[j]; return L && L.type !== TYPE.CRUMBLE && L.s0 <= a && L.s1 >= b && !holeAt(L, a, b); };
    for (let i = 0; i < LANES; i++) {
      const L = lanes[i];
      if (!good(L)) { this.runStart[i] = null; continue; }
      if (canyon) { this.runStart[i] = s1; continue; }        // 峡谷是开场热身，从峡谷尽头开始算
      const grp = split ? (i < 5 ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9]) : (laneClusters(lanes.map(Boolean)).find((cl) => cl.includes(i)) || []);
      const hs = (L.holes || []).slice().sort((x, y) => x[0] - y[0]);
      const pieces = [];
      { let a = L.s0; for (const [h0, h1] of hs) { if (h0 > a) pieces.push([a, h0]); a = Math.max(a, h1); } if (L.s1 > a) pieces.push([a, L.s1]); }
      let lastSt = null, lastEnd = -1;
      for (const [p0, p1] of pieces) {
        let st = p0 === s0 && L.s0 === s0 && this.runStart[i] !== null ? this.runStart[i] : p0;
        while (p1 - st > LIMIT) {
          // 从该打断的位置开始往后找，每次挪 12 米，直到旁边有别的完整普通/加速道可走
          let placed = false;
          for (let a = Math.max(p0 + 8, st + LIMIT * (0.8 + 0.2 * r())); ; a += 12) {
            const b = a + lerp(10, 16, r());
            if (b > p1 - 8) break;
            if (grp.some((j) => j !== i && good(lanes[j]) && solid(j, a - 6, b + 6))) {
              (L.holes || (L.holes = [])).push([a, b]);
              L.obstacles = L.obstacles.filter((os) => os < a - 6 || os > b + 6);
              st = b;
              placed = true;
              break;
            }
          }
          if (!placed) break; // 这一节放不下，计数不清零，下一节一开头接着找
        }
        lastSt = st; lastEnd = p1;
      }
      this.runStart[i] = lastEnd === s1 ? lastSt : null;
    }
  }

  // 分岔里险路那一半开洞：每条道 0～2 个 10～22 米的洞，只开在两半完全分开的那段里，
  // 并且同一处这一半至少还留 2 条完整的道
  carveSplitHoles(lanes, s0, s1, sp) {
    const r = this.rand;
    const half = sp.risky < 0 ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9];
    const safe = sp.risky < 0 ? [5, 6, 7, 8, 9] : [0, 1, 2, 3, 4];
    const lo = Math.max(s0 + 10, sp.s0 + SPLIT.ramp * 0.6), hi = Math.min(s1 - 10, sp.s1 - SPLIT.ramp * 0.6);
    if (hi - lo < 30) return;
    const holeAt = (L, a, b) => L.holes && L.holes.some(([h0, h1]) => h0 < b && h1 > a);
    for (const i of half) {
      const L = lanes[i];
      if (!L) continue;
      const n = r() < 0.75 ? 1 + (r() < 0.4 ? 1 : 0) : 0;
      for (let k = 0; k < n; k++) {
        const hl = lerp(10, 22, r());
        const a = lo + r() * (hi - lo - hl), b = a + hl;
        if (holeAt(L, a - 12, b + 12)) continue;
        const solidN = half.filter((j) => j !== i && lanes[j] && !holeAt(lanes[j], a - 6, b + 6)).length;
        if (solidN < 2) continue;
        (L.holes || (L.holes = [])).push([a, b]);
      }
    }
    if (r() < 0.6) {
      const i = safe[Math.floor(r() * 5)], L = lanes[i];
      const hl = lerp(8, 14, r());
      const a = lo + r() * (hi - lo - hl), b = a + hl;
      if (L && safe.filter((j) => j !== i && lanes[j] && !holeAt(lanes[j], a - 6, b + 6)).length >= 3) (L.holes || (L.holes = [])).push([a, b]);
    }
  }

  carveHoles(lanes, s0, s1, P) {
    const r = this.rand;
    const name = P.st.name, t = P.st.t;
    const len = s1 - s0;
    // 洞只开在普通道、加速道上（以前减速道开洞后会被改成普通道，结果并排出现两条一样的道）
    const okType = (L) => L && (L.type === TYPE.NORMAL || L.type === TYPE.BOOST) && L.s0 === s0 && L.s1 === s1;
    const holeAt = (L, a, b) => L && L.holes && L.holes.some(([h0, h1]) => h0 < b && h1 > a);
    const solid = (i, a, b) => { const L = lanes[(i + LANES) % LANES]; return L && L.s0 <= a && L.s1 >= b && !holeAt(L, a, b) && L.type !== TYPE.CRUMBLE; };
    // 除了第 skip 条（可以是一组），[a, b] 这一段还有没有完整的普通/加速道
    const clusterOf = new Array(LANES).fill(-1);
    laneClusters(lanes.map(Boolean)).forEach((cl, n) => cl.forEach((i) => { clusterOf[i] = n; }));
    const goodSolid = (skip, a, b) => {
      const sk = Array.isArray(skip) ? skip : [skip];
      const cid = clusterOf[(sk[0] + LANES) % LANES];
      return lanes.some((L, j) => L && !sk.includes(j) && clusterOf[j] === cid && isGoodType(L.type) && solid(j, a, b));
    };
    const addHole = (L, a, b) => {
      (L.holes || (L.holes = [])).push([a, b]);
      L.obstacles = L.obstacles.filter((os) => os < a - 6 || os > b + 6);
    };
    // 道中间的洞
    let nHoles = 0;
    if (name === 'warm') nHoles = r() < 0.4 ? 1 : 0;           // 热身段也偶尔有个小洞，绕一下就过
    else if (name === 'teach') nHoles = 1 + (r() < 0.3 + 0.3 * t ? 1 : 0);
    else if (name === 'combo') nHoles = 1 + (r() < 0.5 ? 1 : 0);
    else if (name !== 'warm' && name !== 'teach') nHoles = 2 + (r() < 0.4 ? 1 : 0);
    for (let k = 0; k < nHoles && len > 70; k++) {
      const cands = lanes.map((L, i) => (okType(L) ? i : -1)).filter((i) => i >= 0);
      if (!cands.length) break;
      const i = cands[Math.floor(r() * cands.length)];
      const hl = name === 'warm' ? lerp(8, 14, r()) : lerp(10, 24, r());
      const a = s0 + 20 + r() * (len - 40 - hl), b = a + hl;
      if (holeAt(lanes[i], a - 10, b + 10)) continue;
      if (!solid(i - 1, a - 8, b + 8) && !solid(i + 1, a - 8, b + 8)) continue;
      {
        // 开洞处整圈至少还留 2 条完整的道（断崖之后 3 条），不会只剩独木桥
        let keep = 0;
        for (let j = 0; j < LANES; j++) if (j !== i && solid(j, a - 6, b + 6)) keep++;
        if (keep < (name === 'cliff' || name === 'beyond' ? 3 : 2)) continue;
        if (!goodSolid(i, a - 6, b + 6)) continue;
      }
      addHole(lanes[i], a, b);
    }
    // 不规则大缺口
    const chance = name === 'teach' ? 0.15 : name === 'combo' ? 0.3 + 0.15 * t : name === 'cliff' || name === 'beyond' ? 0.45 : 0;
    if (len > 80 && r() < chance) {
      const w = 2 + Math.floor(r() * 3);
      const j = Math.floor(r() * LANES);
      const step = (r() < 0.5 ? 1 : -1) * lerp(6, 12, r());
      const start = s0 + 25 + (step < 0 ? -step * (w - 1) : 0);
      const plan = [];
      for (let k = 0; k < w; k++) {
        const i = (j + k) % LANES, L = lanes[i];
        if (!L || L.type === TYPE.CRUMBLE || L.type === TYPE.SHORT || L.type === TYPE.SLOW) continue;
        const hl = lerp(16, 26, r());
        const a = start + k * step, b = a + hl;
        if (a < L.s0 + 15 || b > L.s1 - 15 || holeAt(L, a - 6, b + 6)) continue;
        plan.push([i, a, b]);
      }
      // 整个缺口范围内，缺口以外至少还要有 2 条完整的道
      if (plan.length) {
        const lo = Math.min(...plan.map((x) => x[1])), hi = Math.max(...plan.map((x) => x[2]));
        let keep = 0;
        for (let i = 0; i < LANES; i++) if (!plan.some((x) => x[0] === i) && solid(i, lo, hi)) keep++;
        if (keep >= (name === 'cliff' || name === 'beyond' ? 3 : 2) && goodSolid(plan.map((x) => x[0]), lo, hi)) for (const [i, a, b] of plan) addHole(lanes[i], a, b);
      }
    }
  }

  // 陨石外表面模式：选这一节陨石占哪几条道。
  // 和上一块至少重叠 2 条道（过大空隙时至少覆盖一条起跳的加速道），中心大致跟着上一块，左右慢慢漂移
  rockPattern(prevLanes, mustHit, idx, isFinish, wide) {
    const r = this.rand;
    const out = new Array(LANES).fill(false);
    const early = idx < 3 || isFinish;
    if (idx === 0 || !prevLanes) { for (let i = 2; i < 8; i++) out[i] = true; return { present: out, fork: false }; }
    const pc = prevLanes.reduce((x, y) => x + y, 0) / prevLanes.length + 0.5;
    const overlap = (a0, w) => prevLanes.filter((i) => i >= a0 && i < a0 + w).length;
    const hits = (a0, w) => !mustHit || mustHit.some((i) => i >= a0 && i < a0 + w);
    const pick = (w) => {
      const need = Math.min(2, w, prevLanes.length);
      const cand = [];
      for (let a0 = 0; a0 + w <= LANES; a0++) {
        if (overlap(a0, w) < need || !hits(a0, w)) continue;
        const d = Math.abs(a0 + w / 2 - pc);
        cand.push([a0, 1 / (1 + d * d)]);
      }
      if (!cand.length) return -1;
      let t = r() * cand.reduce((x, c) => x + c[1], 0);
      for (const [a0, wt] of cand) { t -= wt; if (t <= 0) return a0; }
      return cand[cand.length - 1][0];
    };
    if (!early && !wide && r() < 0.22) {
      // 分岔：两块小陨石，中间空 1～2 条道
      const w1 = 2 + Math.floor(r() * 2), w2 = 2 + Math.floor(r() * 2), g = 1 + Math.floor(r() * 2);
      const a0 = pick(w1);
      if (a0 >= 0) {
        const right = a0 + w1 + g, left = a0 - g - w2;
        const b0 = right + w2 <= LANES && (left < 0 || r() < 0.5) ? right : left;
        if (b0 >= 0 && b0 + w2 <= LANES) {
          for (let i = 0; i < w1; i++) out[a0 + i] = true;
          for (let i = 0; i < w2; i++) out[b0 + i] = true;
          return { present: out, fork: true };
        }
      }
    }
    let w = early ? 6 : 2 + Math.floor(r() * 5);
    if (wide) w = Math.max(w, 4);
    let a0 = pick(w);
    if (a0 < 0) { w = 6; a0 = pick(w); }
    if (a0 < 0) a0 = clamp(Math.round(pc - w / 2), 0, LANES - w);
    for (let i = 0; i < w; i++) out[a0 + i] = true;
    return { present: out, fork: false };
  }

  generate() {
    const r = this.rand;
    const idx = this.sections.length;
    const prev = this.sections[idx - 1];
    const first = idx === 0;
    const P = this.stageParams(this.genS);
    // 上一节如果预约了大空隙，这一节前面就是这个大空隙
    const big = prev ? prev.bigGapNext : 0;
    const gap = first ? 0 : big || (TRACK_STYLE.continuous ? 0 : P.gap * (0.85 + 0.3 * r()));
    let len = first ? 320 : P.len * (0.8 + 0.4 * r());
    if (big) len = Math.max(len, 75); // 大空隙后的落脚平台给长一点
    const s0 = this.genS + gap;
    let isFinish = false;
    if (s0 + len >= this.raceLength) { isFinish = true; len = 340; }
    const s1 = s0 + len;

    // 分岔：到点了就从这一节开头不远处劈开（大空隙后的落脚节不劈；离终点太近不劈）
    if (TRACK_STYLE.splits && !TRACK_STYLE.outside && !isFinish && !TEST_BOOST) {
      if (this.nextSplit === undefined) this.nextSplit = lerp(SPLIT.first[0], SPLIT.first[1], r());
      const sl = lerp(SPLIT.len[0], SPLIT.len[1], r());
      if (!big && s0 >= this.nextSplit && s0 + 20 + sl < this.raceLength - 400) {
        this.path.splits.push({ s0: s0 + 20, s1: s0 + 20 + sl, risky: r() < 0.5 ? -1 : 1, drop: r() < 0.5 ? -1 : 1 });
        this.nextSplit = s0 + 20 + sl + lerp(SPLIT.every[0], SPLIT.every[1], r()) - sl;
      }
    }
    const split = this.path.splits.find((sp) => sp.s0 < s1 && sp.s1 > s0) || null;

    // 预约这一节后面的空隙要不要是大空隙（预约了，这一节就要准备好加速赛道）
    let bigGapNext = 0;
    const cliffOk = !TRACK_STYLE.continuous || P.st.name === 'cliff' || P.st.name === 'beyond';
    const splitSoon = split || (this.nextSplit !== undefined && s1 + 400 > this.nextSplit);
    // 两个整圈断口之间至少隔 700 米，不会连着几个大跳
    const bigSpaced = !TEST_BOOST && (this.lastBigS === undefined || s1 - this.lastBigS > 700);
    if (!first && !big && !isFinish && !splitSoon && bigSpaced && cliffOk && P.bigGap && r() < P.bigGap.chance * (TRACK_STYLE.continuous ? (this.mode === 'race' ? 0.6 : 0.3) * (P.st.name === 'cliff' ? 1 : 0.5) : 1) && s1 < this.raceLength - 600) {
      bigGapNext = lerp(P.bigGap.min, P.bigGap.max, r());
      this.lastBigS = s1;
      // 大空隙前后把管道拉直，关键跳跃一定看得见落点
      this.path.calm.push([s1 - 50, s1 + bigGapNext + 70]);
    }

    // 哪些赛道存在
    // 热身和认识阶段始终 10 条赛道（不出现坑），之后才在目标数量上下浮动
    let count = idx < 3 || isFinish || split || P.count >= 10 ? 10 : clamp(P.count + Math.round((r() - 0.5) * 2), 2, 10);
    if (big || bigGapNext) count = Math.max(count, big ? 6 : 4); // 大空隙前后留足赛道；落脚的那一节多给几条，落点宽一些
    let present = count < 10 ? this.lanePattern(count) : new Array(LANES).fill(true);
    // 起跳赛道：过大空隙只能从加速赛道起跳（连跳是另一条备用路线）
    if (prev) {
      const prevLanes = prev.lanes.map((L, i) => (L ? i : -1)).filter((i) => i >= 0);
      const boosts = prevLanes.filter((i) => prev.lanes[i].type === TYPE.BOOST);
      this.ensureRoutes(present, big && boosts.length ? boosts : prevLanes);
    }

    // 连贯模式·远处扣：路线中心（慢慢漂移）正对面的 3～4 条道扣掉，管道变得通透，但车附近完整
    const clusters = TRACK_STYLE.continuous && !TRACK_STYLE.outside && !isFinish && !(first && TRACK_STYLE.canyon);
    if (!clusters && TRACK_STYLE.continuous && !isFinish && !big && !bigGapNext && !split && present.filter(Boolean).length >= 8) {
      if (this.routeC === undefined) this.routeC = 5;
      if (idx > 1 && r() < 0.5) this.routeC = (this.routeC + (r() < 0.5 ? 1 : -1) + LANES) % LANES;
      const far = (this.routeC + 5) % LANES;
      const n = 3 + (r() < 0.4 ? 1 : 0);
      for (let k = 0; k < n; k++) present[(far - 1 + k + LANES) % LANES] = false;
      if (prev) {
        const prevLanes = prev.lanes.map((L, i) => (L ? i : -1)).filter((i) => i >= 0);
        this.ensureRoutes(present, prevLanes);
      }
    }

    // 石带成簇：一节只有一簇 3～4 条并排的道，或者“2 条、空 2 条、2 条”，其余都空着，能看到更多宇宙背景。
    // 簇的中心 routeC 每节最多漂 1 条道，前后两节接得上；分岔前漂回管道底部（第 5 条道附近），两半都有路
    if (clusters) {
      if (this.routeC === undefined) this.routeC = 5;
      const toSplit = this.nextSplit !== undefined && this.nextSplit - s0 < 600;
      if (toSplit || split) {
        if (this.routeC !== 5) this.routeC = (this.routeC + (shortestDelta(this.routeC, 5) > 0 ? 1 : -1) + LANES) % LANES;
      } else if (idx > 1 && r() < 0.55) this.routeC = (this.routeC + (r() < 0.5 ? 1 : -1) + LANES) % LANES;
      const c = this.routeC, name = P.st.name;
      const late = name === 'cliff' || name === 'beyond';
      const u = r();
      let set;
      if (big || bigGapNext || name === 'warm') set = [-1, 0, 1, 2];                 // 4 条（热身、大断口前后）
      else if (u < (late ? 0.45 : 0.3)) set = [-1, 0, 1];                           // 3 条
      else if (u < (late ? 0.65 : 0.65)) set = [-1, 0, 1, 2];                       // 4 条
      else set = [-3, -2, 1, 2];                                                     // 2 条、空 2 条、2 条
      present = new Array(LANES).fill(false);
      for (const d of set) present[(c + d + LANES) % LANES] = true;
      if (prev) {
        const prevLanes = prev.lanes.map((L, i) => (L ? i : -1)).filter((i) => i >= 0);
        const boosts = prevLanes.filter((i) => prev.lanes[i].type === TYPE.BOOST);
        this.ensureRoutes(present, big && boosts.length ? boosts : prevLanes);
      }
    }

    // 陨石外表面模式：这一节是一块 2～6 条道的陨石，偶尔并排两块小陨石（分岔）
    let fork = false;
    if (TRACK_STYLE.outside) {
      const prevLanes = prev ? prev.lanes.map((L, i) => (L ? i : -1)).filter((i) => i >= 0) : null;
      const boosts = prev && big ? prevLanes.filter((i) => prev.lanes[i].type === TYPE.BOOST) : null;
      ({ present, fork } = this.rockPattern(prevLanes, boosts && boosts.length ? boosts : null, idx, isFinish, big || bigGapNext));
    }

    // 各条赛道的类型
    const types = new Array(LANES).fill(TYPE.NORMAL);
    if (!(idx < 2 || isFinish)) {
      for (let i = 0; i < LANES; i++) if (present[i]) types[i] = this.pickType(P.weights);
      // 认识阶段：正在学的新赛道连着放 3 条，单独出现，容易看清
      if (P.st.name === 'teach' && r() < 0.85) {
        // 从有道的地方开始放（成簇以后大部分位置是空的）
        const have = present.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0);
        const start = have[Math.floor(r() * have.length)];
        // 至少留 2 条普通的道（一簇只有 3～4 条，3 条全是碎裂道就没路了）
        const nIntro = Math.max(1, Math.min(3, have.length - 2));
        for (let k = 0; k < nIntro; k++) {
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
      if (!bigGapNext && !big && !TRACK_STYLE.outside) this.lureByBend(types, present, s1, P.st.name, P.st.name === 'teach' ? INTRO[P.st.intro] : -1);
      // 障碍类的道（减速、冰刺、短台、碎裂）是让玩家找最优解的，不能整节都是：
      // 至多一半是障碍类，至少留一条普通或加速道。超出的先把减速道改回普通（认识阶段正在学的那种最后才改）
      const have = types.map((t, i) => (present[i] ? i : -1)).filter((i) => i >= 0);
      // 普通、加速以外的都算（弹射也算：它会把车弹起来，不是“正常路”）
      const isBad = (t) => t !== TYPE.NORMAL && t !== TYPE.BOOST;
      const learning = P.st.name === 'teach' ? INTRO[P.st.intro] : -1;
      let bad = have.filter((i) => isBad(types[i]));
      // 普通/加速道至少占一半（向上取整），最少 1 条：2 条道时至少 1 条正常路
      const allow = Math.max(0, have.length - Math.max(1, Math.ceil(have.length / 2)));
      const order = (i) => (types[i] === learning ? 9 : types[i] === TYPE.SLOW ? 0 : types[i] === TYPE.BOUNCE ? 1 : 2);
      bad.sort((a, b) => order(a) - order(b));
      while (bad.length > allow) types[bad.shift()] = TYPE.NORMAL;
    }

    // 每一簇挨在一起的道：至少一条普通或加速道；并排的两条道类型不一样
    if (!split && !isFinish && !(first && TRACK_STYLE.canyon) && !TRACK_STYLE.outside) {
      const learning = P.st.name === 'teach' ? INTRO[P.st.intro] : -1;
      for (const cl of laneClusters(present)) {
        if (!cl.some((i) => isGoodType(types[i]))) {
          // 找一条不是正在学的那种的道改成普通道（找不到就改中间那条）
          const i = cl.find((j) => types[j] !== learning) ?? cl[Math.floor(cl.length / 2)];
          types[i] = TYPE.NORMAL;
        }
        for (let k = 1; k < cl.length; k++) {
          const a = cl[k - 1], b = cl[k], c = cl[k + 1];
          if (types[b] !== types[a]) continue;
          // 和左边一样：换成普通或加速里和左右都不一样的那个
          const pick = [TYPE.NORMAL, TYPE.BOOST].find((t) => t !== types[a] && (c === undefined || t !== types[c]));
          types[b] = pick ?? (types[a] === TYPE.NORMAL ? TYPE.BOOST : TYPE.NORMAL);
        }
      }
    }

    // 测试赛道：整圈都是加速道（峡谷那一节保持原样）
    if (TEST_BOOST && !(first && TRACK_STYLE.canyon)) { present.fill(true); types.fill(TYPE.BOOST); }

    // 分岔里：两半各管各的。稳路全是普通道；险路有 2 条加速道，后面还会开洞
    if (split && !(idx < 2)) {
      // 两半各 3 条道，贴着管道底部那道缝（第 2～4 条 / 第 5～7 条）
      for (let i = 0; i < LANES; i++) {
        present[i] = clusters ? i >= 2 && i <= 7 : true;
        types[i] = TYPE.NORMAL;
      }
      const rk = split.risky < 0 ? [2, 3, 4] : [5, 6, 7];
      const b1 = rk[Math.floor(r() * 3)];
      let b2 = rk[Math.floor(r() * 3)];
      if (b2 === b1) b2 = rk[(rk.indexOf(b1) + 2) % 3];
      types[b1] = TYPE.BOOST;
      types[b2] = TYPE.BOOST;
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

    if (TEST_BOOST) { /* 测试赛道不开洞 */ }
    else if (split) this.carveSplitHoles(lanes, s0, s1, split);
    else if (TRACK_STYLE.continuous && !isFinish && idx >= 3) this.carveHoles(lanes, s0, s1, P);

    // 开场峡谷：谷底只有第 3～7 条道，管道上半圈的道快到峡谷尽头才一条条长出来；
    // 下一节没有的道就不长了（不然刚长出来又断掉）
    const canyon = first && TRACK_STYLE.canyon && !isFinish;
    if (canyon) for (const k in CANYON_GROW) if (lanes[k]) lanes[k].s0 = canyonLaneStart(+k);
    if (prev && prev.canyon) for (const k in CANYON_GROW) if (!lanes[k]) prev.lanes[k] = null;
    if (TRACK_STYLE.continuous && !TRACK_STYLE.outside && !isFinish && !TEST_BOOST) this.breakLongRuns(lanes, s0, s1, P, split, canyon);

    // bigGap：这一节前面是大空隙（用于提示）；bigGapNext：这一节后面预约了大空隙
    const sec = { s0, s1, lanes, isFinish, mesh: null, extras: [], bigGap: big, bigGapNext, fork, canyon };
    // 新赛道第一次出现的那一节做个标记，游戏里会弹出说明
    if (idx === 2) sec.intro = TYPE.BOOST;
    if (P.st.name === 'teach' && P.st.intro !== this.lastIntro && types.includes(INTRO[P.st.intro])) {
      sec.intro = INTRO[P.st.intro];
      this.lastIntro = P.st.intro;
    }
    // 石带模式要知道前后两节是否接着同一条道（接着就不封口），所以等下一节生成了再建上一节的几何
    if (!TRACK_STYLE.slab) this.queueBuild(sec, null);
    else if (prev && !prev.queued) this.queueBuild(prev, sec);
    this.sections.push(sec);
    if (TRACK_STYLE.slab && isFinish) this.queueBuild(sec, null);
    this.genS = s1;
    if (isFinish) {
      this.finishS = s0 + 50;
      this.done = true;
      this.addFinishGate(sec);
    }
  }

  // 陨石风格：相邻、等长的几条赛道合成一块陨石（每块 1～3 条道），碎裂赛道和短台单独一块
  rockGroups(lanes, s0) {
    const join = (A, B) => A && B && A.type !== TYPE.CRUMBLE && B.type !== TYPE.CRUMBLE && A.s0 === B.s0 && A.s1 === B.s1;
    let start = 0;
    if (!TRACK_STYLE.outside) for (let i = 0; i < LANES; i++) if (lanes[i] && !join(lanes[(i + LANES - 1) % LANES], lanes[i])) { start = i; break; }
    const groups = [];
    let cur = null, limit = 0;
    for (let k = 0; k < LANES; k++) {
      const i = (start + k) % LANES, L = lanes[i];
      if (!L) { cur = null; continue; }
      if (cur && cur.length < limit && join(cur[cur.length - 1], L)) { cur.push(L); continue; }
      cur = [L];
      limit = TRACK_STYLE.outside ? LANES : 1 + Math.floor(vnoise(s0 * 0.37 + i * 1.9, i * 2.3) * 3);
      groups.push(cur);
    }
    return groups;
  }

  queueBuild(sec, next) {
    sec.queued = true;
    sec.parts = [];
    this.jobs.push({ sec, it: this.buildSection(sec, next) });
  }

  // 每帧调用：按队列顺序建几何，离车 350 米以内的节必须马上建完，其余每帧最多花 budget 毫秒
  runJobs(carS, budget = 3) {
    const t0 = performance.now();
    while (this.jobs.length) {
      const job = this.jobs[0];
      if (job.sec.disposed) { this.jobs.shift(); continue; }
      const urgent = job.sec.s0 < carS + 350;
      if (!urgent && performance.now() - t0 > budget) break;
      if (job.it.next().done) this.jobs.shift();
    }
  }

  // 建一节的几何：每建完一条道就 yield 一次（交给 runJobs 决定要不要留到下一帧）
  *buildSection(sec, next = null) {
    const path = this.path;
    const gb = new GeoBuilder();
    const prev = this.sections[this.sections.indexOf(sec) - 1];
    // 第 i 条道和前一节 / 后一节是不是无缝接着的
    const flows = (L) => L && L.type !== TYPE.CRUMBLE;
    const contPrev = (i) => prev && prev.s1 === sec.s0 && flows(prev.lanes[i]) && prev.lanes[i].s1 === prev.s1;
    const contNext = (i) => next && next.s0 === sec.s1 && flows(next.lanes[i]) && next.lanes[i].s0 === next.s0;
    const solid = (L, a, b) => flows(L) && L.s0 <= a && L.s1 >= b && !(L.holes && L.holes.some(([h0, h1]) => h0 < b && h1 > a));
    const ends = []; // 石带断开的端头：{ i 第几条道, s 位置, dir 石带朝哪边延伸 }
    const rocky = TRACK_STYLE.slab ? 0 : TRACK_STYLE.rocky;
    const targets = new Map();
    for (const L of sec.lanes) if (L) targets.set(L, new GeoBuilder());
    const edgeOf = new Map(); // 每条赛道：[左边是陨石外缘, 右边是陨石外缘, 收边函数, 分块数]
    if (rocky) {
      for (const g of this.rockGroups(sec.lanes, sec.s0)) {
        const first = g[0], len = first.s1 - first.s0;
        const seed = sec.s0 * 0.013 + first.i * 3.7;
        // 长陨石沿前进方向切成几块，每块 20～35 米，接缝处顶面变窄，看起来是一块块椭圆的大石头
        const n = 1; // 一节一块巨石，不再切块
        const ins = (s, k) => {
          const t = clamp((s - first.s0) / len * n, 0, n) % 1;
          return 0.05 + 0.2 * Math.pow(1 - Math.sin(Math.PI * t), 4) + 0.05 * vnoise(s * 0.11 + seed + k * 9, k * 2.7);
        };
        g.forEach((L, k) => edgeOf.set(L, [k === 0, k === g.length - 1, ins, n]));
        for (let c = 0; c < n; c++) {
          const cs0 = first.s0 + len * c / n, cs1 = first.s0 + len * (c + 1) / n;
          const size = rocky * (1 + 0.2 * g.length) * clamp((cs1 - cs0) / 60, 0.5, 1.4);
          if (TRACK_STYLE.outside) targets.get(first).outsideRock(path, first.i, first.i + g.length, cs0, cs1, ins, SLOT_SIDE, seed + c * 7.3, g.length >= 2 && !sec.fork);
          else targets.get(first).boulder(path, first.i, first.i + g.length, cs0, cs1, ins, size, SLOT_SIDE, seed + c * 7.3);
        }
      }
    }
    for (const L of sec.lanes) {
      if (!L) continue;
      const a0 = L.i + 0.025, a1 = L.i + 0.975;
      const target = targets.get(L);
      const topSlot = sec.isFinish ? SLOT_FINISH : L.type;
      // 被洞切开的几段
      const pieces = [];
      { let a = L.s0; for (const [h0, h1] of (L.holes || []).slice().sort((x, y) => x[0] - y[0])) { if (h0 > a) pieces.push([a, h0]); a = Math.max(a, h1); } if (L.s1 > a) pieces.push([a, L.s1]); }
      // 峡谷里谷底盖住的部分不用建石带，石带从谷底断口下面一点开始
      if (sec.canyon) for (const p of pieces) p[0] = Math.max(p[0], canyonFloorEnd(L.i + 0.5) - 12);
      if (TRACK_STYLE.slab) {
        // 石带：每条道一条不规整的石头，和前后两段无缝相连，只有真的断开处才有端面
        const T = TRACK_STYLE.slab;
        for (const [p0, p1] of pieces) {
          if (L.type === TYPE.CRUMBLE) { target.shardLane(path, L.i, p0, p1, topSlot, SLOT_SIDE); continue; }
          const cs = !(p0 === sec.s0 && L.s0 === sec.s0 && flows(L) && contPrev(L.i));
          const ce = !(p1 === sec.s1 && L.s1 === sec.s1 && flows(L) && contNext(L.i));
          target.stoneLane(path, L.i, p0, p1, T, topSlot, SLOT_SIDE, cs, ce);
          if (flows(L)) { if (cs) ends.push({ i: L.i, s: p0, dir: 1 }); if (ce) ends.push({ i: L.i, s: p1, dir: -1 }); }
          // 钟乳石：沿两侧边缘往外垂；断开处（洞的边缘、道的尽头）垂得更密、更长
          for (const [edgeS, dir, open] of [[p0, 1, cs], [p1, -1, ce]]) {
            if (!open) continue;
            for (let m = 0; m < 2; m++) {
              const k = vnoise(edgeS * 0.7 + m * 3.3, L.i + m);
              target.stalactite(path, edgeS + dir * (2.5 + 2 * k), L.i + 0.3 + 0.4 * m, -T * 0.9, 1.5 + 3 * k, 0.4 + 0.3 * k, SLOT_SIDE);
            }
          }
        }
      } else if (L.holes) {
        for (const [p0, p1] of pieces) target.curvedBox(path, a0, a1, p0, p1, -THICK, 0, topSlot, SLOT_SIDE, sec.isFinish ? 4 : 16);
      } else if (rocky) {
        // 顶面：平整的跑道面，贴在陨石上；两侧各一条浅色岩纹作为赛道边线
        const ns = Math.max(2, Math.ceil((L.s1 - L.s0) / 2.5));
        const vs = sec.isFinish ? 4 : 16;
        // 陨石外缘往里收一点并带起伏（车总是在赛道中间跑，边缘收进去不影响落脚），
        // 相邻两块陨石之间就露出一道真正的空隙；同一块陨石里的相邻赛道则紧挨着
        const [le, re, ins, nChunk] = edgeOf.get(L);
        const A0 = (s) => L.i + (le ? ins(s, 0) : 0);
        const A1 = (s) => L.i + 1 - (re ? ins(s, 1) : 0);
        const S = (v) => L.s0 + v * (L.s1 - L.s0);
        target.grid(6, ns, topSlot, (u, v, out) => { const s = S(v); path.point(s, A0(s) + u * (A1(s) - A0(s)), 0, out); return [u, (s - L.s0) / vs]; });
        if (TRACK_STYLE.lines) {
          const W = 0.018;
          const strip = (f) => target.grid(1, ns, SLOT_EDGE + L.type, (u, v, out) => { const s = S(v); path.point(s, f(s) + u * W, 0.012, out); return [u, v]; });
          strip(le ? A0 : () => L.i - W / 2);  // 左边：陨石外缘，或与左邻赛道的分界（只画一次）
          if (re) strip((s) => A1(s) - W);
          // 两块陨石的接缝：横跨赛道的一道岩缝
          for (let c = 1; c < nChunk; c++) {
            const js = L.s0 + (L.s1 - L.s0) * c / nChunk;
            target.grid(4, 1, SLOT_EDGE + L.type, (u, v, out) => { path.point(js - 0.12 + v * 0.24, A0(js) + u * (A1(js) - A0(js)), 0.012, out); return [u, v]; });
          }
        }
      } else target.curvedBox(path, a0, a1, L.s0, L.s1, -THICK, 0, topSlot, SLOT_SIDE, sec.isFinish ? 4 : 16);
      // 端头发光条
      if (TRACK_STYLE.edges) {
        target.curvedBox(path, a0, a1, L.s0, Math.min(L.s0 + 0.6, L.s1), 0, 0.06, SLOT_EDGE + L.type, SLOT_EDGE + L.type);
        target.curvedBox(path, a0, a1, Math.max(L.s1 - 0.6, L.s0), L.s1, 0, 0.06, SLOT_EDGE + L.type, SLOT_EDGE + L.type);
      }
      for (const os of L.obstacles) {
        if (TRACK_STYLE.slab) this.addRocks(sec, path, a0, a1, os);
        else if (TRACK_STYLE.spikes) this.addSpikes(sec, path, a0, a1, os);
        else target.curvedBox(path, a0 + 0.04, a1 - 0.04, os - 0.5, os + 0.5, 0, WALL_H, SLOT_WALL, SLOT_WALL);
      }
      if (L.type !== TYPE.CRUMBLE) {
        if (target.pos.length) { const m = new THREE.Mesh(target.build(), this.mats); sec.parts.push(m); this.group.add(m); }
        yield;
        continue;
      }
      {
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
      yield;
    }
    if (TRACK_STYLE.slab) {
      // 石桥：每条石带断开的一头，和旁边一条还连着的道用一座短石桥连起来（像草图里那样钩在一起）
      const T = TRACK_STYLE.slab;
      for (const { i, s: e, dir } of ends) {
        const A = sec.lanes[i];
        const w = 3.5 + 4 * vnoise(e * 0.13, i * 3.9);
        const lo = dir > 0 ? e + 1 : e - 1 - w - 2.4, hi = lo + w + 2.4;
        if (!solid(A, lo, hi)) continue;
        const order = vnoise(e * 0.31, i) < 0.5 ? [1, -1] : [-1, 1];
        for (const d of order) {
          const n = (i + d + LANES) % LANES;
          if (!solid(sec.lanes[n], lo, hi)) continue;
          const b = (lo + hi) / 2;
          const left = d > 0 ? i : i - 1; // 桥在第 left 条和第 left+1 条道之间
          if (path.splitAt(b) && (left + LANES) % LANES % 5 === 4) continue; // 不跨过分岔的缝
          gb.stoneBridge(path, left + 1 - laneInset(left, b, 1) - 0.08, left + 1 + laneInset(left + 1, b, 0) + 0.08, b, w, T * 0.7, 0.05, SLOT_SIDE, b * 0.1 + i, TYPE.NORMAL);
          break;
        }
      }
    }
    if (sec.canyon) gb.canyon(path, TYPE.NORMAL, SLOT_SIDE);
    sec.mesh = new THREE.Mesh(gb.build(), this.mats);
    this.group.add(sec.mesh);
  }

  // 峡谷里车能左右开到哪里（赛道坐标 a 的范围）；不受限制时返回 null
  steerRange(s, a) {
    // 分岔里中间的缝过不去：车在哪一半就只能在哪一半
    if (this.path.splitAt(s)) return wrapLane(a) < 5 ? [0.3, 4.7] : [5.3, 9.7];
    const sec = this.sections[0];
    if (!sec || !sec.canyon || s > sec.s1 || s < sec.s0) return null;
    let lo = 5, hi = 5;
    while (lo > 0 && this.laneAt(s, lo - 1)) lo--;
    while (hi < LANES - 1 && this.laneAt(s, hi + 1)) hi++;
    if (lo === 0 && hi === LANES - 1) return null;
    return [lo + 0.3, hi + 1 - 0.3];
  }

  // 障碍做成一排竖起的冰刺（碰撞范围不变：整条赛道宽、高 WALL_H）
  // 石头主题：障碍是一排岩石块，贴图和障碍道路面一样（同一种颜色的石头），大小不一、挤在一起挡住整条道
  addRocks(sec, path, a0, a1, os) {
    if (!ROCK_GEO) ROCK_GEO = rockLump();
    const W = trackRadius() * laneAng() * (a1 - a0);
    const n = Math.max(3, Math.round(W / 1.3));
    const p = new THREE.Vector3(), up = new THREE.Vector3(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < n; k++) {
      const a = a0 + 0.08 + (k + 0.5) * (a1 - a0 - 0.16) / n + (vnoise(k * 2.3, os * 0.2) - 0.5) * 0.04;
      const s = os + (vnoise(k * 1.7, os * 0.1) - 0.5) * 0.6;
      path.point(s, a, -0.25, p);
      up.copy(path.r).negate();
      const m = new THREE.Mesh(ROCK_GEO, this.mats[TYPE.OBSTACLE]);
      m.position.copy(p);
      q.setFromAxisAngle(Y, vnoise(k * 4.1, os) * 6.28);
      m.quaternion.setFromUnitVectors(Y, up).multiply(q);
      const hgt = WALL_H * (0.62 + 0.3 * vnoise(k * 3.1, os * 0.3)) + 0.25;   // 露出路面 1.0～1.5 米
      const wid = 0.75 + 0.35 * vnoise(k, 2);
      m.scale.set(wid, hgt / 1.7, wid * (0.8 + 0.4 * vnoise(2, k)));
      this.group.add(m);
      sec.extras.push(m);
    }
  }

  addSpikes(sec, path, a0, a1, os) {
    if (!SPIKE_GEO) SPIKE_GEO = new THREE.ConeGeometry(0.42, 1, 7, 1).translate(0, 0.5, 0);
    const n = Math.max(6, Math.round(trackRadius() * laneAng() * (a1 - a0) / 0.95)); // 冰刺排满整条赛道宽度
    const p = new THREE.Vector3(), up = new THREE.Vector3(), q = new THREE.Quaternion();
    for (let k = 0; k < n; k++) {
      const a = a0 + 0.06 + (k + 0.5) * (a1 - a0 - 0.12) / n;
      const s = os + (vnoise(k * 1.7, os * 0.1) - 0.5) * 0.8;
      path.point(s, a, -0.1, p);
      up.copy(path.r).negate();
      // 略微随机倾斜，像自然长出来的冰晶
      const tilt = new THREE.Vector3((vnoise(k, os) - 0.5) * 0.5, 1, (vnoise(os, k) - 0.5) * 0.5).normalize();
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tilt);
      const m = new THREE.Mesh(SPIKE_GEO, this.mats[SLOT_WALL]);
      m.position.copy(p);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up).multiply(q);
      const hgt = WALL_H * (0.62 + 0.3 * vnoise(k * 3.1, os * 0.3)); // 1.0～1.5 米：比碰撞高度（WALL_H）矮，跳过去看起来就是真的越过了
      m.scale.set(0.8 + 0.5 * vnoise(k, 2), hgt, 0.8 + 0.5 * vnoise(2, k));
      this.group.add(m);
      sec.extras.push(m);
    }
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
    if (TRACK_STYLE.outside) {
      // 外表面模式：终点是套在巨石外面的一圈拱门
      const RR = TRACK_STYLE.radius;
      mk(RR + 9, 0.5, '#ffffff');
      mk(RR + 7.5, 0.3, '#ff3cf0');
      this.gate = mk(RR + 10.5, 0.2, '#00fff0');
      return;
    }
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
    if (!L || L.gone || s < L.s0 || s > L.s1) return null;
    if (L.holes) for (const [a, b] of L.holes) if (s > a && s < b) return null;
    return L;
  }

  laneRaw(s, i) {
    const sec = this.sectionAt(s);
    return sec ? sec.lanes[i] : null;
  }

  update(carS, time, dt) {
    while (!this.done && this.genS < carS + 1500) this.generate();
    this.runJobs(carS);
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
    sec.disposed = true;
    for (const m of sec.parts || []) { this.group.remove(m); m.geometry.dispose(); }
    if (sec.mesh) {
      this.group.remove(sec.mesh);
      sec.mesh.geometry.dispose();
    }
    for (const L of sec.lanes) {
      if (L && L.mesh) {
        this.group.remove(L.mesh);
        L.mesh.geometry.dispose();
      }
    }
    for (const e of sec.extras) { this.group.remove(e); if (e.geometry !== SPIKE_GEO && e.geometry !== ROCK_GEO) e.geometry.dispose(); }
  }

  dispose() {
    for (const sec of this.sections) this.disposeSection(sec);
    this.sections = [];
    this.scene.remove(this.group);
  }
}
