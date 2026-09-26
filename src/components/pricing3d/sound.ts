/* ╁━ /pricing 3D 卡堆音效：WebAudio 程序合成（無音檔）╁━
   - 玻璃輕叮：三個非諧和泛音（1 : 2.76 : 5.40，玻璃/鐘類的經典比）+ 極短起音 + 指數衰減；
   - 落硬木輕得：帶通噪聲短脈衝（木頭的「喀」）+ 低頻正弦（桌面的「得」）；
   - 卡落卡：高頻短叮（玻璃邊碰玻璃邊）。
   紀律：首次用戶手勢後才建 AudioContext（瀏覽器自動播放政策 + 不嚇人）；總音量很小；
   節流（同類 35ms 內只響一次、同時最多 6 個聲部），一次落 300 張卡不會變成噪音牆。 */

const STORAGE_KEY = "pricing3d.sound";
const MIN_GAP_MS = 35;
const MAX_VOICES = 6;

export interface PricingSound {
  /** 用戶手勢裡呼叫：建立/喚醒 AudioContext。 */
  unlock(): void;
  isEnabled(): boolean;
  setEnabled(on: boolean): void;
  chime(intensity?: number): void;
  knock(intensity?: number): void;
  tick(intensity?: number): void;
  dispose(): void;
}

export function readSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function createPricingSound(): PricingSound {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let enabled = readSoundPreference();
  let voices = 0;
  const lastAt: Record<string, number> = {};

  const ready = () => enabled && ctx !== null && master !== null && ctx.state === "running";

  const gate = (kind: string) => {
    const now = performance.now();
    if (now - (lastAt[kind] ?? 0) < MIN_GAP_MS || voices >= MAX_VOICES) return false;
    lastAt[kind] = now;
    return true;
  };

  const voice = (seconds: number) => {
    voices += 1;
    window.setTimeout(() => {
      voices = Math.max(0, voices - 1);
    }, seconds * 1000 + 30);
  };

  const partial = (freq: number, gain: number, decay: number, start: number) => {
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    osc.connect(amp).connect(master);
    osc.start(start);
    osc.stop(start + decay + 0.02);
  };

  return {
    unlock() {
      if (!enabled) return;
      try {
        if (!ctx) {
          const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Ctor) return;
          ctx = new Ctor();
          master = ctx.createGain();
          master.gain.value = 0.32;
          master.connect(ctx.destination);
          const length = Math.floor(ctx.sampleRate * 0.12);
          noise = ctx.createBuffer(1, length, ctx.sampleRate);
          const data = noise.getChannelData(0);
          for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
        }
        if (ctx.state === "suspended") void ctx.resume();
      } catch {
        ctx = null;
        master = null;
      }
    },
    isEnabled: () => enabled,
    setEnabled(on) {
      enabled = on;
      try {
        window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
      } catch {
        /* 隱私模式寫不進去就只在本頁生效 */
      }
      if (on) this.unlock();
    },
    chime(intensity = 1) {
      if (!ready() || !gate("chime") || !ctx) return;
      const t = ctx.currentTime;
      const base = 1900 + Math.random() * 700;
      const g = 0.05 * Math.min(1, Math.max(0.2, intensity));
      partial(base, g, 0.7, t);
      partial(base * 2.76, g * 0.45, 0.42, t);
      partial(base * 5.4, g * 0.18, 0.22, t);
      voice(0.7);
    },
    tick(intensity = 1) {
      if (!ready() || !gate("tick") || !ctx) return;
      const t = ctx.currentTime;
      const base = 3000 + Math.random() * 900;
      const g = 0.022 * Math.min(1, Math.max(0.15, intensity));
      partial(base, g, 0.09, t);
      partial(base * 1.93, g * 0.4, 0.05, t);
      voice(0.1);
    },
    knock(intensity = 1) {
      if (!ready() || !gate("knock") || !ctx || !master || !noise) return;
      const t = ctx.currentTime;
      const g = 0.11 * Math.min(1, Math.max(0.2, intensity));
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 520 + Math.random() * 380;
      band.Q.value = 2.2;
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(g, t);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      src.connect(band).connect(amp).connect(master);
      src.start(t);
      src.stop(t + 0.1);
      partial(150 + Math.random() * 40, g * 0.9, 0.11, t);
      voice(0.12);
    },
    dispose() {
      const closing = ctx;
      ctx = null;
      master = null;
      noise = null;
      if (closing) void closing.close().catch(() => undefined);
    },
  };
}
