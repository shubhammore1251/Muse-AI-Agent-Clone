import {
  createCooperAgentForUser,
  mapMessages,
  parseToolOutput,
} from "@/lib/composioAgent";
import { validateUserFromRequest } from "@/lib/composioBackend";
import { parseScheduleIntentWithAgent } from "@/lib/scheduleIntentAgent";
import { closeBrowserSessions } from "@/services/tools/BrowserbaseSession";
import { run } from "@openai/agents";

export async function POST(req: Request) {
  let reqBody: any = {};
  try {
    reqBody = await req.json();
  } catch {
    reqBody = {};
  }

  const { messages = [], timezone } = reqBody;

  let activeUserId: string | null = null;
  try {
    const userAuth = await validateUserFromRequest(req, reqBody.userId);
    activeUserId = userAuth.userId;
  } catch {
    activeUserId = reqBody.userId || null;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
      };

      const browserSessionIds = new Set<string>();
      let loginRequired = false;

      try {
        const latestUserMessage = [...messages]
          .reverse()
          .find(
            (message: any) =>
              message?.sender === "user" && typeof message?.text === "string",
          );
        const scheduleConfirmation = latestUserMessage
          ? await parseScheduleIntentWithAgent({
              text: latestUserMessage.text,
              timezone,
            })
          : null;

        if (scheduleConfirmation) {
          send({
            type: "schedule_confirmation",
            output: "Schedule this task?",
            scheduleConfirmation,
          });
          return;
        }

        const agent = await createCooperAgentForUser(activeUserId || "");
        const result = await run(agent, mapMessages(messages), {
          stream: true,
          maxTurns: 30,
        });

        for await (const event of result) {
          if (
            event.type !== "run_item_stream_event" ||
            event.name !== "tool_output"
          ) {
            continue;
          }

          const output = parseToolOutput((event.item as any).output);

          if (
            output?.type === "browser_session" &&
            typeof output.sessionId === "string"
          ) {
            browserSessionIds.add(output.sessionId);
            send({
              type: "browser",
              browser: output,
            });
          }

          if (
            output?.type === "close_browser_result" &&
            typeof output.sessionId === "string"
          ) {
            browserSessionIds.delete(output.sessionId);
          }

          if (output?.status === "login_required") {
            loginRequired = true;
          }
        }

        await result.completed;

        const output = result.finalOutput ?? "";

        const connectCta = extractConnectCta(output);
        send({
          type: "final",
          output: connectCta ? cleanConnectLinkFromOutput(output) : output,
          connectCta,
        });
      } catch (error) {
        console.error("[chat+api] Composio agent error:", error);
        send({
          type: "error",
          message: getAgentErrorMessage(error),
        });
      } finally {
        if (!loginRequired && browserSessionIds.size > 0) {
          try {
            await closeBrowserSessions(browserSessionIds);
          } catch (closeError) {
            console.error(
              "[chat+api] Browserbase session pause failed:",
              closeError,
            );
          }
        }

        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}

function getAgentErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return `Agent failed: ${error.message}`;
  }

  return "Agent failed";
}

function extractConnectCta(output: string) {
  const urlMatch = output.match(
    /https:\/\/connect\.composio\.dev\/link\/[A-Za-z0-9_-]+/,
  );
  if (!urlMatch) return undefined;

  const toolMatch =
    output.match(/connect\s+([A-Za-z0-9 ]+)\s+here/i) ||
    output.match(/connect\s+([A-Za-z0-9 ]+)/i);

  const toolName = toolMatch?.[1]?.trim().replace(/\s+/g, " ") || "Tool";

  return {
    toolName,
    connectUrl: urlMatch[0],
  };
}

function cleanConnectLinkFromOutput(output: string) {
  return output
    .replace(
      /\*\*\[Connect [^\]]+\]\(https:\/\/connect\.composio\.dev\/link\/[A-Za-z0-9_-]+\)\*\*/gi,
      "",
    )
    .replace(
      /\[Connect [^\]]+\]\(https:\/\/connect\.composio\.dev\/link\/[A-Za-z0-9_-]+\)/gi,
      "",
    )
    .replace(/https:\/\/connect\.composio\.dev\/link\/[A-Za-z0-9_-]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
