import * as THREE from './lib.js';
import { each, loadTexture, loadModel } from './assets.js';
import { buildSleekCar } from './carModel.js';

// ---------------------------------------------------------------------------
// 宇宙背景：星云天球 + 两层星空 + 远处行星。整体跟随相机移动，永远到不了。
// ---------------------------------------------------------------------------
const NOISE_GLSL = `
float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5; } return v; }
`;

function makeNebula() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `${NOISE_GLSL}
      varying vec3 vDir; uniform float uTime;
      void main(){
        vec3 d = normalize(vDir);
        float n = fbm(d*2.2 + vec3(0.0, 0.0, uTime*0.004));
        float m = fbm(d*4.5 + vec3(5.2, 1.3, 2.7));
        float band = exp(-pow(d.y*2.2 + 0.4*sin(d.x*3.0), 2.0));
        vec3 base = vec3(0.008, 0.01, 0.03);
        vec3 purple = vec3(0.11, 0.025, 0.17);
        vec3 teal = vec3(0.01, 0.08, 0.13);
        vec3 pink = vec3(0.22, 0.04, 0.13);
        vec3 col = base;
        col += purple * smoothstep(0.35, 0.85, n) * (0.4 + band);
        col += teal * smoothstep(0.45, 0.9, m) * 0.8;
        col += pink * pow(smoothstep(0.55, 0.95, n*m*1.6), 2.0) * band;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(2600, 48, 24), mat);
}

function starTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
// 星空和粒子共用这一张（美术素材 star_particle 替换的就是它）
export const STAR_TEX = starTexture();

function makeStars(count, radius, size, bright) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.85 + Math.random() * 0.15);
    pos.set([Math.cos(th) * s * r, u * r, Math.sin(th) * s * r], i * 3);
    c.setHSL(0.55 + Math.random() * 0.2 - (Math.random() < 0.2 ? 0.5 : 0), 0.5, 0.65 + Math.random() * 0.35);
    c.multiplyScalar(bright * (0.5 + Math.random() * 0.8));
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    size, sizeAttenuation: false, vertexColors: true, map: STAR_TEX,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(g, m);
}

function makePlanet(radius, colA, colB, ring) {
  const g = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    uniforms: { cA: { value: new THREE.Color(colA) }, cB: { value: new THREE.Color(colB) }, sun: { value: new THREE.Vector3(0.6, 0.5, -0.6).normalize() } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vV;
      void main(){ vN = normalize(normalMatrix*normal); vP = position; vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `${NOISE_GLSL}
      uniform vec3 cA; uniform vec3 cB; uniform vec3 sun; varying vec3 vN; varying vec3 vP; varying vec3 vV;
      void main(){
        vec3 p = normalize(vP);
        float bands = fbm(vec3(p.y*6.0, p.x*1.5, p.z*1.5)) ;
        vec3 col = mix(cA, cB, smoothstep(0.3, 0.75, bands));
        vec3 ns = normalize((viewMatrix*vec4(sun,0.0)).xyz);
        float l = clamp(dot(vN, ns)*0.9+0.15, 0.03, 1.0);
        float rim = pow(1.0 - max(dot(vN, vV), 0.0), 3.0);
        gl_FragColor = vec4(col*l + cB*rim*1.2, 1.0);
      }`,
  });
  g.userData.sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), mat);
  g.add(g.userData.sphere);
  if (ring) {
    const rg = new THREE.RingGeometry(radius * 1.4, radius * 2.2, 96, 1);
    const rm = new THREE.MeshBasicMaterial({ color: new THREE.Color(colB).multiplyScalar(0.6), side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false });
    const r = new THREE.Mesh(rg, rm);
    r.rotation.x = Math.PI * 0.42;
    r.rotation.y = 0.3;
    g.add(r);
    g.userData.ring = r;
  }
  return g;
}

export function createBackground(scene) {
  const group = new THREE.Group();
  const nebula = makeNebula();
  group.add(nebula);
  const stars = [makeStars(5000, 2300, 1.6, 1.0), makeStars(600, 2200, 3.2, 1.6)];
  for (const st of stars) group.add(st);
  const p1 = makePlanet(260, '#1a2a6a', '#5ad1ff', true);
  p1.position.set(-900, 350, 1500);
  group.add(p1);
  const p2 = makePlanet(120, '#4a1030', '#ff6a9a', false);
  p2.position.set(1300, -200, -900);
  group.add(p2);
  const p3 = makePlanet(60, '#2a2010', '#ffb44a', false);
  p3.position.set(400, 900, 600);
  group.add(p3);
  group.renderOrder = -1;
  for (const o of group.children) o.renderOrder = -1;
  scene.add(group);
  return {
    group, nebula, stars, planets: [p1, p2, p3],
    update(camPos, time) {
      group.position.copy(camPos);
      nebula.material.uniforms.uTime.value = time;
    },
  };
}

// 美术素材替换：全景天空、行星表面、行星环
export async function applyBackgroundArt(bg, art, scene) {
  await each([['sky', art.sky]], async (key, file) => {
    const tex = await loadTexture(file);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = tex;
    bg.nebula.visible = false;
  });
  if (art.hideProceduralStars) for (const st of bg.stars) st.visible = false;
  const p = art.planets || {};
  await each([['planet_1', p.planet_1], ['planet_2', p.planet_2], ['planet_3', p.planet_3]], async (key, file) => {
    const tex = await loadTexture(file);
    const planet = bg.planets[Number(key.slice(-1)) - 1];
    // 受太阳光照，暗面带一点自发光，不会全黑
    planet.userData.sphere.material = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.06, roughness: 1, metalness: 0,
    });
  });
  await each([['planet_1_ring', p.planet_1_ring]], async (key, file) => {
    const m = bg.planets[0].userData.ring.material;
    m.map = await loadTexture(file);
    m.color.set(0xffffff);
    m.opacity = 1;
    m.needsUpdate = true;
  });
}

// 把模型里某个轮心附近的零件（轮胎、轮毂、胎侧文字）收进一个转轴组，之后转这个组就是转轮子
function gatherWheel(root, center, pick) {
  const pivot = new THREE.Group();
  pivot.position.copy(center);
  root.add(pivot);
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const box = new THREE.Box3(), c = new THREE.Vector3(), s = new THREE.Vector3();
  for (const m of meshes) {
    box.setFromObject(m);
    if (box.getCenter(c).distanceTo(center) < pick && Math.max(...box.getSize(s).toArray()) < pick * 4) pivot.attach(m);
  }
  return pivot;
}

// 美术素材替换：赛车模型（.glb）。
// 可选：wheelCenters（模型坐标里的轮心）让轮子随车速转；groundY 指定模型里地面高度；
// trails（模型坐标里的拖尾起点，空数组表示不要拖尾）；模型里名为 nozzle_L / nozzle_R 的空节点也可作为拖尾起点
export async function applyCarArt(car, art) {
  // car：平时的车；car2：变身后的超跑（可选）。两台都挂在 car.body 下面，用 car.setForm(0 / 1) 切换
  car.forms = [];
  for (const key of ['car', 'car2']) {
    const c = art[key] || {};
    if (!c.model) continue;
    let loaded;
    try { loaded = await loadModel(c.model); } catch (e) { console.warn('car model failed', key, e); continue; }
    // hide：模型里不要的零件（按名字的开头匹配），比如原作者留在车外面的散件
    if (Array.isArray(c.hide)) loaded.traverse((o) => { if (c.hide.some((h) => o.name.startsWith(h))) o.visible = false; });
    const wheels = (c.wheelCenters || []).map((p) => gatherWheel(loaded, new THREE.Vector3(...p), c.wheelPick || 0.3));
    // 包一层，方便旋转、缩放、对齐，不改模型自己的变换
    const model = new THREE.Group();
    model.add(loaded);
    if (c.rotateY) loaded.rotation.y = THREE.MathUtils.degToRad(c.rotateY);
    let k = c.scale || 1;
    let box = null;
    if (c.length) {
      // 指定了车长：按包围盒自动缩放，并把车底中心放到原点
      box = new THREE.Box3().setFromObject(loaded, !!c.preciseBox); // preciseBox：按顶点算，模型里有旋转过的零件时更准
      const size = box.getSize(new THREE.Vector3());
      k *= c.length / size.z;
      const ground = c.groundY ?? box.min.y;
      loaded.position.set(-(box.min.x + box.max.x) / 2, -ground, -(box.min.z + box.max.z) / 2);
    }
    // 模型按游戏单位（≈米）制作；外层赛车组整体放大了 1.25 倍，这里抵消掉
    model.scale.setScalar(k / car.group.scale.x);
    // 收集材质（变身时让整台车发光用），加上环境反射
    const mats = [];
    loaded.traverse((o) => {
      if (!o.isMesh) return;
      o.material = [].concat(o.material).map((m) => m.clone()).reduce((a, m, i, arr) => (arr.length === 1 ? m : arr), null);
      for (const m of [].concat(o.material)) {
        if (!m) continue;
        if (car.envMap && 'envMap' in m) { m.envMap = car.envMap; m.envMapIntensity = c.envIntensity ?? 0.8; m.needsUpdate = true; }
        if ('emissive' in m) mats.push({ m, e: m.emissive.clone(), ei: m.emissiveIntensity });
      }
    });
    car.body.add(model);
    car.group.updateMatrixWorld(true);
    const toCar = (v) => car.group.worldToLocal(v);
    const nozzles = [];
    if (Array.isArray(c.trails)) for (const p of c.trails) nozzles.push(toCar(loaded.localToWorld(new THREE.Vector3(...p))));
    ['nozzle_L', 'nozzle_R'].forEach((name, i) => {
      const node = model.getObjectByName(name);
      if (node) nozzles[i] = toCar(node.getWorldPosition(new THREE.Vector3()));
    });
    car.forms.push({
      model, mats, wheels, nozzles,
      wheelRadius: (c.wheelRadius || 0.33) * k,
      wheelDir: Math.cos(THREE.MathUtils.degToRad(c.rotateY || 0)) >= 0 ? 1 : -1,
      trailColor: c.trailColor, trailWidth: c.trailWidth, trailIntensity: c.trailIntensity, trailLength: c.trailLength,
    });
  }
  if (!car.forms.length) return;
  for (const ch of car.body.children) if (!car.forms.some((f) => f.model === ch)) ch.visible = false;
  // 切换车身：轮子、拖尾起点、拖尾样式跟着换
  car.setForm = (i) => {
    const f = car.forms[Math.min(i, car.forms.length - 1)];
    car.forms.forEach((g) => { g.model.visible = g === f; });
    car.form = car.forms.indexOf(f);
    car.wheels = f.wheels;
    car.wheelRadius = f.wheelRadius;
    car.wheelDir = f.wheelDir;
    car.nozzles.length = 0;
    car.nozzles.push(...f.nozzles);
    if (f.trailColor) car.trailColor = f.trailColor;
    if (f.trailWidth !== undefined) car.trailWidth = f.trailWidth;
    if (f.trailIntensity !== undefined) car.trailIntensity = f.trailIntensity;
    if (f.trailLength !== undefined) car.trailLength = f.trailLength;
  };
  // 让某一台车整体发光（0 = 正常，1 = 被流光完全覆盖成一团亮光）
  car.setGlow = (i, k, color) => {
    const f = car.forms[i];
    if (!f) return;
    for (const { m, e, ei } of f.mats) {
      m.emissive.copy(e).lerp(color, k);
      m.emissiveIntensity = ei + (2.5 - ei) * k;
    }
  };
  car.setForm(0);
}

// ---------------------------------------------------------------------------
// 赛车：原创流线型悬浮赛车（造型在 carModel.js），车头朝 +Z，车顶朝 +Y
// envMap：金属车身反射用的环境贴图
// ---------------------------------------------------------------------------
export function createCar(envMap) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // 造型按米制作；外层整体放大了 1.25 倍，这里抵消掉
  const S = 1.25;
  const sleek = buildSleekCar(envMap);
  sleek.car.scale.setScalar(1 / S);
  // 游戏里有辉光，环境反射调弱一些，避免车身泛白
  sleek.car.traverse((o) => { if (o.material && o.material.envMapIntensity !== undefined) o.material.envMapIntensity *= 0.45; });
  body.add(sleek.car);
  const nozzles = sleek.nozzles.map((p) => p.clone().divideScalar(S));
  const engineMat = sleek.engineMat;

  // 车灯放在车头前方，照亮前面的赛道，不直接打在车身上
  const headlight = new THREE.PointLight(0x66e8ff, 4, 20, 2);
  headlight.position.set(0, 0.8, 5);
  group.add(headlight);

  group.scale.setScalar(1.25);
  return { group, body, nozzles, engineMat, envMap, wheels: [], wheelRadius: 0.33, wheelDir: 1 };
}

// ---------------------------------------------------------------------------
// 尾焰拖尾：记录喷口的世界坐标，生成渐隐的飘带
// ---------------------------------------------------------------------------
export class Trail {
  constructor(scene, color, n = 12) {
    this.n = n;
    this.pts = [];
    this.color = new THREE.Color(color);
    const g = new THREE.BufferGeometry();
    this.posArr = new Float32Array(n * 2 * 3);
    this.colArr = new Float32Array(n * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.colArr, 3));
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  reset() { this.pts = []; }

  // maxLen：拖尾最长多少米（按实际走过的距离算，和帧率、车速无关）
  push(p, up, width, intensity, maxLen = Infinity) {
    this.pts.unshift({ p: p.clone(), u: up.clone() });
    if (this.pts.length > this.n) this.pts.pop();
    let dist = 0;
    for (let i = 0; i < this.n; i++) {
      let q = this.pts[Math.min(i, this.pts.length - 1)];
      if (!q) continue;
      if (i > 0 && i < this.pts.length) dist += q.p.distanceTo(this.pts[i - 1].p);
      // 超过最大长度的点都收到长度末端，并且完全透明
      if (dist > maxLen) q = this.pts[Math.min(Math.max(0, i - 1), this.pts.length - 1)];
      // 车速为 0 时 maxLen 为 0，0/0 会产生 NaN，直接当作完全透明
      const k = maxLen > 0 ? Math.min(1 - i / (this.n - 1), Math.max(0, 1 - dist / maxLen)) : 0;
      const w = width * (0.3 + 0.7 * k);
      this.posArr.set([q.p.x + q.u.x * w, q.p.y + q.u.y * w, q.p.z + q.u.z * w], i * 6);
      this.posArr.set([q.p.x - q.u.x * w, q.p.y - q.u.y * w, q.p.z - q.u.z * w], i * 6 + 3);
      const c = k * k * intensity;
      this.colArr.set([this.color.r * c, this.color.g * c, this.color.b * c, this.color.r * c, this.color.g * c, this.color.b * c], i * 6);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// 粒子：火花 / 爆炸 / 落地尘
// ---------------------------------------------------------------------------
export class Particles {
  constructor(scene, max = 900) {
    this.max = max;
    this.p = [];
    for (let i = 0; i < max; i++) this.p.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, max: 1, col: new THREE.Color() });
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    this.posArr = new Float32Array(max * 3);
    this.colArr = new Float32Array(max * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.colArr, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.5, vertexColors: true, map: STAR_TEX, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(pos, baseVel, spread, color, life, count) {
    for (let k = 0; k < count; k++) {
      const q = this.p[this.cursor];
      this.cursor = (this.cursor + 1) % this.max;
      q.pos.copy(pos);
      q.vel.copy(baseVel).add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).multiplyScalar(spread));
      q.life = q.max = life * (0.5 + Math.random() * 0.8);
      q.col.set(color);
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      const q = this.p[i];
      if (q.life > 0) {
        q.life -= dt;
        q.pos.addScaledVector(q.vel, dt);
        q.vel.multiplyScalar(1 - dt * 1.5);
      }
      const k = Math.max(0, q.life / q.max) * 2;
      this.posArr[i * 3] = q.pos.x; this.posArr[i * 3 + 1] = q.pos.y; this.posArr[i * 3 + 2] = q.pos.z;
      this.colArr[i * 3] = q.col.r * k; this.colArr[i * 3 + 1] = q.col.g * k; this.colArr[i * 3 + 2] = q.col.b * k;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// 速度线：放在管道里的发光细线，沿管道中轴方向排布，所以会跟着管道的弧度弯；
// 车开过去时从远处涌来、从身边掠过。远处（隧道中心）和赛车所在的赛道上方不出线，
// 保证玩家看前方落点的视线干净。
// ---------------------------------------------------------------------------
const SPEEDLINE_BASE = new THREE.Color(0x9fdcff);
const SPEEDLINE_BOOST = new THREE.Color(0x4dfff4);
const SL_AHEAD_MIN = 45, SL_AHEAD_MAX = 95; // 新线生成在前方这个距离范围
const SL_FADE_FAR = 55, SL_FADE_NEAR = 25;   // 比 FADE_FAR 远的看不见，近到 FADE_NEAR 才完全显示
const SL_CLEAR_LANES = 1.3;                  // 赛车左右各这么多条赛道上方不出线

export class SpeedLines {
  constructor(scene, count = 240) {
    this.count = count;
    this.items = Array.from({ length: count }, () => ({ s: 0, a: 0, h: 0 }));
    this.path = null;
    this.pos = new Float32Array(count * 4 * 3);
    this.col = new Float32Array(count * 4 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    scene.add(this.lines);
    this.color = new THREE.Color();
    this.p = new THREE.Vector3();
  }

  spawn(o, carS, carA, init) {
    o.s = carS + (init ? -10 + Math.random() * (SL_AHEAD_MAX + 10) : SL_AHEAD_MIN + Math.random() * (SL_AHEAD_MAX - SL_AHEAD_MIN));
    // 避开赛车所在赛道的正上方（那里是玩家要看清的跑道）
    const off = SL_CLEAR_LANES + Math.random() * (10 - 2 * SL_CLEAR_LANES);
    o.a = carA + off;
    o.h = 0.6 + Math.random() * 4.6;
  }

  // path/carS/carA：当前管道和赛车位置；norm：速度/极速；boost 0..1：加速时更长、更亮、偏青
  update(dt, path, carS, carA, speed, norm, boost = 0) {
    if (path !== this.path) {
      this.path = path;
      for (const o of this.items) this.spawn(o, carS, carA, true);
    }
    const len = (0.6 + speed * 0.07) * (1 + 1.4 * boost);
    const bright = Math.min(0.85, Math.max(0, norm - 0.35) * 1.1 + boost * 0.2);
    this.color.copy(SPEEDLINE_BASE).lerp(SPEEDLINE_BOOST, boost);
    const c = this.color, p = this.p, pos = this.pos, col = this.col;
    for (let i = 0; i < this.count; i++) {
      const o = this.items[i];
      o.s -= speed * 0.6 * dt; // 自身也往后飘，掠过感更强
      if (o.s < carS - 12) this.spawn(o, carS, carA, false);
      const d = o.s - carS;
      const fade = bright
        * THREE.MathUtils.smoothstep(SL_FADE_FAR - d, 0, SL_FADE_FAR - SL_FADE_NEAR)
        * THREE.MathUtils.smoothstep(d, -12, -6);
      // 头 → 中 → 尾 两段，沿管道取点，所以线条跟着管道弧度弯
      const sh = [o.s, o.s - len * 0.5, o.s - len];
      const k = [1, 0.55, 0];
      const base = i * 12;
      for (let j = 0; j < 4; j++) {
        const idx = j === 0 ? 0 : j === 3 ? 2 : 1;
        path.point(sh[idx], o.a, o.h, p);
        pos[base + j * 3] = p.x; pos[base + j * 3 + 1] = p.y; pos[base + j * 3 + 2] = p.z;
        const b = fade * k[idx];
        col[base + j * 3] = c.r * b; col[base + j * 3 + 1] = c.g * b; col[base + j * 3 + 2] = c.b * b;
      }
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}
