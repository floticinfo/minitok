"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");
/** YAML schema that omits undefined values so they don't round-trip as explicit nulls. */
const CLEAN_SCHEMA = yaml.JSON_SCHEMA;
async function editSettings(repo, rl) { const file = path.join(repo, "minitok.yml"); const config = fs.existsSync(file) ? yaml.load(fs.readFileSync(file, "utf8")) || {} : {}; for (const role of ["plan", "work", "review", "intel"]) { const provider = await new Promise(resolve => rl.question(`${role} provider [${config.roles?.[role]?.provider || "unchanged"}]: `, value => resolve(value.trim()))); if (provider) { const model = await new Promise(resolve => rl.question(`${role} model [${config.roles?.[role]?.model || "default"}]: `, value => resolve(value.trim()))); config.roles = config.roles || {}; config.roles[role] = { ...(config.roles[role] || {}), provider, ...(model ? { model } : {}) }; } } const temporary = `${file}.minitok-tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`; fs.writeFileSync(temporary, yaml.dump(config, { schema: CLEAN_SCHEMA }), { mode: 0o600 }); fs.renameSync(temporary, file); console.log("Settings updated."); }
module.exports = { editSettings };
