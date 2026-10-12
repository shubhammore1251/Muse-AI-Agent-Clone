import { Colors } from "@/constants/colors";
import * as Linking from "expo-linking";
import { useMemo } from "react";
import { StyleProp, Text, TextStyle } from "react-native";

type LinkifiedTextProps = {
  text: string;
  style?: StyleProp<TextStyle>;
};

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:]$/;
const CLOSING_BRACKETS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function getUrlEnd(value: string, start: number, end: number) {
  let candidate = value.slice(start, end);

  while (candidate && TRAILING_PUNCTUATION.test(candidate)) {
    candidate = candidate.slice(0, -1);
  }

  while (candidate) {
    const closingBracket = candidate.at(-1);
    const openingBracket = closingBracket
      ? CLOSING_BRACKETS[closingBracket]
      : undefined;

    if (!closingBracket || !openingBracket) break;

    const openingCount = [...candidate].filter(
      (character) => character === openingBracket,
    ).length;
    const closingCount = [...candidate].filter(
      (character) => character === closingBracket,
    ).length;

    if (closingCount <= openingCount) break;
    candidate = candidate.slice(0, -1);
  }

  return candidate;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

export function LinkifiedText({ text, style }: LinkifiedTextProps) {
  const segments = useMemo(() => {
    const result: Array<{ text: string; url?: string }> = [];
    let lastIndex = 0;

    for (const match of text.matchAll(HTTP_URL_PATTERN)) {
      const matchText = match[0];
      const start = match.index;
      const url = getUrlEnd(text, start, start + matchText.length);

      if (!url || !isHttpUrl(url)) continue;

      if (start > lastIndex) {
        result.push({ text: text.slice(lastIndex, start) });
      }
      result.push({ text: url, url });
      lastIndex = start + url.length;
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) });
    }

    return result.length > 0 ? result : [{ text }];
  }, [text]);

  return (
    <Text style={style}>
      {segments.map((segment, index) =>
        segment.url ? (
          <Text
            key={`${index}-${segment.url}`}
            accessibilityRole="link"
            onPress={(event) => {
              event.stopPropagation();
              void Linking.openURL(segment.url!).catch(() => undefined);
            }}
            style={{ color: Colors.textLink, textDecorationLine: "underline" }}
          >
            {segment.text}
          </Text>
        ) : (
          <Text key={index}>{segment.text}</Text>
        ),
      )}
    </Text>
  );
}
