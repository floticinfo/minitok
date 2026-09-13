#!/usr/bin/env node
"use strict";
const { Command } = require("commander");
const pkg = require("../package.json");
const cliArgs = process.argv.slice(2);
const bareInvocation = cliArgs.length === 0;
const helpOrVersionInvocation = cliArgs.some(arg => ["--help", "-h", "--version", "-V"].includes(arg));
if (!helpOrVersionInvocation && (!bareInvocation || process.stdin.isTTY && process.stdout.isTTY) && process.env.MINITOK_UPDATE_CHECK !== "0") require("../src/core/update-check").checkForUpdate();
if (process.env.MINITOK_NO_COLOR === "1" || !process.stdout.isTTY) { process.env.FORCE_COLOR = "0"; }
const program = new Command();
program.name("minitok").description("Repository-aware autonomous coding workflow driver").version(`minitok ${pkg.version}`);
program.action(async () => {
  // commander hands an unrecognized command to this default action instead of
  // reporting it, so reject unknown operands first. Without this a typo such as
  // `minitok statsu` silently opened the fullscreen interface on a TTY, and
  // printed the bare-invocation hint on a pipe.
  const unknownCommand = cliArgs.find(arg => !arg.startsWith("-"));
  if (unknownCommand) {
    console.error(`error: unknown command '${unknownCommand}'`);
    console.error("Run 'minitok --help' to list the available commands.");
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Bare non-TTY usage does not start the GUI or change files. Use 'minitok gui' in an interactive terminal, or 'minitok gui --task \"your task\"' for an explicit non-interactive run.");
    process.exitCode = 2;
    return;
  }
  const { startGui } = require("../src/cli/commands/gui");
  await startGui();
});
program.command("status").description("Show entitlement, providers, roles, and recent runs").option("-w, --workspace <name>").option("--repo <path>", "inspect a repository without registering a workspace").option("--json", "output JSON").action(async (opts) => { const { cmdStatus } = require("../src/cli/commands/status"); const result = await cmdStatus(opts); if (opts.json) { console.log(JSON.stringify(result)); process.exitCode = 0; return; } process.exitCode = typeof result === "number" ? result : 0; });
program.command("doctor").description("Diagnose the local environment and entitlement").option("--verify", "live-check provider credentials against the API", false).action(async (opts) => { const { cmdDoctor } = require("../src/cli/commands/doctor"); process.exit(await cmdDoctor(opts)); });
program.command("run").description("Run the autonomous coding workflow").argument("[task]").option("-w, --workspace <name>").option("-t, --task-flag <task>").option("--dry-run", "dry run", false).option("--auto-accept", "auto accept", false).option("--approval-file <path>").option("--approval-timeout-ms <ms>").option("--repo <path>").option("--provider-override <provider>").option("--coding-adapter <adapter>").option("--research-adapter <adapter>").option("--review-adapter <adapter>").action(async (task, opts) => {
  const { cmdRun } = require("../src/cli/commands/run");
  // Cancel cooperatively on the first Ctrl-C: the pipeline observes this signal
  // while polling for an approval response and while providers are in flight, so
  // a run no longer holds the terminal (or the MCP run slot) until its timeout.
  // A second Ctrl-C still exits immediately for the impatient case.
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    console.error("\nCancelling the run — press Ctrl-C again to exit immediately.");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let exitCode;
  try {
    exitCode = await cmdRun(task || opts.taskFlag || null, /** @type {object} */ ({ ...opts, signal: controller.signal }));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  process.exit(exitCode);
});
const ws=program.command("workspace").description("Manage named repository workspaces"); ws.command("add").argument("[path]", ".").argument("[name]").action(async(p,n)=>{const {cmdWsAdd}=require("../src/cli/commands/workspace");process.exit(await cmdWsAdd(p,n));}); ws.command("list").action(async()=>{const {cmdWsList}=require("../src/cli/commands/workspace");process.exit(await cmdWsList());}); ws.command("use").argument("<name>").action(async n=>{const {cmdWsUse}=require("../src/cli/commands/workspace");process.exit(await cmdWsUse(n));}); ws.command("current").action(async()=>{const {cmdWsCurrent}=require("../src/cli/commands/workspace");process.exit(await cmdWsCurrent());}); ws.command("remove").argument("<name>").action(async n=>{const {cmdWsRemove}=require("../src/cli/commands/workspace");process.exit(await cmdWsRemove(n));});
program.command("migrate").description("Create or update minitok project configuration").argument("[path]", ".").option("-n, --name <name>").action(async(p,o)=>{const {cmdMigrate}=require("../src/cli/commands/migrate");process.exit(await cmdMigrate(p,o.name));});
require("../src/cli/commands/models").register(program); require("../src/cli/commands/auth").register(program); require("../src/cli/commands/account").registerAccount(program); require("../src/cli/commands/billing").register(program); require("../src/cli/commands/license").register(program); require("../src/cli/commands/evolution").register(program); require("../src/cli/commands/runs").register(program); require("../src/cli/commands/mcp").register(program); require("../src/cli/commands/gui").register(program);
const promotion = program.command("promote").description("Generate agent discovery, demo, propagation, and trust previews"); promotion.command("discovery").description("Generate the machine-readable agent discovery manifest").option("-o, --output <path>").action(async opts => { const { buildDiscoveryManifest, writeJson } = require("../src/promotion/manifest"); const target = writeJson(opts.output || "minitok-discovery.json", buildDiscoveryManifest()); console.log(`Discovery manifest written: ${target}`); }); promotion.command("trust").description("Generate the local evidence and claims boundary manifest").option("-o, --output <path>").action(async opts => { const { buildTrustManifest, writeJson } = require("../src/promotion/manifest"); const target = writeJson(opts.output || "minitok-trust.json", buildTrustManifest()); console.log(`Trust manifest written: ${target}`); }); promotion.command("bundle").description("Generate a side-effect-free promotion bundle").option("-o, --output <path>").action(async opts => { const { buildPromotionBundle, writeJson } = require("../src/promotion/manifest"); const target = writeJson(opts.output || "minitok-promotion-bundle.json", buildPromotionBundle()); console.log(`Promotion bundle written: ${target}`); }); promotion.command("demo").description("Create a disposable no-credential onboarding fixture").option("-d, --directory <path>").option("-o, --output <path>").action(async opts => { const { createDemo } = require("../src/promotion/demo"); const { writeJson } = require("../src/promotion/manifest"); const plan = createDemo(opts.directory); const target = writeJson(opts.output || require("path").join(plan.repository, "minitok-demo-plan.json"), plan); console.log(`Demo fixture created: ${plan.repository}`); console.log(`Demo plan written: ${target}`); });
let activationExitCode = 0;
program.command("activate").description("Activate an entitlement on this installation").argument("[key]").option("--key-env <name>", "Read activation key from an environment variable").option("--server <url>").action(async(k,o)=>{const {cmdActivate}=require("../src/cli/commands/activate");activationExitCode=await cmdActivate(k,o);});
program.command("activation-key").description("Legacy command: retrieve a purchased activation key").option("--token <jwt>","Customer JWT (required)").option("--payment <id>","Optional dodo_payment_id").option("--server <url>","minitok server URL").action(async(o)=>{const {cmdActivationKey}=require("../src/cli/commands/activation-key");process.exit(await cmdActivationKey(o));});
program.command("checkout").description("Legacy command: open the billing checkout flow").option("--token <jwt>","Customer JWT (required)").option("--plan <planId>","Plan to purchase (open)","open").option("--server <url>","minitok server URL").action(async(o)=>{const {cmdCheckout}=require("../src/cli/commands/checkout");process.exit(await cmdCheckout(o));});
program.command("portal").description("Legacy command: open the billing portal").option("--token <jwt>","Customer JWT (required)").option("--server <url>","minitok server URL").action(async(o)=>{const {cmdPortal}=require("../src/cli/commands/portal");process.exit(await cmdPortal(o));});
const runtime=program.command("runtime").description("Manage the local runtime service"); runtime.command("start").option("--port <port>","4578").option("--scopes <scopes>","local MCP scopes (read,write,auto_accept,verify_exec)").option("--idle-timeout <minutes>","stop after this many idle minutes; 0 disables the idle shutdown","30").option("--detach","run the runtime in the background").action(async o=>{const {cmdRuntimeStart}=require("../src/cli/commands/runtime");const idle=Number(o.idleTimeout);process.exit(await cmdRuntimeStart({...o,port:parseInt(o.port,10)||4578,idleTimeoutMs:Number.isFinite(idle)&&idle>=0?Math.round(idle)*60000:undefined,detach:o.detach===true}));}); runtime.command("stop").action(async()=>{const {cmdRuntimeStop}=require("../src/cli/commands/runtime");process.exit(await cmdRuntimeStop());}); runtime.command("status").action(async()=>{const {cmdRuntimeStatus}=require("../src/cli/commands/runtime");process.exit(await cmdRuntimeStatus());});
program.parseAsync(process.argv).then(()=>{if(activationExitCode)process.exitCode=activationExitCode;}).catch(e=>{console.error(`Error: ${e.message}`);process.exitCode=1;});
