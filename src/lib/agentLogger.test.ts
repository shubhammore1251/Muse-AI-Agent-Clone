import assert from "node:assert/strict";
import test from "node:test";

import {
    safeDomain,
    safeErrorMessage,
    safeRequestSummary,
    summarizeArgumentKeys,
} from "./agentLogger";

test("agent log summaries redact personal and credential data", () => {
  assert.equal(
    safeRequestSummary("Check user@example.com; Bearer abcdefghijklmnop"),
    "Check [REDACTED_EMAIL]; Bearer [REDACTED]",
  );
  assert.equal(
    safeErrorMessage(
      new Error("https://example.com/path?token=secret sk-abcdefgh12345678"),
    ),
    "https://example.com/path [REDACTED]",
  );
  assert.equal(
    safeDomain("https://www.example.com/private?q=secret"),
    "example.com",
  );
  assert.equal(
    summarizeArgumentKeys('{"query":"private","access_token":"secret"}'),
    "query",
  );
});
