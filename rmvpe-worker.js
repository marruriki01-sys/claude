// RMVPE singing-voice pitch tracker (8-bit ONNX) running in the browser.
// Input: 16 kHz mono Float32Array of the full song (music included). Output: f0 (Hz) + confidence every 10 ms.
importScripts('ort/ort.wasm.min.js');
ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;
ort.env.wasm.numThreads = 1;

const N = 1024, HOP = 160, NB = 128;
let session = null, MEL = null;

async function getModel(onProg) {
  const url = 'models/rmvpe_q8.onnx';
  let cache = null;
  try { cache = await caches.open('fukrong-models-v1'); } catch (e) {}
  let res = cache ? await cache.match(url) : null;
  if (!res) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('โหลดโมเดลไม่สำเร็จ (' + r.status + ')');
    const total = +r.headers.get('content-length') || 98719246;
    const reader = r.body.getReader(); const parts = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProg && onProg(Math.min(1, got / total)); }
    const blob = new Blob(parts);
    if (cache) { try { await cache.put(url, new Response(blob)); } catch (e) {} }
    return new Uint8Array(await blob.arrayBuffer());
  }
  onProg && onProg(1);
  return new Uint8Array(await res.arrayBuffer());
}

// iterative radix-2 FFT (in place), size N
const rev = new Uint32Array(N); { const bits = Math.log2(N); for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; } }
const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2); for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = -Math.sin(2 * Math.PI * i / N); }
const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
function fft(re, im) {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) for (let j = 0; j < half; j++) {
      const k = j * step, a = i + j, b = a + half;
      const tr = re[b] * cosT[k] - im[b] * sinT[k], ti = re[b] * sinT[k] + im[b] * cosT[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
function melSpec(x) {
  const pad = N / 2, L = x.length, T = Math.floor(L / HOP) + 1;
  const xp = new Float32Array(L + 2 * pad);
  xp.set(x, pad);
  for (let i = 0; i < pad; i++) { xp[pad - 1 - i] = x[Math.min(L - 1, i + 1)] || 0; xp[pad + L + i] = x[Math.max(0, L - 2 - i)] || 0; } // reflect
  const mel = new Float32Array(NB * T), re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2 + 1);
  for (let t = 0; t < T; t++) {
    const o = t * HOP;
    for (let i = 0; i < N; i++) { re[i] = xp[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    for (let m = 0; m < NB; m++) { const s = MEL[m][0], w = MEL[m][1]; let acc = 0; for (let k = 0; k < w.length; k++) acc += w[k] * mag[s + k]; mel[m * T + t] = Math.log(Math.max(acc, 1e-5)); }
  }
  return { mel, T };
}
const CENTS = new Float32Array(360); for (let i = 0; i < 360; i++) CENTS[i] = 20 * i + 1997.3794084376191;

onmessage = async e => {
  try {
    const x = e.data.x;
    if (!MEL) MEL = await (await fetch('models/mel128.json')).json();
    if (!session) {
      const bytes = await getModel(p => postMessage({ stage: 'model', prog: p }));
      postMessage({ stage: 'init', prog: 0 });
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    }
    postMessage({ stage: 'mel', prog: 0 });
    const { mel, T } = melSpec(x);
    const f0 = new Float32Array(T), conf = new Float32Array(T);
    const CH = 32 * 64, OV = 32 * 2; // ~20 s chunks, 0.64 s overlap on each side
    for (let s = 0; s < T; s += CH) {
      const a = Math.max(0, s - OV), b = Math.min(T, s + CH + OV), len = b - a, lenP = Math.ceil(len / 32) * 32;
      const inp = new Float32Array(NB * lenP);
      for (let m = 0; m < NB; m++) for (let t = 0; t < len; t++) inp[m * lenP + t] = mel[m * T + a + t];
      for (let m = 0; m < NB; m++) for (let t = len; t < lenP; t++) inp[m * lenP + t] = Math.log(1e-5);
      const out = await session.run({ input: new ort.Tensor('float32', inp, [1, NB, lenP]) });
      const h = out[Object.keys(out)[0]].data;
      for (let t = Math.max(s, a); t < Math.min(T, s + CH); t++) {
        const o = (t - a) * 360; let best = 0, bi = 0;
        for (let k = 0; k < 360; k++) if (h[o + k] > best) { best = h[o + k]; bi = k; }
        let ws = 0, wc = 0; for (let k = Math.max(0, bi - 4); k <= Math.min(359, bi + 4); k++) { ws += h[o + k]; wc += h[o + k] * CENTS[k]; }
        conf[t] = best; f0[t] = ws > 0 ? 10 * Math.pow(2, (wc / ws) / 1200) : 0;
      }
      postMessage({ stage: 'run', prog: Math.min(1, (s + CH) / T) });
    }
    postMessage({ f0, conf }, [f0.buffer, conf.buffer]);
  } catch (err) {
    postMessage({ err: String(err && err.message || err) });
  }
};
