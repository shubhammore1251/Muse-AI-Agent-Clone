// import assert from "node:assert/strict";
// import test from "node:test";

// import {
//   checkLoginRequired,
//   getStartUrlCandidates,
//   isCacheRequestFailure,
//   isStaleFrameError,
//   isUsefulReadResult,
//   tryNavigateToAny,
//   withFreshStagehandPage,
// } from "./BrowserbaseSession";

// test("stale frame errors are detected and retried against a fresh page", async () => {
//   const firstPage = {
//     url: async () => "https://old.example",
//     waitForLoadState: async () => undefined,
//   };
//   const secondPage = {
//     url: async () => "https://new.example",
//     waitForLoadState: async () => undefined,
//   };
//   let activePage = firstPage;

//   const session = {
//     browser: {
//       context: {
//         activePage: async () => activePage,
//         newPage: async () => secondPage,
//       },
//     },
//     stagehand: {},
//   } as any;

//   const result = await withFreshStagehandPage(
//     session,
//     "browser_action",
//     async (page: any) => {
//       if (page === (firstPage as any)) {
//         activePage = secondPage;
//         throw new Error(
//           "Accessibility.getFullAXTree — Frame with the given frameId is not found.",
//         );
//       }
//       return await page.url();
//     },
//   );

//   assert.equal(result, "https://new.example");
//   assert.equal(isStaleFrameError(new Error("Frame with the given frameId is not found.")), true);
// });

// test("cache 413 failures are identified as non-fatal and fall back to execution", () => {
//   const error = new Error(
//     "Cache read failed; executing without cache — Cache request /cache/get failed with status 413.",
//   );

//   assert.equal(isCacheRequestFailure(error), true);
//   assert.equal(
//     isCacheRequestFailure(new Error("different dataset not related to cache")),
//     false,
//   );
// });

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

import assert from "node:assert/strict";
import test from "node:test";

import {
    isStaleFrameError,
    performDirectBrowserAction,
    tryNavigateToAny,
    withFreshStagehandPage,
} from "./BrowserbaseSession";

test("stale-frame recovery reuses the active tab instead of opening another", async () => {
  const firstPage = { pageId: "first", url: async () => "https://old.example" };
  const secondPage = {
    pageId: "first",
    url: async () => "https://new.example",
  };
  let activePage = firstPage;
  let attempts = 0;

  const session = {
    browser: {
      context: {
        activePage: async () => activePage,
        setActivePage: async (page: typeof activePage) => {
          activePage = page;
        },
        pages: async () => [activePage],
        newPage: async () => {
          throw new Error("stale recovery must not create another tab");
        },
      },
    },
    stagehand: {},
  } as any;

  const result = await withFreshStagehandPage(
    session,
    "browser_action",
    async (page) => {
      attempts += 1;
      if (attempts === 1) {
        activePage = secondPage;
        throw new Error("Frame with the given frameId is not found");
      }
      return await page.url();
    },
  );

  assert.equal(result, "https://new.example");
  assert.equal(attempts, 2);
  assert.equal(
    isStaleFrameError(new Error("Frame with the given frameId is not found")),
    true,
  );
});

test("navigation passes a native 30-second timeout to the Stagehand page", async () => {
  const navigationOptions: unknown[] = [];

  await tryNavigateToAny(
    {
      goto: async (_url: string, options: unknown) => {
        navigationOptions.push(options);
      },
    } as any,
    ["https://example.com"],
  );

  assert.deepEqual(navigationOptions, [
    { waitUntil: "domcontentloaded", timeout: 30000 },
  ]);
});

test("direct form actions use observe selectors and locator fill", async () => {
  const calls: string[] = [];
  const result = await performDirectBrowserAction({
    stagehand: {
      observe: async (instruction: string, options: { timeout: number }) => {
        calls.push(`observe:${instruction}:${options.timeout}`);
        return {
          data: [{ selector: "input[name='query']" }],
          metadata: { usage: { inferenceTimeMs: 12 } },
        };
      },
    } as any,
    page: {
      locator: (selector: string) => ({
        fill: async (value: string, options: { timeout: number }) => {
          calls.push(`fill:${selector}:${value}:${options.timeout}`);
        },
      }),
    } as any,
    actionType: "fill",
    value: "match score",
    instruction: "Fill the search field with match score",
  });

  assert.equal(result.data.success, true);
  assert.deepEqual(calls, [
    "observe:Find the page element required for this action: Fill the search field with match score:30000",
    "fill:input[name='query']:match score:30000",
  ]);
});
