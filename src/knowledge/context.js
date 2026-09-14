"use strict";

function allocateContextBudget(sections, budget = 10000) {
  const entries = Object.entries(sections || {}).map(([name, value]) => ({ name, value: String(value || ""), weight: name === "task" ? 3 : name === "retrieved" ? 4 : 1 }));
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const result = {}; let remaining = Math.max(0, Number(budget) || 0);
  for (const [index, entry] of entries.entries()) { const share = index === entries.length - 1 ? remaining : Math.min(remaining, Math.floor(budget * entry.weight / totalWeight)); result[entry.name] = entry.value.slice(0, share); remaining -= share; }
  return { sections: result, total_chars: Object.values(result).reduce((sum, value) => sum + value.length, 0), budget_chars: budget };
}
function buildKnowledgeContext(task, retrieved, budget = 40000) { return allocateContextBudget({ task, retrieved }, budget); }
module.exports = { allocateContextBudget, buildKnowledgeContext };
