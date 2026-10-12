import { logAgentEvent, safeErrorMessage } from "@/lib/agentLogger";
import { createBrowser, GetBrowserbase } from "@/lib/browserbase";
import { tool } from "@openai/agents";
import { z } from "zod";

import {
  deleteBrowserSession,
  getBrowserSession,
  saveBrowserSession,
  type StoredBrowserSession,
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

const PAGE_OPERATION_TIMEOUT_MS = 30000;
const SESSION_CLOSE_GRACE_MS = 1500;
const sessionClosures = new Map<string, Promise<void>>();

export const STALE_FRAME_ERROR_PATTERN =
  /Frame with the given frameId is not found|does not belong to the target|is not found/i;

export function isStaleFrameError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");
  return STALE_FRAME_ERROR_PATTERN.test(message);
}

export function isCacheRequestFailure(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");

  return /\/cache\/get.*status 413|status 413.*\/cache\/get|Cache read failed|status 413/i.test(
    message,
  );
}

export function isPageOperationTimeout(error: unknown) {
  const message =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : String(error ?? "");
  return /timed?\s*out|timeout/i.test(message);
}

export async function withPageOperationTimeout<T>(
  operationName: string,
  operation: () => Promise<T>,
  timeoutMs = PAGE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refreshPageAfterStaleFrame(
  browser: ReturnType<typeof getRequiredBrowserSession>["browser"],
  currentPage?: Awaited<ReturnType<typeof getActivePageOrCreate>>,
) {
  const freshPage =
    (await browser.context.activePage()) ??
    (await browser.context.pages())[0] ??
    currentPage;

  return freshPage;
}

export async function withFreshStagehandPage<T>(
  session: Pick<StoredBrowserSession, "browser" | "stagehand">,
  operationName: string,
  operation: (
    page: Awaited<ReturnType<typeof getActivePageOrCreate>>,
  ) => Promise<T>,
  maxRetries = 1,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const page = await getActivePageOrCreate(session.browser);

    try {
      return await operation(page);
    } catch (error) {
      lastError = error;

      if (!isStaleFrameError(error) || attempt >= maxRetries) {
        throw error;
      }

      logAgentEvent(
        "Browser stale-frame retry",
        session.executionId || "browser",
        {
          operation: operationName,
          attempt: attempt + 1,
        },
      );
      await refreshPageAfterStaleFrame(session.browser, page).catch(
        () => undefined,
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${operationName} failed after retrying stale page state.`);
}

export function createBrowserbaseSessionTool(executionId?: string) {
  let sessionCreation: Promise<Record<string, unknown>> | undefined;
  let replacementUsed = false;

  return tool({
    name: "create_browser_session",

    description: `
Create the single live Browserbase cloud browser session for this research task.
Return as soon as its live tab is ready so the user can watch. Then use
browser_navigate to open startUrl and browser_read to inspect the page.

This tool only starts the browser. It does not navigate or perform the task.
Use browser_navigate, browser_action, and browser_read for later steps.
`,

    parameters: z.object({
      reason: z.string(),

      startUrl: z
        .string()
        .describe(
          "The first source URL to navigate to after the live preview is ready.",
        ),

      userRequest: z
        .string()
        .optional()
        .describe(
          "The full user task for context only. This tool must not execute it.",
        ),
    }),

    execute: async ({ reason, startUrl }) => {
      if (sessionCreation) {
        const previousSession = await sessionCreation;
        const previousSessionId = String(previousSession.sessionId || "");
        if (
          previousSession.status !== "ready" ||
          !previousSessionId ||
          getBrowserSession(previousSessionId) ||
          replacementUsed
        ) {
          return previousSession;
        }

        replacementUsed = true;
        sessionCreation = undefined;
      }

      sessionCreation = (async () => {
        const startedAt = Date.now();
        let resources: Awaited<ReturnType<typeof createBrowser>> | undefined;
        logAgentEvent(
          "Browser session creation started",
          executionId || "browser",
        );
        try {
          resources = await createBrowser();
          const { browser, stagehand } = resources;

          const page = await getActivePageOrCreate(browser);
          const sessionId = browser.sessionId ?? "";

          if (!sessionId) {
            throw new Error("Browserbase did not return a session ID.");
          }

          saveBrowserSession(sessionId, {
            browser,
            stagehand,
            executionId,
          });

          const previewUrl = await getPreviewUrl(sessionId);
          const currentUrl = await page.url();
          logAgentEvent("Browser session ready", executionId || "browser", {
            duration_ms: Date.now() - startedAt,
            page_count: (await browser.context.pages()).length,
          });

          return {
            type: "browser_session",
            status: "ready",
            sessionId,
            previewUrl,
            currentUrl,
            requestedStartUrl: startUrl,
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
            sessionId: resources?.browser.sessionId,
            error: safeErrorMessage(error),
            reason,
          };
        }
      })();

      return await sessionCreation;
    },
  });
}

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
      if (isPageOperationTimeout(error)) {
        await closeBrowserSession(sessionId).catch(() => undefined);
      }
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
links. For predictable actions, provide actionType and value; provide a CSS
selector when known. If the target is uncertain, Stagehand observe() identifies
it before the direct action. Leave actionType unset for semantic, self-healing
Stagehand act() behavior. Do not combine multiple actions into one instruction.
`,

  parameters: z.object({
    sessionId: z.string(),
    instruction: z
      .string()
      .describe(
        'One browser action, such as "Click the Search field" or "Press Enter".',
      ),
    actionType: z
      .enum(["click", "type", "fill", "select", "scroll", "press"])
      .optional(),
    selector: z.string().optional(),
    value: z.string().optional(),
  }),

  execute: async ({ sessionId, instruction, actionType, selector, value }) => {
    try {
      const session = getRequiredBrowserSession(sessionId);

      const actionResult = await withFreshStagehandPage(
        session,
        "browser_action",
        async (page) =>
          await withPageOperationTimeout(
            "browser_action",
            () =>
              actionType
                ? performDirectBrowserAction({
                    stagehand: session.stagehand,
                    page,
                    actionType,
                    selector,
                    value,
                    instruction,
                  })
                : session.stagehand.act(instruction, {
                    page,
                    timeout: PAGE_OPERATION_TIMEOUT_MS,
                  }),
            PAGE_OPERATION_TIMEOUT_MS,
          ),
      );

      const page = await getActivePageOrCreate(session.browser);
      const currentUrl = await page.url();
      const previewUrl = await getPreviewUrl(sessionId);
      const loginCheck =
        !actionResult.data.success ||
        /\/(login|log-in|signin|sign-in|auth)(\/|\?|$)/i.test(currentUrl)
          ? await checkLoginRequired(
              session.stagehand,
              instruction,
              session.browser,
            )
          : undefined;

      if (loginCheck?.loginRequired) {
        return {
          type: "browser_action_result",
          status: "login_required",
          actionObserved: false,
          pageState: loginCheck.pageState,
          sessionId,
          previewUrl,
          currentUrl,
          message: loginCheck.message,
        };
      }

      const actionObserved = actionResult.data.success === true;

      return {
        type: "browser_action_result",
        status: actionObserved ? "completed" : "not_verified",
        actionObserved,
        pageState: actionResult.data.actionDescription,
        sessionId,
        previewUrl,
        currentUrl,
        stagehandUsage: actionResult.metadata?.usage,
      };
    } catch (error) {
      if (isPageOperationTimeout(error)) {
        await closeBrowserSession(sessionId).catch(() => undefined);
      }
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

export async function performDirectBrowserAction({
  stagehand,
  page,
  actionType,
  selector,
  value,
  instruction,
}: {
  stagehand: ReturnType<typeof getRequiredBrowserSession>["stagehand"];
  page: Awaited<ReturnType<typeof getActivePageOrCreate>>;
  actionType: "click" | "type" | "fill" | "select" | "scroll" | "press";
  selector?: string;
  value?: string;
  instruction: string;
}) {
  let targetSelector = selector?.trim();
  const needsTarget = ["click", "type", "fill", "select"].includes(actionType);
  let observationMetadata: any;

  if (needsTarget && !targetSelector) {
    const observation = await stagehand.observe(
      `Find the page element required for this action: ${instruction}`,
      { page, timeout: PAGE_OPERATION_TIMEOUT_MS },
    );
    targetSelector = observation.data[0]?.selector;
    observationMetadata = observation.metadata;
    if (!targetSelector) {
      throw new Error("Stagehand could not identify a target element.");
    }
  }

  if (["type", "fill", "select"].includes(actionType) && value === undefined) {
    throw new Error(`A value is required for the ${actionType} action.`);
  }

  const locator = targetSelector ? page.locator(targetSelector) : undefined;
  switch (actionType) {
    case "click":
      await locator!.click({ timeout: PAGE_OPERATION_TIMEOUT_MS });
      break;
    case "type":
      await locator!.type(value!, { timeout: PAGE_OPERATION_TIMEOUT_MS });
      break;
    case "fill":
      await locator!.fill(value!, { timeout: PAGE_OPERATION_TIMEOUT_MS });
      break;
    case "select":
      await locator!.selectOption(value!, {
        timeout: PAGE_OPERATION_TIMEOUT_MS,
      });
      break;
    case "scroll":
      if (locator) {
        await locator.scrollTo(value || "100", {
          timeout: PAGE_OPERATION_TIMEOUT_MS,
        });
      } else {
        await page.evaluate("window.scrollBy(0, window.innerHeight)");
      }
      break;
    case "press":
      await page.keyPress(value || "Enter");
      break;
  }

  return {
    data: {
      success: true,
      message: "Browser action completed.",
      actionDescription: `${actionType} ${targetSelector || "page"}`,
      actions: [],
    },
    metadata: observationMetadata,
  };
}

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

      const extraction = await withFreshStagehandPage(
        session,
        "browser_read",
        async (page) => {
          return await withPageOperationTimeout(
            "browser_read",
            () =>
              session.stagehand.extract(instruction, readResultSchema as any, {
                page,
                timeout: PAGE_OPERATION_TIMEOUT_MS,
              }),
            PAGE_OPERATION_TIMEOUT_MS,
          );
        },
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
        resultChars: result.length,
        stagehandUsage: extraction.metadata.usage,
        message: hasUsefulResult
          ? undefined
          : "No useful data was extracted from the current page. Try another action, alternate URL, search result, or browser_navigate before answering.",
      };
    } catch (error) {
      if (isPageOperationTimeout(error)) {
        await closeBrowserSession(sessionId).catch(() => undefined);
      }
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
  const pendingClosure = sessionClosures.get(sessionId);
  if (pendingClosure) return await pendingClosure;

  const session = getBrowserSession(sessionId);
  const closure = (async () => {
    if (session) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([
          session.stagehand.close(),
          session.browser?.close(),
        ]),
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, SESSION_CLOSE_GRACE_MS);
        }),
      ]);
      if (closeTimer) clearTimeout(closeTimer);
    }

    const finalStatus = await releaseBrowserbaseSession(sessionId);
    deleteBrowserSession(sessionId);
    if (session?.executionId) {
      logAgentEvent("Browser session closure verified", session.executionId, {
        status: finalStatus,
      });
    }
  })();

  sessionClosures.set(sessionId, closure);
  try {
    await closure;
  } finally {
    if (sessionClosures.get(sessionId) === closure) {
      sessionClosures.delete(sessionId);
    }
  }
}

async function releaseBrowserbaseSession(sessionId: string) {
  const browserbase = GetBrowserbase();
  await browserbase.sessions.update(
    sessionId,
    {
      status: "REQUEST_RELEASE",
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    },
    { timeout: 1000 },
  );

  const closeDeadline = Date.now() + 8000;
  let status = "unknown";

  while (Date.now() < closeDeadline) {
    const session = await browserbase.sessions.retrieve(sessionId, {
      timeout: 1000,
    });
    status = session.status;
    if (["COMPLETED", "TIMED_OUT", "ERROR"].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Browserbase session closure was not confirmed; final status was ${status}.`,
  );
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
  browser?: ReturnType<typeof getRequiredBrowserSession>["browser"],
) {
  const prompt = `Inspect the current page after the preceding browser action.

Return loginRequired true only when login is required to continue, a credential
page blocks progress, or an authentication challenge blocks the workflow.
Do not return true merely because the page contains a Sign In, Log In, or Account button.
Set actionObserved true only if the visible page state confirms this action occurred:
${actionInstruction || "No specific action was supplied."}
Return a short pageState description without copying private page content.`;

  if (browser) {
    const extraction = await withFreshStagehandPage(
      { browser, stagehand },
      "check_login_required",
      async (page) => {
        return await withPageOperationTimeout(
          "check_login_required",
          () =>
            stagehand.extract(prompt, loginRequiredSchema as any, {
              page,
              timeout: PAGE_OPERATION_TIMEOUT_MS,
            }),
          PAGE_OPERATION_TIMEOUT_MS,
        );
      },
    );

    return extraction.data as z.infer<typeof loginRequiredSchema>;
  }

  const extraction = await stagehand.extract(
    prompt,
    loginRequiredSchema as any,
    { timeout: PAGE_OPERATION_TIMEOUT_MS },
  );

  return extraction.data as z.infer<typeof loginRequiredSchema>;
}

async function getActivePageOrCreate(
  browser: ReturnType<typeof getRequiredBrowserSession>["browser"],
) {
  const pages = await browser.context.pages();
  const page =
    (await browser.context.activePage()) ??
    pages[0] ??
    (await browser.context.newPage());

  await browser.context.setActivePage(page);
  await Promise.all(
    pages
      .filter((existingPage) => existingPage.pageId !== page.pageId)
      .map((extraPage) => extraPage.close()),
  );

  return page;
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
  const url = urls[0];
  if (!url) throw new Error("No navigation URL was supplied.");

  await withPageOperationTimeout(
    `browser_navigate:${url}`,
    () =>
      page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_OPERATION_TIMEOUT_MS,
      }),
    PAGE_OPERATION_TIMEOUT_MS,
  );

  return {
    attemptedUrls: [url],
  };
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
