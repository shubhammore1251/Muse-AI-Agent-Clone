export function createExecutionId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function safeRequestSummary(value: unknown, maxLength = 120) {
  if (typeof value !== "string") return "<unavailable>";

  return sanitizeLogText(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function safeErrorMessage(error: unknown, maxLength = 180) {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeLogText(message)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function safeDomain(value: unknown) {
  if (typeof value !== "string") return "unknown";

  try {
    return new URL(value).hostname.replace(/^www\./i, "").slice(0, 100);
  } catch {
    return "unknown";
  }
}

export function summarizeArgumentKeys(value: unknown) {
  let argumentsValue = value;
  if (typeof value === "string") {
    try {
      argumentsValue = JSON.parse(value);
    } catch {
      return "unavailable";
    }
  }

  if (!argumentsValue || typeof argumentsValue !== "object") {
    return "none";
  }

  const keys = Object.keys(argumentsValue)
    .filter(
      (key) =>
        !/(token|secret|password|credential|cookie|auth|emailbody)/i.test(key),
    )
    .slice(0, 12);

  return keys.length ? keys.join(",") : "none";
}

export function logAgentEvent(
  event: string,
  executionId: string,
  details: Record<string, unknown> = {},
) {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatField(value)}`)
    .join(" | ");

  console.info(
    `[Agent] ${event} | ts=${new Date().toISOString()} | id=${formatField(executionId)}${fields ? ` | ${fields}` : ""}`,
  );
}

function formatField(value: unknown) {
  const text = sanitizeLogText(String(value));
  return /[\s|"\\]/.test(text) ? JSON.stringify(text) : text;
}

function sanitizeLogText(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b\d{13,19}\b/g, "[REDACTED_NUMBER]")
    .replace(/https?:\/\/[^\s)]+/gi, (url) => safeUrlLabel(url));
}

function safeUrlLabel(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return "[URL]";
  }
}
