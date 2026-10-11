import { safeErrorMessage } from "@/lib/agentLogger";
import { createBrowser, GetBrowserbase } from "@/lib/browserbase";
import { tool } from "@openai/agents";
import { z } from "zod";

import {
  deleteBrowserSession,
  getBrowserSession,
  saveBrowserSession,
} from "./browserSessionStore";

const loginRequiredSchema = z.object({
  loginRequired: z.boolean(),
  message: z.string(),
  actionObserved: z.boolean(),
  pageState: z.string(),
});

const readResultSchema = z.object({
  result: z.string(),
});

export const createBrowserbaseSessionTool = tool({
  name: "create_browser_session",

  description: `
Create a live Browserbase cloud browser session and open the requested startUrl.

This tool only starts the browser and navigates to startUrl. It does not perform
the user's task. Use browser_action and browser_read for each later step.
After this tool returns, continue the workflow with browser_action/browser_read
unless the user only asked to open the page.
`,

  parameters: z.object({
    reason: z.string(),

    startUrl: z
      .string()
      .describe(
        "A complete URL to open directly, for example https://google.com",
      ),

    userRequest: z
      .string()
      .optional()
      .describe(
        "The full user task for context only. This tool must not execute it.",
      ),
  }),

  execute: async ({ reason, startUrl }) => {
    let resources: Awaited<ReturnType<typeof createBrowser>> | undefined;
    try {
      resources = await createBrowser();
      const { browser, stagehand } = resources;

      const page = await getActivePageOrCreate(browser);
      const navigation = await tryNavigateToAny(
        page,
        getStartUrlCandidates(startUrl),
      );

      const sessionId = browser.sessionId ?? "";

      if (!sessionId) {
        throw new Error("Browserbase did not return a session ID.");
      }

      saveBrowserSession(sessionId, {
        browser,
        stagehand,
      });

      const previewUrl = await getPreviewUrl(sessionId);
      const currentUrl = await page.url();

      return {
        type: "browser_session",
        status: "ready",
        sessionId,
        previewUrl,
        currentUrl,
        attemptedUrls: navigation.attemptedUrls,
        reason,
      };
    } catch (error) {
      const sessionId = resources?.browser.sessionId;
      if (sessionId && getBrowserSession(sessionId)) {
        await closeBrowserSession(sessionId).catch(() => undefined);
      } else if (resources) {
        await Promise.allSettled([
          resources.stagehand.close(),
          resources.browser.close(),
        ]);
        if (sessionId) {
          await releaseBrowserbaseSession(sessionId).catch(() => undefined);
        }
      }
      return {
        type: "browser_session",
        status: "failed",
        error: safeErrorMessage(error),
        reason,
      };
    }
  },
});

export const browserNavigateTool = tool({
  name: "browser_navigate",

  description: `
Navigate the existing browser session to a new URL or alternate URL.
Use this when the first page, path, or extraction did not produce the requested
information. Try a direct URL, an alternate page, or a search URL before failing.
`,

  parameters: z.object({
    sessionId: z.string(),
    url: z
      .string()
      .describe(
        "A complete URL to open, for example https://www.google.com/search?q=google+trends+trending+searches",
      ),
    reason: z.string(),
  }),

  execute: async ({ sessionId, url, reason }) => {
    try {
      const session = getRequiredBrowserSession(sessionId);
      const page = await getActivePageOrCreate(session.browser);
      const navigation = await tryNavigateToAny(
        page,
        getStartUrlCandidates(url),
      );
      const previewUrl = await getPreviewUrl(sessionId);
      const currentUrl = await page.url();

      return {
        type: "browser_navigation_result",
        status: "completed",
        sessionId,
        previewUrl,
        currentUrl,
        attemptedUrls: navigation.attemptedUrls,
        reason,
      };
    } catch (error) {
      return {
        type: "browser_navigation_result",
        status: "failed",
        sessionId,
        error: safeErrorMessage(error),
        reason,
      };
    }
  },
});

export const browserActionTool = tool({
  name: "browser_action",

  description: `
Perform exactly one logical browser action in an existing Browserbase session.
The OpenAI agent must break complex browser tasks into multiple calls.
Use this to actually click, type, press keys, scroll, select options, and open
links. Do not combine multiple actions into one instruction.
`,

  parameters: z.object({
    sessionId: z.string(),
    instruction: z
      .string()
      .describe(
        'One browser action, such as "Click the Search field" or "Press Enter".',
      ),
  }),

  execute: async ({ sessionId, instruction }) => {
    try {
      const session = getRequiredBrowserSession(sessionId);

      await session.stagehand.act(instruction);

      const page = await getActivePageOrCreate(session.browser);
      const currentUrl = await page.url();
      const previewUrl = await getPreviewUrl(sessionId);
      const pageCheck = await checkLoginRequired(
        session.stagehand,
        instruction,
      );

      if (pageCheck.loginRequired) {
        return {
          type: "browser_action_result",
          status: "login_required",
          actionObserved: false,
          pageState: pageCheck.pageState,
          sessionId,
          previewUrl,
          currentUrl,
          message: pageCheck.message,
        };
      }

      return {
        type: "browser_action_result",
        status: pageCheck.actionObserved ? "completed" : "not_verified",
        actionObserved: pageCheck.actionObserved,
        pageState: pageCheck.pageState,
        sessionId,
        previewUrl,
        currentUrl,
      };
    } catch (error) {
      return {
        type: "browser_action_result",
        status: "failed",
        actionObserved: false,
        sessionId,
        error: safeErrorMessage(error),
      };
    }
  },
});

export const browserReadTool = tool({
  name: "browser_read",

  description: `
Read information from the current page of an existing Browserbase session.
Use this for search results, prices, names, ratings, and other page facts.
Use this before answering any task that depends on what is currently shown in
the live browser.
`,

  parameters: z.object({
    sessionId: z.string(),
    instruction: z
      .string()
      .describe("What to read or extract from the current page."),
  }),

  execute: async ({ sessionId, instruction }) => {
    try {
      const session = getRequiredBrowserSession(sessionId);

      const extraction = await session.stagehand.extract(
        instruction,
        readResultSchema as any,
      );

      const page = await getActivePageOrCreate(session.browser);
      const currentUrl = await page.url();
      const result = (extraction.data as z.infer<typeof readResultSchema>)
        .result;
      const hasUsefulResult = isUsefulReadResult(result);

      return {
        type: "browser_read_result",
        status: hasUsefulResult ? "completed" : "no_data",
        sessionId,
        currentUrl,
        result,
        message: hasUsefulResult
          ? undefined
          : "No useful data was extracted from the current page. Try another action, alternate URL, search result, or browser_navigate before answering.",
      };
    } catch (error) {
      return {
        type: "browser_read_result",
        status: "failed",
        sessionId,
        error: safeErrorMessage(error),
      };
    }
  },
});

export const closeBrowserTool = tool({
  name: "close_browser",

  description:
    "Close a Browserbase browser session when the browser task is complete.",

  parameters: z.object({
    sessionId: z.string(),
  }),

  execute: async ({ sessionId }) => {
    await closeBrowserSession(sessionId);

    return {
      type: "close_browser_result",
      status: "completed",
      sessionId,
    };
  },
});

export async function closeBrowserSession(sessionId: string) {
  const session = getBrowserSession(sessionId);

  try {
    if (session) {
      await Promise.allSettled([
        session.stagehand.close(),
        session.browser?.close(),
      ]);
    }

    await releaseBrowserbaseSession(sessionId);
  } finally {
    deleteBrowserSession(sessionId);
  }
}

async function releaseBrowserbaseSession(sessionId: string) {
  await GetBrowserbase().sessions.update(sessionId, {
    status: "REQUEST_RELEASE",
    projectId: process.env.BROWSERBASE_PROJECT_ID,
  });
}

export async function closeBrowserSessions(sessionIds: Iterable<string>) {
  const results = await Promise.allSettled(
    Array.from(sessionIds).map(closeBrowserSession),
  );

  const failedClose = results.find((result) => result.status === "rejected");

  if (failedClose?.status === "rejected") {
    throw failedClose.reason;
  }
}

export async function checkLoginRequired(
  stagehand: ReturnType<typeof getRequiredBrowserSession>["stagehand"],
  actionInstruction = "",
) {
  const extraction = await stagehand.extract(
    `Inspect the current page after the preceding browser action.

Return loginRequired true only when login is required to continue, a credential
page blocks progress, or an authentication challenge blocks the workflow.
Do not return true merely because the page contains a Sign In, Log In, or Account button.
Set actionObserved true only if the visible page state confirms this action occurred:
${actionInstruction || "No specific action was supplied."}
Return a short pageState description without copying private page content.`,
    loginRequiredSchema as any,
  );

  return extraction.data as z.infer<typeof loginRequiredSchema>;
}

async function getActivePageOrCreate(
  browser: ReturnType<typeof getRequiredBrowserSession>["browser"],
) {
  return (
    (await browser.context.activePage()) ?? (await browser.context.newPage())
  );
}

function getRequiredBrowserSession(sessionId: string) {
  const session = getBrowserSession(sessionId);

  if (!session) {
    throw new Error(`Browser session not found: ${sessionId}`);
  }

  return session;
}

async function getPreviewUrl(sessionId: string) {
  const debug = await GetBrowserbase().sessions.debug(sessionId);

  return debug.debuggerFullscreenUrl ?? debug.debuggerUrl;
}

export async function tryNavigateToAny(
  page: Awaited<ReturnType<typeof getActivePageOrCreate>>,
  urls: string[],
) {
  const attemptedUrls: string[] = [];
  let lastError: unknown;

  for (const url of urls) {
    attemptedUrls.push(url);

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
      });

      return {
        attemptedUrls,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to navigate to any attempted URL.");
}

export function getStartUrlCandidates(inputUrl: string) {
  const normalizedInput = normalizeUrl(inputUrl);
  const candidates = [normalizedInput];

  try {
    const parsedUrl = new URL(normalizedInput);
    const host = parsedUrl.hostname;
    const withoutWwwHost = host.replace(/^www\./, "");
    const withWwwHost = host.startsWith("www.") ? host : `www.${host}`;

    candidates.push(
      new URL(
        `${parsedUrl.protocol}//${withWwwHost}${parsedUrl.pathname}${parsedUrl.search}`,
      ).toString(),
    );

    if (parsedUrl.pathname !== "/") {
      candidates.push(`${parsedUrl.protocol}//${host}/`);
      candidates.push(`${parsedUrl.protocol}//${withWwwHost}/`);
    }

    candidates.push(
      `https://www.google.com/search?q=${encodeURIComponent(withoutWwwHost)}`,
    );
  } catch {
    candidates.push(
      `https://www.google.com/search?q=${encodeURIComponent(inputUrl)}`,
    );
  }

  return Array.from(new Set(candidates));
}

function normalizeUrl(inputUrl: string) {
  const trimmedUrl = inputUrl.trim();

  if (/^https?:\/\//i.test(trimmedUrl)) {
    return trimmedUrl;
  }

  return `https://${trimmedUrl}`;
}

export function isUsefulReadResult(result: string) {
  const normalizedResult = result.trim().toLowerCase();

  if (normalizedResult.length < 12) {
    return false;
  }

  return ![
    "no data",
    "not found",
    "unable to extract",
    "could not extract",
    "nothing found",
    "no useful",
    "i can't",
    "i cannot",
  ].some((failureText) => normalizedResult.includes(failureText));
}
