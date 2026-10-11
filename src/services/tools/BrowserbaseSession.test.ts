// import assert from "node:assert/strict";
// import test from "node:test";

// import {
//   checkLoginRequired,
//   getStartUrlCandidates,
//   isUsefulReadResult,
//   tryNavigateToAny,
// } from "./BrowserbaseSession";

// test("post-action inspection exposes login blocks and unverified actions", async () => {
//   let inspectedInstruction = "";
//   const result = await checkLoginRequired(
//     {
//       extract: async (instruction: string) => {
//         inspectedInstruction = instruction;
//         return {
//           data: {
//             loginRequired: true,
//             message: "Sign in is required to continue.",
//             actionObserved: false,
//             pageState: "Authentication page blocks results",
//           },
//         };
//       },
//     } as any,
//     "Open the selected showtime details",
//   );

//   assert.equal(result.loginRequired, true);
//   assert.equal(result.actionObserved, false);
//   assert.match(inspectedInstruction, /Open the selected showtime details/);
// });

// test("browser read identifies useful and empty extraction results", () => {
//   assert.equal(isUsefulReadResult("No useful data was found."), false);
//   assert.equal(isUsefulReadResult("   "), false);
//   assert.equal(isUsefulReadResult("The displayed fare is INR 4,500."), true);
// });

// test("navigation fallback stops at the first page that loads", async () => {
//   const visited: string[] = [];
//   const result = await tryNavigateToAny(
//     {
//       goto: async (url: string) => {
//         visited.push(url);
//         if (url.includes("broken")) throw new Error("navigation failed");
//       },
//     } as any,
//     ["https://broken.example", "https://working.example"],
//   );

//   assert.deepEqual(visited, ["https://broken.example", "https://working.example"]);
//   assert.deepEqual(result.attemptedUrls, visited);
// });

// test("navigation failure is bounded to supplied fallback candidates", async () => {
//   const candidates = getStartUrlCandidates("https://broken.example/path");
//   const visited: string[] = [];

//   await assert.rejects(
//     tryNavigateToAny(
//       {
//         goto: async (url: string) => {
//           visited.push(url);
//           throw new Error("navigation failed");
//         },
//       } as any,
//       candidates,
//     ),
//     /navigation failed/,
//   );

//   assert.deepEqual(visited, candidates);
// });
