import { ScheduleConfirmation } from "@/types";

type ScheduleIntentResult =
  | { intent: "normal_chat" }
  | ({ intent: "schedule_task" } & ScheduleConfirmation);

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

export async function parseScheduleIntentWithAgent({
  text,
  timezone,
}: {
  text: string;
  timezone?: string;
}): Promise<ScheduleConfirmation | null> {
  if (!text.trim()) {
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

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

  if (!response.ok) {
    throw new Error(
      `Schedule intent parser failed (${response.status}): ${raw}`,
    );
  }

  const parsed = parseJsonOutput(
    extractOutputText(data),
  ) as ScheduleIntentResult | null;
  if (!parsed || parsed.intent !== "schedule_task") {
    return null;
  }

  return normalizeScheduleConfirmation(parsed, text, timezone);
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
