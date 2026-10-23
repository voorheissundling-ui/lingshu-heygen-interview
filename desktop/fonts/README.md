# Bundled subtitle fonts

These original, unmodified fonts are loaded explicitly using FFmpeg's
`subtitles:fontsdir` option on both server and desktop. No host installation
or runtime download is required. The Docker source allowlist already copies
the entire `desktop/` directory. Each file is checked against the SHA-256 in
`../subtitle-template.json` before rendering subtitles.

| Role | Font | Upstream source | License |
| --- | --- | --- | --- |
| Yellow body | Source Han Sans SC Regular | https://github.com/adobe-fonts/source-han-sans/tree/release/OTF/SimplifiedChinese | SourceHanSans-LICENSE.txt |
| Red parameter | ZCOOL QingKe HuangYou Regular | https://github.com/google/fonts/tree/main/ofl/zcoolqingkehuangyou | ZCOOL-OFL.txt |
| Blue product | Smiley Sans Oblique 2.0.1 | https://github.com/atelier-anchor/smiley-sans/releases/tag/v2.0.1 | SmileySans-LICENSE.txt |

All three distributions include the SIL Open Font License 1.1. Preserve these
license files when distributing application builds. Smiley Sans archive
SHA-256: `299c0be6c960ae37361762eca76f7d0cd516615435bb96c0d4b98a1e70178a07`.

The template uses each font's real face without artificial bolding or skewing.
Product highlighting is limited to product names supplied by the production
context and already present in the narration. A subtitle page has at most one
special span: a product name takes priority, otherwise one numeric parameter.
Long-form explanations stay in the body font. `style.autoEmphasis=false`
disables both automatic highlight roles while preserving body subtitles.

Unsupported glyphs may use the renderer's fallback fonts. Existing screen
text and disclaimers retain their own placement and white styling.
