# 原创说明图素材

这三个 9:16 画面是 Step 1 的成片说明镜头素材，全部由 `assets/illustrations/generate.mjs` 在本地用 SVG + `sharp` 生成。它们不是参考片截图，也不是网络图片。

## 文件清单

| 文件 | 尺寸 | SHA-256 | 许可 | 作者 |
|---|---|---|---|---|
| `product-range.png` | 1080 × 1920 | `c2a61d025cbcb18c78918d427539500681fbc32d702d3821c85fe7d0fcf4b527` | 本练习 CC0-1.0 | Interview candidate (generated locally) |
| `lab-process.png` | 1080 × 1920 | `22cefda4945b988d0d2a7af16d542726f6cbe4d8ba132185a389d0cdbfa7bf5d` | 本练习 CC0-1.0 | Interview candidate (generated locally) |
| `factory-quality.png` | 1080 × 1920 | `20a088bd24716f2571302c512d0e49d9001b6b28e76b256fa82fb2a5c6e8c11c` | 本练习 CC0-1.0 | Interview candidate (generated locally) |

对应分镜：

- `product-range.png` → `product-range`（5.0–11.5 s）
- `lab-process.png` → `lab-process`（16.0–21.5 s）
- `factory-quality.png` → `factory-quality`（21.5–26.5 s）

## 原创性说明

- 画面由代码中的几何图形、渐变和文字直接绘制，没有下载照片、图标包、贴图或参考片像素。
- 没有参考片品牌名、logo、包装外观、人物肖像或可识别店铺元素。
- 画面中的产品名（如 `BRIGHTENING SERUM`、`BARRIER CREAM`）和宣传语（如 `Low MOQ`、`100% batch checks`、`15 years`）是**演示文案**，不是对任何真实客户的事实陈述；正式发布前必须替换为客户已确认的文案和数据。
- SVG 使用 `Arial, Helvetica, sans-serif` 作为系统字体回退。仓库不下载、不打包、不再分发字体文件；如果后续要做严格的字体许可审计，可把 `generate.mjs` 中的字体族切换为开源字体（例如 Noto Sans）后重新生成。

## 重新生成

从仓库根目录运行：

```bash
pnpm run assets:generate
# 等价于：node assets/illustrations/generate.mjs
```

生成器会覆盖同名 PNG。相同依赖版本、相同系统字体下应得到相同字节；如需确认，重新生成后执行：

```bash
sha256sum assets/illustrations/*.png
```

并对照上表。若哈希变化，先检查 `sharp` 版本、系统字体或生成脚本是否有改动，再把新哈希同步到 `assets/reference-analysis.md` 和 `assets/storyboard.json` 的来源说明中。

## 使用边界

- 只用于本练习的成片和验收记录，不把参考片内容混入这些素材。
- 不把说明图中的文字当作真实功效、认证或产能承诺。
- 不把参考片的品牌、人物、声音或字幕文案导入生成器。
