// 排行榜：本机榜（localStorage）+ 全球榜（朋友的排行榜服务，只放生存模式）
// 全球榜没有账号，按名字区分玩家：同一个名字只保留最高的一局，名字不分大小写
import { LB_URL, LB_GAME, GLOBAL_MODES, GAME_VERSION } from './config.js';

export const MODES = ['race', 'endless'];
const LOCAL_MAX = 10;
const GLOBAL_LIMIT = 50;
// 竞速比用时（越小越好），生存比距离（越大越好）
export const better = (mode, a, b) => (mode === 'race' ? a < b : a > b);

function readLocal(mode) {
  try {
    const v = JSON.parse(localStorage.getItem('starrift.lb.' + mode) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function writeLocal(mode, rows) {
  try { localStorage.setItem('starrift.lb.' + mode, JSON.stringify(rows)); } catch { /* 存储不可用 */ }
}

// 匿名客户端 id：随机串存在本机，只用来帮对方排查问题，不展示
function clientId() {
  try {
    let id = localStorage.getItem('starrift.client');
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('starrift.client', id);
    }
    return id;
  } catch { return ''; }
}

// 数据来自其他玩家，读取时清洗
function clean(r) {
  if (!r || typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score <= 0) return null;
  return { name: String(r.name || '').slice(0, 16) || '???', score: r.score };
}

export class Leaderboard {
  constructor(onChange) {
    this.onChange = onChange;
    this.local = { race: readLocal('race'), endless: readLocal('endless') };
    this.global = { race: [], endless: [] };
    this.myName = '';
    // 全球榜状态：loading / live / error（只对 GLOBAL_MODES 里的模式有意义）
    this.status = LB_URL && LB_GAME ? 'loading' : 'off';
    this.refresh();
  }

  isGlobal(mode) { return this.status !== 'off' && GLOBAL_MODES.includes(mode); }
  // 这一行是不是我自己（按名字，不分大小写）
  isMe(r) { return !!this.myName && r.name.toLowerCase() === this.myName.toLowerCase(); }

  async refresh() {
    if (this.status === 'off') { this.onChange(); return; }
    try {
      for (const mode of GLOBAL_MODES) {
        const res = await fetch(`${LB_URL}/api/top?game=${encodeURIComponent(LB_GAME)}&limit=${GLOBAL_LIMIT}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        this.global[mode] = (Array.isArray(data.top) ? data.top : []).map(clean).filter(Boolean);
      }
      this.status = 'live';
    } catch {
      if (this.status !== 'live') this.status = 'error';
    }
    this.onChange();
  }

  // 返回 { global: 'uploaded' | 'not_better' | 'local_only' | 'failed', globalRank, error }
  // extra：{ time } 本局时长（秒），只存不排序
  async submit(mode, name, score, extra = {}) {
    const rows = this.local[mode].concat({ name, score, at: Date.now() });
    rows.sort((a, b) => (better(mode, a.score, b.score) ? -1 : better(mode, b.score, a.score) ? 1 : 0));
    this.local[mode] = rows.slice(0, LOCAL_MAX);
    writeLocal(mode, this.local[mode]);
    const out = { global: 'local_only' };
    if (this.isGlobal(mode)) {
      try {
        const res = await fetch(`${LB_URL}/api/score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            game: LB_GAME, name, score: Math.max(0, Math.min(5000000, Math.floor(score))),
            time: Math.round((extra.time || 0) * 10) / 10, mode: 'Survival', version: GAME_VERSION, client: clientId(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error === 'slow down' ? '提交太频繁，稍后再试' : data.error || 'HTTP ' + res.status);
        out.global = data.best === false ? 'not_better' : 'uploaded';
        out.globalRank = typeof data.rank === 'number' ? data.rank : null;
        if (Array.isArray(data.top)) this.global[mode] = data.top.map(clean).filter(Boolean);
        this.status = 'live';
      } catch (e) {
        out.global = 'failed';
        out.error = (e && e.message) || String(e);
      }
    }
    this.onChange();
    return out;
  }

  // 全球榜没有改名接口：改名以后用新名字重新上榜，旧名字的成绩留在榜上
  rename() {}
}
