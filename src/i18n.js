// 中英文文案。静态文案用 data-i18n="key" 标在 HTML 上，动态文案用 t(key, vars)
const STR = {
  zh: {
    title: '星轨断桥', titleAlt: 'STAR RIFT',
    tagline: '在宇宙中断裂的管道赛道上飞驰，选对赛道，算准落点。',
    race: '竞速模式', raceDesc: '固定赛道 · 冲过终点比用时',
    endless: '生存模式', endlessDesc: '无尽赛道 · 越跑越难 · 比距离',
    bestNone: '最佳 --', bestVal: '最佳 {v}',
    ctlSteer: '左右换道', ctlBrake: '刹车（空中也能减速）', ctlJump: '起跳', ctlPause: '暂停', ctlMute: '静音',
    keySpace: '空格',
    hint: '只有在赛道上才会自动加速 · 掉进宇宙或撞上障碍墙即失败 · 右下角雷达显示前方两节平台',
    type0: '普通', type1: '加速', type2: '减速', type3: '障碍', type4: '短台', type5: '碎裂', type6: '弹射', hole: '坑（缺失）',
    hudTime: '时间', hudDist: '距离', bestTime: '最佳用时', bestDist: '最佳距离',
    paused: '暂停', resume: '继续 (Esc)', toMenu: '返回菜单', retry: '再来一次 (R)', toMenuEsc: '返回菜单 (Esc)',
    crash: '撞毁', fall: '坠入深空', finished: '完赛！', newRecord: '新纪录！',
    progress: '完成度', time: '用时', best: '最佳', distance: '距离', survived: '存活',
    tipSlow: '减速带', tipBoost: '加速！', tipMuted: '已静音', tipUnmuted: '声音已开启',
    radarEnd: '距平台尽头', radarFinish: '距终点', radarAir: '腾空中',
    lb: '排行榜', lbGlobal: '全球', lbLocal: '本机', nickname: '昵称', nickPh: '输入你的昵称',
    lbEmpty: '还没有成绩，跑一局来占领第一名', lbLoading: '正在读取排行榜…', lbSlow: '排行榜暂时连不上，稍后会自动刷新',
    lbError: '全球榜暂时连不上，下面是本机成绩', lbLocalOnly: '全球榜未配置，只有本机排行榜',
    lbReadonly: '暂时无法上传全球榜，成绩会保存在本机',
    lbYou: '你', rankLine: '全球排名 #{r}', rankOut: '全球排名 50 名以外', uploaded: '成绩已上传全球榜',
    notBetter: '没有超过你在全球榜的最佳成绩', localOnly: '成绩已保存在本机', uploadFail: '上传失败：{m}',
    lang: 'EN',
  },
  en: {
    title: 'Star Rift', titleAlt: '星轨断桥',
    tagline: 'Race across a broken tube of floating platforms in deep space. Pick your lane, time your jump.',
    race: 'Race', raceDesc: 'Fixed track · fastest time to the finish',
    endless: 'Survival', endlessDesc: 'Endless track · gets harder · go the distance',
    bestNone: 'Best --', bestVal: 'Best {v}',
    ctlSteer: 'Switch lanes', ctlBrake: 'Brake (works mid-air)', ctlJump: 'Jump', ctlPause: 'Pause', ctlMute: 'Mute',
    keySpace: 'Space',
    hint: 'You only accelerate on the track · Falling into space or hitting a wall ends the run · The radar shows the next two platforms',
    type0: 'Normal', type1: 'Boost', type2: 'Slow', type3: 'Wall', type4: 'Short', type5: 'Crumble', type6: 'Bounce', hole: 'Hole',
    hudTime: 'TIME', hudDist: 'DISTANCE', bestTime: 'BEST TIME', bestDist: 'BEST DISTANCE',
    paused: 'Paused', resume: 'Resume (Esc)', toMenu: 'Main menu', retry: 'Retry (R)', toMenuEsc: 'Main menu (Esc)',
    crash: 'Wrecked', fall: 'Lost in space', finished: 'Finished!', newRecord: 'New record!',
    progress: 'Progress', time: 'Time', best: 'Best', distance: 'Distance', survived: 'Survived',
    tipSlow: 'SLOW ZONE', tipBoost: 'BOOST!', tipMuted: 'Sound off', tipUnmuted: 'Sound on',
    radarEnd: 'to edge', radarFinish: 'to finish', radarAir: 'airborne',
    lb: 'Leaderboard', lbGlobal: 'Global', lbLocal: 'Local', nickname: 'Name', nickPh: 'Enter your name',
    lbEmpty: 'No scores yet. Run once to take first place.', lbLoading: 'Loading leaderboard…', lbSlow: "Can't reach the leaderboard yet. It will refresh on its own.",
    lbError: "Can't reach the global board right now. Showing scores from this device.", lbLocalOnly: 'Global board not configured. Showing scores from this device.',
    lbReadonly: "Can't post to the global board right now. Scores are saved on this device.",
    lbYou: 'you', rankLine: 'Global rank #{r}', rankOut: 'Global rank: outside top 50', uploaded: 'Score posted to the global board',
    notBetter: "Didn't beat your best on the global board", localOnly: 'Score saved on this device', uploadFail: 'Upload failed: {m}',
    lang: '中文',
  },
};

let lang = 'zh';
try {
  const saved = localStorage.getItem('starrift.lang');
  lang = saved === 'en' || saved === 'zh' ? saved : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
} catch {
  lang = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const getLang = () => lang;

export function t(key, vars) {
  let s = STR[lang][key] ?? STR.zh[key] ?? key;
  if (vars) for (const k in vars) s = s.replace(`{${k}}`, vars[k]);
  return s;
}

export function applyI18n(root = document) {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
}

export function setLang(l) {
  lang = l;
  try { localStorage.setItem('starrift.lang', l); } catch { /* 存储不可用时只在本次生效 */ }
  applyI18n();
}
