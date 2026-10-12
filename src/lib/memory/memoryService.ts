import type { ChatMessage } from "@/types";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  getEmbeddings,
} from "./embeddings";
import {
  createUserSupabaseClient,
  saveMemory,
  searchMemories,
  type MemoryCategory,
  type MemoryScope,
} from "./vectorStore";

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string | null;
};

type ContextInput = {
  userId: string | null;
  userEmail: string | null;
  accessToken: string | null;
  threadId: string | null;
  currentMessage: StoredMessage;
  fallbackMessages: ChatMessage[];
};

export type BuiltConversationContext = {
  promptMessages: ChatMessage[];
  conversationMessages: ChatMessage[];
};

const RECENT_MESSAGE_LIMIT = 10;
const MAX_MEMORY_RESULTS = 5;

function fallbackContext(input: ContextInput): BuiltConversationContext {
  return {
    promptMessages: input.fallbackMessages,
    conversationMessages: input.fallbackMessages,
  };
}

function isValidEmbedding(value: number[]): boolean {
  return value.length === EMBEDDING_DIMENSIONS && value.every(Number.isFinite);
}

/**
 * Build prompt context from recent persisted chat history plus relevant vector
 * memories. Summary-table reads/writes are intentionally not used.
 */
export async function buildConversationContext(
  input: ContextInput,
): Promise<BuiltConversationContext> {
  if (
    !input.userId ||
    !input.userEmail ||
    !input.accessToken ||
    !input.threadId
  ) {
    return fallbackContext(input);
  }

  try {
    const client = createUserSupabaseClient(input.accessToken);
    const { data: thread, error: threadError } = await client
      .from("chat_threads")
      .select("id")
      .eq("id", input.threadId)
      .eq("user_email", input.userEmail)
      .maybeSingle();

    if (threadError) throw threadError;
    if (!thread) return fallbackContext(input);

    const { data: rows, error: historyError } = await client
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("thread_id", input.threadId)
      .eq("user_email", input.userEmail)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(RECENT_MESSAGE_LIMIT + 2);

    if (historyError) throw historyError;

    const history: StoredMessage[] = (rows ?? [])
      .map((row: any) => ({
        id: String(row.id),
        role: row.role,
        content: String(row.content ?? ""),
        created_at: row.created_at,
      }))
      .reverse();

    // Avoid duplicating the current user message if the client already saved it.
    const withoutCurrent = history.filter(
      (message) =>
        message.id !== input.currentMessage.id &&
        !(
          message.role === "user" &&
          message.content === input.currentMessage.content
        ),
    );
    const recent = [
      ...withoutCurrent.slice(-RECENT_MESSAGE_LIMIT),
      input.currentMessage,
    ];

    let promptMessages = input.fallbackMessages;
    try {
      const queryEmbedding = await getEmbeddings().embedQuery(
        input.currentMessage.content,
      );
      if (!isValidEmbedding(queryEmbedding))
        throw new Error("Embedding dimensions mismatch.");

      const memories = await searchMemories({
        client,
        embedding: queryEmbedding,
        threadId: input.threadId,
        queryText: input.currentMessage.content,
        limit: MAX_MEMORY_RESULTS,
      });

      const ownedMemories = memories.filter(
        (memory) => memory.user_id === input.userId,
      );
      if (ownedMemories.length) {
        const memoryBlock =
          "Relevant saved context (use only when relevant; newer user instructions override it):\n" +
          ownedMemories
            .map(
              (memory, index) =>
                `${index + 1}. [${memory.category}] ${memory.content}`,
            )
            .join("\n");

        // Inject context into the latest user turn only in the model prompt.
        // conversationMessages remains clean for UI/history.
        const latestUserIndex = [...input.fallbackMessages]
          .map((message) => message.sender)
          .lastIndexOf("user");

        if (latestUserIndex >= 0) {
          promptMessages = input.fallbackMessages.map((message, index) =>
            index === latestUserIndex
              ? { ...message, text: `${message.text}\n\n${memoryBlock}` }
              : message,
          );
        }
      }
    } catch (error) {
      // Memory retrieval is an enhancement: failures must not block chat.
      console.warn("Vector memory retrieval skipped:", error);
    }

    const conversationMessages: ChatMessage[] = recent.map((message) => ({
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

    return { promptMessages, conversationMessages };
  } catch (error) {
    console.warn(
      "Conversation context build failed; using request messages:",
      error,
    );
    return fallbackContext(input);
  }
}

type ExtractedMemory = {
  content: string;
  category: MemoryCategory;
  scope: MemoryScope;
};

async function extractDurableMemories(
  userText: string,
  assistantText: string,
): Promise<ExtractedMemory[]> {
  if (!process.env.OPENAI_API_KEY) return [];

  const model = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_AGENT_MODEL || "gpt-5-nano",
    // temperature: 0,
    timeout: 20_000,
    maxRetries: 1,
  });

  const response = await model.invoke([
    {
      role: "system",
      content:
        'Extract at most 5 durable memories from this exchange. Save stable user preferences/facts as scope user. Save project-specific decisions, architecture, resolved errors, and open tasks as scope thread. Do not save transient chit-chat, guesses, secrets, credentials, or hidden reasoning. Each memory must be a concise standalone statement. Return only JSON: {"memories":[{"content":"...","category":"preference|fact|decision|architecture|error_resolution|open_task","scope":"user|thread"}]}. If nothing durable exists, return {"memories":[]}.',
    },
    {
      role: "user",
      content: JSON.stringify({
        user: userText.slice(0, 4000),
        assistant: assistantText.slice(0, 5000),
      }),
    },
  ]);

  const text =
    typeof response.content === "string"
      ? response.content
      : response.content.map((part: any) => part.text ?? "").join("");

  const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return [];

  const parsed = JSON.parse(jsonText);
  const allowedCategories = new Set<MemoryCategory>([
    "preference",
    "fact",
    "decision",
    "architecture",
    "error_resolution",
    "open_task",
  ]);
  const allowedScopes = new Set<MemoryScope>(["user", "thread"]);

  return (Array.isArray(parsed.memories) ? parsed.memories : [])
    .filter(
      (item: any) =>
        typeof item?.content === "string" &&
        item.content.trim().length > 0 &&
        allowedCategories.has(item.category) &&
        allowedScopes.has(item.scope),
    )
    .slice(0, 5);
}

/**
 * Persist only extracted durable memories. It does not create/update summaries.
 * Caller should run this after a completed assistant response.
 */
export async function persistConversationExchange(input: {
  userId: string | null;
  userEmail: string | null;
  accessToken: string | null;
  threadId: string | null;
  currentMessage: StoredMessage;
  fallbackMessages: ChatMessage[];
  assistantResponse: string;
}): Promise<void> {
  if (
    !input.userId ||
    !input.userEmail ||
    !input.accessToken ||
    !input.threadId
  )
    return;
  if (!input.currentMessage.content.trim() || !input.assistantResponse.trim())
    return;

  const client = createUserSupabaseClient(input.accessToken);

  const { data: thread, error: threadError } = await client
    .from("chat_threads")
    .select("id")
    .eq("id", input.threadId)
    .eq("user_email", input.userEmail)
    .maybeSingle();

  if (threadError) throw threadError;
  if (!thread) return;

  const memories = await extractDurableMemories(
    input.currentMessage.content,
    input.assistantResponse,
  );
  if (!memories.length) return;

  const embeddings: OpenAIEmbeddings = getEmbeddings();
  for (const memory of memories) {
    try {
      const vector = await embeddings.embedQuery(memory.content);
      if (!isValidEmbedding(vector)) {
        throw new Error(
          `Expected ${EMBEDDING_DIMENSIONS} dimensions from ${EMBEDDING_MODEL}.`,
        );
      }

      await saveMemory({
        client,
        userId: input.userId,
        threadId: input.threadId,
        content: memory.content,
        category: memory.category,
        scope: memory.scope,
        embedding: vector,
        sourceMessageIds: [input.currentMessage.id],
      });
    } catch (error) {
      // Keep processing other memories; the chat response has already completed.
      console.warn("Could not persist one context memory:", error);
    }
  }
}
