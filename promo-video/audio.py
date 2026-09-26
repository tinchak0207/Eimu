"""純代碼配樂：讀 out/cues.json（畫面時間軸導出的卡點），合成 48kHz 立體聲 → out/score.wav"""
import json, wave, os
import numpy as np

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
cues = json.load(open(os.path.join(HERE, "out", "cues.json")))
D = cues["duration"]
N = int(SR * D)
rng = np.random.default_rng(7)
dry = np.zeros((2, N)); send = np.zeros((2, N))


def hz(m): return 440.0 * 2 ** ((m - 69) / 12)


def put(sig, t0, gain=1.0, pan=0.0, rev=0.3):
    i = int(round(t0 * SR))
    if i < 0: sig = sig[-i:]; i = 0
    n = min(len(sig), N - i)
    if n <= 0: return
    a = (pan + 1) * np.pi / 4
    for ch, g in ((0, np.cos(a)), (1, np.sin(a))):
        dry[ch, i:i + n] += sig[:n] * gain * g * 1.4142
        send[ch, i:i + n] += sig[:n] * gain * g * 1.4142 * rev


def tt(dur): return np.arange(int(dur * SR)) / SR


def bell(f, dur=1.4, idx=2.2, ratio=2.0, dec=.45):
    t = tt(dur)
    env = np.exp(-t / dec) * (1 - np.exp(-t / .003))
    return np.sin(2 * np.pi * f * t + idx * np.exp(-t / .12) * np.sin(2 * np.pi * f * ratio * t)) * env


# ---------- Pad：每幕一個和弦，交叉淡入 ----------
CH = [
    (41, [57, 60, 64, 67]),        # Fmaj9
    (38, [53, 57, 60, 64]),        # Dm9
    (34, [50, 53, 57, 60]),        # Bbmaj9
    (36, [52, 55, 57, 62]),        # C6/9
    (33, [48, 52, 55, 59]),        # Am9
    (31, [46, 50, 53, 57]),        # Gm9
    (29, [48, 57, 64, 67, 72]),    # Fmaj9 開闊
]
for (a, b), (bass, notes) in zip(cues["chords"], CH):
    a0 = max(0, a - .7); dur = b - a0 + 1.6
    t = tt(dur)
    env = np.minimum(1, t / 1.1) ** 2 * np.clip((dur - t) / 1.5, 0, 1) ** 1.5
    pad = np.zeros_like(t)
    for k, m in enumerate(notes):
        for det in (-.07, 0, .06):
            f = hz(m + det)
            ph = rng.uniform(0, 6.28)
            for h in range(1, 6):
                pad += np.sin(2 * np.pi * f * h * t + ph * h) / h ** 1.9 * (1 + .25 * np.sin(2 * np.pi * .23 * t + k))
    pad *= env * .013 / len(notes) * 4
    lfo = .5 + .5 * np.sin(2 * np.pi * .11 * t)
    put(pad * (.8 + .2 * lfo), a0, 1, -.25, .7); put(pad * (1 - .2 * lfo), a0, 1, .25, .7)
    sub = (np.sin(2 * np.pi * hz(bass) * t) + .35 * np.sin(2 * np.pi * hz(bass + 12) * t)) * env * .10
    put(sub, a0, 1, 0, .1)

# ---------- 琶音（100 BPM 八分音符） ----------
grid = .3
for (a, b), (bass, notes), vel in zip(cues["chords"][1:6], CH[1:6], (.45, .8, 1.0, .9, .85)):
    pat = [0, 2, 1, 3, 2, 1, 3, 2]
    k = 0; t0 = np.ceil((a - 4.1) / grid) * grid + 4.1
    while t0 < b - .05:
        m = notes[pat[k % 8] % len(notes)] + 12
        acc = 1.0 if k % 2 == 0 else .7
        put(bell(hz(m), 1.1, 1.4, 2.0, .28), t0, .055 * vel * acc, (-.5, .5)[k % 2] * .6, .55)
        k += 1; t0 += grid

# ---------- 低頻脈動（成片 → API 段落） ----------
t0 = 15.3
while t0 < 29.4:
    t = tt(.5); f = 55 + 45 * np.exp(-t / .03)
    put(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .18) * .22, t0, 1, 0, .05)
    t0 += grid * 2

# ---------- 音效 ----------
def whoosh(dur=1.4, peak=.95):
    t = tt(dur); x = rng.standard_normal(len(t))
    env = np.where(t < peak, (t / peak) ** 2.5, np.exp(-(t - peak) / .18))
    cut = .02 + .22 * env                                   # 隨包絡開合的一階低通
    y = np.zeros_like(x); s = 0.0
    for i in range(len(x)):
        s += cut[i] * (x[i] - s); y[i] = s
    return (y - np.convolve(y, np.ones(40) / 40, "same")) * env

for c in cues["whoosh"]:
    put(whoosh(), c - .95, .20, rng.uniform(-.4, .4), .5)

for c in cues["tick"]:
    t = tt(.03); x = rng.standard_normal(len(t)); x = np.diff(x, prepend=0)
    put(x * np.exp(-t / .004) * .06 + np.sin(2 * np.pi * 2400 * t) * np.exp(-t / .006) * .025, c, 1, rng.uniform(-.3, .3), .12)

for c in cues["pop"]:
    t = tt(.25); f = 260 + 520 * (1 - np.exp(-t / .025))
    put(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .07) * .30, c, 1, 0, .3)
    put(bell(hz(84), .8, 1.0, 3.0, .2), c + .01, .05, .2, .5)

PENT = [72, 74, 77, 79, 81, 84, 86, 89, 91, 93, 96, 98]
last, idx = -9, 0
for c in sorted(cues["pluck"]):
    idx = idx + 1 if c - last < .8 else 0; last = c
    put(bell(hz(PENT[idx % len(PENT)]), 1.2, 1.8, 3.0, .32), c, .085, (idx % 5 - 2) * .2, .6)

for c in cues["chime"] + cues["bloom"]:
    for k, m in enumerate([77, 81, 84, 88]):
        put(bell(hz(m), 3.0, 1.6, 3.5, 1.1), c + k * .045, .075, (k - 1.5) * .3, .8)

for c in cues["success"]:
    for k, m in enumerate([81, 88]):
        put(bell(hz(m), 1.6, 1.4, 2.0, .45), c + k * .09, .09, (k - .5) * .4, .6)

for c in cues["shimmer"]:
    for k in range(9):
        put(bell(hz(84 + [0, 2, 5, 7, 9, 12, 14, 17, 19][k]), .9, 1.0, 3.0, .22), c + k * .06, .045, (k / 4 - 1) * .7, .8)

for c in cues["bloom"]:
    t = tt(3.0)
    put(np.sin(2 * np.pi * np.cumsum(38 + 30 * np.exp(-t / .1)) / SR) * np.exp(-t / .9) * .35, c, 1, 0, .2)
    rev_sw = whoosh(1.2, 1.1)
    put(rev_sw, c - 1.1, .16, 0, .6)

for c in cues["swell"]:
    t = tt(2.2); x = rng.standard_normal(len(t))
    y = np.convolve(x, np.ones(60) / 60, "same") * np.sin(np.pi * np.clip(t / 2.2, 0, 1)) ** 2
    put(y * .25, c, 1, 0, .8)

# ---------- 卷積殘響（合成 IR） ----------
L = int(2.8 * SR); ti = np.arange(L) / SR
ir = np.zeros((2, L))
for ch in range(2):
    n = rng.standard_normal(L) * np.exp(-ti / .75)
    n = np.convolve(n, np.ones(6) / 6, "same")
    n[: int(.022 * SR)] = 0
    ir[ch] = n / np.sqrt(np.sum(n ** 2))
nfft = 1 << int(np.ceil(np.log2(N + L)))
wet = np.stack([np.fft.irfft(np.fft.rfft(send[ch], nfft) * np.fft.rfft(ir[ch], nfft), nfft)[:N] for ch in range(2)])
mix = dry + wet * .55

# ---------- 母帶：去直流、柔性限幅、收尾淡出 ----------
mix -= np.mean(mix, axis=1, keepdims=True)
fade = np.clip((D - np.arange(N) / SR) / .9, 0, 1) ** 1.5
fin = np.clip(np.arange(N) / SR / .05, 0, 1)
mix *= fade * fin
mix = np.tanh(mix / np.max(np.abs(mix)) * 1.05) / np.tanh(1.05) * .89
pcm = (mix.T * 32767).astype("<i2")
with wave.open(os.path.join(HERE, "out", "score.wav"), "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print("score.wav", D, "s")
