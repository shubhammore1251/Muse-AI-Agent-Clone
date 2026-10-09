# Scheduled AI Agent Tasks

This document describes the current scheduled-task flow for Muse AI. Scheduled tasks are created from chat, saved in Supabase, and executed by the `agent-run` Supabase Edge Function.

## User Flow

1. User asks Cooper to run something later or repeatedly.
2. The schedule intent parser returns a `ScheduleConfirmation`.
3. Chat renders a confirmation card.
4. User taps Confirm.
5. The app inserts a row into `public.scheduled_agent_tasks`.
6. `pg_cron` calls `agent-run` with `mode = "run_due_schedules"`.
7. `agent-run` executes due schedules for each saved `user_id`.
8. The function writes `agent_tool_runs` history, updates `last_run_*`, and advances `next_run_at`.
9. If `delivery = 'chat'`, the function writes the result into `chat_messages`.
10. If `delivery` maps to an external app, the function uses Composio before producing the final summary.

## V1 Scope

- Daily schedules at a specific time.
- Weekly schedules on a named weekday at a specific time.
- Generic prompt tasks.
- Browserbase tasks when `task_payload.browserTask` is present.
- Composio delivery for connected apps such as Slack, Gmail, Google Calendar, Notion, Teams, and Discord.
- Manual runs from the Tasks tab with `mode = "run_scheduled_task"`.

## App Contract

The chat layer creates a message with a confirmation payload:

```ts
{
  id: string;
  sender: 'agent';
  text: string;
  timestamp: string;
  scheduleConfirmation: {
    title: string;
    originalPrompt: string;
    taskType: 'generic_prompt';
    taskPayload: {
      prompt: string;
      task: string;
      useOpenAi: true;
      sourceThreadId?: string;
      browserTask?: string;
      pollBrowserbase?: boolean;
      composioToolkitSlug?: string;
      composioUseCase?: string;
      composioArguments?: Record<string, unknown>;
      composioText?: string;
    };
    scheduleRule: {
      frequency: 'daily' | 'weekly';
      time: string;
      weekday?: string;
    };
    timezone: string;
    delivery: string;
    summary: string;
  };
}
```

The app inserts the confirmed schedule through `src/lib/scheduledTasks.ts`.

## Database Table

Use `public.scheduled_agent_tasks`. The canonical SQL lives at:

```txt
supabase/functions/agent-run/scheduled_agent_tasks.sql
```

Important fields:

- `user_id`
- `title`
- `original_prompt`
- `task_type`
- `task_payload`
- `schedule_rule`
- `timezone`
- `delivery`
- `next_run_at`
- `last_run_at`
- `last_run_status`
- `last_run_summary`
- `last_run_error`
- `status`
- `created_at`
- `updated_at`

RLS is enabled. Users can select, insert, update, and delete only their own schedules. The Edge Function uses the service role key for cron execution.

## App Insert Shape

When the user confirms, insert:

```ts
{
  user_id: userId,
  title: confirmation.title,
  original_prompt: confirmation.originalPrompt,
  task_type: confirmation.taskType,
  task_payload: {
    ...confirmation.taskPayload,
    sourceThreadId
  },
  schedule_rule: confirmation.scheduleRule,
  timezone: confirmation.timezone,
  delivery: confirmation.delivery,
  next_run_at: calculatedNextRunAt,
  status: 'active'
}
```

Example Slack task:

```json
{
  "title": "Morning Slack Greeting",
  "originalPrompt": "Send a good morning message to #general every morning at 8",
  "taskType": "generic_prompt",
  "taskPayload": {
    "prompt": "Send a good morning message to #general every morning at 8",
    "task": "Send a good morning message to #general",
    "useOpenAi": true,
    "composioToolkitSlug": "slack",
    "composioUseCase": "Send a message to a Slack channel",
    "composioArguments": {
      "channel": "#general"
    },
    "sourceThreadId": "CHAT_THREAD_UUID"
  },
  "scheduleRule": {
    "frequency": "daily",
    "time": "08:00"
  },
  "timezone": "America/New_York",
  "delivery": "slack"
}
```

## Edge Function Contract

`supabase/functions/agent-run/index.ts` supports these modes.

### Run Due Schedules

```json
{
  "mode": "run_due_schedules",
  "source": "pg_cron",
  "triggeredAt": "2026-10-04T12:00:00.000Z"
}
```

The function:

- Fetches up to 25 active schedules where `next_run_at <= now`.
- Executes Browserbase first when a browser task exists.
- Drafts content with OpenAI before Composio for toolkits that need text content.
- Infers Composio plans from `delivery` when explicit Composio fields are missing.
- Lists active Composio connected accounts for the schedule user.
- Runs Composio through direct tool execution or Tool Router session search/execute.
- Runs OpenAI again with the connected tool result so the final summary reflects the actual tool action.
- Inserts a completed or failed `agent_tool_runs` row.
- Updates `last_run_at`, `last_run_status`, `last_run_summary`, and `last_run_error`.
- Advances `next_run_at` for recurring schedules.

### Run One Scheduled Task Now

```json
{
  "mode": "run_scheduled_task",
  "scheduledTaskId": "SCHEDULE_UUID",
  "userId": "USER_UUID"
}
```

This is used by the Tasks tab manual Run action. With a Supabase bearer token, the function verifies the task belongs to the current user.

## Composio Delivery Rules

The Edge Function recognizes these delivery-to-toolkit mappings:

| Delivery | Toolkit slug |
| --- | --- |
| `slack` | `slack` |
| `email`, `gmail`, `mail` | `gmail` |
| `calendar`, `google_calendar` | `googlecalendar` |
| `notion` | `notion` |
| `teams` | `microsoftteams` |
| `discord` | `discord` |

Explicit `task_payload.composioToolkitSlug` and `task_payload.composioToolSlug` override inference.

Supported payload aliases:

- `browserTask` / `browser_task`
- `pollBrowserbase` / `poll_browserbase`
- `composioToolSlug` / `composio_tool_slug`
- `composioToolkitSlug` / `composio_toolkit_slug`
- `composioUseCase` / `composio_use_case`
- `composioArguments` / `composio_arguments`
- `composioText` / `composio_text`
- `useOpenAi` / `use_openai`

## OpenAI Behavior

`agent-run` uses the Responses API with:

- `instructions`
- plain string `input`

If OpenAI returns an unsupported message format error, the function retries with `/v1/chat/completions` using standard `system` and `user` messages.

If `OPENAI_API_KEY` is not configured, OpenAI drafting is skipped. Browserbase and Composio can still run when their secrets are configured.

## Run History

Every scheduled execution writes to `agent_tool_runs`:

```sql
INSERT INTO public.agent_tool_runs (
  user_id,
  action_name,
  input_summary,
  output_summary,
  status,
  error_message,
  metadata
) VALUES (
  '<user_id>',
  'scheduled_generic_prompt',
  '<input summary>',
  '<summary or JSON result>',
  'completed',
  NULL,
  '{"scheduled_task_id":"<scheduled_task_id>","task_type":"generic_prompt","delivery":"chat"}'::jsonb
);
```

For `delivery = 'chat'`, the function inserts a user-facing assistant message into `chat_messages`. It uses `task_payload.sourceThreadId` when available and falls back to the user's main chat thread.

## Cron Setup

Use the production dispatcher SQL:

```txt
supabase/functions/agent-run/schedule.sql
```

The cron body should stay global:

```sql
body := jsonb_build_object(
  'mode', 'run_due_schedules',
  'source', 'pg_cron',
  'triggeredAt', now()
)
```

Do not hardcode `userId`, `task`, or `browserTask` in cron.

## Confirmation Card Copy

```txt
Schedule this task?

Task: Summarize unread emails
When: Every day at 8:00 AM
Delivery: Chat

[Confirm] [Edit] [Cancel]
```

## Follow-Up Improvements

- Add edit flow for time, frequency, and delivery.
- Add richer per-run history in the Tasks tab.
- Add push notifications for completed runs.
- Add specialized argument builders for Gmail, Calendar, Notion, Teams, and Discord.
