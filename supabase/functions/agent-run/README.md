# Muse AI Edge Function: `agent-run`

`agent-run` is the Supabase Edge Function that executes Muse AI backend tasks for a Supabase user. It is Deno-compatible and uses HTTP APIs instead of Node-only packages.

## What It Does

- Authenticates a Supabase user from the request bearer token, or from `userId` for trusted scheduled/cron calls.
- Lists the user's active Composio connected accounts.
- Executes Composio tools directly by `composioToolSlug`, or creates a Composio Tool Router session and searches by app/toolkit use case.
- Infers common Composio delivery toolkits when callers provide `delivery` or task text but no explicit toolkit.
- Starts Browserbase Agent runs for browser tasks and can poll for the final run result.
- Executes due rows from `public.scheduled_agent_tasks` and writes history to `public.agent_tool_runs`.
- Saves scheduled chat-delivery results into `chat_messages`.
- Uses OpenAI for scheduled-task drafting and final summaries, with a fallback from Responses API to Chat Completions when a model or gateway returns an unsupported message format error.

The current Expo route code can use Node packages such as `@browserbasehq/stagehand`, `playwright-core`, and `ws`. Keep that code out of Supabase Edge Functions. This function uses `fetch` calls that run on Deno Edge.

## Secrets

Set these in Supabase:

```bash
supabase secrets set \
  SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" \
  COMPOSIO_API_KEY="YOUR_COMPOSIO_API_KEY" \
  BROWSERBASE_API_KEY="YOUR_BROWSERBASE_API_KEY" \
  OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
```

Optional:

```bash
supabase secrets set \
  COMPOSIO_BASE_URL="https://backend.composio.dev" \
  OPENAI_MODEL="gpt-5-nano"
```

`COMPOSIO_API_KEY` must be a Composio project key with access to connected accounts plus Tool Router session search and execute. If this key is missing those permissions, the function will return a clearer permission error.

## Deploy

```bash
supabase functions deploy agent-run
```

The Supabase CLI is not installed in this workspace by default, so install/authenticate it locally before deploying.

## Request Modes

### Direct Run

Use this mode for one-off backend runs from the app or curl.

```json
{
  "task": "Send a status message to Slack",
  "delivery": "slack",
  "composioArguments": {
    "channel": "#new-channel",
    "text": "Good morning! Hope you have a great day."
  }
}
```

If `composioToolkitSlug` is omitted, the function can infer these delivery mappings:

| Delivery                      | Toolkit slug     |
| ----------------------------- | ---------------- |
| `slack`                       | `slack`          |
| `email`, `gmail`, `mail`      | `gmail`          |
| `calendar`, `google_calendar` | `googlecalendar` |
| `notion`                      | `notion`         |
| `teams`                       | `microsoftteams` |
| `discord`                     | `discord`        |

Explicit fields still win:

```json
{
  "task": "Send a status message to Slack",
  "composioToolkitSlug": "slack",
  "composioUseCase": "Send a message to a Slack channel",
  "composioArguments": {
    "channel": "#new-channel",
    "text": "Good morning! Hope you have a great day."
  }
}
```

For legacy/direct tool calls:

```json
{
  "composioToolSlug": "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
  "composioArguments": {
    "channel": "#new-channel",
    "text": "Good morning!"
  }
}
```

Direct Composio tool execution always sends an `arguments` object. If no explicit arguments are provided, the fallback is `{ "text": "..." }`.

### Manual Scheduled Task Run

The app uses this mode when the user taps Run on a task.

```json
{
  "mode": "run_scheduled_task",
  "scheduledTaskId": "SCHEDULE_UUID",
  "userId": "USER_UUID"
}
```

When a valid Supabase user JWT is present, the function verifies that the schedule belongs to that user.

### Cron Dispatcher

`pg_cron` should call one global dispatcher job. Do not create one cron job per user task.

```json
{
  "mode": "run_due_schedules"
}
```

The function queries up to 25 active schedules where `next_run_at <= now`, executes each one, logs success/failure in `agent_tool_runs`, updates `last_run_*`, and advances `next_run_at` for daily/weekly/interval tasks.

## Scheduled Task Payloads

`scheduled_agent_tasks.task_payload` may include:

```json
{
  "task": "Write a short morning greeting and send it to Slack",
  "useOpenAi": true,
  "composioToolkitSlug": "slack",
  "composioUseCase": "Send a message to a Slack channel",
  "composioArguments": {
    "channel": "#general"
  },
  "sourceThreadId": "CHAT_THREAD_UUID"
}
```

Supported aliases are both camelCase and snake_case for Composio and Browserbase fields:

- `browserTask` / `browser_task`
- `pollBrowserbase` / `poll_browserbase`
- `composioToolSlug` / `composio_tool_slug`
- `composioToolkitSlug` / `composio_toolkit_slug`
- `composioUseCase` / `composio_use_case`
- `composioArguments` / `composio_arguments`
- `composioText` / `composio_text`
- `useOpenAi` / `use_openai`

For external delivery such as Slack, the function drafts content with OpenAI first when helpful, executes Composio, then passes the connected tool result back into the final OpenAI summary. This prevents AI-only results from replacing actual tool execution.

## Curl Examples

Direct browser task:

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/agent-run" \
  -H "Authorization: Bearer USER_SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Inspect example.com",
    "browserTask": "Open https://example.com and summarize the page.",
    "pollBrowserbase": true
  }'
```

Direct Slack delivery with inferred toolkit:

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/agent-run" \
  -H "Authorization: Bearer USER_SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Send a quick morning greeting to Slack",
    "delivery": "slack",
    "composioArguments": {
      "channel": "#new-channel",
      "text": "Good morning! Hope you have a great day."
    }
  }'
```

Run due schedules:

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/agent-run" \
  -H "Authorization: Bearer SERVICE_OR_ALLOWED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "mode": "run_due_schedules" }'
```

## Output And Logging

Successful direct runs return:

```json
{
  "ok": true,
  "userId": "USER_UUID",
  "composio": {
    "activeAccounts": [],
    "toolResult": null
  },
  "browserbase": null
}
```

Scheduled runs write:

- `agent_tool_runs.status = 'completed' | 'failed'`
- `agent_tool_runs.metadata.scheduled_task_id`
- `agent_tool_runs.metadata.delivery`
- `scheduled_agent_tasks.last_run_at`
- `scheduled_agent_tasks.last_run_status`
- `scheduled_agent_tasks.last_run_summary` or `last_run_error`

For `delivery = 'chat'`, the function inserts an assistant message into the source thread from `task_payload.sourceThreadId`. If that thread is missing, it falls back to the user's main chat thread.

## Troubleshooting

- `Missing connected Slack account`: the user's Composio connected account list does not include an active account for the required toolkit. Reconnect the tool in the app and retry.
- `Check that the Supabase Edge Function COMPOSIO_API_KEY...`: the Composio API key is missing connected-account or Tool Router session permissions.
- `unsupported message format`: the function now retries with Chat Completions automatically. If this still appears, check the configured `OPENAI_MODEL`.
- `OPENAI_API_KEY is not configured`: OpenAI drafting/final summaries are skipped, but Browserbase and Composio can still run if their secrets are present.
- `BROWSERBASE_API_KEY` missing: Browserbase tasks will fail; Composio-only tasks do not require it.

## Related Files

- `supabase/functions/agent-run/index.ts`
- `supabase/functions/agent-run/schedule.sql`
- `supabase/functions/agent-run/scheduled_agent_tasks.sql`
- `supabase/functions/agent-run/allow_external_schedule_delivery.sql`
- `docs/scheduled-agent-tasks.md`
- `docs/COMPOSIO_TOOLS_SETUP.md`
