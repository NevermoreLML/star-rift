// 美术素材替换：读取 assets/level1/manifest.json，美术提供了哪个文件就换哪个，
// 没提供（文件名留空）的继续用代码生成的版本。每一项单独加载，某个文件坏了只影响它自己。
import * as THREE from './lib.js';
import { GLTFLoader } from './lib.js';

export const ASSET_BASE = 'assets/level1/';

export async function loadManifest() {
  try {
    const r = await fetch(ASSET_BASE + 'manifest.json', { cache: 'no-store' });
    return r.ok ? await r.json() : {};
  } catch {
    return {};
  }
}

const url = (file) => ASSET_BASE + encodeURI(file);

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法加载 ' + file));
    img.src = url(file);
  });
}

export async function loadTexture(file) {
  const tex = new THREE.Texture(await loadImage(file));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export function loadModel(file) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url(file), (gltf) => resolve(gltf.scene), undefined,
      () => reject(new Error('无法加载 ' + file)));
  });
}

// 把一张图换进已有贴图里（保留原来的重复方式、颜色空间等设置）
export function swapImage(tex, img) {
  tex.image = img;
  tex.needsUpdate = true;
}

// 依次处理每个素材，单个失败只打印警告，不影响游戏
export async function each(entries, fn) {
  for (const [key, file] of entries) {
    if (!file) continue;
    try {
      await fn(key, file);
      console.info('[美术素材] 已替换', key, '←', file);
    } catch (e) {
      console.warn('[美术素材] 替换失败，继续用内置版本：', key, e.message);
    }
  }
}
