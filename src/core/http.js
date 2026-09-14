"use strict";

const { AuthError } = require("./errors");

/**
 * Shared proxy-aware HTTP helpers. Corporate customers commonly sit behind
 * HTTPS_PROXY; raw https.request and bare fetch both bypass it silently,
 * which shows up as "server unreachable"/"provider unavailable".
 */

let cachedDispatcher;

function proxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
}

/** Parse a dotted-quad IPv4 literal into a 32-bit integer, or null. */
function ipv4ToInt(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

/** Match a hostname against an IPv4 CIDR entry such as 10.0.0.0/8. */
function matchesCidr(hostname, entry) {
  const slash = entry.indexOf("/");
  if (slash < 1) return false;
  const network = ipv4ToInt(entry.slice(0, slash));
  const host = ipv4ToInt(hostname);
  const bits = Number(entry.slice(slash + 1));
  if (network === null || host === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((network & mask) >>> 0) === ((host & mask) >>> 0);
}

/**
 * NO_PROXY entries may be a hostname, a leading-dot domain suffix, an IPv4 CIDR
 * block, or a host:port pair. Corporate bypass lists routinely use CIDR for
 * internal ranges; ignoring that shape silently routed the traffic through the
 * proxy, which surfaces as an unreachable server rather than a config error.
 */
function shouldBypassProxy(urlString) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (!noProxy) return false;
  let target;
  try { target = new URL(urlString); } catch { return false; }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const port = target.port || (target.protocol === "https:" ? "443" : target.protocol === "http:" ? "80" : "");
  return noProxy.split(",").map(s => s.trim().toLowerCase()).filter(Boolean).some(entry => {
    if (entry === "*") return true;
    let host = entry;
    // A bracketed IPv6 literal may carry a port: [::1]:8080
    if (entry.startsWith("[")) {
      const close = entry.indexOf("]");
      if (close < 0) return false;
      host = entry.slice(1, close);
      const suffix = entry.slice(close + 1);
      return hostname === host && (!suffix || suffix === `:${port}`);
    }
    // Exactly one colon means host:port. More than one is a bare IPv6 literal,
    // which is only ever matched as an exact host.
    if ((entry.match(/:/g) || []).length === 1) {
      const colon = entry.indexOf(":");
      if (entry.slice(colon + 1) !== port) return false;
      host = entry.slice(0, colon);
    }
    if (matchesCidr(hostname, host)) return true;
    if (hostname === host.replace(/^\./, "")) return true;
    return hostname.endsWith(host.startsWith(".") ? host : `.${host}`);
  });
}

/** Returns an undici ProxyAgent dispatcher, or undefined when no proxy applies. */
function getProxyDispatcher(urlString) {
  const proxy = proxyUrl();
  if (!proxy || shouldBypassProxy(urlString)) return undefined;
  if (cachedDispatcher?.proxy === proxy) return cachedDispatcher.agent;
  try {
    const { ProxyAgent } = require("undici");
    cachedDispatcher = { proxy, agent: new ProxyAgent(proxy) };
    return cachedDispatcher.agent;
  } catch {
    return undefined;
  }
}

/**
 * POST JSON with the same semantics as node http.request but proxy-aware.
 * Mirrors the interface of postValidation in entitlement/online.js.
 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function timeoutError(error) {
  return error?.name === "AbortError" ? new AuthError("Authentication request timed out") : error;
}

async function fetchWithTimeout(urlString, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const finish = () => clearTimeout(timer);
  const dispatcher = getProxyDispatcher(urlString);
  let response;
  try {
    response = await fetch(urlString, { ...options, ...(dispatcher ? { dispatcher } : {}), signal: controller.signal });
  } catch (error) {
    finish();
    throw timeoutError(error);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    finish();
    return response;
  }
  const wrappedBody = new Proxy(response.body, {
    get(target, property, receiver) {
      if (property === "getReader") return (...args) => {
        const reader = target.getReader(...args);
        const read = reader.read.bind(reader);
        reader.read = async (...readArgs) => {
          try {
            const result = await read(...readArgs);
            if (result.done) finish();
            return result;
          } catch (error) {
            finish();
            throw timeoutError(error);
          }
        };
        const cancel = reader.cancel.bind(reader);
        reader.cancel = async (...cancelArgs) => { try { return await cancel(...cancelArgs); } finally { finish(); } };
        return reader;
      };
      return Reflect.get(target, property, receiver);
    },
  });
  return new Proxy(response, {
    get(target, property, receiver) {
      if (property === "body") return wrappedBody;
      if (["json", "text", "arrayBuffer", "blob", "formData"].includes(String(property))) {
        return async (...args) => { try { return await target[property](...args); } catch (error) { throw timeoutError(error); } finally { finish(); } };
      }
      return Reflect.get(target, property, target);
    },
  });
}

async function readCappedResponse(res, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("HTTP response body too large");
  if (!res.body || typeof res.body.getReader !== "function") throw new Error("HTTP response body is unavailable");
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("HTTP response body too large");
      }
      // Decode once over the concatenated bytes: a multi-byte UTF-8 character
      // split across two stream chunks would otherwise decode per chunk and
      // turn into U+FFFD replacement characters.
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    throw timeoutError(error);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function postJson(urlString, body, timeoutMs = 10000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      signal: controller.signal,
    };
    const dispatcher = getProxyDispatcher(urlString);
    if (dispatcher) opts.dispatcher = dispatcher;
    fetch(urlString, { ...opts, body: serialized })
      .then(async (res) => {
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          throw new Error("HTTP response body too large");
        }
        const reader = res.body?.getReader();
        let data;
        if (reader) {
          try {
            const chunks = [];
            let total = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error("HTTP response body too large");
              }
              // Decode once over the concatenated bytes: a multi-byte UTF-8
              // character split across two stream chunks would otherwise decode
              // per chunk and turn into U+FFFD replacement characters.
              chunks.push(Buffer.from(value));
            }
            data = Buffer.concat(chunks).toString("utf8");
          } finally {
            // Release the reader lock so the connection is returned to the pool.
            // Without this, repeated postJson calls hold the stream lock and
            // exhaust the undici connection pool, surfacing as intermittent
            // "UND_ERR_CONNECT_TIMEOUT" on the next request.
            try { reader.releaseLock(); } catch {}
          }
        } else {
          data = await res.text();
          if (Buffer.byteLength(data, "utf8") > MAX_RESPONSE_BYTES) throw new Error("HTTP response body too large");
        }
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, body: parsed });
      })
      .catch((err) => {
        if (err?.name === "AbortError") reject(new Error("Validation request timed out"));
        else reject(new Error(err?.message || "HTTP request failed"));
      })
      .finally(() => clearTimeout(timer));
  });
}

module.exports = { getProxyDispatcher, shouldBypassProxy, fetchWithTimeout, readCappedResponse, postJson, MAX_RESPONSE_BYTES };
