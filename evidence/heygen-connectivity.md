# HeyGen 连通性复测：Key 已通过，钱包已充值并完成 1080p 重生成

> 后续修订（2026-10-24）：男声修订另花费 0.67 USD（TTS 0.10 + 人物 0.57），钱包最终 **3.65 USD**；详见 [voice-fix-brodie.md](voice-fix-brodie.md)。

- 日期：2026-10-24
- 状态：4.2 及之前为**只读测试**；4.3 起为**已批准的付费生成**（充值 5.00 USD，独立 8 CNY 上限）
- Key：仓库外文件 `D:/secrets/heygen.key.txt`（2026-10-24 13:13 更新，54 字节）
- 结论：当前 Key **有效**，`GET /v3/users/me` 与 `/v2/user/remaining_quota` 均返回 200；账户为 wallet 计费。13:13 首次检查时余额为 **0 USD**；用户充值后余额 5.00 USD，已完成 3 个 1080p 人物镜头重生成，最终余额 **4.32 USD**。

## 1. Key 文件检查

| 检查 | 结果 |
| --- | --- |
| 文件 | 存在，54 字节（13:13 更新；此前两个 Key 均为 108 字节） |
| 编码 | UTF-8 / ASCII，单行 |
| 读取方式 | 仅本地读取，未写入日志或证据 |
| 鉴权结果 | 成功（见 4.2） |

## 2. 鉴权探测

代理：`127.0.0.1:7897`；Node 25.5.0；`NODE_USE_ENV_PROXY=1` + `--use-system-ca`。

下表是 **12:34 / 13:06 两个 108 字节 Key** 的历史结果（均已失效或被替换）：

| 端点 | `X-Api-Key` | `Authorization: Bearer` | `Authorization: <key>` |
| --- | --- | --- | --- |
| `GET /v2/user/remaining_quota` | 401 Unauthorized | 401 Unauthorized | 401 Unauthorized |
| `GET /v1/user/me` | 401 `400112 Unauthorized` | 401 `400112 Unauthorized` | 401 `400112 Unauthorized` |
| `GET /v3/users/me` | 401 `unauthorized` | 401 `unauthorized` | 401 `unauthorized` |
| `GET /v3/api_keys/self` | 401 `unauthorized` | — | — |
| `GET /v3/avatars` | 401 `unauthorized` | — | — |

`GET /v2/user/me` 返回 404（该端点不存在），不作为鉴权结论。

## 3. 判定

- 上述 401 结论只适用于两个 108 字节的旧 Key；13:13 的 54 字节 Key 已推翻该结论。
- 13:13 Key 使用 `X-Api-Key` 头即可正常鉴权；`/v3/users/me`、`/v3/api_keys/self`、`/v3/avatars`、`/v2/user/remaining_quota` 均为 200。

## 4. 下一步（12:34 时的建议，已由 4.2 解决）

1. 登录 HeyGen → Settings → API，确认账户已有 API 访问权限。
2. 重新创建 API Key，复制**完整密钥**（不是 Key ID、不是 OAuth token）。
3. 保存到 `D:/secrets/heygen.key.txt`（仅一行，无引号/空格）。
4. 再执行只读检查：`/v2/user/remaining_quota` 返回 200 后再讨论任何生成。

## 4.1 13:06 复测：Key 已更新，但网络不可用

- 2026-10-24 13:06，`D:/secrets/heygen.key.txt` 更新（仍为 108 字节），推测是新 Key。
- 13:07 复测时无法建立 HTTPS 连接：
  - 经 `127.0.0.1:7897` 访问 `api.heygen.com` 与 `google.com` 均为 `SSL_ERROR_SYSCALL`（HTTP 000）；
  - 直连 `api.heygen.com` 15 秒超时。
- 代理恢复后再次复测（13:06 的 Key）：v2 与 v3 端点、3 种鉴权头仍全部 401。
- 因此 13:06 的 Key 同样**未通过鉴权**，不是网络问题。需要重新在 HeyGen 控制台确认 Key 的启用状态与复制内容。

## 4.2 13:13 复测：Key 有效，钱包 0，免费额度可用

- 2026-10-24 13:13，`D:/secrets/heygen.key.txt` 更新为 54 字节；使用 `X-Api-Key` 鉴权成功。

| 端点 | 状态 | 关键结果 |
| --- | --- | --- |
| `GET /v3/users/me` | 200 | `billing_type=wallet`，`currency=usd`，`remaining_balance=0`，`auto_reload=false` |
| `GET /v3/api_keys/self` | 200 | `status=active`，`scope_mode=full`，`expires_at=null` |
| `GET /v3/avatars` | 200 | 返回头像列表（首屏 20 条） |
| `GET /v2/user/remaining_quota` | 200 | `remaining_quota=0` |

免费额度（`details`）：

| 额度项 | 数量 |
| --- | ---: |
| `avatar_iv_free_credit` | 3 |
| `tts_free_credit` | 180 |
| `tts_shared_free_ms` | 600000 |
| `hyperframes_api_render_free_credit` | 5 |
| `hyperion_render_free_credit` | 1 |
| `video_agent_v2_free_video` | 1 |
| `b_roll_free_credit` / `podcast_free_credit` | 1 / 1 |
| `image_free_credit` / `video_upscale_free_credit` / `speech_cleanup_free_credit` | 3 / 3 / 3 |
| `generative_element_*` 三项 | 各 3 |

只读 preflight（`pnpm run provider:preflight`）：

```json
{"preflight":"READ_ONLY_COMPLETE","billingType":"wallet","walletCurrency":"usd","walletRemainingBalance":0,"autoReloadEnabled":false,"catalogComplete":false,"catalogWarning":"catalog_truncated_after_20_pages","publicAvatarCount":1000,"publicVoiceCount":1000,"storyboardPresenterVerified":true,"paidGenerationVerified":false}
```

判定：

- Key 可用；storyboard 里的 public photo avatar 与 voice 在新账号目录中仍然存在，`storyboardPresenterVerified=true`，说明同一个人物/声音可以复用。
- 钱包为 0 USD，`remaining_quota=0`。HeyGen 文档与多方资料显示，**2026 年 2 月起 API 不再提供免费额度**；`avatar_iv_free_credit=3` 等字段更像是网页版免费计划的额度，不能直接当作 API 可用额度。
- 因此直接用该 Key 调生成接口，预期会返回 `402 insufficient_credit`；`avatar_iv_free_credit=3` 与 3 个镜头数量吻合，但**尚未证明可通过 API 使用**。
- 现有 Step 5 管线也会在钱包为 0 时直接拒绝（`step5_generation_wallet_balance_empty`）。
- 在未确认免费额度是否可用于 API、且未获得付费批准前，不提交生成。

## 4.3 充值后：3 个 1080p 人物镜头生成成功

用户向新账户充值 **5.00 USD** 后，按“原成片帧 + 原音轨”方案完成重生成：

| 项目 | 结果 |
| --- | --- |
| 计费 | wallet / USD，`auto_reload=false` |
| 钱包 | 5.00 → **4.32 USD** |
| 付费提交 | 4 次（1 次 avatar-ID 失败 + 3 次 image+audio 成功） |
| 新账户累计费用 | **0.68 USD / 4.5385 CNY** |
| 3 个采用镜头费用 | **0.56 USD / 3.7376 CNY** |
| 输出 | 3 段 1080×1920、H.264/AAC，人物与原成片一致 |
| 成片 | 33.52 s、1080×1920，artifact `review_required` |

关键结论：

- 同一 `avatar_id` 在新账号会解析到不同人物（首次 hook 失败），**不能**用 avatar-ID 复用旧人物；原帧+原音轨可稳定保持身份。
- `avatar_iv_free_credit=3` 等免费额度不能通过 API 使用；充值后余额正常扣减。
- 详细媒体 ID、哈希、费用和写回结果见 [heygen-regeneration-1080p.md](heygen-regeneration-1080p.md)。

## 5. 安全边界

- 未记录 Key、未输出 Key 前缀或分段。
- 未提交 Key、`.interview-data`、`node_modules` 或带凭据 URL。
- 4.2 及之前未产生费用；4.3 的付费生成已获用户明确批准，金额限制在独立 8 CNY 上限内。
- 未部署、未社媒发布。
