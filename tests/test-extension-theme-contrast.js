const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const webviewFiles = ["sidebar.html", "panel.html"];
const webviews = Object.fromEntries(webviewFiles.map(file => [
  file,
  readFileSync(path.join(root, "extension", "src", file), "utf8")
]));

// Extract the brand token declarations from the webview mirror so that hand-edits
// or palette drift change the values under test instead of a stale copy.
function tokenValue(name) {
  const values = {};
  for (const [file, html] of Object.entries(webviews)) {
    const match = html.match(new RegExp(`--${name}:\\s*#?([0-9A-Fa-f]{6})`));
    if (match) values[file] = `#${match[1].toUpperCase()}`;
  }
  assert.ok(webviewFiles.some(file => values[file]), `token --${name} must be declared in a webview`);
  const unique = [...new Set(Object.values(values))];
  assert.equal(unique.length, 1, `token --${name} diverges across webviews: ${JSON.stringify(values)}`);
  return unique[0];
}

const TOKENS = {
  primary: tokenValue("mt-brand-primary"),
  primaryHover: tokenValue("mt-brand-primary-hover"),
  deepNavy: tokenValue("mt-brand-deep-navy"),
  secondary: tokenValue("mt-brand-secondary"),
  cyan: tokenValue("mt-brand-cyan"),
  sky: tokenValue("mt-brand-sky"),
  pale: tokenValue("mt-brand-pale"),
  onPrimary: tokenValue("mt-brand-on-primary")
};

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a, b) {
  const l1 = Math.max(relativeLuminance(a), relativeLuminance(b));
  const l2 = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (l1 + 0.05) / (l2 + 0.05);
}

// VS Code theme surfaces the webview paints brand accents onto.
const VSCODE_DARK_EDITOR = "#1E1E1E";
const VSCODE_DARK_SIDEBAR = "#252526";
const VSCODE_HC_BLACK = "#000000";
const WHITE = "#FFFFFF";

// The palette rule: primary is a badge/fill color; accent text uses the
// theme-adaptive surface-accent (light: primary, dark: cyan, HC: sky).
const CASES = [
  ["on-primary text on primary fill (all themes)", TOKENS.onPrimary, TOKENS.primary, 4.5],
  ["on-primary text on primary-hover fill", TOKENS.onPrimary, TOKENS.primaryHover, 4.5],
  ["primary accent text on light surface", TOKENS.primary, WHITE, 4.5],
  ["cyan accent text on dark editor surface", TOKENS.cyan, VSCODE_DARK_EDITOR, 4.5],
  ["cyan accent text on dark sidebar surface", TOKENS.cyan, VSCODE_DARK_SIDEBAR, 4.5],
  ["sky accent text on high-contrast surface", TOKENS.sky, VSCODE_HC_BLACK, 4.5],
  ["secondary link text on light surface", TOKENS.secondary, WHITE, 4.5],
  ["cyan on deep-navy hero surfaces", TOKENS.cyan, TOKENS.deepNavy, 4.5],
  ["pale text on primary fill", TOKENS.pale, TOKENS.primary, 4.5]
];

test("brand contrast pairs meet WCAG AA across light/dark/high-contrast themes", () => {
  for (const [name, fg, bg, minimum] of CASES) {
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= minimum, `${name}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1 < ${minimum}:1`);
  }
});

test("surface-accent theme mapping keeps primary out of dark-theme text", () => {
  // Dark and high-contrast themes must not use --mt-brand-primary as text color:
  // its contrast on dark surfaces fails AA (measured here to prove the rule).
  const ratio = contrastRatio(TOKENS.primary, VSCODE_DARK_SIDEBAR);
  assert.ok(ratio < 4.5, `primary on dark sidebar unexpectedly passes AA (${ratio.toFixed(2)}:1) — dark themes should use cyan/sky`);
});

test("webview tokens mirror src/core/palette.js single source of truth", () => {
  const { BRAND } = require(path.join(root, "src", "core", "palette.js"));
  assert.equal(TOKENS.primary, BRAND.primary.toUpperCase(), "webview --mt-brand-primary must match palette BRAND.primary");
  assert.equal(TOKENS.secondary, BRAND.secondaryBlue.toUpperCase(), "webview --mt-brand-secondary must match palette BRAND.secondaryBlue");
  assert.equal(TOKENS.cyan, BRAND.cyanAccent.toUpperCase(), "webview --mt-brand-cyan must match palette BRAND.cyanAccent");
});

test("panel.html declares the full brand token set (no partial mirror)", () => {
  const html = webviews["panel.html"];
  for (const token of ["--mt-brand-primary", "--mt-brand-primary-hover", "--mt-brand-deep-navy", "--mt-brand-secondary", "--mt-brand-cyan", "--mt-brand-sky", "--mt-brand-pale", "--mt-brand-on-primary"]) {
    assert.ok(new RegExp(`${token}:`).test(html), `panel.html must declare ${token}`);
  }
  // surface-accent starts as primary and is not overridden per-theme in the panel:
  assert.ok(html.includes("--mt-brand-surface-accent:var(--mt-brand-primary)"), "panel.html must default surface-accent to brand primary");
});