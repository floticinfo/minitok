"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Command } = require("commander");
const { ADMIN_CONSOLE_URL, adminConsoleUrl } = require("../src/cli/commands/admin");

test("admin console uses the real browser administrator route", () => {
  assert.equal(adminConsoleUrl(), "https://minitok.dev/admin");
  assert.equal(ADMIN_CONSOLE_URL, "https://minitok.dev/admin");
  assert.equal(/device_code|oauth|\/login$/.test(adminConsoleUrl()), false);
});

test("admin command is separate from customer device authorization", () => {
  const program = new Command();
  require("../src/cli/commands/admin").register(program);
  require("../src/cli/commands/account").registerAccount(program);
  const admin = program.commands.find(command => command.name() === "admin");
  const account = program.commands.find(command => command.name() === "account");
  assert.ok(admin.commands.some(command => command.name() === "open"));
  assert.ok(admin.commands.some(command => command.name() === "status"));
  assert.match(account.commands.find(command => command.name() === "login").description(), /device authorization/);
  assert.doesNotMatch(admin.commands.find(command => command.name() === "open").description(), /device authorization/);
});
