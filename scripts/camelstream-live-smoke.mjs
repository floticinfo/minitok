import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { discoverCamelstreamLive, runCamelstreamLiveSmoke, LIVE_MODE } = require("../src/llm/live_provider.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseArgs(argv = process.argv.slice(2)) { const args = new Set(argv); return { mode: LIVE_MODE, confirmation: args.has("--confirm-live"), network_enabled: args.has("--allow-network"), live_endpoint_opt_in: args.has("--allow-camelstream"), discover: args.has("--discover"), output: argv.includes("--output") ? argv[argv.indexOf("--output") + 1] : path.join(root, ".minitok", "live-evidence", "camelstream-smoke.json") }; }
const options = parseArgs();
const result = options.discover ? await discoverCamelstreamLive(options) : await runCamelstreamLiveSmoke(options);
fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
fs.writeFileSync(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: result.status, provider: result.provider, model: result.model, request_count: result.request_count, live_contacted: result.live_contacted, output: path.resolve(options.output) }, null, 2));
if (result.status === "blocked" || result.status === "error") process.exitCode = 1;
