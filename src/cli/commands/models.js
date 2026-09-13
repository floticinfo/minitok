"use strict";

const { loadConfig } = require("../../config/loader");
const { detectAvailableProviders } = require("../../llm/provider");
const { listModels, discoverModels, formatModel } = require("../../llm/models");

function register(program) {
  program
    .command("models [provider]")
    .description("List available LLM models (anthropic, openai, google, or a custom provider)")
    .option("--discover", "Fetch live model list from provider APIs (requires API keys)").option("--json", "output JSON")
    .action(async (provider, opts) => {
      try {
        const config = loadConfig();
        const available = await detectAvailableProviders(config);

        if (opts.discover) {
          if (opts.json) { const discovered = await discoverModels(config.providers || {}); console.log(JSON.stringify({ available, ...discovered })); return; }
          console.log("🔍 Discovering models from provider APIs...\n");
          const result = await discoverModels(config.providers || {});

          for (const [prov, liveIds] of Object.entries(result.live)) {
            const provAvail = available.includes(prov);
            const icon = provAvail ? "✅" : "❌";
            console.log(`${icon} ${prov.toUpperCase()} (${liveIds.length} models)`);
            const catalogModels = listModels(prov);
            for (const id of liveIds) {
              const cat = catalogModels.find(m => m.id === id);
              if (cat) { console.log(formatModel(cat)); }
              else { console.log(`  ${id.padEnd(32)} (not in catalog)`); }
            }
            console.log();
          }

          // Custom providers (the three supported providers publish only model IDs)
          for (const custom of result.custom) {
            console.log(`🔧 ${custom.provider.toUpperCase()} (${custom.models.length} models — custom)`);
            if (custom.base_url) console.log(`   endpoint: ${custom.base_url}`);
            for (const m of custom.models) {
              const ctx = m.context_window ? `${(m.context_window/1000).toFixed(0)}K` : "?";
              const out = m.max_output ? `${(m.max_output/1000).toFixed(0)}K` : "?";
              const reasoning = m.reasoning?.supported ? " 🧠" : "";
              console.log(`  ${m.id.padEnd(32)} ${(m.display||m.id).substring(0,24).padEnd(24)} [${ctx} in, ${out} out]${reasoning}`);
            }
            console.log();
          }

          if (result.unknown.length > 0) {
            console.log(`⚠️  ${result.unknown.length} model(s) found in API but not in catalog:`);
            result.unknown.forEach(id => console.log(`  - ${id}`));
            console.log("   These will work but lack metadata (context window, reasoning info).\n");
          }
        } else {
          if (opts.json) { console.log(JSON.stringify({ available, models: listModels(provider) })); return; }
          // Offline catalog display
          const models = listModels(provider);
          const grouped = {};
          for (const m of models) {
            grouped[m.provider] = grouped[m.provider] || [];
            grouped[m.provider].push(m);
          }

          for (const [prov, modelList] of Object.entries(grouped)) {
            const provAvail = available.includes(prov);
            const icon = provAvail ? "✅" : "❌";
            console.log(`${icon} ${prov.toUpperCase()} (${modelList.length} models)`);
            modelList.forEach(m => console.log(formatModel(m)));
            console.log();
          }

          console.log("💡 Use --discover to fetch live model list from provider APIs");
          console.log("💡 Provider status: ✅ = API key configured, ❌ = not configured");
        }
      } catch (e) {
        console.error(`❌ Error: ${e.message}`);
        process.exitCode = 1;
      }
    });
}

module.exports = { register };
