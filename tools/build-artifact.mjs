// 生成发布到 claude.ai Artifact 用的页面：去掉 <!doctype>/<html>/<head>/<body> 外壳，
// 只保留标题、样式链接和页面内容（发布时平台会自己包上外壳）。
// 用法：node tools/build-artifact.mjs  →  dist/index.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .split('\n')
  .filter((l) => !/<meta charset|<meta name="viewport"/.test(l))
  .map((l) => l.trim())
  .filter(Boolean)
  .join('\n');
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1].trim();

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', `${head}\n${body}\n`);
console.log('dist/index.html written');
