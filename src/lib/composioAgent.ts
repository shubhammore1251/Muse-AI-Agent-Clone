import {
    createExecutionId,
    logAgentEvent,
    safeErrorMessage,
} from "@/lib/agentLogger";
import {
    BrowserResearchPlan,
    formatBrowserPlanForAgent,
} from "@/lib/browserResearchPlanner";
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

async function getPinnedConnectedAccounts(
  composio: any,
  userId: string,
  executionId: string,
) {
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
    logAgentEvent("Connected-account lookup failed", executionId, {
      source: "composio",
      error: safeErrorMessage(error),
    });
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
    logAgentEvent("Connected-account lookup failed", executionId, {
      source: "supabase_connection_registry",
      error: safeErrorMessage(error),
    });
  }

  return connectedAccounts;
}

function getConnectionSignature(connectedAccounts: Record<string, string[]>) {
  return Object.entries(connectedAccounts)
    .map(([toolkit, ids]) => `${toolkit}:${[...ids].sort().join(",")}`)
    .sort()
    .join("|");
}

async function getUserComposioSession(userId: string, executionId: string) {
  const composio = getComposioAgentClient();
  const connectedAccounts = await getPinnedConnectedAccounts(
    composio,
    userId,
    executionId,
  );
  logAgentEvent("Connected accounts loaded", executionId, {
    integrations: Object.keys(connectedAccounts).sort().join(",") || "none",
  });
  const connectionSignature = getConnectionSignature(connectedAccounts);
  const existingSession = composioSessionIds.get(userId);

  if (existingSession?.connectionSignature === connectionSignature) {
    try {
      return await composio.use(existingSession.sessionId);
    } catch (error) {
      logAgentEvent("Composio session reuse failed", executionId, {
        error: safeErrorMessage(error),
      });
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

export async function createCooperAgentForUser(
  userId: string,
  executionId = createExecutionId(),
  browserPlan?: BrowserResearchPlan,
) {
  let composioTools: any[];
  try {
    composioTools = userId
      ? await (await getUserComposioSession(userId, executionId)).tools()
      : [];
  } catch (error) {
    logAgentEvent("Tool registry load failed", executionId, {
      error: safeErrorMessage(error),
    });
    throw error;
  }
  logAgentEvent("Tool registry loaded", executionId, {
    composio_tools: composioTools.length,
    browser_tools: 5,
  });

  const browserPlanInstructions = browserPlan
    ? `\n\nBROWSER RESEARCH PLAN (execute this plan; it is not a user-facing answer):\n${formatBrowserPlanForAgent(browserPlan)}\n\n` +
      "Use the plan's sources and focused searchQueries instead of searching the whole original request verbatim. Start one Browserbase session and immediately navigate its single tab to the first relevant source before using browser_read. Execute focused queries using the site's search/filter controls or a suitable search URL; do not paste the whole request as one query. When the plan selects multiple sources or compares options, navigate sequentially in the same tab and gather observed page evidence from at least two distinct sources where accessible. Use one browser_action per action and inspect the resulting page with browser_read before proceeding. If a page is loading, wait briefly using a browser action and inspect again. Dismiss only nonessential cookie-consent banners when needed; do not accept signups or account terms. Verify that interactions changed the page; if not, inspect and try one reasonable alternate action or source. Collect only facts observed on pages, retain actual source URLs for citations, and compare using the listed criteria when applicable. Continue until the completionCriteria are met or the remaining limitations block progress. Do not invent results or claim a source was checked when it was not. Never log in, bypass CAPTCHA, commit a booking, or pay. If evidence is unavailable, say so and explain which source or constraint could not be verified."
    : "";

  return new Agent({
    name: "Cooper",
    instructions:
      "You are Cooper, a personal AI assistant inside Muse AI. " +
      "Use Browserbase browser tools when the user asks you to visit, open, search, inspect, or interact with a website, or when the answer depends on current website content, product availability, prices, login pages, forms, booking, checkout, or browser automation. " +
      "For browser tasks, call create_browser_session once, then immediately call browser_navigate to open its requested source and inspect it with browser_read. Reuse that session and tab for every later source and action. Opening a page is not complete unless the user only asked to open it. " +
      "For predictable clicks, typing, form fills, selection, scrolling, or key presses, use browser_action with actionType and value; pass a known CSS selector, or omit it so Stagehand observe() can identify the element. Use semantic browser_action instructions without actionType when the interaction is ambiguous and Stagehand act() self-healing is needed. " +
      "Do not call close_browser yourself; the chat server pauses Browserbase sessions after the final answer is sent. " +
      "If login blocks progress, ask the user to log in in the live browser, keep the session open, and do not ask for passwords. " +
      "Use Composio tools for connected app workflows such as email, calendar, Slack, Notion, or other workspace data. " +
      "If a Composio tool requires a connection, share exactly one Composio Connect Link and briefly say what it connects. " +
      "Before creating, updating, sending, deleting, or otherwise changing data, ask for confirmation and wait for the user. " +
      "For read-only requests, use tools directly and return a clean, structured answer instead of raw JSON. " +
      "For normal questions, writing, brainstorming, explanations, or content the user already provided, answer directly without using tools. " +
      "Never expose Browserbase session IDs, websocket URLs, debugger URLs, preview URLs, API keys, or internal tool details." +
      browserPlanInstructions,
    model: process.env.OPENAI_AGENT_MODEL || "gpt-5-nano",
    tools: [
      ...composioTools,
      createBrowserbaseSessionTool(executionId),
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
