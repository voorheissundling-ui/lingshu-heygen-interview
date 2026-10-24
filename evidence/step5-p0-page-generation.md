# Step 5 P0：页面触发的真实生成与未知提交对账

状态：**代码完成，离线验证通过；本轮未调用供应商、未产生付费提交、未读取真实 Key。**
日期：2026-10-24
范围：P0-A 页面启动真实生成；P0-B 提交结果未知时的对账恢复。

## 1. 结论

- P0-A 已接入现有 Step 5 流水线，而不是另起一条旁路：页面选择“真实生成”、填写并确认预算上限后，由 `POST /api/start` 进入 `generate` 模式，逐个镜头提交 HeyGen 任务、轮询、下载、校验、合成，再走原有回写与周任务结算。
- P0-B 已实现“结果未知不重提”：创建请求一旦可能已送达供应商，就持久化 `submission_unknown`，后续只允许 GET 对账（按精确标题 + 提交时间窗列任务，或人工指定 `video_id`）。人物镜头可自动/人工对账；旁白没有可列出的任务身份，必须修改台词形成新的内容版本，禁止原样重提。
- 预算沿用 Step 4 的 8 CNY 总上限，不扩大授权：页面必须显式勾选确认，服务端再校验 `HEYGEN_INTERVIEW_MAX_CNY` 必须存在、大于 0、等于页面确认值且不超过 8；每次提交前仍做剩余预算与钱包余额双重检查。
- 离线验证：主回归 **120/120**、队列 **37/37**、`tsc --noEmit` 通过；其中新增生成模块单测 6/6，全部使用临时目录、假 Key、伪造客户端/响应，不访问外网。

## 2. P0-A：页面触发的真实生成

### 2.1 页面与 API

- 页面新增“复用 Step 4 / 真实生成”模式选择。真实生成需要：
  1. `real:dev` 启动（真实模式 + 包外 Key）；
  2. `STEP5_PAGE_GENERATION_ENABLED=1`；
  3. `HEYGEN_INTERVIEW_MAX_CNY=8`；
  4. 页面填写上限 8 并勾选“我确认本次真实生成最多花费 8 CNY”。
- 任一条件不满足时，“启动任务”按钮保持不可用，页面展示中文原因；服务端在抢租约前再次校验，不能只靠前端。
- `GET /api/real/status` 新增 `pageGenerationEnabled`、`generationCapCny`、`generationCapError`、`maxGenerationCapCny`、`reconcileAvailable`，不返回 Key。
- `POST /api/start` 接受 `{mode:"reuse"|"generate", confirmedCapCny}`；`generate` 缺少数字上限直接 400。
- `GET /api/pipeline` 增加脱敏的 `generationLedger`：逐镜头阶段、requestId、标题、供应商任务 ID、时长、费用、复用来源、媒体哈希；不返回签名下载 URL、音频 URL 或请求体。

### 2.2 生成流程

每个镜头按内容寻址：

- 人物：`presenterContentHash({avatarId, voiceId, speech})`，requestId 为 `interview-step5-presenter-<shot>-<hash12>`。
- 旁白：`narrationContentHash({voiceId, engine, language, text})`，requestId 为 `interview-step5-tts-<shot>-<hash12>`。
- 标题：`LingShu Step5 <shot> <hash8>`，用于供应商列表精确对账。

状态账本落在 `.interview-data/step5-generation/<shot>/state.json`：

`prepared → submitting → accepted → downloaded`；
异常分支为 `submission_unknown`、`rejected`、`failed`。
内容变化时旧账本归档为 `state-<oldHash16>.json`，不会覆盖证据。

提交流程的硬约束：

- 提交前必须处于 `prepared`、该镜头 `paidSubmissions=0`、requestId 一致；先写入 `submitting`、请求体和请求哈希，再发 POST。
- 每次提交前向共享预算账本 `reserve(forecast)`；完成下载后按“观察到的钱包扣费 vs 估算”取较大值 `settle`。
- 人物：`avatarUsdPerMinute × fx × (duration+3)/60`；旁白：`speechUsdPerMillionChars × chars / 1e6 × fx`。
- 下载后校验人物视频时长/画幅/编码/音轨，旁白音频时长 ≤ 20 秒；失败不会重提。
- 所有镜头 `downloaded` 后，用 Step 4 计划器重新生成时间轴、旁白混音、清单，再调用原 `desktop/render.cjs` 合成，成片必须 30–37 秒、1080×1920、H.264/AAC 且可完整解码。

### 2.3 与 Step 4 的关系（零成本优先）

生成模式不是无条件付费：

1. 若该镜头已有相同内容哈希且媒体文件校验通过，直接复用本地账本，零提交。
2. 若内容与 Step 4 完全一致，直接采用 Step 4 已付费媒体（`fit=cover`、哈希/字节/时长一致），零提交。
3. 只有内容确实发生变化、且无可用本地产物时才提交一次。

因此，**当前未改动的分镜在“真实生成”模式下也会零新增费用完成**；要验证真实 POST，必须修改某个镜头的台词/时长等形成新内容版本。当前预算剩余 2.660527 CNY，按现价最多覆盖约 1 个新人物的口播镜头（3.2 秒镜头预估约 1.59 CNY）及其旁白，两个人物镜头同时变更会超预算并被服务端拦截。

## 3. P0-B：未知提交对账

### 3.1 何时进入未知

- 创建请求发出后网络中断、超时、连接重置，或收到 5xx/408/429 等不能证明“未受理”的错误；
- 旁白接口返回成功但音频地址不可信、引擎漂移；
- 收到供应商受理回执后本地无法继续。

这些情况统一持久化为 `submission_unknown`，预算预占保留，**绝不自动重提**。

### 3.2 对账方式

- 人物镜头：下一次运行或页面“对账”时，用 `GET /v3/videos` 列表，按“标题完全相等 + 创建时间落在提交时间窗内”匹配；也可人工输入 `video_id`，服务端读取详情并再次校验标题/时间窗。
- 匹配唯一时仅采纳供应商任务 ID，进入 `accepted`，随后正常轮询/下载/结算；对账本身不产生新的付费提交。
- 匹配不到或匹配多个时保持未知并返回中文原因，不做猜测。
- 旁白镜头：无法按列表对账，错误信息明确要求修改台词形成新内容版本；原样重试被禁止。
- 页面提供 `POST /api/reconcile`，返回 `{ok, shot, pipeline}`；未知/未找到/歧义分别返回 409。

### 3.3 回写侧配合

- `generate` 模式会重开原持久队列 job（清空租约/错误，必要时清空旧回执），不重复准入；仍在运行的 job 不会被强行改写。
- 原周任务若已 `succeeded`，在生成新产物前重置为 `queued`，让原适配器重新结算新产物。
- 回写前检查生成账本：存在 `unknownShots` 时把流水线置为 `submission_unknown`；`reconciling` 时返回可重试的 `step5_provider_pending`，避免把“仍在处理”误判为失败或成功。
- 只有全部镜头的 requestId 都有 `completed` 回执、成片校验通过后，才进入 `writing_back` 与 `review_required`。

## 4. 预算与安全边界

- 授权上限仍为 **8 CNY**；账本当前：已记账 5.339473 CNY、预留 0、剩余 2.660527 CNY、付费操作 6 次；钱包 1.35 USD。
- 不在页面或日志中展示 Key、Key 文件路径、带凭据 URL；错误文本先脱敏。
- 真实模式外网仅放行 `api.heygen.com/v3/` 与已注册媒体域；对账只做 GET。
- 离线测试使用假 Key `test-key-not-real`、临时预算文件、伪造 fetch/client，不触发供应商。
- 本轮没有部署、没有社媒发布，也没有读取仓库外的真实 Key；执行期间未提交或推送，证据整理后已随 `step5-writeback` 推送（`2d58d2d`）。

## 5. 验证结果

| 项目 | 结果 | 说明 |
|---|---|---|
| 新增生成模块单测 | 6/6 | 内容哈希稳定/变化；上限 8 与确认不一致在联网前失败；丢响应后未知且仅一次 POST；下次按列表对账零 POST；人工 video_id 对账；4xx 拒绝释放预算；Step 4 复用零提交 |
| 主回归 | 120/120 | 含新增 `interview/step5Generation.test.ts` 与扩展后的 `step5Pipeline.test.ts` |
| 队列回归 | 37/37 | `durableQueue.test.ts`，含 provider reconciliation 与暂停/恢复 |
| 类型检查 | 通过 | `pnpm run typecheck` |
| 真实供应商调用 | 0 | 本轮未启动 `real:dev`，未读取真实 Key |
| 付费提交 | 0 | 预算账本未变化 |

## 6. 未验证与后续

1. **本轮未做真实页面生成**：上述结果证明代码路径、预算闸门和对账状态机，不等同于一次真实付费闭环。真实验证需另行批准金额与 Key，并避免在已用 5.339473/8 CNY 的账本上无计划试价。
2. **预算空间有限**：剩余 2.660527 CNY 不足以同时重生成两个人物镜头；若必须双人物变更，需要按原预算流程重新审批，不能绕过上限。
3. **人工验收未做**：即使真实生成完成，仍需人工观看成片、听感/ASR 复核与 `technicalReview`/`creativeReview` 审核。
4. **收尾步骤**：Step 7（文档与交付清单）、Step 8（最终封包复验）仍未完成；是否邀请评审账号、是否推送代码，仍按原约定等待全部步骤完成后再决定。

## 7. 复现命令（离线）

```bash
pnpm test
pnpm run test:queue
pnpm run typecheck
```

真实验证（需明确授权后执行，勿在未批准时运行）：

```bash
STEP5_PAGE_GENERATION_ENABLED=1 HEYGEN_INTERVIEW_MAX_CNY=8 \
  HEYGEN_KEY_FILE=<仓库外部的 Key 文件> \
  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 \
  pnpm run real:dev
```

启动后打开 `http://127.0.0.1:4318/`，选择“真实生成”、确认 8 CNY 并勾选确认框。若分镜与 Step 4 完全一致，本次会零新增费用复用 Step 4 媒体；要产生真实 POST，需要先修改至少一个镜头的内容。

## 8. 相关文件

- `interview/step5Generation.ts`（新增：身份、账本、预算、提交/轮询/下载、对账）
- `interview/step5Generation.test.ts`（新增：6 项离线测试）
- `interview/step5Pipeline.ts`（generate 模式、job 重开、生成合成、状态机、中文错误）
- `interview/step5Pipeline.test.ts`（模式身份、公开状态、未知终止态）
- `interview/web.ts`（状态字段、启动参数、对账接口、脱敏账本）
- `interview/public/index.html`（模式选择、预算确认、对账面板、账本展示）
- `server/contentExecution/retryPolicy.ts`（未知提交归类为 provider_reconciliation）
- `package.json`（测试套件纳入新测试）
- `evidence/step5-p0-page-generation.json`（机器可读摘要）
