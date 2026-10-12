import assert from "node:assert/strict";
import test from "node:test";

import {
    createChatMessagesPage,
    normalizeChatMessagePageSize,
} from "./chatHistoryPagination.ts";

test("zero page size normalizes to zero and returns no messages or cursor", () => {
  assert.equal(normalizeChatMessagePageSize(0), 0);
  assert.deepEqual(createChatMessagesPage([], 0), {
    messages: [],
    nextCursor: null,
    hasMore: false,
  });
});

test("one requested message returns exactly one row in display order", () => {
  const rows = [
    { id: "newer", created_at: "2026-10-12T12:02:00Z" },
    { id: "older", created_at: "2026-10-12T12:01:00Z" },
  ];

  const page = createChatMessagesPage(rows.slice(0, 1), 1);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].id, "newer");
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.nextCursor, {
    id: "newer",
    createdAt: "2026-10-12T12:02:00Z",
  });
});

test("short final page has no next cursor", () => {
  const page = createChatMessagesPage(
    [{ id: "only", created_at: "2026-10-12T12:00:00Z" }],
    2,
  );
  assert.equal(page.messages.length, 1);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});
