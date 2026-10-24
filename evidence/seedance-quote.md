# Seedance 人物镜头重生成：报价与执行边界

> 2026-10-24 更新：实际 Key 是**火山方舟 Ark** 的 Key，不是 fal.ai Key。本文的 fal.ai 报价仅作历史参考；当前阻塞与接入方式见 [seedance-ark-access.md](seedance-ark-access.md)。

- 日期：2026-10-24
- 状态：**仅报价，未调用生成接口，未产生任何费用**
- 目的：用 Seedance 替换成片中的 3 个人物镜头，旁白、插图、字幕、时间轴保持不变
- 渠道：fal.ai
- 模型：`bytedance/seedance-2.5/reference-to-video`

## 1. 为什么需要重生成

现有 3 个人物镜头来自 HeyGen，实际媒体为 **720×1280、25fps、H.264/AAC**；最终成片是 1080×1920，人物画面目前是放大使用。Seedance 1080p 输出可以真正提升人物镜头的清晰度，同时保留原音轨与口型参考。

| 镜头 | 原台词时长 | 当前媒体 | Seedance 计划时长 |
| --- | ---: | --- | ---: |
| hook | 3.213s | 720×1280 | 4s |
| capabilities | 4.702s | 720×1280 | 5s |
| cta | 7.158s | 720×1280 | 8s |
| 合计 | 15.073s | — | **17s** |

说明：Seedance 的最短生成时长为 4 秒、按整数秒计费。生成后按原镜头时长裁剪，超出部分不会进入成片。

## 2. 输入与参数

- 参考图：从每个原人物镜头中抽取的清晰正面帧，作为 `@Image1`。
- 参考音频：从原人物镜头中抽取的原声（AAC 转 MP3），作为 `@Audio1`；每段 3.2–7.2 秒，满足 1.8–30.2 秒限制。
- 输出：`9:16`、`1080p`、`H264`、`bitrate_mode=high`、`generate_audio=false`。
- 口型：以原音轨为节奏/语音参考；生成后把**原 AAC 音轨**重新封装进新视频，确保成片声音与原来完全一致。
- 合成：只替换 Step 4 manifest 中 3 个人物 `video` 的 URL；字幕、插图、voiceover 与时间轴不改，继续用原 `desktop/render.cjs` 渲染。
- 未改动字幕：保持上一轮确认的现状。

## 3. 官方计费依据

fal.ai 页面给出的 Seedance 2.5 参考生视频计费：

- 480p：约 **$0.2205 / 秒**
- 720p：约 **$0.4730 / 秒**
- 1080p：约 **$1.164 / 秒**
- Token 公式：`(输出高 × 输出宽 × (输入视频时长 + 输出视频时长) × 24) / 1024`
- 图片与音频参考不计费；只有视频参考才触发 0.6× 折扣。

本次只有图片 + 音频参考，没有视频参考，因此按输出时长计费。

## 4. 报价方案

| 方案 | 模型 / 分辨率 | 17 秒估算 | 建议批准上限 | 相对现有画面 |
| --- | --- | ---: | ---: | --- |
| **推荐** | Seedance 2.5 / 1080p | **$19.79** | **$21.00** | 720p → 1080p，画质提升最大 |
| 备选 A | Seedance 2.0 / 1080p | $11.59 | $12.50 | 720p → 1080p，成本更低 |
| 备选 B | Seedance 2.5 / 720p | $8.04 | $9.00 | 分辨率与原素材相同，主要提升模型质感 |
| 备选 C | Seedance 2.0 / 720p | $5.16 | $6.00 | 最省，但分辨率不升级 |

推荐方案的计算：

```text
4s × $1.164 + 5s × $1.164 + 8s × $1.164
= 17s × $1.164
= $19.788 ≈ $19.79
建议 cap = $21.00（留约 6% 计费舍入余量）
```

边界：

- 本次**不自动重试**；任一镜头失败即停止并报告，不把失败当成功。
- 预算检查在提交前完成；超过批准上限直接拒绝。
- 若 fal 账户余额低于批准上限，停止，不提交。
- 批准上限只覆盖本轮 3 个镜头；不包含后续重试或再次生成。
- 所有任务使用内容哈希 + 本地 request_id 账本；响应丢失时只允许按 request_id 对账，不原样重提。

## 5. 当前阻塞

1. **Key 文件不存在**：约定的 Seedance Key 路径当前没有文件；目录中只有 HeyGen Key。需要把 fal.ai 的 Key 放到约定位置，或告知新的仓库外路径。
2. **余额未核验**：Key 到位后先做只读 `GET /v1/account/billing?expand=credits`；若该 Key 只有推理权限（403），则无法在提交前确认余额，需要先确认 fal 账户余额不少于批准上限。
3. **尚未获得 USD 上限批准**：在收到明确批准前不会上传素材、不会提交任务、不会产生费用。

## 6. 批准后执行顺序

1. 只读核验 Key、账户余额与模型可用性（不上传、不生成）。
2. 上传 3 张参考图和 3 段参考音频到 fal storage。
3. 按镜头提交 3 个 Seedance 2.5 任务，记录 request_id，逐镜头轮询。
4. 下载并校验：1080×1920、9:16、时长、编码、可完整解码。
5. 把原 AAC 音轨重新封装进新视频，校验音画时长。
6. 用 Step 4 manifest 替换 3 个人物 URL，重新渲染成片。
7. 校验成片 30–37s、1080×1920、H.264/AAC，生成新的 artifact/file 并走原有写回与审核状态。
8. 写入证据：调用次数、request_id、实际费用、钱包前后、成片哈希；人工看片与听感/ASR 复核仍待执行。

## 7. 安全边界

- 不提交 Key、`node_modules`、`data`、`.interview-data` 或带凭据的 URL。
- Key 仅从仓库外读取，日志与证据不出现 Key、签名 URL、绝对路径。
- 不部署、不社媒发布。
- 不扩大原 HeyGen 8 CNY 授权；Seedance 使用单独的 USD 上限与账本。

## 8. 参考

- [Seedance 2.5 Reference-to-Video（fal.ai）](https://fal.ai/models/bytedance/seedance-2.5/reference-to-video)
- [fal Queue API：提交任务](https://fal.ai/docs/inference-api/queue/submit)
- [fal 文件上传](https://fal.ai/docs/platform-apis/v1/serverless/files/file/upload-from-url)
- [fal Account Billing](https://fal.ai/docs/platform-apis/v1/account/billing)
