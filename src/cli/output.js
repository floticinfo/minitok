"use strict";

/**
 * Shared CLI status-marker output. Every `minitok` command prints the same
 * `[ok]` / `[error]` markers so success and failure are scannable; this module
 * is the single place that styles them. Colour is applied only on a TTY and is
 * dropped when `NO_COLOR`/`MINITOK_NO_COLOR` is "1", so captured/piped output
 * stays plain and byte-identical to the pre-colour behaviour. Success/failure
 * deliberately use the terminal's own green/red rather than brand hues (see
 * fullscreen-gui.js): a status must not be re-tinted to a brand colour.
 */

const { BRAND, ansiBackground, ansiForeground } = require("../core/palette");

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
// Brand tile used only for neutral branding accents (never for status meaning).
const BRAND_BADGE = `${ansiBackground(BRAND.primary)}${ansiForeground(BRAND.onPrimary)}`;

function colorEnabled(env = process.env, stream = process.stdout) {
  return Boolean(stream && stream.isTTY) && env.NO_COLOR !== "1" && env.MINITOK_NO_COLOR !== "1";
}

function paint(text, sequence, enabled) {
  return enabled ? `${sequence}${text}${RESET}` : text;
}

function markerOk(enabled = colorEnabled()) {
  return paint("[ok]", GREEN, enabled);
}

function markerError(enabled = colorEnabled()) {
  return paint("[error]", RED, enabled);
}

function markerBrand(label, enabled = colorEnabled()) {
  return paint(` ${label} `, BRAND_BADGE, enabled);
}

function ok(message, enabled = colorEnabled()) {
  console.log(`${markerOk(enabled)} ${message}`);
}

function printError(message, enabled = colorEnabled()) {
  console.error(`${markerError(enabled)} ${message}`);
}

function printOk(message, enabled = colorEnabled()) {
  console.log(`${markerOk(enabled)} ${message}`);
}

module.exports = { colorEnabled, markerOk, markerError, markerBrand, ok, printOk, printError };
