import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { configuredServerUrl } from "./workspace";

export type ExtensionAuthState = { access_token: string; refresh_token?: string; customer_id?: string; token_type: string; expires_in?: number; expires_at?: string };

type CustomerSessionResponse = { access_token?: string; accessToken?: string; refresh_token?: string; refreshToken?: string; customer_id?: string; customerId?: string; token_type?: string; tokenType?: string; expires_in?: number; expiresIn?: number; expires_at?: string; expiresAt?: string };

function jwtExpiry(accessToken: string) {
  try {
    const part = accessToken.split(".")[1];
    if (!part) return undefined;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? new Date(payload.exp * 1000).toISOString() : undefined;
  } catch { return undefined; }
}

function normalizeAccessSession(value: CustomerSessionResponse): ExtensionAuthState | undefined {
  const accessToken = value?.access_token || value?.accessToken;
  if (!accessToken) return undefined;
  const refreshToken = value?.refresh_token || value?.refreshToken;
  const expiresIn = Number(value.expires_in ?? value.expiresIn);
  const expiresAt = value.expires_at || value.expiresAt || (Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : jwtExpiry(accessToken));
  return { access_token: accessToken, ...(refreshToken ? { refresh_token: refreshToken } : {}), customer_id: value.customer_id || value.customerId, token_type: value.token_type || value.tokenType || "Bearer", ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_in: expiresIn } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) };
}

function normalizeCustomerSession(value: CustomerSessionResponse): ExtensionAuthState | undefined {
  const session = normalizeAccessSession(value);
  return session?.refresh_token ? session : undefined;
}
export type AuthFailureKind = "login" | "entitlement" | "network";

const SESSION_KEY = "minitok.secret.accountSession";
const ADMIN_SESSION_KEY = "minitok.secret.adminSession";
const SHARED_SESSION_FILE = path.join(os.homedir(), ".minitok", "account", "session.json");
const LEGACY_CUSTOMER_TOKEN_FILE = path.join(os.homedir(), ".minitok", "entitlement", "customer-token.json");

function legacyCustomerSession(): ExtensionAuthState | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_CUSTOMER_TOKEN_FILE, "utf8")) as { token?: unknown };
    if (typeof raw.token !== "string" || !raw.token) return undefined;
    const part = raw.token.split(".")[1];
    if (part) {
      const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof payload.exp === "number" && Date.now() >= payload.exp * 1000 - 60000) return undefined;
    }
    return { access_token: raw.token, token_type: "Bearer" };
  } catch { return undefined; }
}

function expiry(session: ExtensionAuthState) {
  return session.expires_at || (Number.isFinite(Number(session.expires_in)) ? new Date(Date.now() + Number(session.expires_in) * 1000).toISOString() : undefined);
}

const REQUEST_TIMEOUT_MS = 15000;

/**
 * POST a JSON body with a hard deadline.
 *
 * A bare fetch has no timeout: a stalled connection left device login and token
 * refresh pending forever, and the extension surfaced nothing to the user.
 */
async function request(path: string, body: Record<string, string>) {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(`${configuredServerUrl()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    const message = aborted ? `minitok request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : (error instanceof Error ? error.message : String(error));
    throw Object.assign(new Error(message), { kind: "network" as const });
  } finally {
    clearTimeout(timer);
  }
  let value: any = null;
  try { value = await response.json(); } catch {}
  if (!response.ok) {
    // Carry the machine readable code: device login decides whether to keep
    // polling from it, and deriving that decision from a human message broke as
    // soon as a server sent a structured body (it stringified to "[object Object]").
    const code = typeof value?.code === "string" ? value.code : typeof value?.error === "string" ? value.error : `http_${response.status}`;
    const detail = typeof value?.error_description === "string" && value.error_description ? value.error_description : code;
    const error = new Error(detail);
    Object.assign(error, { code, kind: response.status >= 500 ? "network" : "login" as AuthFailureKind });
    throw error;
  }
  return value;
}

function sharedSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SHARED_SESSION_FILE, "utf8")) as CustomerSessionResponse;
    if (raw && (raw as any).revoked_at) return undefined;
    const session = normalizeAccessSession(raw);
    if (session && (!session.expires_at || Date.now() < Date.parse(session.expires_at) - 60000)) return session;
  } catch {}
  return undefined;
}

function writeSharedSession(session: ExtensionAuthState) {
  fs.mkdirSync(path.dirname(SHARED_SESSION_FILE), { recursive: true });
  const temp = `${SHARED_SESSION_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({ ...session, saved_at: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, SHARED_SESSION_FILE);
  try { fs.chmodSync(SHARED_SESSION_FILE, 0o600); } catch {}
}

export async function readExtensionSession(context: vscode.ExtensionContext) {
  const shared = sharedSession();
  // A present shared file is authoritative, including a CLI logout/revocation
  // marker. Do not resurrect a stale SecretStorage session in that case.
  if (fs.existsSync(SHARED_SESSION_FILE)) {
    if (!shared) { try { fs.unlinkSync(SHARED_SESSION_FILE); } catch {} await context.secrets.delete(SESSION_KEY); }
    return shared;
  }
  const legacy = legacyCustomerSession();
  if (legacy) return legacy;
  const raw = await context.secrets.get(SESSION_KEY);
  if (!raw) return undefined;
  try {
    const session = normalizeAccessSession(JSON.parse(raw));
    const expiresAt = session?.expires_at ? Date.parse(session.expires_at) : 0;
    if (!session || (expiresAt > 0 && Date.now() >= expiresAt - 60000)) { await context.secrets.delete(SESSION_KEY); return undefined; }
    return session;
  } catch { await context.secrets.delete(SESSION_KEY); return undefined; }
}

async function save(context: vscode.ExtensionContext, session: CustomerSessionResponse) {
  const normalized = normalizeCustomerSession(session);
  if (!normalized) throw new Error("Account session is incomplete");
  const saved = { ...normalized, expires_at: expiry(normalized) };
  await context.secrets.store(SESSION_KEY, JSON.stringify(saved));
  writeSharedSession(saved);
  // A browser login is an explicit account switch. Remove the legacy CLI token
  // so the CLI cannot prefer a stale account over this shared session.
  try { fs.unlinkSync(LEGACY_CUSTOMER_TOKEN_FILE); } catch {}
}

export async function refreshExtensionSession(context: vscode.ExtensionContext) {
  const session = await readExtensionSession(context);
  if (!session?.refresh_token) return undefined;
  const expiresAt = session.expires_at ? Date.parse(session.expires_at) : 0;
  if (expiresAt > Date.now() + 60000) return session;
  try {
    const next = await request("/v1/auth/token/refresh", { refresh_token: session.refresh_token });
    await save(context, next);
    return normalizeCustomerSession(next);
  } catch { return undefined; }
}

/**
 * Cancellation token for the device login polling loop. Setting `cancelled`
 * stops the loop on its next tick so a dismissed browser tab cannot strand the
 * sidebar on "Waiting for browser authorization..." for up to ten minutes.
 */
export type DeviceLoginCancellation = { cancelled: boolean };

export async function deviceLogin(context: vscode.ExtensionContext, onStatus: (text: string) => void, cancellation?: DeviceLoginCancellation) {
  let start: any;
  try { start = await request("/v1/auth/device/authorize", { client_id: "minitok-extension" }); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { kind: "network" as const }); }
  // The server returns camelCase (deviceCode, verificationUri) while other
  // fields arrive snake_case; accept both, exactly like the CLI account flow
  // (src/cli/commands/account.js) does, so a missing field cannot silently
  // serialize an empty device_code into the token poll body.
  const deviceCode = start?.device_code || start?.deviceCode;
  if (!deviceCode) { throw Object.assign(new Error("Authorization response is missing a device code."), { kind: "login" as const }); }
  const verificationUrl = start.verification_uri_complete || start.verificationUriComplete || start.verification_uri || start.verificationUri;
  const verificationDisplay = start.verification_uri || start.verificationUri || verificationUrl;
  onStatus(`Waiting for browser authorization at ${verificationDisplay}`);
  await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
  const deadline = Date.now() + Math.min(Number(start.expires_in || start.expiresIn || 600) * 1000, 10 * 60 * 1000);
  let interval = Math.max(2000, Number(start.interval || 5) * 1000);
  // Transient network failures (a dropped connection or the 15s request
  // timeout while the user is still in the browser) must not kill the whole
  // login. Retry a bounded number of times; the 10-minute deadline above still
  // caps the total wait, and the cancellation token is checked on every tick.
  const maxNetworkRetries = 2;
  let networkRetries = 0;
  while (Date.now() < deadline) {
    if (cancellation?.cancelled) throw Object.assign(new Error("Browser sign-in was cancelled."), { kind: "login" as const, code: "cancelled" });
    await new Promise(resolve => setTimeout(resolve, interval));
    try {
      const result = await request("/v1/auth/device/token", { device_code: deviceCode });
      if (result.access_token || result.accessToken) { await save(context, result); return normalizeCustomerSession(result); }
      networkRetries = 0;
    } catch (error: any) {
      // RFC 8628: "authorization_pending" means keep polling, "slow_down" means
      // poll less often. Treating slow_down as fatal aborted valid logins; the
      // message comparison stays as a fallback for servers that only send text.
      const pollingCode = typeof error?.code === "string" ? error.code : error?.message;
      if (pollingCode === "authorization_pending") { networkRetries = 0; continue; }
      if (pollingCode === "slow_down") { networkRetries = 0; interval += 5000; continue; }
      if (error?.kind === "network" && networkRetries < maxNetworkRetries && Date.now() < deadline) {
        networkRetries += 1;
        onStatus(`Connection interrupted; still waiting for browser authorization (retry ${networkRetries}/${maxNetworkRetries}).`);
        continue;
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { kind: error?.kind || "login" });
    }
  }
  throw Object.assign(new Error("Browser authorization timed out."), { kind: "login" as const });
}

export async function logoutExtension(context: vscode.ExtensionContext) {
  const session = await readExtensionSession(context);
  let remoteRevoked = false;
  if (session?.refresh_token) { try { await request("/v1/auth/logout", { refresh_token: session.refresh_token }); remoteRevoked = true; } catch {} }
  await context.secrets.delete(SESSION_KEY);
  try { fs.unlinkSync(SHARED_SESSION_FILE); } catch {}
  // Browser sign-out must also end a CLI customer-login session; otherwise the
  // CLI token file would immediately authenticate the next Extension check.
  try { fs.unlinkSync(LEGACY_CUSTOMER_TOKEN_FILE); } catch {}
  return remoteRevoked;
}

/**
 * Server-side admin sign-in over /v1/admin/login.
 *
 * Unlike device login, admin login is a direct credentials POST: the server
 * returns the admin token in the body (webAuthResponse only strips it for
 * x-minitok-web browser requests, and the extension is not one). The admin
 * session is stored separately from the customer session so an admin sign-in
 * never collides with, or revokes, a customer session in the shared CLI file.
 */
export async function adminLogin(context: vscode.ExtensionContext, email: string, password: string) {
  const result = await request("/v1/admin/login", { email, password });
  const token = result?.token;
  if (typeof token !== "string" || !token) throw Object.assign(new Error("Admin login response is missing a token."), { kind: "login" as const });
  await context.secrets.store(ADMIN_SESSION_KEY, JSON.stringify({ token, admin_id: result.admin_id, saved_at: new Date().toISOString() }));
  return { token, admin_id: result.admin_id };
}

/** Read the stored admin session, if one exists. */
export async function readAdminSession(context: vscode.ExtensionContext) {
  const raw = await context.secrets.get(ADMIN_SESSION_KEY);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as { token: string; admin_id?: string }; } catch { return undefined; }
}

/**
 * True while an admin session is stored.
 *
 * The entitlement gate already treats an admin session as a full bypass, but both
 * webviews also ask "is anybody signed in?" before they render. That question was
 * answered from the customer session alone, so a view reopened after an admin
 * sign-in reported signed-out and painted the sign-in card again. Every surface
 * now checks the admin session first.
 */
export async function hasAdminSession(context: vscode.ExtensionContext) {
  return Boolean((await readAdminSession(context))?.token);
}

/** Sign out of the admin session only (server-side revocation via /v1/admin/logout). */
export async function logoutAdmin(context: vscode.ExtensionContext) {
  const session = await readAdminSession(context);
  let remoteRevoked = false;
  if (session?.token) {
    try {
      await fetch(`${configuredServerUrl()}/v1/admin/logout`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` } });
      remoteRevoked = true;
    } catch {}
  }
  await context.secrets.delete(ADMIN_SESSION_KEY);
  return remoteRevoked;
}

/**
 * Issue a one-time run delegation token for the CLI child (P-2 fix).
 *
 * The admin token never crosses the process boundary: the extension asks the
 * server for a short-lived token bound to this runId, and only that token —
 * valid for exactly one verification against the same runId — reaches the
 * spawned `minitok run` child, via the environment (never argv).
 */
export async function issueRunDelegation(context: vscode.ExtensionContext, runId: string): Promise<string> {
  const session = await readAdminSession(context);
  if (!session?.token) throw Object.assign(new Error("An admin session is required to issue a run delegation."), { kind: "login" as const });
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(`${configuredServerUrl()}/v1/run-delegation/issue`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ run_id: runId, ttl_seconds: 300 }), signal: controller.signal });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw Object.assign(new Error(aborted ? `minitok request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : (error instanceof Error ? error.message : String(error))), { kind: "network" as const });
  } finally { clearTimeout(timer); }
  let value: any = null;
  try { value = await response.json(); } catch {}
  if (!response.ok) {
    const code = typeof value?.code === "string" ? value.code : typeof value?.error === "string" ? value.error : `http_${response.status}`;
    const detail = typeof value?.error_description === "string" && value.error_description ? value.error_description : typeof value?.error === "string" ? value.error : code;
    throw Object.assign(new Error(detail), { code, kind: response.status >= 500 ? "network" : "login" as AuthFailureKind });
  }
  const token = value?.token;
  if (typeof token !== "string" || !token) throw Object.assign(new Error("Run delegation response is missing a token."), { kind: "login" as const });
  return token;
}

export function authErrorText(error: any) {
  const kind = error?.kind || "login";
  if (kind === "network") return `Network error: ${error.message || "Unable to reach minitok."}`;
  if (kind === "entitlement") return `Entitlement error: ${error.message || "An active entitlement is required."}`;
  return `Login failed: ${error.message || "Browser authorization was not completed."}`;
}
