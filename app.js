'use strict';
/* ฝึกร้องตรงคีย์ — library + auto vocal line + karaoke trainer + score history. Everything stays on this device. */

// ---------- utils ----------
const $ = id => document.getElementById(id);
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const nn = m => NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
const fmt = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const pref = {
  get(k, d) { try { const v = localStorage.getItem('fk_' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('fk_' + k, v); } catch (e) {} }
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOP = 0.02;

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('fukrong', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('songs', { keyPath: 'id' });
      d.createObjectStore('audio');
      const s = d.createObjectStore('sessions', { keyPath: 'k', autoIncrement: true });
      s.createIndex('song', 'songId');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), st = t.objectStore(store);
    let out; const r = fn(st);
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const DB = {
  songs: () => tx('songs', 'readonly', s => s.getAll()),
  song: id => tx('songs', 'readonly', s => s.get(id)),
  putSong: o => tx('songs', 'readwrite', s => s.put(o)),
  audio: id => tx('audio', 'readonly', s => s.get(id)),
  putAudio: (id, b) => tx('audio', 'readwrite', s => s.put(b, id)),
  sessions: id => tx('sessions', 'readonly', s => s.index('song').getAll(id)),
  addSession: o => tx('sessions', 'readwrite', s => s.add(o)),
  async delSong(id) {
    await tx('songs', 'readwrite', s => s.delete(id));
    await tx('audio', 'readwrite', s => s.delete(id));
    const ks = await tx('sessions', 'readonly', s => s.index('song').getAllKeys(id));
    if (ks && ks.length) await tx('sessions', 'readwrite', s => { ks.forEach(k => s.delete(k)); });
  }
};

// ---------- views ----------
let view = 'vLib';
function show(v) {
  ['vLib', 'vHist', 'vSing'].forEach(x => { $(x).hidden = x !== v; });
  $('tabs').hidden = v === 'vSing';
  [...$('tabs').children].forEach(b => b.classList.toggle('on', b.dataset.v === v));
  view = v;
  if (v === 'vLib') renderLib();
  if (v === 'vHist') renderHist();
  if (v === 'vSing') { resizeCanvas(); requestAnimationFrame(step); }
  window.scrollTo(0, 0);
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.v); });
document.querySelectorAll('.sheet').forEach(sh => {
  sh.addEventListener('click', e => { if (e.target === sh && sh.id !== 'proc') sh.hidden = true; if (e.target.closest('[data-close]')) sh.hidden = true; });
});
addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.sheet').forEach(s => { if (s.id !== 'proc') s.hidden = true; }); });

// ---------- library ----------
const COVERS = [['#ff5d7d', '#ff8a5b'], ['#7b5cff', '#c06cff'], ['#1fb5a5', '#4f7cff'], ['#ff9d3c', '#ff5d7d'], ['#5a67ff', '#33c4ff'], ['#d44cff', '#ff5da8']];
function coverStyle(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; const c = COVERS[h % COVERS.length]; return `background:linear-gradient(135deg,${c[0]},${c[1]})`; }
async function renderLib() {
  let songs = [];
  try { songs = await DB.songs(); } catch (e) { $('songs').innerHTML = '<p class="err">เปิดที่เก็บข้อมูลในเครื่องไม่ได้ (โหมดไม่ระบุตัวตนอาจบล็อก) ลองเปิดแบบปกติ</p>'; return; }
  songs.sort((a, b) => (b.lastAt || b.created) - (a.lastAt || a.created));
  $('empty').hidden = songs.length > 0;
  const box = $('songs'); box.innerHTML = '';
  songs.forEach(s => {
    const d = document.createElement('div');
    d.className = 'song'; d.tabIndex = 0; d.setAttribute('role', 'button');
    d.innerHTML = `<div class="cover" style="${coverStyle(s.id)}">${esc((s.title || '?').trim().charAt(0) || '♪')}</div>
      <div><h3>${esc(s.title)}</h3><div class="meta">${esc(s.artist || 'ไม่ระบุศิลปิน')} · ${fmt(s.duration)}</div>
      <div class="tags">${s.kind === 'pack' ? '<span class="tag acc">✦ เส้นแม่นพิเศษ</span>' : s.engine === 'rmvpe' ? '<span class="tag">เส้นอัตโนมัติ (RMVPE)</span>' : '<span class="tag">เส้นแบบเก่า · อัปเกรดได้</span>'}${s.best != null ? `<span class="tag best">ดีสุด ${s.best}%</span>` : ''}${s.plays ? `<span class="tag">ร้องแล้ว ${s.plays} ครั้ง</span>` : ''}</div></div>
      <button class="del" aria-label="ลบเพลง ${esc(s.title)}">🗑</button>`;
    d.addEventListener('click', e => { if (e.target.closest('.del')) { e.stopPropagation(); askDelete(s); return; } openSong(s.id); });
    d.addEventListener('keydown', e => { if (e.key === 'Enter') openSong(s.id); });
    box.appendChild(d);
  });
}
function askDelete(s) {
  $('cMsg').textContent = `ลบ "${s.title}" ออกจากคลัง? ประวัติคะแนนของเพลงนี้จะหายด้วย`;
  $('confirm').hidden = false;
  $('cYes').onclick = async () => { $('confirm').hidden = true; await DB.delSong(s.id); renderLib(); };
  $('cNo').onclick = () => { $('confirm').hidden = true; };
}

// ---------- add song ----------
$('fileIn').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (f) addSong(f);
});
function proc(msg, frac, sub) {
  $('proc').hidden = false; $('procMsg').textContent = msg;
  if (frac != null) $('procBar').style.width = Math.round(frac * 100) + '%';
  if (sub != null) $('procSub').textContent = sub;
}
function guessTitle(name) {
  let n = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();
  let artist = '';
  const m = n.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) { artist = m[1].trim(); n = m[2].trim(); }
  return { title: n || 'เพลงใหม่', artist };
}
async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const ab = await new Promise((res, rej) => { const p = ac.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
  try { ac.close(); } catch (e) {}
  return ab;
}
async function to16k(ab, highpass) {
  const n = Math.ceil(ab.duration * 16000);
  try {
    const oc = new OfflineAudioContext(1, n, 16000);
    const s = oc.createBufferSource(); s.buffer = ab;
    if (highpass) { const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 150; hp.Q.value = 0.7; s.connect(hp).connect(oc.destination); }
    else s.connect(oc.destination);
    s.start();
    const r = await oc.startRendering();
    return r.getChannelData(0);
  } catch (e) {
    // fallback: JS downmix + box-filter resample + one-pole high-pass
    const ch = [], C = ab.numberOfChannels, sr = ab.sampleRate, ratio = sr / 16000;
    for (let c = 0; c < C; c++) ch.push(ab.getChannelData(c));
    const out = new Float32Array(n); let prevX = 0, prevY = 0; const a = Math.exp(-2 * Math.PI * 150 / 16000);
    for (let i = 0; i < n; i++) {
      const s0 = Math.floor(i * ratio), s1 = Math.min(ab.length, Math.floor((i + 1) * ratio)); let acc = 0, k = 0;
      for (let j = s0; j < s1; j++) { for (let c = 0; c < C; c++) acc += ch[c][j]; k += C; }
      const x = k ? acc / k : 0; const y = a * (prevY + x - prevX); prevX = x; prevY = y; out[i] = highpass ? y : x;
    }
    return out;
  }
}
let worker = null;
function analyze(x, onProg) {
  return new Promise((res, rej) => {
    if (!worker) worker = new Worker('analyze-worker.js');
    worker.onmessage = e => {
      const d = e.data;
      if (d.prog != null) { onProg && onProg(d.prog); return; }
      if (d.err) { rej(new Error(d.err)); return; }
      res(d.p);
    };
    worker.onerror = e => rej(new Error('ตัววิเคราะห์เสียงทำงานผิดพลาด'));
    worker.postMessage({ x }, [x.buffer]);
  });
}
// RMVPE (singing-voice pitch model) — main engine for user songs
let rmWorker = null;
function analyzeRmvpe(x, onProg) {
  return new Promise((res, rej) => {
    if (!rmWorker) rmWorker = new Worker('rmvpe-worker.js');
    rmWorker.onmessage = e => {
      const d = e.data;
      if (d.stage) { onProg && onProg(d.stage, d.prog); return; }
      if (d.err) { rej(new Error(d.err)); return; }
      res(d);
    };
    rmWorker.onerror = () => rej(new Error('ตัววิเคราะห์ RMVPE ทำงานผิดพลาด'));
    rmWorker.postMessage({ x }, [x.buffer]);
  });
}
function rmvpeToLine(f0, conf, nOut) {
  const n = nOut, m = new Array(n).fill(null), c = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const a = 2 * j, b = Math.min(f0.length - 1, 2 * j + 1); if (a >= f0.length) break;
    c[j] = (conf[a] + conf[b]) / 2; const f = (f0[a] + f0[b]) / 2;
    if (f > 0) m[j] = 69 + 12 * Math.log2(f / 440);
  }
  let on = false;
  for (let j = 0; j < n; j++) { on = on ? c[j] >= 0.08 : c[j] >= 0.2; if (!on || m[j] == null || m[j] < 40 || m[j] > 84) m[j] = null; }
  const runs = (test, fn) => { for (let i = 0; i < n;) { if (test(i)) { let j = i; while (j < n && test(j)) j++; fn(i, j); i = j; } else i++; } };
  const cm = (i, j) => { let s = 0; for (let k = i; k < j; k++) s += c[k]; return s / (j - i); };
  const lmed = (a, i, r) => { const w = []; for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) if (a[k] != null) w.push(a[k]); if (!w.length) return null; w.sort((x, y) => x - y); return w[w.length >> 1]; };
  for (let pass = 0; pass < 2; pass++) {
    const ref = m.slice(), dev = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (m[i] != null) { const md = lmed(ref, i, 30); if (md != null && Math.abs(m[i] - md) > 6) dev[i] = 1; }
    runs(i => dev[i], (i, j) => { const d = (j - i) * HOP; if (d < 0.2 || (d < 0.4 && cm(i, j) < 0.5)) for (let k = i; k < j; k++) m[k] = null; });
  }
  runs(i => m[i] == null, (i, j) => { if (i > 0 && j < n && m[i - 1] != null && m[j] != null && (j - i) * HOP <= 0.08) for (let k = i; k < j; k++) m[k] = m[i - 1] + (m[j] - m[i - 1]) * (k - i + 1) / (j - i + 1); });
  runs(i => m[i] != null, (i, j) => { const d = (j - i) * HOP; if (d < 0.1 || (d < 0.3 && cm(i, j) < 0.15)) for (let k = i; k < j; k++) m[k] = null; });
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) if (m[i] != null) { const w = []; for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < n && m[k] != null) w.push(m[k]); w.sort((x, y) => x - y); out[i] = Math.round(w[w.length >> 1] * 10); }
  return out;
}
const STAGE = { model: 'ดาวน์โหลดตัวจับเสียงร้อง (ครั้งแรกครั้งเดียว ~99MB)', init: 'เตรียมตัวจับเสียงร้อง…', mel: 'วิเคราะห์เสียงเพลง…', run: 'วาดเส้นเสียงร้อง…' };
// full auto line: RMVPE first, Melodia fallback. returns {line, engine}
async function autoLine(ab, nOut, base, span) {
  try {
    const x = await to16k(ab, false);
    const d = await analyzeRmvpe(x, (st, p) => {
      const w = { model: [0, 0.35], init: [0.35, 0.4], mel: [0.4, 0.45], run: [0.45, 1] }[st] || [0, 1];
      proc(STAGE[st] + (st === 'model' || st === 'run' ? ' ' + Math.round(p * 100) + '%' : ''), base + span * (w[0] + (w[1] - w[0]) * p));
    });
    return { line: rmvpeToLine(d.f0, d.conf, nOut), engine: 'rmvpe' };
  } catch (err) {
    try { rmWorker && rmWorker.terminate(); } catch (e) {} rmWorker = null;
    proc('เครื่องนี้ใช้ตัวจับเสียงหลักไม่ได้ ใช้วิธีสำรองแทน…', base);
    const x = await to16k(ab, true);
    const hz = await analyze(x, f => proc('วาดเส้นเสียงร้อง (วิธีสำรอง)… ' + Math.round(f * 100) + '%', base + span * f));
    return { line: toLine(hz, nOut), engine: 'melodia' };
  }
}

// Melodia Hz (hop 128 @16k) → MIDI line at 0.02 s, cleaned
function toLine(hz, nOut) {
  const fh = 128 / 16000, out = new Array(nOut).fill(null);
  for (let j = 0; j < nOut; j++) {
    const t = j * HOP, a = Math.max(0, Math.floor((t - HOP / 2) / fh)), b = Math.min(hz.length - 1, Math.ceil((t + HOP / 2) / fh));
    const v = []; let tot = 0;
    for (let i = a; i <= b; i++) { tot++; if (hz[i] > 0) v.push(69 + 12 * Math.log2(hz[i] / 440)); }
    if (v.length && v.length >= tot / 2) { v.sort((p, q) => p - q); const m = v[v.length >> 1]; if (m >= 45 && m <= 84) out[j] = m; }
  }
  return cleanLine(out);
}
function localMedian(a, i, r) { const w = []; for (let k = Math.max(0, i - r); k <= Math.min(a.length - 1, i + r); k += 2) if (a[k] != null) w.push(a[k]); if (!w.length) return null; w.sort((x, y) => x - y); return w[w.length >> 1]; }
function cleanLine(m) {
  const n = m.length;
  // octave jumps: pull each frame to the octave nearest the surrounding ±1.5 s melody
  for (let pass = 0; pass < 2; pass++) {
    const ref = m.slice();
    for (let i = 0; i < n; i++) { if (m[i] == null) continue; const md = localMedian(ref, i, 75); if (md == null) continue; while (m[i] - md > 7) m[i] -= 12; while (md - m[i] > 7) m[i] += 12; }
  }
  // short runs far from the local melody are almost always an instrument → drop
  { const ref = m.slice(), dev = new Uint8Array(n);
    for (let i = 0; i < n; i++) { if (m[i] == null) continue; const md = localMedian(ref, i, 50); if (md != null && Math.abs(m[i] - md) > 5) dev[i] = 1; }
    for (let i = 0; i < n;) { if (dev[i]) { let j = i; while (j < n && dev[j]) j++; if ((j - i) * HOP < 0.4) for (let k = i; k < j; k++) m[k] = null; i = j; } else i++; } }
  let sm = m.slice();
  for (let i = 0; i < n; i++) if (m[i] != null) { const w = []; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n && m[k] != null) w.push(m[k]); w.sort((a, b) => a - b); sm[i] = w[w.length >> 1]; }
  for (let i = 0; i < n;) { if (sm[i] != null) { let j = i; while (j < n && sm[j] != null) j++; if ((j - i) * HOP < 0.12) for (let k = i; k < j; k++) sm[k] = null; i = j; } else i++; }
  for (let i = 1; i < n;) { if (sm[i] == null) { let j = i; while (j < n && sm[j] == null) j++; if (j < n && sm[i - 1] != null && (j - i) * HOP <= 0.1) for (let k = i; k < j; k++) sm[k] = sm[i - 1] + (sm[j] - sm[i - 1]) * (k - i + 1) / (j - i + 1); i = j; } else i++; }
  return sm.map(v => v == null ? 0 : Math.round(v * 10));
}
let packCache = null;
async function getPacks() {
  if (packCache) return packCache;
  try { packCache = [await (await fetch('packs/dokmai.json')).json()]; } catch (e) { packCache = []; }
  return packCache;
}
// Compare a short auto-line excerpt with an accurate pack line; returns {lag, score}
function matchPack(ex, startFrame, pack) {
  const P = pack.p10; let best = { lag: 0, score: 0 };
  for (let lag = -100; lag <= 100; lag++) {
    let both = 0, good = 0;
    for (let i = 0; i < ex.length; i += 2) {
      const a = ex[i], b = P[startFrame + i + lag];
      if (!a || !b) continue; both++;
      const d = Math.abs((((a - b) / 10 + 6) % 12 + 12) % 12 - 6); if (d < 1) good++;
    }
    if (both > 200 && good / both > best.score) best = { lag, score: good / both };
  }
  return best;
}
async function addSong(file) {
  const guess = guessTitle(file.name);
  $('procForm').hidden = true; $('procH').textContent = 'กำลังเตรียมเพลง';
  proc('อ่านไฟล์เพลง…', 0.03, 'เพลงยาว 3–4 นาที ใช้เวลาประมาณ 1–3 นาที (มือถือช้ากว่าคอม) อย่าปิดหน้านี้');
  try {
    const ab = await decodeFile(file);
    const dur = ab.duration, nOut = Math.ceil(dur / HOP);
    proc('เตรียมเสียงสำหรับวิเคราะห์…', 0.08);
    let line = null, kind = 'auto', title = guess.title, artist = guess.artist, note = '', engine = null, lag = 0, packVer = null;
    const packs = await getPacks();
    const cand = packs.find(p => Math.abs(p.duration - dur) < 4);
    if (cand) {
      const x = await to16k(ab, true);
      proc('เช็กว่ามีเส้นแม่นพิเศษสำหรับเพลงนี้ไหม…', 0.12);
      const s0 = Math.min(25, dur / 4), s1 = Math.min(dur, s0 + 50);
      const exHz = await analyze(x.slice(Math.floor(s0 * 16000), Math.floor(s1 * 16000)), f => proc('เช็กว่ามีเส้นแม่นพิเศษสำหรับเพลงนี้ไหม…', 0.12 + f * 0.15));
      const ex = toLine(exHz, Math.ceil((s1 - s0) / HOP));
      const m = matchPack(ex, Math.round(s0 / HOP), cand);
      if (m.score >= 0.5) {
        line = new Array(nOut).fill(0).map((_, j) => cand.p10[j + m.lag] || 0);
        kind = 'pack'; title = cand.title; artist = cand.artist; lag = m.lag; packVer = cand.ver || 1;
        note = '✦ เจอเส้นแม่นพิเศษของเพลงนี้ ใช้เส้นที่ทำจากเสียงร้องแยกเดี่ยว';
      }
    }
    if (!line) {
      const r = await autoLine(ab, nOut, 0.12, 0.86);
      line = r.line; engine = r.engine;
      note = engine === 'rmvpe' ? 'เส้นนี้วาดด้วยตัวจับเสียงร้อง RMVPE (ทำมาเพื่อเสียงคนร้องโดยเฉพาะ) ส่วนใหญ่ตรงกับเสียงร้อง บางจุดที่ดนตรีดังมากอาจคลาดได้'
        : 'เส้นนี้วาดด้วยวิธีสำรอง (เครื่องนี้ใช้ตัวจับเสียงหลักไม่ได้) แม่นน้อยกว่า บางจุดอาจไปจับเสียงเครื่องดนตรี';
    }
    const voiced = line.filter(v => v).length * HOP;
    if (voiced < 10) throw new Error('หาเสียงร้องในไฟล์นี้ไม่เจอ (อาจเป็นเพลงบรรเลงหรือไฟล์เสีย)');
    proc('เสร็จแล้ว! ตั้งชื่อเพลงได้เลย', 1, '');
    $('procH').textContent = 'เพิ่มเพลงเสร็จแล้ว';
    $('fTitle').value = title; $('fArtist').value = artist; $('fNote').textContent = note; $('procForm').hidden = false;
    await new Promise(res => { $('fSave').onclick = res; });
    const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = { id, title: $('fTitle').value.trim() || title, artist: $('fArtist').value.trim(), duration: dur, kind, engine, lag, packVer, p10: line, created: Date.now(), best: null, plays: 0 };
    await DB.putAudio(id, file);
    await DB.putSong(rec);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    $('proc').hidden = true; renderLib();
  } catch (err) {
    $('procH').textContent = 'เพิ่มเพลงไม่สำเร็จ';
    proc(err && err.message ? err.message : 'เปิดไฟล์นี้ไม่ได้ ลองไฟล์ mp3 หรือ m4a', 0, 'แตะพื้นหลังเพื่อปิด');
    $('proc').addEventListener('click', function h(e) { if (e.target === $('proc')) { $('proc').hidden = true; $('proc').removeEventListener('click', h); } });
  }
}

// ---------- song model ----------
let S = null; // current song
let P = [], B = [], PH = [], HM = new Uint8Array(0), DUR = 0;
function buildModel(rec) {
  P = rec.p10.map(v => v ? v / 10 : null);
  DUR = rec.duration;
  B = []; let cur = null;
  for (let i = 0; i <= P.length; i++) {
    const v = i < P.length ? P[i] : null, k = v == null ? null : Math.round(v);
    if (cur && (k == null || k !== cur.n)) { if (i - cur.s >= 4) B.push({ t0: cur.s * HOP, t1: i * HOP, n: cur.n, hit: 0, tot: 0 }); cur = null; }
    if (k != null && !cur) cur = { s: i, n: k };
  }
  // phrases: break at breaths; aim for 4–8 s chunks (always break at a real pause > 0.7 s)
  PH = [];
  if (B.length) {
    let s = B[0].t0, e = B[0].t1;
    for (const b of B.slice(1)) {
      const gap = b.t0 - e, len = e - s;
      if (gap > 0.7 || (len >= 4 && gap >= 0.12) || (len >= 8 && gap >= 0.06)) { PH.push([s, e]); s = b.t0; }
      e = b.t1;
    }
    PH.push([s, e]);
    if (PH.length > 1 && PH[PH.length - 1][1] - PH[PH.length - 1][0] < 2.5) { const l = PH.pop(); PH[PH.length - 1][1] = l[1]; }
    PH = PH.filter(p => p[1] - p[0] >= 1.2);
  }
  HM = new Uint8Array(P.length);
}

// ---------- player ----------
const el = new Audio(); el.preload = 'auto';
window.__el = el;
let playing = false, ctx = null, osc = null, og = null, unlocked = false, curUrl = null, countdown = 0;
let loopOn = false, curPh = null, take = [], lastIdx = -1;
const SH = () => +$('shift').value;
let SYNC = +pref.get('sync', 0);
const clock = () => Math.max(0, el.currentTime - SYNC / 1000);
function setPP() { el.preservesPitch = true; el.webkitPreservesPitch = true; el.mozPreservesPitch = true; }

for (let s = -12; s <= 12; s++) { const o = document.createElement('option'); o.value = s; o.textContent = (s > 0 ? '+' : '') + s + (s === 0 ? ' (คีย์จริง)' : ''); $('shift').appendChild(o); }
['shift', 'speed', 'guide', 'gain'].forEach(k => { const v = pref.get(k, null); if (v !== null) $(k).value = v; $(k).addEventListener('change', () => { pref.set(k, $(k).value); applyAudio(); if (k === 'gain' && gainN) gainN.gain.value = +$('gain').value; }); });
$('shift').value = pref.get('shift', '0');
$('oct').checked = pref.get('oct', '1') === '1'; $('oct').onchange = () => pref.set('oct', $('oct').checked ? '1' : '0');
$('sync').value = SYNC; const syncTxt = () => { $('syncTxt').textContent = (SYNC > 0 ? '+' : '') + SYNC + ' ms'; }; syncTxt();
$('sync').oninput = () => { SYNC = +$('sync').value; syncTxt(); pref.set('sync', SYNC); };
$('gear').onclick = () => { $('sheet').hidden = false; };

function applyAudio() {
  el.playbackRate = +$('speed').value; setPP();
  el.muted = $('guide').value === 'tone';
  el.volume = 0.9;
}
async function openSong(id) {
  const rec = await DB.song(id); if (!rec) return;
  const blob = await DB.audio(id);
  if (!blob) { alertErr('ไม่เจอไฟล์เพลงในเครื่อง ลองลบแล้วเพิ่มเพลงนี้ใหม่'); return; }
  pause(true);
  // accurate-line pack got better since this song was added → swap in the new line automatically
  if (rec.kind === 'pack') {
    const pk = (await getPacks()).find(p => p.title === rec.title) || (await getPacks())[0];
    if (pk && (rec.packVer || 1) !== (pk.ver || 1)) {
      let lag = rec.lag;
      if (lag == null) { const m = matchPack(rec.p10.slice(0, Math.min(rec.p10.length, 6000)), 0, pk); lag = m.lag; }
      rec.p10 = rec.p10.map((_, j) => pk.p10[j + lag] || 0); rec.lag = lag; rec.packVer = pk.ver || 1;
      try { await DB.putSong(rec); } catch (e) {}
    }
  }
  $('upg').hidden = !(rec.kind === 'auto' && rec.engine !== 'rmvpe');
  S = rec; buildModel(rec);
  if (curUrl) URL.revokeObjectURL(curUrl);
  curUrl = URL.createObjectURL(blob); el.src = curUrl; applyAudio();
  $('sTitle').textContent = rec.title; $('sArtist').textContent = (rec.artist || '') + (rec.kind === 'pack' ? ' · ✦ เส้นแม่นพิเศษ' : ' · เส้นอัตโนมัติ');
  $('seek').max = DUR.toFixed(1); $('seek').value = 0; el.currentTime = 0;
  take = []; loopOn = false; $('bLoop').setAttribute('aria-pressed', 'false'); curPh = null;
  $('score').textContent = '–'; $('err').hidden = true; window._c = undefined; window._lastBall = null;
  renderPhr(); show('vSing');
}
$('upgBtn').onclick = async () => {
  if (!S) return; pause(true);
  const id = S.id;
  $('procForm').hidden = true; $('procH').textContent = 'อัปเกรดเส้นเสียงร้อง';
  proc('อ่านไฟล์เพลง…', 0.03, 'ใช้เวลาประมาณ 1–3 นาที (มือถือช้ากว่าคอม) อย่าปิดหน้านี้');
  try {
    const blob = await DB.audio(id); const ab = await decodeFile(blob);
    const r = await autoLine(ab, Math.ceil(ab.duration / HOP), 0.05, 0.95);
    const rec = await DB.song(id); rec.p10 = r.line; rec.engine = r.engine; await DB.putSong(rec);
    $('proc').hidden = true; openSong(id);
  } catch (err) { $('procH').textContent = 'อัปเกรดไม่สำเร็จ'; proc(err.message || String(err), 0, 'แตะพื้นหลังเพื่อปิด'); $('proc').onclick = e => { if (e.target === $('proc')) $('proc').hidden = true; }; }
};
function renderPhr() {
  const box = $('phr'); box.innerHTML = '';
  PH.forEach((p, i) => {
    const b = document.createElement('button');
    b.innerHTML = 'ท่อน ' + (i + 1) + ' · ' + fmt(p[0]) + (p.s != null ? '<span class="ps">' + p.s + '%</span>' : '');
    b.onclick = () => { curPh = i; seek(Math.max(0, p[0] - 1.5)); markPh(); if (!playing) play(); };
    box.appendChild(b);
  });
  markPh();
}
function markPh() { [...$('phr').children].forEach((b, i) => { b.classList.toggle('cur', i === curPh); if (i === curPh) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }); }
const phAt = t => { let k = 0; PH.forEach((p, i) => { if (t >= p[0] - 1.5) k = i; }); return k; };
$('bLoop').onclick = () => { loopOn = !loopOn; $('bLoop').setAttribute('aria-pressed', loopOn); if (loopOn && curPh == null) curPh = phAt(clock()); markPh(); };
function seek(t) { el.currentTime = t; $('seek').value = t; }
$('seek').oninput = () => { seek(+$('seek').value); curPh = phAt(+$('seek').value); markPh(); };

function ensureCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!ctx) ctx = new AC();
  if (ctx.state !== 'running') ctx.resume();
  if (!osc) { osc = ctx.createOscillator(); og = ctx.createGain(); osc.type = 'triangle'; og.gain.value = 0; osc.connect(og).connect(ctx.destination); osc.start(); }
}
// iOS starts an AudioContext made outside a tap as "suspended": wake it on the next tap
['touchend', 'click'].forEach(ev => addEventListener(ev, () => { if (ctx && ctx.state === 'suspended') ctx.resume(); }, { passive: true }));
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function play() {
  if (!S) return;
  ensureCtx(); applyAudio();
  if (!unlocked) { const m = el.muted; el.muted = true; const pr = el.play(); if (pr && pr.then) pr.then(() => { if (countdown) el.pause(); el.muted = m || $('guide').value === 'tone'; unlocked = true; }).catch(() => {}); }
  take = [];
  countdown = performance.now() + 1500; playing = true; $('bPlay').textContent = '❚❚'; $('bPlay').setAttribute('aria-label', 'หยุด');
  setTimeout(() => { if (playing) { applyAudio(); const pr = el.play(); if (pr && pr.catch) pr.catch(() => { alertErr('เบราว์เซอร์ไม่ยอมเล่นเสียง แตะ ▶ อีกครั้ง'); pause(true); }); } }, 1500);
}
function pause(silent) {
  if (playing && !silent && take.length > 90) report();
  playing = false; el.pause(); $('bPlay').textContent = '▶'; $('bPlay').setAttribute('aria-label', 'เล่น');
  if (og && ctx) og.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  countdown = 0;
}
$('bPlay').onclick = () => playing ? pause() : play();
el.onended = () => pause();
$('back').onclick = () => { pause(); show('vLib'); };
function alertErr(t) { $('err').hidden = false; $('err').textContent = t; }

// ---------- mic + pitch ----------
let an = null, buf = null, micOn = false, stream = null, gainN = null;
// McLeod pitch method on a 2x-decimated buffer, 55–1000 Hz
function mpm(b, sr, gate) {
  const W = b.length >> 1, x = new Float32Array(W), sr2 = sr / 2; let mean = 0;
  for (let i = 0; i < W; i++) { x[i] = (b[2 * i] + b[2 * i + 1]) * 0.5; mean += x[i]; }
  mean /= W; let e = 0; for (let i = 0; i < W; i++) { x[i] -= mean; e += x[i] * x[i]; }
  const rms = Math.sqrt(e / W); if (rms < gate) return null;
  const tMin = Math.max(2, Math.floor(sr2 / 1000)), tMax = Math.min(W - 2, Math.ceil(sr2 / 55));
  const n = new Float32Array(tMax + 2);
  // m(tau) via running sums of squares
  const sq = new Float32Array(W + 1); for (let i = 0; i < W; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  for (let t = 0; t <= tMax + 1; t++) {
    let r = 0; const L = W - t; for (let i = 0; i < L; i++) r += x[i] * x[i + t];
    const m = sq[L] + (sq[W] - sq[t]); n[t] = m > 0 ? 2 * r / m : 0;
  }
  // key maxima between positive zero crossings
  const peaks = []; let t = 1; while (t < tMax && n[t] > 0) t++;
  while (t < tMax) {
    while (t < tMax && n[t] <= 0) t++;
    let best = t; while (t < tMax && n[t] > 0) { if (n[t] > n[best]) best = t; t++; }
    if (best >= tMin && best < tMax) peaks.push(best);
  }
  if (!peaks.length) return null;
  let mx = 0; for (const p of peaks) mx = Math.max(mx, n[p]);
  const k = peaks.find(p => n[p] >= 0.88 * mx);
  const a = n[k - 1], bb = n[k], c = n[k + 1], den = a - 2 * bb + c, sh = den ? 0.5 * (a - c) / den : 0;
  return { f: sr2 / (k + sh), c: bb, rms };
}
// smoothing: confidence gate, octave-snap to the recent stable pitch, median of 5, light easing for the ball
function makeTracker() {
  const h = []; let disp = null, stable = null, miss = 0;
  return (raw, conf) => {
    if (raw != null && (raw < 33 || raw > 88 || conf < 0.6)) raw = null;
    if (raw != null && stable != null) { const d = raw - stable; if (Math.abs(d - 12) < 1.2) raw -= 12; else if (Math.abs(d + 12) < 1.2) raw += 12; }
    h.push(raw); if (h.length > 5) h.shift();
    const v = h.filter(x => x != null).sort((a, b) => a - b);
    if (raw == null || v.length < 2) { if (++miss > 3) { disp = null; stable = miss > 30 ? null : stable; } return disp; }
    miss = 0; const med = v[v.length >> 1]; const val = Math.abs(raw - med) > 1 ? med : raw;
    stable = stable == null ? val : stable + (val - stable) * 0.15;
    disp = disp == null || Math.abs(val - disp) > 0.8 ? val : disp + (val - disp) * 0.6;
    return disp;
  };
}
const track = makeTracker();
async function startMic(id) {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw { name: 'ต้องเปิดผ่านลิงก์ https' };
    if (stream) stream.getTracks().forEach(k => k.stop());
    const c = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (id) c.deviceId = { exact: id };
    stream = await navigator.mediaDevices.getUserMedia({ audio: c });
    // iPhone switches the audio hardware into record mode (often a new sample rate) when the mic opens;
    // an AudioContext made before that crackles or plays at the wrong speed, so rebuild it now.
    if (ctx && !ctx._afterMic) { try { ctx.close(); } catch (e) {} ctx = null; osc = null; og = null; }
    ensureCtx(); ctx._afterMic = true;
    const s = ctx.createMediaStreamSource(stream);
    gainN = ctx.createGain(); gainN.gain.value = +$('gain').value;
    an = ctx.createAnalyser(); an.fftSize = 2048; s.connect(gainN).connect(an); buf = new Float32Array(2048); micOn = true;
    $('bMic').setAttribute('aria-pressed', 'true'); $('err').hidden = true;
    const used = stream.getAudioTracks()[0].getSettings().deviceId;
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const sel = $('micSel'); sel.innerHTML = '';
    devs.forEach(d => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'ไมค์'; if (d.deviceId === used) o.selected = true; sel.appendChild(o); });
    if (used) pref.set('mic', used);
  } catch (e) {
    if (id) { startMic(); return; }
    alertErr('เปิดไมค์ไม่ได้ กดอนุญาตไมค์ (ไอคอนข้างช่องที่อยู่เว็บ / ตั้งค่า Safari) แล้วลองใหม่ (' + (e.name || e) + ')');
  }
}
if (IS_IOS) $('lvlTxt').textContent = 'ยังไม่ได้เปิดไมค์ · แนะนำหูฟังมีสาย (หูฟังบลูทูธ + ไมค์ บน iPhone เสียงเพลงจะเปลี่ยนเป็นแบบเสียงโทรศัพท์)';
$('micSel').onchange = () => startMic($('micSel').value);
$('bMic').onclick = () => { if (!micOn) startMic(pref.get('mic', '') || undefined); else $('sheet').hidden = false; };

// ---------- target helpers ----------
const rawAt = t => { const i = Math.round(t / HOP); return i >= 0 && i < P.length ? P[i] : null; };
function guideAt(t) {
  const v = rawAt(t); if (v != null) return v;
  const i = Math.round(t / HOP); let a = i, b = i;
  while (a > 0 && P[a] == null && i - a < 150) a--;
  while (b < P.length - 1 && P[b] == null && b - i < 150) b++;
  const pa = P[a], pb = P[b];
  if (pa == null && pb == null) return null; if (pa == null) return pb; if (pb == null) return pa;
  return pa + (pb - pa) * ((i - a) / (b - a));
}
const blockAt = t => { for (const b of B) { if (t >= b.t0 && t <= b.t1) return b; if (b.t0 > t) break; } return null; };
function fold(m, tg) { if (!$('oct').checked || tg == null) return m; while (m - tg > 6) m -= 12; while (tg - m > 6) m += 12; return m; }
// best match within ±0.12 s (forgives mic/headphone delay and slightly early/late entries)
function nearDiff(shown, t, sh) {
  const i0 = Math.round(t / HOP); let best = null;
  for (let k = -6; k <= 6; k++) { const v = P[i0 + k]; if (v == null) continue; const d = shown - (v + sh); if (best == null || Math.abs(d) < Math.abs(best)) best = d; }
  return best;
}
$('bReset').onclick = () => { HM.fill(0); B.forEach(b => { b.hit = 0; b.tot = 0; }); $('score').textContent = '–'; take = []; PH.forEach(p => { delete p.s; }); renderPhr(); $('sheet').hidden = true; };
$('bReport').onclick = () => { if (take.length > 30) report(true); else { openResult(); $('rSum').textContent = 'ยังร้องไม่พอจะวิเคราะห์ ลองร้องสัก 1 ท่อนก่อน'; $('rList').innerHTML = ''; } };

// ---------- report + save ----------
function openResult() { $('result').hidden = false; }
async function report(manual) {
  const F = take; if (!F.length) return;
  const byB = {}; F.forEach(f => { (byB[f.b] = byB[f.b] || []).push(f); });
  const n = F.length; let ok = 0, low = 0, high = 0, miss = 0, oct = 0;
  F.forEach(f => { if (f.d == null) miss++; else if (Math.abs(f.d) <= 0.6) ok++; else if (f.d < 0) low++; else high++; if (f.raw != null && f.raw < -9) oct++; });
  let late = 0, lateN = 0, tail = 0, tailN = 0, shaky = 0, shakyN = 0, jumpBad = 0, jumpN = 0, slide = 0, slideN = 0; const worst = {};
  Object.entries(byB).forEach(([bi, fs]) => {
    bi = +bi; const b = B[bi]; if (!b) return; const len = b.t1 - b.t0; if (fs.length < 4) return;
    const firstOk = fs.findIndex(f => f.d != null && Math.abs(f.d) <= 0.6);
    if (len >= 0.18) { lateN++; const lt = firstOk < 0 ? len : fs[firstOk].t - b.t0; if (lt > Math.min(0.25, len * 0.5)) { late++; (worst.late = worst.late || []).push(b.t0); } }
    if (len >= 0.4) {
      tailN++; const k = Math.floor(fs.length * 0.7); const end = fs.slice(k);
      if (end.filter(f => f.d == null).length > end.length * 0.6 && fs.slice(0, k).some(f => f.d != null)) { tail++; (worst.tail = worst.tail || []).push(b.t0); }
      const vs = fs.map(f => f.m).filter(v => v != null);
      if (vs.length > 8) { shakyN++; const mu = vs.reduce((a, c) => a + c, 0) / vs.length; const sd = Math.sqrt(vs.reduce((a, c) => a + (c - mu) ** 2, 0) / vs.length); if (sd > 0.45) { shaky++; (worst.shaky = worst.shaky || []).push(b.t0); } }
      const ds = fs.map(f => f.d).filter(v => v != null);
      if (ds.length > 8) { slideN++; const h = ds.slice(0, ds.length >> 2), r = ds.slice(ds.length >> 1); const a = h.reduce((x, y) => x + y, 0) / h.length, c = r.reduce((x, y) => x + y, 0) / r.length; if (Math.abs(a) > 0.8 && Math.abs(c) < 0.5) { slide++; (worst.slide = worst.slide || []).push(b.t0); } }
    }
    const prev = B[bi - 1];
    if (prev && b.t0 - prev.t1 < 0.4 && Math.abs(b.n - prev.n) >= 4) { jumpN++; const r = fs.filter(f => f.d != null && Math.abs(f.d) <= 0.6).length / fs.length; if (r < 0.4) { jumpBad++; (worst.jump = worst.jump || []).push(b.t0); } }
  });
  F.forEach(f => { if (f.d == null) (worst.miss = worst.miss || []).push(f.t); else if (f.d < -0.6) (worst.low = worst.low || []).push(f.t); else if (f.d > 0.6) (worst.high = worst.high || []).push(f.t); });
  const sc = Math.round(ok / n * 100), stab = shakyN ? Math.round((1 - shaky / shakyN) * 100) : null;
  const g = sc >= 85 ? 'S' : sc >= 70 ? 'A' : sc >= 55 ? 'B' : sc >= 40 ? 'C' : 'D';
  const t0 = F[0].t, t1 = F[F.length - 1].t;
  const M = [];
  if (oct > n * 0.35) M.push({ k: 'oct', v: oct / n, h: 'ร้องต่ำกว่าทำนองทั้งช่วงเสียง', p: 'คุณร้องต่ำกว่านักร้องประมาณ 1 ช่วงเสียง (12 คีย์) <b>ลองใช้เสียงหลบเบาๆ</b> แบบ "ฮู้~" หรือย้ายคีย์ลงในตั้งค่าก่อน แล้วค่อยขยับขึ้น' });
  if (low / n > 0.08) M.push({ k: 'low', v: low / n, h: 'ร้องต่ำไป (เพี้ยนลง)', p: '<b>ยกเสียงขึ้นนิดหนึ่ง</b> คิดว่าเสียงลอยขึ้นจากหน้าผาก อย่าดันจากคอ ร้องเบาลงจะขึ้นถึงง่ายกว่า มักเพี้ยนต่ำตอนลมใกล้หมด หายใจให้พอก่อนเข้าวลี' });
  if (high / n > 0.08) M.push({ k: 'high', v: high / n, h: 'ร้องสูงไป (เพี้ยนขึ้น)', p: '<b>ผ่อนเสียงลง</b> มักเกิดจากเกร็งหรือร้องดังเกิน ร้องเบาลงเหมือนพูดข้างหู และอย่าดันเสียงตามวรรณยุกต์ภาษาพูด' });
  if (miss / n > 0.15) M.push({ k: 'miss', v: miss / n, h: 'เงียบตอนที่ต้องร้อง', p: 'ช่วงนี้ไมค์ไม่ได้ยินเสียงคุณ อาจเข้าช้า จำเนื้อไม่ทัน หรือร้องเบาจนไมค์ไม่จับ <b>ฟังที่ความเร็ว 50% ให้จำเนื้อกับจังหวะก่อน</b> หรือเพิ่มความไวไมค์ในตั้งค่า' });
  if (lateN && late / lateN > 0.3) M.push({ k: 'late', v: late / lateN, h: 'เข้าโน้ตช้า / ไม่ตรงตั้งแต่ต้นคำ', p: 'คำเริ่มแล้วแต่เสียงคุณยังไม่ถึงโน้ต <b>ดูเส้นล่วงหน้า เตรียมโน้ตในหัวก่อนเปิดปาก</b> แล้วเปิดเสียงตรงโน้ตทันที ไม่ต้องไถขึ้นไปหา' });
  if (slideN && slide / slideN > 0.3) M.push({ k: 'slide', v: slide / slideN, h: 'ไถเสียงเข้าหาโน้ต', p: 'เริ่มคำผิดโน้ตแล้วค่อยไถไปหาโน้ตที่ถูก ถ้าใช้ Auto-Tune จะฟังเหน่อหรือกระตุก <b>เปลี่ยนโน้ตให้ชัดตรงๆ</b>' });
  if (tailN && tail / tailN > 0.3) M.push({ k: 'tail', v: tail / tailN, h: 'เสียงหายท้ายคำ', p: 'คำยาวๆ คุณหยุดเสียงก่อนนักร้องจบ <b>ลากสระให้ครบจนเส้นหมด</b> แล้วค่อยปล่อยลม หายใจเข้าให้พอก่อนวลียาว' });
  if (shakyN && shaky / shakyN > 0.3) M.push({ k: 'shaky', v: shaky / shakyN, h: 'เสียงไม่นิ่งตอนลากยาว', p: 'โน้ตยาวเสียงสั่นขึ้นลง <b>ใช้ลมนิ่งๆ จากท้อง</b> ฝึกเสียง "ซี่~" ยาว 15 วิ แล้วลากโน้ตตรงๆ ไม่ต้องใส่ลูกคอ' });
  if (jumpN && jumpBad / jumpN > 0.4) M.push({ k: 'jump', v: jumpBad / jumpN, h: 'กระโดดโน้ตไกลไม่ถึง', p: 'ตรงที่ทำนองกระโดดขึ้นลงหลายคีย์ คุณไปไม่ถึง <b>ฮัมเฉพาะ 2 โน้ตนั้นสลับกันช้าๆ</b> เปิดวนท่อนที่ความเร็ว 50%' });
  M.sort((a, b) => b.v - a.v);
  // per-phrase scores
  const phr = {};
  PH.forEach((p, i) => { const fs = F.filter(f => f.t >= p[0] - 0.2 && f.t <= p[1] + 0.2); if (fs.length > 40) { const s = Math.round(fs.filter(f => f.d != null && Math.abs(f.d) <= 0.6).length / fs.length * 100); phr[i] = s; p.s = s; } });
  renderPhr();
  // save
  let best = S.best;
  if (F.length >= 300) {
    const sess = { songId: S.id, at: Date.now(), score: sc, stab, grade: g, t0, t1, speed: +$('speed').value, top: M.slice(0, 3).map(x => x.k), phr };
    try {
      await DB.addSession(sess);
      S.plays = (S.plays || 0) + 1; S.lastAt = sess.at; if (best == null || sc > best) best = S.best = sc;
      await DB.putSong(S);
    } catch (e) {}
  }
  // render
  $('rGrade').textContent = g; $('rScore').textContent = sc + '%';
  const col = sc >= 70 ? 'var(--hit)' : sc >= 45 ? 'var(--warn)' : 'var(--ball)';
  $('ringFg').style.stroke = col; $('rGrade').style.color = col;
  $('ringFg').style.strokeDashoffset = 327; requestAnimationFrame(() => requestAnimationFrame(() => { $('ringFg').style.strokeDashoffset = 327 * (1 - sc / 100); }));
  $('rStable').textContent = stab == null ? '–' : stab + '%';
  $('rTime').textContent = fmt(t0) + '–' + fmt(t1);
  $('rBest').textContent = best == null ? '–' : best + '%';
  $('rSum').textContent = (F.length < 300 ? '(ร้องสั้นไป รอบนี้ไม่บันทึกลงประวัติ) ' : '') + (sc >= 85 ? 'เยี่ยมมาก ร้องตรงเกือบทั้งช่วง ลองความเร็ว 100% หรือฟังทำนองนำให้น้อยลง' : sc >= 60 ? 'ดีแล้ว เหลือเก็บรายละเอียดตามด้านล่าง' : sc >= 40 ? 'เริ่มจับทำนองได้แล้ว แก้ข้อแรกด้านล่างก่อน แล้วร้องท่อนนี้ซ้ำ' : 'ลองลดความเร็วเป็น 50% และเลือก "เพลง + ทำนองนำ" ฟังก่อน แล้วค่อยร้องตาม');
  const L = $('rList'); L.innerHTML = '';
  if (!M.length) L.innerHTML = '<div class="mi"><div class="rk">✓</div><div><h4>ไม่มีจุดพลาดเด่นๆ</h4><p>ลองเร่งความเร็ว หรือฝึกท่อนอื่นต่อ</p></div><div></div></div>';
  M.slice(0, 3).forEach((x, i) => {
    const ts = worst[x.k] || []; let at = null;
    if (ts.length) { const bins = {}; ts.forEach(s => { const k = Math.floor(s / 2); bins[k] = (bins[k] || 0) + 1; }); at = +Object.entries(bins).sort((a, b) => b[1] - a[1])[0][0] * 2; }
    const d = document.createElement('div'); d.className = 'mi';
    d.innerHTML = '<div class="rk">' + (i + 1) + '</div><div><h4>' + x.h + '</h4><p>' + x.p + '</p>' + (at != null ? '<button class="btn">▶ ไปฝึกตรงที่พลาดบ่อย (' + fmt(at) + ')</button>' : '') + '</div><div class="pct">' + Math.round(x.v * 100) + '%</div>';
    const bt = d.querySelector('button');
    if (bt) bt.onclick = () => { $('result').hidden = true; curPh = phAt(at); markPh(); seek(Math.max(0, at - 1.5)); loopOn = true; $('bLoop').setAttribute('aria-pressed', 'true'); $('speed').value = '0.5'; pref.set('speed', '0.5'); applyAudio(); if (!playing) play(); };
    L.appendChild(d);
  });
  openResult();
}
$('rAgain').onclick = () => { $('result').hidden = true; if (curPh != null) seek(Math.max(0, PH[curPh][0] - 1.5)); else seek(0); play(); };
$('rHist').onclick = () => { $('result').hidden = true; pause(true); pref.set('histSong', S ? S.id : ''); show('vHist'); };

// ---------- main loop ----------
const trail = [], parts = []; let lastCue = '';
function cue(a, s, sub, cls) { const k = a + s + sub + cls; if (k === lastCue) return; lastCue = k; $('arrow').textContent = a; $('arrow').className = 'arrow ' + cls; $('say').innerHTML = s + '<small>' + (sub || '&nbsp;') + '</small>'; }
function step() {
  if (view !== 'vSing' || !S) return;
  const now = performance.now() / 1000, t = clock();
  if (loopOn && curPh != null && playing && PH[curPh]) { const p = PH[curPh]; if (t > p[1] + 0.8) { if (take.length > 90) report(); take = []; el.currentTime = Math.max(0, p[0] - 1.5); } }
  $('seek').value = t; $('time').textContent = fmt(t) + ' / ' + fmt(DUR);
  const c = $('count'); if (countdown && performance.now() < countdown) { c.hidden = false; c.textContent = Math.ceil((countdown - performance.now()) / 500); } else c.hidden = true;
  let you = null;
  if (micOn && an) {
    an.getFloatTimeDomainData(buf);
    let r = 0; for (let i = 0; i < buf.length; i += 4) r += buf[i] * buf[i]; r = Math.sqrt(r / (buf.length / 4));
    const pc = Math.min(100, Math.round(Math.sqrt(r) * 260)); $('lvl').style.width = pc + '%';
    $('lvlTxt').textContent = pc < 8 ? 'ไมค์ไม่ค่อยได้ยิน ลองร้องดังขึ้น หรือเพิ่มความไวในตั้งค่า ⚙' : pc > 92 ? 'เสียงดังเกิน ลองลดความไวไมค์' : 'ไมค์ได้ยินเสียงคุณ ✓';
    const pd = mpm(buf, ctx.sampleRate, 0.004);
    you = track(pd ? 69 + 12 * Math.log2(pd.f / 440) : null, pd ? pd.c : 0);
  }
  const sh = SH(), g = guideAt(t), gs = g == null ? null : g + sh, blk = blockAt(t), rv = rawAt(t), tg = rv != null ? rv + sh : null, shown = you != null ? fold(you, gs) : null;
  const near = shown != null && tg != null ? nearDiff(shown, t, sh) : null;
  const ok = near != null && Math.abs(near) <= 0.6;
  const gm = $('guide').value;
  if (og) { const on = playing && gm !== 'mix' && rv != null && !countdown; og.gain.setTargetAtTime(on ? (gm === 'tone' ? 0.16 : 0.1) : 0, ctx.currentTime, 0.02); if (gs != null) osc.frequency.setTargetAtTime(440 * Math.pow(2, (gs - 69) / 12), ctx.currentTime, 0.01); }
  if (playing && !countdown && tg != null) { const ix = Math.round(t / HOP); const v = ok ? 2 : 1; if (lastIdx >= 0 && ix > lastIdx && ix - lastIdx < 10) { for (let k = lastIdx + 1; k <= ix; k++) if (P[k] != null) HM[k] = Math.max(HM[k], v); } else HM[ix] = Math.max(HM[ix], v); lastIdx = ix; } else lastIdx = -1;
  trail.push({ now, m: shown, ok }); while (trail.length && now - trail[0].now > 1.6) trail.shift();
  $('youN').textContent = you != null ? nn(you) : '–'; $('tgN').textContent = tg != null ? nn(tg) : (gs != null ? nn(gs) : '–');
  if (playing && performance.now() >= countdown) {
    countdown = 0;
    if (blk && tg != null) {
      blk.tot++; if (ok) blk.hit++;
      take.push({ t, b: B.indexOf(blk), d: near, raw: you == null ? null : you - tg, m: shown });
      if (shown == null) cue('•', 'ร้องเลย!', 'ตอนนี้ต้องร้อง ' + nn(tg), '');
      else { const d = near; if (Math.abs(d) <= 0.6) cue('✓', 'ตรงแล้ว', '', 'ok'); else if (d < 0) cue('⬆', 'ร้องสูงขึ้น', Math.round(-d) >= 1 ? 'อีกประมาณ ' + Math.round(-d) + ' คีย์' : 'อีกนิดเดียว', 'up'); else cue('⬇', 'ร้องต่ำลง', Math.round(d) >= 1 ? 'อีกประมาณ ' + Math.round(d) + ' คีย์' : 'อีกนิดเดียว', 'down'); }
    } else cue('•', 'พักหายใจ', gs != null ? 'โน้ตถัดไป ' + nn(gs) : '', '');
    let h = 0, n = 0; B.forEach(b => { h += b.hit; n += b.tot; }); if (n > 30) $('score').textContent = Math.round(h / n * 100) + '%';
  } else if (!playing) cue('•', micOn ? 'กด ▶ เพื่อเริ่ม' : 'กด 🎤 เปิดไมค์ แล้วกด ▶', micOn && you != null ? 'ได้ยินเสียงคุณแล้ว' : '', '');
  resizeCanvas();
  draw(t, gs, shown, ok);
  requestAnimationFrame(step);
}

// ---------- drawing ----------
const cv = $('cv'), G = cv.getContext('2d');
function resizeCanvas() {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const w = Math.max(300, Math.round(cv.clientWidth * dpr)), h = Math.max(200, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}
addEventListener('resize', () => { if (view === 'vSing') resizeCanvas(); });
function draw(t, gs, shown, ok) {
  const W = cv.width, H = cv.height, k = H / 840, narrow = cv.clientWidth < 600, AHEAD = narrow ? 3 : 4;
  const NOW = W * 0.27, PX = W * 0.73 / AHEAD, sh = SH();
  const center = gs != null ? gs : 58 + sh; window._c = (window._c ?? center) + (center - (window._c ?? center)) * 0.03;
  const span = narrow ? 16 : 20;
  const lo = Math.round(window._c) - span / 2, hi = lo + span, y = m => 40 * k + (H - 80 * k) * (1 - (m - lo) / (hi - lo)), rowH = (H - 80 * k) / (hi - lo);
  G.clearRect(0, 0, W, H);
  G.font = (24 * k) + 'px "IBM Plex Mono",monospace';
  for (let m = lo; m <= hi; m++) { if (NAMES[((m % 12) + 12) % 12].length === 1) { G.fillStyle = 'rgba(255,255,255,.04)'; G.fillRect(0, y(m) - k, W, 2 * k); G.fillStyle = 'rgba(255,255,255,.28)'; G.fillText(nn(m), W - 80 * k, y(m) + 8 * k); } }
  const gr = G.createLinearGradient(NOW - W * 0.12, 0, NOW, 0); gr.addColorStop(0, 'rgba(255,90,90,0)'); gr.addColorStop(1, 'rgba(255,90,110,.28)'); G.fillStyle = gr; G.fillRect(NOW - W * 0.12, 0, W * 0.12, H);
  G.fillStyle = 'rgba(255,255,255,.55)'; G.fillRect(NOW - 2 * k, 0, 4 * k, H);
  const X = s => NOW + (s - t) * PX, bh = Math.max(12 * k, rowH * 0.34);
  G.lineCap = 'round'; G.lineJoin = 'round';
  const s0 = Math.max(0, Math.floor((t - NOW / PX - 0.2) / HOP)), s1 = Math.min(P.length - 1, Math.ceil((t + AHEAD + 0.1) / HOP));
  const seg = (colFn, w, blur) => {
    let run = null;
    const flush = () => { if (run && run.pts.length > 1) { G.save(); G.strokeStyle = run.c; G.lineWidth = w; if (blur) { G.shadowColor = run.c; G.shadowBlur = blur; } G.beginPath(); run.pts.forEach((q, i) => i ? G.lineTo(q[0], q[1]) : G.moveTo(q[0], q[1])); G.stroke(); G.restore(); } run = null; };
    for (let i = s0; i <= s1; i++) { const v = P[i]; if (v == null) { flush(); continue; } const c = colFn(i); const pt = [X(i * HOP), y(v + sh)]; if (!run || run.c !== c) { const last = run ? run.pts[run.pts.length - 1] : null; flush(); run = { c, pts: last ? [last, pt] : [pt] }; } else run.pts.push(pt); }
    flush();
  };
  seg(i => { const s = i * HOP; if (s > t) return 'rgba(255,255,255,.72)'; return HM[i] === 2 ? 'rgba(255,205,110,.95)' : HM[i] === 1 ? 'rgba(255,130,150,.6)' : 'rgba(255,255,255,.5)'; }, bh, 0);
  seg(i => { const s = i * HOP; return (s <= t && HM[i] === 2) ? 'rgba(255,205,110,.9)' : 'rgba(0,0,0,0)'; }, bh * 0.5, 22 * k);
  { const r = rawAt(t); if (r != null) { const ty = y(r + sh), q = bh * 0.9; G.save(); G.strokeStyle = 'rgba(255,255,255,.95)'; G.lineWidth = 4 * k; G.shadowColor = '#fff'; G.shadowBlur = 16 * k; G.beginPath(); G.moveTo(NOW, ty - q); G.lineTo(NOW + q, ty); G.lineTo(NOW, ty + q); G.lineTo(NOW - q, ty); G.closePath(); G.stroke(); G.restore(); } }
  G.font = 'bold ' + (20 * k) + 'px "IBM Plex Mono",monospace'; G.fillStyle = 'rgba(255,255,255,.7)';
  for (const b of B) { if (b.t0 > t + AHEAD) break; if (b.t1 - b.t0 < 0.3 || b.t1 < t) continue; const x0 = X(b.t0); if (x0 < NOW - 20 * k || x0 > W - 100 * k) continue; G.fillText(nn(b.n + sh), x0, y(b.n + sh) - bh / 2 - 10 * k); }
  const now = performance.now() / 1000, rate = +$('speed').value, sing = shown != null;
  if (sing) window._lastBall = shown; const lb = window._lastBall;
  const by = sing ? Math.max(16 * k, Math.min(H - 16 * k, y(shown))) : (lb != null ? Math.max(16 * k, Math.min(H - 16 * k, y(lb))) : null);
  let prev = null;
  trail.forEach(p => { if (p.m == null) { prev = null; return; } const xx = NOW - (now - p.now) * PX * rate, yy = y(p.m); if (prev) { const a = Math.max(0, 1 - (now - p.now) / 1.4); G.strokeStyle = p.ok ? `rgba(255,200,110,${a})` : `rgba(255,120,140,${a * .8})`; G.lineWidth = (8 * a + 2) * k; G.beginPath(); G.moveTo(prev[0], prev[1]); G.lineTo(xx, yy); G.stroke(); } prev = [xx, yy]; });
  if (by != null) {
    if (sing) { G.save(); const st = G.createLinearGradient(NOW - 160 * k, 0, NOW, 0); st.addColorStop(0, 'rgba(255,170,90,0)'); st.addColorStop(1, ok ? 'rgba(255,200,110,.9)' : 'rgba(255,120,140,.7)'); G.fillStyle = st; G.fillRect(NOW - 160 * k, by - 5 * k, 160 * k, 10 * k); G.restore(); }
    G.save(); G.shadowColor = sing ? (ok ? '#ffd27a' : '#ff7a90') : '#ffffff'; G.shadowBlur = sing ? 40 * k : 0; G.fillStyle = sing ? '#ffffff' : 'rgba(255,255,255,.18)';
    G.beginPath(); G.arc(NOW, by, (sing ? 24 : 16) * k, 0, 7); G.fill(); G.restore();
    if (!sing) { G.strokeStyle = 'rgba(255,255,255,.35)'; G.lineWidth = 2 * k; G.beginPath(); G.arc(NOW, by, 20 * k, 0, 7); G.stroke(); }
  }
  if (ok && by != null && Math.random() < 0.25) parts.push({ x: NOW - 20 * k, y: by, vx: -(60 + Math.random() * 80) * k, vy: -(80 + Math.random() * 90) * k, life: 1, g: Math.random() < .5 ? '♪' : '♫', s: (28 + Math.random() * 16) * k });
  const dt = 1 / 60; G.textAlign = 'center';
  for (let i = parts.length - 1; i >= 0; i--) { const q = parts[i]; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt * 0.9; if (q.life <= 0) { parts.splice(i, 1); continue; } G.globalAlpha = q.life; G.fillStyle = '#fff'; G.font = q.s + 'px serif'; G.fillText(q.g, q.x, q.y); }
  G.globalAlpha = 1; G.textAlign = 'start';
}

// ---------- history ----------
async function renderHist() {
  let songs = [];
  try { songs = await DB.songs(); } catch (e) {}
  const sel = $('hSong'); const want = pref.get('histSong', '');
  sel.innerHTML = songs.length ? '' : '<option value="">ยังไม่มีเพลง</option>';
  songs.forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.title + (s.artist ? ' – ' + s.artist : ''); sel.appendChild(o); });
  if (want && songs.some(s => s.id === want)) sel.value = want;
  sel.onchange = () => { pref.set('histSong', sel.value); renderHistSong(); };
  renderHistSong();
}
async function renderHistSong() {
  const id = $('hSong').value;
  const rec = id ? await DB.song(id) : null;
  const ss = id ? (await DB.sessions(id)).sort((a, b) => a.at - b.at) : [];
  const last5 = ss.slice(-5), avg = last5.length ? Math.round(last5.reduce((a, s) => a + s.score, 0) / last5.length) : null;
  const first = ss.length ? ss[0].score : null, best = ss.length ? Math.max(...ss.map(s => s.score)) : null;
  const mins = Math.round(ss.reduce((a, s) => a + Math.max(0, s.t1 - s.t0) / (s.speed || 1), 0) / 60);
  $('hStats').innerHTML = [
    ['ร้องไปแล้ว', ss.length + ' ครั้ง'], ['คะแนนดีสุด', best == null ? '–' : best + '%'], ['เฉลี่ย 5 ครั้งล่าสุด', avg == null ? '–' : avg + '%'],
    ['พัฒนาขึ้น', first == null || ss.length < 2 ? '–' : ((avg - first >= 0 ? '+' : '') + (avg - first) + '%')], ['เวลาฝึกรวม', mins + ' นาที']
  ].map(x => `<div class="stat"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('');
  drawChart(ss);
  $('hChartNote').textContent = ss.length ? 'เส้นประ = คะแนนดีสุด · จุดเขียว ≥70% · ส้ม 45–69% · แดง <45%' : 'ยังไม่มีประวัติ ร้องเพลงนี้สักรอบ (อย่างน้อย 5 วินาที) แล้วกลับมาดู';
  // phrase heat
  const box = $('hPhr'); box.innerHTML = '';
  if (rec) {
    buildModelLite(rec);
    const agg = {};
    ss.slice(-10).forEach(s => { Object.entries(s.phr || {}).forEach(([i, v]) => { (agg[i] = agg[i] || []).push(v); }); });
    const items = PHL.map((p, i) => { const a = agg[i]; return { i, p, v: a ? Math.round(a.slice(-3).reduce((x, y) => x + y, 0) / a.slice(-3).length) : null }; });
    items.forEach(o => { const sp = document.createElement('span'); const c = o.v == null ? ['var(--bg2)', 'var(--muted)'] : o.v >= 70 ? ['rgba(67,217,145,.18)', 'var(--hit)'] : o.v >= 45 ? ['rgba(255,181,71,.16)', 'var(--warn)'] : ['rgba(255,93,125,.18)', 'var(--ball)']; sp.style.background = c[0]; sp.style.color = c[1]; sp.textContent = 'ท่อน ' + (o.i + 1) + ' ' + fmt(o.p[0]) + ' · ' + (o.v == null ? 'ยังไม่ร้อง' : o.v + '%'); box.appendChild(sp); });
  }
  // list
  const KN = { oct: 'ต่ำกว่าทั้งช่วงเสียง', low: 'ร้องต่ำไป', high: 'ร้องสูงไป', miss: 'เงียบตอนต้องร้อง', late: 'เข้าโน้ตช้า', slide: 'ไถเสียง', tail: 'เสียงหายท้ายคำ', shaky: 'เสียงไม่นิ่ง', jump: 'กระโดดโน้ตไม่ถึง' };
  $('hList').innerHTML = ss.slice(-15).reverse().map(s => {
    const col = s.score >= 70 ? 'var(--hit)' : s.score >= 45 ? 'var(--warn)' : 'var(--ball)';
    const d = new Date(s.at);
    return `<div class="hrow"><div class="g" style="color:${col}">${s.grade}</div><div><b>${d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</b><br><small>${fmt(s.t0)}–${fmt(s.t1)} · ความเร็ว ${Math.round((s.speed || 1) * 100)}%${s.top && s.top.length ? ' · พลาด: ' + KN[s.top[0]] : ''}</small></div><div class="s" style="color:${col}">${s.score}%</div></div>`;
  }).join('') || '<p class="muted">ยังไม่มีประวัติ</p>';
}
let PHL = [];
function buildModelLite(rec) { const keep = [P, B, PH, HM, DUR]; buildModel(rec); PHL = PH; [P, B, PH, HM, DUR] = keep; }
function drawChart(ss) {
  const c = $('hChart'), dpr = Math.min(2.5, window.devicePixelRatio || 1);
  c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr);
  const g = c.getContext('2d'), W = c.width, H = c.height, k = dpr;
  g.clearRect(0, 0, W, H);
  const L = 36 * k, R = 12 * k, T = 12 * k, Bt = 24 * k, y = v => T + (H - T - Bt) * (1 - v / 100);
  g.font = (11 * k) + 'px "IBM Plex Mono",monospace'; g.fillStyle = 'rgba(255,255,255,.45)'; g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = k;
  [0, 25, 50, 75, 100].forEach(v => { g.beginPath(); g.moveTo(L, y(v)); g.lineTo(W - R, y(v)); g.stroke(); g.fillText(v + '%', 4 * k, y(v) + 4 * k); });
  const pts = ss.slice(-40); if (!pts.length) return;
  const x = i => pts.length === 1 ? (L + W - R) / 2 : L + (W - L - R) * i / (pts.length - 1);
  const best = Math.max(...pts.map(s => s.score));
  g.setLineDash([6 * k, 6 * k]); g.strokeStyle = 'rgba(255,207,115,.6)'; g.beginPath(); g.moveTo(L, y(best)); g.lineTo(W - R, y(best)); g.stroke(); g.setLineDash([]);
  const grd = g.createLinearGradient(0, T, 0, H - Bt); grd.addColorStop(0, 'rgba(169,140,240,.35)'); grd.addColorStop(1, 'rgba(169,140,240,0)');
  g.beginPath(); pts.forEach((s, i) => i ? g.lineTo(x(i), y(s.score)) : g.moveTo(x(i), y(s.score))); g.lineTo(x(pts.length - 1), H - Bt); g.lineTo(x(0), H - Bt); g.closePath(); g.fillStyle = grd; g.fill();
  g.beginPath(); pts.forEach((s, i) => i ? g.lineTo(x(i), y(s.score)) : g.moveTo(x(i), y(s.score))); g.strokeStyle = '#a98cf0'; g.lineWidth = 2.5 * k; g.stroke();
  pts.forEach((s, i) => { g.beginPath(); g.arc(x(i), y(s.score), 4.5 * k, 0, 7); g.fillStyle = s.score >= 70 ? '#43d991' : s.score >= 45 ? '#ffb547' : '#ff5d7d'; g.fill(); });
  g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText('ครั้งแรก', L, H - 6 * k); const tl = 'ล่าสุด'; g.fillText(tl, W - R - g.measureText(tl).width, H - 6 * k);
}

// ---------- boot ----------
show('vLib');
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
