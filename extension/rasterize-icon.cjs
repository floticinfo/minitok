const { chromium } = require('playwright');
const fs = require('fs');
// Render the supplied 2.svg without changing its viewBox, coordinates, or
// geometry. The licensed font is injected only for this build-time render and
// is not redistributed with the product package.
(async () => {
  const fontPath = process.env.MINITOK_HARLEKIN_FONT;
  if (!fontPath || !fs.existsSync(fontPath)) throw new Error('Set MINITOK_HARLEKIN_FONT to the licensed Harlekin WOFF2 before rasterizing');
  const source = fs.readFileSync('media/minitok.svg', 'utf8');
  const font = fs.readFileSync(fontPath).toString('base64');
  const svg = source.replace('</svg>', `<style>@font-face{font-family:Harlekin;src:url(data:font/woff2;base64,${font}) format('woff2')}</style></svg>`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:512px;height:512px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`);
  await page.screenshot({ path: 'media/minitok.png' });
  await browser.close();
})();
