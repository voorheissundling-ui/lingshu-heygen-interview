# 男声修订证据：Brodie 重做全片口播与人物镜头

**日期**：2026-10-24  
**触发问题**：原成片人物为男性，声音却是 `Jennifer - Smooth & Warm`（female）。  
**处理方式**：保留旧媒体与旧 artifact，全片改用英文男声 **Brodie - Breezy & Genuine**（`c30ecab014cb4a8d816d07f6b2b625c8`），重做 6 段 TTS、3 段 1080p 人物镜头，再走原 Step 4 合成与 Step 5 写回链路。

## 1. 结论

| 项目 | 结果 |
| --- | --- |
| 新音色 | Brodie - Breezy & Genuine，male，English，engine `orca` |
| 新成片 | 33.52 s，1080×1920，H.264/AAC，7,701,275 bytes |
| 成片 SHA-256 | `632b0a50d8f0f53ba4aba4d0bb2b77f240acf001a3f455f58ca1dfc0ac189ed7` |
| 新 artifact | `socialart_ae42c3e4f47b90c0dbdbc554` |
| 新 file | `socialfile_107db1207e1f029db1f17503` |
| 回写状态 | `review_required`；technicalReview=false，creativeReview=false；周任务 `succeeded` |
| 页面播放/下载 | HTTP 200；下载 7,701,275 bytes，SHA 与成片一致 |
| 本次费用 | 0.67 USD / **4.471809 CNY**（TTS 0.667434 + 人物 3.804375） |
| 钱包 | 4.32 → 3.65 USD |

客观音高对比（自相关 F0，剔除静音帧）：

| 成片 | 中位基频 | P25–P75 | 有声音帧 |
| --- | ---: | ---: | ---: |
| 新（Brodie 男声） | **112.7 Hz** | 97.6–131.1 Hz | 773 |
| 旧（Jennifer 女声） | **169.3 Hz** | 144.1–207.8 Hz | 932 |

男声修订后的中位基频明显下降，和听感一致；这只是客观辅助证据，**人工听感与 ASR 逐字校对仍未完成**。

## 2. TTS 重做（6 段）

- 接口：`POST https://api.heygen.com/v3/voices/speech`
- 请求：`voice_id=c30ecab014cb4a8d816d07f6b2b625c8`、`engine=orca`、`language=en`、`speed=1`
- 上限：3 CNY；实际 0.10 USD / 0.667434 CNY；钱包 4.32 → 4.22 USD
- 幂等：每段独立 state；`downloaded` 且 SHA 匹配时跳过；`submitting` 不重提

| 镜头 | 时长 | 费用 CNY | 钱包变化 | 音频 SHA-256（前 16） |
| --- | ---: | ---: | --- | --- |
| hook | 3.03 s | 0.133487 | 4.32→4.30 | `33b244fd560ae39f` |
| product-range | 6.01 s | 0.133487 | 4.30→4.28 | `f7152cc7312f7484` |
| capabilities | 4.23 s | 0.066743 | 4.28→4.27 | `5fe718918fc76bba` |
| lab-process | 5.46 s | 0.133487 | 4.27→4.25 | `449d838bb00cb4cd` |
| factory-quality | 6.06 s | 0.133487 | 4.25→4.23 | `5cfeba0175dd1931` |
| cta | 7.24 s | 0.066743 | 4.23→4.22 | `4f8df056aaec1039` |

## 3. 人物镜头重做（3 段，1080p）

- 输入：原人物帧 `.interview-data/seedance-assets/<shot>/frame-2.0.png` + 新 Brodie 音轨
- 接口：`POST https://api.heygen.com/v3/videos`，`type=image`、`aspect_ratio=9:16`、`resolution=1080p`
- 上限：8 CNY；实际 0.57 USD / 3.804375 CNY；钱包 4.22 → 3.65 USD
- 每镜固定 `Idempotency-Key=requestId`；已有 videoId 只轮询，不重提

| 镜头 | 供应商 videoId | 视频时长 | 费用 CNY | 钱包变化 | 视频 SHA-256（前 16） |
| --- | --- | ---: | ---: | --- | --- |
| hook | `9d0519064be63dd8a4056e7cf0cb6646` | 3.04 s | 0.800921 | 4.22→4.10 | `a55c5b85f744f6ff` |
| capabilities | `9b3e92ba5b88fdb7979186f213939c48` | 4.24 s | 1.134638 | 4.10→3.93 | `2b46b8cbbb11f5af` |
| cta | `dfc6cab7de73b99afc80db654d497dd4` | 7.24 s | 1.868816 | 3.93→3.65 | `b8c94e29c2beb9a2` |

3 段插图旁白直接复用新 TTS 音轨，不再调用视频供应商。

## 4. 采纳与合成

- `assets/storyboard.json` 的 `presenter.voiceId` 更新为 Brodie，记录 `previousVoiceId` 与 `voiceCatalogEvidence`。
- storyboard SHA-256：`ce3de043fcb22b36ef495664ad53ba69ce8c52d5bc702023d76e6ff1f51c86a6`。
- 6 个 Step 4 媒体槽位替换为新男声版本；旧 Jennifer 媒体保留为 `provider-output.jennifer-1080p.mp4` / `narration.jennifer.mp3`。
- 每个 Step 4 state 写入新 `videoId`、`requestId`、媒体哈希、费用、钱包快照与 `historicalVoiceFix`，避免覆盖历史。
- 重新生成 `plan.json` / `manifest.json` / `voiceover.wav`，并通过 `desktop/render.cjs` 重新合成。
- 新时间轴：hook 0–3.04、product-range 3.04–9.80、capabilities 9.80–14.04、lab-process 14.04–19.85、factory-quality 19.85–26.26、cta 26.26–33.50。
- manifest SHA-256：`c58da3badac1867422c74c58e0b8607803a74b047a75116169431d92a608995f`。
- Step 4 状态与费用明细：`.interview-data/voice-fix/adoption.json`、`evidence/step4-final.json`、`evidence/step4-manifest.json`。

## 5. 原链路写回与页面验证

- Step 5 使用 `reuse` 模式，从 Step 4 state + manifest 重合成，未重新提交 HeyGen。
- 通过原 file/artifact 命令回写，原周任务消费者结算成功。
- 新 artifact：`socialart_ae42c3e4f47b90c0dbdbc554`；新 file：`socialfile_107db1207e1f029db1f17503`。
- 页面播放：`/api/media?artifactId=socialart_ae42c3e4f47b90c0dbdbc554` → 200，`video/mp4`，7,701,275 bytes。
- 页面下载：追加 `&download=1` → 200，`Content-Disposition: attachment; filename="interview-output.mp4"`，SHA-256 与成片完全一致。
- 截图：[step5-page-brodie.png](step5-page-brodie.png)、[step5-page-brodie-bottom.png](step5-page-brodie-bottom.png)；页面未出现 Key 泄露模式。
- 完整检查项见 [step5-writeback.json](step5-writeback.json) 与 [voice-fix-brodie.json](voice-fix-brodie.json)。

## 6. 费用口径

| 项目 | USD | CNY |
| --- | ---: | ---: |
| 6 段 TTS | 0.10 | 0.667434 |
| 3 段人物视频 | 0.57 | 3.804375 |
| **本次合计** | **0.67** | **4.471809** |

- Step 5 的 provider 汇总已把人物 TTS 计入对应镜头：hook 0.934408、capabilities 1.201381、cta 1.935559；三镜合计 4.471809 CNY。
- 独立上限：TTS 3 CNY、人物 8 CNY；均未超限。
- 本轮共 **9 次付费提交**（6 次 TTS + 3 次人物视频）；钱包最终余额 **3.65 USD**；`auto_reload=false`。

## 7. 回滚

- 修订前完整备份：`.interview-data/backup-pre-voicefix-20261024-140031/`
- 旧 Step 5 状态归档：`.interview-data/step5.pre-voicefix-<timestamp>/`
- 旧 artifact：`socialart_ea506cbb7bf6107371b71cbc`
- 旧 file：`socialfile_84064b8f2e700d63902d4e2f`
- 旧成片 SHA-256：`78126c2b6db8628c4e8b33574c72874d9db0529642350acde3938bb6a4e71ae9`
- 回滚时恢复备份中的 `step4-shots/`、`step4-narration/`、`step4-compose/`、`step5/`、`store/` 与 `assets/storyboard.json`，再重跑 Step 4 合成和 Step 5 reuse。

## 8. 尚未完成

- 人工听感确认与 ASR 逐字校对。
- 3–5 分钟演示录制。
- 干净环境复跑与最终提交（当前改动尚未 commit/push）。
