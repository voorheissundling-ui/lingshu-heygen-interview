# SOLUTION｜数字员工 × HeyGen 单条视频纵向链

- 基线：`20fe685fa87c33680e3cc079fac62dcd07e0272a`
- 分支：`step5-writeback`
- 日期：2026-10-24
- 目标：在原有身份、租约、预算、回写门禁内，完成一条分镜驱动的数字员工视频：分镜导入 → 真实 HeyGen 生成 → 查询/下载 → 合成 → 原任务回写 → 页面播放/下载，并覆盖幂等、强杀恢复、未知提交对账、异常与预算边界。

## 1. 结果摘要

| 项目 | 结果 |
| --- | --- |
| 成片 | 33.52 s、1080×1920、H.264/AAC，可完整解码；Brodie 英文男声 |
| 最终 artifact | `socialart_ae42c3e4f47b90c0dbdbc554`，`review_required` |
| 最终 file | `socialfile_107db1207e1f029db1f17503` |
| 成片 SHA-256 | `632b0a50d8f0f53ba4aba4d0bb2b77f240acf001a3f455f58ca1dfc0ac189ed7` |
| 页面播放/下载 | `/api/media?artifactId=…` 200；`download=1` 返回 attachment；下载哈希一致 |
| 人工审核 | technical=false、creative=false（未代替审核人批准） |
| 回归 | 主测试 128/128、队列 37/37、typecheck 通过（Step 7 记录） |

## 2. 整体方案

### 2.1 数据流

```
assets/storyboard.json
  ├─ Step 1：校验并保存分镜（6 镜、3 人物 + 3 说明、33.5s）
  ├─ Step 2：只读 preflight（账号/钱包/public avatar & voice/价格）
  ├─ Step 3：单人物镜头真实闭环（submit → query → download → validate）
  ├─ Step 4：3 人物镜头 + 3 段旁白 + 原创说明图 → manifest → 33.52s 成片
  └─ Step 5：原任务/run/job 回写
        ├─ reuse：接管已落盘媒体（离线可复跑）
        ├─ live-bridge：GET-only 接管既有 video_id，不新提交
        └─ generate：页面显式确认 CNY 上限后逐镜真实生成
```

- 合成统一走原 `desktop/render.cjs`（`composite()`），字幕烧录、9:16 构图、音轨拼接均复用原实现。
- 回写统一走原 durable job / artifact / file / production receipt / scene cache / weekly settlement，不另建平行交付表。
- 页面只监听 `127.0.0.1`；读页面不触发生成，执行仅由 `POST /api/start` 进入。

### 2.2 三种模式

| 模式 | 供应商调用 | 用途 |
| --- | --- | --- |
| `reuse`（默认） | 0 | 复跑合成、回写、页面验收；消费已校验的 Step 4 媒体 |
| `reuse` + real bridge | 仅 GET | 用既有 `video_id` 重新查询/下载，证明恢复不重提 |
| `generate` | POST + GET | 页面确认上限后真实生成；受钱包、8 CNY、幂等、预占约束 |

## 3. 必做项落点

### 3.1 真实全链路与成片（35 分）

- Step 3 用真实 HeyGen public photo avatar 出 1 段口播；Step 4 出 3 段人物 + 3 段旁白；Step 5 回写并页面播放/下载。
- 请求身份、`video_id`、阶段、费用、媒体 SHA、钱包前后均落盘；证据见 `evidence/step3-*.json`、`evidence/step4-*.json`、`evidence/step5-*.json`。
- 2026-10-24 的画质修订把 3 个人物镜头从 720×1280 替换为原生 **1080×1920**，再走原 `reuse` 合成/回写；见 `evidence/heygen-regeneration-1080p.md`。
- 同日发现原音色 `Jennifer` 为女声、与男性人物不匹配，遂全片改用 **Brodie - Breezy & Genuine** 男声：重做 6 段 TTS 与 3 段人物镜头，重新合成并再次走原 `reuse` 写回；见 `evidence/voice-fix-brodie.md`。

### 3.2 幂等与重复启动

- 幂等键：`taskId + runId + storyboardSha256 + avatarId + voiceId + mode`。
- 状态落盘 phases：`prepared → submitting → accepted → generating → downloading → compositing → writing_back → review_required`。
- 重复 `POST /api/start`：运行中返回 `already_running`，完成后返回 `already_complete`；原 task/run 不变，只保留一份 artifact/file。
- 供应商提交固定 `Idempotency-Key=requestId`；`beforeSubmit` 校验 `paidSubmissions=0`、请求哈希与阶段，拒绝同一幂等键换内容。

### 3.3 中断恢复

- 60 秒租约 + owner/PID/过期时间；启动前检查 stale 租约，不抢活进程。
- job worker 使用原 durable queue；强杀后同一 job 进入 `reconciling`，恢复时只查询既有 `video_id` 并继续下载/合成/回写。
- 修复过真实缺陷：worker id 正则把 UUID 首段吞进 host，导致已死进程被误判存活；现按完整 UUID 形状解析（`server/contentExecution/durableQueue.ts`）。
- 证据：`evidence/step6-idempotency-recovery.md` / `.json`。

### 3.4 未知提交对账

- 创建请求已发出但响应丢失时，状态停留在 `submitting`，不自动重提。
- 恢复时按固定 `title` 调 `GET /v3/videos` 对账；只有唯一匹配才接管 `video_id`，0 个或多个都拒绝。
- 页面提供 `POST /api/reconcile`，只读供应商，不创建、不下载、不重提。
- 离线测试覆盖 401/429/5xx/下载失败/损坏媒体/预算不足；真实创建响应丢失场景未对供应商演练。

### 3.5 预算与错误边界

- 生成前要求：`billing_type=wallet`、币种 USD、余额 ≥ 估算、`auto_reload=false`；不把“查到余额”当作硬上限。
- 单镜与累计上限：`HEYGEN_INTERVIEW_MAX_CNY`，页面生成最多 8 CNY；提交前做 worst-case 估算，超限拒绝。
- 预算账本记录 `chargedCny` / `reservedCny` / `paidSubmissions`；预占持久化，防并发绕过。
- 真实错误分类为可读中文：401 鉴权、429/5xx 未知、下载失败、媒体损坏、预算不足、供应商 pending；不把未知当失败重提。

### 3.6 完整性与隔离

- 下载 URL 必须匹配供应商允许域；拒绝带凭据/非白名单 URL，下载使用 `redirect: error`。
- 媒体校验：容器/编码、9:16、时长 2–12.5s（单镜）、1080p 宽度、可解码；最终成片校验 30–37s、1080×1920、H.264/AAC。
- 回写时校验 file/artifact/composition SHA 四段一致；artifact 强制 `review_required`，技术/创意审核 false。
- Key 只从仓库外 `HEYGEN_KEY_FILE` 读取；前端、日志、证据、提交均不含 Key 或签名 URL。

## 4. 关键取舍

1. **720p 改 1080p**：原 Step 4 为控制成本用 720p 源片上采样；画质修订改为原生 1080p。1080p 阶段单镜 $0.11–0.28，新账户画质修订共 0.68 USD。
2. **不用 avatar-ID 复用人物**：同一 `avatar_id` 在新账号会解析成另一个人；改用原成片帧 + 原音轨上传，稳定保持身份。
3. **发现音色不匹配后全片重做**：不保留“男画面 + 女声”的折中版本。6 段 TTS 与 3 段人物镜头统一换成 Brodie 男声，另花 0.67 USD；旧媒体与旧 artifact 完整保留，可回滚。代价是本次总计 1.35 USD，但成片一致性优先。
4. **画质/音色修订的付费生成不放在页面 `generate` 模式**：使用独立脚本、TTS 3 CNY 与人物 8 CNY 独立上限、逐镜幂等；页面 `reuse` 只做合成/回写，避免把“重渲染”与“新付费提交”混为一谈。
5. **保留原 Step 4 记录**：新状态顶层描述实际使用的媒体，原始 720p 与 Jennifer 女声记录完整保留在 `historicalStep4` / `supersedes` / `historicalVoiceFix` 与备份目录，不删除审计痕迹。
6. **视频/字幕时间轴随旁白时长重新规划**：男声 TTS 时长与原女声不同，Step 4 plan 重新计算 6 镜起止点；说明图、字幕文案与总时长目标保持不变。
7. **人工审核不自动化**：技术/创意审核保持 false；机器校验只证明格式、哈希、可解码，不代替人看片/听声。

## 5. 复现

### 5.1 离线回归与页面

```bash
pnpm install --frozen-lockfile
pnpm run doctor
pnpm run typecheck
pnpm test
pnpm run test:queue
pnpm run smoke
pnpm run verify
pnpm run seed
pnpm run dev
# http://127.0.0.1:4318/
# 点击“启动任务”，等待 review_required，播放/下载
```

注意：`smoke`/`seed` 会重置本地业务 store；`.interview-data` 为隔离数据，不提交。最终成片由已校验的 Step 4 媒体 + manifest 复跑得到。

### 5.2 真实只读预检

```bash
HEYGEN_KEY_FILE=/path/outside/repo/heygen.key.txt \
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
pnpm run provider:preflight
```

只读；不提交、不上传、不下载、不扣费。

### 5.3 真实模式页面

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
HEYGEN_KEY_FILE=/path/outside/repo/heygen.key.txt \
HEYGEN_INTERVIEW_MAX_CNY=8 STEP5_PAGE_GENERATION_ENABLED=1 \
pnpm run real:dev
```

- `generate` 必须由页面显式确认 CNY 上限；未配置时不显示真实生成入口。
- `reuse` 不调用供应商；real 模式下若启用 bridge，只允许 GET 接管既有 `video_id`。
- 任何付费提交前先读钱包并核对上限；不要为了演示重复生成。

### 5.4 画质修订（一次性、非页面入口）

本轮一次性脚本与状态位于 `.interview-data/heygen-regeneration/`（不提交）。关键命令形态：

```bash
# 1) 预算试算，不提交
HEYGEN_INTERVIEW_MAX_CNY=8 HEYGEN_KEY_FILE=/path/outside/repo/heygen.key.txt \
DRY_RUN=1 node --use-system-ca --import tsx \
  .interview-data/heygen-regeneration/regenerate-image-audio.ts <shot>

# 2) 真实提交（每镜一次，脚本拒绝第二次付费提交）
HEYGEN_INTERVIEW_MAX_CNY=8 HEYGEN_KEY_FILE=/path/outside/repo/heygen.key.txt \
node --use-system-ca --import tsx \
  .interview-data/heygen-regeneration/regenerate-image-audio.ts <shot>

# 3) 把 3 段 1080p 媒体合入 Step 4 槽位，再按原 reuse 流程 seed + start + 回写
```

对外交付以 `evidence/heygen-regeneration-1080p.md/.json` 的结果为准；一次性脚本未纳入正式构建，避免误触发付费提交。

### 5.5 男声修订（一次性、非页面入口）

男声修订状态与脚本位于 `.interview-data/voice-fix/`（不提交）：

```bash
# 1) 6 段 TTS（3 CNY 上限，每段一次付费提交，downloaded 且哈希一致时跳过）
HEYGEN_KEY_FILE=/path/outside/repo/heygen.key.txt DRY_RUN=1 \
  node --use-system-ca --import tsx .interview-data/voice-fix/generate-voice.ts
HEYGEN_KEY_FILE=/path/outside/repo/heygen.key.txt \
  node --use-system-ca --import tsx .interview-data/voice-fix/generate-voice.ts

# 2) 3 段人物镜头 1080p（8 CNY 上限，原帧 + 新男声）
HEYGEN_KEY_FILE=/path/outside/repo/heygen.key.txt DRY_RUN=1 \
  node --use-system-ca --import tsx .interview-data/voice-fix/regenerate-presenter.ts <shot>
HEYGEN_KEY_FILE=/path/outside/repo/heygen.key.txt \
  node --use-system-ca --import tsx .interview-data/voice-fix/regenerate-presenter.ts <shot>

# 3) 更新 storyboard/Step 4 状态，重跑合成与原 reuse 写回
node --use-system-ca --import tsx .interview-data/voice-fix/adopt-voice-fix.ts
pnpm run step4:compose -- --render
```

结果与费用见 `evidence/voice-fix-brodie.md/.json`；旧 Jennifer 媒体、旧 Step 5 状态和旧 artifact 均保留在 `.interview-data/backup-pre-voicefix-*` 与 `step5.pre-voicefix-*`。

## 6. 实际验证

| 验证 | 结果 |
| --- | --- |
| Step 0 环境/干净安装/回归 | 通过（Windows 11、Node 25.5.0、pnpm 11.25.0） |
| Step 2 真实只读 preflight | 通过；Key/钱包/目录检查 |
| Step 3 单镜头真实生成 | 通过；真实 `video_id` + 下载 + 媒体校验 |
| Step 4 多镜头成片 | 通过；33.52s、1080×1920、6 段素材 |
| Step 5 回写/页面 | 通过；artifact/file/receipt/cache/weekly，播放/下载 |
| Step 6 并发/强杀 | 通过；并发只执行一次，强杀后同一 job 恢复 |
| Step 7 异常/预算 | 8/8 专项、128/128 主回归、37/37 队列 |
| 1080p 画质修订 | 3 镜 1080×1920、人物一致，新 artifact `review_required` |
| 男声修订 | Brodie 男声 6 段 TTS + 3 镜 1080p；新成片 33.52 s / 7,701,275 bytes |
| 页面哈希链 | `/api/media` 实际下载 SHA = composition = file = artifact = `632b0a50…189ed7` |
| 音高辅助检查 | 新成片中位 F0 112.7 Hz；旧女声版 169.3 Hz |

## 7. 未验证项（不能声称已验证）

1. **人工整段观看、听感、ASR 复核**未完成；抽帧只证明人物与画质。
2. **真实页面触发的付费 `generate`** 未执行；付费生成发生在一次性准备脚本中。Step 7 的该边界仍成立。
3. **真实 429/5xx、真实下载中断、真实创建响应丢失**未对供应商演练；现有结论来自受控注入与客户端分类。
4. **干净环境完整复跑与 3–5 分钟录屏**未完成，属于 Step 8。
5. **演示/现场改口播复跑**未执行；复跑额度需另行确认。
6. 未部署、未社媒发布、未邀请协作者。

## 8. AI 使用说明

- 使用 AI 辅助代码阅读、异常矩阵设计、脚本编写、媒体抽帧分析与文档整理。
- 所有真实生成、下载、合成、回写均由脚本/原管线执行；费用、`video_id`、哈希、钱包变化均来自真实响应，未手工伪造。
- 人工审核状态未被 AI 置为通过；未代替审核人做创意/技术批准。
- Key 未出现在代码、前端、日志、证据或提交中；未把 AI 生成内容冒充供应商真实输出。

## 9. 关键文件

| 文件 | 作用 |
| --- | --- |
| `assets/storyboard.json` | 6 镜分镜、口播、字幕、时长 |
| `interview/step4Plan.ts` / `step4Compose.ts` | 时间轴计划、manifest、合成 |
| `interview/step5Pipeline.ts` | 8 阶段、幂等、租约、回写、页面状态 |
| `interview/step5Generation.ts` | 页面真实生成、预算、钱包、逐镜账本 |
| `interview/step5LiveBridge.ts` | GET-only 接管既有 `video_id` |
| `interview/realMode.ts` / `realWeb.ts` | 真实模式、Key 注入、网络白名单 |
| `server/contentExecution/durableQueue.ts` | durable job、租约、恢复 |
| `desktop/render.cjs` | 原合成器（字幕/构图/音轨） |
| `evidence/voice-fix-brodie.md/.json` | 男声修订的请求、费用、音高、哈希与回写验证 |
| `evidence/` | 脱敏执行证据与哈希 |
