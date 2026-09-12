"use strict";

/**
 * Token Store — persists OAuth/refresh tokens to disk.
 * Storage: ~/.minitok/tokens/<provider>.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");
const { execFileSync } = require("child_process");

const TOKENS_DIR = path.join(os.homedir(), ".minitok", "tokens");

class TokenStore {
  constructor(tokensDir) {
    this._dir = tokensDir || TOKENS_DIR;
  }

  _ensureDir() {
    fs.mkdirSync(this._dir, { recursive: true });
  }

  _filePath(provider) {
    // Sanitize provider name for filename
    const safe = provider.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this._dir, `${safe}.json`);
  }

  /**
   * Load stored token data for a provider.
   * @returns {string}
   */
   _keychainName(provider) { return `minitok:${provider}`; }

  /** @returns {Record<string, unknown> | null} */
  _keychainLoad(provider) {
    try {
      if (process.platform === "win32") return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Secret -Name '${this._keychainName(provider)}' -AsPlainText -ErrorAction Stop | ConvertFrom-Json) | ConvertTo-Json -Compress`], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim());
      if (process.platform === "darwin") return JSON.parse(execFileSync("security", ["find-generic-password", "-s", this._keychainName(provider), "-w"], { encoding: "utf8", timeout: 5000 }).trim());
      return JSON.parse(execFileSync("secret-tool", ["lookup", "service", "minitok", "provider", provider], { encoding: "utf8", timeout: 5000 }).trim());
    } catch { return null; }
  }

  /** @param {Record<string, unknown>} record @returns {boolean} */
  _keychainSave(provider, record) {
    const payload = JSON.stringify(record);
    try {
      if (process.platform === "win32") { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$secret = ConvertTo-SecureString '${payload.replace(/'/g, "''")}' -AsPlainText -Force; Set-Secret -Name '${this._keychainName(provider)}' -Secret $secret -ErrorAction Stop`], { stdio: "ignore", timeout: 5000, windowsHide: true }); return true; }
      if (process.platform === "darwin") { execFileSync("security", ["add-generic-password", "-U", "-s", this._keychainName(provider), "-a", process.env.USER || "minitok", "-w", payload], { stdio: "ignore", timeout: 5000 }); return true; }
      execFileSync("secret-tool", ["store", "--label", this._keychainName(provider), "service", "minitok", "provider", provider], { input: payload, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 }); return true;
    } catch { return false; }
  }

  _keychainRemove(provider) {
    try {
      if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Remove-Secret -Name '${this._keychainName(provider)}' -ErrorAction SilentlyContinue`], { stdio: "ignore", timeout: 5000, windowsHide: true });
      else if (process.platform === "darwin") execFileSync("security", ["delete-generic-password", "-s", this._keychainName(provider)], { stdio: "ignore", timeout: 5000 });
      else execFileSync("secret-tool", ["clear", "service", "minitok", "provider", provider], { stdio: "ignore", timeout: 5000 });
    } catch {}
  }

  load(provider) {
    const keychain = this._keychainLoad(provider);
    if (keychain) return keychain;
    const fp = this._filePath(provider);
    try {
      const data = fs.readFileSync(fp, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Save token data for a provider.
   */
  save(provider, tokenData) {
    this._ensureDir();
    const fp = this._filePath(provider);
    const record = { provider, ...tokenData, saved_at: new Date().toISOString() };
    if (this._keychainSave(provider, record)) { try { fs.unlinkSync(this._filePath(provider)); } catch {} return; }
    const tmp = `${fp}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, fp);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
    // P3-01: Set owner-only permissions (POSIX + Windows ACL)
    setOwnerOnlyPermissions(fp);
  }

  /**
   * Delete stored token for a provider.
   */
  remove(provider) {
    this._keychainRemove(provider);
    const fp = this._filePath(provider);
    try {
      fs.unlinkSync(fp);
    } catch {
      // Ignore if not found
    }
  }

  /**
   * Check if a token exists and is not expired.
   * @returns {boolean}
   */
  isValid(provider) {
    const token = this.load(provider);
    if (!token || !token.access_token) return false;
    if (token.expires_at) {
      // Add 60-second buffer before expiry
      const expiry = new Date(token.expires_at).getTime() - 60000;
      if (Date.now() >= expiry) return false;
    }
    return true;
  }

  /**
   * List all stored providers.
   */
  list() {
    this._ensureDir();
    return fs.readdirSync(this._dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this._dir, f), "utf-8"));
          if (!data || typeof data !== "object" || Array.isArray(data)) return [];
          return [{
            provider: data.provider || f.replace(".json", ""),
            has_refresh: Boolean(data.refresh_token),
            expires_at: data.expires_at || null,
            valid: data.expires_at ? Date.now() < new Date(data.expires_at).getTime() - 60000 : Boolean(data.access_token),
          }];
        } catch {
          return [];
        }
      });
  }
}

module.exports = { TokenStore, TOKENS_DIR };
