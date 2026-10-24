# OPERATIONS｜数字员工 × HeyGen 单条视频纵向链

- 适用分支：`step5-writeback`
- 运行平台：Windows 11 + Git Bash；Node ≥ 22.19（实测 25.5.0）、pnpm 11.25.0
- 隔离原则：只读写仓库内 `.interview-data/`；Key 只从仓库外文件读取；不部署、不社媒发布。

## 1. 启动与停止

### 1.1 离线模式（默认，不访问供应商）

```bash
pnpm install --frozen-lockfile
pnpm run seed        # 重建业务 store；会清空 .interview-data/store
pnpm run dev         # http://127.0.0.1:4318
```

- 端口：`PORT` 可覆盖，默认 4318；只绑定 `127.0.0.1`。
- 页面读取（`GET /`、`/api/pipeline`、`/api/state`）不触发生成；只有 `POST /api/start` 执行。
- 仓库用 `.gitattributes` 强制文本文件 LF 检出。`assets/storyboard.json` 的 SHA-256 是任务身份的一部分，**不要用会改成 CRLF 的编辑器重新保存该文件**，否则哈希和已有证据/状态不再匹配。
- `seed` 是**破坏性**操作：删除 `.interview-data/store` 后重建 fixture。执行前先备份（见 §6）。

### 1.2 真实模式（HeyGen，经系统代理）

```bash
NODE_USE_ENV_PROXY=1 \
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
HEYGEN_KEY_FILE=D:/secrets/heygen.key.txt \
pnpm run real:dev
```

只读预检（不提交、不扣费）：

```bash
HEYGEN_KEY_FILE=D:/secrets/heygen.key.txt \
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
pnpm run provider:preflight
```

付费生成必须**显式**开启：

```bash
HEYGEN_KEY_FILE=D:/secrets/heygen.key.txt \
HEYGEN_GENERATION_ENABLED=true \
STEP5_PAGE_GENERATION_ENABLED=1 \
HEYGEN_INTERVIEW_MAX_CNY=8 \
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
pnpm run real:dev
```

- 未设置 `HEYGEN_GENERATION_ENABLED=true` 或页面上限时，页面不出现真实生成入口，`generate` 会被拒绝。
- 页面 `reuse` 不调用供应商；real bridge 仅 GET 接管既有 `video_id`。
- `SOCIAL_CONTENT_HEYGEN_ENABLED=true` 才启用原社交内容桥接；本交付的页面链路不需要它。

### 1.3 停止

- 前台运行：`Ctrl+C`。
- 后台/失联进程（Git Bash 没有 `netstat`，用 PowerShell）：

```powershell
Get-NetTCPConnection -LocalPort 4318 -State Listen | Select-Object -ExpandProperty OwningProcess
Stop-Process -Id <PID> -Force
```

停止前确认没有 `writing_back` 进行中；强杀是支持的恢复场景（§5），但应留出合成/回写完成窗口。

## 2. 配置

| 变量 | 作用 | 默认/约束 |
| --- | --- | --- |
| `PORT` | 页面端口 | 4318，仅 `127.0.0.1` |
| `HEYGEN_KEY_FILE` | 仓库外 Key 文件路径 | 仅 `real:dev` / 预检脚本读取 |
| `INTERVIEW_REAL_MODE` | 真实模式标记 | 由 `real:dev` 设置 |
| `HEYGEN_GENERATION_ENABLED` | 允许真实生成 | 默认关闭；`true` 才启用 |
| `STEP5_PAGE_GENERATION_ENABLED` | 允许页面 `generate` | 默认关闭；`1` 才启用 |
| `HEYGEN_INTERVIEW_MAX_CNY` | 页面生成累计上限 | 必须 >0 且 ≤8；未设置则拒绝 |
| `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`/`HTTP_PROXY` | 让 Node 走系统代理 | Windows 实测必需 |
| `SOCIAL_WEEKLY_EXECUTION_WORKER_ENABLED` | 周任务 worker | real:dev 固定 `false` |

内部固定路径（代码设置，不需要手工配置）：

| 路径 | 内容 |
| --- | --- |
| `.interview-data/store` | 本地业务 store（job/artifact/file/receipt/cache/weekly） |
| `.interview-data/object-storage` | 本地对象存储 |
| `.interview-data/step5/state.json` | 管线状态、阶段、费用、产物引用 |
| `.interview-data/step4-shots/<shot>/state.json` | 每个镜头的供应商请求与媒体哈希 |
| `.interview-data/step4-compose/manifest.json` | 合成时间轴 |
| `.interview-data/heygen-regeneration/` | 一次性 1080p 重生成脚本与状态（不提交） |
| `.interview-data/voice-fix/` | 一次性 Brodie 男声修订脚本、音频、人物视频与预算（不提交） |

预算相关约束：钱包必须为 `wallet`/USD、`auto_reload=false`；提交前后记录钱包；累计账本在 `.interview-data/step4-shots/budget.json`、`.interview-data/voice-fix/budget.json` 与 Step 5 state 中。男声修订的 TTS 与人物镜头分别用 3 CNY / 8 CNY 独立上限；**不要把“余额足够”当作上限**。

## 3. 观察与日志

### 3.1 页面/API

| 端点 | 用途 |
| --- | --- |
| `GET /` | 页面：阶段、费用、播放/下载 |
| `GET /api/pipeline` | 8 阶段状态、generation、composition、writeBack、settlement |
| `GET /api/real/status` | 模式、Key 是否配置、生成开关、上限、对账可用性 |
| `GET /api/state` | 业务 store 快照（weekly/content/jobs/artifacts/files） |
| `GET /api/media?artifactId=…` | 播放；加 `download=1` 下载 attachment |
| `POST /api/start` | 启动/恢复；`reuse` 默认 |
| `POST /api/reconcile` | 真实模式下按 title 只读对账 |
| `POST /api/scan` | 周任务扫描（离线控制台用） |

### 3.2 日志

- 服务日志写到 stdout/stderr；建议重定向留档：
  - `pnpm run real:dev > .interview-data/real-dev.log 2>&1`
  - 历史样例：`.interview-data/step5-server.log`、`step6-server-*.log`。
- 结构化状态优先于文本日志：
  - `.interview-data/step5/state.json`（阶段、费用、哈希、URL）
  - `.interview-data/step5/final.mp4`（最终字节）
  - `.interview-data/store/content_execution_jobs.json`（job 状态、尝试次数、lease）
  - `.interview-data/store/durable_operation_leases.json`（租约 owner/PID/过期）
- 快速查看：

```bash
curl -s http://127.0.0.1:4318/api/pipeline
curl -s http://127.0.0.1:4318/api/real/status
pnpm run status
```

- 日志和证据中不得出现 Key、带凭据的下载 URL；服务端错误只输出固定错误码。

## 4. 正常操作流程

1. `pnpm run seed`（仅首次或需要干净环境）。
2. `pnpm run dev` 或 `pnpm run real:dev`。
3. 页面点击“启动任务” → `POST /api/start`。
4. 等待 `review_required`；确认 `technicalApproved=false`、`creativeApproved=false`。
5. 页面播放/下载，核对 SHA 与 `.interview-data/step5/state.json` 中 `composition.sha256` 一致。
6. 重复点击不会重复执行：运行中返回 `already_running`，完成后返回 `already_complete`。

真实生成（`generate`）时页面必须先确认 CNY 上限；提交前会重新读钱包、检查上限、写预占。**演示时优先用 `reuse`，避免重复付费。**

## 5. 中断恢复

### 5.1 恢复原则

- 供应商提交带固定 `Idempotency-Key=requestId`；恢复只查询既有 `video_id`，不重新提交。
- 阶段持久化在 `.interview-data/step5/state.json`；job 状态在本地 store。
- 60 秒租约；重启时检查 stale 租约，不抢活进程。
- 创建响应丢失时状态停在 `submitting`，按固定 `title` 对账；只有唯一匹配才接管，0 个或多个都拒绝。

### 5.2 步骤

1. 确认旧进程已退出（`Get-NetTCPConnection` / 任务管理器）。
2. 用**相同**的启动命令重新启动（real 模式需相同 Key 文件与代理）。
3. 在页面再次点击“启动任务”（`POST /api/start`）。服务不会仅靠重启自动续跑：
   - lease 仍有效 → `already_running`，说明旧进程可能还活着或租约未过期（60 秒），等租约过期再试；
   - 已回写且有 artifact → `already_complete`；
   - 其余情况按落盘 phase 续跑，不重新提交。
4. 观察 `GET /api/pipeline` 的阶段推进；job 级恢复时 `content_execution_jobs.json` 会短暂出现 `reconciling`。
5. 若停在 `submitting` 且为真实模式：`POST /api/reconcile`，只读对账；不要手工改状态、不要重新点击生成。
6. 校验恢复结果：`provider.shots[].videoId` 未变化、`paidSubmissions` 未增加、钱包未二次扣费。

### 5.3 常见故障对照

| 现象 | 处理 |
| --- | --- |
| `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT` | 检查代理 `127.0.0.1:7897`、`NODE_USE_ENV_PROXY=1`；已持久化的阶段不要重提，重启后继续 |
| `401 unauthorized` | 检查 Key 文件内容/有效期；不把 401 当可重试的网络错误 |
| 钱包读取失败 | 网络问题，不是扣费失败；用只读接口重查，不要重跑生成 |
| `step5_generation_wallet_balance_empty` | 钱包为 0；充值或改用 `reuse` |
| `step5_generation_cap_not_configured` | 未设置 `HEYGEN_INTERVIEW_MAX_CNY`；按流程设置 ≤8 |
| `already_running` / `already_complete` | 正常幂等响应，不是错误 |
| 页面播放器黑屏 0:00 | 无头 Chrome 的媒体限制；用下载文件或桌面浏览器核验 |

## 6. 回滚

### 6.1 回滚到 1080p 修订前

备份目录（本次会话创建，不提交）：

```
.interview-data/backup-pre-1080p-20261024-134533/
├─ step4-shots/        # 原 720p 镜头、state、frames、budget
├─ manifest.json       # 原合成清单
├─ store/              # 原业务 store
├─ step5/              # 原 state.json + final.mp4
└─ server-run.json     # 原页面运行记录
```

操作：

1. 停止服务。
2. 备份当前目录（不要直接覆盖）。
3. 把备份中的 `step4-shots`、`manifest.json`、`store`、`step5` 复制回 `.interview-data/` 对应位置。
4. 启动 `pnpm run dev`，用 `reuse` 重新执行，得到与备份一致的 720p 成片；或直接保留备份中的 `step5/final.mp4`。
5. 核对 `step5/state.json` 的 `composition.sha256` 与旧记录一致。

注意：备份 `store` 含旧 artifact/file/receipt；覆盖前确认没有需要保留的新记录。回滚**不退还**已产生的供应商费用。

### 6.2 回滚男声修订

备份目录：

```
.interview-data/backup-pre-voicefix-20261024-140031/
├─ step4-shots/           # Jennifer 女声 1080p 人物镜头与 state
├─ step4-narration/       # Jennifer 女声旁白与 state
├─ step4-compose/         # 旧 plan/manifest/voiceover
├─ step5/                 # 旧 state.json + final.mp4
├─ store/                 # 旧 artifact/file/receipt/cache
├─ storyboard.json        # 旧 storyboard（Jennifer voiceId）
└─ heygen-regeneration-1080p.json
```

旧 Step 5 状态另存于 `.interview-data/step5.pre-voicefix-<timestamp>/`；备份路径在 `.interview-data/voice-fix-backup-path.txt`。

操作：

1. 停止服务并备份当前目录。
2. 恢复上述 `step4-shots`、`step4-narration`、`step4-compose`、`step5`、`store` 与 `assets/storyboard.json`。
3. 启动 `pnpm run dev`，确认 `GET /api/pipeline` 返回旧 artifact `socialart_ea506cbb7bf6107371b71cbc`，成片 SHA 为 `78126c2b6db8628c4e8b33574c72874d9db0529642350acde3938bb6a4e71ae9`。
4. 若只回滚媒体、不回滚 store：用备份中的 `step4-*` 覆盖媒体与 state，保留新 store；随后 `pnpm run seed` + `reuse` 会生成新的 artifact，旧 artifact 仍保留在 store 中供审计。
5. 回滚**不退还**男声修订已产生的 0.67 USD。

### 6.3 只回滚媒体、不回滚账本

- 将 `step4-shots/<shot>/provider-output.step4-720p.mp4` 复制回 `provider-output.mp4`，并从备份恢复对应 `state.json`。
- 保留 `regeneration.json` 与 `historicalStep4` 记录，便于审计，但不要把它们当作当前媒体依据；管线以 `provider-output.mp4` 的实际哈希与 `state.json` 的 `mediaSha256` 为准。

### 6.4 干净重来

```bash
pnpm run seed
pnpm run dev
```

只重建业务 store；**不会**删除 `.interview-data/step4-*` 媒体、`.interview-data/heygen-regeneration/` 或备份目录。若需要完全干净环境，另建目录运行并重新执行 Step 3/4。

## 7. 交付与安全

- 不提交：`node_modules/`、`data/`、`.interview-data/`、Key、带凭据 URL、签名下载链接。
- 一次性 1080p / 男声修订脚本不进入正式构建；不在 CI/演示流程中自动执行，避免误触发付费。
- 男声修订只把最终媒体与脱敏证据写入 `evidence/`；音频、人物视频、预算账本留在 `.interview-data/voice-fix/`，不提交。
- 服务只监听本机；不部署、不社媒发布。
- 演示前核对：钱包余额、`HEYGEN_INTERVIEW_MAX_CNY`、`auto_reload=false`、页面显示的上限与模式。
- 人工审核保持 false，直到有人真正看片/听音并签字；运维不得把审核标记改为 true 代替审核人。
