# Composio Tools Setup

Use these prompts one by one to add Composio-powered tool connections to the existing Muse AI app. The flow starts with Supabase schema, then moves to app data, settings UI, Composio connection handling, and finally AI agent integration.

## Current Implementation Notes

The app now has both connection management and agent execution paths:

- `src/lib/composioBackend.ts` handles Composio connect/status/disconnect flows and syncs `user_tool_connections`.
- `src/lib/composioAgent.ts` creates a user-scoped Composio session for chat agent tool use.
- `supabase/functions/agent-run/index.ts` executes Composio from Supabase Edge for direct runs and scheduled tasks.
- The Edge Function can run direct `composioToolSlug` calls or create a Tool Router session from `composioToolkitSlug` plus `composioUseCase`.
- Scheduled tasks may omit explicit Composio fields when `delivery` maps to a supported toolkit. Current inference supports Slack, Gmail/email, Google Calendar, Notion, Microsoft Teams, and Discord.
- Direct Composio execution always sends an `arguments` object. Avoid top-level `text` payloads for tool execution.
- For scheduled external delivery, the function drafts message content with OpenAI when useful, executes Composio, then feeds the connected tool result back into the final OpenAI summary.
- OpenAI scheduled-task calls use the Responses API with `instructions` and plain string `input`; if OpenAI returns an unsupported message format error, the Edge Function retries through Chat Completions.

Supabase Edge requires these secrets:

```bash
supabase secrets set \
  SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" \
  COMPOSIO_API_KEY="YOUR_COMPOSIO_API_KEY" \
  OPENAI_API_KEY="YOUR_OPENAI_API_KEY" \
  BROWSERBASE_API_KEY="YOUR_BROWSERBASE_API_KEY"
```

`COMPOSIO_API_KEY` must have connected-account read access and Tool Router session search/execute access.

## Step 1: Supabase DB Schema

```txt
Implement the Supabase database schema for Composio tools connection.

Before implementing:
- Check the existing app structure and current Supabase setup.
- Check whether there are existing migration files or SQL patterns.
- Follow existing project conventions.
- Do not build UI yet.
- Do not integrate Composio SDK yet.

Create Supabase SQL that I can execute directly in Supabase SQL Editor.

Required tables:

1. tools
- id
- name
- slug
- toolkit_slug
- description
- category
- logo_url
- logo_key
- actions jsonb
- composio_auth_config_id
- is_active
- sort_order
- created_at
- updated_at

2. user_tool_connections
- id
- user_id linked to auth.users
- tool_id linked to tools
- status: not_connected, pending, connected, failed, revoked
- composio_connected_account_id
- composio_connection_request_id
- connected_label
- connected_email
- metadata jsonb
- last_checked_at
- connected_at
- created_at
- updated_at

3. agent_tool_runs
- id
- user_id linked to auth.users
- tool_id linked to tools
- action_name
- input_summary
- output_summary
- status
- error_message
- metadata jsonb
- created_at

Requirements:
- Enable RLS.
- Add safe RLS policies.
- Users can read active tools.
- Users can only read/update their own tool connections.
- Users can only read their own tool run logs.
- Add indexes.
- Add updated_at trigger if needed.
- Add seed data for Gmail, Slack, and Google Calendar.
- Include logo_url or logo_key for each tool.
- Use placeholder composio_auth_config_id values if real ones are not available yet.

After implementation:
1. Give me the final SQL only in one executable block.
2. Explain how to run it in Supabase SQL Editor.
3. Give me test SQL queries to verify tables, seed data, and RLS behavior.
```

## Step 2: App Data Layer

```txt
Now implement the app-side data layer for tools.

Before coding:
- Inspect the current project structure.
- Check how Supabase is currently initialized.
- If Supabase is not configured yet, tell me clearly and add the minimum required setup.
- Follow the existing Expo Router and TypeScript patterns.

Implement:
1. A tools API/service file that fetches tools from Supabase.
2. A function to fetch tools with the current user's connection status.
3. TypeScript types for:
   - Tool
   - UserToolConnection
   - ToolConnectionStatus
4. A fallback/mock only if Supabase is not fully configured yet.

The returned app data should include:
- tool id
- name
- slug
- toolkit_slug
- description
- category
- logo_url
- logo_key
- actions
- status
- connected_label
- connected_email

Do not build Composio connect flow yet.

After implementation:
1. List changed files.
2. Explain how to test fetching tools.
3. Run TypeScript check.
```

## Step 3: Tools & Connections UI

```txt
Build the Tools & Connections screen under Settings.

Before coding:
- Inspect src/app/(tabs)/settings.tsx and existing navigation.
- Follow the current app UI style.
- Use src/constants/colors.ts for colors.
- Do not hardcode random hex colors.
- Reuse existing spacing/theme patterns where possible.

Implement:
1. Add "Tools & Connections" option under Settings.
2. Create a Tools & Connections screen.
3. Fetch tools using the data layer.
4. Group tools by category:
   - Email
   - Messaging
   - Calendar
5. Each tool row/card should show:
   - logo image if logo_url exists
   - fallback icon/logo_key if no logo_url
   - tool name
   - description
   - actions summary
   - connection status
   - Connect button if not connected
   - Manage button if connected
   - Pending state if pending

Do not integrate real Composio yet.
For Connect button, show placeholder behavior or disabled state.

After implementation:
1. List changed files.
2. Explain how to test navigation and UI.
3. Run TypeScript check.
```

## Step 4: Composio Backend Connection Flow

```txt
Implement the backend/API flow for starting and checking Composio tool connections.

Before coding:
- Inspect whether this project has an existing backend, API routes, Supabase Edge Functions, or server folder.
- Choose the cleanest approach for this app.
- Do not expose COMPOSIO_API_KEY in the React Native frontend.
- Use environment variables safely.

Implement backend endpoints/functions for:

1. Start connection
POST /tools/:toolId/connect

Behavior:
- Validate current user.
- Load tool from Supabase.
- Require composio_auth_config_id.
- Start Composio connection/link flow.
- Save or update user_tool_connections as pending.
- Save composio connection/request id if returned.
- Return connect URL.

2. Check status
GET /tools/:toolId/status

Behavior:
- Validate current user.
- Load user's connection.
- Check latest Composio status.
- Update Supabase status to connected, pending, failed, or revoked.
- Save connected label/email if available.
- Return latest connection status.

3. Disconnect
POST /tools/:toolId/disconnect

Behavior:
- Validate current user.
- Revoke Composio connected account if possible.
- Update Supabase connection status.
- Return updated status.

After implementation:
1. List environment variables needed.
2. Show request/response examples.
3. Explain how to test with Gmail first.
4. Run TypeScript check.
```

## Step 5: Wire Connect UI To Backend

```txt
Wire the Tools & Connections UI to the real backend connection flow.

Before coding:
- Inspect the current Tools & Connections screen.
- Use the existing data/service layer.
- Keep UI consistent with current app design.

Implement:
1. Connect button calls backend start connection endpoint.
2. Open returned Composio connect URL using Expo/React Native browser linking.
3. Show pending state after connection starts.
4. Refresh tools when the user returns to the app.
5. Poll/check status using backend status endpoint.
6. Show connected state when completed.
7. Add Manage/Disconnect option for connected tools.
8. Show friendly error messages for failed/pending/closed OAuth cases.

After implementation:
1. Explain the full test flow.
2. Test with Gmail, Slack, and Google Calendar if auth config IDs are available.
3. Run TypeScript check.
```

## Step 6: Connect Tools To AI Agent

```txt
Now integrate connected tools with the AI agent flow.

Before coding:
- Inspect the existing chat/agent implementation.
- Identify where user messages are handled.
- Identify where agent responses are generated.
- Do not break existing chat UI.

Implement:

1. Connected tools context
Create a helper that returns connected tools for the current user:
- toolkit_slug
- tool name
- actions
- composio_connected_account_id
- connected_label

2. Tool requirement detection
When user asks things like:
- "Read my latest emails"
- "Send message to Slack"
- "Schedule a meeting"
Detect required tool:
- Gmail
- Slack
- Google Calendar

3. Missing connection suggestion
If required tool is not connected:
- Return a chat response asking user to connect the tool.
- Show a Connect CTA in chat.
- CTA should start the same connection flow.

4. Read-only execution first
Allow read-only actions first:
- Read/search emails
- Read calendar events

5. Write action confirmation
For write actions:
- Send Slack message
- Send email
- Create calendar event
Require user confirmation before executing.

6. Tool run logging
Log tool execution to agent_tool_runs:
- user_id
- tool_id
- action_name
- input_summary
- output_summary
- status
- error_message if failed

After implementation:
1. Test missing Gmail connection.
2. Test connected Gmail read action.
3. Test Slack send message confirmation.
4. Test Calendar create event confirmation.
5. Run TypeScript check.
```

## Recommended Order

1. Run Step 1 and execute the generated SQL in Supabase.
2. Run Step 2 to connect the app to the new tools data.
3. Run Step 3 to expose tools under Settings.
4. Run Step 4 to add secure Composio backend behavior.
5. Run Step 5 to make connection buttons real.
6. Run Step 6 after connection management is stable.

Keep the first milestone focused on showing seeded tools and statuses under Settings. Then wire real Composio OAuth. Only after that should the AI agent start using the connected tools.
