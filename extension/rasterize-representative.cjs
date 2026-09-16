const { chromium } = require('playwright');
const fs = require('fs');
// Representative listing image for the supplied 2.svg mark. This intentionally
// uses the same full-bleed tile and glyph as rasterize-icon.cjs. The palette in
// src/core/palette.js remains the single source of truth for brand colours.
(async () => {
  const fontPath = process.env.MINITOK_HARLEKIN_FONT;
  if (!fontPath || !fs.existsSync(fontPath)) throw new Error('Set MINITOK_HARLEKIN_FONT to the licensed Harlekin WOFF2 before rasterizing');
  const font = fs.readFileSync(fontPath).toString('base64');
  const fontStyle = font ? `<style>@font-face{font-family:Harlekin;src:url(data:font/woff2;base64,${font}) format('woff2')}</style>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">${fontStyle}<rect x="4.6863" y="4.6863" width="22.6274" height="22.6274" rx="4.682" transform="rotate(45 16 16)" fill="#013DCF"/><text x="12.1" y="12.2" dy="0.04em" dominant-baseline="central" font-family="Harlekin,system-ui,sans-serif" font-size="34" font-weight="400" fill="#FFFFFF" text-anchor="middle">m</text></svg>`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:512px;height:512px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`);
  await page.screenshot({ path: 'media/minitok.png', omitBackground: true });
  await browser.close();
})();
