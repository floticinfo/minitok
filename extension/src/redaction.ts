export function redactSensitiveText(value: string) {
  return String(value)
    .replace(/(api[_-]?key|token|secret|password|license|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|secret|password|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED]");
}
