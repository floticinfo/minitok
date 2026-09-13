const { chromium } = require('playwright');
const fs = require('fs');
// The tile is the brand pairing the CLI ` ACT ` badge paints: `primary`
// (#013DCF) behind the `onPrimary` white glyph (8.2:1). The values mirror
// src/core/palette.js, which is the single source of truth, and the geometry
// matches media/minitok.svg. Both must change together, and regenerating
// media/minitok.png requires Playwright.
(async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><rect x="1" y="1" width="30" height="30" rx="6" fill="#013DCF"/><text x="16" y="23" font-family="system-ui,-apple-system,sans-serif" font-size="20" font-weight="800" fill="#ffffff" text-anchor="middle">m</text></svg>';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:128px;height:128px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`);
  await page.screenshot({ path: 'media/minitok.png' });
  await browser.close();
})();
