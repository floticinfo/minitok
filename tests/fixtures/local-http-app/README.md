# Local HTTP application fixture

Run from the repository root:

```text
node scripts/local-http-app-server.mjs
```

The server listens on `127.0.0.1:43127` by default. Set `PORT` to use another local port. The fixture module itself does not start a server when loaded by the Node test runner.

Endpoints:

- `GET /health` — `200` and `ok`
- `GET /api` — JSON success response
- `GET /failure` — JSON `500` response
- `GET /slow` — delayed success response for timeout tests
- `GET /large` — response larger than the default verifier limit
- `GET /secret` — redaction test response
