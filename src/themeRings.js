// “J1407b 光环”主题：赛道换成光环里被削平的陨石，没有霓虹灯，只靠恒星光照；
// 背景是系外行星 J1407b 和它比土星环大约 200 倍的环系统（按观测数据还原：多层环、中间有空隙），
// 一颗年轻的橙色恒星（J1407 是 K 型星）从侧面照过来，管道周围漂浮着大大小小的陨石。
// 在网址后加 ?theme=rings 启用。
import * as THREE from './lib.js';
import { TRACK_STYLE } from './track.js';
import { ASSET_BASE } from './assets.js';

const DIR = ASSET_BASE + 'themes/rings/';
// 恒星方向（与 main.js 里的平行光一致）
const STAR_DIR = new THREE.Vector3(600, 500, -600).normalize();

export const isRingsTheme = () => new URLSearchParams(location.search).get('theme') === 'rings';

function texture(loader, name, srgb = true) {
  const t = loader.load(DIR + name);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 行星：年轻气态巨行星，暗红、铁锈、深褐色的条纹，被恒星照亮一侧
function makePlanet(radius) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { sun: { value: STAR_DIR.clone() } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vW;
      void main(){ vP = normalize(position); vN = normalize(mat3(modelMatrix) * normal); vW = (modelMatrix*vec4(position,1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
    fragmentShader: `
      uniform vec3 sun; varying vec3 vN; varying vec3 vP; varying vec3 vW;
      float h(float n){ return fract(sin(n)*43758.5453); }
      float n1(float x){ float i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); return mix(h(i),h(i+1.0),f); }
      void main(){
        float lat = vP.y;
        float swirl = n1(vP.x*6.0 + vP.z*4.0 + lat*20.0) * 0.08;
        float b = n1((lat + swirl) * 14.0) * 0.6 + n1((lat + swirl) * 37.0) * 0.4;
        vec3 c1 = vec3(0.42, 0.17, 0.09), c2 = vec3(0.64, 0.33, 0.16), c3 = vec3(0.22, 0.09, 0.06);
        vec3 col = mix(mix(c3, c1, smoothstep(0.2, 0.55, b)), c2, smoothstep(0.55, 0.85, b));
        float l = clamp(dot(normalize(vN), sun), 0.0, 1.0);
        vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - max(dot(normalize(vN), V), 0.0), 3.0);
        gl_FragColor = vec4(col * (0.06 + 1.15 * l) + vec3(0.5, 0.25, 0.12) * rim * l * 0.6, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), mat);
}

// 光环：径向分成许多层，几道明显的空隙（可能是正在形成的卫星扫出来的），冰、尘、岩石三种颜色交替
function makeRings(inner, outer) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { inner: { value: inner }, outer: { value: outer }, sun: { value: STAR_DIR.clone() } },
    vertexShader: `varying vec3 vP; varying vec3 vN;
      void main(){ vP = position; vN = normalize(mat3(modelMatrix) * vec3(0.0,0.0,1.0)); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float inner; uniform float outer; uniform vec3 sun; varying vec3 vP; varying vec3 vN;
      float h(float n){ return fract(sin(n)*43758.5453); }
      float n1(float x){ float i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); return mix(h(i),h(i+1.0),f); }
      float gap(float t, float c, float w){ return smoothstep(0.0, w, abs(t - c)); }
      void main(){
        float t = (length(vP.xy) - inner) / (outer - inner);
        if (t < 0.0 || t > 1.0) discard;
        float d = 0.55 * n1(t * 60.0) + 0.3 * n1(t * 230.0) + 0.15 * n1(t * 900.0);
        d *= gap(t, 0.23, 0.012) * gap(t, 0.47, 0.02) * gap(t, 0.61, 0.008) * gap(t, 0.78, 0.03);
        d *= smoothstep(0.0, 0.04, t) * smoothstep(1.0, 0.86, t);
        float k = n1(t * 18.0 + 3.0);
        vec3 ice = vec3(0.78, 0.82, 0.86), dust = vec3(0.70, 0.56, 0.42), rock = vec3(0.42, 0.36, 0.32);
        vec3 col = mix(mix(rock, dust, smoothstep(0.2, 0.6, k)), ice, smoothstep(0.6, 0.9, k));
        float lit = 0.55 + 0.45 * abs(dot(normalize(vN), sun));
        gl_FragColor = vec4(col * lit, d * 0.92);
      }`,
  });
  return new THREE.Mesh(new THREE.RingGeometry(inner, outer, 512, 1), mat);
}

// 恒星：橙白色的圆盘 + 柔和光晕
function makeStar() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,250,235,1)');
  g.addColorStop(0.12, 'rgba(255,236,200,1)');
  g.addColorStop(0.2, 'rgba(255,190,120,0.55)');
  g.addColorStop(0.5, 'rgba(255,140,60,0.12)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(420);
  return s;
}

// 三向投影贴图：用世界坐标采样，大小不同的石头纹理密度一致；再叠一层大尺度的明暗变化
function triplanar(m, scale) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.triScale = { value: scale };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm; uniform float triScale;')
      .replace('#include <map_fragment>', `
        vec3 bw = pow(abs(normalize(vWNrm)), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
        vec4 t1 = texture2D(map, vWPos.zy * triScale) * bw.x + texture2D(map, vWPos.xz * triScale) * bw.y + texture2D(map, vWPos.xy * triScale) * bw.z;
        float k = 0.13;
        vec4 t2 = texture2D(map, vWPos.zy * triScale * k) * bw.x + texture2D(map, vWPos.xz * triScale * k) * bw.y + texture2D(map, vWPos.xy * triScale * k) * bw.z;
        diffuseColor *= t1 * (0.55 + 0.6 * t2);`);
  };
  m.customProgramCacheKey = () => 'triplanar';
  return m;
}

// 一块不规则的陨石（所有漂浮陨石共用，靠缩放和旋转做出变化）
function rockGeometry() {
  // 用有索引的球体，法线能平滑过渡（二十面体是不共享顶点的，算出来是一块块的平面）
  const g = new THREE.SphereGeometry(1, 48, 32);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + 0.28 * Math.sin(v.x * 3.1 + v.y * 1.7) * Math.cos(v.z * 2.3 - v.x) + 0.12 * Math.sin(v.y * 7.3 + v.z * 5.1);
    v.multiplyScalar(k);
    v.y *= 0.75;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function setupRingsTheme({ scene, mats, bg, bloom }) {
  // 赛道：陨石平台，无发光条，障碍是冰刺
  // 玩法和管道完全不变，只是平台换成石头：每条道一块石板，没有发光条，障碍是冰刺
  TRACK_STYLE.slab = 1.4;     // 石板厚度（米），和原来的平台差不多大
  TRACK_STYLE.continuous = true; // 管道连贯：平时没有整圈断口，难点来自扣掉的部分；断崖阶段偶尔有整圈断口
  TRACK_STYLE.edges = false;
  TRACK_STYLE.spikes = true;
  TRACK_STYLE.lines = false;
  TRACK_STYLE.outside = false;

  const loader = new THREE.TextureLoader();
  const lanes = ['lane_0_normal', 'lane_1_boost', 'lane_2_slow', 'lane_3_obstacle', 'lane_4_short', 'lane_5_crumble', 'lane_6_bounce'];
  lanes.forEach((n, i) => {
    mats[i] = new THREE.MeshStandardMaterial({
      map: texture(loader, n + '.jpg'), normalMap: texture(loader, n + '_n.jpg', false),
      roughness: i === 1 ? 0.3 : i === 6 ? 0.6 : 0.92, metalness: i === 1 ? 0.15 : 0.03, side: THREE.DoubleSide,
    });
  });
  // 陨石本体和普通跑道是同一种岩石，按世界坐标三向投影贴图，巨石上不会拉伸；跑道只是这块岩石表面的一部分
  const side = triplanar(new THREE.MeshStandardMaterial({
    map: texture(loader, 'lane_0_normal.jpg'), color: 0xc9c2b6, roughness: 0.95, metalness: 0.02, side: THREE.DoubleSide,
  }), 1 / 14);
  mats[7] = side;
  // 赛道边线：浅砂岩色，不发光，只是比岩石亮一些，看得出每条道的边界
  const line = new THREE.MeshStandardMaterial({ color: 0xa79d8a, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  for (let i = 8; i <= 14; i++) mats[i] = line;
  mats[15] = new THREE.MeshStandardMaterial({
    map: texture(loader, 'wall.jpg'), normalMap: texture(loader, 'wall_n.jpg', false), color: 0xdcf0ff,
    roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.93,
  });
  if (mats[16].emissiveIntensity !== undefined) mats[16].emissiveIntensity = 0.08;

  // 光照：只靠恒星，环境光很弱，暗面接近黑
  scene.traverse((o) => {
    // 背光面也要看得清路：环境光和天光给足，恒星负责明暗和立体感
    if (o.isAmbientLight) { o.intensity = TRACK_STYLE.outside ? 1.5 : 1.05; o.color.set(0x8a8f9c); }
    if (o.isHemisphereLight) { o.intensity = 0.95; o.color.set(0xc9d2e6); o.groundColor.set(TRACK_STYLE.outside ? 0x8a8478 : 0x3a3028); }
    if (o.isDirectionalLight) { o.intensity = 2.9; o.color.set(0xffe4c4); }
  });
  // 辉光只留给恒星这种真正的光源
  bloom.threshold = 0.92;

  // 背景：旧的行星不要了，加上 J1407b、光环和恒星
  for (const p of bg.planets) p.visible = false;
  const sys = new THREE.Group();
  const planetDir = new THREE.Vector3(-0.62, 0.12, 0.78).normalize();
  const pr = 240;
  sys.add(makePlanet(pr));
  const rings = makeRings(pr * 1.5, pr * 8.5);
  sys.add(rings);
  const ringTilt = new THREE.Vector3(0.25, 1, 0.1).normalize();
  const ringNormal = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  // 行星放在 dir 方向；环面朝向观察者倾斜约 55°，看到的是一大片椭圆形的环，而不是一条细线
  function placePlanet(dir) {
    sys.position.copy(dir).multiplyScalar(2300);
    ringNormal.copy(dir).multiplyScalar(-Math.cos(0.96)).addScaledVector(ringTilt, Math.sin(0.96)).normalize();
    rings.quaternion.setFromUnitVectors(Z, ringNormal);
  }
  placePlanet(planetDir);
  // 行星缓慢地跟着赛道大方向走：总在前方偏左上约 25° 的位置，开车时经常能从平台缝隙里看到它
  const UP = new THREE.Vector3(0, 1, 0);
  const want = new THREE.Vector3(), left = new THREE.Vector3(), up2 = new THREE.Vector3();
  function planetTarget(path, carS) {
    const t = path.frame(carS + 250).t;
    left.crossVectors(UP, t);
    if (left.lengthSq() < 1e-4) left.set(1, 0, 0);
    left.normalize();
    up2.crossVectors(t, left).normalize();
    return want.copy(t).addScaledVector(left, 0.36).addScaledVector(up2, 0.26).normalize();
  }
  bg.group.add(sys);
  const star = makeStar();
  star.position.copy(STAR_DIR).multiplyScalar(2400);
  bg.group.add(star);

  // 管道周围漂浮的陨石（只是装饰，不参与碰撞）
  const COUNT = 260;
  const rockMat = new THREE.MeshStandardMaterial({
    map: texture(loader, 'side.jpg'), normalMap: texture(loader, 'side_n.jpg', false), roughness: 0.95, color: 0xd8d0c8,
  });
  const inst = new THREE.InstancedMesh(rockGeometry(), rockMat, COUNT);
  inst.frustumCulled = false;
  scene.add(inst);
  const items = Array.from({ length: COUNT }, () => ({}));
  // 远处的巨型陨石：和赛道所在的巨石一样大甚至更大，说明赛道也只是陨石带里的一块
  const GIANTS = 70;
  const giantGeo = rockGeometry();
  const giant = new THREE.InstancedMesh(giantGeo, rockMat, GIANTS);
  giant.frustumCulled = false;
  scene.add(giant);
  const giants = Array.from({ length: GIANTS }, () => ({}));
  function spawnGiant(o, carS, init) {
    o.s = carS + (init ? -200 + Math.random() * 2200 : 1700 + Math.random() * 500);
    o.a = TRACK_STYLE.outside ? -14 + Math.random() * 38 : Math.random() * 10;
    o.scale = 30 + Math.pow(Math.random(), 2) * 200;
    o.off = (TRACK_STYLE.outside ? 60 : 90) + o.scale + Math.pow(Math.random(), 1.3) * 900;
    o.rot = new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    o.spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.04);
  }
  const dummy = new THREE.Object3D();
  const pos = new THREE.Vector3();
  let lastPath = null;

  function spawn(o, carS, init) {
    o.s = carS + (init ? -30 + Math.random() * 450 : 380 + Math.random() * 60);
    o.a = TRACK_STYLE.outside ? -14 + Math.random() * 38 : Math.random() * 10; // 外表面模式：四面八方都有
    const big = Math.random();
    o.scale = 0.3 + big * big * big * 7;
    // 离赛道面的高度：外表面模式下漂在头顶的太空里，管道模式下在管壁外侧
    o.off = TRACK_STYLE.outside ? 16 + o.scale + Math.pow(Math.random(), 1.4) * 120 : 2.5 + o.scale + Math.pow(Math.random(), 1.6) * 70;
    o.rot = new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    o.spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.6);
  }

  return {
    update(dt, path, carS) {
      if (path !== lastPath) {
        lastPath = path;
        for (const o of items) spawn(o, carS, true);
        for (const o of giants) spawnGiant(o, carS, true);
        planetDir.copy(planetTarget(path, carS));
      }
      // 时间常数约 8 秒，转得很慢，看起来像是赛道在绕着它走
      planetDir.lerp(planetTarget(path, carS), 1 - Math.exp(-dt / 8)).normalize();
      placePlanet(planetDir);
      for (let i = 0; i < COUNT; i++) {
        const o = items[i];
        if (o.s < carS - 30) spawn(o, carS, false);
        o.rot.x += o.spin.x * dt; o.rot.y += o.spin.y * dt; o.rot.z += o.spin.z * dt;
        path.point(o.s, o.a, TRACK_STYLE.outside ? o.off : -o.off, pos);
        dummy.position.copy(pos);
        dummy.rotation.copy(o.rot);
        dummy.scale.setScalar(o.scale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < GIANTS; i++) {
        const o = giants[i];
        if (o.s < carS - 300) spawnGiant(o, carS, false);
        o.rot.x += o.spin.x * dt; o.rot.y += o.spin.y * dt; o.rot.z += o.spin.z * dt;
        path.point(o.s, o.a, TRACK_STYLE.outside ? o.off : -o.off, pos);
        dummy.position.copy(pos);
        dummy.rotation.copy(o.rot);
        dummy.scale.setScalar(o.scale);
        dummy.updateMatrix();
        giant.setMatrixAt(i, dummy.matrix);
      }
      giant.instanceMatrix.needsUpdate = true;
    },
  };
}

