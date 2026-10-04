"use strict";

/**
 * Minimal fixed-window rate limiter for credential-bearing endpoints.
 *
 * Activation and admin session endpoints validate secrets, so a burst of
 * guesses from one IP must be throttled. In-memory per-process state is fine
 * for the single-instance dev container; front multiple replicas with a
 * shared limiter (e.g. Redis) before production scale-out.
 */

const WINDOW_MS = Number(process.env.MINITOK_RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_REQUESTS = Number(process.env.MINITOK_RATE_LIMIT_MAX) || 20;

const hits = new Map(); // ip → { count, resetAt }

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  let entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    hits.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > MAX_REQUESTS) {
    res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  return next();
}

// Prevent unbounded growth on long-running processes.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) {
    if (now >= entry.resetAt) hits.delete(key);
  }
}, WINDOW_MS);
sweeper.unref();

module.exports = { rateLimit };
