import {
  createExecutionId,
  logAgentEvent,
  safeDomain,
  safeErrorMessage,
  safeRequestSummary,
  summarizeArgumentKeys,
} from "@/lib/agentLogger";
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
  const executionId = createExecutionId();
  const requestStartedAt = Date.now();
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
      let toolCallCount = 0;
      let toolSequence = 0;
      const activeToolCalls = new Map<
        string,
        { name: string; startedAt: number }
      >();
      const pendingToolResults: Array<{
        name: string;
        durationMs: number;
        status: "success" | "failed";
        resultStatus?: string;
        error?: string;
      }> = [];
      const flushToolResults = (anotherToolSelected: boolean) => {
        for (const result of pendingToolResults.splice(0)) {
          logAgentEvent(
            result.status === "success"
              ? "Tool execution completed"
              : "Tool execution failed",
            executionId,
            {
              tool: result.name,
              duration_ms: result.durationMs,
              status: result.status,
              result_status: result.resultStatus,
              another_tool_selected: anotherToolSelected,
              error: result.error,
            },
          );
        }
      };

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
        logAgentEvent("Request received", executionId, {
          request: safeRequestSummary(latestUserMessage?.text),
        });
        logAgentEvent("Intent resolved", executionId, {
          intent: intent.intent,
          reason: intent.reason,
        });

        if (intent.intent === "clarification_required") {
          logAgentEvent("Clarification requested", executionId, {
            status: "pending",
          });
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
          logAgentEvent("Execution plan created", executionId, {
            action: "prepare_recurring_task_confirmation",
            frequency: scheduleConfirmation.scheduleRule.frequency,
            delivery: scheduleConfirmation.delivery,
          });
          logAgentEvent("Confirmation required", executionId, {
            status: "pending",
          });
          send({
            type: "schedule_confirmation",
            output: "Schedule this task?",
            scheduleConfirmation,
            executionId,
          });
          return;
        }

        logAgentEvent("Execution path selected", executionId, {
          action: "cooper_agent_tool_loop",
        });
        const agent = await createCooperAgentForUser(
          activeUserId || "",
          executionId,
        );
        const result = await run(agent, mapMessages(messages), {
          stream: true,
          maxTurns: 30,
        });

        for await (const event of result) {
          if (event.type !== "run_item_stream_event") continue;

          if (event.name === "tool_search_called") {
            const rawItem = (event.item as any)?.rawItem;
            logAgentEvent("Tool search started", executionId, {
              argument_keys: summarizeArgumentKeys(rawItem?.arguments),
            });
            continue;
          }

          if (event.name === "tool_search_output_created") {
            const rawItem = (event.item as any)?.rawItem;
            logAgentEvent("Tool search completed", executionId, {
              available_tools: Array.isArray(rawItem?.tools)
                ? rawItem.tools.length
                : undefined,
            });
            continue;
          }

          if (event.name === "tool_called") {
            flushToolResults(true);
            const rawItem = (event.item as any)?.rawItem;
            const toolName = rawItem?.name || "unknown_tool";
            const toolCallId =
              rawItem?.callId || rawItem?.id || `${toolName}:${toolSequence}`;
            const argumentKeys = summarizeArgumentKeys(rawItem?.arguments);
            toolSequence += 1;
            toolCallCount += 1;
            activeToolCalls.set(String(toolCallId), {
              name: String(toolName),
              startedAt: Date.now(),
            });
            logAgentEvent("Tool selected", executionId, {
              sequence: toolSequence,
              integration: getToolIntegration(toolName),
              tool: toolName,
              argument_keys: argumentKeys,
            });
            logAgentEvent("Tool execution started", executionId, {
              tool: toolName,
            });

            if (/^(create_browser_session|browser_navigate)$/i.test(toolName)) {
              let toolArguments: any = rawItem?.arguments;
              if (typeof toolArguments === "string") {
                try {
                  toolArguments = JSON.parse(toolArguments);
                } catch {
                  toolArguments = {};
                }
              }
              logAgentEvent("Browser navigation started", executionId, {
                destination: safeDomain(
                  toolArguments?.startUrl || toolArguments?.url,
                ),
              });
            }

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

          const outputItem = event.item as any;
          const output = parseToolOutput(outputItem.output);
          const rawOutputItem = outputItem.rawItem;
          const outputName = String(rawOutputItem?.name || "unknown_tool");
          const outputCallId = String(
            rawOutputItem?.callId || rawOutputItem?.id || "",
          );
          const activeCall = outputCallId
            ? activeToolCalls.get(outputCallId)
            : [...activeToolCalls.values()].find(
                (call) => call.name === outputName,
              );
          if (activeCall) {
            if (outputCallId) activeToolCalls.delete(outputCallId);
            else {
              const matchingKey = [...activeToolCalls.entries()].find(
                ([, call]) => call === activeCall,
              )?.[0];
              if (matchingKey) activeToolCalls.delete(matchingKey);
            }

            const outputStatus = String(output?.status || "").toLowerCase();
            const outputFailed =
              rawOutputItem?.status === "incomplete" ||
              output?.isError === true ||
              ["failed", "failure", "error", "login_required"].includes(
                outputStatus,
              );
            pendingToolResults.push({
              name: activeCall.name,
              durationMs: Date.now() - activeCall.startedAt,
              status: outputFailed ? "failed" : "success",
              resultStatus: outputStatus || undefined,
              error: outputFailed
                ? safeErrorMessage(
                    output?.message ||
                      output?.error ||
                      "Tool returned an error",
                  )
                : undefined,
            });
          }

          if (/^(create_browser_session|browser_navigate)$/i.test(outputName)) {
            logAgentEvent("Browser navigation completed", executionId, {
              destination: safeDomain(output?.currentUrl),
              status: output?.status || "completed",
            });
          } else if (/^browser_read$/i.test(outputName)) {
            logAgentEvent("Browser page inspected", executionId, {
              page: safeDomain(output?.currentUrl),
              status: output?.status || "completed",
            });
          }

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
        flushToolResults(false);
        if (toolCallCount === 0) {
          logAgentEvent("No tool selected", executionId, {
            reason: "agent_completed_without_tool_call",
          });
        }

        const connectCta = extractConnectCta(output);
        logAgentEvent("Final response generated", executionId, {
          status: "success",
          response_chars: output.length,
          duration_ms: Date.now() - requestStartedAt,
        });
        send({
          type: "final",
          output: connectCta ? cleanConnectLinkFromOutput(output) : output,
          connectCta,
        });
      } catch (error) {
        flushToolResults(false);
        for (const activeCall of activeToolCalls.values()) {
          logAgentEvent("Tool execution failed", executionId, {
            tool: activeCall.name,
            duration_ms: Date.now() - activeCall.startedAt,
            status: "failed",
            error: safeErrorMessage(error),
          });
        }
        logAgentEvent("Request failed", executionId, {
          duration_ms: Date.now() - requestStartedAt,
          error: safeErrorMessage(error),
        });
        send({
          type: "error",
          message: getAgentErrorMessage(error),
        });
      } finally {
        if (!loginRequired && browserSessionIds.size > 0) {
          try {
            await closeBrowserSessions(browserSessionIds);
          } catch (closeError) {
            logAgentEvent("Browser session close failed", executionId, {
              error: safeErrorMessage(closeError),
            });
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

function getToolIntegration(toolName: unknown) {
  const normalized = String(toolName || "").toLowerCase();
  if (/browser|stagehand|browserbase/.test(normalized)) return "browser";
  if (/gmail|email|outlook/.test(normalized)) return "gmail";
  if (/google.?calendar|calendar/.test(normalized)) return "googlecalendar";
  if (/google.?meet/.test(normalized)) return "google_meet";
  if (/motion/.test(normalized)) return "motion";
  if (/slack/.test(normalized)) return "slack";
  if (/notion/.test(normalized)) return "notion";
  if (/teams/.test(normalized)) return "microsoftteams";
  return normalized.split(/[_-]/)[0] || "connected_tool";
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
