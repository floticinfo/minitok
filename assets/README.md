# minitok brand assets

`minitok-harlekin-mark.png` is static, non-editable brand artwork rendered from the
licensed Harlekin webfont. The CLI and MCP runtime do not distribute the Harlekin
font files. The extension uses the same static mark for its marketplace icon.

The source font remains subject to its applicable MyFonts/Monotype license and must
not be extracted from or redistributed with this package.

## Remote icon consistency

`server.json` declares its Registry icon as `https://minitok.dev/assets/minitok-harlekin-mark.png`.
Run `npm run readiness:icons` (scripts/mcp-icon-consistency.mjs) to verify the live URL
both serves an `image/*` payload and is byte-identical to the packaged
`assets/minitok-harlekin-mark.png`.

> Known gap (2026-10): the URL currently returns `text/html` (the SPA fallback page),
> not the PNG. The marketing/docs site must serve the real asset at that path before
> the icon check can pass. Until then the Registry listing shows no icon.
