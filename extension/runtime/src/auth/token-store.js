"use strict";

/**
 * Token Store — persists OAuth/refresh tokens to disk.
 * Storage: ~/.minitok/tokens/<provider>.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { setOwnerOnlyPermissions } = require("../utils/file-permissions");
const { execFileSync } = require("child_process");

const TOKENS_DIR = path.join(os.homedir(), ".minitok", "tokens");
// Short enough that another process rotating a token is picked up almost
// immediately, long enough to remove the repeated keychain process per request.
const LOAD_CACHE_TTL_MS = 5000;

class TokenStore {
  constructor(tokensDir) {
    this._dir = tokensDir || TOKENS_DIR;
    /** @type {Map<string, { at: number, record: any }>} */
    this._cache = new Map();
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
  /**
   * Escape a value for interpolation inside a single-quoted PowerShell string.
   *
   * Provider names come from minitok.yml (a repository-controlled file) and from
   * CLI arguments, so they must never reach a -Command script verbatim: a name
   * such as  x') ; <payload> ; ('y  closes the string literal and runs the
   * injected statements. Doubling single quotes is the complete escape for a
   * single-quoted PowerShell literal ($(), backticks and " stay inert).
   */
  _escapePowerShellString(value) { return String(value).replace(/'/g, "''"); }

  /** PowerShell -Command script that reads a stored secret. */
  _powerShellLoadCommand(provider) {
    return `(Get-Secret -Name '${this._escapePowerShellString(this._keychainName(provider))}' -AsPlainText -ErrorAction Stop | ConvertFrom-Json) | ConvertTo-Json -Compress`;
  }

  /**
   * PowerShell -Command script that stores a secret.
   *
   * The payload is read from stdin, never passed as an argument: an argument is
   * visible to every local process through the process command line
   * (Win32_Process.CommandLine — Task Manager, WMI, Sysmon), which exposed the API
   * key it was meant to store.
   */
  _powerShellSaveCommand(provider) {
    return `$payload = [Console]::In.ReadToEnd(); $secret = ConvertTo-SecureString -String $payload -AsPlainText -Force; Set-Secret -Name '${this._escapePowerShellString(this._keychainName(provider))}' -Secret $secret -ErrorAction Stop`;
  }

  /** PowerShell -Command script that removes a stored secret. */
  _powerShellRemoveCommand(provider) {
    return `Remove-Secret -Name '${this._escapePowerShellString(this._keychainName(provider))}' -ErrorAction SilentlyContinue`;
  }

  /** @returns {Record<string, unknown> | null} */
  _keychainLoad(provider) {
    // The child's stderr is discarded: without the SecretManagement module every
    // read prints a PowerShell error that is expected (the owner-only token file is
    // the documented fallback) and only confuses the CLI output.
    const options = /** @type {import("child_process").ExecFileSyncOptionsWithStringEncoding} */ ({ encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    try {
      if (process.platform === "win32") return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", this._powerShellLoadCommand(provider)], options).trim());
      if (process.platform === "darwin") return JSON.parse(execFileSync("security", ["find-generic-password", "-s", this._keychainName(provider), "-w"], options).trim());
      return JSON.parse(execFileSync("secret-tool", ["lookup", "service", "minitok", "provider", provider], options).trim());
    } catch { return null; }
  }

  /**
   * Verify the keychain holds what was just written.
   *
   * A storage command can exit 0 without persisting anything (a missing
   * SecretManagement module, an unexpected stdin contract, a platform-specific
   * `security` option). Reporting success for a secret that cannot be read back
   * would log the user into an account that stops working later, so the write is
   * confirmed and the owner-only token file is used when it is not.
   */
  _keychainReadBack(provider, record) {
    const stored = this._keychainLoad(provider);
    return Boolean(stored && stored.access_token && stored.access_token === record.access_token);
  }

  /** @param {Record<string, unknown>} record @returns {boolean} */
  _keychainSave(provider, record) {
    const payload = JSON.stringify(record);
    try {
      if (process.platform === "win32") {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", this._powerShellSaveCommand(provider)], { input: payload, stdio: ["pipe", "ignore", "ignore"], timeout: 5000, windowsHide: true });
        return this._keychainReadBack(provider, record);
      }
      if (process.platform === "darwin") {
        // `security add-generic-password` without a -w value reads the secret from
        // stdin, keeping it out of the process argument list (ps).
        execFileSync("security", ["add-generic-password", "-U", "-s", this._keychainName(provider), "-a", process.env.USER || "minitok", "-w"], { input: `${payload}\n`, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 });
        return this._keychainReadBack(provider, record);
      }
      execFileSync("secret-tool", ["store", "--label", this._keychainName(provider), "service", "minitok", "provider", provider], { input: payload, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 });
      return this._keychainReadBack(provider, record);
    } catch { return false; }
  }

  _keychainRemove(provider) {
    try {
      if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", this._powerShellRemoveCommand(provider)], { stdio: "ignore", timeout: 5000, windowsHide: true });
      else if (process.platform === "darwin") execFileSync("security", ["delete-generic-password", "-s", this._keychainName(provider)], { stdio: "ignore", timeout: 5000 });
      else execFileSync("secret-tool", ["clear", "service", "minitok", "provider", provider], { stdio: "ignore", timeout: 5000 });
    } catch {}
  }

  /**
   * Load stored token data for a provider.
   *
   * Reads are cached briefly: this shells out to the OS keychain (a PowerShell
   * process on Windows, ~0.5s) and the auth resolver calls isValid() + load()
   * for every provider request, so an uncached read added roughly a second to
   * every LLM call. Writes invalidate the entry.
   */
  load(provider) {
    const cached = this._cache.get(provider);
    if (cached && Date.now() - cached.at < LOAD_CACHE_TTL_MS) return cached.record;
    const record = this._loadFromSource(provider);
    this._cache.set(provider, { at: Date.now(), record });
    return record;
  }

  _loadFromSource(provider) {
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
    this._cache.delete(provider);
    const fp = this._filePath(provider);
    const record = { provider, ...tokenData, saved_at: new Date().toISOString() };
    if (this._keychainSave(provider, record)) { try { fs.unlinkSync(this._filePath(provider)); } catch {} return; }
    // Random suffix (not Math.random): two runs in one process must never pick
    // the same temporary name, or one would unlink the other's in-flight write.
    const tmp = `${fp}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
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
    this._cache.delete(provider);
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

module.exports = { TokenStore, TOKENS_DIR, LOAD_CACHE_TTL_MS };
