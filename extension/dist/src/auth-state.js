"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAuthenticationState = parseAuthenticationState;
exports.authRecoveryMessage = authRecoveryMessage;
function parseAuthenticationState(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const input = value;
    if (input.schema_version !== 1 || !input.account || !input.installation || !input.entitlement || !input.mcp || !input.providers)
        return undefined;
    if (typeof input.installation.installation_id !== "string" && input.installation.installation_id !== null)
        return undefined;
    if (typeof input.entitlement.allowed !== "boolean")
        return undefined;
    return input;
}
function authRecoveryMessage(state) {
    const code = state?.installation?.access;
    if (code === "ACTIVATION_REQUIRED")
        return "Activate this installation with `minitok activate <key>` before continuing.";
    if (code === "ACCOUNT_AUTH_REQUIRED" || code === "REAUTH_REQUIRED")
        return "Sign in to the minitok account to re-authenticate the existing installation.";
    if (code === "MISMATCHED")
        return "The MCP runtime token belongs to a different installation.";
    if (code === "MISSING_OR_EXPIRED")
        return "The MCP runtime token is missing or expired.";
    return undefined;
}
