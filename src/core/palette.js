"use strict";

/**
 * minitok brand palette -- the single source of truth for every colour the
 * product paints on a surface it owns.
 *
 * | token         | hex       | role                                                       |
 * | ------------- | --------- | ---------------------------------------------------------- |
 * | primary       | `#013DCF` | brand mark, primary fills, active/selected product states  |
 * | primaryHover  | `#012CA8` | pressed or hovered state of a primary fill                 |
 * | deepNavy      | `#03045E` | deepest fill, strongest text on pale/sky                   |
 * | secondaryBlue | `#0077B6` | secondary actions, progress strokes, legible accents       |
 * | cyanAccent    | `#00B4D8` | accent and focus glow on dark surfaces                     |
 * | sky           | `#90E0EF` | light tint and hairline borders on dark surfaces           |
 * | pale          | `#CAF0F8` | lightest tint, text on a deep navy fill                    |
 * | onPrimary     | `#FFFFFF` | glyph or text on a primary/deep navy fill                  |
 *
 * Neutral surfaces and backgrounds are deliberately *not* part of this palette.
 * The CLI inherits the operator's terminal background and the Extension
 * webviews use the editor's `--vscode-*` theme variables, so the product keeps
 * matching whatever the host is themed with and the brand only paints the
 * product-owned elements on top of those neutrals.
 *
 * Legibility decides how a token may be used. The ratio next to each entry is
 * `contrastRatio(token, "#FFFFFF")` and `contrastRatio(token, "#000000")`:
 *
 *   primary       8.2:1 on white,  2.6:1 on black -> fills only, never text
 *   primaryHover 10.9:1 on white,  1.9:1 on black -> fills only, never text
 *   deepNavy     17.8:1 on white,  1.2:1 on black -> fills only, never text
 *   secondaryBlue 4.9:1 on white,  4.3:1 on black -> the member that is text on either surface
 *   cyanAccent    2.5:1 on white,  8.5:1 on black -> dark surfaces, decoration
 *   sky           1.5:1 on white, 14.1:1 on black -> dark surfaces (as a tint, or as text)
 *   pale          1.2:1 on white, 17.3:1 on black -> dark surfaces (as a tint, or as text)
 *   onPrimary     8.2:1 on primary, 17.8:1 on deepNavy
 *
 * The three dark members are why a dark hue must never be used for text in a
 * surface-agnostic context: `#013DCF` on a black terminal is unreadable, so
 * text tones use `secondaryBlue` and the brand is carried by filled tiles
 * instead.
 *
 * Consumers
 * ---------
 * - CLI TUI (`src/cli/fullscreen-gui.js`) derives 24-bit ANSI from these tokens
 *   with `ansiForeground`/`ansiBackground`.
 * - Extension webviews (`extension/src/sidebar.html`, `panel.html`) mirror the
 *   hex values as `--mt-brand-*` custom properties, because a webview cannot
 *   `require()` this module. `WEBVIEW_CUSTOM_PROPERTIES` is that mirror in
 *   code form, `WEBVIEW_ACCENT_ALIAS` is the derived property below, and
 *   `palette.test.js` asserts the files and this module stay identical.
 * - MCP (`src/mcp/tools.js`) is deliberately colour-free: its payload is
 *   JSON-RPC that the host renders, so a sequence from this module would be
 *   displayed literally. See the note on the tool surface.
 * - The Marketplace banner (`extension/package.json` -> `galleryBanner.color`)
 *   carries `primary` from the same values, asserted rather than commented
 *   because the file is strict JSON.
 */

/** The seven brand colours plus the glyph colour for a brand fill. */
const BRAND = Object.freeze({
  primary: "#013DCF",
  primaryHover: "#012CA8",
  deepNavy: "#03045E",
  secondaryBlue: "#0077B6",
  cyanAccent: "#00B4D8",
  sky: "#90E0EF",
  pale: "#CAF0F8",
  onPrimary: "#FFFFFF",
});

/**
 * The custom properties the Extension webviews declare in `:root`.
 *
 * The declaration order matches the palette order so the mirrored block in the
 * HTML files stays readable next to this table; nothing depends on the order.
 */
const WEBVIEW_CUSTOM_PROPERTIES = Object.freeze({
  "--mt-brand-primary": BRAND.primary,
  "--mt-brand-primary-hover": BRAND.primaryHover,
  "--mt-brand-deep-navy": BRAND.deepNavy,
  "--mt-brand-secondary": BRAND.secondaryBlue,
  "--mt-brand-cyan": BRAND.cyanAccent,
  "--mt-brand-sky": BRAND.sky,
  "--mt-brand-pale": BRAND.pale,
  "--mt-brand-on-primary": BRAND.onPrimary,
});

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * The one derived property the webviews declare.
 *
 * A webview inherits the editor's theme, so the accent that has to sit *on the
 * host surface* cannot be a single hue: VS Code stamps `vscode-dark` /
 * `vscode-light` on the body and `primary` is 8.2:1 against white but only
 * 2.6:1 against black. The alias therefore resolves to the palette member that
 * is legible on the current surface, which is the same rule the CLI applies by
 * painting badges instead of colouring text.
 */
const WEBVIEW_ACCENT_ALIAS = Object.freeze({
  property: "--mt-brand-surface-accent",
  light: "--mt-brand-primary",
  dark: "--mt-brand-cyan",
  highContrast: "--mt-brand-sky",
});

function assertHex(hex) {
  if (typeof hex !== "string" || !HEX_PATTERN.test(hex)) throw new Error(`not a 6-digit hex colour: ${hex}`);
  return hex.toLowerCase();
}

/** Split `#rrggbb` into its channels. */
function hexToRgb(hex) {
  const value = assertHex(hex);
  return { r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16) };
}

/** `#rrggbb` as the `r;g;b` triplet a 24-bit SGR sequence expects. */
function rgbTriplet(hex) {
  const { r, g, b } = hexToRgb(hex);
  return `${r};${g};${b}`;
}

/** Truecolour foreground; unlike the 256-colour palette this needs no terminal table. */
function ansiForeground(hex) {
  return `\x1b[38;2;${rgbTriplet(hex)}m`;
}

/** Truecolour background, used to paint a brand tile behind text. */
function ansiBackground(hex) {
  return `\x1b[48;2;${rgbTriplet(hex)}m`;
}

/** WCAG relative luminance of an sRGB colour. */
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = value => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two opaque colours (1:1 to 21:1). */
function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

module.exports = { BRAND, WEBVIEW_CUSTOM_PROPERTIES, WEBVIEW_ACCENT_ALIAS, hexToRgb, rgbTriplet, ansiForeground, ansiBackground, relativeLuminance, contrastRatio };
