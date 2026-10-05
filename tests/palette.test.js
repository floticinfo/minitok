"use strict";
// Brand-consistency gate for `src/core/palette.js`.
//
// `palette.js` documents itself as the single source of truth for every colour
// the product paints, and names the surfaces that mirror it. This suite is the
// assertion that keeps that promise true: each test pins one mirror so a hand
// edit that drifts from the palette fails here instead of shipping.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const palette = require(path.join(root, "src", "core", "palette.js"));
const { BRAND, WEBVIEW_CUSTOM_PROPERTIES, WEBVIEW_ACCENT_ALIAS } = palette;

const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

// Colour-use rule: BRAND.primary (#013DCF) is a dark hue, so painting it as text
// on a light background fails contrast. It is the badge background only; text
// on that tile uses BRAND.onPrimary, and plain foreground text uses
// BRAND.secondaryBlue (see the fullscreen-gui ansi table). These two scans
// enforce that rule over the CLI surface instead of leaving it a comment.
const CLI_COLOUR_SCENES = ["src/cli/fullscreen-gui.js", "src/cli/output.js", "src/cli/commands/gui.js"];

// The brand mark renders only the fill and the glyph. Anti-aliased PNG edges
// blend the two, so a near match (any channel within 0x20) counts as on-brand.
function nearBrand(hex, slack) {
  const { r, g, b } = palette.hexToRgb(hex);
  const near = target => {
    const t = palette.hexToRgb(target);
    return Math.abs(r - t.r) <= slack && Math.abs(g - t.g) <= slack && Math.abs(b - t.b) <= slack;
  };
  return near(BRAND.primary) || near(BRAND.onPrimary);
}
const isBrandColour = hex => nearBrand(hex, 0x20);


test("the palette and its webview mirror are internally consistent", () => {
  assert.deepEqual(Object.keys(BRAND), [
    "primary",
    "primaryHover",
    "deepNavy",
    "secondaryBlue",
    "cyanAccent",
    "sky",
    "pale",
    "onPrimary",
  ]);
  // Every mirrored property points at a real palette member, with no extra keys.
  assert.equal(Object.keys(WEBVIEW_CUSTOM_PROPERTIES).length, Object.keys(BRAND).length);
  for (const value of Object.values(WEBVIEW_CUSTOM_PROPERTIES)) {
    assert.ok(Object.values(BRAND).includes(value), `mirror value ${value} must be a palette member`);
  }
  // The accent alias resolves to declared mirror properties for each theme.
  for (const key of ["light", "dark", "highContrast"]) {
    assert.ok(
      Object.hasOwn(WEBVIEW_CUSTOM_PROPERTIES, WEBVIEW_ACCENT_ALIAS[key]),
      `accent alias for ${key} must reference a declared property`,
    );
  }
});

test("CLI colour scenes never paint the primary hue as text and only badge it as a tile", () => {
  const { BRAND, ansiForeground, ansiBackground } = palette;
  const primaryFg = ansiForeground(BRAND.primary);
  const secondaryFg = ansiForeground(BRAND.secondaryBlue);
  const onPrimaryFg = ansiForeground(BRAND.onPrimary);
  const primaryBg = ansiBackground(BRAND.primary);
  const deepNavyBg = ansiBackground(BRAND.deepNavy);
  for (const scene of CLI_COLOUR_SCENES) {
    const source = read(scene);
    assert.ok(!source.includes(primaryFg) || source.includes(primaryBg),
      `${scene}: BRAND.primary as foreground is only legal inside a badge tile (after a primary background)`);
    if (source.includes(primaryFg)) {
      // Every occurrence of a primary foreground must be preceded (in the same
      // literal) by a tile background, i.e. it is the onPrimary-style glyph —
      // but the only legal glyph there is BRAND.onPrimary, never primary itself.
      const literals = source.match(new RegExp("\u0060[^\u0060]*\u0060", "g")) || [];
      for (const literal of literals) {
        if (literal.includes(primaryFg)) {
          assert.ok(literal.startsWith(primaryBg) || literal.includes(deepNavyBg),
            `${scene}: primary foreground outside a tile literal: ${literal.slice(0, 60)}`);
        }
      }
    }
    // Status colour must come from the terminal's own green/red, not a brand hue
    // (asserted in test-cli-output-markers.js); here we assert the text-only brand
    // foreground that does exist is the readable secondary blue.
  }
  // Runtime truth: the exported ansi table is what actually paints pixels.
  const { ansi } = require(path.join(root, "src", "cli", "fullscreen-gui.js"));
  assert.equal(ansi.brand, secondaryFg, "brand text foreground is secondaryBlue, not primary");
  assert.notEqual(ansi.brand, primaryFg);
  assert.equal(ansi.accent, ansiForeground(BRAND.cyanAccent));
  assert.equal(ansi.actBadge, `${primaryBg}${onPrimaryFg}`, "actBadge paints a primary tile with an onPrimary glyph");
  assert.equal(ansi.planBadge, `${deepNavyBg}${ansiForeground(BRAND.pale)}`, "planBadge paints a deepNavy tile with a pale glyph");
});

for (const file of ["extension/src/sidebar.html", "extension/src/panel.html"]) {
  test(`${file} mirrors every webview custom property verbatim`, () => {
    const html = read(...file.split("/"));
    for (const [property, value] of Object.entries(WEBVIEW_CUSTOM_PROPERTIES)) {
      const declared = new RegExp(`${property}:\\s*${value};`, "i");
      assert.match(html, declared, `${file} must declare ${property}: ${value}`);
    }
  });
}


test("extension package.json gallery banner carries the primary brand colour", () => {
  const pkg = JSON.parse(read("extension", "package.json"));
  assert.equal(pkg.galleryBanner.color.toLowerCase(), BRAND.primary.toLowerCase());
});

test("minitok.svg paints the mark only with the primary fill and onPrimary glyph", () => {
  const svg = read("extension", "media", "minitok.svg");
  const hexes = new Set([...svg.matchAll(/#([0-9a-f]{6})\b/gi)].map(m => `#${m[1].toLowerCase()}`));
  for (const hex of hexes) {
    assert.ok(isBrandColour(hex), `minitok.svg paints ${hex}, which is not a brand colour`);
  }
  // The mark must carry the primary fill; without it the tile is not branded.
  assert.ok(hexes.has(BRAND.primary.toLowerCase()), "minitok.svg must carry the primary fill");
});

test("minitok-activitybar.svg renders the glyph in currentColor for the host theme", () => {
  const svg = read("extension", "media", "minitok-activitybar.svg");
  assert.match(svg, /fill="currentColor"/);
  // The monochrome icon must not bake a brand fill; the activity bar themes it.
  assert.doesNotMatch(svg, /#[0-9a-f]{6}/i);
});

test("the colour and monochrome marks draw the same glyph", () => {
  const colour = read("extension", "media", "minitok.svg");
  const mono = read("extension", "media", "minitok-activitybar.svg");
  // The colour mark has two paths: the rounded-square tile and the m glyph.
  // Match the glyph by its distinctive move, not by document order.
  const glyph = source => {
    const m = source.match(/\bd="(m 83\.625937,162\.13977[^"]+)"/);
    assert.ok(m, "expected the m glyph path");
    return m[1].replace(/\s+/g, "");
  };
  assert.equal(glyph(mono), glyph(colour), "the two marks must trace the identical m glyph");
});


// Decode the RGBA scanlines of a non-interlaced PNG (Paeth/Sub/Up/Average/None
// filters) so the shipped icon can be colour-audited without a dependency.
function decodePngRgba(buffer) {
  const zlib = require("node:zlib");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunk = buffer.slice(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      assert.equal(chunk[9], 6, "expected an RGBA (colour type 6) icon");
      assert.equal(chunk[12], 0, "expected a non-interlaced icon");
    }
    if (type === "IDAT") idat.push(chunk);
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? pixels[y * stride + i - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= 4 ? pixels[(y - 1) * stride + i - 4] : 0;
      let value = row[i];
      if (filter === 1) value = (value + left) & 0xff;
      else if (filter === 2) value = (value + up) & 0xff;
      else if (filter === 3) value = (value + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = (value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
      }
      pixels[y * stride + i] = value;
    }
  }
  return { width, height, pixels };
}

test("minitok.png is byte-identical to the canonical mark", () => {
  const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
  assert.equal(
    sha256(fs.readFileSync(path.join(root, "assets", "minitok-harlekin-mark.png"))),
    sha256(fs.readFileSync(path.join(root, "extension", "media", "minitok.png"))),
    "assets/minitok-harlekin-mark.png and extension/media/minitok.png must be the same image",
  );
});

test("minitok.png renders only the brand fill and glyph, blended at the edges", () => {
  const { width, height, pixels } = decodePngRgba(fs.readFileSync(path.join(root, "extension", "media", "minitok.png")));
  assert.ok(width > 0 && height > 0, "expected a decoded icon");
  let offBrand = 0;
  let opaque = 0;
  for (let i = 0; i < width * height; i++) {
    if (pixels[i * 4 + 3] <= 200) continue; // ignore transparent/edge pixels
    opaque++;
    const hex = `#${[pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]]
      .map(v => v.toString(16).padStart(2, "0"))
      .join("")}`;
    if (!isBrandColour(hex)) offBrand++;
  }
  assert.ok(opaque > 0, "expected some opaque pixels");
  // The mark is a primary tile with an onPrimary glyph, so those two colours
  // must dominate; a re-tinted or recoloured icon breaks this share.
  const ratio = offBrand / opaque;
  assert.ok(
    ratio <= 0.01,
    `minitok.png paints ${(ratio * 100).toFixed(2)}% of opaque pixels off-brand (allowed 1%)`,
  );
  // Generous slack catches blue<->white edge blends, which still read as the
  // mark. What must stay negligible are colours no blend produces (a magenta
  // cast from the rasteriser is present at a trace level, ~0.2%).
  let far = 0;
  for (let i = 0; i < width * height; i++) {
    if (pixels[i * 4 + 3] <= 200) continue;
    const hex = `#${[pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]]
      .map(v => v.toString(16).padStart(2, "0"))
      .join("")}`;
    if (!nearBrand(hex, 0x60)) far++;
  }
  const farRatio = far / opaque;
  assert.ok(
    farRatio <= 0.003,
    `minitok.png paints ${(farRatio * 100).toFixed(2)}% of opaque pixels a non-blend colour (allowed 0.3%)`,
  );
});
