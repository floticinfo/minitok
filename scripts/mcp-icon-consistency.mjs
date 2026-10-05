import https from "node:https";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Live consistency probe: proves that each HTTPS icon declared in server.json is
 * reachable AND byte-identical to the matching asset shipped inside the npm
 * package under assets/. This closes the gap where a remote icon URL could drift
 * from the packaged brand mark without any gate noticing. Network-only — the
 * offline structural checks stay in scripts/mcp-registry-check.mjs.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = JSON.parse(readFileSync(path.join(root, "server.json"), "utf8"));
const icons = Array.isArray(server.icons) ? server.icons : [];

const sha256 = buffer => createHash("sha256").update(buffer).digest("hex");

function fetchBuffer(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { Accept: "image/*" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(fetchBuffer(new URL(res.headers.location, url)));
        return;
      }
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), contentType: res.headers["content-type"] || null }));
    });
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.on("error", error => resolve({ status: 0, error: error instanceof Error ? error.message : String(error) }));
  });
}

const results = [];
for (const icon of icons) {
  const src = typeof icon.src === "string" ? icon.src : "";
  const match = src.match(/^https:\/\/minitok\.dev\/assets\/(.+)$/);
  if (!match) {
    results.push({ src, status: "SKIP", reason: "not a minitok.dev/assets URL; nothing local to compare against" });
    continue;
  }
  const localPath = path.join(root, "assets", match[1]);
  let local;
  try {
    local = readFileSync(localPath);
  } catch {
    results.push({ src, status: "BLOCKED", reason: `no packaged asset at assets/${match[1]}` });
    continue;
  }
  const remote = await fetchBuffer(src);
  if (remote.error || remote.status !== 200) {
    results.push({ src, status: "BLOCKED", httpStatus: remote.status, ...(remote.error ? { error: remote.error } : {}) });
    continue;
  }
  const contentType = remote.contentType || "";
  if (!contentType.startsWith("image/")) {
    results.push({ src, asset: `assets/${match[1]}`, status: "BLOCKED", httpStatus: remote.status, contentType, reason: "URL did not serve an image (likely an SPA fallback page)" });
    continue;
  }
  const localHash = sha256(local);
  const remoteHash = sha256(remote.body);
  results.push({
    src,
    asset: `assets/${match[1]}`,
    status: localHash === remoteHash ? "PASS" : "BLOCKED",
    httpStatus: remote.status,
    contentType: remote.contentType,
    match: localHash === remoteHash,
    ...(localHash === remoteHash ? {} : { localHash, remoteHash }),
  });
}

const consistent = results.length > 0 && results.every(result => result.status === "PASS" || result.status === "SKIP");
console.log(JSON.stringify({ target: "minitok.dev/assets", safeReadOnly: true, results, consistent }, null, 2));
process.exitCode = consistent ? 0 : 1;
