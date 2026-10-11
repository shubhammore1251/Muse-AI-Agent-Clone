// import assert from "node:assert/strict";
// import test from "node:test";

// import {
//   getRequiredBrowserResearchSources,
//   hasSufficientBrowserResearchEvidence,
//   planBrowserResearch,
// } from "./browserResearchPlanner";

// function plannerResponse(plan: Record<string, unknown>) {
//   return new Response(JSON.stringify({ output_text: JSON.stringify(plan) }), {
//     status: 200,
//     headers: { "Content-Type": "application/json" },
//   });
// }

// function makePlan(overrides: Record<string, unknown> = {}) {
//   return {
//     goal: "Research and compare relevant options",
//     entities: [],
//     constraints: [],
//     missingInformation: [],
//     clarificationQuestion: null,
//     sources: [{ name: "Official source", url: "https://example.com", rationale: "Primary source" }],
//     searchQueries: ["focused research query"],
//     comparisonCriteria: [],
//     completionCriteria: ["Observe relevant facts on the source pages"],
//     limitations: ["Do not sign in or make a purchase"],
//     ...overrides,
//   };
// }

// async function planWith(plan: Record<string, unknown>, request: string) {
//   return planBrowserResearch({
//     request,
//     timezone: "Asia/Kolkata",
//     apiKey: "test-key",
//     fetchImpl: async () => plannerResponse(plan),
//   });
// }

// test("flight planner preserves route and date constraints", async () => {
//   const plan = await planWith(
//     makePlan({
//       goal: "Find and compare low fares",
//       entities: ["Bombay", "New Delhi"],
//       constraints: [
//         { name: "origin", value: "Bombay" },
//         { name: "destination", value: "New Delhi" },
//         { name: "departure_date", value: "2026-10-12" },
//       ],
//       comparisonCriteria: ["airline", "departure", "stops", "duration", "displayed fare"],
//     }),
//     "Find me the cheapest flights from Bombay to New Delhi for tomorrow.",
//   );
//   assert.equal(plan.constraints[0].value, "Bombay");
//   assert.equal(plan.constraints[1].value, "New Delhi");
//   assert.equal(plan.comparisonCriteria.length, 5);
// });

// test("flight planner can ask for a materially missing trip type", async () => {
//   const plan = await planWith(
//     makePlan({
//       missingInformation: ["one-way or return"],
//       clarificationQuestion: "Do you need a one-way or return flight?",
//     }),
//     "Find flights from Bombay to New Delhi tomorrow.",
//   );
//   assert.match(plan.clarificationQuestion || "", /one-way or return/);
// });

// test("movie planner can clarify missing location", async () => {
//   const plan = await planWith(
//     makePlan({
//       missingInformation: ["city"],
//       clarificationQuestion: "Which city should I search in?",
//     }),
//     "Find the ticket price for this movie on BookMyShow.",
//   );
//   assert.equal(plan.missingInformation[0], "city");
// });

// test("movie plan retains supplied city, date, and format", async () => {
//   const plan = await planWith(
//     makePlan({
//       constraints: [
//         { name: "city", value: "Mumbai" },
//         { name: "date", value: "2026-10-12" },
//         { name: "format", value: "IMAX 2D or English 2D" },
//       ],
//     }),
//     "Check BookMyShow in Mumbai for tomorrow, IMAX 2D or English 2D.",
//   );
//   assert.deepEqual(plan.constraints.map(({ name }) => name), ["city", "date", "format"]);
// });

// test("identifiable cricket result plan requires observed evidence", async () => {
//   const plan = await planWith(
//     makePlan({
//       entities: ["India", "West Indies", "2026 T20 match"],
//       completionCriteria: ["Verify score and match status from a trusted score source"],
//     }),
//     "Find the score for the India versus West Indies T20 match today.",
//   );
//   assert.equal(plan.entities.length, 3);
//   assert.match(plan.completionCriteria[0], /Verify score/);
// });

// test("ambiguous cricket lookup can request identifying details", async () => {
//   const plan = await planWith(
//     makePlan({
//       missingInformation: ["match date or tournament"],
//       clarificationQuestion: "Which date or tournament do you mean?",
//     }),
//     "Find the score for India versus West Indies at 3:30.",
//   );
//   assert.ok(plan.clarificationQuestion);
// });

// test("general research plan does not require an explicit user URL", async () => {
//   const plan = await planWith(
//     makePlan({ sources: [{ name: "Search", url: "https://www.google.com", rationale: "Discover current sources" }] }),
//     "Research the latest Node.js release.",
//   );
//   assert.equal(plan.sources[0].url, "https://www.google.com");
// });

// test("planner can describe an empty-result verification strategy", async () => {
//   const plan = await planWith(
//     makePlan({ completionCriteria: ["If no useful results appear, try another source and report the limitation"] }),
//     "Find current public information about this topic.",
//   );
//   assert.match(plan.completionCriteria[0], /no useful results/);
// });

// test("planner records a fallback after a navigation failure", async () => {
//   const plan = await planWith(
//     makePlan({ limitations: ["If the source fails to load, search its title on another source"] }),
//     "Research a current topic on its official website.",
//   );
//   assert.match(plan.limitations[0], /fails to load/);
// });

// test("comparison plan can target multiple sources and focused queries", async () => {
//   const plan = await planWith(
//     makePlan({
//       sources: [
//         { name: "Source A", url: "https://a.example", rationale: "Official data" },
//         { name: "Source B", url: "https://b.example", rationale: "Independent comparison" },
//       ],
//       searchQueries: ["focused query A", "focused query B"],
//       comparisonCriteria: ["price", "availability"],
//     }),
//     "Compare current options across reliable sites.",
//   );
//   assert.equal(plan.sources.length, 2);
//   assert.equal(plan.searchQueries.length, 2);
// });

// test("planner flags access-restricted workflows without proposing bypass", async () => {
//   const plan = await planWith(
//     makePlan({ limitations: ["Stop if login, CAPTCHA, or payment is required"] }),
//     "Research options on a site that may require an account.",
//   );
//   assert.match(plan.limitations[0], /Stop if login/);
// });

// test("research evidence gate requires multiple sources for comparisons", async () => {
//   const plan = await planWith(
//     makePlan({
//       sources: [
//         { name: "Source A", url: "https://a.example", rationale: "Primary" },
//         { name: "Source B", url: "https://b.example", rationale: "Compare" },
//       ],
//       comparisonCriteria: ["price"],
//     }),
//     "Compare prices across sources.",
//   );

//   assert.equal(getRequiredBrowserResearchSources(plan), 2);
//   assert.equal(
//     hasSufficientBrowserResearchEvidence(plan, 1, ["a.example"]),
//     false,
//   );
//   assert.equal(
//     hasSufficientBrowserResearchEvidence(plan, 2, ["a.example", "b.example"]),
//     true,
//   );
// });
