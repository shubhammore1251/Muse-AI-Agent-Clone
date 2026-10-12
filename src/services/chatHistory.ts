import { getApiUrl } from "@/lib/services";
import { supabase } from "@/lib/supabase";
import {
  createChatMessagesPage,
  DEFAULT_CHAT_MESSAGE_PAGE_SIZE,
  normalizeChatMessagePageSize,
  type ChatMessageCursor,
  type ChatMessagesPage,
} from "@/services/chatHistoryPagination";
import axios from "axios";
export type {
  ChatMessageCursor,
  ChatMessagesPage
} from "@/services/chatHistoryPagination";

export type ChatThreadType = "main" | "side";
export type ChatMessageType = "user" | "assistant";

export const CreateNewThread = async (
  userEmail: string,
  type: ChatThreadType,
  title: string,
) => {
  const { data, error } = await supabase
    .from("chat_threads")
    .insert([
      {
        user_email: userEmail,
        type: type,
        title: title,
      },
    ])
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
};

export const getThread = async (threadId: string, userEmail?: string) => {
  if (!threadId) {
    const { data, error } = await supabase
      .from("chat_threads")
      .select("*")
      .eq("type", "main")
      .eq("user_email", userEmail)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data;
  }

  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
};

export const getLatestThread = async (userEmail: string) => {
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("user_email", userEmail)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
};

export const loadMessages = async (
  threadId: string,
  cursor: ChatMessageCursor | null = null,
  pageSize = DEFAULT_CHAT_MESSAGE_PAGE_SIZE,
): Promise<ChatMessagesPage> => {
  const safePageSize = normalizeChatMessagePageSize(pageSize);
  if (safePageSize === 0) {
    return createChatMessagesPage([], safePageSize);
  }

  let query = supabase
    .from("chat_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (cursor) {
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await query.limit(safePageSize);

  if (error) {
    throw error;
  }

  return createChatMessagesPage(data ?? [], safePageSize);
};

export const getAllUserThreads = async (userEmail: string) => {
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("user_email", userEmail)
    .order("created_at", { ascending: false });
  // .limit(20)

  if (error) {
    throw error;
  }

  return data;
};

export const clearThreadMessages = async (threadId: string) => {
  if (!threadId)
    throw new Error("A chat thread is required to clear messages.");

  const { data, error } = await supabase
    .from("chat_messages")
    .delete()
    .eq("thread_id", threadId);

  if (error) throw error;
  return data;
};

export const deleteSingleThread = async (threadId: string) => {
  const { data: messages, error: messageError } = await supabase
    .from("chat_messages")
    .delete()
    .eq("thread_id", threadId);

  if (messageError) {
    throw messageError;
  }

  const { data, error } = await supabase
    .from("chat_threads")
    .delete()
    .eq("id", threadId);

  if (error) {
    throw error;
  }

  return data;
};

export const saveMessage = async (
  threadId: string,
  userEmail: string,
  role: ChatMessageType,
  content: string,
  metadata: any,
) => {
  const { data, error } = await supabase
    .from("chat_messages")
    .insert([
      {
        thread_id: threadId,
        user_email: userEmail,
        role,
        content,
        metadata,
      },
    ])
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from("chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId);

  if (role === "assistant" && content.trim()) {
    void generateSideChatTitle(threadId, content).catch((titleError) => {
      console.error("Chat title generation failed:", titleError);
    });
  }

  return data;
};

async function generateSideChatTitle(threadId: string, content: string) {
  const { data: thread, error: threadError } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("id", threadId)
    .single();

  if (threadError) throw threadError;
  if (thread?.type !== "side" || thread?.title !== "New side chat") return;

  const response = await axios.post(
    getApiUrl("/chat-title"),
    { assistantResponse: content },
    { timeout: 60000 },
  );
  const generatedTitle = response.data?.title?.trim();

  if (generatedTitle && generatedTitle !== "SKIP_TITLE") {
    const { error: titleError } = await supabase
      .from("chat_threads")
      .update({ title: generatedTitle })
      .eq("id", threadId);

    if (titleError) throw titleError;
  }
}

export const updateMessage = async (
  messageId: string,
  content: string,
  metadata: any,
) => {
  const { data, error } = await supabase
    .from("chat_messages")
    .update({
      content,
      metadata,
    })
    .eq("id", messageId)
    .select()
    .single();

  if (error) throw error;
  return data;
};
