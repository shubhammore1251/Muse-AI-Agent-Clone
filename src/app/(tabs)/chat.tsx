/**
 * Chat Tab Screen ('/(tabs)/chat')
 *
 * Minimalist, clean conversational companion UI:
 * - Scrollable message thread
 * - Composio-powered assistant responses
 */

import { ChatBrowserPreview } from "@/components/common/ChatBrowserPreview";
import { Colors } from "@/constants/colors";
import { showToast } from "@/context/ToastContext";
import {
  createScheduledAgentTask,
  formatScheduleRule,
} from "@/lib/scheduledTasks";
import { getApiUrl } from "@/lib/services";
import { supabase } from "@/lib/supabase";
import {
  CreateNewThread,
  getThread,
  loadMessages,
  saveMessage,
  updateMessage,
} from "@/services/chatHistory";
import { ChatMessage } from "@/types";
import {
  Add01Icon,
  Link02Icon,
  Mic01Icon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
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

export default function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const scrollViewRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const [isSending, setIsSending] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadData, setThreadData] = useState<any>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const { sideChatThreadId } = useLocalSearchParams();

  useEffect(() => {
    if (sideChatThreadId) {
      setThreadId(sideChatThreadId as string);
    }
  }, [sideChatThreadId]);

  // Calculate header height offset for iOS KeyboardAvoidingView
  const headerOffset = Platform.OS === "ios" ? insets.top + 98 : 0;

  useEffect(() => {
    const loadUser = async () => {
      const data = await supabase.auth.getSession();
      const email = data?.data?.session?.user?.email;
      const uid = data?.data?.session?.user?.id;
      setUserEmail(email ?? null);
      setUserId(uid ?? null);
    };
    loadUser();
  }, []);

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  useEffect(() => {
    userEmail && GetThreadData();
    threadId && userEmail && getChatHistory();
  }, [threadId, userEmail]);

  const getChatHistory = async () => {
    const messages = await loadMessages(threadId ?? "");
    const MappedMessages = messages?.map((msg: any) => ({
      id: msg.id,
      sender: msg.role === "user" ? "user" : "agent",
      text: msg.content,
      timestamp: new Date(msg.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      scheduleConfirmation: msg.metadata?.scheduleConfirmation,
      scheduleStatus: msg.metadata?.scheduleStatus,
      scheduledTaskId: msg.metadata?.scheduledTaskId,
      scheduleError: msg.metadata?.scheduleError,
    })) as ChatMessage[];

    setMessages(MappedMessages ?? []);
  };

  const GetThreadData = async () => {
    if (!threadId) {
      let Thread = await getThread(threadId ?? "", userEmail ?? "");
      if (!Thread) {
        Thread = await CreateNewThread(userEmail ?? "", "main", "Main Chat");
      }
      setThreadData(Thread);
      setThreadId(Thread?.id ?? null);
    }
  };

  // Scroll to bottom when keyboard appears
  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const sub = Keyboard.addListener(showEvent, () => {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    });
    return () => sub.remove();
  }, []);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text) return;

    setIsSending(true);

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: "user",
      text,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText("");

    await saveMessage(threadId ?? "", userEmail ?? "", "user", text, {});

    const agentMessageId = `msg-${Date.now() + 1}`;

    try {
      const ApiUrl = getApiUrl("/chat");

      const response = await fetch(ApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [...messages, userMsg],
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

      // Add placeholder message immediately
      setMessages((prev) => [
        ...prev,
        {
          id: agentMessageId,
          sender: "agent",
          text: "Thinking...",
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      ]);

      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, {
          stream: true,
        });

        const lines = buffer.split("\n");

        // Keep unfinished line
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          const data = JSON.parse(line);

          if (data.type === "browser") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === agentMessageId
                  ? {
                      ...msg,
                      browserPreview: data.browser,
                    }
                  : msg,
              ),
            );
          }

          if (data.type === "final") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === agentMessageId
                  ? {
                      ...msg,
                      text:
                        data.output ?? "No Response from AI agent, Try Again",
                      connectCta: data.connectCta || undefined,
                      browserPreview: data.browserPreview || msg.browserPreview,
                    }
                  : msg,
              ),
            );

            await saveMessage(
              threadId ?? "",
              userEmail ?? "",
              "assistant",
              data.output ?? "No Response from AI agent, Try Again",
              {},
            );
          }

          if (data.type === "schedule_confirmation") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === agentMessageId
                  ? {
                      ...msg,
                      text: data.output ?? "Schedule this task?",
                      scheduleConfirmation: data.scheduleConfirmation,
                      scheduleStatus: "pending",
                    }
                  : msg,
              ),
            );

            const savedScheduleMessage = await saveMessage(
              threadId ?? "",
              userEmail ?? "",
              "assistant",
              data.output ?? "Schedule this task?",
              {
                scheduleConfirmation: data.scheduleConfirmation,
                scheduleStatus: "pending",
              },
            );

            if (savedScheduleMessage?.id) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === agentMessageId
                    ? { ...msg, id: savedScheduleMessage.id }
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
    } catch (error) {
      console.error("Error sending message:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to send message";

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === agentMessageId
            ? {
                ...msg,
                text: errorMessage,
              }
            : msg,
        ),
      );

      showToast(errorMessage);
    } finally {
      setIsSending(false);
    }
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
    if (!message?.scheduleConfirmation) return;

    if (!userId) {
      showToast("Please sign in before creating a schedule.");
      return;
    }

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

      await updateMessage(messageId, "Scheduled.", {
        scheduleConfirmation: message.scheduleConfirmation,
        scheduleStatus: "confirmed",
        scheduledTaskId: task.id,
      });

      showToast("Schedule created");
    } catch (error) {
      console.error("Failed to create schedule:", error);
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
    }
  };

  const handleCancelSchedule = (messageId: string) => {
    const message = messages.find((msg) => msg.id === messageId);

    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? { ...msg, text: "Schedule cancelled.", scheduleStatus: "cancelled" }
          : msg,
      ),
    );

    if (message?.scheduleConfirmation) {
      updateMessage(messageId, "Schedule cancelled.", {
        scheduleConfirmation: message.scheduleConfirmation,
        scheduleStatus: "cancelled",
      }).catch((error: any) => {
        console.error("Failed to persist schedule cancellation:", error);
      });
    }
  };

  const handleEditSchedule = (messageId: string) => {
    const message = messages.find((msg) => msg.id === messageId);
    if (!message?.scheduleConfirmation) return;

    setInputText(message.scheduleConfirmation.originalPrompt);
    handleCancelSchedule(messageId);
    showToast("Edit the request, then send it again.");
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
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
        >
          <TouchableWithoutFeedback
            onPress={Keyboard.dismiss}
            accessible={false}
          >
            <View style={styles.scrollInner}>
              {/* Centered Date Badge */}
              <View style={styles.dateBadgeContainer}>
                <View style={styles.dateBadge}>
                  <Text style={styles.dateBadgeText}>Today</Text>
                </View>
              </View>

              {/* Messages */}
              {messages.map((msg) => {
                const isUser = msg.sender === "user";
                return (
                  <TouchableOpacity
                    key={msg.id}
                    activeOpacity={0.9}
                    onPress={() => showToast(msg.text)}
                    style={[
                      styles.messageRow,
                      isUser ? styles.userMessageRow : styles.agentMessageRow,
                    ]}
                  >
                    <View
                      style={[
                        styles.bubble,
                        isUser ? styles.userBubble : styles.agentBubble,
                      ]}
                    >
                      <Text
                        style={[
                          styles.bubbleText,
                          isUser
                            ? styles.userBubbleText
                            : styles.agentBubbleText,
                        ]}
                      >
                        {msg.text}
                      </Text>

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

                      {!isUser && msg.scheduleConfirmation ? (
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
                            <Text style={styles.scheduleLabel}>Delivery</Text>
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
                              onPress={() => handleConfirmSchedule(msg.id)}
                              activeOpacity={0.8}
                            >
                              <Text style={styles.schedulePrimaryButtonText}>
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
                );
              })}

              {isSending && (
                <Text
                  style={{
                    fontStyle: "italic",
                    color: Colors.iconMuted,
                    textAlign: "left",
                    marginTop: 8,
                  }}
                >
                  <ActivityIndicator /> AI is typing...
                </Text>
              )}
            </View>
          </TouchableWithoutFeedback>
        </ScrollView>

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
              onChangeText={setInputText}
              onFocus={() => {
                setTimeout(() => {
                  scrollViewRef.current?.scrollToEnd({ animated: true });
                }, 100);
              }}
              placeholder="Ask Cooper to read emails, send Slack msgs, or schedule meetings..."
              placeholderTextColor={Colors.iconMuted}
              returnKeyType="send"
              onSubmitEditing={handleSend}
            />

            {/* Right Action: Voice or Send */}
            {inputText.trim().length > 0 ? (
              <TouchableOpacity
                style={[styles.circleBtn, styles.sendBtn]}
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
    </KeyboardAvoidingView>
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
  content: {
    flex: 1,
    justifyContent: "space-between",
  },
  scrollArea: {
    flex: 1,
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
