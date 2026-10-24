/**
 * Generates the three original 9:16 illustration plates used by the
 * storyboard. Everything is drawn locally as SVG and rasterised with sharp;
 * there are no downloaded photos, brand assets, or reference-video pixels.
 *
 * Run from the repository root:
 *   node assets/illustrations/generate.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const outDir = path.dirname(fileURLToPath(import.meta.url));
const W = 1080;
const H = 1920;

const esc = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function shell(content, accent = '#5eead4', plate = '01 / 03') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#07111f"/>
      <stop offset="0.55" stop-color="#0d1b2a"/>
      <stop offset="1" stop-color="#13283a"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.12" cy="0.06" r="0.6">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.24"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.92" cy="0.94" r="0.55">
      <stop offset="0" stop-color="#38bdf8" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
      <path d="M60 0H0V60" fill="none" stroke="#7dd3fc" stroke-opacity="0.055" stroke-width="1"/>
    </pattern>
    <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0e2536"/>
      <stop offset="1" stop-color="#0a1a27"/>
    </linearGradient>
    <linearGradient id="mint" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#38bdf8"/>
    </linearGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbbf24"/>
      <stop offset="1" stop-color="#fb7185"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <circle cx="90" cy="70" r="620" fill="url(#glowA)"/>
  <circle cx="1020" cy="1850" r="620" fill="url(#glowB)"/>
  <rect x="48" y="48" width="${W - 96}" height="${H - 96}" rx="42" fill="none" stroke="#7dd3fc" stroke-opacity="0.12" stroke-width="2"/>
  ${content}
  <text x="80" y="1830" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#94a3b8">ORIGINAL VECTOR ILLUSTRATION · NO BRAND MARKS · 9:16</text>
  <text x="1000" y="1830" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#475569">${plate}</text>
</svg>`;
}

function heading(kicker, line1, line2, subtitle) {
  return `<text x="80" y="200" font-family="Arial, Helvetica, sans-serif" font-size="24" letter-spacing="5" fill="#5eead4">${esc(kicker)}</text>
  <text x="80" y="330" font-family="Arial, Helvetica, sans-serif" font-size="92" font-weight="700" fill="#f8fafc">${esc(line1)}</text>
  <text x="80" y="435" font-family="Arial, Helvetica, sans-serif" font-size="92" font-weight="700" fill="url(#mint)">${esc(line2)}</text>
  <text x="80" y="505" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#94a3b8">${esc(subtitle)}</text>`;
}

function card(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="32" fill="url(#card)" stroke="#5eead4" stroke-opacity="0.18"/>
  <rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="86" rx="31" fill="#5eead4" fill-opacity="0.05"/>`;
}

const productRange = shell(`
  ${heading('PRIVATE-LABEL', 'YOUR FORMULA.', 'YOUR BRAND.', 'A flexible skincare range, built around your brief.')}

  ${card(80, 570, 440, 420)}
  <g transform="translate(300 690)">
    <rect x="-34" y="20" width="68" height="120" rx="16" fill="#f59e0b" fill-opacity="0.24" stroke="#fbbf24"/>
    <rect x="-22" y="4" width="44" height="24" rx="6" fill="#fbbf24"/>
    <rect x="-13" y="-38" width="26" height="46" rx="8" fill="#e2e8f0" fill-opacity="0.85"/>
    <line x1="0" y1="-38" x2="0" y2="2" stroke="#e2e8f0" stroke-width="6"/>
    <circle cx="0" cy="80" r="10" fill="#fbbf24" fill-opacity="0.7"/>
  </g>
  <text x="300" y="900" text-anchor="middle" font-family="Arial" font-size="30" font-weight="700" fill="#f8fafc">BRIGHTENING SERUM</text>
  <text x="300" y="940" text-anchor="middle" font-family="Arial" font-size="22" fill="#94a3b8">Vitamin C · 30 ml</text>

  ${card(560, 570, 440, 420)}
  <g transform="translate(780 720)">
    <rect x="-78" y="-6" width="156" height="96" rx="26" fill="#22d3ee" fill-opacity="0.18" stroke="#67e8f9"/>
    <rect x="-88" y="-42" width="176" height="40" rx="14" fill="#67e8f9"/>
    <rect x="-60" y="18" width="120" height="10" rx="5" fill="#67e8f9" fill-opacity="0.5"/>
    <text x="0" y="62" text-anchor="middle" font-family="Arial" font-size="16" fill="#67e8f9">CREAM</text>
  </g>
  <text x="780" y="900" text-anchor="middle" font-family="Arial" font-size="30" font-weight="700" fill="#f8fafc">BARRIER CREAM</text>
  <text x="780" y="940" text-anchor="middle" font-family="Arial" font-size="22" fill="#94a3b8">Ceramide · 50 ml</text>

  ${card(80, 1030, 440, 420)}
  <g transform="translate(300 1150)">
    <rect x="-38" y="10" width="76" height="150" rx="18" fill="#34d399" fill-opacity="0.16" stroke="#6ee7b7"/>
    <rect x="-18" y="-42" width="36" height="56" rx="8" fill="#6ee7b7"/>
    <path d="M-18 -42 H-52 V-66 H18 V-42" fill="none" stroke="#6ee7b7" stroke-width="8" stroke-linecap="round"/>
    <rect x="-24" y="52" width="48" height="58" rx="10" fill="#6ee7b7" fill-opacity="0.25"/>
  </g>
  <text x="300" y="1360" text-anchor="middle" font-family="Arial" font-size="30" font-weight="700" fill="#f8fafc">GENTLE CLEANSER</text>
  <text x="300" y="1400" text-anchor="middle" font-family="Arial" font-size="22" fill="#94a3b8">pH balanced · 150 ml</text>

  ${card(560, 1030, 440, 420)}
  <g transform="translate(780 1150)">
    <path d="M-44 -60 H44 L58 100 Q58 128 30 128 H-30 Q-58 128 -58 100 Z" fill="#fb7185" fill-opacity="0.16" stroke="#fda4af"/>
    <rect x="-52" y="-92" width="104" height="36" rx="12" fill="#fda4af"/>
    <rect x="-34" y="0" width="68" height="70" rx="10" fill="#fda4af" fill-opacity="0.22"/>
    <text x="0" y="48" text-anchor="middle" font-family="Arial" font-size="18" fill="#fda4af">SPF 50</text>
  </g>
  <text x="780" y="1360" text-anchor="middle" font-family="Arial" font-size="30" font-weight="700" fill="#f8fafc">MINERAL SUNSCREEN</text>
  <text x="780" y="1400" text-anchor="middle" font-family="Arial" font-size="22" fill="#94a3b8">Zinc oxide · 50 ml</text>

  <rect x="80" y="1545" width="920" height="150" rx="34" fill="#0f2a38" stroke="#5eead4" stroke-opacity="0.3"/>
  <text x="540" y="1610" text-anchor="middle" font-family="Arial" font-size="24" letter-spacing="3" fill="#5eead4">CUSTOM FORMULA · CUSTOM PACKAGING</text>
  <text x="540" y="1662" text-anchor="middle" font-family="Arial" font-size="34" font-weight="700" fill="#f8fafc">Low MOQ. Retail-ready.</text>
`, '#5eead4');

const labProcess = shell(`
  ${heading('R&D TO PRODUCTION', 'FROM FORMULA', 'TO FINISH.', 'A documented path from bench sample to sealed unit.')}

  <line x1="160" y1="760" x2="160" y2="1450" stroke="#5eead4" stroke-opacity="0.3" stroke-width="4" stroke-dasharray="10 14"/>

  ${card(90, 560, 900, 330)}
  <circle cx="160" cy="680" r="44" fill="#5eead4" fill-opacity="0.14" stroke="#5eead4"/>
  <text x="160" y="696" text-anchor="middle" font-family="Arial" font-size="34" font-weight="700" fill="#5eead4">1</text>
  <text x="250" y="670" font-family="Arial" font-size="42" font-weight="700" fill="#f8fafc">FORMULATE</text>
  <text x="250" y="718" font-family="Arial" font-size="26" fill="#94a3b8">Bench samples, measured and documented.</text>
  <g transform="translate(820 690)">
    <path d="M-34 -60 H34 V-18 L62 48 Q70 68 48 68 H-48 Q-70 68 -62 48 L-34 -18 Z" fill="none" stroke="#5eead4" stroke-width="7"/>
    <path d="M-46 30 H46 L58 54 Q62 68 46 68 H-46 Q-62 68 -58 54 Z" fill="#5eead4" fill-opacity="0.3"/>
    <line x1="-20" y1="-78" x2="20" y2="-78" stroke="#5eead4" stroke-width="8" stroke-linecap="round"/>
  </g>

  ${card(90, 930, 900, 330)}
  <circle cx="160" cy="1050" r="44" fill="#38bdf8" fill-opacity="0.14" stroke="#38bdf8"/>
  <text x="160" y="1066" text-anchor="middle" font-family="Arial" font-size="34" font-weight="700" fill="#38bdf8">2</text>
  <text x="250" y="1040" font-family="Arial" font-size="42" font-weight="700" fill="#f8fafc">TEST</text>
  <text x="250" y="1088" font-family="Arial" font-size="26" fill="#94a3b8">Stability, texture, and safety checks.</text>
  <g transform="translate(820 1060)">
    <path d="M0 -72 L58 -48 V4 Q58 52 0 74 Q-58 52 -58 4 V-48 Z" fill="none" stroke="#38bdf8" stroke-width="7"/>
    <path d="M-22 2 L-4 22 L28 -18" fill="none" stroke="#38bdf8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  ${card(90, 1300, 900, 330)}
  <circle cx="160" cy="1420" r="44" fill="#fbbf24" fill-opacity="0.14" stroke="#fbbf24"/>
  <text x="160" y="1436" text-anchor="middle" font-family="Arial" font-size="34" font-weight="700" fill="#fbbf24">3</text>
  <text x="250" y="1410" font-family="Arial" font-size="42" font-weight="700" fill="#f8fafc">FILL &amp; SEAL</text>
  <text x="250" y="1458" font-family="Arial" font-size="26" fill="#94a3b8">Automated filling and sealed packaging.</text>
  <g transform="translate(820 1430)">
    <rect x="-34" y="-46" width="68" height="122" rx="18" fill="none" stroke="#fbbf24" stroke-width="7"/>
    <rect x="-20" y="-78" width="40" height="34" rx="8" fill="#fbbf24" fill-opacity="0.35" stroke="#fbbf24" stroke-width="6"/>
    <line x1="-16" y1="10" x2="16" y2="10" stroke="#fbbf24" stroke-width="6" stroke-linecap="round"/>
    <line x1="-16" y1="34" x2="10" y2="34" stroke="#fbbf24" stroke-width="6" stroke-linecap="round"/>
  </g>

  <rect x="90" y="1680" width="900" height="90" rx="28" fill="#0f2a38" stroke="#5eead4" stroke-opacity="0.25"/>
  <text x="540" y="1737" text-anchor="middle" font-family="Arial" font-size="28" fill="#cbd5e1">Batch records at every step.</text>
`, '#38bdf8', '02 / 03');

const factoryQuality = shell(`
  ${heading('FACTORY & QUALITY', 'CONSISTENT', 'BY DESIGN.', 'Filling. Sealing. Inspection. Every run.')}

  <rect x="70" y="760" width="940" height="260" rx="40" fill="#0c2130" stroke="#5eead4" stroke-opacity="0.22"/>
  <rect x="110" y="930" width="860" height="34" rx="17" fill="#5eead4" fill-opacity="0.18"/>
  <circle cx="170" cy="1000" r="18" fill="#5eead4" fill-opacity="0.25"/>
  <circle cx="290" cy="1000" r="18" fill="#5eead4" fill-opacity="0.25"/>
  <circle cx="410" cy="1000" r="18" fill="#5eead4" fill-opacity="0.25"/>
  <circle cx="530" cy="1000" r="18" fill="#5eead4" fill-opacity="0.25"/>
  <circle cx="650" cy="1000" r="18" fill="#5eead4" fill-opacity="0.25"/>
  <circle cx="770" cy="1000" r="18" fill="#5eead4" fill-opacity="0.25"/>
  <circle cx="890" cy="1000" r="18" fill="#5eead4" fill-opacity="0.25"/>

  <g transform="translate(270 820)">
    <rect x="-36" y="20" width="72" height="110" rx="16" fill="#f8fafc" fill-opacity="0.9"/>
    <rect x="-22" y="-20" width="44" height="42" rx="8" fill="#5eead4"/>
    <rect x="-26" y="52" width="52" height="46" rx="8" fill="#0d1b2a" fill-opacity="0.18"/>
  </g>
  <g transform="translate(470 800)">
    <rect x="-42" y="10" width="84" height="130" rx="18" fill="#fbbf24" fill-opacity="0.9"/>
    <rect x="-26" y="-30" width="52" height="42" rx="8" fill="#f8fafc"/>
    <rect x="-30" y="46" width="60" height="54" rx="8" fill="#f8fafc" fill-opacity="0.3"/>
  </g>
  <g transform="translate(670 810)">
    <rect x="-38" y="18" width="76" height="122" rx="16" fill="#38bdf8" fill-opacity="0.85"/>
    <rect x="-24" y="-24" width="48" height="44" rx="8" fill="#f8fafc"/>
    <circle cx="0" cy="78" r="20" fill="#f8fafc" fill-opacity="0.35"/>
  </g>

  <g transform="translate(850 700)">
    <rect x="-46" y="-150" width="92" height="250" rx="26" fill="none" stroke="#5eead4" stroke-width="6" stroke-dasharray="12 12"/>
    <line x1="-46" y1="10" x2="46" y2="10" stroke="#5eead4" stroke-width="8"/>
    <circle cx="0" cy="-190" r="38" fill="#5eead4" fill-opacity="0.16" stroke="#5eead4" stroke-width="5"/>
    <path d="M-16 -192 L-4 -178 L18 -204" fill="none" stroke="#5eead4" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <text x="540" y="1160" text-anchor="middle" font-family="Arial" font-size="24" letter-spacing="3" fill="#5eead4">AUTOMATED LINE · INLINE INSPECTION</text>

  <g>
    <rect x="90" y="1260" width="900" height="112" rx="28" fill="#0f2a38" stroke="#5eead4" stroke-opacity="0.2"/>
    <circle cx="150" cy="1316" r="24" fill="#5eead4" fill-opacity="0.16"/>
    <path d="M138 1316 L146 1326 L164 1306" fill="none" stroke="#5eead4" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="200" y="1327" font-family="Arial" font-size="30" fill="#f8fafc">100% batch checks</text>
    <text x="940" y="1327" text-anchor="end" font-family="Arial" font-size="24" fill="#94a3b8">QC</text>
  </g>
  <g>
    <rect x="90" y="1392" width="900" height="112" rx="28" fill="#0f2a38" stroke="#5eead4" stroke-opacity="0.2"/>
    <circle cx="150" cy="1448" r="24" fill="#38bdf8" fill-opacity="0.16"/>
    <path d="M138 1448 L146 1458 L164 1438" fill="none" stroke="#38bdf8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="200" y="1459" font-family="Arial" font-size="30" fill="#f8fafc">Documented QC records</text>
    <text x="940" y="1459" text-anchor="end" font-family="Arial" font-size="24" fill="#94a3b8">LOT</text>
  </g>
  <g>
    <rect x="90" y="1524" width="900" height="112" rx="28" fill="#0f2a38" stroke="#5eead4" stroke-opacity="0.2"/>
    <circle cx="150" cy="1580" r="24" fill="#fbbf24" fill-opacity="0.16"/>
    <path d="M138 1580 L146 1590 L164 1570" fill="none" stroke="#fbbf24" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="200" y="1591" font-family="Arial" font-size="30" fill="#f8fafc">Retail-ready packing</text>
    <text x="940" y="1591" text-anchor="end" font-family="Arial" font-size="24" fill="#94a3b8">BOX</text>
  </g>
`, '#fbbf24', '03 / 03');

await fs.mkdir(outDir, { recursive: true });
for (const [name, svg] of [
  ['product-range.png', productRange],
  ['lab-process.png', labProcess],
  ['factory-quality.png', factoryQuality],
]) {
  const file = path.join(outDir, name);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
  const meta = await sharp(file).metadata();
  console.log(`${name}: ${meta.width}x${meta.height}, ${(await fs.stat(file)).size} bytes`);
}
