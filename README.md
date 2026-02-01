# 调音器 + 自动 BPM(♩) + 自动对齐节拍器（AudioWorklet 同步版）

## 你现在得到的是什么
- 麦克风录音（人声 / 双簧管）
- 实时音高估计（`src/dsp/pitchTracker.js`，可替换为你已有成熟版本）
- 停止录音后分析：
  - 四分音符速度：`♩ = BPM`
  - 拍点相位偏移：`beatOffsetSec`（用于把节拍器“贴”到音乐重音/起音附近）
- 回放：音乐与节拍器都用 WebAudio，在同一时间轴（手机上不会像 `<audio>` 那样漂）

## 运行
1. 安装 Node.js
2. 在项目目录运行：
   ```bash
   npx http-server -p 5173
   ```
3. 打开：
   - http://localhost:5173

> GitHub Pages 部署：Settings → Pages → Deploy from a branch → main → /(root)

## 核心实现点
- AudioWorklet 抓 PCM：`src/audio/audio-worklet-processor.js`
- 主线程按 hopSize（约10ms）精确推进分析：`src/main.js`
- Tempo：
  - novelty = 0.7*谱通量 + 0.3*能量差分
  - ACF 找 BPM
  - 固定 BPM 下扫描 offset 得 `beatOffsetSec`
  - 实现：`src/dsp/tempoTracker.js`
- 节拍器调度（lookahead scheduling）：`src/audio/metronome.js`

## 下一步你要融合旧调音器
把你旧项目的核心逻辑替换 `src/dsp/pitchTracker.js` 即可，保持接口 `pushFrame(frame)`。
