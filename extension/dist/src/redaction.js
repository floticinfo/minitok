"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactSensitiveText = redactSensitiveText;
function redactSensitiveText(value) {
    return String(value)
        .replace(/((?:api[_-]?key|token|secret|password|license|authorization|cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*)[^\s,;&]+/gi, "$1[REDACTED]")
        .replace(/([?&](?:token|api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token)=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
        .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
        .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[REDACTED]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
        .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@([^\s/]+)/gi, "$1[REDACTED]@$2");
}
