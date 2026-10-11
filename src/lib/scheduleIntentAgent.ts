import { ScheduleConfirmation } from "@/types";

type ScheduleIntentResult =
  | { intent: "normal_chat" }
  | ({ intent: "schedule_task" } & ScheduleConfirmation);

export type UserIntentClassification =
  | {
      intent: "immediate_action";
      originalText: string;
      reason: string;
    }
  | {
      intent: "browser_research";
      originalText: string;
      reason: string;
    }
  | {
      intent: "recurring_task";
      originalText: string;
      reason: string;
      requiresMoreDetails?: boolean;
      needsScheduleDetails?: boolean;
    }
  | {
      intent: "clarification_required";
      originalText: string;
      reason: string;
    }
  | {
      intent: "clarification_follow_up";
      originalText: string;
      choice: "immediate" | "recurring";
      reason: string;
    };

const SCHEDULE_INTENT_PROMPT = `
You are Muse AI's schedule intent parser.

Decide whether the user's message is asking to create a recurring or future scheduled task.

Return JSON only. Do not include markdown.

If the user is not asking to schedule anything, return:
{
  "intent": "normal_chat"
}

If the user is asking to schedule something, return:
{
  "intent": "schedule_task",
  "title": "Short human-readable title",
  "originalPrompt": "The user's exact message",
  "taskType": "generic_prompt",
  "taskPayload": {},
  "scheduleRule": {
    "frequency": "daily" | "weekly",
    "time": "HH:mm",
    "weekday": "monday"
  },
  "timezone": "User timezone if known, otherwise UTC",
  "delivery": "chat | slack | email | sms | whatsapp | teams | discord | notion | calendar | webhook | app",
  "summary": "Short confirmation summary"
}

Rules:
- Use 24-hour HH:mm time.
- If the user says morning without a time, use 08:00.
- If the user says evening without a time, use 18:00.
- If the user says night without a time, use 21:00.
- Always use taskType "generic_prompt".
- Set delivery to the requested destination. For example, "send to Slack" means delivery "slack"; "email me" means delivery "email"; no explicit destination means delivery "chat".
- Put the full user request in taskPayload.prompt and taskPayload.task.
- Set taskPayload.useOpenAi to true.
- If the saved task requires visiting a website, web research, checking current web content, filling a web form, or browser automation, set taskPayload.browserTask to the exact browser task to perform and taskPayload.pollBrowserbase to true.
- Never create the schedule directly. The app must show a confirmation card first.
`.trim();

export function classifyUserIntent(text: string): UserIntentClassification {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      intent: "clarification_required",
      originalText: text,
      reason: "The message is empty.",
    };
  }

  const normalized = trimmed.toLowerCase();

  if (isAmbiguousScheduleRequest(normalized)) {
    return {
      intent: "clarification_required",
      originalText: trimmed,
      reason:
        "The wording does not clearly say whether this should run once or recur.",
    };
  }

  const followUpChoice = classifyClarificationFollowUp(normalized);
  if (followUpChoice) {
    return {
      intent: "clarification_follow_up",
      originalText: trimmed,
      choice: followUpChoice,
      reason: `User selected ${followUpChoice} from the clarification prompt.`,
    };
  }

  if (isExplicitRecurringTaskRequest(normalized)) {
    return {
      intent: "recurring_task",
      originalText: trimmed,
      reason: "This request describes a repeating workflow or schedule.",
      requiresMoreDetails:
        /\b(repeat|every|each)\b/i.test(trimmed) &&
        !/\b(at\s+\d\d?:?\d{0,2}\s*(a|p)m|\b\d{1,2}:\d{2}\b)/i.test(trimmed),
      needsScheduleDetails:
        /\b(repeat|every|each)\b/i.test(trimmed) &&
        !/\b(at\s+\d\d?:?\d{0,2}\s*(a|p)m|\b\d{1,2}:\d{2}\b)/i.test(trimmed),
    };
  }

  if (isBrowserResearchRequest(normalized)) {
    return {
      intent: "browser_research",
      originalText: trimmed,
      reason: "This request needs live research on current web results.",
    };
  }

  if (isLiveResultsRequest(normalized)) {
    return {
      intent: "browser_research",
      originalText: trimmed,
      reason:
        "This request needs current results from a live information source.",
    };
  }

  if (isImmediateActionRequest(normalized)) {
    return {
      intent: "immediate_action",
      originalText: trimmed,
      reason:
        "This request is a one-time tool action without a recurring schedule.",
    };
  }

  return {
    intent: "immediate_action",
    originalText: trimmed,
    reason: "This is a normal one-off chat or tool request.",
  };
}

export function isExplicitRecurringTaskRequest(normalized: string) {
  if (!isRecurringTaskRequest(normalized)) {
    return false;
  }

  return !isOneTimeToolActionRequest(normalized);
}

export async function parseScheduleIntentWithAgent({
  text,
  timezone,
}: {
  text: string;
  timezone?: string;
}): Promise<ScheduleConfirmation | null> {
  if (
    !text.trim() ||
    !isExplicitRecurringTaskRequest(text.trim().toLowerCase()) ||
    classifyUserIntent(text).intent !== "recurring_task"
  ) {
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return createFallbackScheduleConfirmation(text, timezone);
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:
          process.env.OPENAI_SCHEDULE_MODEL ||
          process.env.OPENAI_AGENT_MODEL ||
          "gpt-5-nano",
        input: [
          {
            role: "system",
            content: SCHEDULE_INTENT_PROMPT,
          },
          {
            role: "user",
            content: JSON.stringify({
              userMessage: text,
              userTimezone: timezone || "UTC",
            }),
          },
        ],
      }),
    });

    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};

    if (response.ok) {
      const parsed = parseJsonOutput(
        extractOutputText(data),
      ) as ScheduleIntentResult | null;
      if (parsed?.intent === "schedule_task") {
        return normalizeScheduleConfirmation(parsed, text, timezone);
      }
    }
  } catch (error) {
    console.warn(
      "[scheduleIntentAgent] Proposal parser unavailable; using classified recurring request:",
      error,
    );
  }

  return createFallbackScheduleConfirmation(text, timezone);
}

function createFallbackScheduleConfirmation(
  originalText: string,
  timezone?: string,
): ScheduleConfirmation {
  const normalized = originalText.toLowerCase();
  const weekly = /\b(weekly|weekdays?|weekends?|every\s+week)\b/.test(
    normalized,
  );
  const weekday = normalized.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  )?.[1];
  const time = inferScheduleTime(normalized);
  const delivery = inferDeliveryFromPrompt(originalText) || "chat";
  const taskPayload: Record<string, unknown> = {
    prompt: originalText,
    task: originalText,
    useOpenAi: true,
  };

  enrichPayloadForBrowserbase(taskPayload, originalText);
  enrichPayloadForDelivery(taskPayload, delivery, originalText);

  return {
    title: originalText.replace(/[.!?]+$/, "").slice(0, 100),
    originalPrompt: originalText,
    taskType: "generic_prompt",
    taskPayload,
    scheduleRule: {
      frequency: weekly ? "weekly" : "daily",
      time,
      ...(weekly && weekday ? { weekday } : {}),
    },
    timezone: timezone || "UTC",
    delivery,
    summary: `Muse AI will run this ${weekly ? "weekly" : "daily"} at ${time} and deliver the result to ${formatDeliveryLabel(delivery)}.`,
  };
}

function inferScheduleTime(normalized: string) {
  const explicitTime = normalized.match(
    /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/,
  );
  if (explicitTime) {
    let hour = Number(explicitTime[1]);
    const minute = Number(explicitTime[2] || "0");
    const meridiem = explicitTime[3];
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }

  if (/\b(evening|afternoon)\b/.test(normalized)) return "18:00";
  if (/\bnight\b/.test(normalized)) return "21:00";
  return "08:00";
}

function classifyClarificationFollowUp(normalized: string) {
  const followUp = normalized.trim();
  if (
    /(^|\s)(do it now|do this now|execute now|run it now)(\s|$)/.test(followUp)
  ) {
    return "immediate" as const;
  }

  if (
    /(^|\s)(schedule it|set it up|do it on a schedule)(\s|$)/.test(followUp)
  ) {
    return "recurring" as const;
  }

  return null;
}

function isRecurringTaskRequest(normalized: string) {
  const recurrenceSignal =
    /\b(every|each|repeat|recurring|daily|weekly|monthly|yearly|weekdays?|weekends?|every\s+\d+\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months))\b/i.test(
      normalized,
    );

  const hasActionVerb =
    /\b(run|check|summarize|report|monitor|remind|send|search|scan|review|watch|track|sync|read|fetch|pull|email|message|notify)/i.test(
      normalized,
    );

  if (!recurrenceSignal) {
    return false;
  }

  return hasActionVerb || /\b(repeat|every|each)\b/i.test(normalized);
}

function isBrowserResearchRequest(normalized: string) {
  const travelResearch =
    /(find|search|look up|compare|research|browse).*\b(flight|flights|hotel|hotels|ticket|tickets|travel|traveling|fare|fares)\b|\b(flight|flights|hotel|hotels|ticket|tickets|travel|fare|fares)\b.*(tomorrow|next month|today|weekend|from|to|cheapest|best)/i.test(
      normalized,
    );

  const webSearch =
    /(search|look up|find|research|browse|google).*\b(web|website|site|news|current|price|prices|availability|listing|listings|official|source|documentation|docs|release|announcement|funding)\b|\b(website|web|site|news|price|prices|availability|official|source|documentation|docs|release|announcement|funding)\b.*(search|look up|find|research|browse)/i.test(
      normalized,
    );

  const liveResearch =
    /(research|look up|lookup|find|compare|investigate|inspect|browse|summarize).*\b(latest|current|recent|official|upcoming|new|news|pricing|price|release|announcement|funding|developments|updates|benchmarks|docs?|documentation|source)\b|\b(latest|current|recent|updated|official)\b.*\b(release|announcement|news|pricing|price|funding|developments|updates|benchmarks|docs?|documentation|source|company|service|product)\b/i.test(
      normalized,
    );

  const productFacts =
    /\b(node\.?js|react|ai|openai|anthropic|google|microsoft|apple|notion|slack|github|aws|azure|gcp|pricing|security|funding|developments|benchmarks)\b.*\b(latest|current|recent|updated|official|release|announcement|news|developments|updates|benchmarks|docs?|documentation)\b|\b(latest|current|recent|official)\b.*\b(node\.?js|react|ai|openai|anthropic|google|microsoft|apple|notion|slack|github|aws|azure|gcp|pricing|security|funding|developments|benchmarks)\b/i.test(
      normalized,
    );

  return travelResearch || webSearch || liveResearch || productFacts;
}

function isLiveResultsRequest(normalized: string) {
  return /\b(find|look up|check|get|show|tell me|what(?:'s| is))\b.*\b(live score|score|match result|sports result|showtimes?|ticket prices?|flight fares?)\b/i.test(
    normalized,
  );
}

function isImmediateActionRequest(normalized: string) {
  const emailAction =
    /(read|fetch|show|get|check|summarize|review|reply|send|forward|archive).*\b(email|emails|gmail|mail)\b|\b(email|emails|gmail|mail)\b.*(me|now|today|latest|five)/i.test(
      normalized,
    );

  const writingOrDocAction =
    /(create|make|update|edit|draft|write).*\b(note|page|document|notion|calendar event|google meet|meet|slack message|teams message|event)\b|\b(notion|calendar event|google meet|meet|slack|teams)\b.*(create|make|schedule|add|update)/i.test(
      normalized,
    );

  const oneTimeScheduling =
    /(create|schedule|book|set up).*\b(google calendar|calendar event|google meet|meet|calendly|booking|appointment)\b/i.test(
      normalized,
    ) &&
    !/\b(every|each|repeat|recurring|daily|weekly|monthly|weekdays?|weekends?)\b/i.test(
      normalized,
    );

  const directMeetingOrAction =
    /\b(send this email|create a page in notion|create a google calendar event|schedule a google meet)\b/i.test(
      normalized,
    );

  return (
    emailAction ||
    writingOrDocAction ||
    oneTimeScheduling ||
    directMeetingOrAction
  );
}

function isOneTimeToolActionRequest(normalized: string) {
  return (
    /(create|make|update|edit|draft|write|book|set up|schedule).*(google calendar|calendar event|google meet|meet|notion|slack message|teams message|gmail|email|calendar)/i.test(
      normalized,
    ) &&
    !/\b(every|each|repeat|recurring|daily|weekly|monthly|yearly|weekdays?|weekends?|every\s+\d+\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months))\b/i.test(
      normalized,
    )
  );
}

function isAmbiguousScheduleRequest(normalized: string) {
  return /\b(schedule this|schedule that|schedule this task)\b/i.test(
    normalized,
  );
}

function normalizeScheduleConfirmation(
  parsed: ScheduleIntentResult & { intent: "schedule_task" },
  originalText: string,
  timezone?: string,
): ScheduleConfirmation | null {
  const frequency =
    parsed.scheduleRule?.frequency === "weekly" ? "weekly" : "daily";
  const time = isValidTime(parsed.scheduleRule?.time)
    ? parsed.scheduleRule.time
    : "08:00";
  const weekday =
    frequency === "weekly" && typeof parsed.scheduleRule?.weekday === "string"
      ? parsed.scheduleRule.weekday.toLowerCase()
      : undefined;
  const taskPayload =
    parsed.taskPayload &&
    typeof parsed.taskPayload === "object" &&
    !Array.isArray(parsed.taskPayload)
      ? parsed.taskPayload
      : {};

  taskPayload.prompt =
    typeof taskPayload.prompt === "string" ? taskPayload.prompt : originalText;
  taskPayload.task =
    typeof taskPayload.task === "string" ? taskPayload.task : originalText;
  taskPayload.useOpenAi = taskPayload.useOpenAi ?? true;
  const delivery = normalizeDelivery((parsed as any).delivery, originalText);
  enrichPayloadForBrowserbase(taskPayload, originalText);
  enrichPayloadForDelivery(taskPayload, delivery, originalText);

  return {
    title:
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : "Scheduled Muse AI task",
    originalPrompt: originalText,
    taskType: "generic_prompt",
    taskPayload,
    scheduleRule: {
      frequency,
      time,
      ...(weekday ? { weekday } : {}),
    },
    timezone:
      typeof parsed.timezone === "string" && parsed.timezone.trim()
        ? parsed.timezone.trim()
        : timezone || "UTC",
    delivery,
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : `Muse AI will run this on schedule and deliver the result to ${formatDeliveryLabel(delivery)}.`,
  };
}

function enrichPayloadForBrowserbase(
  taskPayload: Record<string, any>,
  originalText: string,
) {
  if (
    typeof taskPayload.browserTask === "string" &&
    taskPayload.browserTask.trim()
  ) {
    taskPayload.pollBrowserbase = taskPayload.pollBrowserbase ?? true;
    return;
  }

  if (!needsBrowserbase(originalText)) {
    return;
  }

  taskPayload.browserTask = originalText;
  taskPayload.pollBrowserbase = true;
}

function enrichPayloadForDelivery(
  taskPayload: Record<string, any>,
  delivery: string,
  originalText: string,
) {
  if (delivery !== "slack") {
    return;
  }

  taskPayload.composioToolkitSlug =
    typeof taskPayload.composioToolkitSlug === "string" &&
    taskPayload.composioToolkitSlug.trim()
      ? taskPayload.composioToolkitSlug
      : "slack";
  taskPayload.composioUseCase =
    typeof taskPayload.composioUseCase === "string" &&
    taskPayload.composioUseCase.trim()
      ? taskPayload.composioUseCase
      : "Send a message to a Slack channel";

  const channel = extractSlackChannel(originalText);
  const existingArguments =
    taskPayload.composioArguments &&
    typeof taskPayload.composioArguments === "object" &&
    !Array.isArray(taskPayload.composioArguments)
      ? taskPayload.composioArguments
      : {};

  taskPayload.composioArguments = {
    ...existingArguments,
    ...(channel ? { channel } : {}),
  };
}

function normalizeDelivery(value: unknown, originalText: string) {
  const parsed = typeof value === "string" ? value.trim().toLowerCase() : "";
  const inferred = inferDeliveryFromPrompt(originalText);
  const delivery = inferred || parsed || "chat";

  return (
    delivery
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "chat"
  );
}

function inferDeliveryFromPrompt(text: string) {
  const lower = text.toLowerCase();
  const deliveryRules: Array<[RegExp, string]> = [
    [/\b(slack|channel)\b/, "slack"],
    [
      /\b(email|mail|gmail|inbox)\b.*\b(me|to|send)|\b(email|mail|gmail)\s+me\b/,
      "email",
    ],
    [/\b(whatsapp|whats app)\b/, "whatsapp"],
    [/\b(sms|text me|text message)\b/, "sms"],
    [/\b(teams|microsoft teams)\b/, "teams"],
    [/\bdiscord\b/, "discord"],
    [/\bnotion\b/, "notion"],
    [/\bcalendar\b/, "calendar"],
    [/\bwebhook\b/, "webhook"],
  ];

  for (const [pattern, delivery] of deliveryRules) {
    if (pattern.test(lower)) {
      return delivery;
    }
  }

  return undefined;
}

function needsBrowserbase(text: string) {
  return /\b(website|webpage|site|url|browser|browse|open|visit|search the web|google|current price|latest|available|booking|book|form|checkout|login)\b/i.test(
    text,
  );
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

function formatDeliveryLabel(delivery?: string | null) {
  return (
    (delivery || "chat")
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Chat"
  );
}

function extractOutputText(response: any) {
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  return output
    .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
    .map((part: any) => part?.text || part?.output_text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseJsonOutput(text: string) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
