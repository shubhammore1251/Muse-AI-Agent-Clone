/**
 * AppHeader Component
 *
 * Sticky top navigation bar featuring:
 * - Left: Circular 2-line drawer menu trigger with active notification blue dot
 * - Center: Cooper 3D mascot avatar with interactive floating name pill
 * - Right: Circular 3-dots action sheet menu button
 */

import { Colors } from "@/constants/colors";
import {
  MenuTwoLineIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import React from "react";
import {
  LayoutChangeEvent,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MascotAvatar from "./MascotAvatar";

export interface AppHeaderProps {
  /** Active agent display name (defaults to 'Cooper') */
  agentName?: string;
  /** Mascot emblem icon key or 'cooper' */
  mascotIcon?: string;
  /** Accent aura color */
  mascotColor?: string;
  /** Current thread label, such as Main Chat or a side-chat title */
  chatContextLabel?: string;
  /** Whether the current thread is a side chat */
  chatContextIsSide?: boolean;
  /** Reports the rendered header height for keyboard positioning */
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Callback to open the left sliding session drawer */
  onOpenSidebar: () => void;
  /** Callback to trigger the right 3-dots actions menu */
  onOpenSettings: () => void;
  /** Callback triggered when tapping the center mascot/name pill */
  onMascotPress?: () => void;
}

/**
 * Global Top Header with 3D Mascot and Action Triggers
 */
export const AppHeader: React.FC<AppHeaderProps> = ({
  agentName = "Cooper",
  mascotIcon = "cooper",
  mascotColor = Colors.primary,
  chatContextLabel = "Main Chat",
  chatContextIsSide = false,
  onLayout,
  onOpenSidebar,
  onOpenSettings,
  onMascotPress,
}) => {
  return (
    <View style={styles.headerContainer} onLayout={onLayout}>
      {/* Left Action: Circular White Button with 2 lines and Blue Status Dot */}
      <View style={styles.sideCol}>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={onOpenSidebar}
          activeOpacity={0.7}
          accessibilityLabel="Open sidebar and drawer"
          accessibilityRole="button"
        >
          <HugeiconsIcon
            icon={MenuTwoLineIcon}
            size={22}
            color={Colors.iconDark}
            strokeWidth={2.2}
          />
          {/* Blue status / notification indicator dot */}
          <View style={styles.blueDot} />
        </TouchableOpacity>
      </View>

      {/* Center: 3D Mascot Character with Floating 'Cooper' Name Capsule Below */}
      <TouchableOpacity
        style={styles.centerCol}
        onPress={onMascotPress || onOpenSettings}
        activeOpacity={0.85}
        accessibilityLabel={`${agentName} profile`}
        accessibilityRole="button"
      >
        <View style={styles.mascotContainer}>
          <MascotAvatar size={54} icon={mascotIcon} color={mascotColor} />
        </View>

        {/* Floating Capsule Name Pill */}
        <View style={styles.nameCapsule}>
          <Text style={styles.agentNameText}>{agentName}</Text>
          <View style={styles.nameCapsuleDivider} />
          <View
            style={styles.chatContextBadge}
            accessibilityLabel={chatContextLabel}
          >
            <View
              style={[
                styles.chatContextDot,
                chatContextIsSide
                  ? styles.sideChatContextDot
                  : styles.mainChatContextDot,
              ]}
            />
            <Text
              style={styles.chatContextText}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {chatContextLabel}
            </Text>
          </View>
        </View>
      </TouchableOpacity>

      {/* Right Action: Circular White Button with 3 Horizontal Dots */}
      <View style={[styles.sideCol, styles.rightCol]}>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={onOpenSettings}
          activeOpacity={0.7}
          accessibilityLabel="Agent settings and options"
          accessibilityRole="button"
        >
          <HugeiconsIcon
            icon={MoreHorizontalIcon}
            size={24}
            color={Colors.iconDark}
            strokeWidth={2.2}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  headerContainer: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 6,
    backgroundColor: Colors.white,
    zIndex: 10,
  },
  sideCol: {
    width: 48,
    alignItems: "flex-start",
    paddingTop: 4,
  },
  rightCol: {
    alignItems: "flex-end",
  },
  circleBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.white,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    ...Platform.select({
      ios: {
        shadowColor: Colors.black,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.08,
        shadowRadius: 8,
      },
      android: {
        elevation: 3,
      },
      web: {
        boxShadow: "0 3px 12px rgba(0, 0, 0, 0.07)",
      },
    }),
  },
  blueDot: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.statusBlue,
    borderWidth: 1.5,
    borderColor: Colors.white,
  },
  centerCol: {
    maxWidth: "62%",
    flexShrink: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  mascotContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  nameCapsule: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.white,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    marginTop: 4,
    ...Platform.select({
      ios: {
        shadowColor: Colors.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.07,
        shadowRadius: 6,
      },
      android: {
        elevation: 2,
      },
      web: {
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.06)",
      },
    }),
  },
  agentNameText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.iconDark,
    letterSpacing: -0.2,
  },
  nameCapsuleDivider: {
    width: 1,
    height: 14,
    marginHorizontal: 7,
    backgroundColor: Colors.border,
  },
  chatContextBadge: {
    maxWidth: "58%",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  chatContextDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  mainChatContextDot: {
    backgroundColor: Colors.primary,
  },
  sideChatContextDot: {
    backgroundColor: Colors.success,
  },
  chatContextText: {
    flexShrink: 1,
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
});

export default AppHeader;
