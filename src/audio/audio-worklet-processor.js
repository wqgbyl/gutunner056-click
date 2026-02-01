// AudioWorkletProcessor: 抓取麦克风输入 PCM（Float32）并批量发送到主线程
// 主线程做：环形/队列缓存 -> 按 hopSize 精确推进分析（pitch/tempo）

class PCMGrabberProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._bufLen = 0;
    this._chunkSize = 2048; // 聚合后再发，降低 message 频率
    this._totalSamples = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0) return true;

    const copy = new Float32Array(ch0.length);
    copy.set(ch0);

    this._buf.push(copy);
    this._bufLen += copy.length;
    this._totalSamples += copy.length;

    if (this._bufLen >= this._chunkSize) {
      const out = new Float32Array(this._bufLen);
      let off = 0;
      for (const a of this._buf) {
        out.set(a, off);
        off += a.length;
      }
      // 同时发累计样本数，便于主线程调试/对齐
      this.port.postMessage({ type: "pcm", pcm: out, totalSamples: this._totalSamples }, [out.buffer]);
      this._buf = [];
      this._bufLen = 0;
    }

    return true;
  }
}

registerProcessor("pcm-grabber", PCMGrabberProcessor);
