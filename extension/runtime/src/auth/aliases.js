"use strict";

/**
 * Provider aliases — the single table every entry point resolves names with.
 *
 * The table used to be copied into the auth manager, `doctor`, `run` and the
 * pipeline loop, while `auth login`/`auth logout` and the token store keyed
 * credentials by the raw argument. `minitok auth login gpt` therefore stored
 * gpt.json, but every consumer — starting with AuthManager.resolve() — looked up
 * the normalised name openai.json and reported the credential as missing, so an
 * alias login silently never authenticated.
 *
 * Aliases are resolved here, at the boundary, so a stored key and a looked-up
 * key always agree.
 */
const ALIAS_MAP = {
  claude: "anthropic",
  gpt: "openai",
  gemini: "google",
};

/**
 * Canonical provider name for `name`.
 *
 * Unknown names are returned lowercased, which matches the case-insensitive
 * lookup the providers and the token store already relied on.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeProvider(name) {
  const key = String(name == null ? "" : name).toLowerCase();
  return ALIAS_MAP[key] || key;
}

/**
 * Alias names that resolve to the canonical form of `name`.
 *
 * Used to find credentials written before aliases were normalised (the token
 * store's `gpt.json` legacy fallback).
 *
 * @param {string} name
 * @returns {string[]}
 */
function aliasesFor(name) {
  const canonical = normalizeProvider(name);
  return Object.keys(ALIAS_MAP).filter((alias) => ALIAS_MAP[alias] === canonical);
}

module.exports = { ALIAS_MAP, normalizeProvider, aliasesFor };
