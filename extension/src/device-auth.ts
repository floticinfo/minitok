import * as vscode from "vscode";

export type ExtensionAuthState = { access_token: string; refresh_token: string; customer_id?: string; token_type: string; expires_in?: number; expires_at?: string };

type CustomerSessionResponse = { access_token?: string; accessToken?: string; refresh_token?: string; refreshToken?: string; customer_id?: string; customerId?: string; token_type?: string; tokenType?: string; expires_in?: number; expiresIn?: number; expires_at?: string; expiresAt?: string };

function normalizeCustomerSession(value: CustomerSessionResponse): ExtensionAuthState | undefined {
  const accessToken = value?.access_token || value?.accessToken;
  const refreshToken = value?.refresh_token || value?.refreshToken;
  if (!accessToken || !refreshToken) return undefined;
  const expiresIn = Number(value.expires_in ?? value.expiresIn);
  const expiresAt = value.expires_at || value.expiresAt || (Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined);
  return { access_token: accessToken, refresh_token: refreshToken, customer_id: value.customer_id || value.customerId, token_type: value.token_type || value.tokenType || "Bearer", ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_in: expiresIn } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) };
}
export type AuthFailureKind = "login" | "entitlement" | "network";

const SESSION_KEY = "minitok.secret.accountSession";
const DEFAULT_SERVER = "https://api.minitok.dev";

function serverUrl() {
  const configured = vscode.workspace.getConfiguration("minitok").get<string>("serverUrl", DEFAULT_SERVER).trim();
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error("minitok.serverUrl must be a valid HTTPS URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("minitok.serverUrl must use HTTPS and contain only an origin");
  if (!loopback && url.hostname !== "api.minitok.dev") throw new Error("minitok.serverUrl is not an allowed authentication origin");
  return url.origin;
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
    response = await fetch(`${serverUrl()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
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
    const error = new Error(value?.error || `Authentication request failed (${response.status})`);
    Object.assign(error, { kind: response.status >= 500 ? "network" : "login" as AuthFailureKind });
    throw error;
  }
  return value;
}

export async function readExtensionSession(context: vscode.ExtensionContext) {
  const raw = await context.secrets.get(SESSION_KEY);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as ExtensionAuthState; } catch { await context.secrets.delete(SESSION_KEY); return undefined; }
}

async function save(context: vscode.ExtensionContext, session: CustomerSessionResponse) {
  const normalized = normalizeCustomerSession(session);
  if (!normalized) throw new Error("Account session is incomplete");
  await context.secrets.store(SESSION_KEY, JSON.stringify({ ...normalized, expires_at: expiry(normalized) }));
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

export async function deviceLogin(context: vscode.ExtensionContext, onStatus: (text: string) => void) {
  let start: any;
  try { start = await request("/v1/auth/device/authorize", { client_id: "minitok-extension" }); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { kind: "network" as const }); }
  const verificationUrl = start.verification_uri_complete || start.verification_uri;
  onStatus(`Waiting for browser authorization at ${start.verification_uri}`);
  await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
  const deadline = Date.now() + Math.min(Number(start.expires_in || 600) * 1000, 10 * 60 * 1000);
  let interval = Math.max(2000, Number(start.interval || 5) * 1000);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, interval));
    try {
      const result = await request("/v1/auth/device/token", { device_code: start.device_code });
      if (result.access_token || result.accessToken) { await save(context, result); return normalizeCustomerSession(result); }
    } catch (error: any) {
      // RFC 8628: "authorization_pending" means keep polling, "slow_down" means
      // poll less often. Treating slow_down as fatal aborted valid logins.
      if (error?.message === "authorization_pending") continue;
      if (error?.message === "slow_down") { interval += 5000; continue; }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { kind: error?.kind || "login" });
    }
  }
  throw Object.assign(new Error("Browser authorization timed out."), { kind: "login" as const });
}

export async function logoutExtension(context: vscode.ExtensionContext) {
  const session = await readExtensionSession(context);
  if (session?.refresh_token) { try { await request("/v1/auth/logout", { refresh_token: session.refresh_token }); } catch {} }
  await context.secrets.delete(SESSION_KEY);
}

export function authErrorText(error: any) {
  const kind = error?.kind || "login";
  if (kind === "network") return `Network error: ${error.message || "Unable to reach minitok."}`;
  if (kind === "entitlement") return `Entitlement error: ${error.message || "An active entitlement is required."}`;
  return `Login failed: ${error.message || "Browser authorization was not completed."}`;
}
