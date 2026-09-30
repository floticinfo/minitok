import fs from "node:fs";
import process from "node:process";

const source = fs.readFileSync(new URL("./src/calculator.js", import.meta.url), "utf8");
if (/return a \+ b/.test(source)) process.exit(0);
console.error("calculator add implementation is not fixed");
process.exit(1);
