"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EntitlementCache = void 0;
exports.decodeJwtPayload = decodeJwtPayload;
const SECRET_KEY = "minitok.secret.entitlement";
/** How long a cached session is trusted without contacting the server (24h, matching the CLI). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Decode a JWT payload without verifying it — verification is the server's job. */
function decodeJwtPayload(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return null;
        const json = Buffer.from(parts[1], "base64url").toString("utf8");
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== "object")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
class EntitlementCache {
    secrets;
    constructor(secrets) {
        this.secrets = secrets;
    }
    /** Persist the session token plus decoded payload for offline rendering. */
    async save(token) {
        const payload = decodeJwtPayload(token);
        if (!payload)
            throw new Error("Could not decode the entitlement token.");
        const session = { token, cachedAt: Date.now(), payload };
        await this.secrets.store(SECRET_KEY, JSON.stringify(session));
        return session;
    }
    /** Load the stored session, or null when none exists or it is unreadable. */
    async load() {
        const raw = await this.secrets.get(SECRET_KEY);
        if (!raw)
            return null;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.token !== "string" || !parsed.payload)
                return null;
            return parsed;
        }
        catch {
            return null;
        }
    }
    /** Remove the stored session (used by deactivate, even if revocation fails). */
    async clear() {
        try {
            await this.secrets.delete(SECRET_KEY);
        }
        catch {
            // Deleting a missing secret is not an error for the caller.
        }
    }
    /**
     * Offline fallback: a cached session whose `exp` is still in the future is
     * treated as valid. Returns null when there is no usable cached session.
     */
    async loadValidOffline() {
        const session = await this.load();
        if (!session)
            return null;
        const exp = typeof session.payload.exp === "number" ? session.payload.exp * 1000 : 0;
        if (exp <= Date.now())
            return null;
        return session;
    }
    /** True when the cached session is older than the 24h refresh window. */
    async needsRefresh() {
        const session = await this.load();
        if (!session)
            return true;
        return Date.now() - session.cachedAt > SESSION_TTL_MS;
    }
}
exports.EntitlementCache = EntitlementCache;
