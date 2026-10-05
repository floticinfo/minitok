#!/usr/bin/env node
// Dense-sampling true inked bounds of the (single-path) activity-bar glyph.
// Endpoint/anchor sampling (svg-bbox.js) can miss curve extremes.
const fs = require("node:fs");

const file = process.argv[2];
if (!file) { console.error("usage: node svg-ink-bbox.js <svg-file>"); process.exit(1); }
const svg = fs.readFileSync(file, "utf8");
const d = (svg.match(/d="([^"]+)"/) || [])[1];
if (!d) { console.error("no path d found"); process.exit(1); }

const tok = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
let x = 0, y = 0, start = null;
const pts = [];
const cubic = (x0, y0, x1, y1, x2, y2, x3, y3) => {
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const u = 1 - t;
    pts.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
};
let cmd = null, nums = [];
const flush = () => {
  const n = nums.map(Number);
  switch (cmd) {
    case "m": case "M": case "l": case "L": {
      const rel = cmd === "m" || cmd === "l";
      let first = true;
      for (let i = 0; i + 1 < n.length; i += 2) {
        if ((rel && !first) || (rel && first)) { x += n[i]; y += n[i + 1]; }
        else { x = n[i]; y = n[i + 1]; }
        if (rel && first && cmd === "m" && start === null) { start = [x, y]; }
        pts.push([x, y]);
        first = false;
      }
      break;
    }
    case "c": {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const x0 = x, y0 = y;
        cubic(x0, y0, x + n[i], y + n[i + 1], x + n[i + 2], y + n[i + 3], x + n[i + 4], y + n[i + 5]);
        x += n[i + 4]; y += n[i + 5];
      }
      break;
    }
    case "C": {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const x0 = x, y0 = y;
        cubic(x0, y0, n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4], n[i + 5]);
        x = n[i + 4]; y = n[i + 5];
      }
      break;
    }
    case "z": case "Z": { if (start) { x = start[0]; y = start[1]; pts.push([x, y]); } break; }
  }
  nums = [];
};
for (const t of tok) {
  if (/[A-Za-z]/.test(t)) { flush(); cmd = t; } else { nums.push(t); }
}
flush();

const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
const minX = Math.min(...xs), maxX = Math.max(...xs);
const minY = Math.min(...ys), maxY = Math.max(...ys);
console.log("ink   x:", minX.toFixed(3), "→", maxX.toFixed(3));
console.log("ink   y:", minY.toFixed(3), "→", maxY.toFixed(3));
console.log("size  :", (maxX - minX).toFixed(3), "x", (maxY - minY).toFixed(3));
console.log("center:", ((minX + maxX) / 2).toFixed(3), ((minY + maxY) / 2).toFixed(3));