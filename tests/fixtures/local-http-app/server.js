"use strict";

const http = require("http");

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function createServer() {
  return http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
      return;
    }
    if (request.url === "/api") {
      json(response, 200, { data: { status: "ready" }, token: "token=fixture-secret" });
      return;
    }
    if (request.url === "/failure") {
      json(response, 500, { data: { status: "failed" } });
      return;
    }
    if (request.url === "/slow") {
      setTimeout(() => json(response, 200, { data: { status: "slow" } }), 100);
      return;
    }
    if (request.url === "/large") {
      const body = "x".repeat(128 * 1024);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.url === "/secret") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("token=fixture-secret Authorization: Bearer fixture-bearer");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
}

async function startServer(port = 0, host = "127.0.0.1") {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ port, host }, () => resolve()); });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { server, host, port: address.port, baseUrl: `http://${host}:${address.port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}

module.exports = { createServer, startServer };
