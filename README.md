# AI全栈工程师实操：数字员工 × HeyGen

基线：`20fe685fa87c33680e3cc079fac62dcd07e0272a`。

> **交付状态（2026-10-24）**：分镜导入 → HeyGen 生成 → 查询/下载 → 合成 → 原任务回写 → 页面播放/下载的全链路已完成，最终成片为 33.52 s、1080×1920、Brodie 英文男声，artifact `socialart_ae42c3e4f47b90c0dbdbc554`，状态 `review_required`。已在全新克隆中复验独立启动、成片/任务记录、重复执行与中断恢复（见 [evidence/step8-clean-acceptance.md](evidence/step8-clean-acceptance.md)），并修复 Windows 换行导致的 storyboard 哈希漂移。实现与取舍见 [SOLUTION.md](SOLUTION.md)，启动/恢复/回滚见 [OPERATIONS.md](OPERATIONS.md)，音色修订证据见 [evidence/voice-fix-brodie.md](evidence/voice-fix-brodie.md)，其余执行证据见 [evidence/](evidence/)。人工看片/听感、ASR 校对与 3–5 分钟演示录制仍由验收人完成。

**以下保留出题方原始说明。** 本包最初为供审阅的面试包；已附可解码的历史缓存参考片。真实短片探针不是完整数字员工链路，不能替代候选人交付。

本题目标：基于真实模块，完成单条数字员工任务，从导入脚本分镜、提交HeyGen、查询下载、素材合成、持久保存，到原任务结果回写与页面播放下载。详见 `docs/01-任务与验收.md`、`docs/04-模块现状与验收矩阵.md`。

## 先验证本地环境

Node.js >=22.19.0；已测试Node.js 24.19.0、pnpm 11.25.0，macOS arm64。其他系统未实测。首次安装需联网下载依赖和FFmpeg，无需生产库或Docker。

```sh
pnpm install --frozen-lockfile
pnpm run doctor
pnpm run typecheck
pnpm test
pnpm run test:queue
pnpm run smoke
pnpm run verify
pnpm run dev
```

访问 http://127.0.0.1:4318 。`smoke`重置本包数据并执行本地合成→原队列与结果回写；测试片为合成画面和音调，不能代表真实口播。`verify`须在smoke后执行，检查租户和实际媒体完整性。下载入口为 `/api/media?artifactId=<产物ID>&download=1`。

`pnpm run seed`重置本包初始化数据；`pnpm run render`和`pnpm run scan`分别执行受控本地生产与周任务结算。先seed再scan会遇到已记录的素材阻塞，见验收矩阵。当前页面为验证页，需要候选人完善工作台。

## 本地与真实供应商模式

`interview/bootstrap.mjs`用于离线测试：清理子进程继承的密钥，并拦截外网。**当前render/smoke命令不会使用HeyGen。** 不应仅删除拦截就认定已接入供应商。候选人应建立显式真实模式，保留离线回归，并沿原队列和业务命令接入已有HeyGen模块。

`pnpm run provider:preflight`只读检查真实账号、公共人物和声音接口。运行前由出题方单独交付Key文件，通过环境变量HEYGEN_KEY_FILE指定路径；Key不写入包内。该命令不提交生成，不证明额度足够或生成可用。生成前还必须确认金额/币种上限及预算控制。

## 交付和边界

本包附真实导入依赖约1100个源码文件，不要求逐一重构。核心范围见代码地图。来源源码除阅读注释外保留基线；SOURCE_MANIFEST.json记录来源和哈希。本包不含原Git历史、生产数据和凭据，私下交付，不上传public仓库。

本地启动、参考片及一次真实短片已验证，24小时时限仍须双方确认T0。候选人Key与额度另行交付，环境及供应商阻塞时暂停计时。不承诺4–8小时完成全部工作，必做范围限单条任务。允许AI，须提交可复现代码、完整MP4和运行记录，现场修改口播复跑。

参考文件：assets/reference-analysis-only.mp4，33.58秒，576×1024，SHA256见同目录provenance文件。历史验收记录将其哈希关联到所给TikTok链接，本次未重新验证在线URL身份；本轮以附件文件为共同参考，不沿用历史自动分析的镜头清单。原片仅供分析，不剪入成片。

真实供应商证据：evidence/heygen-short-probe.mp4及JSON。使用原HeyGenClient，单次提交，产出2.06367秒视频，账户余额减少0.10美元。尚未接通完整任务入口、bridge及分镜生产链，亦未设置供应商账户硬限额。
