# Step 7：异常、预算与费用边界

- 日期：2026-10-24
- 模式：离线异常注入 + 本地 FFmpeg 真实探测；**本轮没有真实生成、没有付费提交、没有新增扣费**
- 结论：**PASS（异常矩阵与预算边界已实现并通过回归）**
- 结构化证据：[step7-exception-budget.json](step7-exception-budget.json)

## 1. 结论

Step 7 的五个必需故障场景都有明确处理路径：鉴权失败、限流/服务失败、下载失败、预算不足、损坏媒体。所有路径都满足三条底线：

1. 不把失败伪装成成功，不进入 `review_required` 或回写；
2. 已知拒绝释放预算预占，未知结果保留预占且禁止重提；
3. 页面错误为中文可读，保留错误码与阶段，便于定位。

预算方面，提交前预占、`beforeSubmit` 二次校验、受理后记录 `videoId`、轮询记录状态、下载后按钱包差值与价格估算结算，均已落地。应用预算上限与供应商钱包余额分开记录：**应用侧 8 CNY 是硬上限；钱包余额 1.35 USD 不是硬上限**，当前供应商账户未设置消费硬上限。

## 2. 异常矩阵

| 故障 | 本轮触发方式 | 真实/注入 | 实际行为 | 预算与重提 |
|---|---|---|---|---|
| 鉴权失败 401 | `HeyGenRequestError(401)` 注入到创建请求 | **注入**；真实只读 401 可达性见 Step 2 | 识别为已知 4xx，镜头置 `rejected`；页面显示“鉴权失败/凭据无效” | 释放预占；只发 1 次 POST；不重提 |
| 限流/服务失败 429、5xx | 创建请求抛 429 / 500 | **注入** | 置 `submission_unknown`，保留请求身份与 `paidSubmissions=1` | 预占保留；不自动重提；后续只允许 GET 对账 |
| 状态查询 429 | 已有 `video_id` 后状态查询抛 429 | **注入** | 任务保持 `accepted`，继续轮询到截止时间；超时返回 `step5_provider_pending` | 不重新提交；仅查询同一 `video_id` |
| 下载失败 | 下载函数抛 `step5_generation_download_failed:502` | **注入** | 保持 `accepted`，记录 `lastError`；下次重试同一下载 | 预占保留；重试下载，不重新生成；只发 1 次 POST |
| 预算不足 | 本地账本 `chargedCny=7.9`，下一镜头预占约 0.744 CNY | **本地账本** | 在钱包读取与 POST 之前拒绝 | 返回 `step4_forecast_exceeds_approved_budget`；`reservedCny` 不变 |
| 损坏媒体 | 本地 FFmpeg 探测文本冒充的 MP4；另注入校验失败 | **真实本地探测 + 注入校验失败** | 拒绝 `step5_generation_media_probe_failed`；镜头保持 `accepted`，不写 completed 回执 | 预占保留；下次重试下载，不重新生成 |

补充：

- 预算预占会叠加计算。`chargedCny=7`、`reservedCny=0.9` 时，再预占 0.744 CNY 会被拒绝，防止并发请求绕过上限。
- 下载或媒体校验失败时，账本保留 `videoId`/音频地址和预占，避免“失败后重提”造成第二次付费；恢复后只补下载与结算。
- 供应商明确失败（`status=failed`）仍是终态，不会自动重提。

## 3. 预算落点

| 时点 | 实现 | 作用 |
|---|---|---|
| 提交前 | `assertCanReserve` + 钱包余额检查 | 检查 `charged + reserved + forecast <= approved`，余额不足直接拒绝 |
| `beforeSubmit` | 再次校验阶段、`paidSubmissions=0`、`requestId`、请求体哈希 | 防止换内容复用幂等键或重复提交 |
| 预占 | `reserve` 后立即持久化预算文件 | 崩溃后仍保留占用，不能静默授权第二次花费 |
| `onAccepted` | 写入供应商 `videoId` 与 `accepted` 回执 | 后续恢复只查询，不重新生成 |
| `onStatus` | 记录状态、时长、媒体域名 | 支持页面阶段展示与恢复 |
| 下载后 | 对比 `walletBefore/walletAfter` 与价格估算，`settle` 取较大值 | 记录实际扣费；钱包显示有舍入时以估算为下限 |
| 结束后 | `paidSubmissions += 1`、写 `operations` | 费用与提交次数可审计 |

当前账本：

- 批准上限 8 CNY
- 已记账 5.339473 CNY
- 预占 0 CNY
- 剩余 2.660527 CNY（约 0.398620 USD）
- 付费操作 6 次

账户侧：

- 钱包 1.35 USD；计费方式 wallet；自动充值关闭
- `accountSpendingCapConfigured=false`：**余额/自动充值状态不等于供应商硬上限**
- 真正阻止超支的是应用侧 8 CNY 账本；Step 7 没有扩大授权

## 4. 本轮代码调整

1. 下载或媒体校验失败时，把错误写入镜头账本的 `lastError`，但保持 `accepted` 阶段与预占，确保下次只重试下载，不重新提交。
2. 为 Step 4 预算错误补充中文文案，包括预占超限、批准上限变化、凭据变化、分镜变化和账本格式错误。
3. 新增 [interview/step7Boundaries.test.ts](../interview/step7Boundaries.test.ts) 8 项测试，覆盖上表全部场景；纳入 `pnpm test`。

## 5. 验证结果

| 项目 | 结果 | 说明 |
|---|---|---|
| Step 7 专项测试 | **8/8 PASS** | 401、429/5xx、状态查询 429、下载重试、真实损坏媒体、损坏媒体重试、预算不足、结算规则 |
| 主回归 | **128/128 PASS** | 原 120 项 + Step 7 8 项 |
| 队列回归 | **37/37 PASS** | 租约、恢复、回执合并等原有用例 |
| 类型检查 | **PASS** | `pnpm run typecheck` |
| 真实供应商调用（本轮 Step 7） | **0** | 未提交、未上传、未下载 |
| 付费提交 | **0** | 预算账本未变化 |
| 钱包 | **1.35 USD** | 同日早前只读查询；Step 7 测试未再调用供应商 |

## 6. 真实与模拟的边界

**真实触发：**

- 本地 FFmpeg 对损坏文件的探测与拒绝，使用真实 `ffmpeg-static`；
- Step 2 的真实只读 401（未发送凭据）；
- 此前 Step 6 的真实模式强杀恢复，但那是“已知 `video_id`”场景。

**注入模拟：**

- 创建请求 401/429/5xx；
- 状态查询 429；
- 媒体下载失败；
- 媒体校验失败；
- 预算不足（通过本地账本构造）。

本轮没有为了演示 429/5xx 或下载失败而向供应商制造真实流量，也没有为异常矩阵产生任何付费提交。

## 7. 未验证与后续

1. **真实 429/5xx、真实下载中断**未对供应商触发；当前结论来自受控注入与现有客户端错误分类。
2. **未知提交的真实对账**仍只在离线测试中验证；真实创建响应丢失场景未演练。
3. **真实页面触发的付费生成**仍未执行；Step 7 不改变这一边界。
4. **人工观看、听感/ASR、技术与创意审核**仍未完成。
5. 当前剩余预算约 2.660527 CNY，最多支持一次最小真实演示；异常重试空间有限，现场复跑额度需另行确认。

## 8. 安全与合规

- 测试使用假 Key `test-key-not-real`、临时目录和伪造客户端；没有读取真实 Key 进行异常注入。
- 未部署、未社媒发布；Step 7 执行期间未提交或推送，证据整理后已随 `step5-writeback` 推送（`2d58d2d`）。
- 推送内容不含 Key、`node_modules`、`data`、`.interview-data` 或带凭据的 URL。
- 证据中不含 Key、签名 URL、绝对路径或供应商临时下载地址。
- 没有关闭 TLS 校验，没有绕过预算账本，没有把产物状态改成 `succeeded`。

## 9. 相关文件

- `interview/step5Generation.ts`（下载/校验失败保留可恢复状态与错误）
- `interview/step5Pipeline.ts`（预算错误中文文案）
- `interview/step7Boundaries.test.ts`（新增 8 项异常/预算测试）
- `package.json`（测试套件纳入 Step 7）
- `evidence/step7-exception-budget.json`（机器可读摘要）
