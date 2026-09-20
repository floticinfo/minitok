"use strict";

/**
 * File Permission Utilities — cross-platform owner-only access.
 *
 * On POSIX: uses fs.chmodSync(0o600) for owner read/write only.
 * On Windows: uses icacls to grant only the current user full control,
 *             removing inherited permissions.
 *
 * These functions enforce owner-only access for credential material.
 */

const fs = require("fs");
const { execFileSync } = require("child_process");

/**
 * Set a file to owner-only access.
 *
 * @param {string} filePath - Absolute path to the file
 */
function setOwnerOnlyPermissions(filePath) {
  if (process.platform === "win32") {
    _setWindowsPermissions(filePath);
  } else {
    fs.chmodSync(filePath, 0o600);
  }
}

/**
 * Principals that must never keep access to credential material.
 *
 * Well-known SIDs are used instead of localized principal names ("Everyone" is
 * displayed under a translated name on non-English Windows), so the removal works
 * on every language.
 */
const BROAD_PRINCIPAL_SIDS = ["*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545", "*S-1-5-4", "*S-1-5-32-546"];

/**
 * Build the icacls commands for owner-only access.
 *
 * `/grant:r <user>:F` only replaces the current user's explicit entries: an
 * explicit grant to Everyone (which is how a copied or previously shared file
 * arrives) survived it, leaving the credential readable by every local account.
 *
 * @param {string} filePath
 * @param {string} username
 * @returns {Array<[string, string[]]>}
 */
function _windowsPermissionCommands(filePath, username) {
  return [
    ["icacls", [filePath, "/inheritance:r"]],
    ["icacls", [filePath, "/remove:g", ...BROAD_PRINCIPAL_SIDS]],
    ["icacls", [filePath, "/grant:r", `${username}:F`]],
  ];
}

/**
 * Windows ACL: grant only the current user full control.
 *
 * Uses icacls to:
 * 1. Disable inheritance and remove inherited ACEs
 * 2. Remove explicit grants held by broad principals
 * 3. Grant only the current user Full Control
 *
 * This is the closest equivalent to POSIX 0o600 on Windows NTFS.
 */
function currentWindowsPrincipal() {
  try {
    const principal = execFileSync("whoami", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    if (principal) return principal;
  } catch {}
  const username = typeof process.env.USERNAME === "string" ? process.env.USERNAME.trim() : "";
  if (!username) throw new Error("Unable to resolve the current Windows principal");
  const domain = typeof process.env.USERDOMAIN === "string" ? process.env.USERDOMAIN.trim() : "";
  return domain ? `${domain}\\${username}` : username;
}
function _setWindowsPermissions(filePath) {
  const username = currentWindowsPrincipal();
  const [[, inheritArgs], [, removeArgs], [, grantArgs]] = _windowsPermissionCommands(filePath, username);
  // Each step is independent: a missing principal to remove, or a lock held by
  // another process, must not skip the grant that follows.
  try { execFileSync("icacls", inheritArgs, { stdio: "ignore", timeout: 5000 }); } catch {}
  try { execFileSync("icacls", removeArgs, { stdio: "ignore", timeout: 5000 }); } catch {}
  try {
    execFileSync("icacls", grantArgs, { stdio: "ignore", timeout: 5000 });
  } catch {
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }
}

module.exports = { setOwnerOnlyPermissions, BROAD_PRINCIPAL_SIDS, _windowsPermissionCommands };

