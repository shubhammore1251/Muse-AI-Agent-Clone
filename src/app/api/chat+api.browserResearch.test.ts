// import assert from "node:assert/strict";
// import test from "node:test";

// import { POST } from "./chat+api";

// function makePlan(overrides: Record<string, unknown> = {}) {
//   return {
//     goal: "Find and compare flight options",
//     entities: ["Bombay", "New Delhi"],
//     constraints: [],
//     missingInformation: ["one-way or return"],
//     clarificationQuestion: "Do you need a one-way or return flight?",
//     sources: [],
//     searchQueries: [],
//     comparisonCriteria: [],
//     completionCriteria: [],
//     limitations: [],
//     ...overrides,
//   };
// }

// function mockPlannerResponse(
//   plan: Record<string, unknown>,
//   onRequest?: (body: any) => void,
// ) {
//   return async (_input: RequestInfo | URL, init?: RequestInit) => {
//     if (typeof init?.body === "string") onRequest?.(JSON.parse(init.body));
//     return new Response(JSON.stringify({ output_text: JSON.stringify(plan) }), {
//       status: 200,
//       headers: { "Content-Type": "application/json" },
//     });
//   };
// }

// async function postChat(messages: Array<Record<string, unknown>>) {
//   return POST(
//     new Request("http://localhost/api/chat", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         userId: "browser-planner-test-user",
//         timezone: "Asia/Kolkata",
//         messages,
//       }),
//     }),
//   );
// }

// test("browser planner clarification is returned as a normal assistant response", async () => {
//   const oldApiKey = process.env.OPENAI_API_KEY;
//   const oldFetch = globalThis.fetch;
//   process.env.OPENAI_API_KEY = "test-key";
//   globalThis.fetch = mockPlannerResponse(makePlan());

//   try {
//     const response = await postChat([
//       {
//         sender: "user",
//         text: "Find me the cheapest flights from Bombay to New Delhi for tomorrow.",
//       },
//     ]);
//     const events = (await response.text())
//       .trim()
//       .split("\n")
//       .map((line) => JSON.parse(line));
//     const final = events.find((event) => event.type === "final");

//     assert.match(final.output, /one-way or return/);
//     assert.equal(events.some((event) => event.type === "browser"), false);
//   } finally {
//     globalThis.fetch = oldFetch;
//     if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
//     else process.env.OPENAI_API_KEY = oldApiKey;
//   }
// });

// test("browser research resumes with the original request and user's clarification", async () => {
//   const oldApiKey = process.env.OPENAI_API_KEY;
//   const oldFetch = globalThis.fetch;
//   let plannerInput: any;
//   process.env.OPENAI_API_KEY = "test-key";
//   globalThis.fetch = mockPlannerResponse(
//     makePlan({
//       missingInformation: ["date"],
//       clarificationQuestion: "Which date should I check?",
//     }),
//     (body) => {
//       plannerInput = JSON.parse(body.input[1].content);
//     },
//   );

//   try {
//     const response = await postChat([
//       {
//         sender: "user",
//         text: "Find the ticket price for a movie on BookMyShow.",
//       },
//       {
//         sender: "agent",
//         text: "Before I research, I need one detail: Which city should I search in?",
//       },
//       { sender: "user", text: "Mumbai" },
//     ]);
//     const events = (await response.text())
//       .trim()
//       .split("\n")
//       .map((line) => JSON.parse(line));
//     const final = events.find((event) => event.type === "final");

//     assert.match(plannerInput.request, /BookMyShow/);
//     assert.match(plannerInput.request, /Mumbai/);
//     assert.match(final.output, /Which date should I check/);
//   } finally {
//     globalThis.fetch = oldFetch;
//     if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
//     else process.env.OPENAI_API_KEY = oldApiKey;
//   }
// });
