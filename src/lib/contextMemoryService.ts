import {
  buildPromptContext,
  canUsePersistentContext,
  chooseMemoryMutation,
  ContextMemory,
  getTechnicalIdentifiers,
  isCompatibleEmbedding,
  scopeMemories,
  selectRecentMessages,
  StoredContextMessage,
} from "@/lib/contextMemory";

import { ChatMessage } from "@/types";

import { createClient } from "@supabase/supabase-js";

const EMBEDDING_MODEL = "text-embedding-3-small";

const EMBEDDING_DIMENSIONS = 1536;

const DEFAULT_CONTEXT_TOKEN_BUDGET = 6000;

const MAX_MEMORY_RESULTS = 5;

type ContextRequest = {
  userId: string | null;

  userEmail: string | null;

  accessToken: string | null;

  threadId: string | null;

  currentMessage: StoredContextMessage;

  fallbackMessages: ChatMessage[];
};

export type BuiltConversationContext = {
  promptMessages: ChatMessage[];

  conversationMessages: ChatMessage[];
};

type SummaryRow = {
  summary: string;

  summary_version: number;

  source_message_ids: string[];

  source_started_at: string | null;

  source_ended_at: string | null;

  updated_at: string;
};

type ExtractedUpdate = {
  summary: string;

  memories: Array<{
    content: string;

    category: ContextMemory["category"];

    scope: "user" | "thread";
  }>;
};

function getAuthenticatedClient(accessToken: string) {
  const url =
    process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";

  const anonKey =
    process.env.EXPO_PUBLIC_SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";

  if (!url || !anonKey)
    throw new Error("Supabase public configuration is missing.");

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },

    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function getConfiguredLimit(name: string, fallback: number, maximum: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  return Number.isFinite(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function toChatMessages(messages: StoredContextMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,

    sender: message.role === "assistant" ? "agent" : "user",

    text: message.content,

    timestamp: message.created_at
      ? new Date(message.created_at).toLocaleTimeString([], {
          hour: "2-digit",

          minute: "2-digit",
        })
      : "",
  }));
}

function fallbackContext(input: ContextRequest): BuiltConversationContext {
  const fallback = input.fallbackMessages

    .filter(
      (message) => message.sender === "user" || message.sender === "agent",
    )

    .slice(-10);

  const currentIndex = fallback.findIndex(
    (message) => message.id === input.currentMessage.id,
  );

  if (currentIndex >= 0) fallback.splice(currentIndex, 1);

  fallback.push({
    id: input.currentMessage.id,

    sender: "user",

    text: input.currentMessage.content,

    timestamp: "",
  });

  return { promptMessages: fallback, conversationMessages: fallback };
}

export async function buildConversationContext(
  input: ContextRequest,
): Promise<BuiltConversationContext> {
  if (
    !canUsePersistentContext({
      userId: input.userId,

      accessToken: input.accessToken,

      threadId: input.threadId,
    }) ||
    !input.userEmail
  ) {
    return fallbackContext(input);
  }

  try {
    const client = getAuthenticatedClient(input.accessToken!);

    const { data: thread, error: threadError } = await client

      .from("chat_threads")

      .select("id, user_email, type")

      .eq("id", input.threadId!)

      .eq("user_email", input.userEmail)

      .maybeSingle();

    if (threadError) throw threadError;

    if (!thread) return fallbackContext(input);

    const { data: storedRows, error: historyError } = await client

      .from("chat_messages")

      .select("id, role, content, created_at")

      .eq("thread_id", input.threadId!)

      .eq("user_email", input.userEmail)

      .order("created_at", { ascending: false })

      .limit(11);

    if (historyError) throw historyError;

    const current: StoredContextMessage = {
      ...input.currentMessage,

      role: "user",
    };

    const rows: StoredContextMessage[] = (storedRows ?? [])

      .filter((row: any) => row.role === "user" || row.role === "assistant")

      .map((row: any) => ({
        id: String(row.id),

        role: row.role,

        content: String(row.content ?? ""),

        created_at: row.created_at,
      }));

    const recentMessages = selectRecentMessages(rows, current, 10);

    const { data: summaryData, error: summaryError } = await client

      .from("context_summaries")

      .select(
        "summary, summary_version, source_message_ids, source_started_at, source_ended_at, updated_at",
      )

      .eq("user_id", input.userId!)

      .eq("thread_id", input.threadId!)

      .maybeSingle();

    if (summaryError) {
      console.warn("Conversation summary lookup failed:", summaryError.message);
    }

    let summary = summaryError
      ? null
      : ((summaryData as SummaryRow | null) ?? null);

    if (!summaryError) {
      try {
        summary = await refreshSummaryIfDue({
          client,

          userId: input.userId!,

          userEmail: input.userEmail,

          threadId: input.threadId!,

          current,

          previousSummary: summary,
        });
      } catch (error) {
        console.warn(
          "Summary refresh failed; keeping the previous summary:",

          error instanceof Error ? error.message : error,
        );
      }
    }

    const queryEmbedding = summaryError
      ? null
      : await embedTexts([current.content]).then(
          (embeddings) => embeddings[0],

          () => null,
        );

    const keywords = getTechnicalIdentifiers(current.content);

    let memories: ContextMemory[] = [];

    const { data: memoryRows, error: memoryError } = await client.rpc(
      "search_context_memories",

      {
        query_embedding: queryEmbedding ? encodeVector(queryEmbedding) : null,

        active_thread_id: input.threadId,

        query_text: current.content,

        keyword_terms: keywords,

        match_limit: MAX_MEMORY_RESULTS,
      },
    );

    if (memoryError) {
      console.warn("Persistent context retrieval failed:", memoryError.message);
    } else {
      memories = scopeMemories(
        (memoryRows ?? []) as ContextMemory[],

        input.userId as string,

        input.threadId as string,
      ).slice(0, MAX_MEMORY_RESULTS);
    }

    const sourceMessages = await loadSourceMessages({
      client,

      userEmail: input.userEmail,

      recentMessages,

      memories,
    }).catch((error) => {
      console.warn(
        "Original context messages unavailable:",

        error instanceof Error ? error.message : error,
      );

      return [];
    });

    const packed = buildPromptContext({
      recentMessages,

      currentMessage: current,

      summary: summary?.summary,

      memories,

      sourceMessages,

      tokenBudget: getConfiguredLimit(
        "CONTEXT_TOKEN_BUDGET",

        DEFAULT_CONTEXT_TOKEN_BUDGET,

        16000,
      ),
    });

    return {
      promptMessages: packed.messages.map((message, index) => ({
        id:
          index === packed.messages.length - 1
            ? current.id
            : `context-${index}`,

        sender: message.sender,

        text: message.text,

        timestamp: "",
      })),

      conversationMessages: toChatMessages(recentMessages),
    };
  } catch (error) {
    console.warn(
      "Persistent context unavailable; continuing with recent request messages:",

      error instanceof Error ? error.message : error,
    );

    return fallbackContext(input);
  }
}

/** Persist derived context after the assistant has produced its reply.
 * This is intentionally separate from retrieval so a missing summary cannot
 * silently prevent the exchange from being written to persistent context.
 */
export async function persistConversationExchange(
  input: ContextRequest & { assistantResponse: string },
): Promise<void> {
  if (
    !canUsePersistentContext({
      userId: input.userId,
      accessToken: input.accessToken,
      threadId: input.threadId,
    }) ||
    !input.userEmail
  ) {
    throw new Error(
      "Cannot persist conversation context: user ID, access token, thread ID, and user email are required.",
    );
  }

  const userText = input.currentMessage.content.trim();
  const assistantText = input.assistantResponse.trim();
  if (!userText || !assistantText) {
    throw new Error("Cannot persist context for an empty exchange.");
  }

  const client = getAuthenticatedClient(input.accessToken!);
  const { data: thread, error: threadError } = await client
    .from("chat_threads")
    .select("id")
    .eq("id", input.threadId!)
    .eq("user_email", input.userEmail)
    .maybeSingle();
  if (threadError) throw threadError;
  if (!thread) {
    throw new Error(
      "Cannot persist context: the thread was not found for this user.",
    );
  }

  const { data: summaryData, error: summaryError } = await client
    .from("context_summaries")
    .select(
      "summary, summary_version, source_message_ids, source_started_at, source_ended_at, updated_at",
    )
    .eq("user_id", input.userId!)
    .eq("thread_id", input.threadId!)
    .maybeSingle();
  if (summaryError) throw summaryError;

  const exchangeTime =
    input.currentMessage.created_at ?? new Date().toISOString();
  const current: StoredContextMessage = {
    ...input.currentMessage,
    role: "user",
    content: userText,
    created_at: exchangeTime,
  };
  const assistantMessage: StoredContextMessage = {
    id: `assistant:${input.currentMessage.id}`,
    role: "assistant",
    content: assistantText,
    created_at: new Date().toISOString(),
  };

  const saved = await refreshSummaryIfDue({
    client,
    userId: input.userId!,
    userEmail: input.userEmail,
    threadId: input.threadId!,
    current,
    additionalMessages: [assistantMessage],
    previousSummary: (summaryData as SummaryRow | null) ?? null,
  });

  if (!saved) {
    throw new Error("Context summary was not persisted.");
  }
}

async function refreshSummaryIfDue(input: {
  client: ReturnType<typeof getAuthenticatedClient>;
  userId: string;
  userEmail: string;
  threadId: string;
  current: StoredContextMessage;
  additionalMessages?: StoredContextMessage[];
  previousSummary: SummaryRow | null;
}): Promise<SummaryRow | null> {
  // Persist an updated summary and extracted memories on every incoming user
  // message. The current message may not yet exist in chat_messages, so add it
  // explicitly instead of relying on the database query to return it.
  const { data: sourceRows, error: sourceError } = await input.client
    .from("chat_messages")
    .select("id, role, content, created_at")
    .eq("thread_id", input.threadId)
    .eq("user_email", input.userEmail)
    .neq("id", input.current.id)
    .lt("created_at", input.current.created_at ?? new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(23);

  if (sourceError) throw sourceError;

  const previousMessages: StoredContextMessage[] = (sourceRows ?? [])
    .filter((row: any) => row.role === "user" || row.role === "assistant")
    .map((row: any) => ({
      id: String(row.id),
      role: row.role,
      content: String(row.content ?? ""),
      created_at: row.created_at,
    }));

  const currentMessage: StoredContextMessage = {
    ...input.current,
    role: "user",
    content: input.current.content.trim(),
    created_at: input.current.created_at ?? new Date().toISOString(),
  };

  const messagesById = new Map<string, StoredContextMessage>();
  for (const message of previousMessages) {
    if (message.id && message.content.trim())
      messagesById.set(message.id, message);
  }
  if (currentMessage.id && currentMessage.content) {
    messagesById.set(currentMessage.id, currentMessage);
  }

  const sourceMessages = [...messagesById.values()].sort((left, right) => {
    const leftTime = left.created_at ? Date.parse(left.created_at) : 0;
    const rightTime = right.created_at ? Date.parse(right.created_at) : 0;
    return leftTime - rightTime;
  });
  if (!sourceMessages.length) return input.previousSummary;

  let update: ExtractedUpdate | null = null;
  try {
    update = await extractContextUpdate(
      [...sourceMessages, ...(input.additionalMessages ?? [])].sort(
        (left, right) => {
          const leftTime = left.created_at ? Date.parse(left.created_at) : 0;
          const rightTime = right.created_at ? Date.parse(right.created_at) : 0;
          return leftTime - rightTime;
        },
      ),
      input.previousSummary?.summary ?? "",
    );
  } catch (error) {
    console.warn(
      "Context extraction failed; saving a minimal summary instead:",
      error instanceof Error ? error.message : error,
    );
  }

  const allSourceMessages = [
    ...sourceMessages,
    ...(input.additionalMessages ?? []),
  ];
  const summaryText =
    update?.summary.trim() ||
    input.previousSummary?.summary ||
    "No durable preferences, facts, or decisions have been established in this conversation yet.";

  const sourceIds = [
    ...new Set([
      ...(input.previousSummary?.source_message_ids ?? []).filter(isUuid),
      ...sourceMessages.map(({ id }) => id).filter(isUuid),
    ]),
  ].slice(-100);

  const payload = {
    user_id: input.userId,
    thread_id: input.threadId,
    summary: summaryText.slice(0, 12000),
    summary_version: (input.previousSummary?.summary_version ?? 0) + 1,
    source_message_ids: sourceIds,
    source_started_at:
      input.previousSummary?.source_started_at ??
      sourceMessages[0]?.created_at ??
      null,
    source_ended_at:
      allSourceMessages[allSourceMessages.length - 1]?.created_at ?? null,
  };

  const { data: savedSummary, error: saveSummaryError } = await input.client
    .from("context_summaries")
    .upsert(payload, { onConflict: "user_id,thread_id" })
    .select(
      "summary, summary_version, source_message_ids, source_started_at, source_ended_at, updated_at",
    )
    .single();
  if (saveSummaryError) throw saveSummaryError;

  if (update) {
    await saveExtractedMemories({
      client: input.client,
      userId: input.userId,
      threadId: input.threadId,
      update,
      sourceMessageIds: allSourceMessages
        .filter(({ id }) => !id.startsWith("assistant:") && isUuid(id))
        .map(({ id }) => id),
    });
  }

  return savedSummary as SummaryRow;
}

async function loadSourceMessages(input: {
  client: ReturnType<typeof getAuthenticatedClient>;

  userEmail: string;

  recentMessages: StoredContextMessage[];

  memories: ContextMemory[];
}) {
  const recentIds = new Set(input.recentMessages.map(({ id }) => id));

  const references = new Map<string, string[]>();

  for (const memory of input.memories) {
    if (!memory.source_thread_id) continue;

    const ids = (memory.source_message_ids ?? [])

      .filter((id) => !recentIds.has(id))

      .slice(-2);

    if (!ids.length) continue;

    references.set(memory.source_thread_id, [
      ...new Set([...(references.get(memory.source_thread_id) ?? []), ...ids]),
    ]);
  }

  const sourceMessages: StoredContextMessage[] = [];

  for (const [sourceThreadId, ids] of references) {
    const { data: sourceThread, error: threadError } = await input.client

      .from("chat_threads")

      .select("id")

      .eq("id", sourceThreadId)

      .eq("user_email", input.userEmail)

      .maybeSingle();

    if (threadError) throw threadError;

    if (!sourceThread) continue;

    const { data, error } = await input.client

      .from("chat_messages")

      .select("id, role, content, created_at")

      .eq("thread_id", sourceThreadId)

      .eq("user_email", input.userEmail)

      .in("id", ids);

    if (error) throw error;

    sourceMessages.push(
      ...((data ?? []) as any[])

        .filter((row) => row.role === "user" || row.role === "assistant")

        .map((row) => ({
          id: String(row.id),

          role: row.role,

          content: String(row.content ?? ""),

          created_at: row.created_at,
        })),
    );
  }

  return sourceMessages;
}

async function extractContextUpdate(
  messages: StoredContextMessage[],

  previousSummary: string,
): Promise<ExtractedUpdate | null> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) return null;

  const schema = {
    type: "object",

    additionalProperties: false,

    required: ["summary", "memories"],

    properties: {
      summary: { type: "string" },

      memories: {
        type: "array",

        maxItems: 6,

        items: {
          type: "object",

          additionalProperties: false,

          required: ["content", "category", "scope"],

          properties: {
            content: { type: "string" },

            category: {
              type: "string",

              enum: [
                "preference",

                "fact",

                "decision",

                "architecture",

                "error_resolution",

                "open_task",
              ],
            },

            scope: { type: "string", enum: ["user", "thread"] },
          },
        },
      },
    },
  };

  const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
    method: "POST",

    headers: {
      Authorization: `Bearer ${apiKey}`,

      "Content-Type": "application/json",
    },

    signal: AbortSignal.timeout(20000),

    body: JSON.stringify({
      model: process.env.OPENAI_AGENT_MODEL || "gpt-5-nano",

      input: [
        {
          role: "system",

          content:
            "Update a compact conversation summary and extract only durable facts, preferences, architecture decisions, resolved errors, and unresolved tasks. Do not store every utterance, speculation, secrets, or hidden reasoning. Preserve useful technical identifiers verbatim. Revise or remove outdated claims instead of repeating contradictions. User scope is only for stable facts useful across unrelated conversations; project-specific details must be thread scoped. Return no more than six memories.",
        },

        {
          role: "user",

          content: JSON.stringify({
            previousSummary,

            messages: messages.map(({ role, content }) => ({
              role,

              content: content.slice(0, 2000),
            })),
          }),
        },
      ],

      text: {
        format: {
          type: "json_schema",

          name: "muse_context_update",

          strict: true,

          schema,
        },
      },

      max_output_tokens: 1400,
    }),
  });

  if (!response.ok) {
    throw new Error(`Context extraction failed with HTTP ${response.status}.`);
  }

  const body = await response.json();

  const outputText = (body.output ?? [])

    .flatMap((item: any) => item.content ?? [])

    .find((item: any) => item.type === "output_text")?.text;

  if (typeof outputText !== "string") return null;

  const parsed = JSON.parse(outputText) as ExtractedUpdate;

  return {
    summary: parsed.summary.slice(0, 12000),

    memories: (parsed.memories ?? [])

      .filter((memory) => memory.content.trim())

      .slice(0, 6),
  };
}

async function saveExtractedMemories(input: {
  client: ReturnType<typeof getAuthenticatedClient>;

  userId: string;

  threadId: string;

  update: ExtractedUpdate;

  sourceMessageIds: string[];
}) {
  if (!input.update.memories.length) return;

  const embeddings = await embedTexts(
    input.update.memories.map(({ content }) => content),
  ).catch((error) => {
    console.warn(
      "Memory embeddings unavailable; retaining memories for lexical retrieval:",

      error instanceof Error ? error.message : error,
    );

    return input.update.memories.map(() => null);
  });

  for (const [index, memory] of input.update.memories.entries()) {
    const threadScope = memory.scope === "thread" ? input.threadId : null;

    const embedding = embeddings[index];

    let existing: ContextMemory[] = [];

    if (embedding) {
      const { data, error } = await input.client.rpc(
        "search_context_memories",

        {
          query_embedding: encodeVector(embedding),

          active_thread_id: input.threadId,

          query_text: memory.content,

          keyword_terms: [],

          match_limit: 5,
        },
      );

      if (error) {
        console.warn("Memory deduplication search failed:", error.message);
      } else {
        existing = scopeMemories(
          (data ?? []) as ContextMemory[],

          input.userId,

          input.threadId,
        ).filter((candidate) => candidate.thread_id === threadScope);
      }
    }

    const existingMatch = existing

      .filter((candidate) => candidate.category === memory.category)

      .sort(
        (left, right) => (right.similarity ?? 0) - (left.similarity ?? 0),
      )[0];

    const shouldUpdate = existingMatch
      ? chooseMemoryMutation(
          [
            {
              category: existingMatch.category,

              similarity: existingMatch.similarity ?? 0,
            },
          ],

          memory.category,

          0.82,
        ) === "update"
      : false;

    const payload = {
      user_id: input.userId,

      thread_id: threadScope,

      source_thread_id: input.threadId,

      content: memory.content.trim().slice(0, 4000),

      category: memory.category,

      embedding: embedding ? encodeVector(embedding) : null,

      embedding_model: embedding ? EMBEDDING_MODEL : null,

      source_message_ids: input.sourceMessageIds.slice(-24),

      archived_at: null,

      superseded_by: null,
    };

    if (shouldUpdate && existingMatch) {
      const { error } = await input.client

        .from("context_memories")

        .update(payload)

        .eq("id", existingMatch.id)

        .eq("user_id", input.userId);

      if (error) console.warn("Memory update failed:", error.message);

      continue;
    }

    let exactQuery = input.client

      .from("context_memories")

      .select("id")

      .eq("user_id", input.userId)

      .eq("category", memory.category)

      .eq("content", payload.content)

      .is("archived_at", null);

    exactQuery = threadScope
      ? exactQuery.eq("thread_id", threadScope)
      : exactQuery.is("thread_id", null);

    const { data: exactMatches, error: exactError } = await exactQuery.limit(1);

    if (exactError) {
      console.warn("Memory duplicate check failed:", exactError.message);

      continue;
    }

    if (exactMatches?.length) {
      const { error } = await input.client

        .from("context_memories")

        .update(payload)

        .eq("id", exactMatches[0].id)

        .eq("user_id", input.userId);

      if (error) console.warn("Memory refresh failed:", error.message);

      continue;
    }

    const insertPayload = { ...payload };

    const { error } = await input.client

      .from("context_memories")

      .insert(insertPayload);

    if (error) console.warn("Memory insert failed:", error.message);
  }
}

async function embedTexts(texts: string[]): Promise<Array<number[] | null>> {
  if (!texts.length) return [];

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const response = await fetchWithRetry(
    "https://api.openai.com/v1/embeddings",

    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${apiKey}`,

        "Content-Type": "application/json",
      },

      signal: AbortSignal.timeout(15000),

      body: JSON.stringify({
        model: EMBEDDING_MODEL,

        input: texts.map((text) => text.trim()),

        encoding_format: "float",
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Embedding request failed with HTTP ${response.status}.`);
  }

  const body = await response.json();

  const embeddings = (body.data ?? [])

    .sort((left: any, right: any) => left.index - right.index)

    .map((item: any) => item.embedding as number[]);

  if (
    embeddings.length !== texts.length ||
    embeddings.some(
      (embedding: number[]) =>
        !isCompatibleEmbedding(embedding, EMBEDDING_DIMENSIONS),
    )
  ) {
    throw new Error("Embedding model returned an incompatible vector shape.");
  }

  return embeddings;
}

async function fetchWithRetry(
  url: string,

  init: RequestInit,

  retries = 1,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, init);

      if (
        attempt < retries &&
        (response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel();

        await new Promise((resolve) =>
          setTimeout(resolve, 250 * (attempt + 1)),
        );

        continue;
      }

      return response;
    } catch (error) {
      if (attempt >= retries) throw error;

      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

function encodeVector(embedding: number[]) {
  return `[${embedding.join(",")}]`;
}
