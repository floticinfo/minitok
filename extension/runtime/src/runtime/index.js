"use strict";

const { KnowledgeService } = require("./knowledge");
const { AnalysisService } = require("./analysis");
const { CompactService } = require("./compact");
const { EvidenceService } = require("./evidence");
const { WorkspaceService } = require("./workspace");
const { AuditService } = require("./audit");
const { EntitlementService } = require("./entitlement");
const { ObservationService } = require("./observations");

function createRuntimeServices(options = {}) {
  const runtimeDir = options.runtimeDir;
  const knowledgePath = options.knowledgePath || (runtimeDir && require("path").join(runtimeDir, "knowledge.json"));
  const entitlementDir = options.entitlementDir || (runtimeDir && require("path").join(runtimeDir, "entitlement"));
  const auditPath = options.auditPath || (runtimeDir && require("path").join(runtimeDir, "audit.jsonl"));

  return {
    knowledge: new KnowledgeService(knowledgePath),
    analysis: new AnalysisService(knowledgePath),
    compact: new CompactService(),
    evidence: new EvidenceService({ workspaceRoots: options.workspaceRoots || [], evidenceDirectory: options.evidenceDirectory }),
    workspace: new WorkspaceService(),
    audit: new AuditService(auditPath),
    entitlement: new EntitlementService(entitlementDir, options.serverUrl || process.env.minitok_server_url || process.env.MINITOK_SERVER_URL),
    observation: new ObservationService({ storageDir: options.observationDir || (runtimeDir && require("path").join(runtimeDir, "observations")) }),
  };
}

module.exports = { createRuntimeServices };
