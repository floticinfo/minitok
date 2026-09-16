const { chromium } = require('playwright');
const fs = require('fs');
// Render the supplied path-based 2.svg directly. No font injection or geometry
// rewriting is allowed because the SVG already contains the glyph paths.
(async () => {
  const svg = fs.readFileSync('media/minitok.svg', 'utf8');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:512px;height:512px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`);
  await page.screenshot({ path: 'media/minitok.png' });
  await browser.close();
})();
