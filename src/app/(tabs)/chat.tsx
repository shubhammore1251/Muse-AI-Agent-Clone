/**
 * Chat Tab Screen ('/(tabs)/chat')
 *
 * Minimalist, clean conversational companion UI:
 * - Scrollable message thread
 * - Floating prompt bar (+ attachment, input box, voice mic, send action)
 * - Simple on-click Toast triggers
 */

import { Colors } from "@/constants/colors";
import { INITIAL_CHAT_MESSAGES } from "@/constants/dummyData";
import { showToast } from "@/context/ToastContext";
import { getApiUrl } from "@/lib/services";
import { ChatMessage } from "@/types";
import { Add01Icon, Mic01Icon, SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import axios from "axios";
import { useEffect, useRef, useState } from "react";
import {
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
  const [messages, setMessages] = useState<ChatMessage[]>(
    INITIAL_CHAT_MESSAGES,
  );
  const [inputText, setInputText] = useState("");
  const scrollViewRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();

  const [isSending, setIsSending] = useState(false);

  // Calculate header height offset for iOS KeyboardAvoidingView (SafeAreaView top + AppHeader height)
  const headerOffset = Platform.OS === "ios" ? insets.top + 98 : 0;

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

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

  // console.log("OpenAI key exists:", !!process.env.OPENAI_API_KEY);

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
    showToast("Message sent");

    try {
      const ApiUrl = getApiUrl("/chat");
      console.log("Sending message to API", ApiUrl);
      const result = await axios.post(ApiUrl, {
        messages: [...messages, userMsg],
      });

      const data = result.data;
      console.log("API response", data);

      const agentMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        sender: "agent",
        text: data?.output ?? "No response from AI, try again",
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      };

      setMessages((prev) => [...prev, agentMsg]);
    } catch (e) {
      console.log("Error sending message", e);
      showToast("Error sending message");
    } finally {
      setIsSending(false);
    }
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
                    activeOpacity={0.8}
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
                  Cooper is typing...
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
              placeholder="Message in Start a health goal"
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
    backgroundColor: "#F3F4F6",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
  },
  dateBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
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
    maxWidth: "82%",
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
    color: "#3B2318",
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
    backgroundColor: "#F3F4F6",
    borderRadius: 26,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#ECEEF0",
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
    fontSize: 15,
    color: Colors.iconDark,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 8 : 4,
  },
});
