"use strict";

/**
 * `minitok auth login|logout` must key credentials by the canonical provider
 * name.
 *
 * The CLI used the raw argument (`gpt`) while AuthManager.resolve() normalised
 * to `openai` before reading, so an alias login stored a credential that no
 * consumer ever looked up, and `auth logout gpt` cleared a key nothing used.
 * These tests drive the real command functions with the store and the readline
 * prompt substituted, so they run offline and never touch the OS keychain or a
 * developer's real ~/.minitok.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const readline = require("node:readline");

const { TokenStore } = require("../src/auth/token-store");
const { OAuthFlow } = require("../src/auth/oauth");
const { cmdAuthLogin, cmdAuthLogout, cmdAuthStatus } = require("../src/cli/commands/auth.js");

const TEST_API_KEY = "sk-test-api-key";

/**
 * Run `fn` with the CLI's credential store replaced by a recorder and the OAuth
 * flow disabled.
 *
 * The auth command module builds its TokenStore at load time, so the calls have
 * to be captured on the prototype. Without this the OAuth branch would open a
 * browser (or overwrite a real keychain entry) depending on the host.
 */
async function withStubbedAuth({ listed = [] } = {}, fn) {
  const record = { saved: [], removed: [], prompts: [] };
  const store = {
    save: (provider, data) => record.saved.push({ provider, data }),
    remove: provider => record.removed.push(provider),
    load: provider => listed.find(entry => entry.provider === provider) || null,
    isValid: provider => Boolean(listed.find(entry => entry.provider === provider)),
    list: () => listed,
  };
  const original = {
    save: TokenStore.prototype.save,
    remove: TokenStore.prototype.remove,
    load: TokenStore.prototype.load,
    isValid: TokenStore.prototype.isValid,
    list: TokenStore.prototype.list,
    authorize: OAuthFlow.prototype.authorize,
    createInterface: readline.createInterface,
    log: console.log,
    error: console.error,
  };
  Object.assign(TokenStore.prototype, {
    save: store.save,
    remove: store.remove,
    load: store.load,
    isValid: store.isValid,
    list: store.list,
  });
  const output = [];
  // An unreachable OAuth server keeps the flow on the documented API-key path
  // even on a host where a real client id is configured.
  OAuthFlow.prototype.authorize = async () => { throw new Error("test: oauth disabled"); };
  readline.createInterface = () => ({
    question: (question, callback) => { record.prompts.push(question); callback(TEST_API_KEY); },
    close: () => {},
  });
  console.log = (...values) => { output.push(values.map(String).join(" ")); };
  console.error = (...values) => { output.push(values.map(String).join(" ")); };
  try {
    const status = await fn(record);
    return { status, record, output: output.join("\n") };
  } finally {
    TokenStore.prototype.save = original.save;
    TokenStore.prototype.remove = original.remove;
    TokenStore.prototype.load = original.load;
    TokenStore.prototype.isValid = original.isValid;
    TokenStore.prototype.list = original.list;
    OAuthFlow.prototype.authorize = original.authorize;
    readline.createInterface = original.createInterface;
    console.log = original.log;
    console.error = original.error;
  }
}


test("auth login stores an alias under the canonical provider name", async () => {
  const cases = [
    ["gpt", "openai"],
    ["GPT", "openai"],
    ["claude", "anthropic"],
    ["gemini", "google"],
    ["openai", "openai"],
  ];
  for (const [input, expected] of cases) {
    const { status, record } = await withStubbedAuth({}, () => cmdAuthLogin(input));
    assert.equal(status, 0, `${input} login should succeed`);
    assert.deepEqual(record.saved.map(entry => entry.provider), [expected], `${input} must be stored as ${expected}`);
    assert.equal(record.saved[0].data.access_token, TEST_API_KEY);
  }
});

test("auth logout clears the canonical entry for an alias argument", async () => {
  for (const [input, expected] of [["gpt", "openai"], ["claude", "anthropic"], ["Gemini", "google"]]) {
    const { status, record } = await withStubbedAuth({}, () => cmdAuthLogout(input));
    assert.equal(status, 0);
    assert.deepEqual(record.removed, [expected], `${input} must remove ${expected}`);
  }
});

test("auth login and auth logout agree on the key for the same alias", async () => {
  const { record: saved } = await withStubbedAuth({}, () => cmdAuthLogin("gpt"));
  const { record: removed } = await withStubbedAuth({}, () => cmdAuthLogout("gpt"));
  assert.equal(saved.saved[0].provider, removed.removed[0]);
});

test("auth status flags a credential saved under a pre-alias key", async () => {
  const listed = [{ provider: "gpt", valid: true, has_refresh: false, expires_at: null }];
  const { status, output } = await withStubbedAuth({ listed }, () => cmdAuthStatus());
  assert.equal(status, 0);
  assert.match(output, /gpt/);
  assert.match(output, /alias of openai/, "the stale key must be explained, not just printed");
  assert.match(output, /auth login openai/, "the operator must be told how to fix it");
});

test("auth status leaves canonical entries unannotated", async () => {
  const listed = [{ provider: "openai", valid: true, has_refresh: false, expires_at: null }];
  const { output } = await withStubbedAuth({ listed }, () => cmdAuthStatus());
  assert.match(output, /openai/);
  assert.doesNotMatch(output, /alias of/);
});

test("auth login rejects a missing provider before touching the store", async () => {
  const { status, record, output } = await withStubbedAuth({}, () => cmdAuthLogin(undefined));
  assert.equal(status, 1);
  assert.deepEqual(record.saved, []);
  assert.match(output, /Usage: minitok auth login <provider>/);
  assert.match(output, /aliases claude, gpt, gemini are accepted/);
});

test("auth logout rejects a missing provider before touching the store", async () => {
  const { status, record } = await withStubbedAuth({}, () => cmdAuthLogout(undefined));
  assert.equal(status, 1);
  assert.deepEqual(record.removed, []);
});

test("auth status reports an empty store with the next step", async () => {
  const { status, output } = await withStubbedAuth({ listed: [] }, () => cmdAuthStatus());
  assert.equal(status, 0);
  assert.match(output, /No stored credentials/);
  assert.match(output, /minitok auth login <provider>/);
});

test("auth login keeps an unknown provider name intact", async () => {
  // A custom endpoint is a legitimate name; normalisation must not mangle it.
  const { status, record } = await withStubbedAuth({}, () => cmdAuthLogin("Local-Ollama"));
  assert.equal(status, 0);
  assert.deepEqual(record.saved.map(entry => entry.provider), ["local-ollama"]);
});
