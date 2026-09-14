"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ALIAS_MAP, normalizeProvider, aliasesFor } = require("./aliases");

describe("provider aliases: normalisation", () => {
  it("maps every alias to its canonical provider", () => {
    assert.equal(normalizeProvider("claude"), "anthropic");
    assert.equal(normalizeProvider("gpt"), "openai");
    assert.equal(normalizeProvider("gemini"), "google");
  });

  it("normalises case and surrounding whitespace-free input the same way", () => {
    assert.equal(normalizeProvider("GPT"), "openai");
    assert.equal(normalizeProvider("Claude"), "anthropic");
    assert.equal(normalizeProvider("GEMINI"), "google");
  });

  it("passes canonical and unknown names through lowercased", () => {
    assert.equal(normalizeProvider("OpenAI"), "openai");
    assert.equal(normalizeProvider("anthropic"), "anthropic");
    assert.equal(normalizeProvider("local-ollama"), "local-ollama");
  });

  it("treats missing names as an empty key instead of throwing", () => {
    for (const value of [undefined, null, "", 0]) {
      assert.equal(typeof normalizeProvider(value), "string");
    }
    assert.equal(normalizeProvider(undefined), "");
    assert.equal(normalizeProvider(null), "");
  });

  it("is idempotent, so resolving twice cannot change the key", () => {
    for (const name of ["claude", "gpt", "gemini", "openai", "unknown-provider"]) {
      assert.equal(normalizeProvider(normalizeProvider(name)), normalizeProvider(name));
    }
  });
});

describe("provider aliases: alias lookup", () => {
  it("returns the alias names that resolve to a canonical provider", () => {
    assert.deepEqual(aliasesFor("openai"), ["gpt"]);
    assert.deepEqual(aliasesFor("gpt"), ["gpt"]);
    assert.deepEqual(aliasesFor("anthropic"), ["claude"]);
    assert.deepEqual(aliasesFor("google"), ["gemini"]);
  });

  it("returns nothing for a name that is not in the table", () => {
    assert.deepEqual(aliasesFor("local-ollama"), []);
    assert.deepEqual(aliasesFor(""), []);
  });

  it("never returns the queried name's canonical form when it is unrelated", () => {
    for (const alias of Object.keys(ALIAS_MAP)) {
      assert.equal(aliasesFor(alias).every(name => ALIAS_MAP[name] === ALIAS_MAP[alias]), true);
    }
  });
});

describe("provider aliases: single source of truth", () => {
  const sourceRoot = path.resolve(__dirname, "..");
  const definition = /claude:\s*"anthropic"/;

  function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : jsFiles(full);
      return entry.name.endsWith(".js") ? [full] : [];
    });
  }

  it("declares the alias table in exactly one module", () => {
    const owners = jsFiles(sourceRoot)
      .filter(file => definition.test(fs.readFileSync(file, "utf8")))
      .map(file => path.relative(sourceRoot, file).split(path.sep).join("/"));
    // The table used to be copied into the auth manager, doctor, run and the
    // pipeline loop, so a new alias (or a fix to one) silently missed the other
    // call sites. Consumers must import it instead.
    assert.deepEqual(owners, ["auth/aliases.js"]);
  });

  it("re-exports the shared table from the auth entry point", () => {
    const entry = require("./index.js");
    assert.deepEqual(entry.ALIAS_MAP, ALIAS_MAP);
  });

  it("leaves no local alias table in the other consumers", () => {
    for (const rel of ["cli/commands/doctor.js", "cli/commands/run.js", "pipeline/loop.js"]) {
      const source = fs.readFileSync(path.resolve(sourceRoot, rel), "utf8");
      assert.doesNotMatch(source, /(providerAliases|aliasOf|ALIAS_MAP)\s*=\s*\{/, `${rel} declares its own table`);
      assert.match(source, /require\(["'][^"']*\/aliases["']\)/, `${rel} imports the shared table`);
    }
  });

  it("keeps the credential writer and the credential reader on one normaliser", () => {
    // The asymmetry this guards against: `auth login gpt` keyed the credential
    // by the raw argument while the resolver normalised it before reading, so
    // the credential could never be found again.
    for (const rel of ["auth/index.js", "cli/commands/auth.js"]) {
      const source = fs.readFileSync(path.resolve(sourceRoot, rel), "utf8");
      assert.match(source, /require\(["'][^"']*\/aliases["']\)/, `${rel} imports the shared normaliser`);
      assert.match(source, /normalizeProvider/, `${rel} normalises provider names`);
    }
  });
});
