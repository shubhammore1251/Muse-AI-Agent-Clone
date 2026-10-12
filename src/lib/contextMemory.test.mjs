import assert from "node:assert/strict";
import test from "node:test";

import {
    buildPromptContext,
    canUsePersistentContext,
    chooseMemoryMutation,
    getTechnicalIdentifiers,
    isCompatibleEmbedding,
    scopeMemories,
    selectRecentMessages,
} from "./contextMemory.ts";

const current = {
  id: "m-current",
  role: "user",
  content: "Fix chat+api.ts error TS1234",
  created_at: "2026-10-12T12:10:00.000Z",
};

test("keeps recent messages chronological and includes the current turn once", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? "assistant" : "user",
    content: `message ${index}`,
    created_at: new Date(Date.UTC(2026, 9, 12, 12, index)).toISOString(),
  }));
  const latestCurrent = {
    ...current,
    created_at: "2026-10-12T12:12:00.000Z",
  };
  const selected = selectRecentMessages(
    [...rows, latestCurrent],
    latestCurrent,
  );

  assert.equal(selected.length, 10);
  assert.equal(selected.at(-1).id, latestCurrent.id);
  assert.equal(selected.filter(({ id }) => id === latestCurrent.id).length, 1);
  assert.deepEqual(
    selected.map(({ id }) => id),
    [...selected]
      .map(({ id }) => id)
      .sort((a, b) => {
        const aTime = a === latestCurrent.id ? 12 : Number(a.slice(2));
        const bTime = b === latestCurrent.id ? 12 : Number(b.slice(2));
        return aTime - bTime;
      }),
  );
});

test("requires authenticated identity and an active thread for persistence", () => {
  assert.equal(
    canUsePersistentContext({
      userId: "u1",
      accessToken: "token",
      threadId: "t1",
    }),
    true,
  );
  assert.equal(
    canUsePersistentContext({
      userId: "u1",
      accessToken: null,
      threadId: "t1",
    }),
    false,
  );
});

test("isolates memories to the authenticated user and active thread", () => {
  const memories = [
    {
      id: "a",
      user_id: "u1",
      thread_id: null,
      content: "Global fact",
      category: "fact",
    },
    {
      id: "a2",
      user_id: "u1",
      thread_id: null,
      content: " global fact ",
      category: "fact",
    },
    {
      id: "b",
      user_id: "u1",
      thread_id: "t1",
      content: "Thread fact",
      category: "fact",
    },
    {
      id: "c",
      user_id: "u1",
      thread_id: "t2",
      content: "Other thread",
      category: "fact",
    },
    {
      id: "d",
      user_id: "u2",
      thread_id: "t1",
      content: "Other user",
      category: "fact",
    },
  ];

  assert.deepEqual(
    scopeMemories(memories, "u1", "t1").map(({ id }) => id),
    ["a", "b"],
  );
});

test("matches technical identifiers and avoids near-duplicate memory inserts", () => {
  assert.deepEqual(
    getTechnicalIdentifiers("Fix chat+api.ts for OPENAI_API_KEY"),
    ["chat+api.ts", "openai_api_key"],
  );
  assert.equal(
    chooseMemoryMutation(
      [{ category: "decision", similarity: 0.93 }],
      "decision",
    ),
    "update",
  );
  assert.equal(
    chooseMemoryMutation([{ category: "fact", similarity: 0.93 }], "decision"),
    "insert",
  );
});

test("rejects absent or incompatible embedding vectors", () => {
  assert.equal(isCompatibleEmbedding(null), false);
  assert.equal(isCompatibleEmbedding([0, 1], 2), true);
  assert.equal(isCompatibleEmbedding([0, Number.NaN], 2), false);
});

test("falls back cleanly with no memories and respects the prompt budget", () => {
  const result = buildPromptContext({
    recentMessages: [
      { id: "old", role: "assistant", content: "old content ".repeat(200) },
      { id: "prior", role: "user", content: "short prior" },
      current,
    ],
    currentMessage: current,
    memories: [],
    tokenBudget: 40,
  });

  assert.ok(result.estimatedTokens <= 40);
  assert.equal(result.messages.at(-1).sender, "user");
  assert.match(result.messages.at(-1).text, /Fix chat\+api\.ts/);
  assert.equal(
    result.messages.filter(({ sender }) => sender === "agent").length,
    0,
  );
});

test("adds a summary, relevant memory, and source verification without duplicating turns", () => {
  const result = buildPromptContext({
    recentMessages: [
      { id: "prior", role: "assistant", content: "We chose Supabase." },
      current,
    ],
    currentMessage: current,
    summary: "Muse uses Supabase for chat persistence.",
    memories: [
      {
        id: "memory-1",
        user_id: "u1",
        thread_id: "t1",
        source_thread_id: "t1",
        content: "text-embedding-3-small uses 1536 dimensions.",
        category: "architecture",
      },
    ],
    sourceMessages: [
      {
        id: "source-1",
        role: "assistant",
        content: "The schema uses 1536 dimensions.",
      },
    ],
    tokenBudget: 300,
  });

  assert.equal(
    result.messages.filter(({ sender }) => sender === "user").length,
    1,
  );
  assert.match(result.messages.at(-1).text, /Conversation summary/);
  assert.match(result.messages.at(-1).text, /Relevant architecture memory/);
  assert.match(
    result.messages.at(-1).text,
    /Original assistant message for verification/,
  );
  assert.ok(result.estimatedTokens <= 300);
});
