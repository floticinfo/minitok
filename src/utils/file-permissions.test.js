"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { setOwnerOnlyPermissions, BROAD_PRINCIPAL_SIDS, _windowsPermissionCommands } = require("./file-permissions");

/** Read a file's ACL as SIDs so the assertions are language independent. */
function aclSids(filePath) {
  const literal = filePath.replace(/'/g, "''");
  const script = `Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; (Get-Acl -LiteralPath '${literal}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000 })
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

describe("file permissions: owner-only access", () => {
  it("sets mode 0600 on POSIX", { skip: process.platform === "win32" }, () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mt-perm-")), "token.json");
    fs.writeFileSync(file, "{}");
    setOwnerOnlyPermissions(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("removes inherited and broadly granted access on Windows", { skip: process.platform !== "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-perm-"));
    const file = path.join(dir, "token.json");
    fs.writeFileSync(file, "{}");
    // Simulate a copied or previously shared credential file: Everyone holds an
    // explicit grant, which `/grant:r <user>:F` alone never removed.
    execFileSync("icacls", [file, "/grant", "*S-1-1-0:(F)"], { stdio: "ignore", timeout: 15000 });
    assert.ok(aclSids(file).includes("S-1-1-0"), "precondition: Everyone has an explicit grant");

    setOwnerOnlyPermissions(file);
    const sids = aclSids(file);
    for (const sid of BROAD_PRINCIPAL_SIDS) {
      assert.equal(sids.includes(sid.replace(/^\*/, "")), false, `${sid} must not keep access`);
    }
    assert.ok(sids.length > 0, "the owner still has an entry");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds the icacls steps in safe order", () => {
    const commands = _windowsPermissionCommands("C:\\tmp\\token.json", "DOMAIN\\user");
    assert.equal(commands.length, 3);
    assert.deepEqual(commands[0][1], ["C:\\tmp\\token.json", "/inheritance:r"]);
    assert.equal(commands[1][1][1], "/remove:g");
    for (const sid of BROAD_PRINCIPAL_SIDS) assert.ok(commands[1][1].includes(sid), `${sid} is removed`);
    assert.deepEqual(commands[2][1], ["C:\\tmp\\token.json", "/grant:r", "DOMAIN\\user:F"]);
  });
});
