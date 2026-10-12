import {
  createExecutionId,
  logAgentEvent,
  safeDomain,
  safeErrorMessage,
  safeRequestSummary,
  summarizeArgumentKeys,
} from "@/lib/agentLogger";
import {
  getRequiredBrowserResearchSources,
  hasSufficientBrowserResearchEvidence,
  planBrowserResearch,
} from "@/lib/browserResearchPlanner";
import {
  createCooperAgentForUser,
  mapMessages,
  parseToolOutput,
} from "@/lib/composioAgent";
import { validateUserFromRequest } from "@/lib/composioBackend";
import { buildConversationContext } from "@/lib/contextMemoryService";
import {
  classifyUserIntent,
  parseScheduleIntentWithAgent,
} from "@/lib/scheduleIntentAgent";
import { closeBrowserSessions } from "@/services/tools/BrowserbaseSession";
import { AgentInputItem, run } from "@openai/agents";

const TASK_DEADLINE_MS = 4 * 60 * 1000 + 45 * 1000;

export async function POST(req: Request) {
  const executionId = createExecutionId();
  const requestStartedAt = Date.now();
  const taskAbortController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    taskAbortController.abort(new Error("Research task deadline reached."));
  }, TASK_DEADLINE_MS);
  let reqBody: any = {};
  try {
    reqBody = await withAbortSignal(req.json(), taskAbortController.signal);
  } catch {
    reqBody = {};
  }

  const requestMessages = Array.isArray(reqBody.messages)
    ? reqBody.messages
    : [];
  let messages = requestMessages;
  let promptMessages = requestMessages;
  const { timezone } = reqBody;

  let activeUserId: string | null = null;
  let activeUserEmail: string | null = null;
  let activeAccessToken: string | null = null;
  try {
    const userAuth = await withAbortSignal(
      validateUserFromRequest(req, reqBody.userId),
      taskAbortController.signal,
    );
    activeUserId = userAuth.userId;
    activeUserEmail = userAuth.userEmail ?? null;
    activeAccessToken = userAuth.token ?? null;
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
      const verifiedPageEvidence: Array<{ url: string; result: string }> = [];
      let deadlineCleanup: Promise<void> | undefined;
      const onTaskDeadline = () => {
        logAgentEvent("Task deadline reached", executionId, {
          duration_ms: Date.now() - requestStartedAt,
          verified_page_reads: verifiedPageEvidence.length,
        });
        deadlineCleanup = closeBrowserSessions(browserSessionIds).then(() => {
          browserSessionIds.clear();
        });
      };
      taskAbortController.signal.addEventListener("abort", onTaskDeadline, {
        once: true,
      });
      if (taskAbortController.signal.aborted) onTaskDeadline();
      let loginRequired = false;
      let toolCallCount = 0;
      let toolSequence = 0;
      let firstBrowserActionReported = false;
      let agentModelTurns = 0;
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
        const requestCurrentMessage = [...requestMessages]
          .reverse()
          .find(
            (message: any) =>
              message?.sender === "user" && typeof message?.text === "string",
          );
        if (requestCurrentMessage) {
          const context = await buildConversationContext({
            userId: activeUserId,
            userEmail: activeUserEmail,
            accessToken: activeAccessToken,
            threadId:
              typeof reqBody.threadId === "string" ? reqBody.threadId : null,
            currentMessage: {
              id: String(requestCurrentMessage.id || "current-request"),
              role: "user",
              content: requestCurrentMessage.text,
              created_at: requestCurrentMessage.created_at,
            },
            fallbackMessages: requestMessages,
          });
          messages = context.conversationMessages;
          promptMessages = context.promptMessages;
        }
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
        const browserFollowUp = resolveBrowserResearchFollowUp(
          messages,
          latestUserMessage,
        );
        const resolvedRequestText =
          latestClarification &&
          followUpIntent &&
          followUpIntent.intent === "clarification_follow_up"
            ? latestClarification.clarification.originalRequest
            : browserFollowUp?.request || latestUserMessage?.text || "";

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

        let browserPlan;
        if (intent.intent === "browser_research") {
          browserPlan = await planBrowserResearch({
            request: resolvedRequestText,
            timezone,
            conversationContext: browserFollowUp?.conversationContext,
            signal: taskAbortController.signal,
          });
          logAgentEvent("Execution plan created", executionId, {
            action: "browser_research",
            goal: safeRequestSummary(browserPlan.goal),
            entities: browserPlan.entities.length,
            constraints: browserPlan.constraints
              .map(({ name }) => name)
              .join(","),
            sources: browserPlan.sources
              .map(({ url }) => safeDomain(url))
              .join(","),
            search_queries: browserPlan.searchQueries.length,
            comparison_criteria: browserPlan.comparisonCriteria.length,
          });

          if (browserPlan.clarificationQuestion) {
            logAgentEvent("Clarification requested", executionId, {
              reason: "essential_research_constraint_missing",
              missing_information: browserPlan.missingInformation.length,
            });
            send({
              type: "final",
              output: `Before I research, I need one detail: ${browserPlan.clarificationQuestion}`,
            });
            return;
          }
        }

        logAgentEvent("Execution path selected", executionId, {
          action: "cooper_agent_tool_loop",
          plan: browserPlan ? "browser_research" : "none",
        });
        const agent = await createCooperAgentForUser(
          activeUserId || "",
          executionId,
          browserPlan,
        );
        let result = await run(agent, mapMessages(promptMessages), {
          stream: true,
          maxTurns: 30,
          signal: taskAbortController.signal,
        });
        let output = "";
        let continuationAttempt = 0;
        const browserEvidenceDomains = new Set<string>();
        let usefulBrowserReads = 0;

        while (true) {
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

              if (/^browser_navigate$/i.test(toolName)) {
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
                activity: getToolActivityStage(toolName, rawItem?.arguments),
                detail: getToolActivityDetail(toolName, rawItem?.arguments),
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
                [
                  "failed",
                  "failure",
                  "error",
                  "login_required",
                  "not_verified",
                  "no_data",
                ].includes(outputStatus);
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

            if (/^create_browser_session$/i.test(outputName)) {
              logAgentEvent("Browser session preview ready", executionId, {
                page: safeDomain(output?.currentUrl),
                time_to_preview_ms: Date.now() - requestStartedAt,
                status: output?.status || "unknown",
              });
            } else if (/^browser_navigate$/i.test(outputName)) {
              logAgentEvent("Browser navigation completed", executionId, {
                destination: safeDomain(output?.currentUrl),
                status: output?.status || "completed",
                attempted_urls: Array.isArray(output?.attemptedUrls)
                  ? output.attemptedUrls.length
                  : undefined,
              });
            } else if (/^browser_read$/i.test(outputName)) {
              logAgentEvent("Browser page inspected", executionId, {
                page: safeDomain(output?.currentUrl),
                status: output?.status || "completed",
                result_chars: output?.resultChars,
                model_inference_ms: output?.stagehandUsage?.inferenceTimeMs,
                model_input_tokens: output?.stagehandUsage?.inputTokens,
                model_output_tokens: output?.stagehandUsage?.outputTokens,
              });
              if (
                output?.status === "completed" &&
                typeof output.result === "string" &&
                output.result.trim().length >= 12
              ) {
                usefulBrowserReads += 1;
                const domain = safeDomain(output.currentUrl);
                if (domain !== "unknown") browserEvidenceDomains.add(domain);
                verifiedPageEvidence.push({
                  url: String(output.currentUrl || "unknown"),
                  result: output.result.trim().slice(0, 1200),
                });
              }
            } else if (/^browser_action$/i.test(outputName)) {
              const firstActionDetails = firstBrowserActionReported
                ? {}
                : {
                    time_to_first_visible_interaction_ms:
                      Date.now() - requestStartedAt,
                  };
              firstBrowserActionReported = true;
              logAgentEvent("Browser action verified", executionId, {
                page: safeDomain(output?.currentUrl),
                observed: output?.actionObserved === true,
                status: output?.status || "unknown",
                model_inference_ms: output?.stagehandUsage?.inferenceTimeMs,
                model_input_tokens: output?.stagehandUsage?.inputTokens,
                model_output_tokens: output?.stagehandUsage?.outputTokens,
                ...firstActionDetails,
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
          agentModelTurns += result.currentTurn;
          output = result.finalOutput ?? "";

          const requiredSources = browserPlan
            ? getRequiredBrowserResearchSources(browserPlan)
            : 0;
          const hasEnoughBrowserEvidence =
            !browserPlan ||
            hasSufficientBrowserResearchEvidence(
              browserPlan,
              usefulBrowserReads,
              browserEvidenceDomains,
            );

          if (
            !browserPlan ||
            hasEnoughBrowserEvidence ||
            loginRequired ||
            continuationAttempt >= 2
          ) {
            break;
          }

          continuationAttempt += 1;
          logAgentEvent("Research continuation required", executionId, {
            attempt: continuationAttempt,
            useful_page_reads: usefulBrowserReads,
            distinct_sources: browserEvidenceDomains.size,
            required_sources: requiredSources,
          });
          send({ type: "activity", activity: "browsing_web" });

          const continuationMessages: AgentInputItem[] = [
            ...mapMessages(promptMessages),
            {
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: output }],
            } as AgentInputItem,
            {
              role: "user",
              content:
                `Continue the existing research plan; do not restart with the full request as one search query. ` +
                `Useful page reads so far: ${usefulBrowserReads}. ` +
                `Distinct source domains inspected: ${[...browserEvidenceDomains].filter((domain) => domain !== "unknown").join(",") || "none"}. ` +
                `Required distinct sources for this plan: ${requiredSources}. ` +
                `${browserSessionIds.size > 0 ? `Existing Browserbase session IDs: ${[...browserSessionIds].join(",")}. Do not create another session; reuse one of these.` : "No Browserbase session exists yet; create one for the next planned source."} ` +
                `Inspect prior results, then choose a focused next query or another planned source. Verify every action with browser_read. ` +
                `Research plan: ${JSON.stringify(browserPlan)}. Do not claim completion unless observed evidence satisfies its completion criteria.`,
            },
          ];
          result = await run(agent, continuationMessages, {
            stream: true,
            maxTurns: 20,
            signal: taskAbortController.signal,
          });
        }

        if (browserPlan) {
          const requiredSources =
            getRequiredBrowserResearchSources(browserPlan);
          const plannedDomains = browserPlan.sources
            .map(({ url }) => safeDomain(url))
            .filter((domain) => domain !== "unknown");
          const skippedDomains = plannedDomains.filter(
            (domain) => !browserEvidenceDomains.has(domain),
          );
          const unsupportedCitations = getLinkedDomains(output).filter(
            (domain) => !browserEvidenceDomains.has(domain),
          );

          logAgentEvent("Research source coverage", executionId, {
            planned_sources: plannedDomains.join(",") || "none",
            visited_sources: [...browserEvidenceDomains].join(",") || "none",
            skipped_sources: skippedDomains.join(",") || "none",
          });

          if (skippedDomains.length || unsupportedCitations.length) {
            const warnings = [
              skippedDomains.length
                ? `Planned sources not inspected: ${skippedDomains.join(", ")}.`
                : "",
              unsupportedCitations.length
                ? `These cited domains were not verified in the live browser: ${unsupportedCitations.join(", ")}.`
                : "",
            ].filter(Boolean);
            output = `${output}${output ? "\n\n" : ""}Source verification note: ${warnings.join(" ")}`;
          }

          if (
            !loginRequired &&
            !hasSufficientBrowserResearchEvidence(
              browserPlan,
              usefulBrowserReads,
              browserEvidenceDomains,
            )
          ) {
            logAgentEvent("Research evidence incomplete", executionId, {
              useful_page_reads: usefulBrowserReads,
              distinct_sources: browserEvidenceDomains.size,
              required_sources: requiredSources,
            });
            output = `${output}${output ? "\n\n" : ""}Research limitation: I could not verify enough useful page evidence to complete this research confidently.`;
          }
        }

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
          agent_model_turns: agentModelTurns,
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
        if (taskAbortController.signal.aborted) {
          const partialResults = verifiedPageEvidence
            .slice(0, 5)
            .map(({ url, result: evidence }) => `Source: ${url}\n${evidence}`)
            .join("\n\n");
          send({
            type: "final",
            output: `The research time budget was reached. ${partialResults ? `Verified partial results:\n\n${partialResults}` : "I could not verify useful page results before the deadline."}`,
          });
        } else {
          send({
            type: "error",
            message: getAgentErrorMessage(error),
          });
        }
      } finally {
        clearTimeout(deadlineTimer);
        taskAbortController.signal.removeEventListener("abort", onTaskDeadline);
        if (deadlineCleanup) {
          try {
            await deadlineCleanup;
          } catch (closeError) {
            logAgentEvent("Browser session close failed", executionId, {
              error: safeErrorMessage(closeError),
            });
          }
        } else if (!loginRequired && browserSessionIds.size > 0) {
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

async function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason ?? new Error("Request deadline reached.");
  }

  let removeAbortListener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new Error("Request deadline reached."));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    removeAbortListener();
  }
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

function resolveBrowserResearchFollowUp(
  messages: any[],
  latestUserMessage: any,
): {
  request: string;
  conversationContext: Array<{ role: string; text: string }>;
} | null {
  if (!latestUserMessage?.text || !Array.isArray(messages)) return null;

  const latestUserIndex = messages.lastIndexOf(latestUserMessage);
  if (latestUserIndex <= 1) return null;

  let assistantIndex = latestUserIndex - 1;
  while (assistantIndex >= 0 && messages[assistantIndex]?.sender !== "agent") {
    assistantIndex -= 1;
  }
  const assistantMessage = messages[assistantIndex];
  if (
    typeof assistantMessage?.text !== "string" ||
    !assistantMessage.text.startsWith("Before I research, I need one detail:")
  ) {
    return null;
  }

  let originalRequestIndex = assistantIndex - 1;
  while (
    originalRequestIndex >= 0 &&
    messages[originalRequestIndex]?.sender !== "user"
  ) {
    originalRequestIndex -= 1;
  }
  const originalRequest = messages[originalRequestIndex]?.text;
  if (
    typeof originalRequest !== "string" ||
    classifyUserIntent(originalRequest).intent !== "browser_research"
  ) {
    return null;
  }

  return {
    request: `${originalRequest}\n\nAdditional detail from the user: ${latestUserMessage.text}`,
    conversationContext: [
      { role: "user", text: originalRequest },
      { role: "assistant", text: assistantMessage.text },
      { role: "user", text: latestUserMessage.text },
    ],
  };
}

function getToolActivityStage(toolName: unknown, toolArguments?: unknown) {
  if (typeof toolName !== "string") return "using_connected_tools";

  const normalizedName = toolName.toLowerCase();
  const argumentText =
    typeof toolArguments === "string"
      ? toolArguments
      : toolArguments && typeof toolArguments === "object"
        ? JSON.stringify(toolArguments)
        : "";

  if (/^browser_navigate$/.test(normalizedName)) {
    return "opening_source";
  }
  if (/^create_browser_session$/.test(normalizedName)) {
    return "browsing_web";
  }
  if (/browser_action/.test(normalizedName)) {
    if (/scroll/i.test(argumentText)) return "scrolling_page";
    if (/type|fill|enter text/i.test(argumentText)) return "typing_in_page";
    if (/click|press|select/i.test(argumentText)) return "clicking_page";
    if (/search|query/i.test(argumentText)) return "searching_web";
    if (/compare/i.test(argumentText)) return "comparing_options";
    if (/open|inspect|details/i.test(argumentText)) return "inspecting_details";
    return "searching_web";
  }
  if (/browser_read/.test(normalizedName)) {
    return "reading_results";
  }
  if (/browser|web[_-]?search|search[_-]?web/.test(normalizedName)) {
    return "browsing_web";
  }
  if (/gmail|outlook|email|mail/.test(normalizedName)) return "using_email";
  if (/calendar/.test(normalizedName)) return "using_calendar";
  if (/slack/.test(normalizedName)) return "using_slack";
  return "using_connected_tools";
}

function getToolActivityDetail(toolName: unknown, toolArguments?: unknown) {
  const normalizedName = String(toolName || "").toLowerCase();
  let argumentsValue = toolArguments;
  if (typeof argumentsValue === "string") {
    try {
      argumentsValue = JSON.parse(argumentsValue);
    } catch {
      argumentsValue = {};
    }
  }

  const args =
    argumentsValue && typeof argumentsValue === "object"
      ? (argumentsValue as Record<string, unknown>)
      : {};

  if (normalizedName === "browser_navigate") {
    const destination = safeDomain(args.url);
    return destination === "unknown"
      ? "Opening source"
      : `Opening ${destination}`;
  }
  if (normalizedName === "create_browser_session")
    return "Starting live browser";
  if (normalizedName === "browser_read") return "Inspecting visible results";
  if (normalizedName === "browser_action") {
    const instruction = String(args.instruction || "");
    if (/scroll/i.test(instruction)) return "Scrolling page";
    if (/type|fill|enter text/i.test(instruction)) return "Typing in page";
    if (/click|press|select/i.test(instruction)) return "Clicking page";
    if (/search|query/i.test(instruction)) return "Searching the web";
    return "Inspecting page details";
  }
  return undefined;
}

function getLinkedDomains(text: string) {
  const urls = text.match(/https?:\/\/[^\s)\]>]+/gi) || [];
  return [
    ...new Set(urls.map(safeDomain).filter((domain) => domain !== "unknown")),
  ];
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
