// 原创流线型悬浮赛车：用截面放样（loft）做出光滑车身，单位为米，车头朝 +Z、车顶朝 +Y、车底在 y=0
import * as THREE from './lib.js';

// 沿 z 方向把一组截面连成光滑的管状曲面。
// 每个截面：{ z, w 半宽, h 上半高, hb 下半高, y 中心高度, n 截面圆方程度（2=椭圆，越大越方）, x 中心横向偏移 }
function loft(sections, segs = 40) {
  const pos = [];
  const idx = [];
  const ring = segs + 1;
  for (const s of sections) {
    const n = s.n || 2.4;
    for (let j = 0; j <= segs; j++) {
      const t = (j / segs) * Math.PI * 2;
      const c = Math.cos(t), sn = Math.sin(t);
      const px = (s.x || 0) + s.w * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      const py = s.y + (sn >= 0 ? s.h : s.hb ?? s.h) * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
      pos.push(px, py, s.z);
    }
  }
  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * ring + j, b = a + 1, c = a + ring, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  // 两端封口
  for (const [si, flip] of [[0, true], [sections.length - 1, false]]) {
    const s = sections[si];
    const center = pos.length / 3;
    pos.push(s.x || 0, s.y, s.z);
    for (let j = 0; j < segs; j++) {
      const a = si * ring + j, b = a + 1;
      if (flip) idx.push(center, b, a); else idx.push(center, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 水平的薄翼面：给一组 [x, z] 平面轮廓点，挤出厚度并倒圆角
function wing(points, thick, y) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.45, bevelSize: thick * 0.6, bevelSegments: 3, curveSegments: 12 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

// 竖直的薄尾鳍：给一组 [z, y] 侧面轮廓点，沿 x 方向挤出很薄的厚度
function fin(points, thick, x) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.01, bevelSegments: 2, curveSegments: 8 });
  g.rotateY(-Math.PI / 2); // 轮廓的横轴转成 z，挤出方向转成 x
  g.translate(x + thick / 2, 0, 0);
  return g;
}

// 沿曲线的发光灯条
function strip(points, radius, mat) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 48, radius, 8, false), mat);
}

export function buildSleekCar(envMap) {
  const car = new THREE.Group();

  const paint = new THREE.MeshPhysicalMaterial({
    color: 0x2340b8, metalness: 0.75, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, envMap, envMapIntensity: 1.3,
  });
  const silver = new THREE.MeshPhysicalMaterial({
    color: 0xc8d2ec, metalness: 1, roughness: 0.22, clearcoat: 0.6, envMap, envMapIntensity: 1.2,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0e1a, metalness: 0.7, roughness: 0.45, envMap });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x2ad8ff, metalness: 0.3, roughness: 0.04, transparent: true, opacity: 0.55, clearcoat: 1,
    emissive: 0x0a5a80, emissiveIntensity: 0.6, envMap, envMapIntensity: 2,
  });
  const neonPink = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3cf0).multiplyScalar(2.6) });
  const neonCyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3ef6ff).multiplyScalar(2.6) });
  const engineGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3ec8ff).multiplyScalar(1.6) });

  // ---- 主车身：车头尖、中段最宽、车尾收成平口 ----
  const Y = 0.5;
  const body = loft([
    { z: -1.95, w: 0.46, h: 0.22, hb: 0.16, y: Y, n: 3.2 },
    { z: -1.7, w: 0.56, h: 0.3, hb: 0.2, y: Y, n: 3 },
    { z: -1.0, w: 0.64, h: 0.36, hb: 0.22, y: Y, n: 2.8 },
    { z: -0.2, w: 0.62, h: 0.34, hb: 0.22, y: Y, n: 2.6 },
    { z: 0.6, w: 0.52, h: 0.27, hb: 0.2, y: Y - 0.02, n: 2.5 },
    { z: 1.3, w: 0.36, h: 0.17, hb: 0.15, y: Y - 0.05, n: 2.4 },
    { z: 1.8, w: 0.2, h: 0.09, hb: 0.09, y: Y - 0.08, n: 2.2 },
    { z: 2.12, w: 0.04, h: 0.025, hb: 0.025, y: Y - 0.1, n: 2 },
  ]);
  car.add(new THREE.Mesh(body, paint));

  // ---- 两侧推进器舱：银色金属，前端进气口、后端喷口发光 ----
  const nozzles = [];
  for (const sx of [-1, 1]) {
    const X = sx * 0.98;
    const pod = loft([
      { z: -2.05, w: 0.27, h: 0.27, y: 0.46, x: X, n: 2 },
      { z: -1.85, w: 0.31, h: 0.3, y: 0.46, x: X, n: 2.2 },
      { z: -0.9, w: 0.3, h: 0.29, y: 0.46, x: X, n: 2.4 },
      { z: 0.1, w: 0.25, h: 0.23, y: 0.44, x: X, n: 2.3 },
      { z: 0.75, w: 0.15, h: 0.13, y: 0.42, x: X, n: 2 },
      { z: 1.0, w: 0.05, h: 0.05, y: 0.41, x: X, n: 2 },
    ], 32);
    car.add(new THREE.Mesh(pod, silver));
    // 尾部喷口：深色喇叭口 + 凹进去的发光芯（从后面看是一圈光，不像轮子）
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.2, 0.16, 32, 1, true), dark);
    bell.rotation.x = Math.PI / 2;
    bell.position.set(X, 0.46, -2.1);
    car.add(bell);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.17, 32), engineGlow);
    glow.position.set(X, 0.46, -2.1);
    glow.rotation.y = Math.PI;
    car.add(glow);
    const ringGlow = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.012, 8, 40), neonCyan);
    ringGlow.position.set(X, 0.46, -2.18);
    car.add(ringGlow);
    nozzles.push(new THREE.Vector3(X, 0.46, -2.12));
    // 推进器外侧的青色灯条
    car.add(strip([[X + sx * 0.3, 0.5, -1.8], [X + sx * 0.3, 0.5, -0.9], [X + sx * 0.25, 0.48, 0.1], [X + sx * 0.12, 0.44, 0.75]], 0.022, neonCyan));
  }

  // ---- 连接车身和推进器的掠翼 ----
  for (const sx of [-1, 1]) {
    const g = wing([[0, -1.4], [0, 0.4], [sx * 0.95, -0.3], [sx * 0.98, -1.55]], 0.05, 0.42);
    car.add(new THREE.Mesh(g, paint));
  }

  // ---- 玻璃座舱 ----
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), glass);
  canopy.scale.set(0.3, 0.19, 0.78);
  canopy.position.set(0, Y + 0.3, 0.2);
  car.add(canopy);

  // ---- 尾翼：架在两个推进器上方，后缘粉色灯条 ----
  const rearWing = wing([[-1.15, -1.55], [1.15, -1.55], [1.05, -1.95], [-1.05, -1.95]], 0.05, 0.98);
  car.add(new THREE.Mesh(rearWing, paint));
  car.add(strip([[-1.08, 1.02, -1.99], [0, 1.02, -1.99], [1.08, 1.02, -1.99]], 0.022, neonPink));
  // 两片后掠的竖尾鳍，从推进器顶部撑起尾翼
  for (const sx of [-1, 1]) {
    car.add(new THREE.Mesh(fin([[-1.2, 0.7], [-1.62, 1.0], [-1.98, 1.0], [-1.95, 0.7]], 0.05, sx * 0.98), paint));
  }

  // ---- 车身两侧的粉色灯条，沿车身曲线从车尾到车头 ----
  for (const sx of [-1, 1]) {
    car.add(strip([
      [sx * 0.47, Y + 0.02, -1.9], [sx * 0.65, Y + 0.02, -1.0], [sx * 0.6, Y + 0.02, -0.1],
      [sx * 0.5, Y, 0.6], [sx * 0.33, Y - 0.04, 1.3], [sx * 0.12, Y - 0.08, 1.85],
    ], 0.02, neonPink));
  }

  // ---- 车头一道白色涂装条，增加速度感 ----
  const noseStripe = loft([
    { z: 0.7, w: 0.09, h: 0.02, y: Y + 0.255, n: 2 },
    { z: 1.3, w: 0.07, h: 0.02, y: Y + 0.12, n: 2 },
    { z: 1.8, w: 0.035, h: 0.015, y: Y + 0.01, n: 2 },
  ], 16);
  car.add(new THREE.Mesh(noseStripe, new THREE.MeshBasicMaterial({ color: 0xf2f6ff })));

  return { car, nozzles, engineMat: engineGlow };
}
