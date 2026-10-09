import { getSupabaseAdminClient } from "@/lib/composioBackend";
import {
    browserActionTool,
    browserNavigateTool,
    browserReadTool,
    closeBrowserTool,
    createBrowserbaseSessionTool,
} from "@/services/tools/BrowserbaseSession";
import { ChatMessage } from "@/types";
import { Composio } from "@composio/core";
import { OpenAIAgentsProvider } from "@composio/openai-agents";
import { Agent, AgentInputItem, run } from "@openai/agents";

type StoredComposioSession = {
  sessionId: string;
  connectionSignature: string;
};

const composioSessionIds = new Map<string, StoredComposioSession>();

function getComposioAgentClient() {
  return new Composio({
    provider: new OpenAIAgentsProvider(),
  });
}

async function getPinnedConnectedAccounts(composio: any, userId: string) {
  const connectedAccounts: Record<string, string[]> = {};

  try {
    const activeAccounts = await composio.connectedAccounts.list({
      userIds: [userId],
      statuses: ["ACTIVE" as any],
    });

    for (const account of activeAccounts?.items || []) {
      const toolkitSlug = account.toolkit?.slug?.toLowerCase();
      if (toolkitSlug && account.id) {
        const existing = connectedAccounts[toolkitSlug] || [];
        if (!existing.includes(account.id)) {
          connectedAccounts[toolkitSlug] = [...existing, account.id];
        }
      }
    }
  } catch (error) {
    console.warn(
      "[composioAgent] Failed to list active Composio accounts:",
      error,
    );
  }

  try {
    const supabase = getSupabaseAdminClient();
    const { data: rows } = await supabase
      .from("user_tool_connections")
      .select("composio_connected_account_id, tools!inner(toolkit_slug, slug)")
      .eq("user_id", userId)
      .eq("status", "connected")
      .not("composio_connected_account_id", "is", null);

    for (const row of (rows as any[]) || []) {
      const accountId = row.composio_connected_account_id;
      const tool = Array.isArray(row.tools) ? row.tools[0] : row.tools;
      const toolkitSlug = (
        tool?.toolkit_slug ||
        tool?.slug ||
        ""
      ).toLowerCase();
      if (!accountId || !toolkitSlug) continue;

      const existing = connectedAccounts[toolkitSlug] || [];
      if (!existing.includes(accountId)) {
        connectedAccounts[toolkitSlug] = [...existing, accountId];
      }
    }
  } catch (error) {
    console.warn(
      "[composioAgent] Failed to read stored tool connections:",
      error,
    );
  }

  return connectedAccounts;
}

function getConnectionSignature(connectedAccounts: Record<string, string[]>) {
  return Object.entries(connectedAccounts)
    .map(([toolkit, ids]) => `${toolkit}:${[...ids].sort().join(",")}`)
    .sort()
    .join("|");
}

async function getUserComposioSession(userId: string) {
  const composio = getComposioAgentClient();
  const connectedAccounts = await getPinnedConnectedAccounts(composio, userId);
  const connectionSignature = getConnectionSignature(connectedAccounts);
  const existingSession = composioSessionIds.get(userId);

  if (existingSession?.connectionSignature === connectionSignature) {
    try {
      return await composio.use(existingSession.sessionId);
    } catch (error) {
      console.warn("[composioAgent] Failed to reuse Composio session:", error);
      composioSessionIds.delete(userId);
    }
  }

  const session = await composio.create(userId, {
    connectedAccounts,
    multiAccount: {
      enable: true,
      maxAccountsPerToolkit: 5,
      requireExplicitSelection: false,
    },
    manageConnections: true,
  });
  composioSessionIds.set(userId, {
    sessionId: session.sessionId,
    connectionSignature,
  });
  return session;
}

export async function createCooperAgentForUser(userId: string) {
  const composioTools = userId
    ? await (await getUserComposioSession(userId)).tools()
    : [];

  return new Agent({
    name: "Cooper",
    instructions:
      "You are Cooper, a personal AI assistant inside Muse AI. " +
      "Use Browserbase browser tools when the user asks you to visit, open, search, inspect, or interact with a website, or when the answer depends on current website content, product availability, prices, login pages, forms, booking, checkout, or browser automation. " +
      "For browser tasks, call create_browser_session once, inspect the page with browser_read, then continue with browser_action or browser_navigate until the original user goal is complete. Opening a page is not complete unless the user only asked to open it. " +
      "Do not call close_browser yourself; the chat server pauses Browserbase sessions after the final answer is sent. " +
      "If login blocks progress, ask the user to log in in the live browser, keep the session open, and do not ask for passwords. " +
      "Use Composio tools for connected app workflows such as email, calendar, Slack, Notion, or other workspace data. " +
      "If a Composio tool requires a connection, share exactly one Composio Connect Link and briefly say what it connects. " +
      "Before creating, updating, sending, deleting, or otherwise changing data, ask for confirmation and wait for the user. " +
      "For read-only requests, use tools directly and return a clean, structured answer instead of raw JSON. " +
      "For normal questions, writing, brainstorming, explanations, or content the user already provided, answer directly without using tools. " +
      "Never expose Browserbase session IDs, websocket URLs, debugger URLs, preview URLs, API keys, or internal tool details.",
    model: process.env.OPENAI_AGENT_MODEL || "gpt-5-nano",
    tools: [
      ...composioTools,
      createBrowserbaseSessionTool,
      browserNavigateTool,
      browserActionTool,
      browserReadTool,
      closeBrowserTool,
    ],
  });
}

export async function runComposioAgentForUser({
  userId,
  messages,
}: {
  userId: string;
  messages: ChatMessage[];
}) {
  const agent = await createCooperAgentForUser(userId);

  const result = await run(agent, mapMessages(messages), {
    maxTurns: 30,
  });

  return {
    output: result.finalOutput ?? "",
    browserPreview: extractBrowserPreview(result.newItems),
  };
}

function extractBrowserPreview(newItems: any[]) {
  for (const item of newItems) {
    if (item?.type !== "tool_call_output_item") continue;

    const output = parseToolOutput(item.output);
    if (output?.type === "browser_session" && output.status === "ready") {
      return output;
    }
  }

  return undefined;
}

export function parseToolOutput(output: unknown) {
  if (!output) return undefined;

  if (typeof output === "string") {
    try {
      return JSON.parse(output);
    } catch {
      return undefined;
    }
  }

  if (typeof output === "object") {
    return output as any;
  }

  return undefined;
}

export function mapMessages(messages: ChatMessage[]): AgentInputItem[] {
  return messages.map((message) =>
    message.sender === "agent"
      ? {
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: message.text,
            },
          ],
        }
      : {
          role: "user",
          content: message.text,
        },
  ) as AgentInputItem[];
}
