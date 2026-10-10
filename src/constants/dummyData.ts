/**
 * Muse AI Clone - Mock Data Datasets
 *
 * Centralized initial state mocks for:
 * 1. Chat conversation messages & Cooper AI responses
 * 2. Sidebar drawer chat sessions & side topics
 * 3. Pre-built prompt idea templates for one-tap agent execution
 * 4. Scheduled autonomous goals and background tasks
 * 5. Account plan limits and third-party workspace connectors
 */

import {
  AiNewsItem,
  ChatMessage,
  ConnectorItem,
  IdeaItem,
  PlanData,
  SideChatItem,
  TaskGoalItem,
} from "@/types";

// Re-export all types for convenience
export * from "@/types";

/**
 * Initial seed messages presented when opening the main chat screen.
 */
export const INITIAL_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: "msg-1",
    sender: "user",
    text: "I want to start a health goal",
    timestamp: "3:35 PM",
  },
  {
    id: "msg-2",
    sender: "agent",
    text: "I'd love to help with that. In your own words, what would this health goal be about — what's the change you'd want to see?",
    timestamp: "3:35 PM",
  },
];

/**
 * Mock side conversations displayed in the sliding sidebar drawer.
 */
export const SIDE_CHATS: SideChatItem[] = [
  {
    id: "side-1",
    title: "Creative story after college fight",
    hasUnreadDot: false,
  },
  {
    id: "side-2",
    title: "Greet and start conversation",
    hasUnreadDot: false,
  },
  {
    id: "side-3",
    title: "Start a health goal",
    hasUnreadDot: false,
  },
  {
    id: "side-4",
    title: "Start a productivity goal",
    hasUnreadDot: true,
  },
  {
    id: "side-5",
    title: "Start an interests goal",
    hasUnreadDot: true,
  },
];

/**
 * Dummy AI news stories displayed in the Feed tab.
 */
export const AI_NEWS_ITEMS: AiNewsItem[] = [
  {
    id: "ai-news-1",
    source: "Muse Brief",
    category: "Research",
    title: "New reasoning models focus on longer autonomous task chains",
    summary:
      "Labs are testing agents that can plan, inspect tool results, and recover from failed steps across multi-hour workflows.",
    timeAgo: "12 min ago",
    readTime: "3 min read",
  },
  {
    id: "ai-news-2",
    source: "Builder Weekly",
    category: "Tools",
    title: "Agent app builders add browser, calendar, and workspace actions",
    summary:
      "The newest developer kits make it easier for assistants to complete practical jobs across tabs, files, and connected services.",
    timeAgo: "38 min ago",
    readTime: "4 min read",
  },
  {
    id: "ai-news-3",
    source: "Model Watch",
    category: "Product",
    title: "Voice companions are moving from chat mode into daily routines",
    summary:
      "Consumer AI apps are pairing conversational memory with reminders, habit check-ins, and lightweight personal automation.",
    timeAgo: "1 hr ago",
    readTime: "2 min read",
  },
  {
    id: "ai-news-4",
    source: "Policy Radar",
    category: "Policy",
    title: "AI safety teams publish fresh guidance for agent permissions",
    summary:
      "New recommendations emphasize scoped access, visible approval moments, and logs for assistants that can act on behalf of users.",
    timeAgo: "2 hrs ago",
    readTime: "5 min read",
  },
  {
    id: "ai-news-5",
    source: "Startup Signal",
    category: "Funding",
    title: "Automation startups see renewed investor demand",
    summary:
      "Teams building vertical agents for sales, support, and operations are attracting attention as businesses look for measurable AI output.",
    timeAgo: "Today",
    readTime: "3 min read",
  },
];

/**
 * Curated idea templates presented on the Ideas tab.
 */
export const IDEA_ITEMS: IdeaItem[] = [
  {
    id: "idea-1",
    icon: "🏆",
    title: "I can build your AI Builder Cup entry package",
    description:
      "I can research the AI Builder Cup JAPAC's current rules and judging criteria, then build your submission package around a solo-buildable agentic app: an entry draft, demo script, and deadline checklist. It is listed with...",
    prompt:
      "Help me build my AI Builder Cup entry package. Research the rules and build a submission draft, demo script, and checklist.",
  },
  {
    id: "idea-2",
    icon: "🗂️",
    title: "I can keep your money-making apps leaderboard",
    description:
      "I can turn the money-making apps from your X timeline scan into a living leaderboard, with each app's name, link, and earnings figure tagged claimed or verified. New apps you spot get added to the same list, so you never hav...",
    prompt:
      "Create a living leaderboard of top money-making apps from my X timeline scan, tracking names, links, and verified earnings.",
  },
  {
    id: "idea-3",
    icon: "📹",
    title: "Turn your next app build into a Shorts series",
    description:
      "Share your next app build, and I can map it onto YouTube's 2026 Shorts Series, AI Shorts editing, and real-time dubbing: episode breakdowns, per-episode hooks, and shoot-ready scripts. You stop figuring out how to s...",
    prompt:
      "Turn my app build into a YouTube Shorts series. Break it down into episodes with hooks and shoot-ready scripts.",
  },
  {
    id: "idea-4",
    icon: "🚀",
    title: "I can build your launch post and assets",
    description:
      "I can track the launch sources you pick and draft launch copy, screenshot mockups, and community responses.",
    prompt:
      "Draft my product launch copy, headline variations, and Product Hunt announcement strategy.",
  },
];

/**
 * Pre-configured scheduled agent check-ins displayed in Tasks tab.
 */
export const TASK_GOALS: TaskGoalItem[] = [
  {
    id: "task-1",
    title: "Morning Health & Workout Check-in",
    schedule: "Every day @ 8:00 AM",
    status: "active",
    runsCount: 28,
  },
  {
    id: "task-2",
    title: "Evening Reflection & Habit Log",
    schedule: "Every day @ 9:00 PM",
    status: "active",
    runsCount: 34,
  },
  {
    id: "task-3",
    title: "Weekly Focus Sprint Review",
    schedule: "Every Sunday @ 6:00 PM",
    status: "active",
    runsCount: 8,
  },
];

/**
 * Account usage stats and quota reset schedule displayed on Settings tab.
 */
export const SETTINGS_PLAN_DATA: PlanData = {
  planName: "Free plan",
  percentUsed: 11,
  resetText: "Weekly limit resets on Oct 2",
  creditsUsed: 110,
  creditsTotal: 1000,
  remainingCredits: 890,
};

/**
 * Pre-configured third-party tools with connection state in Settings.
 */
export const SETTINGS_CONNECTORS: ConnectorItem[] = [
  {
    id: "conn-1",
    name: "Google Workspace",
    description: "Gmail, Calendar events & Google Drive sync",
    iconBg: "#4285F4",
    connected: true,
    category: "Productivity",
    accountEmail: "rahul.s@gmail.com",
  },
  {
    id: "conn-2",
    name: "Notion",
    description: "Automate databases, docs, and habit trackers",
    iconBg: "#000000",
    connected: true,
    category: "Workspace",
    accountEmail: "rahul.notion.so",
  },
  {
    id: "conn-3",
    name: "GitHub",
    description: "Pull request reviews, issue triage & commits",
    iconBg: "#24292E",
    connected: true,
    category: "Developer",
    accountEmail: "github.com/rahulsana",
  },
  {
    id: "conn-4",
    name: "Slack",
    description: "Channel agent summary & urgent notifications",
    iconBg: "#4A154B",
    connected: true,
    category: "Messaging",
    accountEmail: "Team Workspace",
  },
  {
    id: "conn-5",
    name: "Linear",
    description: "Track issues, sprint cycles and product roadmap",
    iconBg: "#5E6AD2",
    connected: false,
    category: "Developer",
  },
  {
    id: "conn-6",
    name: "Figma",
    description: "Inspect design tokens, frame comments & assets",
    iconBg: "#F24E1E",
    connected: false,
    category: "Design",
  },
  {
    id: "conn-7",
    name: "X (Twitter)",
    description: "Scan timelines, trends, and post drafts",
    iconBg: "#1DA1F2",
    connected: false,
    category: "Social",
  },
];
