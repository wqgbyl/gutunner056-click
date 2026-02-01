// TempoTracker：输入 time-domain frame（固定 frameSize，固定 hop）
// 输出：四分音符 BPM（♩=BPM） + confidence
// novelty = 0.7*SpectralFlux + 0.3*RMSDiff

import { magnitudeSpectrumFromTimeDomain } from "./fft.js";

export class TempoTracker {
  constructor({ sampleRate, frameSize = 1024, hopSize = 480 } = {}) {
    this.sampleRate = sampleRate;
    this.frameSize = frameSize;
    this.hopSize = hopSize;
    this.hopSeconds = hopSize / sampleRate;

    this._prevRms = 0;
    this._prevMag = null;
    this._noveltyPairs = []; // {flux, rmsDiff}
  }

  pushFrame(frame) {
    // RMS diff
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const rmsDiff = Math.max(0, rms - this._prevRms);
    this._prevRms = rms;

    // spectral flux
    const mag = magnitudeSpectrumFromTimeDomain(frame);
    let flux = 0;
    if (!this._prevMag) {
      this._prevMag = new Float32Array(mag.length);
      this._prevMag.set(mag);
    } else {
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - this._prevMag[i];
        if (d > 0) flux += d;
        this._prevMag[i] = mag[i];
      }
    }

    this._noveltyPairs.push({ flux, rmsDiff });
  }

  finalize({ minBPM = 40, maxBPM = 200 } = {}) {
    // 经验：>=8s 更靠谱；这里至少 3s 才输出
    if (this._noveltyPairs.length * this.hopSeconds < 3) {
      return { bpm: null, confidence: 0 };
    }

    // normalize
    let maxFlux = 1e-12, maxRms = 1e-12;
    for (const x of this._noveltyPairs) {
      if (x.flux > maxFlux) maxFlux = x.flux;
      if (x.rmsDiff > maxRms) maxRms = x.rmsDiff;
    }

    const v = new Float32Array(this._noveltyPairs.length);
    for (let i = 0; i < this._noveltyPairs.length; i++) {
      const fluxN = this._noveltyPairs[i].flux / maxFlux;
      const rmsN  = this._noveltyPairs[i].rmsDiff / maxRms;
      v[i] = 0.7 * fluxN + 0.3 * rmsN;
    }

    // smooth (moving average 5)
    const sm = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) {
      let acc = 0, cnt = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j >= 0 && j < v.length) { acc += v[j]; cnt++; }
      }
      sm[i] = acc / cnt;
    }

    // ACF over lag range
    const hop = this.hopSeconds;
    const minLag = Math.floor((60 / maxBPM) / hop);
    const maxLag = Math.floor((60 / minBPM) / hop);

    const acf = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < sm.length; i++) s += sm[i] * sm[i + lag];
      acf[lag] = s;
    }

    // peak picking
    const peaks = [];
    for (let lag = minLag + 1; lag < maxLag - 1; lag++) {
      if (acf[lag] > acf[lag-1] && acf[lag] > acf[lag+1]) {
        peaks.push({ lag, val: acf[lag] });
      }
    }
    peaks.sort((a, b) => b.val - a.val);
    const top = peaks.slice(0, 8);
    if (!top.length) return { bpm: null, confidence: 0 };

    const fold = (bpm) => {
      while (bpm > maxBPM) bpm *= 0.5;
      while (bpm < minBPM) bpm *= 2.0;
      return bpm;
    };

    const cands = top.map(p => {
      const periodSec = p.lag * hop;
      const bpm = fold(60 / periodSec);
      return { bpm, strength: p.val };
    });

    // merge close BPMs
    cands.sort((a, b) => a.bpm - b.bpm);
    const merged = [];
    const tol = 2.5;
    for (const c of cands) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.bpm - c.bpm) < tol) {
        const w1 = last.strength, w2 = c.strength;
        last.bpm = (last.bpm * w1 + c.bpm * w2) / (w1 + w2);
        last.strength += c.strength;
      } else merged.push({ ...c });
    }
    merged.sort((a, b) => b.strength - a.strength);

    const best = merged[0];
    const conf = best.strength / (merged.reduce((s, x) => s + x.strength, 1e-9));
    return { bpm: Math.round(best.bpm), confidence: conf };
  }

  reset() {
    this._prevRms = 0;
    this._prevMag = null;
    this._noveltyPairs.length = 0;
  }
}
