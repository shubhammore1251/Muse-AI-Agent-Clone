/**
 * Chat Tab Screen ('/(tabs)/chat')
 *
 * Minimalist, clean conversational companion UI:
 * - Scrollable message thread
 * - Composio-powered assistant responses
 */

import { ChatBrowserPreview } from "@/components/common/ChatBrowserPreview";
import { LinkifiedText } from "@/components/common/LinkifiedText";
import { Colors } from "@/constants/colors";
import { useChatExport } from "@/context/ChatExportContext";
import { showToast } from "@/context/ToastContext";
import { logAgentEvent, safeErrorMessage } from "@/lib/agentLogger";
import { getChatDateKey, getChatDateLabel } from "@/lib/chatDateLabels";
import {
  ChatExportDestination,
  ChatExportFormat,
  exportChat,
} from "@/lib/chatExport";
import {
  createScheduledAgentTask,
  formatScheduleRule,
} from "@/lib/scheduledTasks";
import { getApiUrl } from "@/lib/services";
import { supabase } from "@/lib/supabase";
import {
  ChatMessageCursor,
  CreateNewThread,
  clearThreadMessages,
  deleteSingleThread,
  getThread,
  loadMessages,
  saveMessage,
  updateMessage,
} from "@/services/chatHistory";
import { ChatMessage } from "@/types";
import {
  Add01Icon,
  Download04Icon,
  File01Icon,
  Link02Icon,
  Mic01Icon,
  SentIcon,
  Share01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type AgentActivityStage =
  | "thinking"
  | "understanding_request"
  | "opening_source"
  | "searching_web"
  | "reading_results"
  | "inspecting_details"
  | "comparing_options"
  | "typing_in_page"
  | "clicking_page"
  | "scrolling_page"
  | "browsing_web"
  | "using_connected_tools"
  | "using_email"
  | "using_calendar"
  | "using_slack"
  | "processing_results"
  | "preparing_response";
type AgentActivity = {
  current: AgentActivityStage;
  completed: AgentActivityStage[];
  detail?: string;
} | null;

function mapStoredMessages(rows: any[]): ChatMessage[] {
  return rows.map((message: any) => ({
    id: String(message.id),
    sender: message.role === "user" ? "user" : "agent",
    text: message.content,
    timestamp: new Date(message.created_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    clarification: message.metadata?.clarification,
    createdAt: message.created_at,
    scheduleConfirmation: message.metadata?.scheduleConfirmation,
    scheduleExecutionId: message.metadata?.scheduleExecutionId,
    scheduleStatus: message.metadata?.scheduleStatus,
    scheduledTaskId: message.metadata?.scheduledTaskId,
    scheduleError: message.metadata?.scheduleError,
  }));
}

export default function ChatScreen() {
  const { registerChatAction, setChatHeaderIdentity } = useChatExport();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerOffset = Platform.OS === "web" ? 0 : insets.top + 98;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const scrollViewRef = useRef<ScrollView>(null);
  const shouldAutoScrollRef = useRef(true);
  const messagesRef = useRef<ChatMessage[]>([]);
  const olderMessagesCursorRef = useRef<ChatMessageCursor | null>(null);
  const isLoadingOlderRef = useRef(false);
  const scrollMetricsRef = useRef({
    offsetY: 0,
    contentHeight: 0,
    viewportHeight: 0,
  });
  const prependScrollAnchorRef = useRef<{
    offsetY: number;
    contentHeight: number;
  } | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivity>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadData, setThreadData] = useState<any>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [isExportMenuVisible, setIsExportMenuVisible] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [selectedExportFormat, setSelectedExportFormat] =
    useState<ChatExportFormat | null>(null);
  const historyLoadIdRef = useRef(0);
  const activeAgentRequestIdRef = useRef(0);
  const confirmingScheduleIdsRef = useRef(new Set<string>());
  const isSendingRef = useRef(false);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  messagesRef.current = messages;

  const { sideChatThreadId, chatType } = useLocalSearchParams();
  const requestedThreadId =
    typeof sideChatThreadId === "string" ? sideChatThreadId : null;
  const routeIsSideChat = chatType === "side";

  useEffect(() => {
    const loadUser = async () => {
      try {
        const data = await supabase.auth.getSession();
        const email = data?.data?.session?.user?.email;
        const uid = data?.data?.session?.user?.id;
        setUserEmail(email ?? null);
        setUserId(uid ?? null);
        if (!email) setIsLoadingMessages(false);
      } catch (error) {
        console.error("Failed to load chat user:", error);
        setIsLoadingMessages(false);
      }
    };
    loadUser();
  }, []);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages]);

  useEffect(() => {
    setThreadData(null);
    setChatHeaderIdentity({
      threadId: requestedThreadId,
      type: routeIsSideChat ? "side" : "main",
      title: routeIsSideChat ? "Side Chat" : "Main Chat",
    });
    if (!requestedThreadId && !userEmail) return;

    let active = true;
    const loadId = ++historyLoadIdRef.current;

    activeAgentRequestIdRef.current += 1;
    isSendingRef.current = false;
    setIsSending(false);
    setAgentActivity(null);
    setIsLoadingMessages(true);
    setIsLoadingOlderMessages(false);
    setHasOlderMessages(false);
    isLoadingOlderRef.current = false;
    olderMessagesCursorRef.current = null;
    prependScrollAnchorRef.current = null;
    scrollMetricsRef.current = {
      offsetY: 0,
      contentHeight: 0,
      viewportHeight: 0,
    };
    shouldAutoScrollRef.current = true;
    setMessages([]);

    const loadThreadAndMessages = async () => {
      try {
        let thread;
        if (requestedThreadId) {
          setThreadId(requestedThreadId);
          thread = await getThread(requestedThreadId, userEmail ?? "");
        } else {
          thread = await getThread("", userEmail ?? "");
          if (!thread) {
            thread = await CreateNewThread(
              userEmail ?? "",
              "main",
              "Main Chat",
            );
          }
          if (active) setThreadId(thread?.id ?? null);
        }

        if (!active || historyLoadIdRef.current !== loadId) return;
        setThreadData(thread);
        const isSideThread = thread?.type === "side";
        setChatHeaderIdentity({
          threadId: thread?.id ?? requestedThreadId,
          type: isSideThread ? "side" : "main",
          title: isSideThread
            ? typeof thread?.title === "string" && thread.title.trim()
              ? thread.title.trim()
              : "Side Chat"
            : "Main Chat",
        });

        const activeThreadId = thread?.id ?? requestedThreadId;
        if (!activeThreadId) return;

        const history = await loadMessages(activeThreadId);
        if (!active || historyLoadIdRef.current !== loadId) return;
        olderMessagesCursorRef.current = history.nextCursor;
        setHasOlderMessages(history.hasMore);
        setMessages(mapStoredMessages(history.messages));
      } catch (error) {
        if (active && historyLoadIdRef.current === loadId) {
          console.error("Failed to load chat history:", error);
          setMessages([]);
          showToast("Couldn't load this chat's messages.");
        }
      } finally {
        if (active && historyLoadIdRef.current === loadId) {
          setIsLoadingMessages(false);
        }
      }
    };

    void loadThreadAndMessages();
    return () => {
      active = false;
      historyLoadIdRef.current += 1;
    };
  }, [requestedThreadId, userEmail, routeIsSideChat, setChatHeaderIdentity]);

  const loadOlderMessages = async () => {
    const activeThreadId = threadIdRef.current;
    const cursor = olderMessagesCursorRef.current;
    if (
      !activeThreadId ||
      !cursor ||
      !hasOlderMessages ||
      isLoadingMessages ||
      isLoadingOlderRef.current
    ) {
      return;
    }

    shouldAutoScrollRef.current = false;
    const loadId = historyLoadIdRef.current;
    isLoadingOlderRef.current = true;
    setIsLoadingOlderMessages(true);
    try {
      const page = await loadMessages(activeThreadId, cursor);
      if (
        loadId !== historyLoadIdRef.current ||
        threadIdRef.current !== activeThreadId
      ) {
        return;
      }

      const olderMessages = mapStoredMessages(page.messages);
      const existingIds = new Set(messagesRef.current.map(({ id }) => id));
      const uniqueOlderMessages = olderMessages.filter(
        ({ id }) => !existingIds.has(id),
      );
      if (uniqueOlderMessages.length) {
        prependScrollAnchorRef.current = {
          offsetY: scrollMetricsRef.current.offsetY,
          contentHeight: scrollMetricsRef.current.contentHeight,
        };
        setMessages((currentMessages) => {
          const currentIds = new Set(currentMessages.map(({ id }) => id));
          return [
            ...uniqueOlderMessages.filter(({ id }) => !currentIds.has(id)),
            ...currentMessages,
          ];
        });
      }
      olderMessagesCursorRef.current = page.nextCursor;
      setHasOlderMessages(page.hasMore);
    } catch (error) {
      showToast("Couldn't load older messages.");
      console.error("Failed to load older chat messages:", error);
    } finally {
      isLoadingOlderRef.current = false;
      setIsLoadingOlderMessages(false);
    }
  };

  const loadOlderMessagesToFillViewport = (contentHeight: number) => {
    const viewportHeight = scrollMetricsRef.current.viewportHeight;
    if (
      viewportHeight > 0 &&
      contentHeight <= viewportHeight + 1 &&
      hasOlderMessages &&
      !isLoadingMessages &&
      !isLoadingOlderRef.current
    ) {
      void loadOlderMessages();
    }
  };
  useEffect(() => {
    if (isLoadingMessages) return;
    const frame = requestAnimationFrame(() => {
      loadOlderMessagesToFillViewport(scrollMetricsRef.current.contentHeight);
    });
    return () => cancelAnimationFrame(frame);
  }, [isLoadingMessages, hasOlderMessages, messages.length]);

  const submitPrompt = async (
    text: string,
    baseMessages: ChatMessage[] = messages,
  ) => {
    if (!text || isLoadingMessages || isSendingRef.current) return;

    Keyboard.dismiss();
    shouldAutoScrollRef.current = true;
    const requestId = ++activeAgentRequestIdRef.current;
    const requestThreadId = threadId ?? "";
    const agentMessageId = `msg-${Date.now()}-${requestId}`;
    const createdAt = new Date().toISOString();
    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    isSendingRef.current = true;
    setIsSending(true);
    setAgentActivity({ current: "thinking", completed: [] });

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-${requestId}-user`,
      sender: "user",
      text,
      timestamp,
      createdAt,
    };

    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: agentMessageId, sender: "agent", text: "", timestamp, createdAt },
    ]);
    setInputText("");

    const stopAgentLoader = () => {
      if (activeAgentRequestIdRef.current !== requestId) return;
      isSendingRef.current = false;
      setIsSending(false);
      setAgentActivity(null);
    };
    const isRequestCurrent = () =>
      activeAgentRequestIdRef.current === requestId &&
      threadIdRef.current === requestThreadId;
    const recordAgentActivity = (stage: unknown, detail?: unknown) => {
      if (!isRequestCurrent() || !isAgentActivityStage(stage)) return;
      const activityDetail = typeof detail === "string" ? detail : undefined;

      setAgentActivity((previous) => {
        if (!previous) {
          return { current: stage, completed: [], detail: activityDetail };
        }
        if (previous.current === stage && previous.detail === activityDetail) {
          return previous;
        }

        return {
          current: stage,
          completed: [...previous.completed, previous.current].slice(-3),
          detail: activityDetail,
        };
      });
    };

    try {
      const savedUserMessage = await saveMessage(
        requestThreadId,
        userEmail ?? "",
        "user",
        text,
        {},
      );
      const { data: authData } = await supabase.auth.getSession();
      const accessToken = authData.session?.access_token;

      const ApiUrl = getApiUrl("/chat");

      const response = await fetch(ApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          messages: [
            {
              ...userMsg,
              id: savedUserMessage?.id ?? userMsg.id,
              created_at: savedUserMessage?.created_at,
            },
          ],
          threadId: requestThreadId,
          userId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Failed to connect to agent");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, {
          stream: true,
        });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          const data = JSON.parse(line);

          if (data.type === "activity") {
            recordAgentActivity(data.activity, data.detail);
          }

          if (data.type === "browser") {
            if (isRequestCurrent()) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === agentMessageId
                    ? { ...msg, browserPreview: data.browser }
                    : msg,
                ),
              );
            }
          }

          if (data.type === "final") {
            if (isRequestCurrent()) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === agentMessageId
                    ? {
                        ...msg,
                        text:
                          data.output ?? "No Response from AI agent, Try Again",
                        connectCta: data.connectCta || undefined,
                        browserPreview:
                          data.browserPreview || msg.browserPreview,
                      }
                    : msg,
                ),
              );
            }
            stopAgentLoader();

            await saveMessage(
              requestThreadId,
              userEmail ?? "",
              "assistant",
              data.output ?? "No Response from AI agent, Try Again",
              {},
            );
          }

          if (data.type === "schedule_confirmation") {
            if (isRequestCurrent()) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === agentMessageId
                    ? {
                        ...msg,
                        text: data.output ?? "Schedule this task?",
                        scheduleConfirmation: data.scheduleConfirmation,
                        scheduleExecutionId: data.executionId,
                        scheduleStatus: "pending",
                      }
                    : msg,
                ),
              );
            }
            stopAgentLoader();

            const savedScheduleMessage = await saveMessage(
              requestThreadId,
              userEmail ?? "",
              "assistant",
              data.output ?? "Schedule this task?",
              {
                scheduleConfirmation: data.scheduleConfirmation,
                scheduleExecutionId: data.executionId,
                scheduleStatus: "pending",
              },
            );

            if (savedScheduleMessage?.id && isRequestCurrent()) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === agentMessageId
                    ? { ...msg, id: savedScheduleMessage.id }
                    : msg,
                ),
              );
            }
          }

          if (data.type === "clarification") {
            if (isRequestCurrent()) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === agentMessageId
                    ? {
                        ...msg,
                        text:
                          data.output ??
                          "How would you like me to handle this?",
                        clarification: data.clarification,
                      }
                    : msg,
                ),
              );
            }
            stopAgentLoader();

            const savedClarificationMessage = await saveMessage(
              requestThreadId,
              userEmail ?? "",
              "assistant",
              data.output ?? "How would you like me to handle this?",
              {
                clarification: data.clarification,
              },
            );

            if (savedClarificationMessage?.id && isRequestCurrent()) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === agentMessageId
                    ? { ...msg, id: savedClarificationMessage.id }
                    : msg,
                ),
              );
            }
          }

          if (data.type === "error") {
            throw new Error(data.message);
          }
        }
      }

      if (buffer.trim()) {
        const data = JSON.parse(buffer);
        if (data.type === "error") throw new Error(data.message);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to send message";

      if (isRequestCurrent()) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === agentMessageId ? { ...msg, text: errorMessage } : msg,
          ),
        );
      }

      showToast(errorMessage);
    } finally {
      stopAgentLoader();
    }
  };

  const handleSend = async () => {
    const text = inputText.trim();
    await submitPrompt(text);
  };

  const handleClarificationChoice = async (
    messageId: string,
    choice: "immediate" | "recurring",
  ) => {
    const message = messages.find((msg) => msg.id === messageId);
    if (!message?.clarification || isSendingRef.current) return;

    const selectionText = choice === "immediate" ? "Do it now" : "Schedule it";
    await submitPrompt(selectionText, messages);
  };

  const handleOpenConnectLink = async (
    connectUrl: string,
    toolName: string,
  ) => {
    try {
      showToast(`Opening ${toolName} connection...`);
      if (Platform.OS === "web") {
        window.open(connectUrl, "_blank");
      } else {
        await WebBrowser.openAuthSessionAsync(connectUrl);
      }
    } catch (error: any) {
      showToast(error?.message || `Could not open ${toolName} connection`);
    }
  };

  const handleConfirmSchedule = async (messageId: string) => {
    const message = messages.find((msg) => msg.id === messageId);
    if (
      !message?.scheduleConfirmation ||
      message.scheduleStatus !== "pending" ||
      confirmingScheduleIdsRef.current.has(messageId)
    ) {
      return;
    }

    if (!userId) {
      showToast("Please sign in before creating a schedule.");
      return;
    }

    confirmingScheduleIdsRef.current.add(messageId);
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? { ...msg, scheduleStatus: "saving", scheduleError: undefined }
          : msg,
      ),
    );

    try {
      const task = await createScheduledAgentTask(
        userId,
        message.scheduleConfirmation,
        {
          sourceThreadId: threadId,
          executionId: message.scheduleExecutionId,
        },
      );

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                text: "Scheduled.",
                scheduleStatus: "confirmed",
                scheduledTaskId: task.id,
              }
            : msg,
        ),
      );

      showToast("Schedule created");

      try {
        await updateMessage(messageId, "Scheduled.", {
          scheduleConfirmation: message.scheduleConfirmation,
          scheduleStatus: "confirmed",
          scheduledTaskId: task.id,
        });
      } catch (error) {
        logAgentEvent(
          "Confirmation metadata update failed",
          message.scheduleExecutionId || messageId,
          { error: safeErrorMessage(error) },
        );
      }
    } catch (error) {
      const errorMessage = getScheduleCreateErrorMessage(error);

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                scheduleStatus: "failed",
                scheduleError: errorMessage,
              }
            : msg,
        ),
      );

      showToast(errorMessage);
    } finally {
      confirmingScheduleIdsRef.current.delete(messageId);
    }
  };

  const handleCancelSchedule = (messageId: string) => {
    const message = messages.find((msg) => msg.id === messageId);
    if (
      !message?.scheduleConfirmation ||
      message.scheduleStatus !== "pending"
    ) {
      return;
    }

    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? { ...msg, text: "Schedule cancelled.", scheduleStatus: "cancelled" }
          : msg,
      ),
    );

    logAgentEvent(
      "Confirmation cancelled",
      message.scheduleExecutionId || messageId,
      {
        status: "cancelled",
      },
    );

    if (message?.scheduleConfirmation) {
      updateMessage(messageId, "Schedule cancelled.", {
        scheduleConfirmation: message.scheduleConfirmation,
        scheduleStatus: "cancelled",
      }).catch((error: any) => {
        logAgentEvent(
          "Confirmation cancellation metadata update failed",
          message.scheduleExecutionId || messageId,
          { error: safeErrorMessage(error) },
        );
      });
    }
  };

  const handleEditSchedule = (messageId: string) => {
    const message = messages.find((msg) => msg.id === messageId);
    if (
      !message?.scheduleConfirmation ||
      message.scheduleStatus !== "pending"
    ) {
      return;
    }

    logAgentEvent(
      "Confirmation edit requested",
      message.scheduleExecutionId || messageId,
      {
        status: "editing",
      },
    );
    setInputText(message.scheduleConfirmation.originalPrompt);
    handleCancelSchedule(messageId);
    showToast("Edit the request, then send it again.");
  };

  const handleCopy = async (message: string) => {
    if (!message || typeof message !== "string") return;
    try {
      const textToCopy = message.trim();

      if (!textToCopy) {
        showToast("Nothing to copy");
        return;
      }

      await Clipboard.setStringAsync(textToCopy);

      // Verify by reading the clipboard back
      const copiedText = await Clipboard.getStringAsync();

      if (copiedText === textToCopy) {
        showToast("Message copied to clipboard");
      } else {
        showToast("Clipboard verification failed");
      }
    } catch (error) {
      console.error("Clipboard error:", error);
      showToast("Failed to copy message");
    }
  };

  const handleExportChat = async (destination: ChatExportDestination) => {
    if (isExporting) return;
    if (!selectedExportFormat) return;
    if (isLoadingMessages) {
      showToast("Chat messages are still loading.");
      return;
    }

    setIsExporting(true);
    try {
      let exportMessages = messagesRef.current;
      let cursor = olderMessagesCursorRef.current;
      const activeThreadId = threadIdRef.current;
      if (activeThreadId && hasOlderMessages && cursor) {
        let olderMessages: ChatMessage[] = [];
        while (cursor) {
          const page = await loadMessages(activeThreadId, cursor);
          olderMessages = [
            ...mapStoredMessages(page.messages),
            ...olderMessages,
          ];
          cursor = page.hasMore ? page.nextCursor : null;
        }
        exportMessages = [...olderMessages, ...messagesRef.current];
      }

      const snapshot = exportMessages
        .filter((message) => message.text.trim())
        .map(({ id, sender, text, timestamp }) => ({
          id,
          sender,
          text,
          timestamp,
        }));

      if (snapshot.length === 0) {
        showToast("There are no messages to export.");
        return;
      }

      const didExport = await exportChat(
        snapshot,
        threadData?.title || "Muse AI Chat",
        selectedExportFormat,
        destination,
      );
      setSelectedExportFormat(null);
      setIsExportMenuVisible(false);
      if (!didExport) return;
      showToast(
        `${selectedExportFormat === "pdf" ? "PDF" : "Word"} export is ready.`,
      );
    } catch (error) {
      console.error("Chat export failed:", error);
      showToast(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't export chat. Please try again.",
      );
      setSelectedExportFormat(null);
    } finally {
      setIsExporting(false);
    }
  };

  const handleClearCurrentThread = async () => {
    const activeThreadId = threadIdRef.current;
    if (isLoadingMessages || !activeThreadId) {
      throw new Error("Wait for this conversation to finish loading.");
    }

    await clearThreadMessages(activeThreadId);
    historyLoadIdRef.current += 1;
    isLoadingOlderRef.current = false;
    setIsLoadingOlderMessages(false);
    setMessages([]);
    olderMessagesCursorRef.current = null;
    setHasOlderMessages(false);
    shouldAutoScrollRef.current = true;
    showToast("Messages cleared.");
  };

  const handleDeleteCurrentThread = async () => {
    const activeThreadId = threadIdRef.current;
    if (isLoadingMessages || !activeThreadId) {
      throw new Error("Wait for this conversation to finish loading.");
    }
    if (threadData?.type !== "side") {
      throw new Error("The main chat cannot be deleted.");
    }

    await deleteSingleThread(activeThreadId);
    historyLoadIdRef.current += 1;
    isLoadingOlderRef.current = false;
    setIsLoadingOlderMessages(false);
    setMessages([]);
    olderMessagesCursorRef.current = null;
    setHasOlderMessages(false);
    setThreadData(null);
    setThreadId(null);
    setChatHeaderIdentity({ threadId: null, type: "main", title: "Main Chat" });
    router.replace("/(tabs)/chat" as any);
    showToast("Chat deleted.");
  };

  useEffect(() => {
    const unregister = [
      registerChatAction("export", () => setIsExportMenuVisible(true)),
      registerChatAction("clear", handleClearCurrentThread),
      registerChatAction("delete", handleDeleteCurrentThread),
    ];
    return () => unregister.forEach((removeHandler) => removeHandler());
  }, [registerChatAction, isLoadingMessages, threadData, router]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={headerOffset}
    >
      <View style={styles.content}>
        {/* Scrollable Messages Thread */}
        <ScrollView
          ref={scrollViewRef}
          style={styles.scrollArea}
          contentContainerStyle={styles.scrollContent}
          keyboardDismissMode={
            Platform.OS === "ios" ? "interactive" : "on-drag"
          }
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onLayout={({ nativeEvent }) => {
            scrollMetricsRef.current.viewportHeight = nativeEvent.layout.height;
            loadOlderMessagesToFillViewport(
              scrollMetricsRef.current.contentHeight,
            );
          }}
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } =
              nativeEvent;
            scrollMetricsRef.current.offsetY = contentOffset.y;
            scrollMetricsRef.current.contentHeight = contentSize.height;
            scrollMetricsRef.current.viewportHeight = layoutMeasurement.height;
            shouldAutoScrollRef.current =
              contentSize.height - layoutMeasurement.height - contentOffset.y <=
              80;
            if (
              contentOffset.y <= 80 &&
              hasOlderMessages &&
              !isLoadingOlderRef.current
            ) {
              shouldAutoScrollRef.current = false;
              void loadOlderMessages();
            }
          }}
          onContentSizeChange={(_, height) => {
            const anchor = prependScrollAnchorRef.current;
            scrollMetricsRef.current.contentHeight = height;
            if (!anchor) {
              loadOlderMessagesToFillViewport(height);
              return;
            }

            prependScrollAnchorRef.current = null;
            const restoredOffset = Math.max(
              0,
              anchor.offsetY + height - anchor.contentHeight,
            );
            requestAnimationFrame(() => {
              scrollViewRef.current?.scrollTo({
                y: restoredOffset,
                animated: false,
              });
              scrollMetricsRef.current.offsetY = restoredOffset;
              loadOlderMessagesToFillViewport(height);
            });
          }}
          scrollEventThrottle={16}
        >
          <TouchableWithoutFeedback
            onPress={Keyboard.dismiss}
            accessible={false}
          >
            <View style={styles.scrollInner}>
              {/* Messages */}
              {isLoadingMessages ? (
                <ChatHistorySkeleton />
              ) : messages.length === 0 ? (
                <View style={styles.emptyChat}>
                  <Text style={styles.emptyChatText}>
                    Start a conversation with Cooper.
                  </Text>
                </View>
              ) : (
                messages
                  .filter(
                    (message) =>
                      message.text.trim() ||
                      message.connectCta ||
                      message.browserPreview ||
                      message.scheduleConfirmation,
                  )
                  .map((msg, index, visibleMessages) => {
                    const isUser = msg.sender === "user";
                    const previousMessage = visibleMessages[index - 1];
                    const showDateBadge =
                      !previousMessage ||
                      getChatDateKey(previousMessage.createdAt) !==
                        getChatDateKey(msg.createdAt);

                    return (
                      <View key={msg.id}>
                        {showDateBadge ? (
                          <View style={styles.dateBadgeContainer}>
                            <View style={styles.dateBadge}>
                              <Text style={styles.dateBadgeText}>
                                {getChatDateLabel(msg.createdAt)}
                              </Text>
                            </View>
                          </View>
                        ) : null}
                        <TouchableOpacity
                          activeOpacity={0.9}
                          onLongPress={() => handleCopy(msg.text)}
                          onPress={() => showToast(msg.text)}
                          style={[
                            styles.messageRow,
                            isUser
                              ? styles.userMessageRow
                              : styles.agentMessageRow,
                          ]}
                        >
                          <View
                            style={[
                              styles.bubble,
                              isUser ? styles.userBubble : styles.agentBubble,
                            ]}
                          >
                            <LinkifiedText
                              text={msg.text}
                              style={[
                                styles.bubbleText,
                                isUser
                                  ? styles.userBubbleText
                                  : styles.agentBubbleText,
                              ]}
                            />

                            {!isUser && msg.connectCta ? (
                              <View style={styles.connectCard}>
                                <View style={styles.connectIcon}>
                                  <HugeiconsIcon
                                    icon={Link02Icon}
                                    size={20}
                                    color={Colors.primary}
                                    strokeWidth={2}
                                  />
                                </View>
                                <View style={styles.connectBody}>
                                  <Text style={styles.connectTitle}>
                                    Connect {msg.connectCta.toolName}
                                  </Text>
                                  <Text style={styles.connectSubtitle}>
                                    Complete authorization, then send done.
                                  </Text>
                                </View>
                                <TouchableOpacity
                                  style={styles.connectButton}
                                  onPress={() =>
                                    handleOpenConnectLink(
                                      msg.connectCta!.connectUrl,
                                      msg.connectCta!.toolName,
                                    )
                                  }
                                  activeOpacity={0.8}
                                >
                                  <Text style={styles.connectButtonText}>
                                    Connect
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            ) : null}

                            {!isUser && msg.browserPreview ? (
                              <ChatBrowserPreview
                                browserPreview={msg.browserPreview}
                              />
                            ) : null}

                            {!isUser && msg.clarification ? (
                              <View style={styles.clarificationCard}>
                                <Text style={styles.clarificationTitle}>
                                  {msg.clarification.question}
                                </Text>
                                {msg.clarification.choices.map((choice) => (
                                  <TouchableOpacity
                                    key={choice.value}
                                    style={styles.clarificationButton}
                                    onPress={() =>
                                      handleClarificationChoice(
                                        msg.id,
                                        choice.value,
                                      )
                                    }
                                    activeOpacity={0.85}
                                  >
                                    <Text
                                      style={styles.clarificationButtonText}
                                    >
                                      {choice.label}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </View>
                            ) : null}

                            {!isUser &&
                            msg.scheduleConfirmation &&
                            msg.scheduleStatus !== "cancelled" ? (
                              <View style={styles.scheduleCard}>
                                <Text style={styles.scheduleTitle}>
                                  Schedule this task?
                                </Text>
                                <View style={styles.scheduleDetailRow}>
                                  <Text style={styles.scheduleLabel}>Task</Text>
                                  <Text style={styles.scheduleValue}>
                                    {msg.scheduleConfirmation.title}
                                  </Text>
                                </View>
                                <View style={styles.scheduleDetailRow}>
                                  <Text style={styles.scheduleLabel}>When</Text>
                                  <Text style={styles.scheduleValue}>
                                    {formatScheduleRule(
                                      msg.scheduleConfirmation.scheduleRule,
                                    )}
                                  </Text>
                                </View>
                                <View style={styles.scheduleDetailRow}>
                                  <Text style={styles.scheduleLabel}>
                                    Delivery
                                  </Text>
                                  <Text style={styles.scheduleValue}>
                                    {formatDeliveryLabel(
                                      msg.scheduleConfirmation.delivery,
                                    )}
                                  </Text>
                                </View>
                                <Text style={styles.scheduleSummary}>
                                  {msg.scheduleConfirmation.summary}
                                </Text>

                                {msg.scheduleError ? (
                                  <Text style={styles.scheduleError}>
                                    {msg.scheduleError}
                                  </Text>
                                ) : null}

                                <View style={styles.scheduleActions}>
                                  <TouchableOpacity
                                    style={[
                                      styles.scheduleButton,
                                      styles.schedulePrimaryButton,
                                      msg.scheduleStatus !== "pending" &&
                                        styles.scheduleButtonDisabled,
                                    ]}
                                    disabled={msg.scheduleStatus !== "pending"}
                                    onPress={() =>
                                      handleConfirmSchedule(msg.id)
                                    }
                                    activeOpacity={0.8}
                                  >
                                    <Text
                                      style={styles.schedulePrimaryButtonText}
                                    >
                                      {msg.scheduleStatus === "saving"
                                        ? "Saving..."
                                        : msg.scheduleStatus === "confirmed"
                                          ? "Confirmed"
                                          : "Confirm"}
                                    </Text>
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                    style={styles.scheduleButton}
                                    disabled={msg.scheduleStatus !== "pending"}
                                    onPress={() => handleEditSchedule(msg.id)}
                                    activeOpacity={0.8}
                                  >
                                    <Text style={styles.scheduleButtonText}>
                                      Edit
                                    </Text>
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                    style={styles.scheduleButton}
                                    disabled={msg.scheduleStatus !== "pending"}
                                    onPress={() => handleCancelSchedule(msg.id)}
                                    activeOpacity={0.8}
                                  >
                                    <Text style={styles.scheduleButtonText}>
                                      Cancel
                                    </Text>
                                  </TouchableOpacity>
                                </View>
                              </View>
                            ) : null}
                          </View>
                        </TouchableOpacity>
                      </View>
                    );
                  })
              )}

              {isSending && agentActivity ? (
                <AgentActivityIndicator activity={agentActivity} />
              ) : null}
            </View>
          </TouchableWithoutFeedback>
        </ScrollView>

        {isLoadingOlderMessages ? (
          <View
            pointerEvents="none"
            style={styles.olderMessagesLoadingIndicator}
          >
            <ActivityIndicator size="small" color={Colors.iconMuted} />
          </View>
        ) : null}

        {/* Floating Input Pill */}
        <View style={styles.inputWrapper}>
          <View style={styles.inputBar}>
            {/* Plus Attach Button */}
            <TouchableOpacity
              style={styles.circleBtn}
              onPress={() => showToast("Attach file")}
              activeOpacity={0.7}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                size={20}
                color={Colors.iconDark}
                strokeWidth={2.2}
              />
            </TouchableOpacity>

            {/* Prompt Text Input */}
            <TextInput
              style={styles.textInput}
              value={inputText}
              editable={!isLoadingMessages}
              multiline
              onChangeText={setInputText}
              placeholder="Ask Cooper to read emails, send Slack msgs, or schedule meetings..."
              placeholderTextColor={Colors.iconMuted}
              returnKeyType="send"
              onSubmitEditing={handleSend}
            />

            {/* Right Action: Voice or Send */}
            {inputText.trim().length > 0 ? (
              <TouchableOpacity
                style={[styles.circleBtn, styles.sendBtn]}
                disabled={isLoadingMessages || isSending}
                onPress={handleSend}
                activeOpacity={0.8}
              >
                <HugeiconsIcon
                  icon={SentIcon}
                  size={18}
                  color={Colors.white}
                  strokeWidth={2.4}
                />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.circleBtn}
                onPress={() => showToast("Voice input")}
                activeOpacity={0.7}
              >
                <HugeiconsIcon
                  icon={Mic01Icon}
                  size={20}
                  color={Colors.iconDark}
                  strokeWidth={2}
                />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
      <Modal
        visible={isExportMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isExporting) setIsExportMenuVisible(false);
        }}
      >
        <TouchableWithoutFeedback
          onPress={() => {
            if (!isExporting) setIsExportMenuVisible(false);
          }}
        >
          <View style={styles.exportOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.exportDialog}>
                <Text style={styles.exportTitle}>
                  {selectedExportFormat
                    ? `Export ${selectedExportFormat === "pdf" ? "PDF" : "Word"}`
                    : "Export Chat"}
                </Text>
                <Text style={styles.exportDescription}>
                  {isLoadingMessages
                    ? "Loading conversation..."
                    : isExporting
                      ? "Preparing your conversation..."
                      : !messages.some((message) => message.text.trim())
                        ? "There are no messages to export."
                        : selectedExportFormat
                          ? "Choose how you want to export this file."
                          : "Choose a format"}
                </Text>
                {isExporting ? (
                  <View style={styles.exportBusyRow}>
                    <ActivityIndicator color={Colors.primary} />
                    <Text style={styles.exportBusyText}>
                      Preparing{" "}
                      {selectedExportFormat === "pdf" ? "PDF" : "Word document"}
                      ...
                    </Text>
                  </View>
                ) : null}
                {selectedExportFormat ? (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.exportOption,
                        isExporting && styles.exportOptionDisabled,
                      ]}
                      disabled={isExporting}
                      onPress={() => void handleExportChat("share")}
                      activeOpacity={0.75}
                    >
                      <View style={[styles.exportIconBox, styles.shareIconBox]}>
                        <HugeiconsIcon
                          icon={Share01Icon}
                          size={20}
                          color={Colors.info}
                          strokeWidth={1.8}
                        />
                      </View>
                      <View style={styles.exportOptionCopy}>
                        <Text style={styles.exportOptionText}>Share</Text>
                        <Text style={styles.exportOptionHint}>
                          Send to another app
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.exportOption,
                        isExporting && styles.exportOptionDisabled,
                      ]}
                      disabled={isExporting}
                      onPress={() => void handleExportChat("download")}
                      activeOpacity={0.75}
                    >
                      <View
                        style={[styles.exportIconBox, styles.downloadIconBox]}
                      >
                        <HugeiconsIcon
                          icon={Download04Icon}
                          size={20}
                          color={Colors.success}
                          strokeWidth={1.8}
                        />
                      </View>
                      <View style={styles.exportOptionCopy}>
                        <Text style={styles.exportOptionText}>
                          {Platform.OS === "ios"
                            ? "Save / Download"
                            : "Download"}
                        </Text>
                        <Text style={styles.exportOptionHint}>
                          {Platform.OS === "android"
                            ? "Choose a folder on your device"
                            : Platform.OS === "ios"
                              ? "Save to Files from the share sheet"
                              : selectedExportFormat === "pdf"
                                ? "Save from your browser's print dialog"
                                : "Save a .docx file to your device"}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.exportBack}
                      disabled={isExporting}
                      onPress={() => setSelectedExportFormat(null)}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.exportCancelText}>
                        Back to formats
                      </Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.exportOption,
                        (isLoadingMessages ||
                          isExporting ||
                          !messages.some((message) => message.text.trim())) &&
                          styles.exportOptionDisabled,
                      ]}
                      disabled={
                        isLoadingMessages ||
                        isExporting ||
                        !messages.some((message) => message.text.trim())
                      }
                      onPress={() => setSelectedExportFormat("pdf")}
                      activeOpacity={0.75}
                    >
                      <View style={[styles.exportIconBox, styles.pdfIconBox]}>
                        <HugeiconsIcon
                          icon={File01Icon}
                          size={20}
                          color={Colors.error}
                          strokeWidth={1.8}
                        />
                      </View>
                      <View style={styles.exportOptionCopy}>
                        <Text style={styles.exportOptionText}>PDF</Text>
                        <Text style={styles.exportOptionHint}>
                          Portable document
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.exportOption,
                        (isLoadingMessages ||
                          isExporting ||
                          !messages.some((message) => message.text.trim())) &&
                          styles.exportOptionDisabled,
                      ]}
                      disabled={
                        isLoadingMessages ||
                        isExporting ||
                        !messages.some((message) => message.text.trim())
                      }
                      onPress={() => setSelectedExportFormat("docx")}
                      activeOpacity={0.75}
                    >
                      <View style={[styles.exportIconBox, styles.wordIconBox]}>
                        <HugeiconsIcon
                          icon={File01Icon}
                          size={20}
                          color={Colors.primary}
                          strokeWidth={1.8}
                        />
                      </View>
                      <View style={styles.exportOptionCopy}>
                        <Text style={styles.exportOptionText}>
                          Word (.docx)
                        </Text>
                        <Text style={styles.exportOptionHint}>
                          Editable document
                        </Text>
                      </View>
                    </TouchableOpacity>
                  </>
                )}
                <TouchableOpacity
                  style={styles.exportCancel}
                  disabled={isExporting}
                  onPress={() => setIsExportMenuVisible(false)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.exportCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function ChatHistorySkeleton() {
  return (
    <View accessibilityLabel="Loading chat messages">
      <View style={[styles.messageRow, styles.agentMessageRow]}>
        <View
          style={[styles.bubble, styles.agentBubble, styles.skeletonBubble]}
        >
          <View style={[styles.skeletonLine, styles.skeletonLineLong]} />
          <View style={styles.skeletonLine} />
          <View style={[styles.skeletonLine, styles.skeletonLineShort]} />
        </View>
      </View>
      <View style={[styles.messageRow, styles.userMessageRow]}>
        <View
          style={[styles.bubble, styles.userBubble, styles.skeletonUserBubble]}
        />
      </View>
      <View style={[styles.messageRow, styles.agentMessageRow]}>
        <View
          style={[
            styles.bubble,
            styles.agentBubble,
            styles.skeletonShortBubble,
          ]}
        >
          <View style={styles.skeletonLine} />
          <View style={[styles.skeletonLine, styles.skeletonLineShort]} />
        </View>
      </View>
    </View>
  );
}

function isAgentActivityStage(value: unknown): value is AgentActivityStage {
  return (
    value === "understanding_request" ||
    value === "opening_source" ||
    value === "searching_web" ||
    value === "reading_results" ||
    value === "inspecting_details" ||
    value === "comparing_options" ||
    value === "typing_in_page" ||
    value === "clicking_page" ||
    value === "scrolling_page" ||
    value === "browsing_web" ||
    value === "using_connected_tools" ||
    value === "using_email" ||
    value === "using_calendar" ||
    value === "using_slack" ||
    value === "processing_results" ||
    value === "preparing_response"
  );
}

const agentActivityLabels: Record<AgentActivityStage, string> = {
  thinking: "Thinking",
  understanding_request: "Understanding your request",
  opening_source: "Opening source",
  searching_web: "Searching the web",
  reading_results: "Reading results",
  inspecting_details: "Inspecting details",
  comparing_options: "Comparing options",
  typing_in_page: "Typing in page",
  clicking_page: "Clicking",
  scrolling_page: "Scrolling",
  browsing_web: "Browsing the web",
  using_connected_tools: "Working with connected tools",
  using_email: "Working with your email",
  using_calendar: "Working with your calendar",
  using_slack: "Working with Slack",
  processing_results: "Working with your results",
  preparing_response: "Preparing your response",
};

function AgentActivityIndicator({
  activity,
}: {
  activity: NonNullable<AgentActivity>;
}) {
  const statusOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const transition = Animated.sequence([
      Animated.timing(statusOpacity, {
        toValue: 0.45,
        duration: 90,
        useNativeDriver: true,
      }),
      Animated.timing(statusOpacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]);

    transition.start();
    return () => transition.stop();
  }, [activity.current, statusOpacity]);

  return (
    <View style={[styles.messageRow, styles.agentMessageRow]}>
      <View style={[styles.bubble, styles.agentBubble, styles.activityBubble]}>
        {activity.completed.map((stage, index) => (
          <View key={`${stage}-${index}`} style={styles.activityCompletedRow}>
            <View style={styles.activityCompletedDot} />
            <Text style={styles.activityCompletedText}>
              {agentActivityLabels[stage]}
            </Text>
          </View>
        ))}
        <Animated.View
          style={[styles.activityCurrentRow, { opacity: statusOpacity }]}
        >
          <ActivityIndicator size="small" color={Colors.iconMuted} />
          <Text style={styles.activityText}>
            {activity.detail || agentActivityLabels[activity.current]}
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}

function formatDeliveryLabel(delivery?: string | null) {
  return (
    (delivery || "chat")
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Chat"
  );
}

function getScheduleCreateErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    return [
      typeof record.message === "string"
        ? record.message
        : "Could not create schedule",
      typeof record.details === "string" ? record.details : null,
      typeof record.hint === "string" ? `Hint: ${record.hint}` : null,
      typeof record.code === "string" ? `Code: ${record.code}` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return "Could not create schedule";
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.white,
  },
  exportOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(15, 23, 42, 0.4)",
  },
  exportDialog: {
    width: "100%",
    maxWidth: 360,
    padding: 20,
    borderRadius: 14,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  exportTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  exportDescription: {
    marginTop: 6,
    marginBottom: 10,
    fontSize: 13,
    color: Colors.textSecondary,
  },
  exportBusyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  exportBusyText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 13,
  },
  exportOption: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  exportIconBox: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
  },
  pdfIconBox: {
    backgroundColor: Colors.errorLight,
  },
  wordIconBox: {
    backgroundColor: Colors.primarySubtle,
  },
  shareIconBox: {
    backgroundColor: Colors.infoLight,
  },
  downloadIconBox: {
    backgroundColor: Colors.successLight,
  },
  exportOptionCopy: {
    flex: 1,
    paddingVertical: 9,
  },
  exportOptionDisabled: {
    opacity: 0.5,
  },
  exportOptionText: {
    color: Colors.textPrimary,
    fontSize: 15,
    fontWeight: "600",
  },
  exportOptionHint: {
    marginTop: 2,
    color: Colors.textSecondary,
    fontSize: 12,
  },
  exportBack: {
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  exportCancel: {
    minHeight: 42,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 8,
  },
  exportCancelText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  content: {
    flex: 1,
    justifyContent: "space-between",
  },
  scrollArea: {
    flex: 1,
  },
  olderMessagesLoadingIndicator: {
    position: "absolute",
    top: 10,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    flexGrow: 1,
  },
  scrollInner: {
    flexGrow: 1,
  },
  emptyChat: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  emptyChatText: {
    color: Colors.textSecondary,
    fontSize: 15,
  },
  dateBadgeContainer: {
    alignItems: "center",
    marginVertical: 14,
  },
  dateBadge: {
    backgroundColor: Colors.dateBadgeBg,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
  },
  dateBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.dateBadgeText,
  },
  messageRow: {
    marginBottom: 12,
    width: "100%",
    flexDirection: "row",
  },
  userMessageRow: {
    justifyContent: "flex-end",
  },
  agentMessageRow: {
    justifyContent: "flex-start",
  },
  bubble: {
    maxWidth: "85%",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
  },
  userBubble: {
    backgroundColor: Colors.chatBubbleUser,
    borderBottomRightRadius: 6,
  },
  agentBubble: {
    backgroundColor: Colors.chatBubbleAi,
    borderBottomLeftRadius: 6,
  },
  skeletonBubble: {
    width: "72%",
    gap: 8,
  },
  skeletonShortBubble: {
    width: "52%",
    gap: 8,
  },
  skeletonUserBubble: {
    width: "58%",
    height: 52,
    opacity: 0.5,
  },
  skeletonLine: {
    height: 9,
    width: "78%",
    borderRadius: 5,
    backgroundColor: Colors.border,
  },
  skeletonLineLong: {
    width: "92%",
  },
  skeletonLineShort: {
    width: "56%",
  },
  activityBubble: {
    gap: 8,
  },
  activityCompletedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  activityCompletedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.success,
  },
  activityCompletedText: {
    color: Colors.textMuted,
    fontSize: 12,
  },
  activityCurrentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  activityText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  bubbleText: {
    fontSize: 15.5,
    lineHeight: 22,
    letterSpacing: -0.1,
  },
  userBubbleText: {
    color: Colors.chatBubbleUserText,
    fontWeight: "500",
  },
  agentBubbleText: {
    color: Colors.iconDark,
    fontWeight: "400",
  },
  inputWrapper: {
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === "ios" ? 12 : 10,
    paddingTop: 6,
    backgroundColor: Colors.white,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.inputBarBg,
    borderRadius: 26,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.inputBarBorder,
  },
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtn: {
    backgroundColor: Colors.iconDark,
  },
  textInput: {
    flex: 1,
    maxHeight: 112,
    fontSize: 14.5,
    color: Colors.iconDark,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 8 : 4,
  },
  connectCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    flexDirection: "row",
    alignItems: "center",
  },
  connectIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primarySubtle,
    marginRight: 10,
  },
  connectBody: {
    flex: 1,
    marginRight: 10,
  },
  connectTitle: {
    fontSize: 13.5,
    fontWeight: "700",
    color: Colors.iconDark,
  },
  connectSubtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  connectButton: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  connectButtonText: {
    color: Colors.white,
    fontSize: 12.5,
    fontWeight: "700",
  },
  clarificationCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    gap: 8,
  },
  clarificationTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: Colors.iconDark,
    marginBottom: 4,
  },
  clarificationButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.primarySubtle,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  clarificationButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.iconDark,
  },
  scheduleCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  scheduleTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: Colors.iconDark,
    marginBottom: 10,
  },
  scheduleDetailRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  scheduleLabel: {
    width: 64,
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  scheduleValue: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.iconDark,
  },
  scheduleSummary: {
    fontSize: 12.5,
    lineHeight: 18,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  scheduleError: {
    fontSize: 12.5,
    lineHeight: 18,
    color: Colors.error,
    marginTop: 8,
  },
  scheduleActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  scheduleButton: {
    minHeight: 34,
    borderRadius: 10,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  schedulePrimaryButton: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary,
  },
  scheduleButtonDisabled: {
    opacity: 0.65,
  },
  scheduleButtonText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: Colors.iconDark,
  },
  schedulePrimaryButtonText: {
    fontSize: 12.5,
    fontWeight: "800",
    color: Colors.white,
  },
});
