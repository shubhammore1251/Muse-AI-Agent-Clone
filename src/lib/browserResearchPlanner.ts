import { z } from "zod";

export const browserResearchPlanSchema = z.object({
  goal: z.string().min(1),
  entities: z.array(z.string()),
  constraints: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
    }),
  ),
  missingInformation: z.array(z.string()),
  clarificationQuestion: z.string().nullable(),
  sources: z.array(
    z.object({
      name: z.string(),
      url: z
        .string()
        .url()
        .refine((value) => {
          const protocol = new URL(value).protocol;
          return protocol === "https:" || protocol === "http:";
        }),
      rationale: z.string(),
    }),
  ),
  searchQueries: z.array(z.string()),
  comparisonCriteria: z.array(z.string()),
  completionCriteria: z.array(z.string()),
  limitations: z.array(z.string()),
});

export type BrowserResearchPlan = z.infer<typeof browserResearchPlanSchema>;

export function getRequiredBrowserResearchSources(plan: BrowserResearchPlan) {
  return plan.sources.length > 1 || plan.comparisonCriteria.length > 0 ? 2 : 1;
}

export function hasSufficientBrowserResearchEvidence(
  plan: BrowserResearchPlan,
  usefulPageReads: number,
  observedDomains: Iterable<string>,
) {
  const distinctDomains = new Set(
    [...observedDomains].filter((domain) => domain && domain !== "unknown"),
  );
  return (
    usefulPageReads > 0 &&
    distinctDomains.size >= getRequiredBrowserResearchSources(plan)
  );
}

const plannerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "goal",
    "entities",
    "constraints",
    "missingInformation",
    "clarificationQuestion",
    "sources",
    "searchQueries",
    "comparisonCriteria",
    "completionCriteria",
    "limitations",
  ],
  properties: {
    goal: { type: "string" },
    entities: { type: "array", items: { type: "string" } },
    constraints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value"],
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
      },
    },
    missingInformation: { type: "array", items: { type: "string" } },
    clarificationQuestion: { type: ["string", "null"] },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "url", "rationale"],
        properties: {
          name: { type: "string" },
          url: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
    searchQueries: { type: "array", items: { type: "string" } },
    comparisonCriteria: { type: "array", items: { type: "string" } },
    completionCriteria: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
  },
};

const plannerInstructions = `You are the research planner for Muse AI's existing Browserbase and Stagehand agent.
Create an actionable plan for the user's research goal. This plan will be executed by browser tools, so do not return a plan that merely repeats the full request as one search query.
Extract the goal, named entities, and every supplied constraint. Resolve relative dates using the supplied current date and timezone. Preserve origin/destination roles and other directional constraints.
Ask one concise clarification question only when missing information materially changes which results are relevant or makes a reliable search impossible. Do not ask about details that are already given or can be stated as a caveat. Put the essential missing details in missingInformation and set clarificationQuestion; otherwise set it to null.
Choose a small set of relevant, accessible candidate sources. Prefer the user's named website and authoritative or domain-specific sources; use search engines only to discover pages, not as the sole evidence when a source page is available. Do not invent URLs: use known canonical URLs and search URLs only when certain.
Create focused search queries from the information needed, not a verbatim copy of the whole user request. Provide comparison criteria when the request compares options, completion criteria that require observed evidence, and limitations including login, CAPTCHA, payment, or unavailable-data boundaries.
Do not claim that any page has been visited or any result observed. Return only the requested structured JSON.`;

export async function planBrowserResearch({
  request,
  timezone,
  conversationContext,
  fetchImpl = fetch,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_BROWSER_PLANNER_MODEL ||
    process.env.OPENAI_AGENT_MODEL ||
    "gpt-5-nano",
}: {
  request: string;
  timezone?: string;
  conversationContext?: Array<{ role: string; text: string }>;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  model?: string;
}): Promise<BrowserResearchPlan> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to plan browser research.");
  }

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: plannerInstructions },
        {
          role: "user",
          content: JSON.stringify({
            currentDate: new Date().toISOString().slice(0, 10),
            timezone: timezone || "UTC",
            request,
            conversationContext: conversationContext || [],
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "browser_research_plan",
          strict: true,
          schema: plannerJsonSchema,
        },
      },
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Research planner failed with status ${response.status}.`);
  }

  let responseBody: any;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error("Research planner returned invalid JSON.");
  }

  const rawPlan = extractStructuredOutput(responseBody);
  if (!rawPlan) {
    throw new Error("Research planner returned no structured plan.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPlan);
  } catch {
    throw new Error("Research planner returned malformed plan JSON.");
  }

  const plan = browserResearchPlanSchema.parse(parsed);
  if (
    !plan.clarificationQuestion &&
    plan.sources.length === 0 &&
    plan.searchQueries.length === 0
  ) {
    throw new Error(
      "Research planner returned no actionable sources or queries.",
    );
  }
  return plan;
}

function extractStructuredOutput(response: any): string | null {
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return null;
}

export function formatBrowserPlanForAgent(plan: BrowserResearchPlan) {
  return JSON.stringify({
    goal: plan.goal,
    entities: plan.entities,
    constraints: plan.constraints,
    sources: plan.sources,
    searchQueries: plan.searchQueries,
    comparisonCriteria: plan.comparisonCriteria,
    completionCriteria: plan.completionCriteria,
    limitations: plan.limitations,
  });
}
