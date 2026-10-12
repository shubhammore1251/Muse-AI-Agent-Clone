import { createClient } from "@supabase/supabase-js";
import { EMBEDDING_MODEL } from "./embeddings";

export type MemoryCategory =
  | "preference"
  | "fact"
  | "decision"
  | "architecture"
  | "error_resolution"
  | "open_task";

export type MemoryScope = "user" | "thread";

export type RetrievedMemory = {
  id: string;
  user_id: string;
  thread_id: string | null;
  content: string;
  category: MemoryCategory;
  similarity?: number;
};

export function createUserSupabaseClient(accessToken: string) {
  const url = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase URL or anon key is missing on the server.");
  }

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export function encodeVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function searchMemories(input: {
  client: ReturnType<typeof createUserSupabaseClient>;
  embedding: number[];
  threadId: string;
  queryText: string;
  limit?: number;
}): Promise<RetrievedMemory[]> {
  const { data, error } = await input.client.rpc("search_context_memories", {
    query_embedding: encodeVector(input.embedding),
    active_thread_id: input.threadId,
    query_text: input.queryText,
    keyword_terms: [],
    match_limit: input.limit ?? 5,
  });

  if (error) throw new Error(`Memory search failed: ${error.message}`);

  return ((data ?? []) as RetrievedMemory[]).filter(
    (memory) =>
      memory.thread_id === null || memory.thread_id === input.threadId,
  );
}

export async function saveMemory(input: {
  client: ReturnType<typeof createUserSupabaseClient>;
  userId: string;
  threadId: string;
  content: string;
  category: MemoryCategory;
  scope: MemoryScope;
  embedding: number[];
  sourceMessageIds: string[];
}) {
  const content = input.content.trim().slice(0, 4000);
  if (!content) return;

  const threadId = input.scope === "thread" ? input.threadId : null;

  // Exact-match check keeps repeated exchanges from creating identical rows.
  let duplicateQuery = input.client
    .from("context_memories")
    .select("id")
    .eq("user_id", input.userId)
    .eq("category", input.category)
    .eq("content", content)
    .is("archived_at", null);

  duplicateQuery = threadId
    ? duplicateQuery.eq("thread_id", threadId)
    : duplicateQuery.is("thread_id", null);

  const { data: duplicates, error: duplicateError } =
    await duplicateQuery.limit(1);
  if (duplicateError)
    throw new Error(`Memory duplicate check failed: ${duplicateError.message}`);

  const payload = {
    user_id: input.userId,
    thread_id: threadId,
    source_thread_id: input.threadId,
    content,
    category: input.category,
    embedding: encodeVector(input.embedding),
    embedding_model: EMBEDDING_MODEL,
    source_message_ids: input.sourceMessageIds.slice(-24),
    archived_at: null,
    superseded_by: null,
  };

  if (duplicates?.length) {
    const { error } = await input.client
      .from("context_memories")
      .update(payload)
      .eq("id", duplicates[0].id)
      .eq("user_id", input.userId);
    if (error) throw new Error(`Memory refresh failed: ${error.message}`);
    return;
  }

  const { error } = await input.client.from("context_memories").insert(payload);
  if (error) throw new Error(`Memory insert failed: ${error.message}`);
}
