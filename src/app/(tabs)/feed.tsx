/**
 * Feed Tab Screen ('/(tabs)/feed')
 *
 * Minimalist AI news feed with dummy stories.
 */

import { Colors } from "@/constants/colors";
import { AI_NEWS_ITEMS } from "@/constants/dummyData";
import { showToast } from "@/context/ToastContext";
import { AiNewsItem } from "@/types";
import {
  AiBrain02Icon,
  AiSearch01Icon,
  AiWebBrowsingIcon,
  ChartIncreaseIcon,
  NewsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const categoryMeta: Record<
  AiNewsItem["category"],
  {
    icon: typeof AiBrain02Icon;
    backgroundColor: string;
    color: string;
  }
> = {
  Research: {
    icon: AiBrain02Icon,
    backgroundColor: Colors.primarySubtle,
    color: Colors.primary,
  },
  Product: {
    icon: AiWebBrowsingIcon,
    backgroundColor: Colors.infoLight,
    color: Colors.info,
  },
  Policy: {
    icon: NewsIcon,
    backgroundColor: Colors.surfaceMuted,
    color: Colors.textSecondary,
  },
  Funding: {
    icon: ChartIncreaseIcon,
    backgroundColor: Colors.successLight,
    color: Colors.success,
  },
  Tools: {
    icon: AiSearch01Icon,
    backgroundColor: Colors.warningLight,
    color: Colors.warning,
  },
};

type NewsCategory = keyof typeof categoryMeta;

export default function FeedScreen() {
  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleWrapper}>
          <Text style={styles.pageTitle}>AI Feed</Text>
          <Text style={styles.pageSubtitle}>
            Fresh dummy updates for Cooper to track.
          </Text>
        </View>

        <View style={styles.featuredCard}>
          <View style={styles.featuredIcon}>
            <HugeiconsIcon
              icon={AiBrain02Icon}
              size={22}
              color={Colors.primary}
              strokeWidth={2}
            />
          </View>
          <View style={styles.featuredText}>
            <Text style={styles.featuredLabel}>Today&apos;s signal</Text>
            <Text style={styles.featuredTitle}>
              Agentic AI is shifting toward useful daily workflows
            </Text>
          </View>
        </View>

        {AI_NEWS_ITEMS.map((item: any, index: number) => {
          const category: NewsCategory =
            item.category in categoryMeta
              ? (item.category as NewsCategory)
              : "Research";

          const meta = categoryMeta[category];

          return (
            <View key={item.id}>
              <TouchableOpacity
                style={styles.newsRow}
                onPress={() => showToast(item.title)}
                activeOpacity={0.75}
              >
                <View
                  style={[
                    styles.iconContainer,
                    { backgroundColor: meta.backgroundColor },
                  ]}
                >
                  <HugeiconsIcon
                    icon={meta.icon}
                    size={20}
                    color={meta.color}
                    strokeWidth={2}
                  />
                </View>

                <View style={styles.textContainer}>
                  <View style={styles.metaRow}>
                    <Text style={styles.sourceText}>{item.source}</Text>
                    <Text style={styles.metaDot}>•</Text>
                    <Text style={styles.timeText}>{item.timeAgo}</Text>
                  </View>

                  <Text style={styles.newsTitle}>{item.title}</Text>
                  <Text style={styles.newsSummary} numberOfLines={3}>
                    {item.summary}
                  </Text>

                  <View style={styles.footerRow}>
                    <View
                      style={[
                        styles.categoryChip,
                        { backgroundColor: meta.backgroundColor },
                      ]}
                    >
                      <Text
                        style={[styles.categoryText, { color: meta.color }]}
                      >
                        {item.category}
                      </Text>
                    </View>
                    <Text style={styles.readTime}>{item.readTime}</Text>
                  </View>
                </View>
              </TouchableOpacity>

              {index < AI_NEWS_ITEMS.length - 1 && (
                <View style={styles.divider} />
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.white,
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  titleWrapper: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 14,
  },
  pageTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: Colors.iconDark,
    letterSpacing: -0.5,
  },
  pageSubtitle: {
    marginTop: 4,
    fontSize: 14,
    lineHeight: 20,
    color: Colors.textSecondary,
    fontWeight: "500",
  },
  featuredCard: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 20,
    marginBottom: 10,
    padding: 14,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: 12,
  },
  featuredIcon: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primarySubtle,
  },
  featuredText: {
    flex: 1,
  },
  featuredLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: Colors.primary,
    textTransform: "uppercase",
  },
  featuredTitle: {
    marginTop: 3,
    fontSize: 14.5,
    lineHeight: 20,
    fontWeight: "700",
    color: Colors.iconDark,
  },
  newsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 18,
    gap: 14,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  textContainer: {
    flex: 1,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 5,
  },
  sourceText: {
    fontSize: 12,
    fontWeight: "800",
    color: Colors.textSecondary,
  },
  metaDot: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  timeText: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textMuted,
  },
  newsTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.iconDark,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  newsSummary: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: "400",
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 11,
  },
  categoryChip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
  },
  categoryText: {
    fontSize: 11,
    fontWeight: "800",
  },
  readTime: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: "600",
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginHorizontal: 20,
  },
});
