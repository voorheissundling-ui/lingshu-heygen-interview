# 参考片分析与分镜还原记录

本文件记录 Step 1 的参考片拆解、成片分镜映射和取舍。参考片只用于分析结构与信息顺序，不作为成片素材，也不上传给任何生成服务。

## 1. 参考片元数据

| 项目 | 值 |
|---|---|
| 文件 | `assets/reference-analysis-only.mp4` |
| 参考来源 | `https://www.tiktok.com/@yuchengcosmeticsfactory/video/7449962848203181354` |
| SHA-256 | `501ec2c4d39ce67630448eff7001e2f911561e962533ca1bdb6aa10e6d2388e9` |
| 时长 | 33.58 s |
| 分辨率 / 帧率 | 576 × 1024 / 30 fps（9:16 竖屏） |
| 画面语言 | 英语内嵌字幕；人物口播 + 产品/工厂空镜 |
| 使用边界 | 仅做结构与节奏分析；禁止原片像素、原声、人物身份、品牌标识进入成片 |

分析方法：

1. 用 FFmpeg 按 1 fps 生成 contact sheet，并抽取关键时间点的原始帧。
2. 逐帧读取画面内嵌英文字幕，按“钩子 → 产品/能力 → 工厂/质检 → CTA”归纳叙事段。
3. 本地 ASR（`whisper-tiny.en`，16 kHz 单声道）用于交叉验证分段边界。模型对品牌名和产品词有明显误听，因此引用口播时仍以**画面内嵌字幕**为准；ASR 的时间边界与字幕、画面一致，见 2.1。

## 2. 参考片分段表

| 时间段 | 画面 | 画面内字幕（按帧读取） | 叙事功能 |
|---|---|---|---|
| 0.0–5.0 s | 实验室/展厅内，白大褂女性出镜，正面近景，手势指向镜头 | “hello boss” → “Do you want to” → “customize your own brand” → “customize your own skincare products” | 开场钩子：直接点名目标客户，提出“做自己的品牌” |
| 5.0–12.0 s | 连续产品特写：手持/桌面展示不同品类 | “Repairing marks” → “whitening cream” → “liquid foundation” → “anti-wrinkle essence” → “massaging oil” → “shampoo and so on” | 展示品类广度，回答“能做什么产品” |
| 12.0–17.0 s | 实验室研发场景、灌装/包装画面、人物讲解 | “develop” → “best-selling products” → “according to your needs” | 研发与定制能力：可按需求开发 |
| 17.0–21.0 s | 白大褂人物出镜，配合手势与产品 | “Lowest MOQ” → “Lowest Price” → “From a cosmetics factory in China” → “with 15 years experience” | 核心卖点：低起订量、价格、工厂资历 |
| 21.0–27.0 s | 工厂产线、灌装线、质检/传送带特写 | “15 years of producing experience” → “you can be assured of the quality” | 实力证明：生产线与质检，建立信任 |
| 27.0–33.58 s | 人物回到镜头前，手势收尾；结尾有 “cut” 花絮 | “please contact me for product quotation” → “cut” | 明确 CTA：联系报价；花絮不属于有效叙事 |

结构摘要：**6 个信息节拍，人物口播作为锚点，产品特写与工厂画面作为证据，字幕承担信息密度，最后用直接 CTA 收束。**

### 2.1 ASR 交叉验证（whisper-tiny.en）

ASR 只用于确认“哪一段在讲什么”和分段边界，不作为逐字稿。下表保留模型原始输出，并给出对照字幕/画面后的含义：

| ASR 时间 | ASR 原文（含误听） | 对照字幕/画面后的含义 |
|---|---|---|
| 0.0–5.0 s | “Hello Vos, do you want to customize your own blend of skin care products?” | “Hello boss, do you want to customize your own brand of skincare products?” |
| 5.0–12.6 s | “We pair in Max, white and green, we pair foundation, I'm giving co-enses, massaging art, support and so on.” | 依次报出 repairing marks、whitening cream、liquid foundation、anti-wrinkle essence、massaging oil、shampoo 等品类 |
| 12.6–17.2 s | “We can develop and produce various best-selling products according to your needs.” | 与画面字幕“develop / best-selling products / according to your needs”一致 |
| 17.2–20.6 s | “Allow me and make you, allow me twice.” | “Lowest MOQ / Lowest Price” 的误听 |
| 20.6–25.2 s | “From a cosmetics fracture in China with 15 years of producer experience” | “From a cosmetics factory in China with 15 years experience” |
| 25.2–27.2 s | “you can rest assured of the party.” | “you can be assured of the quality” |
| 27.2–29.2 s | “If you are interested in massaging,” | 引出 CTA 的过渡句 |
| 29.2–33.2 s | “Please contact me for our last creation, Ka-ka-ka!” | “please contact me for product quotation”；结尾“cut cut cut”为花絮 |

结论：ASR 的分段边界（5.0 / 12.6 / 17.2 / 20.6 / 27.2 / 33.2 s）与 1 fps 抽帧看到的内容切换基本重合，说明上表的分段不是凭印象划分。具体英文文案以画面字幕为准。

## 3. 成片分镜映射

成片分镜文件为 `assets/storyboard.json`（SHA-256 `6d78d775752986ce5c3ea22b0b42cedea0825f80842f67b351406752e8791cf2`）。时长 33.5 s，6 个镜头，连续时间轴，3 个人物镜头 + 3 个说明图镜头。

| 时间 | 镜头 id | 类型 | 口播 | 字幕 | 对应参考段 | 保留 / 替换 |
|---|---|---|---|---|---|---|
| 0.0–5.0 | `hook` | 人物 | Hi there. Ready to launch your own skincare line? | Launch your own skincare line | 0–5 s 钩子 | 保留“直接点名 + 提问”的钩子；替换人物身份、声音、背景与措辞 |
| 5.0–11.5 | `product-range` | 说明图 | From brightening serums to gentle cleansers, we turn your formula into a retail-ready product. | Serums, creams, cleansers — retail-ready | 5–12 s 产品品类 | 保留品类展示的信息功能；用原创矢量产品图替换原片产品特写 |
| 11.5–16.0 | `capabilities` | 人物 | Low minimums, transparent pricing, and packaging that fits your brand. | Low MOQs. Clear pricing. Your branding. | 17–21 s 卖点 | 保留低起订量/价格/品牌包装三卖点；措辞重写 |
| 16.0–21.5 | `lab-process` | 说明图 | Our lab tests every batch for stability, texture, and safety before production. | Every batch tested for stability and safety | 12–17 s 研发/实验室 | 保留“实验室验证”证据；用原创流程图替换原片实验室场景 |
| 21.5–26.5 | `factory-quality` | 说明图 | Then our automated line fills, seals, and inspects each unit for a consistent finish. | Automated filling, sealing, and QC | 21–27 s 产线/质检 | 保留“自动化产线 + 质检”的信任证据；用原创产线插画替换原片工厂画面 |
| 26.5–33.5 | `cta` | 人物 | Fifteen years of skincare manufacturing, with documentation from sample to shipment. Contact us for a quote. | 15 years of manufacturing. Contact us for a quote. | 27–33.58 s CTA | 保留“资历数字 + 直接报价 CTA”；删除“cut”花絮 |

> 演示文案声明：分镜和插画中的 “15 years”“Low MOQ”“100% batch checks” 等，是为了还原参考片的信息功能而写的演示文案，不代表任何真实客户的已核验事实。正式发布前必须替换为客户书面确认的文案、数字和资质表述。

## 4. 还原与取舍

### 4.1 保留的结构

- **同一信息顺序**：开场钩子 → 产品/能力 → 研发与工厂证据 → 结尾 CTA。
- **同一节奏目标**：参考片 33.58 s；成片 33.5 s，落在题目的 30–37 s 区间内。
- **同一画幅**：9:16 竖屏；成片为 1080 × 1920，参考片为 576 × 1024。
- **人物锚点 + 说明镜头交替**：成片 3 个人物镜头负责口播和情绪，3 个说明图镜头负责产品、研发和产线证据，避免全程“数字人头”单调，也满足 ≥2 人物 + ≥2 说明的验收条件。
- **字幕与口播一致**：每个镜头的 `subtitle` 都是对同一镜头 `speech` 的压缩复述，不引入口播中没有的信息。

### 4.2 明确不复制的内容

- **不复制原片像素**：成片的三个说明镜头全部由 `assets/illustrations/generate.mjs` 在本地生成，没有截取、描摹或合成参考片画面。
- **不复制原声与人物身份**：成片使用 HeyGen 公共授权形象与公共声音；不使用参考片人物、声音或克隆授权。
- **不复制品牌标识**：插画中没有参考片品牌名、logo、包装文字或可识别产品外观。
- **不照搬字幕文案**：只保留信息功能和卖点类别，英文口播/字幕按本项目重新撰写。
- **不保留花絮**：参考片结尾的 “cut” 花絮不进入成片。

### 4.3 取舍与风险

- **真实感 vs. 版权边界**：参考片的产品特写和工厂画面更有实拍说服力，但这些像素不能使用；成片改用原创矢量插画，视觉更统一、版权可控，但产品与工厂的“实拍真实感”会下降。成片用具体数字（15 年、低 MOQ、逐批测试）和流程信息补偿这一点。
- **信息密度 vs. 可读性**：参考片字幕切换很快；成片把字幕限制在每条 140 字符以内，并由合成器单独渲染，优先保证可读性。
- **人物外观**：公共数字人的外观与参考片人物不同，这是刻意的身份隔离；Step 2 会再次通过公共目录核验 avatar/voice，并在成片预览中检查构图与口型。
- **说明镜头的声音**：分镜为三个说明镜头也写了口播文本，目的是让字幕与旁白保持连续。Step 2 需要明确实现方式（例如从 HeyGen 生成音轨后复用到说明镜头，或为说明镜头生成独立旁白），不能把“有字幕但没有声音”当成已完成验收。

## 5. 素材来源与许可

| 文件 | 尺寸 | SHA-256 | 来源 / 许可 |
|---|---|---|---|
| `assets/illustrations/product-range.png` | 1080 × 1920 | `c2a61d025cbcb18c78918d427539500681fbc32d702d3821c85fe7d0fcf4b527` | 本地原创矢量插画；本练习 CC0-1.0 |
| `assets/illustrations/lab-process.png` | 1080 × 1920 | `22cefda4945b988d0d2a7af16d542726f6cbe4d8ba132185a389d0cdbfa7bf5d` | 本地原创矢量插画；本练习 CC0-1.0 |
| `assets/illustrations/factory-quality.png` | 1080 × 1920 | `20a088bd24716f2571302c512d0e49d9001b6b28e76b256fa82fb2a5c6e8c11c` | 本地原创矢量插画；本练习 CC0-1.0 |

插画的生成方式、原创性说明和重新生成命令见 `assets/illustrations/README.md`。

## 6. 可复核命令

```bash
# 分镜结构与素材文件校验
pnpm run storyboard:validate

# 分镜校验单元测试（含时间轴、数量、来源、租户字段等）
node --import ./interview/bootstrap.mjs --import tsx --test interview/storyboard.test.ts

# 查看已保存分镜的 API 响应（只读，不触发生成）
curl http://127.0.0.1:4318/api/storyboard

# 通过 API 校验并原子写入（写入前会再次检查素材文件）
curl -X POST -H 'Content-Type: application/json' \
  --data-binary @assets/storyboard.json \
  http://127.0.0.1:4318/api/storyboard
```

## 7. 验收状态

- [x] 参考片时长、画幅、节拍和字幕结构已记录。
- [x] 参考片已做 1 fps 抽帧与 ASR 交叉验证；ASR 的误听已在 2.1 标注。
- [x] 成片分镜为 30–37 s、连续时间轴、3 人物 + 3 说明图。
- [x] 说明素材均为本地原创，来源、许可、作者齐全。
- [x] 分镜不含参考片像素、参考片 URL、客户端租户字段或占位 ID。
- [x] 页面支持导入、编辑、预览和字段级错误展示；读取/预览不触发生成。
- [x] Step 2：真实模式和公开人物证据校验路径已实现；HeyGen 经系统代理可达，官方 Photo Avatar 价格已取得；真实只读预检已确认钱包 wallet/USD、余额 2.3、自动充值关闭，分镜公共 avatar/voice 均通过。公共目录在 20 页处截断，但目标 ID 已在前 1000 条中找到并验证。
- [x] Step 3：公共人物运行时绑定与独立单镜头闭环已实现并测试；在 10 CNY 预算内完成 1 次真实提交，取得 3.21306 s、720×1280/H.264/AAC 的 MP4，全片解码通过，钱包 2.30→2.15 USD。证据见 `evidence/step3-single-shot.mp4` 与 `.json`。
- [ ] Step 3 遗留（Step 4 处理）：原始 9:16 输出上下白边明显（内容区约 720×408），且公共人物为西装办公室风格，与分镜“实验室白大褂”不一致；需在渲染层裁切/模糊填充或改原生竖屏 look，不得手工改最终视频。
- [ ] 真实 API 完整业务链路、多镜头成片合成、人工听感/ASR 与人工审核仍待后续步骤。
