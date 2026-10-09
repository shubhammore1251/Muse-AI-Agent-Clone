import type { Stagehand, StagehandBrowser } from "@browserbasehq/stagehand";

export type StoredBrowserSession = {
  browser: StagehandBrowser;
  stagehand: Stagehand;
};

const browserSessions = new Map<string, StoredBrowserSession>();

export function saveBrowserSession(
  sessionId: string,
  session: StoredBrowserSession,
) {
  browserSessions.set(sessionId, session);
}

export function getBrowserSession(sessionId: string) {
  return browserSessions.get(sessionId);
}

export function deleteBrowserSession(sessionId: string) {
  browserSessions.delete(sessionId);
}
