// 全部用 Web Audio 实时合成：引擎、风噪、刹车、音效、背景电子乐
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class SynthAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicLevel = 0; // 0 菜单（只有铺底）, 1 比赛（完整编曲）
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = this.gain(this.muted ? 0 : 0.85, comp);
    this.sfx = this.gain(0.9, this.master);
    this.music = this.gain(0.32, this.master);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // 引擎
    this.engGain = this.gain(0, this.sfx);
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 400;
    this.engFilter.Q.value = 5;
    this.engFilter.connect(this.engGain);
    this.eng = [this.osc('sawtooth', 60, this.engFilter), this.osc('square', 60.4, this.engFilter), this.osc('sine', 30, this.engGain)];

    // 风噪
    this.windGain = this.gain(0, this.sfx);
    this.windFilter = this.filter('bandpass', 600, 0.7, this.windGain);
    this.loopNoise(this.windFilter);

    // 刹车嘶声
    this.brakeGain = this.gain(0, this.sfx);
    this.loopNoise(this.filter('bandpass', 3200, 2.5, this.brakeGain));

    // 音乐延迟
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = (60 / 124) * 0.75;
    const fb = this.gain(0.33, this.delay);
    this.delay.connect(fb);
    this.delay.connect(this.music);

    this.startMusic();
  }

  gain(v, dest) { const g = this.ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; }
  filter(type, f, q, dest) { const n = this.ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.connect(dest); return n; }
  osc(type, f, dest) { const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(dest); o.start(); return o; }
  loopNoise(dest) { const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; s.connect(dest); s.start(); return s; }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05);
  }

  // norm: 速度/极速，grounded: 是否在地面，active: 是否在比赛中
  setEngine(norm, grounded, braking, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 42 + norm * 120 + (grounded ? 0 : 18);
    this.eng[0].frequency.setTargetAtTime(f, t, 0.06);
    this.eng[1].frequency.setTargetAtTime(f * 1.007, t, 0.06);
    this.eng[2].frequency.setTargetAtTime(f / 2, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(280 + norm * 2400, t, 0.08);
    this.engGain.gain.setTargetAtTime(active ? (0.05 + norm * 0.09) * (grounded ? 1 : 0.6) : 0, t, 0.08);
    this.windGain.gain.setTargetAtTime(active ? norm * norm * 0.22 : 0, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(400 + norm * 1600, t, 0.1);
    this.brakeGain.gain.setTargetAtTime(active && braking && norm > 0.05 ? (grounded ? 0.12 : 0.05) : 0, t, 0.04);
  }

  tone(type, f0, f1, dur, vol, when = 0, dest = this.sfx) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  burst(dur, vol, type, f0, f1, when = 0, dest = this.sfx) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const fl = this.ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.setValueAtTime(f0, t);
    fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl); fl.connect(g); g.connect(dest);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  jump() { this.tone('square', 180, 620, 0.2, 0.08); this.tone('sine', 320, 900, 0.25, 0.12); }
  land() { this.burst(0.18, 0.35, 'lowpass', 900, 150); this.tone('sine', 110, 45, 0.18, 0.3); }
  boost() { this.tone('sawtooth', 180, 1300, 0.45, 0.08); this.burst(0.5, 0.15, 'highpass', 800, 4000); }
  bounce() { this.tone('sine', 260, 1100, 0.35, 0.22); this.tone('triangle', 520, 1600, 0.3, 0.1); }
  slow() { this.tone('sawtooth', 300, 90, 0.35, 0.08); }
  crack() { this.burst(0.35, 0.25, 'bandpass', 1800, 300); this.tone('square', 90, 50, 0.2, 0.06); }
  crash() { this.burst(1.2, 0.8, 'lowpass', 3000, 60); this.tone('sawtooth', 140, 25, 1.0, 0.25); this.tone('sine', 70, 20, 1.2, 0.5); }
  fall() { this.tone('sine', 700, 50, 1.8, 0.2); this.tone('sawtooth', 350, 30, 1.6, 0.05); }
  beep(hi) { this.tone('square', hi ? 1320 : 660, hi ? 1320 : 660, hi ? 0.5 : 0.18, 0.12); }
  finish() { [0, 4, 7, 12, 16].forEach((n, i) => this.tone('square', mtof(72 + n), mtof(72 + n), 0.25, 0.08, i * 0.09)); }
  ready() { [0, 7, 12].forEach((n, i) => this.tone('triangle', mtof(79 + n), mtof(79 + n), 0.3, 0.09, i * 0.07)); }
  airJump() {
    this.tone('sawtooth', 300, 1800, 0.35, 0.1);
    this.tone('sine', 600, 1600, 0.3, 0.16);
    this.burst(0.4, 0.2, 'highpass', 1500, 6000);
  }
  click() { this.tone('square', 900, 1200, 0.06, 0.05); }

  // ---- 背景音乐：124 BPM，Am - F - C - G ----
  startMusic() {
    const ctx = this.ctx;
    this.bpm = 124;
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.1;
    const chords = [[57, 60, 64], [53, 57, 60], [52, 55, 60], [55, 59, 62]];
    const roots = [33, 29, 36, 31];
    const sixteenth = 60 / this.bpm / 4;
    const schedule = (step, t) => {
      const bar = Math.floor(step / 16) % 4;
      const s = step % 16;
      const full = this.musicLevel > 0.5;
      const when = t - ctx.currentTime;
      if (s === 0) this.pad(chords[bar], t, sixteenth * 16);
      // 琶音
      const ch = chords[bar];
      const note = ch[s % 3] + 12 * (Math.floor(s / 3) % 2) + 12;
      if (s % 2 === 0 || full) this.pluck(mtof(note), t, full ? 0.035 : 0.025);
      if (!full) return;
      // 鼓
      if (s % 4 === 0) this.kick(t);
      if (s % 4 === 2) this.burst(0.05, 0.12, 'highpass', 7000, 9000, when, this.music);
      if (s % 2 === 1) this.burst(0.025, 0.04, 'highpass', 9000, 10000, when, this.music);
      if (s === 4 || s === 12) this.burst(0.18, 0.25, 'bandpass', 1800, 900, when, this.music);
      // 贝斯
      if (s % 4 !== 0) this.bass(mtof(roots[bar] + (s % 4 === 3 ? 12 : 0)), t, sixteenth * 0.9);
    };
    this.timer = setInterval(() => {
      while (this.nextTime < ctx.currentTime + 0.12) {
        schedule(this.step, this.nextTime);
        this.nextTime += sixteenth;
        this.step++;
      }
    }, 25);
  }

  kick(t) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(this.music);
    o.start(t); o.stop(t + 0.35);
  }

  bass(f, t, dur) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const fl = this.ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.Q.value = 6;
    fl.frequency.setValueAtTime(1400, t);
    fl.frequency.exponentialRampToValueAtTime(180, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(fl); fl.connect(g); g.connect(this.music);
    o.start(t); o.stop(t + dur + 0.02);
  }

  pluck(f, t, vol) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol * 4, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(this.music); g.connect(this.delay);
    o.start(t); o.stop(t + 0.25);
  }

  pad(notes, t, dur) {
    const fl = this.ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.value = 1100;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.6);
    g.gain.setValueAtTime(0.06, t + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    fl.connect(g); g.connect(this.music);
    for (const n of notes) for (const det of [-6, 6]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(n - 12);
      o.detune.value = det;
      o.connect(fl);
      o.start(t); o.stop(t + dur + 0.4);
    }
  }
}
