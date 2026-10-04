"use strict";

/**
 * SecretStorage-backed entitlement session cache (Phase 3).
 *
 * Mirrors src/entitlement/cache.js from the CLI: the session JWT is stored
 * together with its decoded payload so the sidebar can render plan/expiry
 * offline, and the `exp` claim provides an offline fallback decision when the
 * server cannot be reached. Secret key: `minitok.secret.entitlement`.
 */

import * as vscode from "vscode";

const SECRET_KEY = "minitok.secret.entitlement";
/** How long a cached session is trusted without contacting the server (24h, matching the CLI). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface EntitlementSessionPayload {
  sub?: string;
  jti?: string;
  plan?: string;
  features?: string[];
  exp?: number;
  iat?: number;
}

export interface StoredEntitlementSession {
  token: string;
  cachedAt: number;
  payload: EntitlementSessionPayload;
}

/** Decode a JWT payload without verifying it — verification is the server's job. */
export function decodeJwtPayload(token: string): EntitlementSessionPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json) as EntitlementSessionPayload;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export class EntitlementCache {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Persist the session token plus decoded payload for offline rendering. */
  async save(token: string): Promise<StoredEntitlementSession> {
    const payload = decodeJwtPayload(token);
    if (!payload) throw new Error("Could not decode the entitlement token.");
    const session: StoredEntitlementSession = { token, cachedAt: Date.now(), payload };
    await this.secrets.store(SECRET_KEY, JSON.stringify(session));
    return session;
  }

  /** Load the stored session, or null when none exists or it is unreadable. */
  async load(): Promise<StoredEntitlementSession | null> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredEntitlementSession;
      if (!parsed || typeof parsed.token !== "string" || !parsed.payload) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Remove the stored session (used by deactivate, even if revocation fails). */
  async clear(): Promise<void> {
    try {
      await this.secrets.delete(SECRET_KEY);
    } catch {
      // Deleting a missing secret is not an error for the caller.
    }
  }

  /**
   * Offline fallback: a cached session whose `exp` is still in the future is
   * treated as valid. Returns null when there is no usable cached session.
   */
  async loadValidOffline(): Promise<StoredEntitlementSession | null> {
    const session = await this.load();
    if (!session) return null;
    const exp = typeof session.payload.exp === "number" ? session.payload.exp * 1000 : 0;
    if (exp <= Date.now()) return null;
    return session;
  }

  /** True when the cached session is older than the 24h refresh window. */
  async needsRefresh(): Promise<boolean> {
    const session = await this.load();
    if (!session) return true;
    return Date.now() - session.cachedAt > SESSION_TTL_MS;
  }
}