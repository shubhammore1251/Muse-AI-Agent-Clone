export type StoredContextMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

export type ContextMemory = {
  id: string;
  user_id: string;
  thread_id: string | null;
  source_thread_id: string | null;
  content: string;
  category: string;
  similarity?: number;
  source_message_ids?: string[];
};

export type PromptContext = {
  messages: Array<{ sender: "user" | "agent"; text: string }>;
  estimatedTokens: number;
};

export function canUsePersistentContext(input: {
  userId?: string | null;
  accessToken?: string | null;
  threadId?: string | null;
}) {
  return Boolean(input.userId && input.accessToken && input.threadId);
}

export function selectRecentMessages(
  rows: StoredContextMessage[],
  current: StoredContextMessage,
  limit = 10,
): StoredContextMessage[] {
  const unique = new Map<string, StoredContextMessage>();
  for (const row of rows) {
    if (!row.id || !row.content.trim()) continue;
    unique.set(row.id, row);
  }
  unique.set(current.id, current);

  const ordered = [...unique.values()].sort((left, right) => {
    if (left.id === current.id) return 1;
    if (right.id === current.id) return -1;
    const leftTime = left.created_at ? Date.parse(left.created_at) : 0;
    const rightTime = right.created_at ? Date.parse(right.created_at) : 0;
    return leftTime - rightTime;
  });
  return ordered.slice(-Math.max(1, limit));
}

export function scopeMemories(
  memories: ContextMemory[],
  userId: string,
  threadId: string,
): ContextMemory[] {
  const seen = new Set<string>();
  const contentSeen = new Set<string>();
  return memories.filter((memory) => {
    if (
      memory.user_id !== userId ||
      (memory.thread_id !== null && memory.thread_id !== threadId)
    ) {
      return false;
    }
    const normalizedContent = memory.content.trim().toLowerCase();
    if (
      !normalizedContent ||
      seen.has(memory.id) ||
      contentSeen.has(normalizedContent)
    ) {
      return false;
    }
    seen.add(memory.id);
    contentSeen.add(normalizedContent);
    return true;
  });
}

export function getTechnicalIdentifiers(text: string): string[] {
  const matches = text.match(
    /(?:[\w.+-]+\.(?:tsx?|jsx?|json|sql|py|env))|(?:\b[A-Z]{2,}[-_]\d+\b)|(?:\b[A-Z][A-Z0-9_]{2,}\b)|(?:\b[a-zA-Z_$][\w$]*(?:\.[\w$]+)+\b)|(?:\b[a-zA-Z_$][\w$]*\(\))|(?:\b[a-f0-9]{7,}\b)/g,
  );
  return [...new Set((matches ?? []).map((match) => match.toLowerCase()))];
}

export function chooseMemoryMutation(
  existing: Array<{ category: string; similarity: number }>,
  category: string,
  threshold = 0.88,
): "insert" | "update" {
  return existing.some(
    (memory) => memory.category === category && memory.similarity >= threshold,
  )
    ? "update"
    : "insert";
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function isCompatibleEmbedding(
  embedding: unknown,
  dimensions = 1536,
): embedding is number[] {
  return (
    Array.isArray(embedding) &&
    embedding.length === dimensions &&
    embedding.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  );
}

export function buildPromptContext(input: {
  recentMessages: StoredContextMessage[];
  currentMessage: StoredContextMessage;
  summary?: string | null;
  memories?: ContextMemory[];
  sourceMessages?: StoredContextMessage[];
  tokenBudget?: number;
}): PromptContext {
  const budget = Math.max(1, input.tokenBudget ?? 6000);
  const recent = selectRecentMessages(
    input.recentMessages,
    input.currentMessage,
    10,
  );
  const priorMessages = recent.filter(
    (message) => message.id !== input.currentMessage.id,
  );
  const selectedPrior: StoredContextMessage[] = [];
  let usedTokens = estimateTokens(input.currentMessage.content);

  for (const message of [...priorMessages].reverse()) {
    const tokens = estimateTokens(message.content);
    if (usedTokens + tokens + 1 > budget) break;
    selectedPrior.unshift(message);
    usedTokens += tokens + 1;
  }

  const includedIds = new Set([
    input.currentMessage.id,
    ...selectedPrior.map((message) => message.id),
  ]);
  const contextParts: string[] = [];
  const contextHeader =
    "\n\nSaved context (verify if details may have changed):\n";
  const appendPart = (label: string, content: string) => {
    const part = `${label}: ${content.trim()}`;
    const tokens = estimateTokens(part) + 1;
    const headerTokens = contextParts.length
      ? 0
      : estimateTokens(contextHeader);
    if (content.trim() && usedTokens + tokens + headerTokens <= budget) {
      contextParts.push(part);
      usedTokens += tokens + headerTokens;
    }
  };

  if (input.summary) appendPart("Conversation summary", input.summary);
  for (const memory of input.memories ?? []) {
    appendPart(`Relevant ${memory.category} memory`, memory.content);
  }
  for (const message of input.sourceMessages ?? []) {
    if (includedIds.has(message.id)) continue;
    appendPart(
      `Original ${message.role} message for verification`,
      message.content,
    );
    includedIds.add(message.id);
  }

  const currentText = contextParts.length
    ? `${input.currentMessage.content}${contextHeader}${contextParts.join("\n")}`
    : input.currentMessage.content;
  const messages = [
    ...selectedPrior.map((message) => ({
      sender:
        message.role === "assistant" ? ("agent" as const) : ("user" as const),
      text: message.content,
    })),
    { sender: "user" as const, text: currentText },
  ];

  return {
    messages,
    estimatedTokens: estimateTokens(
      messages.map(({ text }) => text).join("\n"),
    ),
  };
}
