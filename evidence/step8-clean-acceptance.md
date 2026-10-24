# 干净环境验收：独立启动、成片/任务记录、重复执行与中断恢复

**日期**：2026-10-24
**提交**：`64ce85c`
**环境**：Windows 11 x64、Node v25.5.0、pnpm 11.25.0，`core.autocrlf=true`
**隔离方式**：全新克隆到 `D:/tmp/accept-clean`，无 `node_modules`、无 `.interview-data`、无 Key；全程离线（未调用供应商，未产生费用）。

## 1. 结论

按 README / OPERATIONS 从零启动可以通过，成片、任务记录、重复执行和中断恢复均已复验。过程中发现并修复了一个**会直接卡住 Windows 干净环境验收**的问题（换行符导致 storyboard 哈希漂移）。

| 验收动作 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm run doctor` | PASS（ffmpeg 6.1.1，无需供应商/数据库/凭据） |
| `pnpm run typecheck` | PASS |
| `pnpm test` | 129/129 |
| `pnpm run test:queue` | 37/37 |
| `pnpm run smoke` / `pnpm run verify` | PASS / PASS |
| 页面 `GET /` | 200 |
| `POST /api/start`（reuse） | `review_required` |
| 成片 | 33.52 s、1080×1920、h264/aac、7,701,275 bytes、SHA `632b0a50…189ed7` |
| 播放 / 下载 | 均 200，下载 SHA 与成片一致 |
| 任务记录 | weekly `succeeded`；job/artifact/file 各 1 条；artifact `review_required` |
| 重复启动 | `already_complete`，记录不增加 |
| 合成中强制杀进程后重启 | 从落盘 phase 续跑，同一成片哈希；0 次新提交、0 新增费用 |

截图：[step8-clean-page.png](step8-clean-page.png)

## 2. 发现并修复：CRLF 导致 storyboard SHA 漂移

- **现象**：首次干净克隆跑 `pnpm test` 失败，`saved.sha256=ce3de043…`（LF）与 `loaded.sha256=6b6a43d1…`（CRLF）不一致。
- **原因**：Windows 的 `core.autocrlf=true` 在检出时把 `assets/storyboard.json` 转成 CRLF；storyboard SHA-256 按文件原始字节计算，而任务身份、Step 4/5 状态和证据都引用该哈希。
- **修复**：新增 [.gitattributes](../.gitattributes)，`* text=auto eol=lf`，媒体文件标记 `binary`。重新克隆后文件为 LF，SHA 恢复为 `ce3de043…c86a6`，129 项回归通过。
- **影响**：修复前“按说明独立启动”在 Windows 上会失败，属于验收阻塞项；修复后通过。

## 3. 独立启动（reuse）

从干净克隆执行：

```bash
pnpm install --frozen-lockfile
pnpm run seed
PORT=4320 pnpm run dev
# 页面点击“启动任务”等价于：
curl -X POST http://127.0.0.1:4320/api/start -H 'Content-Type: application/json' -d '{"mode":"reuse"}'
```

- 干净仓库没有 `.interview-data/step4-*`，管线按设计以 `reused-verified-evidence` 复用已提交的 `evidence/step4-final.mp4`，未访问供应商。
- 本次生成本地 artifact `socialart_3978fbbe96419f5901ef0836`、file `socialfile_0cebb5aadda2eca1561e5369`，均 `review_required`，周任务 `succeeded`。
- 页面播放器在无头 Chrome 中显示 0:00 属已知媒体限制；以 `/api/media?...&download=1` 的字节与 SHA 作为成片核验依据。

## 4. 重复执行

完成后再 `POST /api/start` 返回 `already_complete`；job/artifact/file 仍各 1 条，`completedAt` 不变。

## 5. 中断恢复

为获得可观察的合成窗口，把本机 Step 4 媒体与 state 复制进克隆目录（仍为 reuse，无付费）：

1. `seed` 后启动，`POST /api/start`，停在 `compositing`。
2. `Stop-Process -Force` 强杀服务；端口关闭，`step5/state.json` 保留 `phase=compositing`。
3. 用相同命令重启，再次 `POST /api/start`：`submitting → compositing → writing_back → review_required`。
4. 结果：成片 `632b0a50…` 与主交付一致；`paidSubmissions=6`（Step 4 历史账本）、无新增提交与扣费；artifact/file 各 1 条；再次启动 `already_complete`。

## 6. 仍需验收人完成

- 人工完整看片/听感与 ASR 逐字校对（自动化只覆盖时长、分辨率、编码、字幕帧、响度与基频）。
- 3–5 分钟演示录屏未随仓库交付。
- 真实模式付费生成（`generate`）未在干净克隆重跑；该路径需要真实 Key 与预算，本次用 `reuse` 验收。
- 供应商账户未设置消费硬上限；应用侧闸门为 8 CNY。
