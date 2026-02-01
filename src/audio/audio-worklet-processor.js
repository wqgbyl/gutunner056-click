// AudioWorkletProcessor: 把麦克风输入以固定 block 输出到主线程（Float32Array）
// 说明：这里不做 FFT/分析，尽量轻量。
// 主线程会把这些样本缓冲成 (frameSize=1024, hop≈10ms) 用于 pitch/tempo。

class PCMGrabberProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._bufLen = 0;
    this._chunkSize = 2048; // 每次凑够 2048 样本就发一次，减少 message 频率
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0) return true;

    // 拷贝当前 render quantum (通常 128 samples)
    const copy = new Float32Array(ch0.length);
    copy.set(ch0);
    this._buf.push(copy);
    this._bufLen += copy.length;

    if (this._bufLen >= this._chunkSize) {
      const out = new Float32Array(this._bufLen);
      let off = 0;
      for (const a of this._buf) {
        out.set(a, off);
        off += a.length;
      }
      this.port.postMessage({ type: "pcm", pcm: out }, [out.buffer]);
      this._buf = [];
      this._bufLen = 0;
    }
    return true;
  }
}

registerProcessor("pcm-grabber", PCMGrabberProcessor);
