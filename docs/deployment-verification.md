# Deployment Verification — OAuth ↔ Entitlement JWT Contract

This runbook verifies that the OAuth server (`minitok-server-deploy`) and the
entitlement server (`server/` in this repo) agree on the customer-token signing
contract before `GET /api/entitlement/me` and `POST /api/entitlement/bind` are
relied on in production.

## The contract

| Property | Value | Source of truth |
|---|---|---|
| Algorithm | HS256 (HMAC-SHA256) | both `services/jwt.js` |
| Issuer (`iss`) | `minitok-server` | `minitok-server-deploy/src/index.js` `JWT_ISSUER` |
| Audience (`aud`) | `minitok:customer` | `minitok-server-deploy/src/index.js` `JWT_AUD_CUSTOMER` |
| Customer identity | `sub` claim = customer UUID | `device-authorization.js` `accessToken()` |
| Signing secret | shared byte-for-byte | OAuth `JWT_SECRET` ⇄ entitlement `OAUTH_JWT_SECRET` |

## Step 1 — confirm the shared secret

The entitlement server verifies OAuth tokens with `OAUTH_JWT_SECRET`, falling
back to `MINITOK_JWT_SECRET`. This **must equal** the OAuth server's `JWT_SECRET`
byte-for-byte (same string, same encoding — no trailing newline).

```sh
# On the OAuth server host: the value behind JWT_SECRET
# On the entitlement host: set the SAME value
OAUTH_JWT_SECRET="<oauth JWT_SECRET value>"
```

If the two services share one secret, setting only `MINITOK_JWT_SECRET` on the
entitlement server is sufficient (it is the fallback).

## Step 2 — confirm issuer/audience (usually defaults)

Defaults already match production; only set these if the OAuth server overrides
`JWT_ISSUER` / `JWT_AUD_CUSTOMER` (it does not, today — they are constants).

```sh
OAUTH_JWT_ISSUER=minitok-server      # default
OAUTH_JWT_AUDIENCE=minitok:customer  # default
```

## Step 3 — run the contract check

From the entitlement server repo root:

```sh
OAUTH_JWT_SECRET="<value>" node scripts/verify-deployment-contract.js
```

Expected: `OK All deployment contract checks passed.` and exit code 0.
The script proves 15 properties, including that forgery (wrong secret, wrong
iss/aud, payload tampering, expired, installation-token shape) is rejected.

A live cross-implementation check was run during development: a token signed by
`minitok-server-deploy/src/services/jwt.js` (ESM) verifies in
`server/services/jwt.js` (CJS). Re-run it after any change to either JWT module.

## Step 4 — smoke-test the running entitlement server

```sh
# Health
curl -fsS http://<entitlement-host>:3000/health

# /me with a real customer access token issued by the OAuth server
curl -fsS -H "Authorization: Bearer <customer_access_token>" \
  http://<entitlement-host>:3000/api/entitlement/me
```

Expected `/me` responses:

| Condition | Status |
|---|---|
| Valid token, customer has a bound plan | `200` + `{ active: true, plan, ... }` |
| Valid token, no plan bound yet | `404` "No active plan found for this account." |
| Missing/expired/forged token | `401` |
| Verification unavailable (e.g. misconfig) | `503` (fail-closed, never grants) |

## Failure triage

- **All `/me` calls return 503** → the verification path cannot run; check that
  `OAUTH_JWT_SECRET`/`MINITOK_JWT_SECRET` is set on the entitlement host.
- **Valid OAuth tokens return 401** → secret mismatch (most common), or the OAuth
  server changed `JWT_ISSUER`/`JWT_AUD_CUSTOMER`. Re-run Step 3 on the
  entitlement host; a wrong secret fails "Token verifies with shared secret".
- **Container crashes at startup with `Cannot find module '../services/jwt'`** →
  the image predates the `COPY services ./services` Dockerfile fix. Rebuild.
