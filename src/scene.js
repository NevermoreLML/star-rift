import * as THREE from './lib.js';

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
    size, sizeAttenuation: false, vertexColors: true, map: starTexture(),
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
  g.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), mat));
  if (ring) {
    const rg = new THREE.RingGeometry(radius * 1.4, radius * 2.2, 96, 1);
    const rm = new THREE.MeshBasicMaterial({ color: new THREE.Color(colB).multiplyScalar(0.6), side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false });
    const r = new THREE.Mesh(rg, rm);
    r.rotation.x = Math.PI * 0.42;
    r.rotation.y = 0.3;
    g.add(r);
  }
  return g;
}

export function createBackground(scene) {
  const group = new THREE.Group();
  const nebula = makeNebula();
  group.add(nebula);
  group.add(makeStars(5000, 2300, 1.6, 1.0));
  group.add(makeStars(600, 2200, 3.2, 1.6));
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
    group,
    update(camPos, time) {
      group.position.copy(camPos);
      nebula.material.uniforms.uTime.value = time;
    },
  };
}

// ---------------------------------------------------------------------------
// 赛车：几何体拼成的霓虹悬浮车，车头朝 +Z，车顶朝 +Y
// ---------------------------------------------------------------------------
export function createCar() {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const hullMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ff, metalness: 0.75, roughness: 0.25 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1f33, metalness: 0.6, roughness: 0.4 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0a2a40, emissive: 0x18c8ff, emissiveIntensity: 0.9, metalness: 0.9, roughness: 0.1 });
  const neonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3cf0).multiplyScalar(2.4) });
  const engineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x66e8ff).multiplyScalar(3) });

  // 主体：前端收窄的楔形
  const hullG = new THREE.BoxGeometry(1.5, 0.42, 3.2, 1, 1, 4);
  const pa = hullG.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const z = pa.getZ(i);
    const t = (z + 1.6) / 3.2; // 0 车尾 → 1 车头
    pa.setX(i, pa.getX(i) * (1 - 0.55 * t * t));
    if (pa.getY(i) > 0) pa.setY(i, pa.getY(i) * (1 - 0.75 * t));
  }
  hullG.computeVertexNormals();
  const hull = new THREE.Mesh(hullG, hullMat);
  hull.position.y = 0.45;
  body.add(hull);

  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 12), glassMat);
  cockpit.scale.set(0.9, 0.55, 1.6);
  cockpit.position.set(0, 0.72, -0.15);
  body.add(cockpit);

  // 侧舱 + 引擎
  const nozzles = [];
  for (const sx of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 1.9, 16), darkMat);
    pod.rotation.x = Math.PI / 2;
    pod.position.set(sx * 0.82, 0.42, -0.55);
    body.add(pod);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.05, 8, 24), neonMat);
    ring.position.set(sx * 0.82, 0.42, -1.5);
    body.add(ring);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), engineMat);
    glow.position.set(sx * 0.82, 0.42, -1.52);
    glow.rotation.y = Math.PI;
    body.add(glow);
    nozzles.push(new THREE.Vector3(sx * 0.82, 0.42, -1.6));
    // 霓虹侧条
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 2.2), neonMat);
    stripe.position.set(sx * 0.62, 0.5, 0.15);
    stripe.rotation.y = -sx * 0.12;
    body.add(stripe);
  }

  // 尾翼
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.06, 0.45), darkMat);
  wing.position.set(0, 0.95, -1.35);
  body.add(wing);
  for (const sx of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.4, 0.4), hullMat);
    fin.position.set(sx * 0.4, 0.75, -1.35);
    body.add(fin);
  }
  const wingNeon = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.03, 0.04), neonMat);
  wingNeon.position.set(0, 0.99, -1.57);
  body.add(wingNeon);

  // 底部悬浮光
  const under = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 3.2),
    new THREE.MeshBasicMaterial({ color: 0x18c8ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  under.rotation.x = -Math.PI / 2;
  under.position.y = 0.06;
  body.add(under);

  const headlight = new THREE.PointLight(0x66e8ff, 6, 20, 2);
  headlight.position.set(0, 1.2, 2.5);
  group.add(headlight);

  group.scale.setScalar(1.25);
  return { group, body, nozzles, engineMat, under };
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

  push(p, up, width, intensity) {
    this.pts.unshift({ p: p.clone(), u: up.clone() });
    if (this.pts.length > this.n) this.pts.pop();
    for (let i = 0; i < this.n; i++) {
      const q = this.pts[Math.min(i, this.pts.length - 1)];
      if (!q) continue;
      const k = 1 - i / (this.n - 1);
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
      size: 0.5, vertexColors: true, map: starTexture(), transparent: true,
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
// 速度线：挂在相机上，随速度拉长
// ---------------------------------------------------------------------------
export class SpeedLines {
  constructor(camera, count = 160) {
    this.count = count;
    this.items = [];
    for (let i = 0; i < count; i++) this.items.push(this.spawn({}, true));
    this.arr = new Float32Array(count * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.arr, 3));
    this.mat = new THREE.LineBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.lines = new THREE.LineSegments(g, this.mat);
    this.lines.frustumCulled = false;
    camera.add(this.lines);
  }

  spawn(o, init) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 2.5 + Math.random() * 9;
    o.x = Math.cos(ang) * rad;
    o.y = Math.sin(ang) * rad;
    o.z = init ? -Math.random() * 90 : -90;
    return o;
  }

  update(dt, speed, norm) {
    const len = 0.5 + speed * 0.06;
    for (let i = 0; i < this.count; i++) {
      const o = this.items[i];
      o.z += speed * 1.6 * dt;
      if (o.z > 2) this.spawn(o, false);
      this.arr.set([o.x, o.y, o.z, o.x, o.y, o.z - len], i * 6);
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.mat.opacity = Math.max(0, norm - 0.35) * 0.9;
  }
}
