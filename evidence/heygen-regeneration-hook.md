# HeyGen hook 重生成验证：avatar-ID 首次失败，改原帧+原音轨后成功

> 后续进展：本文件记录第一次 avatar-ID 方法的失败现场。用户随后选择“原帧 + 原音轨”方案，hook、capabilities、cta 均已成功生成并合入成片。完整结果见 [heygen-regeneration-1080p.md](heygen-regeneration-1080p.md)。  
> 再后续：1080p 版本仍为女声，已用 Brodie 男声重做全片并通过原写回链路，见 [voice-fix-brodie.md](voice-fix-brodie.md)。

- 日期：2026-10-24
- 账户：新 HeyGen API 账户（钱包充值后 5.00 USD）
- 模式：首次失败为 avatar-ID 新付费提交 1 次；未重试；未改动 Step 4/5 状态
- 结论：**第一次生成成功，但输出人物与原成片不是同一个人，不能用于替换；已停止后续两个镜头。**

## 1. 提交与结果

| 项目 | 值 |
| --- | --- |
| 镜头 | hook |
| 请求 ID | `interview-regen-hook-e3f026aca024` |
| Provider video ID | `17b5b6e9d2acb9129589201873f3c79d` |
| 标题 | `LingShu Regen hook e3f026ac` |
| 输出 | 720×1280、3.22s、H.264/AAC |
| 媒体 SHA-256 | `5113ddf2ee1389d75c5dff669494540738b4289e627dcdd96ff55fedd8c7d035` |
| 钱包前 → 后 | 5.00 → 4.88 USD |
| 实际扣费 | **0.12 USD（约 0.80 CNY）** |
| 预算上限 | 8 CNY（本轮累计 0.80 CNY） |

媒体与状态：

- `.interview-data/heygen-regeneration/hook/provider-output.mp4`
- `.interview-data/heygen-regeneration/hook/state.json`
- 预览帧：`preview-1.0.png`、`preview-2.0.png`
- 原成片对照帧：`existing-1.0.png`

## 2. 失败原因：同名 avatar ID 指向了另一个人

提交使用 storyboard 中原有的：

- `avatar_id = ee25a2363ef941a1b5b0f7b1172e57d1`
- `voice_id = c5e71f9038a2419d9d43c7132c31fe49`

preflight 显示 `storyboardPresenterVerified=true`，只证明新账号目录里存在同 ID 的 public photo avatar，**不证明是同一个人**。

实际输出：

- 原成片：深色背景、近景、卷发男子；
- 新生成：书架/白花背景、更宽景别、脸型与发型明显不同的另一名男子。

因此同一 `avatar_id` 在新账号中解析到了不同的 look/人物。继续生成 capabilities 和 cta 会得到另一个人的画面，破坏成片连续性，已停止。

## 3. 费用与边界

- 仅 1 次付费提交，`Idempotency-Key` 固定，未重试、未重复扣费。
- 生成前校验：wallet 为 USD、余额 5.00、auto-reload 关闭；估算 1.2848 CNY < 8 CNY 上限。
- 生成后钱包 4.88 USD，实际扣 0.12 USD。
- 未修改 Step 4 manifest、未重新渲染、未写回 artifact。
- 未提交 Key、未记录签名 URL。

## 4. 可选后续

1. **用原成片帧 + 原音轨作为 image/audio 资产重试 1 次**：可精确保留人物脸与声音，预计再花约 0.12 USD；输出仍是 720p。
2. **转 Seedance 1080p**：用同一组参考帧与音轨，画质上限更高；需要先开通 Seedance 视频模型。
3. **保留现有成片**：不再替换人物镜头。

在获得明确选择前，不提交第二次生成。

## 5. 后续：原帧 + 原音轨方案成功

用户选择方案 1 后，用原成片帧与原音轨作为 HeyGen 资产重新提交：

| 镜头 | videoId | 输出 | 实际扣费 |
| --- | --- | --- | --- |
| hook | `ce5d644322cdf75417313b9553f0cfb7` | 1080×1920 / 3.24s | 0.11 USD / 0.7342 CNY |
| capabilities | `4322f525743df4aa4ea80ebe5f74f18e` | 1080×1920 / 4.72s | 0.17 USD / 1.1346 CNY |
| cta | `4035b775b46193f363794ab9669a1bc5` | 1080×1920 / 7.20s | 0.28 USD / 1.8688 CNY |

- 3 段人物身份与原成片一致，已替换进成片并通过原写回链路；最终 artifact `socialart_ea506cbb7bf6107371b71cbc`。
- 新账户累计 4 次付费提交、0.68 USD；钱包 5.00 → 4.32 USD。
- 完整证据：[heygen-regeneration-1080p.md](heygen-regeneration-1080p.md)。
