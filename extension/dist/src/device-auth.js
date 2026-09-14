"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readExtensionSession = readExtensionSession;
exports.refreshExtensionSession = refreshExtensionSession;
exports.deviceLogin = deviceLogin;
exports.logoutExtension = logoutExtension;
exports.authErrorText = authErrorText;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const workspace_1 = require("./workspace");
function jwtExpiry(accessToken) {
    try {
        const part = accessToken.split(".")[1];
        if (!part)
            return undefined;
        const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
        return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? new Date(payload.exp * 1000).toISOString() : undefined;
    }
    catch {
        return undefined;
    }
}
function normalizeAccessSession(value) {
    const accessToken = value?.access_token || value?.accessToken;
    if (!accessToken)
        return undefined;
    const refreshToken = value?.refresh_token || value?.refreshToken;
    const expiresIn = Number(value.expires_in ?? value.expiresIn);
    const expiresAt = value.expires_at || value.expiresAt || (Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : jwtExpiry(accessToken));
    return { access_token: accessToken, ...(refreshToken ? { refresh_token: refreshToken } : {}), customer_id: value.customer_id || value.customerId, token_type: value.token_type || value.tokenType || "Bearer", ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_in: expiresIn } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) };
}
function normalizeCustomerSession(value) {
    const session = normalizeAccessSession(value);
    return session?.refresh_token ? session : undefined;
}
const SESSION_KEY = "minitok.secret.accountSession";
const SHARED_SESSION_FILE = path.join(os.homedir(), ".minitok", "account", "session.json");
const LEGACY_CUSTOMER_TOKEN_FILE = path.join(os.homedir(), ".minitok", "entitlement", "customer-token.json");
function expiry(session) {
    return session.expires_at || (Number.isFinite(Number(session.expires_in)) ? new Date(Date.now() + Number(session.expires_in) * 1000).toISOString() : undefined);
}
const REQUEST_TIMEOUT_MS = 15000;
/**
 * POST a JSON body with a hard deadline.
 *
 * A bare fetch has no timeout: a stalled connection left device login and token
 * refresh pending forever, and the extension surfaced nothing to the user.
 */
async function request(path, body) {
    let response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        response = await fetch(`${(0, workspace_1.configuredServerUrl)()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    }
    catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        const message = aborted ? `minitok request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : (error instanceof Error ? error.message : String(error));
        throw Object.assign(new Error(message), { kind: "network" });
    }
    finally {
        clearTimeout(timer);
    }
    let value = null;
    try {
        value = await response.json();
    }
    catch { }
    if (!response.ok) {
        // Carry the machine readable code: device login decides whether to keep
        // polling from it, and deriving that decision from a human message broke as
        // soon as a server sent a structured body (it stringified to "[object Object]").
        const code = typeof value?.code === "string" ? value.code : typeof value?.error === "string" ? value.error : `http_${response.status}`;
        const detail = typeof value?.error_description === "string" && value.error_description ? value.error_description : code;
        const error = new Error(detail);
        Object.assign(error, { code, kind: response.status >= 500 ? "network" : "login" });
        throw error;
    }
    return value;
}
function sharedSession() {
    try {
        const raw = JSON.parse(fs.readFileSync(SHARED_SESSION_FILE, "utf8"));
        if (raw && raw.revoked_at)
            return undefined;
        const session = normalizeAccessSession(raw);
        if (session && (!session.expires_at || Date.now() < Date.parse(session.expires_at) - 60000))
            return session;
    }
    catch { }
    return undefined;
}
function writeSharedSession(session) {
    fs.mkdirSync(path.dirname(SHARED_SESSION_FILE), { recursive: true });
    const temp = `${SHARED_SESSION_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify({ ...session, saved_at: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
        fs.chmodSync(temp, 0o600);
    }
    catch { }
    fs.renameSync(temp, SHARED_SESSION_FILE);
    try {
        fs.chmodSync(SHARED_SESSION_FILE, 0o600);
    }
    catch { }
}
async function readExtensionSession(context) {
    const shared = sharedSession();
    // A present shared file is authoritative, including a CLI logout/revocation
    // marker. Do not resurrect a stale SecretStorage session in that case.
    if (fs.existsSync(SHARED_SESSION_FILE)) {
        if (!shared) {
            try {
                fs.unlinkSync(SHARED_SESSION_FILE);
            }
            catch { }
            await context.secrets.delete(SESSION_KEY);
        }
        return shared;
    }
    const raw = await context.secrets.get(SESSION_KEY);
    if (!raw)
        return undefined;
    try {
        const session = normalizeAccessSession(JSON.parse(raw));
        const expiresAt = session?.expires_at ? Date.parse(session.expires_at) : 0;
        if (!session || (expiresAt > 0 && Date.now() >= expiresAt - 60000)) {
            await context.secrets.delete(SESSION_KEY);
            return undefined;
        }
        return session;
    }
    catch {
        await context.secrets.delete(SESSION_KEY);
        return undefined;
    }
}
async function save(context, session) {
    const normalized = normalizeCustomerSession(session);
    if (!normalized)
        throw new Error("Account session is incomplete");
    const saved = { ...normalized, expires_at: expiry(normalized) };
    await context.secrets.store(SESSION_KEY, JSON.stringify(saved));
    writeSharedSession(saved);
    // A browser login is an explicit account switch. Remove the legacy CLI token
    // so the CLI cannot prefer a stale account over this shared session.
    try {
        fs.unlinkSync(LEGACY_CUSTOMER_TOKEN_FILE);
    }
    catch { }
}
async function refreshExtensionSession(context) {
    const session = await readExtensionSession(context);
    if (!session?.refresh_token)
        return undefined;
    const expiresAt = session.expires_at ? Date.parse(session.expires_at) : 0;
    if (expiresAt > Date.now() + 60000)
        return session;
    try {
        const next = await request("/v1/auth/token/refresh", { refresh_token: session.refresh_token });
        await save(context, next);
        return normalizeCustomerSession(next);
    }
    catch {
        return undefined;
    }
}
async function deviceLogin(context, onStatus) {
    let start;
    try {
        start = await request("/v1/auth/device/authorize", { client_id: "minitok-extension" });
    }
    catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { kind: "network" });
    }
    const verificationUrl = start.verification_uri_complete || start.verification_uri;
    onStatus(`Waiting for browser authorization at ${start.verification_uri}`);
    await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
    const deadline = Date.now() + Math.min(Number(start.expires_in || 600) * 1000, 10 * 60 * 1000);
    let interval = Math.max(2000, Number(start.interval || 5) * 1000);
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, interval));
        try {
            const result = await request("/v1/auth/device/token", { device_code: start.device_code });
            if (result.access_token || result.accessToken) {
                await save(context, result);
                return normalizeCustomerSession(result);
            }
        }
        catch (error) {
            // RFC 8628: "authorization_pending" means keep polling, "slow_down" means
            // poll less often. Treating slow_down as fatal aborted valid logins; the
            // message comparison stays as a fallback for servers that only send text.
            const pollingCode = typeof error?.code === "string" ? error.code : error?.message;
            if (pollingCode === "authorization_pending")
                continue;
            if (pollingCode === "slow_down") {
                interval += 5000;
                continue;
            }
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), { kind: error?.kind || "login" });
        }
    }
    throw Object.assign(new Error("Browser authorization timed out."), { kind: "login" });
}
async function logoutExtension(context) {
    const session = await readExtensionSession(context);
    let remoteRevoked = false;
    if (session?.refresh_token) {
        try {
            await request("/v1/auth/logout", { refresh_token: session.refresh_token });
            remoteRevoked = true;
        }
        catch { }
    }
    await context.secrets.delete(SESSION_KEY);
    try {
        fs.unlinkSync(SHARED_SESSION_FILE);
    }
    catch { }
    // Browser sign-out must also end a CLI customer-login session; otherwise the
    // CLI token file would immediately authenticate the next Extension check.
    try {
        fs.unlinkSync(LEGACY_CUSTOMER_TOKEN_FILE);
    }
    catch { }
    return remoteRevoked;
}
function authErrorText(error) {
    const kind = error?.kind || "login";
    if (kind === "network")
        return `Network error: ${error.message || "Unable to reach minitok."}`;
    if (kind === "entitlement")
        return `Entitlement error: ${error.message || "An active entitlement is required."}`;
    return `Login failed: ${error.message || "Browser authorization was not completed."}`;
}
