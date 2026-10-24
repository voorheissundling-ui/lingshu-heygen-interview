# HeyGen 1080p 人物镜头重生成与成片替换

> 后续修订（2026-10-24）：本文件记录的 1080p 版本仍为 Jennifer 女声。已按用户决定用 **Brodie 男声**重做全片 6 段 TTS 与 3 段人物镜头，新成片与 artifact 见 [voice-fix-brodie.md](voice-fix-brodie.md)。本文件保留为 1080p 画质阶段的现场记录。

- 日期：2026-10-24
- 分支：`step5-writeback`
- 账户：新 HeyGen API 账户（钱包充值后 5.00 USD；wallet/USD、auto-reload=false）
- 模式：原成片帧 + 原音轨作为 image/audio 资产，HeyGen Avatar IV 默认引擎，`9:16`、`1080p`
- 预算：本轮重生成独立累计上限 **8 CNY**；实际新增 **3.7376 CNY**（3 个成功镜头），失败重试另计 **0.8009 CNY**
- 结论：**PASS（画质修订已合入成片并通过原写回链路）**。3 个人物镜头由 720×1280 替换为 **1080×1920**，人物身份与原成片一致；最终成片 **33.52 s、1080×1920、H.264/AAC**，新 artifact 为 `review_required`，页面播放与下载哈希一致。
- 结构化证据：[heygen-regeneration-1080p.json](heygen-regeneration-1080p.json)

## 1. 背景与方案

Seedance 视频模型在火山方舟账号中未开通（`ModelNotOpen`），3D 模型不能生成视频；详见 [seedance-ark-access.md](seedance-ark-access.md)。因此改用新 HeyGen API Key：

1. 先用 storyboard 原 `avatar_id`/`voice_id` 生成 hook：新账号把同一 public look 解析成了**另一个人**，失败；详见 [heygen-regeneration-hook.md](heygen-regeneration-hook.md)。
2. 按已确认方案改为**原成片帧 + 原音轨**作为上传资产：脸与声音直接来自原成片，不再依赖 avatar 目录解析。
3. 3 个镜头均为 1080p；生成后只替换人物镜头，说明图、旁白、字幕和时间轴不动。

生成请求的公开结构（不含 Key / 签名 URL）：

```json
{
  "type": "image",
  "image": {"type": "asset_id", "asset_id": "<imageAssetId>"},
  "audio_asset_id": "<audioAssetId>",
  "aspect_ratio": "9:16",
  "resolution": "1080p",
  "title": "<title>",
  "output_format": "mp4"
}
```

输入素材：

| 镜头 | 参考帧 | 原音轨 |
| --- | --- | --- |
| hook | `.interview-data/seedance-assets/hook/frame-2.0.png` | `.interview-data/seedance-assets/hook/voice.mp3` |
| capabilities | `.interview-data/seedance-assets/capabilities/frame-2.0.png` | `.interview-data/seedance-assets/capabilities/voice.mp3` |
| cta | `.interview-data/seedance-assets/cta/frame-2.0.png` | `.interview-data/seedance-assets/cta/voice.mp3` |

## 2. 提交与费用

| 镜头 | Provider video ID | 请求 ID | 输出 | 媒体 SHA-256（前 16） | 钱包前→后 | 实际扣费 |
| --- | --- | --- | --- | --- | --- | --- |
| hook（首次、失败） | `17b5b6e9d2acb9129589201873f3c79d` | `interview-regen-hook-e3f026aca024` | 720×1280 / 3.22s | `5113ddf2ee1389d7…` | 5.00 → 4.88 | 0.12 USD / 0.8009 CNY |
| hook | `ce5d644322cdf75417313b9553f0cfb7` | `interview-regen-ia-hook-ba7c8658049f` | 1080×1920 / 3.24s | `878250ec58d4a2c9…` | 4.88 → 4.77 | 0.11 USD / 0.7342 CNY |
| capabilities | `4322f525743df4aa4ea80ebe5f74f18e` | `interview-regen-ia-capabilities-058c2056a964` | 1080×1920 / 4.72s | `be8dad62a07317d7…` | 4.77 → 4.60 | 0.17 USD / 1.1346 CNY |
| cta | `4035b775b46193f363794ab9669a1bc5` | `interview-regen-ia-cta-50bbed8b06b5` | 1080×1920 / 7.20s | `8defa4a9d00c3a1a…` | 4.60 → 4.32 | 0.28 USD / 1.8688 CNY |

- 累计付费提交 **4 次**（1 次失败 + 3 次成功），新账户共花 **0.68 USD / 4.5385 CNY**，钱包余额 **4.32 USD**。
- 3 个采用镜头合计 **0.56 USD / 3.7376 CNY**，低于 8 CNY 独立上限。
- 每次提交前都校验：wallet/USD、`balance >= 0`、`auto_reload=false`、单镜与累计估算不超过 8 CNY；实际扣费低于保守估算（例如 cta 估算 4.2983 CNY、实际 1.8688 CNY）。
- `Idempotency-Key` 固定为 `requestId`；不自动重试。cta 轮询期间代理两次 `ECONNRESET`，脚本退出但状态已落盘为 `accepted`+`videoId`，恢复后只继续轮询/下载，**没有第二次提交**。

逐镜完整元数据：

| 镜头 | 资产（image / audio） | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| hook | `99fb86465d434655b6f50f9fe989c959` / `5e5187dc9e644d63a0206b0c0f268b81` | 2,527,879 | `878250ec58d4a2c921ef50e9d2cdc40ff037f7e6a37493b27000ccf68cf6e4b2` |
| capabilities | `f2d1d5b92a77417183e07d33373a2bf2` / `ea29b5737331486ebf092127b7f07f92` | 3,809,524 | `be8dad62a07317d7e0f8fd80b89710980b4035c0d710fab37752bd2f2bd27787` |
| cta | `db7767c311e24020b1a4a0ad0ef929ce` / `1fd379c17eea4c33832abb3a7569d5d9` | 5,320,634 | `8defa4a9d00c3a1ae5c85b633519c682e3fab96747d4704e85233bece4eeaa95` |

## 3. 媒体校验与人物一致性

- 3 段均为 **1080×1920、H.264/AAC**，可完整解码；`validateGenerationPresenterMedia` 通过。
- 时长 3.24 / 4.72 / 7.20 s，均长于 manifest 中对应 `trimEnd`（3.213 / 4.702 / 7.158 s），不会补帧或截短。
- 每段抽取 1.0 s、2.0 s 帧人工对照：脸型、卷发、胡须、痣位、浅蓝衬衫/深色西装、背景均与原成片一致；不是首次 avatar-ID 生成中的另一名男子。
- 只做了抽帧对照，**尚未做整段人工观看**；口型与音轨的逐句核对仍需人工听看。

## 4. 合入成片

### 4.1 替换方式

- `.interview-data/step4-compose/manifest.json` 的时间轴 URL 路径保持不变，直接替换 3 个路径下的媒体：
  - `.interview-data/step4-shots/{hook,capabilities,cta}/provider-output.mp4`
- 原 720p 媒体、状态与 manifest 已备份到 `.interview-data/backup-pre-1080p-20261024-134533/`；每个镜头目录另有 `provider-output.step4-720p.mp4` 与 `regeneration.json`。
- 每个 `state.json` 顶层现在描述本次 1080p 媒体（新 `videoId`、`mediaSha256`、`chargedCny`、`regeneration` 块），原 Step 4 记录完整移入 `historicalStep4` 与 `regeneration.supersedes`；原视频 ID、哈希、费用未被丢弃或改写。
- 说明图、旁白、字幕、时间轴偏移均未改动；`production.sound` 仍为 `source`。

### 4.2 原写回链路

按原流程重新 seed 本地业务 store、清除旧 Step 5 artifact/job/state（均先备份），然后启动离线 `pnpm run dev`，页面 `POST /api/start`（`mode=reuse`）执行 8 阶段：

```
submitting → accepted → generating → downloading → compositing → writing_back → review_required
```

本次最终运行**没有调用供应商**（`providerSource=local-step4-state`，`live=null`，新增付费提交 0），因为 3 段媒体已在上一阶段生成并校验；这符合原 `reuse` 语义。

结果：

| 项目 | 值 |
| --- | --- |
| artifact | `socialart_ea506cbb7bf6107371b71cbc`，`review_required` |
| file | `socialfile_84064b8f2e700d63902d4e2f` |
| 成片 | 33.52 s、1080×1920、H.264/AAC、8,436,894 字节 |
| SHA-256 | `78126c2b6db8628c4e8b33574c72874d9db0529642350acde3938bb6a4e71ae9` |
| 合成 manifest SHA-256 | `8675ecd7721ce5328d997b9953e8bd652790301e7f7ca1deedb70855ef36b37d` |
| 技术/创意审核 | `false` / `false`（等待人工） |
| 周任务 | `succeeded` |
| 页面播放 | `GET /api/media?artifactId=socialart_ea506cbb7bf6107371b71cbc` → 200，8,436,894 字节，哈希与磁盘一致 |
| 页面下载 | 同 URL 加 `download=1` → 200，`Content-Disposition: attachment`，哈希一致 |

页面记录同时展示了新 `videoId`、新媒体 SHA 与三镜费用；回写账本合计为 **4.738751 CNY**，其中 3.7376 CNY 是本次人物镜头、1.001151 CNY 是复用的 3 段旁白。

### 4.3 抽帧验收

最终成片抽帧：

- 1.5 s（hook）：“Launch your own skincare line”字幕下，人物与原片一致；
- 12.0 s（capabilities）：“pricing. Your branding.”字幕下，人物与原片一致；
- 30.0 s（cta）：“15 years of manufacturing.”字幕下，人物与原片一致。

音频：`mean_volume=-19.4 dB`、`max_volume=-3.1 dB`；3 处静音间隙（8.95 / 19.55 / 25.77 s）位于说明镜头与旁白之间，属原时间轴结构，不是生成丢失。

## 5. 边界与未完成

1. **整段人工审核未完成**：技术/创意审核保持 false；抽帧只能证明人物与画质，不证明全片口型、语义、听感。
2. **字幕/音轨同步未做 ASR 复核**：本次未改字幕与旁白时间，风险来自新人物镜头自身的口型；需人工看片。
3. **首次 avatar-ID 失败已计入费用**：0.12 USD；不要复用该 `avatar_id` 生成，原因是新账号同名 ID 指向另一人。
4. **最终运行是离线 reuse**：真正付费生成发生在本修订的准备阶段（独立脚本、独立 8 CNY 上限、逐次幂等），不是页面 `generate` 模式；这与 Step 7 记录的“真实页面触发付费生成未执行”边界一致。
5. 未部署、未社媒发布、未提交 Key/签名 URL/`.interview-data`。
6. 新账户钱包 4.32 USD；如后续还要演示真实 `generate`，需另行确认预算与账户状态。

## 6. 关联证据

- [heygen-connectivity.md](heygen-connectivity.md)：Key、钱包与只读预检
- [heygen-regeneration-hook.md](heygen-regeneration-hook.md)：首次 avatar-ID 失败现场
- [seedance-ark-access.md](seedance-ark-access.md)：Seedance 视频模型未开通
- [step5-writeback.json](step5-writeback.json)、[step5-p0-page-generation.md](step5-p0-page-generation.md)：原写回链路与页面验收
