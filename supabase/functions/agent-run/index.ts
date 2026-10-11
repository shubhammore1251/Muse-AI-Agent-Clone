// @ts-ignore Deno Edge supports npm: imports; the app TypeScript check does not.
import { createClient } from "npm:@supabase/supabase-js@^2.109.0";

type JsonRecord = Record<string, unknown>;

function toJsonRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => toJsonRecord(item));
}

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
  env: {
    get: (name: string) => string | undefined;
  };
};

type RequestBody = {
  mode?: "run_due_schedules" | "run_scheduled_task";
  userId?: string;
  scheduledTaskId?: string;
  task?: string;
  browserTask?: string;
  composioToolSlug?: string;
  composioToolkitSlug?: string;
  composioUseCase?: string;
  composioText?: string;
  composioArguments?: JsonRecord;
  delivery?: string;
  pollBrowserbase?: boolean;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const executionId = createEdgeExecutionId();
  const requestStartedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const taskSummary = body.task || body.browserTask || body.composioText;
    logEdgeAgentEvent("Request received", executionId, {
      mode: body.mode || "execute_task",
      request: safeEdgeSummary(taskSummary),
    });
    const supabase = createAdminClient();

    if (body.mode === "run_due_schedules") {
      logEdgeAgentEvent("Intent resolved", executionId, {
        intent: "due_schedule_execution",
      });
      const result = await runDueSchedules(supabase, executionId);
      logEdgeAgentEvent("Final response generated", executionId, {
        status: "success",
        duration_ms: Date.now() - requestStartedAt,
      });
      return json({ ok: true, ...result });
    }

    const user = await resolveUser(req, supabase, body.userId);

    if (body.mode === "run_scheduled_task") {
      logEdgeAgentEvent("Intent resolved", executionId, {
        intent: "saved_recurring_task_execution",
      });
      const result = await runScheduledTaskNow(
        supabase,
        user.id,
        body.scheduledTaskId,
        executionId,
      );
      logEdgeAgentEvent("Final response generated", executionId, {
        status: "success",
        duration_ms: Date.now() - requestStartedAt,
      });
      return json({ ok: true, ...result });
    }

    const task =
      body.task ||
      body.browserTask ||
      body.composioText ||
      "Scheduled Muse AI task";

    const directComposioPlan =
      body.composioToolSlug || body.composioToolkitSlug
        ? null
        : inferComposioPlanForDelivery({
            delivery: body.delivery || inferDeliveryFromText(task) || "chat",
            task,
            payload: toJsonRecord(body),
            aiText: body.composioText,
          });
    const composioToolSlug = body.composioToolSlug;
    const composioToolkitSlug =
      body.composioToolkitSlug || directComposioPlan?.toolkitSlug;
    const composioUseCase = body.composioUseCase || directComposioPlan?.useCase;
    const composioText = body.composioText || directComposioPlan?.text;
    const composioArguments =
      body.composioArguments || directComposioPlan?.arguments;
    logEdgeAgentEvent("Execution plan created", executionId, {
      action: "execute_requested_task",
      composio: composioToolSlug || composioToolkitSlug || "none",
      browserbase: body.browserTask ? "requested" : "not_requested",
      argument_keys: safeArgumentKeys(composioArguments),
    });
    const composioAccounts =
      composioToolSlug || composioToolkitSlug
        ? await listComposioAccounts(user.id)
        : { items: [] };

    const connectedAccounts = toJsonRecordArray(composioAccounts.items);

    const composioResult = composioToolSlug
      ? await executeComposioTool({
          toolSlug: composioToolSlug,
          userId: user.id,
          text: composioText,
          args: composioArguments,
          connectedAccounts,
          executionId,
          anotherToolExpected: Boolean(body.browserTask),
        })
      : composioToolkitSlug
        ? await executeComposioAppUseCase({
            toolkitSlug: composioToolkitSlug,
            userId: user.id,
            useCase: composioUseCase || composioText || task,
            args: composioArguments,
            connectedAccounts,
            executionId,
            anotherToolExpected: Boolean(body.browserTask),
          })
        : null;

    const browserbaseRun = body.browserTask
      ? await runBrowserbaseAgent({
          task: body.browserTask,
          poll: body.pollBrowserbase ?? true,
          executionId,
        })
      : null;

    await supabase.from("agent_tool_runs").insert({
      user_id: user.id,
      action_name: "edge_agent_run",
      input_summary: task,
      output_summary: summarizeOutput({ composioResult, browserbaseRun }),
      status: "completed",
      metadata: {
        composio_account_count: connectedAccounts.length || 0,
        composio_tool_slug: composioToolSlug || null,
        composio_toolkit_slug: composioToolkitSlug || null,
        browserbase_run_id: browserbaseRun?.runId || null,
        browserbase_status: browserbaseRun?.status || null,
      },
    });

    logEdgeAgentEvent("Final response generated", executionId, {
      status: "success",
      duration_ms: Date.now() - requestStartedAt,
    });
    return json({
      ok: true,
      userId: user.id,
      composio: {
        activeAccounts: sanitizeComposioAccounts(connectedAccounts),
        toolResult: composioResult,
      },
      browserbase: browserbaseRun,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logEdgeAgentEvent("Request failed", executionId, {
      duration_ms: Date.now() - requestStartedAt,
      error: safeEdgeErrorMessage(error),
    });
    return json({ ok: false, error: message }, 500);
  }
});

async function runDueSchedules(
  supabase: ReturnType<typeof createAdminClient>,
  requestExecutionId: string,
) {
  const now = new Date();
  const { data: schedules, error } = await supabase
    .from("scheduled_agent_tasks")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(25);

  if (error) {
    throw error;
  }

  const results = [];

  for (const schedule of schedules || []) {
    const executionId = `${requestExecutionId}:${String(schedule.id).slice(0, 8)}`;
    try {
      logEdgeAgentEvent("Intent resolved", executionId, {
        intent: "saved_recurring_task_execution",
      });
      const output = await executeScheduledTask(schedule, executionId);
      const nextRunAt = calculateNextRunAt(schedule);
      const nextStatus = nextRunAt ? "active" : "cancelled";
      const outputSummary = summarizeOutput(output);
      const resultText = getScheduledResultText(output);

      const { error: runInsertError } = await supabase
        .from("agent_tool_runs")
        .insert({
          user_id: schedule.user_id,
          action_name: getScheduleActionName(schedule),
          input_summary: getScheduleInputSummary(schedule),
          output_summary: outputSummary,
          status: "completed",
          metadata: {
            scheduled_task_id: schedule.id,
            task_type: schedule.task_type || null,
            delivery: schedule.delivery,
          },
        });

      if (runInsertError) {
        throw runInsertError;
      }

      let chatMessageId: string | null = null;
      let chatDeliveryError: string | null = null;

      if (isChatDelivery(schedule)) {
        try {
          const chatMessage = await saveScheduledResultToChat(
            supabase,
            schedule,
            output,
          );
          chatMessageId = getString(chatMessage.id) || null;
        } catch (chatError) {
          chatDeliveryError =
            chatError instanceof Error
              ? chatError.message
              : "Unknown chat delivery error";
          logEdgeAgentEvent("Scheduled result delivery failed", executionId, {
            error: safeEdgeErrorMessage(chatDeliveryError),
          });
        }
      }

      const updatePayload: JsonRecord = {
        last_run_at: now.toISOString(),
        last_run_status: "completed",
        last_run_summary: resultText || outputSummary,
        last_run_error: null,
        status: nextStatus,
      };

      if (nextRunAt) {
        updatePayload.next_run_at = nextRunAt;
      }

      const { error: updateError } = await supabase
        .from("scheduled_agent_tasks")
        .update(updatePayload)
        .eq("id", schedule.id);

      if (updateError) {
        throw updateError;
      }

      results.push({ id: schedule.id, status: "completed" });
      logEdgeAgentEvent("Task execution completed", executionId, {
        status: "success",
      });
      if (chatMessageId || chatDeliveryError) {
        results[results.length - 1] = {
          ...results[results.length - 1],
          chatMessageId,
          chatDeliveryError,
        };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown schedule error";

      const { error: failedRunInsertError } = await supabase
        .from("agent_tool_runs")
        .insert({
          user_id: schedule.user_id,
          action_name: getScheduleActionName(schedule),
          input_summary: getScheduleInputSummary(schedule),
          output_summary: null,
          status: "failed",
          error_message: message,
          metadata: {
            scheduled_task_id: schedule.id,
            task_type: schedule.task_type || null,
          },
        });

      if (failedRunInsertError) {
        logEdgeAgentEvent("Failure record persistence failed", executionId, {
          error: safeEdgeErrorMessage(failedRunInsertError),
        });
      }

      if (isChatDelivery(schedule)) {
        try {
          await saveScheduledResultToChat(supabase, schedule, null, message);
        } catch (chatError) {
          logEdgeAgentEvent("Scheduled failure delivery failed", executionId, {
            error: safeEdgeErrorMessage(chatError),
          });
        }
      }

      const { error: failedScheduleUpdateError } = await supabase
        .from("scheduled_agent_tasks")
        .update({
          last_run_at: now.toISOString(),
          last_run_status: "failed",
          last_run_summary: null,
          last_run_error: message,
        })
        .eq("id", schedule.id);

      if (failedScheduleUpdateError) {
        logEdgeAgentEvent("Task status update failed", executionId, {
          error: safeEdgeErrorMessage(failedScheduleUpdateError),
        });
      }

      results.push({ id: schedule.id, status: "failed", error: message });
      logEdgeAgentEvent("Task execution failed", executionId, {
        status: "failed",
        error: safeEdgeErrorMessage(error),
      });
    }
  }

  return {
    checkedAt: now.toISOString(),
    dueCount: schedules?.length || 0,
    results,
  };
}

async function runScheduledTaskNow(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  scheduledTaskId?: string,
  executionId?: string,
) {
  if (!scheduledTaskId) {
    throw new Error("scheduledTaskId is required.");
  }

  const { data: schedule, error } = await supabase
    .from("scheduled_agent_tasks")
    .select("*")
    .eq("id", scheduledTaskId)
    .eq("user_id", userId)
    .single();

  if (error || !schedule) {
    throw error || new Error("Scheduled task not found.");
  }

  const now = new Date();
  const taskExecutionId = executionId || createEdgeExecutionId();

  try {
    logEdgeAgentEvent("Intent resolved", taskExecutionId, {
      intent: "saved_recurring_task_execution",
    });
    const output = await executeScheduledTask(schedule, taskExecutionId);
    const outputSummary = summarizeOutput(output);
    const resultText = getScheduledResultText(output);

    const { error: runInsertError } = await supabase
      .from("agent_tool_runs")
      .insert({
        user_id: schedule.user_id,
        action_name: getScheduleActionName(schedule),
        input_summary: getScheduleInputSummary(schedule),
        output_summary: outputSummary,
        status: "completed",
        metadata: {
          scheduled_task_id: schedule.id,
          task_type: schedule.task_type || null,
          delivery: schedule.delivery,
          manual: true,
        },
      });

    if (runInsertError) {
      throw runInsertError;
    }

    let chatMessageId: string | null = null;
    let chatDeliveryError: string | null = null;

    if (isChatDelivery(schedule)) {
      try {
        const chatMessage = await saveScheduledResultToChat(
          supabase,
          schedule,
          output,
        );
        chatMessageId = getString(chatMessage.id) || null;
      } catch (chatError) {
        chatDeliveryError =
          chatError instanceof Error
            ? chatError.message
            : "Unknown chat delivery error";
        logEdgeAgentEvent("Scheduled result delivery failed", taskExecutionId, {
          error: safeEdgeErrorMessage(chatDeliveryError),
        });
      }
    }

    const { error: updateError } = await supabase
      .from("scheduled_agent_tasks")
      .update({
        last_run_at: now.toISOString(),
        last_run_status: "completed",
        last_run_summary: resultText || outputSummary,
        last_run_error: null,
      })
      .eq("id", schedule.id);

    if (updateError) {
      throw updateError;
    }

    logEdgeAgentEvent("Task execution completed", taskExecutionId, {
      status: "success",
    });
    return {
      id: schedule.id,
      status: "completed",
      chatMessageId,
      chatDeliveryError,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown schedule error";

    const { error: failedRunInsertError } = await supabase
      .from("agent_tool_runs")
      .insert({
        user_id: schedule.user_id,
        action_name: getScheduleActionName(schedule),
        input_summary: getScheduleInputSummary(schedule),
        output_summary: null,
        status: "failed",
        error_message: message,
        metadata: {
          scheduled_task_id: schedule.id,
          task_type: schedule.task_type || null,
          manual: true,
        },
      });

    if (failedRunInsertError) {
      logEdgeAgentEvent("Failure record persistence failed", taskExecutionId, {
        error: safeEdgeErrorMessage(failedRunInsertError),
      });
    }

    const { error: failedUpdateError } = await supabase
      .from("scheduled_agent_tasks")
      .update({
        last_run_at: now.toISOString(),
        last_run_status: "failed",
        last_run_summary: null,
        last_run_error: message,
      })
      .eq("id", schedule.id);

    if (failedUpdateError) {
      logEdgeAgentEvent("Task status update failed", taskExecutionId, {
        error: safeEdgeErrorMessage(failedUpdateError),
      });
    }

    if (isChatDelivery(schedule)) {
      try {
        await saveScheduledResultToChat(supabase, schedule, null, message);
      } catch (chatError) {
        logEdgeAgentEvent(
          "Scheduled failure delivery failed",
          taskExecutionId,
          { error: safeEdgeErrorMessage(chatError) },
        );
      }
    }

    logEdgeAgentEvent("Task execution failed", taskExecutionId, {
      status: "failed",
      error: safeEdgeErrorMessage(error),
    });

    throw new Error(message);
  }
}

async function executeScheduledTask(schedule: JsonRecord, executionId: string) {
  const payload = toJsonRecord(schedule.task_payload);
  const userId = getRequiredString(schedule, "user_id");
  const task = getFirstString(schedule, payload, [
    "task",
    "original_prompt",
    "prompt",
    "instruction",
    "description",
  ]);
  const browserTask = getFirstString(schedule, payload, [
    "browser_task",
    "browserTask",
  ]);
  const composioToolSlug = getFirstString(schedule, payload, [
    "composio_tool_slug",
    "composioToolSlug",
  ]);
  let composioToolkitSlug = getFirstString(schedule, payload, [
    "composio_toolkit_slug",
    "composioToolkitSlug",
  ]);
  let composioUseCase = getFirstString(schedule, payload, [
    "composio_use_case",
    "composioUseCase",
  ]);
  let composioArguments = getFirstRecord(schedule, payload, [
    "composio_arguments",
    "composioArguments",
  ]);
  let composioText =
    getFirstString(schedule, payload, ["composio_text", "composioText"]) ||
    task;
  const shouldUseOpenAi =
    getBoolean(schedule, payload, "use_openai", "useOpenAi") ?? true;
  const delivery = (getString(schedule.delivery) || "chat").toLowerCase();

  if (!task && !browserTask && !composioToolSlug && !composioToolkitSlug) {
    throw new Error(
      "Scheduled task is missing task, browser_task, composio_tool_slug, or composio_toolkit_slug.",
    );
  }

  logEdgeAgentEvent("Execution plan created", executionId, {
    action: "execute_saved_task",
    integration:
      composioToolSlug ||
      composioToolkitSlug ||
      (browserTask ? "browserbase" : "none"),
    browserbase: browserTask ? "requested" : "not_requested",
    argument_keys: safeArgumentKeys(composioArguments),
  });

  const browserbaseRun = browserTask
    ? await runBrowserbaseAgent({
        task: browserTask,
        poll:
          getBoolean(
            schedule,
            payload,
            "poll_browserbase",
            "pollBrowserbase",
          ) ?? true,
        executionId,
      })
    : null;

  let aiDraft =
    task &&
    shouldUseOpenAi &&
    shouldDraftWithOpenAiBeforeComposio(
      delivery,
      composioToolkitSlug,
      composioToolSlug,
    )
      ? await runOpenAiTask({
          task,
          title: getString(schedule.title),
          delivery,
          composioResult: null,
          browserbaseRun,
          executionId,
          phase: "draft",
        })
      : null;

  if (!composioToolkitSlug && !composioToolSlug) {
    const inferredPlan = inferComposioPlanForDelivery({
      delivery,
      task,
      payload,
      aiText: getString(toJsonRecord(aiDraft).outputText),
    });

    if (inferredPlan) {
      composioToolkitSlug = inferredPlan.toolkitSlug;
      composioUseCase = inferredPlan.useCase;
      composioArguments = inferredPlan.arguments;
      composioText = inferredPlan.text;
    }
  } else if (delivery === "slack") {
    composioArguments = buildSlackMessageArguments({
      task,
      payload,
      aiText: getString(toJsonRecord(aiDraft).outputText),
      existingArguments: composioArguments,
    });
  }

  const composioAccounts =
    composioToolkitSlug || composioToolSlug
      ? await listComposioAccounts(userId)
      : null;

  const connectedAccounts = toJsonRecordArray(composioAccounts?.items);

  const expectedToolkit =
    composioToolkitSlug || getToolkitSlugFromToolSlug(composioToolSlug || "");
  try {
    assertConnectedToolkitAvailable(expectedToolkit, connectedAccounts);
  } catch (error) {
    logEdgeAgentEvent("Tool selection failed", executionId, {
      integration: expectedToolkit,
      reason: "integration_unavailable",
      error: safeEdgeErrorMessage(error),
    });
    throw error;
  }
  const composioResult = composioToolSlug
    ? await executeComposioTool({
        toolSlug: composioToolSlug,
        userId,
        text: composioText,
        args: composioArguments,
        connectedAccounts,
        executionId,
      })
    : composioToolkitSlug
      ? await executeComposioAppUseCase({
          toolkitSlug: composioToolkitSlug,
          userId,
          useCase:
            composioUseCase ||
            composioText ||
            task ||
            `Run scheduled ${delivery} task.`,
          args: composioArguments,
          connectedAccounts,
          executionId,
        })
      : null;
  const aiResult =
    task && shouldUseOpenAi
      ? await runOpenAiTask({
          task,
          title: getString(schedule.title),
          delivery,
          composioResult: toJsonRecord(composioResult),
          browserbaseRun,
          executionId,
          phase: "final",
        })
      : aiDraft;

  return {
    type: "scheduled_user_task",
    title: schedule.title,
    delivery,
    task,
    composio: composioResult
      ? {
          activeAccounts: sanitizeComposioAccounts(connectedAccounts),
          toolResult: composioResult,
        }
      : null,
    browserbase: browserbaseRun,
    ai: aiResult,
  };
}

async function runOpenAiTask({
  task,
  title,
  delivery,
  composioResult,
  browserbaseRun,
  executionId,
  phase,
}: {
  task: string;
  title?: string;
  delivery?: string;
  composioResult: JsonRecord | null;
  browserbaseRun: JsonRecord | null;
  executionId: string;
  phase: "draft" | "final";
}) {
  const apiKey = getEnv("OPENAI_API_KEY");

  if (!apiKey) {
    logEdgeAgentEvent("Model execution skipped", executionId, {
      phase,
      reason: "missing_api_key",
    });
    return {
      skipped: true,
      reason: "OPENAI_API_KEY is not configured.",
    };
  }

  const systemPrompt = [
    "You are Muse AI executing a saved scheduled task for the user.",
    "Do the task now. Do not explain how to set it up, do not suggest cron jobs, scripts, webhooks, or future steps.",
    "If the task asks for a message to be delivered externally, write only the message content that should be sent.",
    "If a connected external tool is required and no tool result is provided, return a concise actionable failure instead of setup instructions.",
    "Keep the result short, useful, and ready to show to the user.",
  ].join(" ");

  const input = [
    title ? `Scheduled task title: ${title}` : null,
    delivery ? `Delivery destination: ${delivery}` : null,
    `User requested task: ${task}`,
    composioResult
      ? `Connected tool result: ${JSON.stringify(composioResult)}`
      : null,
    browserbaseRun
      ? `Browser task result: ${JSON.stringify(browserbaseRun)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const model = getEnv("OPENAI_MODEL") || "gpt-5-nano";
  let response: JsonRecord;
  const startedAt = Date.now();
  logEdgeAgentEvent("Model execution started", executionId, {
    model,
    phase,
  });

  try {
    response = await apiFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/unsupported.*message.*format|message.*format.*unsupported/i.test(
        message,
      )
    ) {
      throw error;
    }

    logEdgeAgentEvent("Model retry", executionId, {
      phase,
      reason: safeEdgeErrorMessage(error),
      fallback: "chat_completions",
    });

    response = await apiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: input,
          },
        ],
      }),
    });
  }

  logEdgeAgentEvent("Model execution completed", executionId, {
    phase,
    status: "success",
    duration_ms: Date.now() - startedAt,
  });
  return {
    outputText:
      extractOpenAiOutputText(response) ||
      extractChatCompletionOutputText(response),
    response,
  };
}

function calculateNextRunAt(schedule: JsonRecord) {
  const scheduleType = String(schedule.schedule_type || "daily");
  const previousRunAt =
    getString(schedule.next_run_at) || new Date().toISOString();
  const next = new Date(previousRunAt);

  if (scheduleType === "once") {
    return null;
  }

  if (scheduleType === "interval") {
    const intervalMinutes = Number(schedule.interval_minutes || 0);
    if (Number.isFinite(intervalMinutes) && intervalMinutes > 0) {
      return new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
    }
  }

  const rule = toJsonRecord(schedule.schedule_rule);
  const frequency = String(rule.frequency || scheduleType || "daily");

  if (frequency === "weekly") {
    do {
      next.setDate(next.getDate() + 7);
    } while (next <= new Date());
  } else {
    do {
      next.setDate(next.getDate() + 1);
    } while (next <= new Date());
  }

  return next.toISOString();
}

function getScheduleActionName(schedule: JsonRecord) {
  const taskType = getString(schedule.task_type) || "user_task";
  return `scheduled_${taskType}`;
}

function getScheduleInputSummary(schedule: JsonRecord) {
  return (
    getString(schedule.task) ||
    getString(schedule.original_prompt) ||
    getString(schedule.prompt) ||
    getString(schedule.browser_task) ||
    getString(schedule.composio_text) ||
    getString(schedule.title) ||
    "Scheduled Muse AI task"
  );
}

function isChatDelivery(schedule: JsonRecord) {
  return (getString(schedule.delivery) || "chat").toLowerCase() === "chat";
}

async function saveScheduledResultToChat(
  supabase: ReturnType<typeof createAdminClient>,
  schedule: JsonRecord,
  output: JsonRecord | null,
  errorMessage?: string,
) {
  const userId = getRequiredString(schedule, "user_id");
  const userEmail = await getUserEmail(supabase, userId);
  const payload = toJsonRecord(schedule.task_payload);
  const thread = await getScheduledResultThread(
    supabase,
    userEmail,
    getString(payload.sourceThreadId) || getString(payload.source_thread_id),
  );
  const content = errorMessage
    ? formatScheduledFailureMessage(schedule, errorMessage)
    : formatScheduledSuccessMessage(schedule, output || {});
  const metadata = {
    type: "scheduled_task_result",
    scheduledTaskId: schedule.id || null,
    taskType: schedule.task_type || null,
    delivery: schedule.delivery || "chat",
    status: errorMessage ? "failed" : "completed",
    output,
    errorMessage: errorMessage || null,
  };

  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      user_email: userEmail,
      thread_id: thread.id,
      role: "assistant",
      content,
      metadata,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  await supabase
    .from("chat_threads")
    .update({
      updated_at: new Date().toISOString(),
    })
    .eq("id", thread.id);

  return data || {};
}

async function getUserEmail(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  const email = data?.user?.email;

  if (error || !email) {
    throw (
      error || new Error("Scheduled task user does not have an email address.")
    );
  }

  return email;
}

async function getScheduledResultThread(
  supabase: ReturnType<typeof createAdminClient>,
  userEmail: string,
  sourceThreadId?: string,
) {
  if (sourceThreadId) {
    const { data: sourceThread, error } = await supabase
      .from("chat_threads")
      .select("*")
      .eq("id", sourceThreadId)
      .eq("user_email", userEmail)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (sourceThread) {
      return sourceThread;
    }
  }

  return getOrCreateMainChatThread(supabase, userEmail);
}

async function getOrCreateMainChatThread(
  supabase: ReturnType<typeof createAdminClient>,
  userEmail: string,
) {
  const { data: existing, error: selectError } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("user_email", userEmail)
    .eq("type", "main")
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

  if (existing) {
    return existing;
  }

  const { data, error } = await supabase
    .from("chat_threads")
    .insert({
      user_email: userEmail,
      type: "main",
      title: "Main Chat",
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

function formatScheduledSuccessMessage(
  schedule: JsonRecord,
  output: JsonRecord,
) {
  const title = getString(schedule.title) || "Scheduled task";
  const resultText = getScheduledResultText(output);

  return [`Scheduled task complete: ${title}`, "", resultText]
    .filter(Boolean)
    .join("\n");
}

function formatScheduledFailureMessage(
  schedule: JsonRecord,
  errorMessage: string,
) {
  const title = getString(schedule.title) || "Scheduled task";
  return `Scheduled task failed: ${title}\n\n${errorMessage}`;
}

function getScheduledResultText(output: JsonRecord) {
  const composio = toJsonRecord(output.composio);
  const composioResult = toJsonRecord(composio.toolResult);
  const composioSummary = getComposioResultSummary(composioResult);
  if (
    composioSummary &&
    (getString(output.delivery) || "chat").toLowerCase() !== "chat"
  ) {
    return composioSummary;
  }

  const ai = toJsonRecord(output.ai);
  const openAiText = getString(ai.outputText);
  if (openAiText) {
    return openAiText;
  }

  const message = getString(output.message);
  if (message) {
    return message;
  }

  const browserbase = toJsonRecord(output.browserbase);
  const browserSummary =
    getString(browserbase.summary) || getString(browserbase.result);
  if (browserSummary) {
    return browserSummary;
  }

  if (composioSummary) {
    return composioSummary;
  }

  return summarizeOutput(output);
}

function getComposioResultSummary(result: JsonRecord) {
  return (
    getString(result.summary) ||
    getString(result.message) ||
    getString(result.result) ||
    getString(result.text) ||
    getString(result.output)
  );
}

function toJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function getRequiredString(record: JsonRecord, key: string) {
  const value = getString(record[key]);
  if (!value) {
    throw new Error(`Scheduled task is missing ${key}.`);
  }
  return value;
}

function getFirstString(
  schedule: JsonRecord,
  payload: JsonRecord,
  keys: string[],
) {
  for (const key of keys) {
    const value = getString(schedule[key]) || getString(payload[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function getFirstRecord(
  schedule: JsonRecord,
  payload: JsonRecord,
  keys: string[],
) {
  for (const key of keys) {
    const value = toJsonRecord(schedule[key]);
    if (Object.keys(value).length > 0) {
      return value;
    }

    const payloadValue = toJsonRecord(payload[key]);
    if (Object.keys(payloadValue).length > 0) {
      return payloadValue;
    }
  }

  return undefined;
}

function getBoolean(
  schedule: JsonRecord,
  payload: JsonRecord,
  snakeKey: string,
  camelKey: string,
) {
  const rawValue =
    schedule[snakeKey] ??
    schedule[camelKey] ??
    payload[snakeKey] ??
    payload[camelKey];

  if (typeof rawValue === "boolean") {
    return rawValue;
  }

  if (typeof rawValue === "string") {
    if (rawValue.toLowerCase() === "true") {
      return true;
    }

    if (rawValue.toLowerCase() === "false") {
      return false;
    }
  }

  return undefined;
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function createAdminClient() {
  const supabaseUrl = mustGetEnv("SUPABASE_URL");
  const serviceRoleKey = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function resolveUser(
  req: Request,
  supabase: ReturnType<typeof createAdminClient>,
  fallbackUserId?: string,
) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data.user) {
      return data.user;
    }
  }

  if (fallbackUserId) {
    return { id: fallbackUserId };
  }

  throw new Error("Unauthorized: send a Supabase user JWT or userId.");
}

async function listComposioAccounts(userId: string) {
  const params = new URLSearchParams();
  params.append("user_ids", userId);
  params.append("statuses", "ACTIVE");

  return composioFetch(`/api/v3.1/connected_accounts?${params.toString()}`, {
    method: "GET",
  });
}

async function executeComposioTool({
  toolSlug,
  userId,
  text,
  args,
  connectedAccounts,
  executionId,
  anotherToolExpected = false,
}: {
  toolSlug: string;
  userId: string;
  text?: string;
  args?: JsonRecord;
  connectedAccounts: JsonRecord[];
  executionId: string;
  anotherToolExpected?: boolean;
}) {
  const matchingAccount = connectedAccounts.find((account) => {
    const toolkitSlug = getAccountToolkitSlug(account);
    return toolkitSlug
      ? toolSlug.toLowerCase().startsWith(`${toolkitSlug}_`)
      : false;
  });

  const payload: JsonRecord = {
    user_id: userId,
    ...(matchingAccount?.id
      ? { connected_account_id: matchingAccount.id }
      : {}),
    arguments: args || {
      text: text || "Run this tool for the scheduled task.",
    },
  };

  const startedAt = Date.now();
  logEdgeAgentEvent("Tool selected", executionId, {
    integration: getToolkitSlugFromToolSlug(toolSlug) || "composio",
    tool: toolSlug,
    argument_keys: safeArgumentKeys(payload.arguments),
  });
  logEdgeAgentEvent("Tool execution started", executionId, { tool: toolSlug });
  try {
    const result = await composioFetch(
      `/api/v3.1/tools/execute/${encodeURIComponent(toolSlug)}`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    logEdgeAgentEvent("Tool execution completed", executionId, {
      tool: toolSlug,
      duration_ms: Date.now() - startedAt,
      status: "success",
      another_tool_selected: anotherToolExpected,
    });
    return result;
  } catch (error) {
    logEdgeAgentEvent("Tool execution failed", executionId, {
      tool: toolSlug,
      duration_ms: Date.now() - startedAt,
      status: "failed",
      error: safeEdgeErrorMessage(error),
    });
    throw error;
  }
}

async function runBrowserbaseAgent({
  task,
  poll,
  executionId,
}: {
  task: string;
  poll: boolean;
  executionId: string;
}) {
  const startedAt = Date.now();
  logEdgeAgentEvent("Tool selected", executionId, {
    integration: "browserbase",
    tool: "browserbase_agent_run",
  });
  logEdgeAgentEvent("Browserbase run started", executionId, {
    requested_domain: safeEdgeDomain(task),
  });
  logEdgeAgentEvent("Tool execution started", executionId, {
    tool: "browserbase_agent_run",
  });
  try {
    const run = await browserbaseFetch("/v1/agents/runs", {
      method: "POST",
      body: JSON.stringify({
        task,
        resultSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            sourceUrl: { type: "string" },
          },
        },
      }),
    });

    let result = run;
    if (poll && run.runId) {
      const completed = await pollBrowserbaseRun(String(run.runId));
      const sessionId = completed.sessionId ? String(completed.sessionId) : "";
      const liveView = sessionId
        ? await getBrowserbaseLiveView(sessionId)
        : null;

      result = {
        ...completed,
        liveViewUrl:
          liveView?.debuggerFullscreenUrl || liveView?.debuggerUrl || null,
      };
    }

    const runStatus = String(result.status || "completed").toLowerCase();
    logEdgeAgentEvent(
      ["completed", "success", "succeeded"].includes(runStatus)
        ? "Browserbase run completed"
        : "Browserbase run failed",
      executionId,
      {
        source_domain: safeEdgeDomain(getString(result.sourceUrl)),
        duration_ms: Date.now() - startedAt,
        status: runStatus,
        error: ["completed", "success", "succeeded"].includes(runStatus)
          ? undefined
          : safeEdgeErrorMessage(result.error || result.message || runStatus),
      },
    );
    return result;
  } catch (error) {
    logEdgeAgentEvent("Tool execution failed", executionId, {
      tool: "browserbase_agent_run",
      duration_ms: Date.now() - startedAt,
      status: "failed",
      error: safeEdgeErrorMessage(error),
    });
    throw error;
  }
}

async function pollBrowserbaseRun(runId: string) {
  const terminalStatuses = new Set([
    "COMPLETED",
    "FAILED",
    "STOPPED",
    "TIMED_OUT",
    "PAUSED",
  ]);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await browserbaseFetch(
      `/v1/agents/runs/${encodeURIComponent(runId)}`,
      {
        method: "GET",
      },
    );

    if (terminalStatuses.has(String(run.status))) {
      return run;
    }

    await sleep(1500);
  }

  return browserbaseFetch(`/v1/agents/runs/${encodeURIComponent(runId)}`, {
    method: "GET",
  });
}

async function getBrowserbaseLiveView(sessionId: string) {
  return browserbaseFetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/debug?expiresIn=3600`,
    {
      method: "GET",
    },
  );
}

async function composioFetch(path: string, init: RequestInit) {
  const url = `${getEnv("COMPOSIO_BASE_URL") || "https://backend.composio.dev"}${path}`;

  try {
    return await apiFetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": mustGetEnv("COMPOSIO_API_KEY"),
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/access|permission|forbidden|unauthorized/i.test(message)) {
      throw new Error(
        `${message}. Check that the Supabase Edge Function COMPOSIO_API_KEY is a project API key with Composio connected-accounts read access and sessions/tool-router search + execute access.`,
      );
    }
    throw error;
  }
}

async function browserbaseFetch(path: string, init: RequestInit) {
  return apiFetch(`https://api.browserbase.com${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-BB-API-Key": mustGetEnv("BROWSERBASE_API_KEY"),
      ...(init.headers || {}),
    },
  });
}

async function apiFetch(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data: unknown = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    throw new Error(
      `${url} failed (${response.status}): ${JSON.stringify(data)}`,
    );
  }

  return toJsonRecord(data);
}

function sanitizeComposioAccounts(accounts: JsonRecord[]) {
  return accounts.map((account) => ({
    id: account.id,
    status: account.status,
    toolkit: account.toolkit,
    authConfig: account.auth_config || account.authConfig,
    alias: account.alias,
    userId: account.user_id || account.userId,
  }));
}

function getAccountToolkitSlug(account: JsonRecord) {
  return (
    getString(toJsonRecord(account.toolkit).slug) ||
    getString(account.toolkit_slug) ||
    getString(account.toolkitSlug) ||
    getString(
      toJsonRecord(account.auth_config || account.authConfig).toolkit_slug,
    ) ||
    getString(
      toJsonRecord(account.auth_config || account.authConfig).toolkitSlug,
    )
  )?.toLowerCase();
}

function extractOpenAiOutputText(response: JsonRecord) {
  const directOutput = getString(response.output_text);
  if (directOutput) {
    return directOutput;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const textParts = output.flatMap((item) => {
    const content = toJsonRecord(item).content;
    if (!Array.isArray(content)) {
      return [];
    }

    return content
      .map((part) => {
        const record = toJsonRecord(part);
        return getString(record.text) || getString(record.output_text);
      })
      .filter(Boolean);
  });

  return textParts.join("\n").trim() || null;
}

function extractChatCompletionOutputText(response: JsonRecord) {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  return (
    choices
      .map((choice) =>
        getString(toJsonRecord(toJsonRecord(choice).message).content),
      )
      .filter(Boolean)
      .join("\n")
      .trim() || null
  );
}

function shouldDraftWithOpenAiBeforeComposio(
  delivery: string,
  toolkitSlug?: string,
  toolSlug?: string,
) {
  const target = (
    toolkitSlug ||
    getToolkitSlugFromToolSlug(toolSlug || "") ||
    delivery
  ).toLowerCase();
  return ["slack", "gmail", "googlesheets", "googledocs", "notion"].includes(
    target,
  );
}

function inferComposioPlanForDelivery({
  delivery,
  task,
  payload,
  aiText,
}: {
  delivery: string;
  task?: string;
  payload: JsonRecord;
  aiText?: string;
}) {
  const toolkitSlug = getToolkitSlugForDelivery(delivery);

  if (!toolkitSlug) {
    return null;
  }

  if (toolkitSlug === "slack") {
    const argumentsPayload = buildSlackMessageArguments({
      task,
      payload,
      aiText,
      existingArguments: getFirstRecord({}, payload, [
        "composio_arguments",
        "composioArguments",
      ]),
    });

    return {
      toolkitSlug,
      useCase: "Send a message to a Slack channel",
      text:
        argumentsPayload.text || task || "Send the scheduled Slack message.",
      arguments: argumentsPayload,
    };
  }

  return {
    toolkitSlug,
    useCase: getComposioUseCaseForDelivery(delivery, task),
    text: aiText || task || `Run the scheduled ${delivery} task.`,
    arguments: getFirstRecord({}, payload, [
      "composio_arguments",
      "composioArguments",
    ]),
  };
}

function getToolkitSlugForDelivery(delivery: string) {
  const normalized = delivery.toLowerCase();
  const deliveryToolkits: Record<string, string> = {
    slack: "slack",
    email: "gmail",
    gmail: "gmail",
    mail: "gmail",
    calendar: "googlecalendar",
    google_calendar: "googlecalendar",
    notion: "notion",
    teams: "microsoftteams",
    discord: "discord",
  };

  return deliveryToolkits[normalized];
}

function inferDeliveryFromText(text?: string) {
  if (!text) {
    return undefined;
  }

  const deliveryRules: Array<[RegExp, string]> = [
    [/\b(slack|channel)\b/, "slack"],
    [
      /\b(email|mail|gmail|inbox)\b.*\b(me|to|send)|\b(email|mail|gmail)\s+me\b/,
      "email",
    ],
    [/\b(calendar|event|meeting)\b/, "calendar"],
    [/\bnotion\b/, "notion"],
    [/\b(teams|microsoft teams)\b/, "teams"],
    [/\bdiscord\b/, "discord"],
  ];

  for (const [pattern, delivery] of deliveryRules) {
    if (pattern.test(text.toLowerCase())) {
      return delivery;
    }
  }

  return undefined;
}

function getComposioUseCaseForDelivery(delivery: string, task?: string) {
  const normalized = delivery.toLowerCase();
  const useCases: Record<string, string> = {
    email: "Send an email",
    gmail: "Send an email",
    mail: "Send an email",
    calendar: "Create or update a calendar event",
    google_calendar: "Create or update a calendar event",
    notion: "Create or update a Notion page",
    teams: "Send a Microsoft Teams message",
    discord: "Send a Discord message",
  };

  return (
    useCases[normalized] ||
    task ||
    `Run the scheduled ${formatDeliveryName(delivery)} task.`
  );
}

function buildSlackMessageArguments({
  task,
  payload,
  aiText,
  existingArguments,
}: {
  task?: string;
  payload: JsonRecord;
  aiText?: string;
  existingArguments?: JsonRecord;
}) {
  const existing = existingArguments || {};
  const channel =
    getString(existing.channel) ||
    getString(existing.channel_id) ||
    getString(existing.channelId) ||
    getString(payload.channel) ||
    extractSlackChannel(task || "");
  const text =
    getString(existing.text) ||
    getString(existing.message) ||
    aiText ||
    inferGreetingMessage(task || "") ||
    task ||
    "Good morning!";

  return {
    ...existing,
    ...(channel ? { channel } : {}),
    text,
  };
}

function assertConnectedToolkitAvailable(
  toolkitSlug: string | undefined,
  connectedAccounts: JsonRecord[],
) {
  if (!toolkitSlug) {
    return;
  }

  const hasMatchingAccount = connectedAccounts.some((account) => {
    return getAccountToolkitSlug(account) === toolkitSlug;
  });

  if (!hasMatchingAccount) {
    throw new Error(
      `Missing connected ${formatDeliveryName(toolkitSlug)} account. Connect ${formatDeliveryName(toolkitSlug)} before this scheduled task can run.`,
    );
  }
}

function getToolkitSlugFromToolSlug(toolSlug: string) {
  const normalized = toolSlug.trim().toLowerCase();
  const firstPart = normalized.split("_")[0];
  return firstPart || undefined;
}

async function executeComposioAppUseCase({
  toolkitSlug,
  userId,
  useCase,
  args,
  connectedAccounts,
  executionId,
  anotherToolExpected = false,
}: {
  toolkitSlug: string;
  userId: string;
  useCase: string;
  args?: JsonRecord;
  connectedAccounts: JsonRecord[];
  executionId: string;
  anotherToolExpected?: boolean;
}) {
  assertConnectedToolkitAvailable(toolkitSlug, connectedAccounts);
  logEdgeAgentEvent("Tool search started", executionId, {
    integration: toolkitSlug,
    argument_keys: safeArgumentKeys(args),
  });

  const session = await createComposioToolRouterSession({
    userId,
    toolkitSlug,
    connectedAccounts,
  });
  const sessionId = getRequiredResponseString(
    session,
    "session_id",
    "Composio session",
  );
  let search: JsonRecord;
  try {
    search = await searchComposioSessionTools({
      sessionId,
      useCase,
      args,
    });
  } catch (error) {
    logEdgeAgentEvent("Tool search failed", executionId, {
      integration: toolkitSlug,
      error: safeEdgeErrorMessage(error),
    });
    throw error;
  }
  const toolSlug = getFirstComposioSearchToolSlug(search);

  if (!toolSlug) {
    logEdgeAgentEvent("Tool selection failed", executionId, {
      integration: toolkitSlug,
      reason: "no_matching_tool_returned",
    });
    throw new Error(
      `Composio could not find a ${formatDeliveryName(toolkitSlug)} tool for: ${useCase}`,
    );
  }

  logEdgeAgentEvent("Tool selected", executionId, {
    integration: toolkitSlug,
    tool: toolSlug,
    argument_keys: safeArgumentKeys(args),
  });
  return executeComposioSessionTool({
    sessionId,
    toolSlug,
    args,
    executionId,
    anotherToolExpected,
  });
}

async function createComposioToolRouterSession({
  userId,
  toolkitSlug,
  connectedAccounts,
}: {
  userId: string;
  toolkitSlug: string;
  connectedAccounts: JsonRecord[];
}) {
  const connectedAccountIds = connectedAccounts
    .filter((account) => getAccountToolkitSlug(account) === toolkitSlug)
    .map((account) => getString(account.id))
    .filter(Boolean);

  return composioFetch("/api/v3.1/tool_router/session", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      toolkits: { enable: [toolkitSlug] },
      ...(connectedAccountIds.length > 0
        ? { connected_accounts: { [toolkitSlug]: connectedAccountIds } }
        : {}),
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 5,
        require_explicit_selection: false,
      },
      manage_connections: {
        enable: true,
      },
    }),
  });
}

async function searchComposioSessionTools({
  sessionId,
  useCase,
  args,
}: {
  sessionId: string;
  useCase: string;
  args?: JsonRecord;
}) {
  return composioFetch(
    `/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        queries: [
          {
            use_case: useCase.slice(0, 1024),
            ...(args && Object.keys(args).length > 0
              ? { known_fields: formatKnownFields(args).slice(0, 500) }
              : {}),
          },
        ],
      }),
    },
  );
}

async function executeComposioSessionTool({
  sessionId,
  toolSlug,
  args,
  executionId,
  anotherToolExpected = false,
}: {
  sessionId: string;
  toolSlug: string;
  args?: JsonRecord;
  executionId: string;
  anotherToolExpected?: boolean;
}) {
  const startedAt = Date.now();
  logEdgeAgentEvent("Tool execution started", executionId, { tool: toolSlug });
  try {
    const result = await composioFetch(
      `/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
      {
        method: "POST",
        body: JSON.stringify({
          tool_slug: toolSlug,
          arguments: args || {},
        }),
      },
    );
    logEdgeAgentEvent("Tool execution completed", executionId, {
      tool: toolSlug,
      duration_ms: Date.now() - startedAt,
      status: "success",
      another_tool_selected: anotherToolExpected,
    });
    return result;
  } catch (error) {
    logEdgeAgentEvent("Tool execution failed", executionId, {
      tool: toolSlug,
      duration_ms: Date.now() - startedAt,
      status: "failed",
      error: safeEdgeErrorMessage(error),
    });
    throw error;
  }
}

function getFirstComposioSearchToolSlug(search: JsonRecord) {
  const results = Array.isArray(search.results) ? search.results : [];
  for (const result of results) {
    const record = toJsonRecord(result);
    const rawSlugs = record.primary_tool_slugs || record.primaryToolSlugs;
    if (!Array.isArray(rawSlugs)) {
      continue;
    }

    const slug = rawSlugs.map(getString).find(Boolean);
    if (slug) {
      return slug;
    }
  }

  const schemas = toJsonRecord(search.tool_schemas);
  const firstSchemaSlug = Object.keys(schemas)[0];
  if (firstSchemaSlug) {
    return firstSchemaSlug;
  }

  const camelSchemas = toJsonRecord(search.toolSchemas);
  return Object.keys(camelSchemas)[0];
}

function getRequiredResponseString(
  record: JsonRecord,
  key: string,
  label: string,
) {
  const value = getString(record[key]);
  if (!value) {
    throw new Error(`${label} response is missing ${key}.`);
  }
  return value;
}

function formatKnownFields(args: JsonRecord) {
  return Object.entries(args)
    .map(
      ([key, value]) =>
        `${key}:${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(", ");
}

function extractSlackChannel(text: string) {
  const hashMatch = text.match(/#[A-Za-z0-9_-]+/);
  if (hashMatch?.[0]) {
    return hashMatch[0];
  }

  const channelMatch = text.match(/\bchannel\s+([A-Za-z0-9_-]+)/i);
  if (channelMatch?.[1]) {
    return `#${channelMatch[1].replace(/^#/, "")}`;
  }

  return undefined;
}

function inferGreetingMessage(task: string) {
  if (!/\bgreeting\b|\bgood\s+morning\b|\bmorning\b/i.test(task)) {
    return undefined;
  }

  return "Good morning! Hope you have a great day.";
}

function formatDeliveryName(value: string) {
  return (
    value
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "tool"
  );
}

function summarizeOutput(output: JsonRecord) {
  const summary = JSON.stringify(output);
  return summary.length > 1000 ? `${summary.slice(0, 1000)}...` : summary;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mustGetEnv(name: string) {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

function createEdgeExecutionId() {
  return crypto.randomUUID();
}

function logEdgeAgentEvent(
  event: string,
  executionId: string,
  details: Record<string, unknown> = {},
) {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatEdgeField(value)}`)
    .join(" | ");
  console.info(
    `[Agent] ${event} | id=${formatEdgeField(executionId)}${fields ? ` | ${fields}` : ""}`,
  );
}

function safeEdgeSummary(value: unknown, maxLength = 120) {
  if (typeof value !== "string") return "<unavailable>";
  return sanitizeEdgeLogText(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeEdgeErrorMessage(error: unknown, maxLength = 180) {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeEdgeLogText(message)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeEdgeDomain(value: unknown) {
  if (typeof value !== "string") return "unknown";
  const url = value.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
  if (!url) return "unknown";
  try {
    return new URL(url).hostname.replace(/^www\./i, "").slice(0, 100);
  } catch {
    return "unknown";
  }
}

function safeArgumentKeys(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "none";
  }
  const keys = Object.keys(value)
    .filter(
      (key) =>
        !/(token|secret|password|credential|cookie|auth|emailbody)/i.test(key),
    )
    .slice(0, 12);
  return keys.length ? keys.join(",") : "none";
}

function formatEdgeField(value: unknown) {
  const text = sanitizeEdgeLogText(String(value));
  return /[\s|"\\]/.test(text) ? JSON.stringify(text) : text;
}

function sanitizeEdgeLogText(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b\d{13,19}\b/g, "[REDACTED_NUMBER]")
    .replace(/https?:\/\/[^\s)]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
      } catch {
        return "[URL]";
      }
    });
}

function getEnv(name: string) {
  return Deno.env.get(name)?.trim();
}
