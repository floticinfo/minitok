"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { BRAND, WEBVIEW_CUSTOM_PROPERTIES, WEBVIEW_ACCENT_ALIAS, hexToRgb, rgbTriplet, ansiForeground, ansiBackground, relativeLuminance, contrastRatio } = require("./palette");

const WHITE = "#FFFFFF";
const BLACK = "#000000";
const webviews = ["sidebar.html", "panel.html"].map(name => ({ name, html: fs.readFileSync(path.join(__dirname, "..", "..", "extension", "src", name), "utf8") }));

test("the palette carries the published brand values", () => {
  // Locked on purpose: a brand colour that drifts silently is a brand that
  // drifts everywhere, because every surface mirrors these values.
  assert.deepEqual(BRAND, {
    primary: "#013DCF",
    primaryHover: "#012CA8",
    deepNavy: "#03045E",
    secondaryBlue: "#0077B6",
    cyanAccent: "#00B4D8",
    sky: "#90E0EF",
    pale: "#CAF0F8",
    onPrimary: "#FFFFFF",
  });
  assert.equal(Object.isFrozen(BRAND), true);
  for (const [name, hex] of Object.entries(BRAND)) assert.match(hex, /^#[0-9A-F]{6}$/, `${name} must be an uppercase 6-digit hex colour`);
  assert.equal(new Set(Object.values(BRAND)).size, Object.keys(BRAND).length, "every token is a distinct colour");
});

test("colour conversion and ANSI helpers agree with each other", () => {
  assert.deepEqual(hexToRgb("#013DCF"), { r: 1, g: 61, b: 207 });
  assert.deepEqual(hexToRgb("#03045e"), { r: 3, g: 4, b: 94 }, "lowercase input is accepted");
  assert.equal(rgbTriplet("#CAF0F8"), "202;240;248");
  assert.equal(ansiForeground("#0077B6"), "\x1b[38;2;0;119;182m");
  assert.equal(ansiBackground("#013DCF"), "\x1b[48;2;1;61;207m");
  assert.throws(() => hexToRgb("#013DCF00"), /not a 6-digit hex colour/, "alpha colours are rejected: an ANSI background cannot carry them");
  assert.throws(() => hexToRgb("013DCF"), /not a 6-digit hex colour/);
});

test("contrastRatio is the WCAG formula", () => {
  assert.equal(contrastRatio(BLACK, WHITE), 21);
  assert.equal(contrastRatio(WHITE, WHITE), 1);
  assert.equal(contrastRatio("#0077B6", WHITE).toFixed(2), "4.87");
  assert.equal(relativeLuminance(BLACK), 0);
  assert.equal(relativeLuminance(WHITE), 1);
});

test("the palette is used where it is legible", () => {
  // A fill token on a black surface is invisible, which is why the CLI paints
  // the brand as a tile instead of as text; the assertions below are the rules
  // documented in palette.js, not incidental numbers.
  assert.equal(contrastRatio(BRAND.onPrimary, BRAND.primary) >= 4.5, true, "text on a primary fill");
  assert.equal(contrastRatio(BRAND.onPrimary, BRAND.deepNavy) >= 4.5, true, "text on a deep navy fill");
  assert.equal(contrastRatio(BRAND.pale, BRAND.deepNavy) >= 4.5, true, "pale text on a deep navy fill");
  assert.equal(contrastRatio(BRAND.secondaryBlue, WHITE) >= 4.5, true, "secondary blue is text on a light surface");
  assert.equal(contrastRatio(BRAND.secondaryBlue, BLACK) >= 4.3, true, "secondary blue is text on a dark surface");
  for (const [name, hex] of Object.entries({ cyanAccent: BRAND.cyanAccent, sky: BRAND.sky, pale: BRAND.pale })) {
    assert.equal(contrastRatio(hex, BLACK) >= 4.5, true, `${name} is readable on a dark surface`);
    assert.equal(contrastRatio(hex, WHITE) < 3, true, `${name} must not be used as text on a light surface`);
  }
  for (const [name, hex] of Object.entries({ primary: BRAND.primary, primaryHover: BRAND.primaryHover, deepNavy: BRAND.deepNavy })) {
    assert.equal(contrastRatio(hex, BLACK) < 3, true, `${name} must not be used as text on a dark surface`);
    assert.equal(contrastRatio(hex, WHITE) >= 4.5, true, `${name} is readable on a light surface`);
  }
});

test("the webviews mirror the palette instead of hardcoding it", () => {
  const alias = WEBVIEW_ACCENT_ALIAS;
  for (const { name, html } of webviews) {
    for (const [property, hex] of Object.entries(WEBVIEW_CUSTOM_PROPERTIES)) {
      assert.equal(html.includes(`${property}:${hex}`), true, `${name} must declare ${property}:${hex}`);
    }
    // The accent has to sit on the host surface, so it resolves per theme
    // rather than to one hue; the three declarations are asserted verbatim so a
    // refactor cannot quietly drop the dark and high-contrast cases.
    assert.equal(html.includes(`${alias.property}:var(${alias.light})`), true, `${name} must declare ${alias.property} for light surfaces`);
    assert.equal(html.includes(`body.vscode-dark{${alias.property}:var(${alias.dark})}`), true, `${name} must switch ${alias.property} for dark surfaces`);
    assert.equal(html.includes(`body.vscode-high-contrast{${alias.property}:var(${alias.highContrast})}`), true, `${name} must switch ${alias.property} for high contrast`);
    for (const target of [alias.light, alias.dark, alias.highContrast]) {
      assert.equal(target in WEBVIEW_CUSTOM_PROPERTIES, true, `${alias.property} resolves to undeclared ${target}`);
    }
    const declared = new Set([...Object.keys(WEBVIEW_CUSTOM_PROPERTIES), alias.property]);
    const referenced = [...new Set([...html.matchAll(/var\((--mt-brand-[a-z-]+)/g)].map(match => match[1]))];
    assert.equal(referenced.length > 0, true, `${name} must use the brand tokens`);
    for (const property of referenced) assert.equal(declared.has(property), true, `${name} uses undeclared ${property}`);
    for (const literal of [...new Set([...html.matchAll(/#[0-9a-fA-F]{6}/g)].map(match => match[0].toUpperCase()))]) {
      assert.equal(Object.values(BRAND).includes(literal), true, `${name} hardcodes ${literal}, which is not a palette colour`);
    }
  }
});

test("the CLI derives its tones from the palette", () => {
  const gui = fs.readFileSync(path.join(__dirname, "..", "cli", "fullscreen-gui.js"), "utf8");
  assert.match(gui, /require\("\.\.\/core\/palette"\)/);
  assert.match(gui, /actBadge: `\$\{ansiBackground\(BRAND\.primary\)\}/);
  assert.match(gui, /planBadge: `\$\{ansiBackground\(BRAND\.deepNavy\)\}/);
  assert.match(gui, /brand: ansiForeground\(BRAND\.secondaryBlue\)/);
  for (const literal of [...new Set([...gui.matchAll(/\\x1b\[38;5;/g)].map(match => match[0]))]) {
    assert.fail(`the GUI still uses a 256-colour index (${JSON.stringify(literal)}) that no longer matches the palette`);
  }
});

test("the shipped brand assets carry the primary colour", () => {
  // The icon is the one asset a user sees before installing, and it is drawn by
  // hand in the SVG plus two rasterizers, next to a package.json field the
  // Marketplace renders as the extension colour. Locking them to
  // `BRAND.primary` keeps a palette change from leaving a stale tile behind,
  // because nothing regenerates these files automatically.
  const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", "..", ...parts), "utf8");
  const assets = { "extension/media/minitok.svg": read("extension", "media", "minitok.svg"), "extension/rasterize-icon.cjs": read("extension", "rasterize-icon.cjs"), "extension/rasterize-representative.cjs": read("extension", "rasterize-representative.cjs") };
  const svg = assets["extension/media/minitok.svg"];
  assert.match(svg, /viewBox="0 0 72\.105095 72\.105095"/, "the supplied SVG viewBox must be preserved");
  assert.match(svg, /transform="rotate\(45\)"/, "the supplied SVG rotation must be preserved");
  assert.match(svg, /fill:#013dcf/i, "the supplied SVG must retain its primary fill");
  assert.match(svg, /fill:#ffffff/i, "the supplied SVG must retain its white glyph");
  for (const [name, source] of Object.entries(assets).filter(([name]) => name !== "extension/media/minitok.svg")) {
    assert.equal(source.includes("media/minitok.svg"), true, `${name} must render the supplied SVG asset`);
    assert.match(source, /omitBackground:\s*true/, `${name} must preserve the transparent icon background`);
  }
  const manifest = JSON.parse(read("extension", "package.json"));
  assert.equal(manifest.icon, "media/minitok.png", "the Marketplace icon is the rasterized tile");
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, "media/minitok.svg", "the activity bar uses the transparent glyph, not the tile");
  // `galleryBanner.color` is the one brand surface that cannot carry a comment
  // (the file is strict JSON), so the assertion below is its only guard.
  assert.equal(manifest.galleryBanner.color.toUpperCase(), BRAND.primary.toUpperCase(), "the Marketplace banner must use the primary colour");
  assert.equal(manifest.galleryBanner.theme, "dark", "the banner theme is fixed because the primary colour is too dark to read on a light banner");
});

