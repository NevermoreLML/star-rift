// 排行榜：本机榜（localStorage）+ 全球榜（Supabase 表 scores，每人每个模式一行）
// 玩家第一次上传成绩时自动匿名登录，RLS 保证每人只能写自己的那行
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

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

// 数据来自其他玩家，读取时清洗
function clean(r) {
  if (!r || typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score <= 0) return null;
  return { id: r.user_id, name: String(r.name || '').slice(0, 16) || '???', score: r.score };
}

export class Leaderboard {
  constructor(onChange) {
    this.onChange = onChange;
    this.local = { race: readLocal('race'), endless: readLocal('endless') };
    this.global = { race: [], endless: [] };
    this.mine = { race: null, endless: null };
    // local：未配置全球榜；loading；live；error：读取失败
    this.status = 'local';
    this.canWrite = false;
    this.uid = null;
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        this.sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, storageKey: 'starrift.auth' } });
        this.status = 'loading';
        this.canWrite = true;
        this.init();
      } catch { this.status = 'error'; }
    }
  }

  async init() {
    try {
      const { data } = await this.sb.auth.getSession();
      this.uid = data.session ? data.session.user.id : null;
    } catch { /* 没有登录过也没关系，上传时再登录 */ }
    await this.refresh();
  }

  get hasGlobal() { return this.status === 'live' || this.status === 'loading'; }

  // 重新拉取两个模式的前 50 名
  async refresh() {
    if (!this.sb) return;
    try {
      const results = await Promise.all(MODES.map((mode) =>
        this.sb.from('scores').select('user_id,name,score').eq('mode', mode)
          .order('score', { ascending: mode === 'race' }).limit(GLOBAL_LIMIT)));
      MODES.forEach((mode, i) => {
        if (results[i].error) throw results[i].error;
        this.global[mode] = results[i].data.map(clean).filter(Boolean);
        const me = this.global[mode].find((r) => r.id === this.uid);
        if (me) this.mine[mode] = me;
      });
      this.status = 'live';
    } catch {
      if (this.status !== 'live') this.status = 'error';
    }
    this.onChange();
  }

  async ensureSession() {
    if (this.uid) return this.uid;
    const { data, error } = await this.sb.auth.signInAnonymously();
    if (error) throw error;
    this.uid = data.user.id;
    return this.uid;
  }

  async fetchMine(mode) {
    const { data, error } = await this.sb.from('scores').select('user_id,name,score')
      .eq('mode', mode).eq('user_id', this.uid).maybeSingle();
    if (error) throw error;
    this.mine[mode] = data ? clean(data) : null;
  }

  // 返回 { global: 'uploaded' | 'not_better' | 'local_only' | 'failed', globalRank, error }
  async submit(mode, name, score) {
    const rows = this.local[mode].concat({ name, score, at: Date.now() });
    rows.sort((a, b) => (better(mode, a.score, b.score) ? -1 : better(mode, b.score, a.score) ? 1 : 0));
    this.local[mode] = rows.slice(0, LOCAL_MAX);
    writeLocal(mode, this.local[mode]);
    const out = { global: 'local_only' };
    if (this.sb && this.canWrite) {
      try {
        await this.ensureSession();
        await this.fetchMine(mode);
        const prev = this.mine[mode];
        if (prev && !better(mode, score, prev.score)) {
          out.global = 'not_better';
        } else {
          const { error } = await this.sb.from('scores').upsert(
            { user_id: this.uid, mode, name, score, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,mode' });
          if (error) throw error;
          this.mine[mode] = { id: this.uid, name, score };
          out.global = 'uploaded';
        }
        out.globalRank = await this.rankOf(mode);
      } catch (e) {
        out.global = 'failed';
        out.error = (e && e.message) || String(e);
      }
      this.refresh();
    }
    this.onChange();
    return out;
  }

  // 全球名次 = 成绩比我好的人数 + 1
  async rankOf(mode) {
    const me = this.mine[mode];
    if (!me) return null;
    let q = this.sb.from('scores').select('user_id', { count: 'exact', head: true }).eq('mode', mode);
    q = mode === 'race' ? q.lt('score', me.score) : q.gt('score', me.score);
    const { count, error } = await q;
    if (error) throw error;
    return count + 1;
  }

  // 改昵称后同步到自己的全球记录
  async rename(name) {
    if (!this.sb || !this.uid) return;
    try {
      await this.sb.from('scores').update({ name }).eq('user_id', this.uid);
      for (const mode of MODES) if (this.mine[mode]) this.mine[mode] = { ...this.mine[mode], name };
      this.refresh();
    } catch { /* 改名失败不影响游戏 */ }
  }
}
