# Step 6：幂等、并发与强杀恢复实测

- 日期：2026-10-24
- 分支：`step5-writeback`
- 环境：Windows 11、Node 25.5.0、pnpm 11.25.0、真实模式（`pnpm real:dev`）、系统代理 `127.0.0.1:7897`
- 模式：只接管 Step 4 已受理的 3 个 HeyGen `video_id`；在线传输仅允许 GET；本次**新增付费提交 0 次、新增扣费 0 CNY**
- 结构化证据：[step6-idempotency-recovery.json](step6-idempotency-recovery.json)

## 结论

三项验收全部通过：

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| 两个 `POST /api/start` 同时到达 | 通过 | 一个 `202 started`、一个 `200 already_running`；最终只有 1 个 job / artifact / file |
| accepted 阶段强杀服务进程 | 通过 | 端口关闭，状态停在 `accepted`，job 仍为 `running`，留下 1 completed + 1 accepted 回执 |
| 重启后再次启动同一任务 | 通过 | 同一 job `attempt=2`、`reconciliation_attempt=1`，复用同一 3 个 `video_id`，最终 `review_required` |
| 完成后再启动 | 通过 | `200 already_complete`，`completedAt` 不变 |
| 钱包 | 通过 | 测试前 1.35 USD → 测试后 1.35 USD，`autoReload=false`，变化 0 |
| 回归测试 | 通过 | `pnpm test` 111/111、`pnpm run test:queue` 37/37、`pnpm run typecheck` 通过 |

本轮测试还**发现并修复了一个真实恢复缺陷**（详见“恢复失败与修复”），否则重启恢复会失败。

## 测试边界

1. 使用隔离数据：先执行 `pnpm run seed` 重建干净基线，并删除本次运行派生的 `.interview-data/step5*` 目录。
2. 真实模式通过 `HEYGEN_KEY_FILE` 从仓库外读取 Key；日志、证据与报告均不包含 Key、绝对路径或带凭据的下载 URL。
3. 只读取/下载 Step 4 已有的 3 个任务，没有调用创建接口；`create()` 与预算 `reserve()` 在接管分支中直接抛错。
4. 没有部署、没有社媒发布；执行期间未提交或推送，证据整理后已随 `step5-writeback` 推送（`2d58d2d`）。

## 用例一：并发双启动

**操作**：干净基线上，同一时刻发出两个 `POST /api/start`。

**结果**：

- 第一个：`202 {"status":"started"}`
- 第二个：`200 {"status":"already_running"}`
- 阶段推进：`submitting → accepted → compositing → writing_back → review_required`
- 记录数：job 1、artifact 1、file 1、operation 2、production receipt 2、presenter job 3
- 产物：`socialart_362ad83b8e0e75d1a781fc92`，状态 `review_required`
- 媒体：8,995,181 字节，SHA-256 `c8fe2f84b25444e048b858dd5274ceb3942f4bd620d6147ee9b7dde03ecf815f`
- 第三次启动：`200 already_complete`，`completedAt` 不变
- 接管计数：`statusCalls=3`、`downloads=3`、`uploads=3`、`presentersAdopted=3`、`newPaidSubmissions=0`、`newChargedCny=0`

**判定**：并发请求只产生一次执行，没有重复 job/artifact/file，也没有新增付费提交。

## 用例二：accepted 后强杀

**操作**：启动一次任务；轮询本地状态，在第一个 presenter 完成接管（`presentersAdopted >= 1`）后，对监听 4318 的服务进程执行 `SIGKILL`（`taskkill /F /PID` 兜底）。

**强杀瞬间**：

- 阶段：`accepted`
- 接管计数：`statusCalls=1`、`downloads=1`、`uploads=1`、`presentersAdopted=1`
- 回执：hook `completed`（`c15b32aecb501970d0f0d0fa3958cf03`），capabilities `accepted`（`9c7ab31c7ef49df5a9a92a6804c73599`）
- job：`running`，`attempt=1`，尚未生成 artifact/file
- 强杀后：端口关闭；`state.json` 仍为 `accepted`，job 仍为 `running`（没有伪造完成或失败）

**判定**：进程确实被杀死，现场保留为可恢复的中间态。

> 第一次强杀尝试中，探针以裸文件名调用 `taskkill.exe` 失败（`spawnSync taskkill.exe ENOENT`），服务器存活并继续推进；该次已标记为**测试工具错误**并归档为 `step6-kill-attempt1.json`，不作为产品结论。第二次改用 `process.kill(pid, 'SIGKILL')` 后成功。

## 用例三：重启恢复

**操作**：用同样的真实模式命令重启服务；再次 `POST /api/start`；轮询到终态。

**结果**：

- 启动响应：`202 {"status":"started"}`
- 阶段推进：`submitting → accepted → compositing → writing_back → review_required`
- 持久任务：同一 job `b723a160da693f0`，`attempt=2`、`reconciliation_attempt=1`、最终 `succeeded`
- 回执：3 条均为 `completed`，且均为接管（`adoption=true`）
- 三个 `video_id` 与 Step 4 完全一致：

| 镜头 | `video_id` | 媒体 SHA-256 |
| --- | --- | --- |
| hook | `c15b32aecb501970d0f0d0fa3958cf03` | `163b50ed…547dcc` |
| capabilities | `9c7ab31c7ef49df5a9a92a6804c73599` | `82c1be19…e3531f` |
| cta | `da9b079f3329488bdb77f31b462bb31e` | `9b340b8a…c874fb` |

- 记录数：job 1、artifact 1、file 1、operation 2、production receipt 2、presenter job 3
- 产物：`socialart_a8f0d112e6e9e4db954ec402`，`review_required`，技术审核与创意审核均为 `false`
- 文件：`socialfile_2379e35d6b2bdc272ee903a7`，8,995,181 字节
- 哈希链：磁盘成片 = 文件记录 = artifact 媒体 = `/api/media` 实际响应，均为 `c8fe2f84…f815f`
- 成片参数：33.52s、1080×1920、H.264/AAC
- 周任务：`succeeded`，`resultRefs` 指向该 artifact
- 接管计数：`statusCalls=3`、`downloads=3`、`uploads=3`、`presentersAdopted=3`、`newPaidSubmissions=0`、`newChargedCny=0`
- 第三次启动：`200 already_complete`，`completedAt` 不变

**判定**：恢复后没有重新提交付费任务，没有换用新的 `video_id`，同一 job 在原身份上完成并生成唯一可审核产物。

## 恢复失败与修复（本轮发现）

第一次重启恢复（修复前）失败，终点为 `step5_job_terminal_error`，job 仍是 `running`、`attempt=1`，只保留原回执。根因在 [durableQueue.ts](../server/contentExecution/durableQueue.ts) 的 worker-id 解析：

- 旧正则：`^(.+)-(\d+)-[0-9a-f-]{20,}$`
- worker id 形如 `Cris7-14976-91640a75-6326-4f1f-b52f-bc9eaf20b301`
- 由于 UUID 首段 `91640a75` 全是十六进制字符，贪婪的 host 分组会吞掉 `14976-91640a75`，把 PID 解析成 `6326`，导致 `sameHost=false`、`localOwnerAlive` 被当作 `true`
- 结果是“同一主机上已死的 worker + 尚未到期的租约”永远不会进入 `reconciling`，`drain()` 领不到任务，最终报错

修复方式：

- 把 UUID 作为完整固定形状匹配：`^(.+)-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`
- 抽出 `localWorkerPid()`，`recoverAbandonedJobs` 与租约清理共用同一解析
- 新增 2 个回归测试：
  - `worker id parser keeps a digit-led uuid out of the host segment`
  - `dead local worker is recovered before its lease expires`

修复后重跑同一场景，恢复通过。修复前的失败现场保留在 `.interview-data/step6-recovery-attempt1-context.json`，可用于复盘。

## 回归测试

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 111 passed / 0 failed |
| `pnpm run test:queue` | 37 passed / 0 failed（新增 2 个恢复测试） |
| `pnpm run typecheck` | 通过 |

## 证据索引

| 内容 | 路径 |
| --- | --- |
| 结构化总证据 | `evidence/step6-idempotency-recovery.json` |
| 并发结果 | `.interview-data/step6-concurrency-result.json` |
| 强杀结果 | `.interview-data/step6-kill-result.json` |
| 强杀工具失败（已废弃） | `.interview-data/step6-kill-attempt1.json` |
| 恢复结果 | `.interview-data/step6-recovery-result.json` |
| 修复前恢复失败现场 | `.interview-data/step6-recovery-attempt1-context.json` |
| 钱包前/后 | `.interview-data/wallet-step6-before.json`、`.interview-data/wallet-step6-after.json` |
| 服务日志 | `.interview-data/step6-server-*.log` |

## 未覆盖与后续

1. **未知提交对账**：本次强杀发生在 3 个任务都已受理之后，属于“已知 providerTaskId”场景；若进程死在创建任务请求发出后、响应返回前，仍需真实的未知提交对账策略。该部分不在本轮零费用范围内。
2. **人工审核**：产物停在 `technicalReview=false`、`creativeReview=false`，人工试听与创意审核仍待执行。
3. **现场复跑**：本次为本地真实模式实测；交付前仍需按验收要求在干净环境完整复跑并录制。
4. **页面链路 P0**：Step 6 解决的是幂等与恢复；页面端到端真实提交仍属于下一项 P0 工作。

## 安全与合规声明

- 未提交 `node_modules`、`data`、`.interview-data`、Key 或带凭据的 URL。
- Key 仅从仓库外的 `HEYGEN_KEY_FILE` 读取；报告与证据不含 Key、签名 URL 或绝对路径。
- 未部署、未社媒发布、未新增付费提交、未改动钱包。
- 未邀请协作者，未执行 commit/push。
