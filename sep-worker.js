// Vocal separation (MDX-Net, ONNX) in the browser.
// Input: stereo (xl, xr) Float32Arrays @44.1 kHz of the whole song. Output: vocal stem resampled to 16 kHz (for RMVPE).
importScripts('ort/ort.wasm.min.js');
ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;

const NF = 6144, HOP = 1024, DF = 2048, TT = 128, OV = 16, STEP = TT - 2 * OV, M = 2048;
let session = null;

async function getModel(onProg) {
  const url = 'models/mdx_voc.onnx';
  let cache = null;
  try { cache = await caches.open('fukrong-models-v1'); } catch (e) {}
  let res = cache ? await cache.match(url) : null;
  if (!res) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('โหลดตัวแยกเสียงไม่สำเร็จ (' + r.status + ')');
    const total = +r.headers.get('content-length') || 29704418;
    const reader = r.body.getReader(); const parts = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProg && onProg(Math.min(1, got / total)); }
    const blob = new Blob(parts);
    if (cache) { try { await cache.put(url, new Response(blob)); } catch (e) {} }
    return new Uint8Array(await blob.arrayBuffer());
  }
  onProg && onProg(1);
  return new Uint8Array(await res.arrayBuffer());
}

// ---- FFT of size 6144 = 3 x 2048 (radix-2 core) ----
const rev = new Uint16Array(M); { const bits = 11; for (let i = 0; i < M; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; } }
const cT = new Float32Array(M / 2), sT = new Float32Array(M / 2);
for (let i = 0; i < M / 2; i++) { cT[i] = Math.cos(2 * Math.PI * i / M); sT[i] = -Math.sin(2 * Math.PI * i / M); }
const w1c = new Float32Array(NF), w1s = new Float32Array(NF), w2c = new Float32Array(NF), w2s = new Float32Array(NF);
for (let k = 0; k < NF; k++) {
  w1c[k] = Math.cos(2 * Math.PI * k / NF); w1s[k] = -Math.sin(2 * Math.PI * k / NF);
  const k2 = (2 * k) % NF; w2c[k] = Math.cos(2 * Math.PI * k2 / NF); w2s[k] = -Math.sin(2 * Math.PI * k2 / NF);
}
const win = new Float32Array(NF); for (let i = 0; i < NF; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
function fft2048(re, im) {
  for (let i = 0; i < M; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= M; size <<= 1) {
    const half = size >> 1, step = M / size;
    for (let i = 0; i < M; i += size) for (let j = 0; j < half; j++) {
      const k = j * step, a = i + j, b = a + half;
      const tr = re[b] * cT[k] - im[b] * sT[k], ti = re[b] * sT[k] + im[b] * cT[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
const ar = [new Float32Array(M), new Float32Array(M), new Float32Array(M)], ai = [new Float32Array(M), new Float32Array(M), new Float32Array(M)];
// full forward FFT of xr/xi (length NF) → outR/outI (length NF)
function fftN(xr, xi, outR, outI) {
  for (let r = 0; r < 3; r++) { const R = ar[r], I = ai[r]; for (let n = 0; n < M; n++) { R[n] = xr[3 * n + r]; I[n] = xi[3 * n + r]; } fft2048(R, I); }
  for (let k = 0; k < NF; k++) {
    const q = k & (M - 1); // k mod 2048
    const r1 = ar[1][q], i1 = ai[1][q], r2 = ar[2][q], i2 = ai[2][q];
    outR[k] = ar[0][q] + r1 * w1c[k] - i1 * w1s[k] + r2 * w2c[k] - i2 * w2s[k];
    outI[k] = ai[0][q] + r1 * w1s[k] + i1 * w1c[k] + r2 * w2s[k] + i2 * w2c[k];
  }
}
const fr = new Float32Array(NF), fi = new Float32Array(NF), gr = new Float32Array(NF), gi = new Float32Array(NF);

onmessage = async e => {
  try {
    const xl = e.data.xl, xr = e.data.xr || e.data.xl, L = xl.length;
    if (!session) {
      const bytes = await getModel(p => postMessage({ stage: 'model', prog: p }));
      postMessage({ stage: 'init', prog: 0 });
      ort.env.wasm.numThreads = Math.max(1, Math.min(4, e.data.threads || 1));
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    }
    const F = 1 + Math.floor(L / HOP), P = NF / 2;
    const out = new Float32Array(L), env = new Float32Array(L);
    const inp = new Float32Array(4 * DF * TT);
    const fr2 = new Float32Array(NF), fi2 = new Float32Array(NF);
    let done = 0;
    for (let s = 0; s < F; s += STEP) {
      const a = Math.max(0, s - OV), b = Math.min(F, s + STEP + OV), len = b - a;
      inp.fill(0);
      for (let t = 0; t < len; t++) {
        const o = (a + t) * HOP - P;
        for (let c = 0; c < 2; c++) {
          const x = c ? xr : xl;
          for (let n = 0; n < NF; n++) { let idx = o + n; if (idx < 0) idx = -idx; else if (idx >= L) idx = 2 * (L - 1) - idx; if (idx < 0) idx = 0; fr[n] = x[idx] * win[n]; fi[n] = 0; }
          fftN(fr, fi, gr, gi);
          const c0 = c * 2;
          for (let f = 0; f < DF; f++) { inp[((c0) * DF + f) * TT + t] = gr[f]; inp[((c0 + 1) * DF + f) * TT + t] = gi[f]; }
        }
      }
      const res = await session.run({ input: new ort.Tensor('float32', inp, [1, 4, DF, TT]) });
      const h = res[Object.keys(res)[0]].data;
      const e1 = Math.min(F, s + STEP);
      for (let t = s; t < e1; t++) {
        const tt = t - a, o = t * HOP - P;
        for (let c = 0; c < 2; c++) {
          fr.fill(0); fi.fill(0);
          const c0 = c * 2;
          for (let f = 0; f < DF; f++) {
            const re = h[(c0 * DF + f) * TT + tt], im = h[((c0 + 1) * DF + f) * TT + tt];
            fr[f] = re; fi[f] = -im;
            if (f > 0) { fr[NF - f] = re; fi[NF - f] = im; }
          }
          fftN(fr, fi, gr, gi);
          for (let n = 0; n < NF; n++) { const idx = o + n; if (idx < 0 || idx >= L) continue; out[idx] += 0.5 * gr[n] / NF * win[n]; }
        }
        for (let n = 0; n < NF; n++) { const idx = o + n; if (idx >= 0 && idx < L) env[idx] += win[n] * win[n]; }
      }
      done = e1;
      postMessage({ stage: 'run', prog: Math.min(1, done / F) });
    }
    // normalise by window envelope, trim padding
    const v = new Float32Array(L);
    for (let i = 0; i < L; i++) { const d = env[i]; v[i] = d > 1e-6 ? out[i] / d : 0; }
    // 44.1k → 16k: windowed-sinc low-pass evaluated at output positions
    const SR = 44100, TR = 16000, ratio = SR / TR, nOut = Math.floor(L / ratio), fc = 7600 / SR, HW = 32;
    const y = new Float32Array(nOut), kern = new Float32Array(2 * HW + 1);
    for (let i = 0; i < nOut; i++) {
      const c = i * ratio, c0 = Math.floor(c), fr0 = c - c0; let acc = 0, ws = 0;
      for (let k = -HW + 1; k <= HW; k++) {
        const idx = c0 + k; if (idx < 0 || idx >= L) continue;
        const d = k - fr0, sinc = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
        const w = 0.5 + 0.5 * Math.cos(Math.PI * d / HW);
        const kv = sinc * w; acc += v[idx] * kv; ws += kv;
      }
      y[i] = ws > 0 ? acc / ws : 0;
    }
    postMessage({ y }, [y.buffer]);
  } catch (err) {
    postMessage({ err: String(err && err.message || err) });
  }
};
