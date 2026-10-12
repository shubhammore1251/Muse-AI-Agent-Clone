import { OpenAIEmbeddings } from "@langchain/openai";

/**
 * Server-only embedding configuration.
 * text-embedding-3-small produces 1536-dimensional vectors, matching the
 * existing context_memories.embedding column and search_context_memories RPC.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

let embeddings: OpenAIEmbeddings | undefined;

export function getEmbeddings(): OpenAIEmbeddings {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  embeddings ??= new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    maxRetries: 2,
    timeout: 20_000,
  });

  return embeddings;
}
