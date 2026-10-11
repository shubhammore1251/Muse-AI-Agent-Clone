// import assert from "node:assert/strict";
// import test from "node:test";

// import {
//     classifyUserIntent,
//     parseScheduleIntentWithAgent,
//     type UserIntentClassification,
// } from "./scheduleIntentAgent";

// const assertIntent = (
//   text: string,
//   expectedIntent: UserIntentClassification["intent"],
// ) => {
//   const result = classifyUserIntent(text);
//   assert.equal(result.intent, expectedIntent);
// };

// test("browser research without a URL is routed to browser_research", () => {
//   assertIntent(
//     "Research the latest Node.js LTS release and summarize the official announcement.",
//     "browser_research",
//   );
// });

// test("current sports scores are routed to browser research", () => {
//   assertIntent(
//     "Find the score for India versus West Indies at 3:30.",
//     "browser_research",
//   );
// });

// test("explicit URL browser tasks stay in browser_research", () => {
//   assertIntent(
//     "Open google.com and search for the latest Node.js LTS release. Inspect the official Node.js source and summarize the result with a link.",
//     "browser_research",
//   );
// });

// test("latest email actions stay immediate and not recurring", () => {
//   assertIntent("Read my five latest emails.", "immediate_action");
// });

// test("one-time Google Meet requests are not recurring schedules", () => {
//   assertIntent(
//     "Schedule a Google Meet for tomorrow at 3 PM.",
//     "immediate_action",
//   );
// });

// test("one-time calendar events on a future weekday are not recurring", () => {
//   assertIntent(
//     "Create a Google Calendar event for next Monday at 3 PM.",
//     "immediate_action",
//   );
// });

// test("recurring inbox monitoring stays in recurring_task", () => {
//   assertIntent("Check my inbox every morning.", "recurring_task");
// });

// test("the requested inbox task produces a confirmation proposal", async () => {
//   const previousApiKey = process.env.OPENAI_API_KEY;
//   delete process.env.OPENAI_API_KEY;

//   try {
//     const text = "Check my inbox every morning and send me a summary.";
//     assertIntent(text, "recurring_task");

//     const proposal = await parseScheduleIntentWithAgent({
//       text,
//       timezone: "America/Los_Angeles",
//     });

//     assert.ok(proposal);
//     assert.equal(proposal.scheduleRule.frequency, "daily");
//     assert.equal(proposal.scheduleRule.time, "08:00");
//     assert.equal(proposal.delivery, "email");
//     assert.equal(proposal.originalPrompt, text);
//     assert.equal(proposal.taskPayload.task, text);
//   } finally {
//     if (previousApiKey === undefined) {
//       delete process.env.OPENAI_API_KEY;
//     } else {
//       process.env.OPENAI_API_KEY = previousApiKey;
//     }
//   }
// });

// test("the proposal model cannot veto an explicitly recurring request", async () => {
//   const previousApiKey = process.env.OPENAI_API_KEY;
//   const previousFetch = globalThis.fetch;
//   process.env.OPENAI_API_KEY = "test-key";
//   globalThis.fetch = async () =>
//     new Response(JSON.stringify({ output_text: '{"intent":"normal_chat"}' }), {
//       status: 200,
//       headers: { "Content-Type": "application/json" },
//     });

//   try {
//     const proposal = await parseScheduleIntentWithAgent({
//       text: "Check my inbox every morning and send me a summary.",
//       timezone: "America/Los_Angeles",
//     });

//     assert.ok(proposal);
//     assert.equal(proposal.scheduleRule.frequency, "daily");
//     assert.equal(proposal.delivery, "email");
//   } finally {
//     globalThis.fetch = previousFetch;
//     if (previousApiKey === undefined) {
//       delete process.env.OPENAI_API_KEY;
//     } else {
//       process.env.OPENAI_API_KEY = previousApiKey;
//     }
//   }
// });

// test("ambiguous requests require clarification", () => {
//   assertIntent("Schedule this", "clarification_required");
// });

// test("follow-up choices resolve the original request without misrouting", () => {
//   const result = classifyUserIntent("do it now");
//   assert.equal(result.intent, "clarification_follow_up");
//   assert.equal(result.choice, "immediate");
// });
