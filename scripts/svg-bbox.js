// Compute the bounding box of an SVG path (handles m/l/c/h/v/z, rel+abs).
const fs = require("fs");
const s = fs.readFileSync(process.argv[2], "utf8");
const d = [...s.matchAll(/\bd="([^"]+)"/g)].map(m => m[1]).sort((a, b) => b.length - a.length)[0];
const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.)?\d+/g);
let x = 0, y = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, cmd = "", i = 0;
const num = () => parseFloat(tokens[i++]);
const track = (px, py) => { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); };
const trackAll = () => { track(x, y); };
while (i < tokens.length) {
  if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
  if (cmd === "m" || cmd === "l") { x += num(); y += num(); if (cmd === "m") cmd = "l"; }
  else if (cmd === "M" || cmd === "L") { x = num(); y = num(); if (cmd === "M") cmd = "L"; }
  else if (cmd === "c") { const sx = x, sy = y; const p = []; for (let k = 0; k < 6; k++) { const v = num(); if (k % 2 === 0) x += v; else y += v; p.push(k % 2 === 0 ? x : y); } for (let k = 0; k < 6; k += 2) track(p[k], p[k + 1]); track(x, y); }
  else if (cmd === "C") { for (let k = 0; k < 6; k++) { const v = num(); if (k % 2 === 0) x = v; else y = v; if (k % 2 === 1) track(x, y); } }
  else if (cmd === "h") { x += num(); }
  else if (cmd === "H") { x = num(); }
  else if (cmd === "v") { y += num(); }
  else if (cmd === "V") { y = num(); }
  else if (cmd === "z" || cmd === "Z") {}
  else { console.log("unhandled cmd", JSON.stringify(cmd), "at token", i, "of", tokens.length, "near", tokens.slice(i - 3, i + 3).join(",")); break; }
  track(x, y);
}
console.log("bbox  ", minX.toFixed(2), minY.toFixed(2), "→", maxX.toFixed(2), maxY.toFixed(2));
console.log("size  ", (maxX - minX).toFixed(2), "x", (maxY - minY).toFixed(2));
console.log("center", ((minX + maxX) / 2).toFixed(2), ((minY + maxY) / 2).toFixed(2));
