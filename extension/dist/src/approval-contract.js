"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GOAL_STEP_APPROVAL_CONFIRMATION = exports.SCOPE_APPROVAL_CONFIRMATION = void 0;
exports.buildApprovalResponse = buildApprovalResponse;
exports.SCOPE_APPROVAL_CONFIRMATION = "I approve this optional scope expansion";
exports.GOAL_STEP_APPROVAL_CONFIRMATION = "I approve this required goal step";
function buildApprovalResponse(request, decision, binding, now = Date.now()) {
    if (request?.type !== "approval_request" || !/^[a-f0-9]{48}$/i.test(request.nonce || "") || !request.run_id?.trim() || !Number.isFinite(request.expires_at) || Number(request.expires_at) <= now || !Array.isArray(request.files) || !["file_changes", "scope_expansion", "goal_required_step"].includes(request.purpose || "") || !request.description?.trim())
        return null;
    if (request.purpose === "scope_expansion" && (request.scope_confirmation !== exports.SCOPE_APPROVAL_CONFIRMATION || request.goal_confirmation !== undefined))
        return null;
    if (request.purpose === "goal_required_step" && (request.goal_confirmation !== exports.GOAL_STEP_APPROVAL_CONFIRMATION || request.scope_confirmation !== undefined))
        return null;
    if (request.purpose === "file_changes" && (request.scope_confirmation !== undefined || request.goal_confirmation !== undefined))
        return null;
    if (binding.nonce !== request.nonce || binding.runId !== request.run_id)
        return null;
    if (decision === "approve" && request.purpose === "scope_expansion" && binding.scopeConfirmation !== exports.SCOPE_APPROVAL_CONFIRMATION)
        return null;
    if (decision === "approve" && request.purpose === "goal_required_step" && binding.goalConfirmation !== exports.GOAL_STEP_APPROVAL_CONFIRMATION)
        return null;
    if (request.purpose !== "scope_expansion" && binding.scopeConfirmation !== undefined || request.purpose !== "goal_required_step" && binding.goalConfirmation !== undefined)
        return null;
    return {
        decision,
        nonce: request.nonce,
        run_id: request.run_id,
        purpose: request.purpose,
        description: request.description,
        ...(decision === "approve" && request.purpose === "scope_expansion" ? { scope_confirmation: binding.scopeConfirmation } : {}),
        ...(decision === "approve" && request.purpose === "goal_required_step" ? { goal_confirmation: binding.goalConfirmation } : {}),
    };
}
