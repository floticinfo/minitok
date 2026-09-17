import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const files = ["README.md", "POLICY.md", "DATA_CLASSIFICATION.md"];
const errors = [];
const commercialDocs = ["README.md", "POLICY.md", "CHANGELOG.md"];
const paidPlans = ["open", "select", "private"];
const trialContract = ["free to install", "14 days", "5 real runs", "telemetry off"];
const commercialContract = "There is no free plan";
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
if (!readme.includes("bounded offline grace period of up to seven days") || !readme.includes("fails closed before the first successful validation")) errors.push("README.md: offline grace contract is missing or stale");
if (!changelog.includes("offline grace") || !changelog.includes("bounded 7-day window")) errors.push("CHANGELOG.md: current offline grace contract is missing");
if (readme.includes("30-day") || readme.includes("30 days") || readme.includes("zero offline grace")) errors.push("README.md: historical offline grace wording is active");
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  if (file !== "README.md" && !text.includes("the current `@flotic/minitok")) errors.push(`${file}: missing current package reference`);
}
const policy = fs.readFileSync(path.join(root, "POLICY.md"), "utf8");
const classification = fs.readFileSync(path.join(root, "DATA_CLASSIFICATION.md"), "utf8");
for (const file of commercialDocs) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  if (!text.toLowerCase().includes(commercialContract.toLowerCase())) errors.push(`${file}: missing no-free-plan contract`);
  for (const plan of paidPlans) {
    if (!text.toLowerCase().includes(plan)) errors.push(`${file}: missing paid plan ${plan}`);
  }
  for (const term of trialContract) {
    if (!text.toLowerCase().includes(term.toLowerCase())) errors.push(`${file}: missing trial/install contract '${term}'`);
  }
  if (/checkout --plan pro|current plan.*pro|purchasable-plan.*pro/i.test(text)) errors.push(`${file}: stale pro plan contract`);
}
const sanitizer = fs.readFileSync(path.join(root, "src/evolution/sanitize.js"), "utf8");
for (const field of ["status", "cycles", "duration_ms", "files_changed", "total_tokens", "failure_category"]) {
  if (!sanitizer.includes(`${field}:`)) errors.push(`sanitizer: missing ${field}`);
  if (!policy.includes(`\`${field}\``)) errors.push(`POLICY.md: missing ${field}`);
  if (!classification.includes(`\`${field}\``)) errors.push(`DATA_CLASSIFICATION.md: missing ${field}`);
}
for (const value of ["lint", "test", "validation", "type_error", "timeout", "api_error", "unknown"]) {
  if (!sanitizer.includes(`"${value}"`)) errors.push(`sanitizer: missing failure category ${value}`);
  if (!classification.includes(`\`${value}\``)) errors.push(`DATA_CLASSIFICATION.md: missing failure category ${value}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`documentation consistency passed for ${pkg.name}@${pkg.version}`);
