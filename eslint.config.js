const js = require("@eslint/js");

const commonGlobals = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  fetch: "readonly",
  Response: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  structuredClone: "readonly",
  crypto: "readonly",
  performance: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  queueMicrotask: "readonly",
  setImmediate: "readonly",
  require: "readonly",
  module: "writable",
  exports: "writable",
  __dirname: "readonly",
  __filename: "readonly",
};

module.exports = [
  { ignores: ["node_modules/**", "coverage/**", "docs/**", "**/*.tgz", "flotic-*.tgz"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: commonGlobals,
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-undef": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-async-promise-executor": "error",
      "require-atomic-updates": "off",
      "no-console": "off",
      "no-prototype-builtins": "off",
    },
  },
  {
    files: ["tests/**"],
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    // Integration test helpers written as ESM
    files: ["tests/test-m3-runtime.js", "tests/test-m4-launch.js", "src/agent/**/*.mjs"],
    languageOptions: { sourceType: "module", globals: commonGlobals },
  },
];
