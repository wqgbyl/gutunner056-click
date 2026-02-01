# 调音器 + 自动 BPM(♩) + 回放节拍器（AudioWorklet 试跑版）

## 目标
- 麦克风录音（人声/双簧管）
- 实时音高估计（PitchTracker）
- 停止录音后自动识别四分音符速度：`♩=BPM`
- 回放时叠加可听节拍器（可开关/音量）

> 这是一个“完整可跑”的新仓库骨架，你之后把你已有的调音器核心算法（换音确认、合并、评分等）直接替换 `src/dsp/pitchTracker.js` 即可。

## 运行
1. 安装 Node.js
2. 在项目目录运行：
   ```bash
   npx http-server -p 5173
   ```
3. 打开浏览器：
   - http://localhost:5173

## 说明与已知限制（当前版本）
- Tempo 识别依赖录音长度，建议 ≥ 8 秒更稳定
- 主线程分析 tick 使用 RAF 近似，精度可用但不是最严谨
  - 下一步优化：用 AudioWorklet 发送“累计样本计数”或在主线程以 `setInterval(10ms)` 从 ring buffer 按 hopSize 精确推进
- Chrome/Edge 体验最好；Safari 可能需要额外处理 AudioWorklet / MediaRecorder

## 文件结构
- `src/audio/audio-worklet-processor.js`：AudioWorklet，抓 PCM
- `src/dsp/pitchTracker.js`：音高估计（可替换为你的成熟实现）
- `src/dsp/tempoTracker.js`：谱通量+能量差分 → ACF → ♩BPM
- `src/audio/metronome.js`：节拍器 click 生成与调度
- `src/dsp/fft.js`：简单 radix-2 FFT（用于谱通量）
