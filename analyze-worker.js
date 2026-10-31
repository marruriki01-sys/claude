// Melody (vocal) pitch extraction with Essentia.js PredominantPitchMelodia, in chunks so it fits phone memory.
var exports = {};
importScripts('vendor/essentia-wasm.umd.js', 'vendor/essentia.js-core.umd.js');
var ess = null;
function ready() {
  if (ess) return true;
  try { ess = new Essentia(exports.EssentiaWASM); return true; } catch (e) { return false; }
}
function melodia(x) {
  var v = ess.arrayToVector(x);
  // signal, binResolution, filterIterations, frameSize, guessUnvoiced, harmonicWeight, hopSize, magnitudeCompression,
  // magnitudeThreshold, maxFrequency, minDuration, minFrequency, numberHarmonics, peakDistributionThreshold,
  // peakFrameThreshold, pitchContinuity, referenceFrequency, sampleRate, timeContinuity, voiceVibrato, voicingTolerance
  var r = ess.PredominantPitchMelodia(v, 10, 3, 1024, false, 0.8, 128, 1, 40, 900, 100, 110, 20, 0.9, 0.9, 27.5625, 55, 16000, 100, false, 0.2);
  var p = ess.vectorToArray(r.pitch);
  try { v.delete(); r.pitch.delete(); r.pitchConfidence.delete(); } catch (e) {}
  return p;
}
onmessage = function (e) {
  var x = e.data.x, SR = 16000, HOP = 128, CH = 30 * SR, OV = 2 * SR;
  var tries = 0;
  (function go() {
    if (!ready()) { if (++tries > 100) { postMessage({ err: 'โหลดตัววิเคราะห์เสียงไม่สำเร็จ' }); return; } setTimeout(go, 100); return; }
    try {
      var nF = Math.floor(x.length / HOP) + 1, out = new Float32Array(nF);
      for (var s = 0; s < x.length; s += CH) {
        var a = Math.max(0, s - OV), b = Math.min(x.length, s + CH + OV);
        var p = melodia(x.subarray(a, b));
        var f0 = Math.floor(s / HOP), f1 = Math.min(nF, Math.floor(Math.min(x.length, s + CH) / HOP)), off = Math.floor(a / HOP);
        for (var f = f0; f < f1; f++) out[f] = p[f - off] || 0;
        postMessage({ prog: Math.min(1, (s + CH) / x.length) });
      }
      postMessage({ p: out }, [out.buffer]);
    } catch (err) {
      postMessage({ err: 'วิเคราะห์เสียงไม่สำเร็จ (' + err + ')' });
    }
  })();
};
