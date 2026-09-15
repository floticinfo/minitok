import https from "node:https";
import http from "node:http";

const base = process.env.MINITOK_LIVE_URL || "https://api.minitok.dev";
const origin = new URL(base);
if (!['https:', 'http:'].includes(origin.protocol)) throw new Error('MINITOK_LIVE_URL must use HTTP(S)');

function get(pathname) {
  return new Promise(resolve => {
    const transport = origin.protocol === 'https:' ? https : http;
    const req = transport.get(new URL(pathname, origin), { headers: { Accept: 'application/json' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: body.slice(0, 500), contentType: res.headers['content-type'] || null }));
    });
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', error => resolve({ status: 0, error: error instanceof Error ? error.message : String(error) }));
  });
}

const results = [];
for (const pathname of ['/health', '/readyz']) {
  const result = await get(pathname);
  const checkStatus = result.status === 200 ? 'PASS' : 'BLOCKED';
  // Keep the human-readable check status separate from the HTTP status. The
  // previous spread order overwrote `status: PASS` with numeric 200, making a
  // healthy server report productionReady=false.
  results.push({ endpoint: pathname, status: checkStatus, httpStatus: result.status, body: result.body, contentType: result.contentType, ...(result.error ? { error: result.error } : {}) });
}
const report = { target: origin.origin, safeReadOnly: true, results, productionReady: results.every(result => result.status === 'PASS'), limitations: ['This probe does not authenticate or exercise MCP /mcp.', 'A public /health success proves liveness only; /readyz must return 200 to prove database readiness.'] };
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.productionReady ? 0 : 1;
