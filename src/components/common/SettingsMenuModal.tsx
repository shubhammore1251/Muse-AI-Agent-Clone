/**
 * SettingsMenuModal Component
 *
 * Floating dropdown action sheet anchored to the top-right 3-dots header button.
 * Provides quick actions:
 * 1. Edit Mascot & Avatar
 * 2. Rename Agent
 * 3. Export / Share Chat
 * 4. Clear Messages
 * 5. Delete Chat Session (Destructive)
 */

import { Colors } from "@/constants/colors";
import { showToast } from "@/context/ToastContext";
import {
  Delete02Icon,
  Edit01Icon,
  RefreshIcon,
  Share01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export interface SettingsMenuModalProps {
  /** Visibility state of the dropdown overlay */
  visible: boolean;
  /** Callback fired to close the dropdown menu */
  onClose: () => void;
  /** Callback to launch the agent customization modal */
  onEditAvatar: () => void;
  /** Callback to launch agent rename */
  onRename: () => void;
  /** Callback to reset conversation messages */
  onClearChat: () => Promise<void>;
  /** Destructive callback to wipe active session */
  onDeleteChat: () => Promise<void>;
  /** Callback to export or share conversation transcript */
  onShareChat: () => void;
  /** Whether the current route is the Chat tab */
  showChatManagement: boolean;
  /** Main chat threads cannot be deleted */
  isMainChat: boolean;
}

/**
 * Top-Right 3-Dots Action Sheet Dropdown
 */
export const SettingsMenuModal: React.FC<SettingsMenuModalProps> = ({
  visible,
  onClose,
  onEditAvatar,
  onRename,
  onClearChat,
  onDeleteChat,
  onShareChat,
  showChatManagement,
  isMainChat,
}) => {
  const insets = useSafeAreaInsets();
  const [confirmation, setConfirmation] = useState<"clear" | "delete" | null>(
    null,
  );
  const [isWorking, setIsWorking] = useState(false);

  const closeMenu = () => {
    if (isWorking) return;
    setConfirmation(null);
    onClose();
  };

  const confirmAction = async () => {
    if (!confirmation || isWorking) return;
    setIsWorking(true);
    try {
      if (confirmation === "clear") await onClearChat();
      else await onDeleteChat();
      setConfirmation(null);
      onClose();
    } catch (error) {
      console.error("Chat management action failed:", error);
      showToast(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't complete this action. Please try again.",
      );
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={closeMenu}
    >
      <TouchableWithoutFeedback onPress={closeMenu}>
        <View
          style={[
            styles.overlay,
            {
              paddingTop:
                Math.max(insets.top, 12) + (Platform.OS === "web" ? 54 : 50),
            },
          ]}
        >
          <TouchableWithoutFeedback>
            <View
              style={
                confirmation ? styles.confirmationCard : styles.dropdownCard
              }
            >
              {confirmation ? (
                <>
                  <Text style={styles.confirmationTitle}>
                    {confirmation === "clear"
                      ? "Clear messages?"
                      : "Delete chat?"}
                  </Text>
                  <Text style={styles.confirmationDescription}>
                    {confirmation === "clear"
                      ? "This removes messages from this conversation. The chat itself will remain."
                      : "This permanently deletes this conversation and its messages."}
                  </Text>
                  <View style={styles.confirmationActions}>
                    <TouchableOpacity
                      style={[styles.confirmationButton, styles.cancelButton]}
                      disabled={isWorking}
                      onPress={() => setConfirmation(null)}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.confirmationButton, styles.dangerButton]}
                      disabled={isWorking}
                      onPress={() => void confirmAction()}
                      activeOpacity={0.75}
                    >
                      {isWorking ? (
                        <ActivityIndicator color={Colors.white} size="small" />
                      ) : (
                        <Text style={styles.confirmButtonText}>
                          {confirmation === "clear" ? "Clear" : "Delete"}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  {/* 1. Edit Mascot & Avatar */}
                  <TouchableOpacity
                    style={styles.menuItem}
                    onPress={() => {
                      showToast("Edit Mascot & Avatar");
                      onClose();
                      onEditAvatar();
                    }}
                    activeOpacity={0.7}
                  >
                    <HugeiconsIcon
                      icon={SparklesIcon}
                      size={18}
                      color={Colors.iconDark}
                      strokeWidth={1.8}
                    />
                    <Text style={styles.itemText}>Edit Mascot & Avatar</Text>
                  </TouchableOpacity>

                  {/* 2. Rename Agent / Chat */}
                  <TouchableOpacity
                    style={styles.menuItem}
                    onPress={() => {
                      showToast("Rename Agent");
                      onClose();
                      onRename();
                    }}
                    activeOpacity={0.7}
                  >
                    <HugeiconsIcon
                      icon={Edit01Icon}
                      size={18}
                      color={Colors.iconDark}
                      strokeWidth={1.8}
                    />
                    <Text style={styles.itemText}>Rename Agent</Text>
                  </TouchableOpacity>

                  {showChatManagement ? (
                    <>
                      {/* 3. Export Conversation */}
                      <TouchableOpacity
                        style={styles.menuItem}
                        onPress={() => {
                          onClose();
                          onShareChat();
                        }}
                        activeOpacity={0.7}
                      >
                        <HugeiconsIcon
                          icon={Share01Icon}
                          size={18}
                          color={Colors.iconDark}
                          strokeWidth={1.8}
                        />
                        <Text style={styles.itemText}>Export Chat</Text>
                      </TouchableOpacity>

                      {/* 4. Clear Messages */}
                      <TouchableOpacity
                        style={styles.menuItem}
                        onPress={() => {
                          setConfirmation("clear");
                        }}
                        activeOpacity={0.7}
                      >
                        <HugeiconsIcon
                          icon={RefreshIcon}
                          size={18}
                          color={Colors.iconDark}
                          strokeWidth={1.8}
                        />
                        <Text style={styles.itemText}>Clear Messages</Text>
                      </TouchableOpacity>

                      {!isMainChat ? <View style={styles.divider} /> : null}

                      {/* 5. Delete Chat (Destructive) */}
                      {!isMainChat ? (
                        <TouchableOpacity
                          style={[styles.menuItem, styles.dangerItem]}
                          onPress={() => setConfirmation("delete")}
                          activeOpacity={0.7}
                        >
                          <HugeiconsIcon
                            icon={Delete02Icon}
                            size={18}
                            color={Colors.error}
                            strokeWidth={1.8}
                          />
                          <Text style={[styles.itemText, styles.dangerText]}>
                            Delete Chat
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.08)",
    justifyContent: "flex-start",
    alignItems: "flex-end",
    paddingTop: Platform.OS === "ios" ? 64 : 56,
    paddingRight: 16,
  },
  dropdownCard: {
    width: 200,
    backgroundColor: Colors.white,
    borderRadius: 14,
    paddingVertical: 6,
    paddingHorizontal: 5,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Platform.select({
      ios: {
        shadowColor: Colors.black,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
      },
      android: {
        elevation: 8,
      },
      web: {
        boxShadow:
          "0 8px 24px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.04)",
      },
    }),
  },
  confirmationCard: {
    width: 290,
    backgroundColor: Colors.white,
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Platform.select({
      ios: {
        shadowColor: Colors.black,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
      },
      android: { elevation: 8 },
      web: {
        boxShadow:
          "0 8px 24px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.04)",
      },
    }),
  },
  confirmationTitle: {
    color: Colors.textPrimary,
    fontSize: 17,
    fontWeight: "700",
  },
  confirmationDescription: {
    marginTop: 7,
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  confirmationActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 18,
  },
  confirmationButton: {
    flex: 1,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
  },
  cancelButton: {
    backgroundColor: Colors.surfaceMuted,
  },
  dangerButton: {
    backgroundColor: Colors.error,
  },
  cancelButtonText: {
    color: Colors.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  confirmButtonText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: "700",
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 9,
    gap: 10,
  },
  dangerItem: {
    marginTop: 1,
  },
  itemText: {
    fontSize: 13.5,
    fontWeight: "500",
    color: Colors.textPrimary,
    letterSpacing: -0.2,
  },
  dangerText: {
    color: Colors.error,
    fontWeight: "500",
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginVertical: 4,
    marginHorizontal: 6,
  },
});

export default SettingsMenuModal;
