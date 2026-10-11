import assert from "node:assert/strict";
import test from "node:test";

import { findMatchingConnectedAccountForTool } from "./composioBackend";

test("Google Meet can use the same active Google workspace connection as Calendar", () => {
  const accounts = [
    {
      id: "acct_google_workspace",
      status: "ACTIVE",
      toolkit: { slug: "googlecalendar" },
      authConfig: { id: "ac_google_workspace" },
    },
  ];

  const tool = {
    slug: "google_meet",
    toolkit_slug: "google_meet",
    composio_auth_config_id: "ac_qTcJN0MUIWyb",
  };

  const match = findMatchingConnectedAccountForTool(accounts, tool);
  assert.ok(match, "expected a matching Google workspace account");
  assert.equal(match.id, "acct_google_workspace");
});
