const { chromium } = require('playwright');
// Variant of rasterize-icon.cjs with the tile bleeding to the exact edges and
// no border radius inset, used for the representative listing image. The colours
// are the brand pairing from src/core/palette.js: `primary` (#013DCF) tile
// behind the `onPrimary` white glyph (8.2:1).
(async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="6" fill="#013DCF"/><text x="16" y="23" font-family="system-ui,-apple-system,sans-serif" font-size="20" font-weight="800" fill="#ffffff" text-anchor="middle">m</text></svg>';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:128px;height:128px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`);
  await page.screenshot({ path: 'media/minitok.png', omitBackground: true });
  await browser.close();
})();
