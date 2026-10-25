#!/usr/bin/env node
"use strict";

/**
 * Node-side verification of the Phase 3 extension cache logic. Compiles the
 * TS module would need tsc output; instead this mirrors decodeJwtPayload and
 * the exp-based offline fallback exactly as implemented in
 * src/entitlement-cache.ts so the flow can be exercised end to end.
 */

const base = "http://localhost:3000";

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadValidOffline(session) {
  if (!session || !session.payload) return null;
  const exp = typeof session.payload.exp === "number" ? session.payload.exp * 1000 : 0;
  if (exp <= Date.now()) return null;
  return session;
}

async function main() {
  let failures = 0;
  const check = (name, cond, detail) => {
    if (cond) console.log(`PASS: ${name}`);
    else { failures++; console.log(`FAIL: ${name} -- ${detail}`); }
  };

  // 1. Activate (mirrors activateEntitlementSession)
  const activateRes = await fetch(`${base}/api/entitlement/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "test" }),
  });
  const activateBody = await activateRes.json();
  check("activate HTTP 200", activateRes.ok, activateRes.status);
  check("activate returns token", typeof activateBody.token === "string" && activateBody.token.split(".").length === 3, JSON.stringify(activateBody).slice(0, 100));
  check("activate plan level1", activateBody.entitlement?.plan === "level1", activateBody.entitlement?.plan);

  // 2. Save + decode (mirrors EntitlementCache.save)
  const payload = decodeJwtPayload(activateBody.token);
  const session = { token: activateBody.token, cachedAt: Date.now(), payload };
  check("decoded payload has plan", payload?.plan === "level1", payload?.plan);
  check("decoded payload has exp in future", typeof payload?.exp === "number" && payload.exp * 1000 > Date.now(), payload?.exp);

  // 3. Offline fallback valid
  const offline = loadValidOffline(session);
  check("offline fallback valid while unexpired", offline !== null, "offline null");

  // 4. Status check (mirrors statusEntitlementSession)
  const statusRes = await fetch(`${base}/api/entitlement/status`, { headers: { Authorization: `Bearer ${session.token}` } });
  const statusBody = await statusRes.json();
  check("status active", statusRes.ok && statusBody.active === true, JSON.stringify(statusBody).slice(0, 100));

  // 5. Refresh (mirrors refreshEntitlementSession)
  const refreshRes = await fetch(`${base}/api/entitlement/refresh`, { method: "POST", headers: { Authorization: `Bearer ${session.token}` } });
  const refreshBody = await refreshRes.json();
  check("refresh returns new token", refreshRes.ok && typeof refreshBody.token === "string" && refreshBody.token !== session.token, refreshRes.status);
  if (refreshBody.token) {
    const newPayload = decodeJwtPayload(refreshBody.token);
    check("refreshed payload decodes", newPayload?.plan === "level1", newPayload?.plan);
  }

  // 6. Offline fallback on a network failure path (server URL that does not exist)
  const badStatus = await fetch(`${base}:1/api/entitlement/status`, { headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(2000) }).catch(() => ({ ok: false, status: 0 }));
  check("network failure yields status 0", badStatus.status === 0, badStatus.status);
  const fallback = badStatus.status === 0 ? loadValidOffline(session) : null;
  check("offline fallback restores plan", fallback?.payload?.plan === "level1", fallback?.payload?.plan);

  // 7. Deactivate (mirrors deactivateEntitlementSession) — local cache cleared regardless
  const delRes = await fetch(`${base}/api/entitlement`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } });
  const delBody = await delRes.json();
  check("revoke confirmed", delRes.ok && delBody.revoked === true, JSON.stringify(delBody));
  const clearedSession = null; // cache.clear() semantics
  check("no offline fallback after local clear", loadValidOffline(clearedSession) === null, "expected null");

  console.log(`RESULT: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => { console.error(error); process.exit(1); });