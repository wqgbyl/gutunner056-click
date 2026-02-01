import { PitchTracker } from "./dsp/pitchTracker.js";
import { TempoTracker } from "./dsp/tempoTracker.js";
import { createClickBuffer, scheduleMetronome } from "./audio/metronome.js";

const $ = (id) => document.getElementById(id);

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const statusEl = $("status");

const noteNameEl = $("noteName");
const freqHzEl = $("freqHz");
const centsEl = $("cents");
const tempoEl = $("tempo");
const tempoConfEl = $("tempoConf");
const durEl = $("dur");
const beatOffsetEl = $("beatOffset");

const btnPlay = $("btnPlay");
const btnStopPlay = $("btnStopPlay");

const metOnEl = $("metOn");
const metGainEl = $("metGain");
const metGainValEl = $("metGainVal");

metGainEl.addEventListener("input", () => {
  metGainValEl.textContent = Number(metGainEl.value).toFixed(2);
});

let audioCtx = null;
let micStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let decodedAudioBuffer = null;

let workletNode = null;

// analysis config
const frameSize = 1024;
let hopSize = 480; // will be updated after ctx created (based on sampleRate)
let hopMs = 10;

let pitchTracker = null;
let tempoTracker = null;

let analysisTimer = null;

// Queue for PCM from worklet
class PCMQueue {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.length = 0;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }
  // pop n samples -> Float32Array
  pop(n) {
    if (this.length < n) return null;
    const out = new Float32Array(n);
    let written = 0;
    while (written < n) {
      const head = this.chunks[0];
      const avail = head.length - this.offset;
      const take = Math.min(avail, n - written);
      out.set(head.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      this.length -= take;
      if (this.offset >= head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return out;
  }
  // read n samples without consuming: for initialization only (not used)
  available() { return this.length; }
  reset() { this.chunks = []; this.offset = 0; this.length = 0; }
}

const pcmQueue = new PCMQueue();

// rolling frame buffer
let rollingFrame = new Float32Array(frameSize);
let rollingInited = false;

let tempoState = {
  bpm: null,
  confidence: 0,
  beatOffsetSec: 0,
};

let playback = {
  source: null,
  schedulerStop: null,
};

btnStart.addEventListener("click", startRecording);
btnStop.addEventListener("click", stopRecording);
btnPlay.addEventListener("click", play);
btnStopPlay.addEventListener("click", stopPlayback);

async function ensureAudioContext() {
  if (audioCtx) return audioCtx;
  audioCtx = new AudioContext({ latencyHint: "interactive" });
  await audioCtx.audioWorklet.addModule("./src/audio/audio-worklet-processor.js");
  return audioCtx;
}

async function startRecording() {
  btnStart.disabled = true;
  btnStop.disabled = false;
  btnPlay.disabled = true;
  btnStopPlay.disabled = true;

  tempoEl.textContent = "♩=—";
  tempoConfEl.textContent = "—";
  beatOffsetEl.textContent = "—";
  durEl.textContent = "—";

  setStatus("请求麦克风权限…");

  const ctx = await ensureAudioContext();
  await ctx.resume();

  // hop config derived from sampleRate
  hopSize = Math.max(240, Math.round(ctx.sampleRate * 0.01)); // ~10ms
  hopMs = (hopSize / ctx.sampleRate) * 1000;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.start();

  // graph: mic -> worklet -> mute -> destination (avoid feedback)
  const src = ctx.createMediaStreamSource(micStream);
  const mute = ctx.createGain();
  mute.gain.value = 0;

  workletNode = new AudioWorkletNode(ctx, "pcm-grabber");
  src.connect(workletNode).connect(mute).connect(ctx.destination);

  // reset buffers
  pcmQueue.reset();
  rollingFrame = new Float32Array(frameSize);
  rollingInited = false;

  // trackers
  pitchTracker = new PitchTracker({ sampleRate: ctx.sampleRate });
  tempoTracker = new TempoTracker({ sampleRate: ctx.sampleRate, frameSize, hopSize });

  workletNode.port.onmessage = (e) => {
    if (e.data?.type === "pcm") {
      const pcm = e.data.pcm;
      pcmQueue.push(pcm);
    }
  };

  setStatus("录音中…（分析中）");

  // analysis loop: exact hop stepping
  if (analysisTimer) clearInterval(analysisTimer);
  analysisTimer = setInterval(analysisHopTick, hopMs);
}

function analysisHopTick() {
  if (!workletNode) return;

  // init: need frameSize samples first
  if (!rollingInited) {
    const init = pcmQueue.pop(frameSize);
    if (!init) return;
    rollingFrame.set(init);
    rollingInited = true;
  } else {
    // advance by hopSize
    const hop = pcmQueue.pop(hopSize);
    if (!hop) return;

    // shift left and append
    rollingFrame.copyWithin(0, hopSize);
    rollingFrame.set(hop, frameSize - hopSize);
  }

  // pitch update
  const pitch = pitchTracker.pushFrame(rollingFrame);
  if (pitch) {
    noteNameEl.textContent = pitch.noteName;
    freqHzEl.textContent = `${pitch.freqHz.toFixed(1)} Hz`;
    centsEl.textContent = `${pitch.cents} cents`;
  }

  // tempo novelty accumulate
  tempoTracker.pushFrame(rollingFrame);
}

async function stopRecording() {
  btnStop.disabled = true;
  setStatus("停止中…");

  if (analysisTimer) {
    clearInterval(analysisTimer);
    analysisTimer = null;
  }

  const blob = await stopMediaRecorderSafely();

  if (micStream) micStream.getTracks().forEach(t => t.stop());
  micStream = null;

  if (workletNode) {
    workletNode.port.onmessage = null;
    try { workletNode.disconnect(); } catch {}
    workletNode = null;
  }

  // finalize tempo
  tempoState = tempoTracker.finalize({ minBPM: 40, maxBPM: 200 });
  tempoTracker.reset();

  if (tempoState.bpm) {
    tempoEl.textContent = `♩=${tempoState.bpm}`;
    tempoConfEl.textContent = tempoState.confidence.toFixed(2);
    beatOffsetEl.textContent = `${tempoState.beatOffsetSec.toFixed(3)}s`;
  } else {
    tempoEl.textContent = "♩=—";
    tempoConfEl.textContent = "0.00";
    beatOffsetEl.textContent = "—";
  }

  const ctx = await ensureAudioContext();
  const arrayBuf = await blob.arrayBuffer();
  decodedAudioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
  durEl.textContent = `${decodedAudioBuffer.duration.toFixed(2)}s`;

  btnStart.disabled = false;
  btnPlay.disabled = false;
  setStatus("已录制，准备回放");
}

function stopMediaRecorderSafely() {
  return new Promise((resolve) => {
    if (!mediaRecorder) return resolve(new Blob());
    const mr = mediaRecorder;
    mediaRecorder = null;

    mr.onstop = () => resolve(new Blob(recordedChunks, { type: mr.mimeType || "audio/webm" }));
    try { mr.stop(); } catch { resolve(new Blob(recordedChunks, { type: mr.mimeType || "audio/webm" })); }
  });
}

async function play() {
  if (!decodedAudioBuffer) return;
  btnPlay.disabled = true;
  btnStopPlay.disabled = false;

  const ctx = await ensureAudioContext();
  await ctx.resume();

  stopPlayback();

  const useMet = metOnEl.checked && !!tempoState.bpm;
  const bpm = tempoState.bpm || 0;
  const beatOffsetSec = tempoState.beatOffsetSec || 0;

  // nodes
  const src = ctx.createBufferSource();
  src.buffer = decodedAudioBuffer;

  const musicGain = ctx.createGain();
  musicGain.gain.value = 1.0;
  musicGain.connect(ctx.destination);

  const clickGain = ctx.createGain();
  clickGain.gain.value = Number(metGainEl.value);
  clickGain.connect(ctx.destination);

  const clickBuffer = createClickBuffer(ctx);

  const startDelay = 0.03;
  const t0 = ctx.currentTime + startDelay;

  let stopScheduler = null;
  if (useMet && bpm > 0) {
    stopScheduler = scheduleMetronome(ctx, {
      bpm,
      startTime: t0 + beatOffsetSec,
      durationSec: decodedAudioBuffer.duration,
      clickBuffer,
      clickGainNode: clickGain,
    });
  }

  src.connect(musicGain);
  src.start(t0);

  playback.source = src;
  playback.schedulerStop = stopScheduler;

  src.onended = () => stopPlayback();

  setStatus(useMet ? "回放中（节拍器已对齐）" : "回放中（节拍器关闭/无BPM）");
}

function stopPlayback() {
  if (playback.source) {
    try { playback.source.stop(); } catch {}
    playback.source = null;
  }
  if (playback.schedulerStop) {
    playback.schedulerStop();
    playback.schedulerStop = null;
  }
  btnPlay.disabled = !decodedAudioBuffer;
  btnStopPlay.disabled = true;
  if (decodedAudioBuffer) setStatus("已录制，准备回放");
}

function setStatus(s) {
  statusEl.textContent = s;
}
