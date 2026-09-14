"use strict";

const fs = require("fs");
const path = require("path");
const { KnowledgeConsent } = require("../../evolution/consent");
const { LocalKnowledgeIndex } = require("../../knowledge/local-index");
const { buildKnowledgeContext } = require("../../knowledge/context");
const { collectKnowledgeFiles } = require("../../knowledge/export");
const { getIndexCapabilities, createKnowledgeRepository, uploadKnowledge, queryKnowledge, deleteKnowledge, createTrainingJob, withdrawKnowledgeConsent } = require("../../knowledge/client");

function register(program) {
  const command = program.command("knowledge").description("Manage local and tenant-scoped project knowledge");
  command.command("status").action(() => { console.log(JSON.stringify(new KnowledgeConsent().status(), null, 2)); });
  command.command("index-capabilities").requiredOption("--server <url>").action(async commandObj => { const options = commandObj.opts(); console.log(JSON.stringify(await getIndexCapabilities(options.server), null, 2)); });
  command.command("enable").argument("<scope>").action(scope => { new KnowledgeConsent().enable(scope); console.log(`Knowledge consent enabled: ${scope}`); });
  command.command("disable").argument("<scope>").action(scope => { new KnowledgeConsent().disable(scope); console.log(`Knowledge consent disabled: ${scope}`); });
  command.command("preview").argument("[directory]", ".").option("--files <files>").action((directory, options) => { const files = options.files ? options.files.split(",") : listFiles(directory); const items = collectKnowledgeFiles(directory, files); console.log(JSON.stringify({ directory: path.resolve(directory), allowed: items.filter(item => item.allowed).map(item => item.file), rejected: items.filter(item => !item.allowed) }, null, 2)); });
  command.command("local-query").argument("<query>").argument("[directory]", ".").option("--files <files>").option("--budget <chars>", "40000").action((query, directory, options) => { const files = options.files ? options.files.split(",") : listFiles(directory); const index = new LocalKnowledgeIndex(directory); index.build(files); const result = index.query(query, { limit: 5 }); console.log(JSON.stringify({ results: result, context: buildKnowledgeContext(query, result.map(item => `## ${item.file}\\n${item.text}`).join("\\n\\n"), Number(options.budget)).sections.retrieved }, null, 2)); });
  command.command("upload").requiredOption("--server <url>").requiredOption("--repository <id>").argument("[directory]", ".").option("--files <files>").action(async (directory, commandObj) => { const options = commandObj.opts(); const files = options.files ? options.files.split(",") : listFiles(directory); const documents = collectKnowledgeFiles(directory, files).filter(item => item.allowed); const repository = await createKnowledgeRepository(options.server, { id: options.repository }, { consent: new (require("../../evolution/consent").KnowledgeConsent)() }); const result = await uploadKnowledge(options.server, { id: repository.repository?.repositoryId || options.repository }, documents); console.log(JSON.stringify(result, null, 2)); });
  command.command("query").requiredOption("--server <url>").requiredOption("--repository <id>").argument("<query>").action(async (query, options) => console.log(JSON.stringify(await queryKnowledge(options.server, options.repository, query), null, 2)));
  command.command("delete").requiredOption("--server <url>").requiredOption("--repository <id>").action(async commandObj => { const options = commandObj.opts(); console.log(JSON.stringify(await deleteKnowledge(options.server, options.repository), null, 2)); });
  command.command("train").requiredOption("--server <url>").requiredOption("--repository <id>").option("--purpose <purpose>", "tenant_training").action(async commandObj => { const options = commandObj.opts(); console.log(JSON.stringify(await createTrainingJob(options.server, options.repository, options.purpose), null, 2)); });
  command.command("withdraw").requiredOption("--server <url>").requiredOption("--purpose <purpose>").action(async commandObj => { const options = commandObj.opts(); console.log(JSON.stringify(await withdrawKnowledgeConsent(options.server, options.purpose), null, 2)); });
}
function listFiles(directory) { const result = []; function walk(current) { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const full = path.join(current, entry.name); if (entry.isDirectory()) { if (![".git", "node_modules", ".minitok"].includes(entry.name)) walk(full); } else result.push(path.relative(directory, full)); } } walk(directory); return result; }
module.exports = { register, listFiles };
