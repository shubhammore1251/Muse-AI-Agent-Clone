// import assert from "node:assert/strict";
// import test from "node:test";

// import { POST } from "./chat+api";

// test("chat API emits the existing schedule confirmation for recurring inbox requests", async () => {
//   const previousApiKey = process.env.OPENAI_API_KEY;
//   delete process.env.OPENAI_API_KEY;

//   try {
//     const response = await POST(
//       new Request("http://localhost/api/chat", {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({
//           userId: "runtime-regression-user",
//           timezone: "America/Los_Angeles",
//           messages: [
//             {
//               sender: "user",
//               text: "Check my inbox every morning and send me a summary.",
//             },
//           ],
//         }),
//       }),
//     );

//     const events = (await response.text())
//       .trim()
//       .split("\n")
//       .map((line) => JSON.parse(line));
//     const confirmation = events.find(
//       (event) => event.type === "schedule_confirmation",
//     );

//     assert.ok(confirmation);
//     assert.equal(confirmation.scheduleConfirmation.scheduleRule.frequency, "daily");
//     assert.equal(confirmation.scheduleConfirmation.scheduleRule.time, "08:00");
//     assert.equal(confirmation.scheduleConfirmation.delivery, "email");
//     assert.equal(events.some((event) => event.type === "final"), false);
//   } finally {
//     if (previousApiKey === undefined) {
//       delete process.env.OPENAI_API_KEY;
//     } else {
//       process.env.OPENAI_API_KEY = previousApiKey;
//     }
//   }
// });
