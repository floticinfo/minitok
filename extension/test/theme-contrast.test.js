"use strict";

// Theme-contrast static audit (prompt 6, class E / minor).
//
// The two webview templates (src/sidebar.html, src/panel.html) must never pin a
// hardcoded color to a declaration that paints on a themed surface. A fixed
// hex/rgb value that contrasts against the author's theme can disappear against
// the user's theme, so all paint on VS Code surfaces must flow through
// var(--vscode-*) and brand paint through var(--mt-brand-*). The only place a
// literal color may appear is inside a custom-property definition (the brand
// palette block), which is itself switched per theme class.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC_DIR = path.join(__dirname, "..", "src");
const TEMPLATES = ["sidebar.html", "panel.html"];

const LITERAL_COLOR = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b|\brgba?\s*\(|\bhsla?\s*\(/;

function extractCss(file) {
  const html = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
  const blocks = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  assert.ok(blocks.length > 0, `${file} must contain at least one <style> block`);
  return blocks.join("\n");
}

// Strips comments, then yields every declaration as { property, value }.
function declarations(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = /([a-zA-Z-]+)\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    out.push({ property: m[1].trim(), value: m[2].trim() });
  }
  return out;
}

test("no declaration paints a literal hex/rgb color outside custom-property definitions", () => {
  for (const file of TEMPLATES) {
    const decls = declarations(extractCss(file));
    const offenders = decls.filter(
      (d) => !d.property.startsWith("--") && LITERAL_COLOR.test(d.value)
    );
    assert.deepEqual(
      offenders,
      [],
      `${file} has fixed-color declarations that bypass the theme: ` +
        offenders.map((d) => `${d.property}:${d.value}`).join(", ")
    );
  }
});

test("every literal color lives inside a --mt-brand custom-property definition", () => {
  for (const file of TEMPLATES) {
    const decls = declarations(extractCss(file));
    const literals = decls.filter((d) => LITERAL_COLOR.test(d.value));
    assert.ok(literals.length > 0, `${file} should declare its brand palette literally`);
    for (const d of literals) {
      assert.ok(
        d.property.startsWith("--mt-brand-"),
        `${file}: literal color must be defined on a --mt-brand-* variable, found ${d.property}:${d.value}`
      );
    }
  }
});

test("color/background declarations resolve through var(--vscode-*) or var(--mt-brand-*)", () => {
  const PAINT_PROPS = /^(color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?-color|outline-color|fill|stroke)$/;
  for (const file of TEMPLATES) {
    const decls = declarations(extractCss(file));
    for (const d of decls) {
      if (!PAINT_PROPS.test(d.property)) continue;
      // transparent/inherit/none are safe keywords: they add no fixed color and
      // let the themed surface underneath stay authoritative.
      if (/^(transparent|inherit|none)$/.test(d.value)) continue;
      // Allow nested var() with a theme/brand fallback, e.g.
      // var(--mt-brand-surface-accent, var(--vscode-charts-blue)).
      assert.match(
        d.value,
        /^var\(--(?:vscode|mt-brand)-[a-zA-Z-]+(?:\s*,\s*var\(--(?:vscode|mt-brand)-[a-zA-Z-]+\))?\)$/,
        `${file}: ${d.property} must reference a theme/brand variable, found "${d.value}"`
      );
    }
  }
});

test("semantic status rules keep the editor's own --vscode-testing tokens", () => {
  const sidebar = extractCss("sidebar.html");
  const panel = extractCss("panel.html");
  assert.match(sidebar, /\.auth-error\s*\{[^}]*color:\s*var\(--vscode-testing-iconFailed\)/);
  assert.match(panel, /\.error\s*\{[^}]*color:\s*var\(--vscode-testing-iconFailed\)/);
  assert.match(panel, /\.ok\s*\{[^}]*color:\s*var\(--vscode-testing-iconPassed\)/);
});

test("surface backgrounds follow the themed sideBar surface", () => {
  const sidebar = extractCss("sidebar.html");
  const panel = extractCss("panel.html");
  assert.match(sidebar, /background:\s*var\(--vscode-sideBar-background\)/);
  assert.match(panel, /background:\s*var\(--vscode-sideBar-background\)/);
});
