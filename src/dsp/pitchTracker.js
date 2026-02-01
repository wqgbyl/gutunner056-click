// 轻量 pitch tracker（YIN-ish / autocorr hybrid）
// 目标：人声/双簧管可用的实时音高估计（不是完美，但能跑）
//
// 你后续可以把你项目里成熟的“换音确认、合并、MIN_SCORE_MS”等逻辑替换到这里，
// 但外部接口保持：pushFrame(frame)-> {freqHz, noteName, cents}

import { freqToNote } from "./pitchUtils.js";

export class PitchTracker {
  constructor({ sampleRate, minFreq = 70, maxFreq = 1600 } = {}) {
    this.sampleRate = sampleRate;
    this.minFreq = minFreq;
    this.maxFreq = maxFreq;
    this._last = null;
  }

  pushFrame(frame) {
    const freq = estimateF0_YINlite(frame, this.sampleRate, this.minFreq, this.maxFreq);
    if (!freq) return null;

    const { noteName, cents } = freqToNote(freq);
    this._last = { freqHz: freq, noteName, cents };
    return this._last;
  }

  get last() { return this._last; }
}

// --- DSP ---

function estimateF0_YINlite(frame, sr, minFreq, maxFreq) {
  // 能量门限：太小就返回 null
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  if (rms < 0.01) return null;

  const n = frame.length;
  const minLag = Math.floor(sr / maxFreq);
  const maxLag = Math.floor(sr / minFreq);

  // 差分函数 d(tau)
  const d = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i + tau < n; i++) {
      const diff = frame[i] - frame[i + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }

  // 累积均值归一化差分函数 CMND
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    running += d[tau];
    cmnd[tau] = d[tau] * tau / (running + 1e-12);
  }

  // 找第一个低于阈值的 tau
  const threshold = 0.12;
  let tau0 = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < threshold) {
      // 在邻域内找更小点
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++;
      tau0 = tau;
      break;
    }
  }
  if (tau0 < 0) return null;

  // 抛物线插值提高精度
  const betterTau = parabolicInterp(cmnd, tau0);
  const f0 = sr / betterTau;

  if (!isFinite(f0) || f0 < minFreq || f0 > maxFreq) return null;
  return f0;
}

function parabolicInterp(arr, i) {
  const x0 = i - 1, x1 = i, x2 = i + 1;
  if (x0 < 0 || x2 >= arr.length) return i;
  const y0 = arr[x0], y1 = arr[x1], y2 = arr[x2];
  const denom = (y0 - 2*y1 + y2);
  if (Math.abs(denom) < 1e-12) return i;
  const delta = 0.5 * (y0 - y2) / denom;
  return i + delta;
}
