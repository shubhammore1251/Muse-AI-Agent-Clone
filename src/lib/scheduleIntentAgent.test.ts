import assert from "node:assert/strict";
import test from "node:test";

import {
    classifyUserIntent,
    type UserIntentClassification,
} from "./scheduleIntentAgent.ts";

const assertIntent = (
  text: string,
  expectedIntent: UserIntentClassification["intent"],
) => {
  const result = classifyUserIntent(text);
  assert.equal(result.intent, expectedIntent);
};

test("browser research without a URL is routed to browser_research", () => {
  assertIntent(
    "Research the latest Node.js LTS release and summarize the official announcement.",
    "browser_research",
  );
});

test("explicit URL browser tasks stay in browser_research", () => {
  assertIntent(
    "Open google.com and search for the latest Node.js LTS release. Inspect the official Node.js source and summarize the result with a link.",
    "browser_research",
  );
});

test("latest email actions stay immediate and not recurring", () => {
  assertIntent("Read my five latest emails.", "immediate_action");
});

test("one-time Google Meet requests are not recurring schedules", () => {
  assertIntent(
    "Schedule a Google Meet for tomorrow at 3 PM.",
    "immediate_action",
  );
});

test("one-time calendar events on a future weekday are not recurring", () => {
  assertIntent(
    "Create a Google Calendar event for next Monday at 3 PM.",
    "immediate_action",
  );
});

test("recurring inbox monitoring stays in recurring_task", () => {
  assertIntent("Check my inbox every morning.", "recurring_task");
});

test("ambiguous requests require clarification", () => {
  assertIntent("Schedule this", "clarification_required");
});

test("follow-up choices resolve the original request without misrouting", () => {
  const result = classifyUserIntent("do it now");
  assert.equal(result.intent, "clarification_follow_up");
  assert.equal(result.choice, "immediate");
});
