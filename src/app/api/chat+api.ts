// import {
//   createCooperAgentForUser,
//   mapMessages,
//   parseToolOutput,
// } from '@/lib/composioAgent';
import {
  createCooperAgentForUser,
  mapMessages,
  parseToolOutput,
} from "@/lib/composioAgent";
import { validateUserFromRequest } from "@/lib/composioBackend";
import { parseScheduleIntentWithAgent } from "@/lib/scheduleIntentAgent";

import { closeBrowserSessions } from "@/services/tools/BrowserbaseSession";
import { ChatMessage } from "@/types";
import { run } from "@openai/agents";

type ChatRequestBody = {
  messages: ChatMessage[];
};

console.log("OPENAI KEY AVAILABLE:", !!process.env.OPENAI_API_KEY);

export async function POST(req: Request) {
  let reqBody: any = {};

  try {
    reqBody = await req.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON request body" },
      { status: 400 },
    );
  }

  const { messages = [], timezone } = reqBody;

  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json(
      { error: "messages must be a non-empty array" },
      { status: 400 },
    );
  }

  let activeUserId: string | null = null;

  try {
    const userAuth = await validateUserFromRequest(req);
    activeUserId = userAuth.userId;
  } catch (error) {
    console.error("[chat+api] User validation failed:", error);
    return Response.json(
      { error: "Unauthorized. Please sign in again." },
      { status: 401 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
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

        // Use the user-specific agent and the existing
        // browser-compatible message mapper.
        const agent = await createCooperAgentForUser(activeUserId || "");

        console.log("[chat+api] Starting agent:", {
          messageCount: messages.length,
        });

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

        console.log("[chat+api] Agent completed:", {
          outputLength: output.length,
        });
      } catch (error) {
        console.error("[chat+api] Agent error:", error);

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
              "[chat+api] Browser session cleanup failed:",
              closeError,
            );
          }
        }

        try {
          controller.close();
        } catch {
          // The client may have already closed the stream.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

// const MapAgentInput = (messages: ChatMessage[]): AgentInputItem[] => {
//   return messages.map((message: ChatMessage) => {
//     if (message.sender === "agent") {
//       return {
//         role: "assistant",
//         status: "completed",
//         content: [
//           {
//             type: "output_text",
//             text: message.text,
//           },
//         ],
//       };
//     }
//     return {
//       role: "user",
//       content: message.text,
//     };
//   });
// };

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
