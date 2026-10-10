/**
 * MascotAvatar Component
 *
 * Simple 3D character mascot avatar portrait.
 */

import { Colors } from "@/constants/colors";
import React from "react";
import {
  Image,
  ImageStyle,
  StyleProp,
  StyleSheet,
  Text,
  View,
} from "react-native";

export interface MascotAvatarProps {
  /** Avatar diameter in pixels (defaults to 54) */
  size?: number;
  /** Emoji avatar icon, or 'cooper' to render the original mascot image */
  icon?: string;
  /** Accent color for emoji avatar backgrounds */
  color?: string;
  /** Optional custom image style */
  style?: StyleProp<ImageStyle>;
}

export const MascotAvatar: React.FC<MascotAvatarProps> = ({
  size = 54,
  icon = "cooper",
  color = Colors.primary,
  style,
}) => {
  if (icon !== "cooper") {
    return (
      <View
        style={[
          styles.emojiAvatar,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: `${color}18`,
            borderColor: color,
          },
          style as any,
        ]}
      >
        <Text style={[styles.emojiText, { fontSize: Math.round(size * 0.52) }]}>
          {icon}
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={require("../../../assets/images/cooper_mascot.jpg")}
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
        style,
      ]}
      resizeMode="cover"
    />
  );
};

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: Colors.avatarPreviewBg,
  },
  emojiAvatar: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
  emojiText: {
    textAlign: "center",
    includeFontPadding: false,
    lineHeight: undefined,
  },
});

export default MascotAvatar;
