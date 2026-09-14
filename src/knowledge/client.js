"use strict";

const { getJson, postJson } = require("../core/http");
const { loadCustomerToken } = require("../auth/customer-token");
const { KnowledgeConsent } = require("../evolution/consent");

function assertHttps(url) { const parsed = new URL(url); if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) throw new Error("Knowledge server URL must use HTTPS"); return parsed; }
function knowledgeUrl(serverUrl, suffix) { const parsed = assertHttps(serverUrl); return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${suffix}`; }
async function knowledgeRequest(serverUrl, suffix, method, body, options = {}) {
  const token = options.token || loadCustomerToken(); if (!token) throw new Error("Customer authentication is required");
  const url = knowledgeUrl(serverUrl, suffix); const headers = { Authorization: `Bearer ${token}`, ...(options.consent ? { "X-Minitok-Knowledge-Consent": "true" } : {}), ...(options.trainingConsent ? { "X-Minitok-Training-Consent": "true" } : {}) }; const result = method === "GET" ? await getJson(url, options.timeoutMs || 30000, headers) : await postJson(url, body, options.timeoutMs || 30000, { ...headers, ...(method === "DELETE" ? { "X-HTTP-Method-Override": "DELETE" } : {}) });
  if (!result.ok) throw new Error(`Knowledge request failed (${result.status})`); return result.body;
}
async function getIndexCapabilities(serverUrl, options = {}) { return knowledgeRequest(serverUrl, "/v1/knowledge/index-capabilities", "GET", undefined, options); }
async function createKnowledgeRepository(serverUrl, repository, options = {}) {
  const consent = options.consent || new KnowledgeConsent(); if (!consent.isEnabled("project_knowledge")) throw new Error("Project knowledge consent is not enabled");
  return knowledgeRequest(serverUrl, "/v1/knowledge/repositories", "POST", { repository }, { ...options, consent: true });
}
async function uploadKnowledge(serverUrl, repository, documents, options = {}) {
  const consent = options.consent || new KnowledgeConsent(); if (!consent.isEnabled("project_knowledge")) throw new Error("Project knowledge consent is not enabled");
  return knowledgeRequest(serverUrl, "/v1/knowledge/documents", "POST", { repository, documents }, { ...options, consent: true });
}
async function queryKnowledge(serverUrl, repositoryId, query, options = {}) { const consent = options.consent || new KnowledgeConsent(); if (!consent.isEnabled("retrieval")) throw new Error("Knowledge retrieval consent is not enabled"); return knowledgeRequest(serverUrl, `/v1/knowledge/repositories/${encodeURIComponent(repositoryId)}/query`, "POST", { query, limit: options.limit || 5 }, { ...options, consent: true }); }
async function deleteKnowledge(serverUrl, repositoryId, options = {}) { const consent = options.consent || new KnowledgeConsent(); if (!consent.isEnabled("project_knowledge")) throw new Error("Project knowledge consent is not enabled"); return knowledgeRequest(serverUrl, `/v1/knowledge/repositories/${encodeURIComponent(repositoryId)}/delete`, "POST", { confirmation: true }, { ...options, consent: true }); }
async function createTrainingJob(serverUrl, repositoryId, purpose, options = {}) { const consent = options.consent || new KnowledgeConsent(); if (!consent.isEnabled("tenant_training")) throw new Error("Tenant training consent is not enabled"); if (purpose !== "tenant_training") throw new Error("Only tenant_training is supported"); return knowledgeRequest(serverUrl, "/v1/knowledge/training-jobs", "POST", { repository_id: repositoryId, purpose }, { ...options, trainingConsent: true }); }
async function withdrawKnowledgeConsent(serverUrl, purpose, options = {}) { const consent = options.consent || new KnowledgeConsent(); if (!["project_knowledge", "retrieval", "tenant_training"].includes(purpose)) throw new Error("Unsupported withdrawal purpose"); consent.disable(purpose); return knowledgeRequest(serverUrl, "/v1/knowledge/consent/withdraw", "POST", { purpose, confirmation: true }, options); }
module.exports = { getIndexCapabilities, createKnowledgeRepository, uploadKnowledge, queryKnowledge, deleteKnowledge, createTrainingJob, withdrawKnowledgeConsent, knowledgeRequest, knowledgeUrl };
