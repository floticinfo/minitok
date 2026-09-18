"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer, startServer } = require("./server");

test("fixture module can be loaded without opening a listening server", () => {
  const server = createServer();
  assert.equal(server.listening, false);
  server.close();
});

test("fixture server closes cleanly after a real local observation", async () => {
  const app = await startServer();
  assert.equal(app.server.listening, true);
  await app.close();
  assert.equal(app.server.listening, false);
});
