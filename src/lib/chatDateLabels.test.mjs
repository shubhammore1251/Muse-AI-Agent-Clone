import assert from "node:assert/strict";
import test from "node:test";

import { getChatDateKey, getChatDateLabel } from "./chatDateLabels.ts";

test("labels current and previous local calendar days", () => {
  const now = new Date(2026, 9, 12, 12, 0, 0);
  assert.equal(
    getChatDateLabel(new Date(2026, 9, 12, 8).toISOString(), now),
    "Today",
  );
  assert.equal(
    getChatDateLabel(new Date(2026, 9, 11, 8).toISOString(), now),
    "Yesterday",
  );
});

test("formats older message dates as Month DD, YYYY and groups by local day", () => {
  const now = new Date(2026, 9, 12, 12, 0, 0);
  const older = new Date(2026, 9, 3, 8).toISOString();
  assert.equal(getChatDateLabel(older, now), "October 03, 2026");
  assert.equal(
    getChatDateKey(new Date(2026, 9, 3, 8).toISOString()),
    getChatDateKey(new Date(2026, 9, 3, 23).toISOString()),
  );
});
