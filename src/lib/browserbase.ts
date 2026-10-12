import Browserbase from "@browserbasehq/sdk";
import fs from "fs";
import path from "path";
import WebSocket from "ws";

if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}

export const GetBrowserbase = () => {
  const apiKey = process.env.BROWSERBASE_API_KEY;

  if (!apiKey) {
    throw new Error("BROWSERBASE_API_KEY is missing");
  }

  return new Browserbase({
    apiKey,
  });
};

export const createBrowser = async () => {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("BROWSERBASE_API_KEY is missing");
  }

  if (!projectId) {
    throw new Error("BROWSERBASE_PROJECT_ID is missing");
  }

  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const stagehandPackagePath = findStagehandPackagePath();

  process.env.STAGEHAND_EXTENSION_ARCHIVE_PATH = path.join(
    stagehandPackagePath,
    "dist/assets/stagehand-extension.zip",
  );

  process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH = path.join(
    stagehandPackagePath,
    "dist/extension",
  );

  const { browserbase, Stagehand } = await import("@browserbasehq/stagehand");

  const browser = await browserbase.launch({
    apiKey,
    projectId,
    keepAlive: false,
  });

  try {
    const stagehand = await Stagehand.create({
      browser,

      model: {
        modelName: "openai/gpt-5-nano",
        apiKey: openaiApiKey,
      },

      cache: false,
      selfHeal: true,
    });

    return {
      browser,
      stagehand,
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    const sessionId = browser.sessionId;
    if (sessionId) {
      const client = new Browserbase({ apiKey });
      await client.sessions.update(
        sessionId,
        { status: "REQUEST_RELEASE", projectId },
        { timeout: 1000 },
      );

      const closeDeadline = Date.now() + 8000;
      let closureVerified = false;
      while (Date.now() < closeDeadline) {
        const session = await client.sessions.retrieve(sessionId, {
          timeout: 1000,
        });
        if (["COMPLETED", "TIMED_OUT", "ERROR"].includes(session.status)) {
          closureVerified = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      if (!closureVerified) {
        throw Object.assign(
          new Error(
            "Browserbase did not confirm session closure after Stagehand initialization failed.",
            { cause: error },
          ),
          { sessionId },
        );
      }
    }
    throw error;
  }
};

function findStagehandPackagePath() {
  let currentPath = process.cwd();

  while (true) {
    const packagePath = path.join(
      currentPath,
      "node_modules/@browserbasehq/stagehand",
    );

    if (fs.existsSync(packagePath)) {
      return packagePath;
    }

    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      throw new Error(
        "Could not find @browserbasehq/stagehand in node_modules.",
      );
    }

    currentPath = parentPath;
  }
}
