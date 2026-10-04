# minitok Entitlement Server — Deployment Guide

Express service that issues, validates, and revokes minitok licenses. Serves the admin page at `/` and the JSON API under `/api/`.

## Requirements

- Node.js 18+ (uses only built-ins plus `express`, `cors`, `jsonwebtoken` — see the repo root `package.json`).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port. |
| `MINITOK_JWT_SECRET` | `minitok-entitlement-dev-secret` | Secret used to sign session and admin JWTs. **Set this in production**; the fallback is for development/tests only. |
| `MINITOK_ACCEPTED_KEYS` | _(none)_ | Comma-separated license keys accepted for activation, optionally with a plan suffix: `KEY1:level1,KEY2:trial` (default plan `level1`). Replace with a billing-backend call before real sales. |
| `MINITOK_ALLOW_TEST_KEY` | _(off)_ | When `true`, also accepts the literal key `test` (plan `level1`). Development/tests only — never enable in production. |
| `MINITOK_STORE_FILE` | _(in-memory)_ | Path to a JSON file the entitlement store is persisted to (e.g. `/data/entitlements.json` on a mounted volume). Writes are debounced and atomic (tmp + rename). Without it a restart wipes all entitlements. |
| `MINITOK_RATE_LIMIT_MAX` | `20` | Max requests per window per IP on credential-bearing endpoints (`activate`, admin `session`). |
| `MINITOK_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window length in milliseconds. |

## Running

```sh
node server/index.js
# or from repo root with a custom port/secret:
PORT=8080 MINITOK_JWT_SECRET=<random-64-bytes> node server/index.js
```

Health check: `GET /health` → `{ "status": "ok", ... }`.

## API surface

### Client (`/api/entitlement`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/entitlement/activate` | — | Body `{ "key": "..." }` → `{ token, entitlement }`. Issues a 24 h JWT session. |
| `GET` | `/api/entitlement/status` | Bearer session JWT | Current state: `active`, `plan`, `expires_at`, `revoked_at`. |
| `POST` | `/api/entitlement/refresh` | Bearer session JWT | Exchange a valid (or just-expired) token for a new one. Rejected tokens: 401 `token_invalid`. |
| `DELETE` | `/api/entitlement` | Bearer session JWT | Revoke the entitlement bound to the token. |

### Admin (`/api/admin`) — used by the management page

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/admin/session` | — | Body `{ "key": "..." }` → 30-minute admin JWT (`scope: "admin"`). |
| `GET` | `/api/admin/entitlements` | Bearer admin JWT | Devices bound to the key. |
| `DELETE` | `/api/admin/entitlements/:id` | Bearer admin JWT | Release a device (revoke the key binding). 409 if already released. |

All error responses are JSON `{ "error": "...", "code?": "..." }`; no stack traces leak to clients.

## Data model

The store (`server/models/entitlement.js`) is an in-memory `Map`. Records:

```js
{
  key, installationId, planId, features, maxDevices,
  activatedAt, expiresAt, revokedAt, deviceName, lastSeenAt
}
```

Accepted activation keys are hard-coded (`ACCEPTED_KEYS`) for development. Before production:

1. Replace `validateKey` with a call to your billing/licensing backend.
2. Swap the `Map` store for a persistent adapter (Postgres, Redis, …) — the route layer only uses the exported function signatures, so no route changes are needed.
3. Without persistence, a server restart wipes all entitlements and every client must re-activate.

## Reverse proxy / TLS

Terminating TLS at a proxy (nginx, Caddy) is recommended:

```
client → https://license.example.com → http://127.0.0.1:3000
```

Point the CLI/extension at the public URL via `MINITOK_SERVER_URL` (CLI env or `minitok.serverUrl` in VS Code settings).

## Production checklist

- [ ] `MINITOK_JWT_SECRET` set to a high-entropy value (rotating it invalidates all sessions).
- [x] Persistent store: set `MINITOK_STORE_FILE` to a path on a mounted volume (or swap the model module for a real database adapter).
- [ ] Real key validation wired to billing (currently `MINITOK_ACCEPTED_KEYS`).
- [ ] HTTPS in front; the admin page exchanges keys for short-lived tokens but keys still cross the wire.
- [x] Built-in rate limiting on `/activate` and `/session` (`MINITOK_RATE_LIMIT_*`); still consider proxy-level limits when scaling out.
