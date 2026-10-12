export type ChatMessageCursor = {
  id: string;
  createdAt: string;
};

export type ChatMessagesPage<T = unknown> = {
  messages: T[];
  nextCursor: ChatMessageCursor | null;
  hasMore: boolean;
};

export const DEFAULT_CHAT_MESSAGE_PAGE_SIZE = 1;
const MAX_CHAT_MESSAGE_PAGE_SIZE = 20;

export function normalizeChatMessagePageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return DEFAULT_CHAT_MESSAGE_PAGE_SIZE;
  return Math.min(
    Math.max(Math.floor(pageSize), 0),
    MAX_CHAT_MESSAGE_PAGE_SIZE,
  );
}

export function createChatMessagesPage<
  T extends { id: string | number; created_at: string },
>(rows: T[], pageSize: number): ChatMessagesPage<T> {
  if (pageSize === 0) {
    return { messages: [], nextCursor: null, hasMore: false };
  }

  const hasMore = rows.length === pageSize;
  const oldestMessage = rows[rows.length - 1];
  return {
    messages: [...rows].reverse(),
    hasMore,
    nextCursor:
      hasMore && oldestMessage
        ? {
            id: String(oldestMessage.id),
            createdAt: String(oldestMessage.created_at),
          }
        : null,
  };
}
