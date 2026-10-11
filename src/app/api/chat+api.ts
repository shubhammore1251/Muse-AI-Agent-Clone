import {
  createCooperAgentForUser,
  mapMessages,
  parseToolOutput,
} from "@/lib/composioAgent";
import { validateUserFromRequest } from "@/lib/composioBackend";
import {
  classifyUserIntent,
  parseScheduleIntentWithAgent,
} from "@/lib/scheduleIntentAgent";
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
        send({ type: "activity", activity: "understanding_request" });
        const latestUserMessage = [...messages]
          .reverse()
          .find(
            (message: any) =>
              message?.sender === "user" && typeof message?.text === "string",
          );

        const latestClarification = [...messages]
          .reverse()
          .find(
            (message: any) =>
              message?.sender === "assistant" &&
              message?.clarification &&
              typeof message?.clarification?.originalRequest === "string",
          );

        const followUpIntent = latestUserMessage
          ? classifyUserIntent(latestUserMessage.text)
          : null;
        const resolvedRequestText =
          latestClarification &&
          followUpIntent &&
          followUpIntent.intent === "clarification_follow_up"
            ? latestClarification.clarification.originalRequest
            : latestUserMessage?.text || "";

        const intent = classifyUserIntent(resolvedRequestText);

        if (intent.intent === "clarification_required") {
          send({
            type: "clarification",
            output:
              "How would you like me to handle this?\n\nDo it now\nSchedule it",
            clarification: {
              question: "How would you like me to handle this?",
              originalRequest: resolvedRequestText,
              choices: [
                { label: "Do it now", value: "immediate" },
                { label: "Schedule it", value: "recurring" },
              ],
            },
          });
          return;
        }

        const scheduleConfirmation =
          intent.intent === "recurring_task"
            ? await parseScheduleIntentWithAgent({
                text: resolvedRequestText,
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
          if (event.type !== "run_item_stream_event") continue;

          if (event.name === "tool_called") {
            const toolName = (event.item as any)?.rawItem?.name;
            send({
              type: "activity",
              activity: getToolActivityStage(toolName),
            });
            continue;
          }

          if (event.name === "message_output_created") {
            const phase = (event.item as any)?.rawItem?.phase;
            if (phase !== "commentary") {
              send({ type: "activity", activity: "preparing_response" });
            }
            continue;
          }

          if (event.name !== "tool_output") continue;

          send({ type: "activity", activity: "processing_results" });

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

function getToolActivityStage(toolName: unknown) {
  if (typeof toolName !== "string") return "using_connected_tools";

  const normalizedName = toolName.toLowerCase();
  if (/browser|web[_-]?search|search[_-]?web/.test(normalizedName)) {
    return "browsing_web";
  }
  if (/gmail|outlook|email|mail/.test(normalizedName)) return "using_email";
  if (/calendar/.test(normalizedName)) return "using_calendar";
  if (/slack/.test(normalizedName)) return "using_slack";
  return "using_connected_tools";
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
