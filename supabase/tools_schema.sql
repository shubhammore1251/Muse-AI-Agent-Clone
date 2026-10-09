begin;

create table if not exists public.tools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  toolkit_slug text not null,
  description text,
  category text,
  logo_url text,
  logo_key text,
  actions jsonb not null default '[]'::jsonb,
  composio_auth_config_id text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_tool_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_id uuid not null references public.tools(id) on delete cascade,
  status text not null default 'not_connected'
    check (status in ('not_connected', 'pending', 'connected', 'failed', 'revoked')),
  composio_connected_account_id text,
  composio_connection_request_id text,
  connected_label text,
  connected_email text,
  metadata jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_tool_connections_user_tool_unique unique (user_id, tool_id)
);

create table if not exists public.agent_tool_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_id uuid references public.tools(id) on delete set null,
  action_name text not null,
  input_summary text not null default '',
  output_summary text,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed', 'cancelled')),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tools_active_category_sort_idx
  on public.tools (category, sort_order)
  where is_active = true;

create index if not exists tools_toolkit_slug_idx
  on public.tools (toolkit_slug);

create index if not exists user_tool_connections_tool_id_idx
  on public.user_tool_connections (tool_id);

create index if not exists user_tool_connections_user_status_idx
  on public.user_tool_connections (user_id, status);

create index if not exists user_tool_connections_composio_account_idx
  on public.user_tool_connections (composio_connected_account_id)
  where composio_connected_account_id is not null;

create index if not exists agent_tool_runs_user_created_idx
  on public.agent_tool_runs (user_id, created_at desc);

create index if not exists agent_tool_runs_tool_id_idx
  on public.agent_tool_runs (tool_id)
  where tool_id is not null;

create or replace function public.set_tools_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists tools_set_updated_at on public.tools;
create trigger tools_set_updated_at
  before update on public.tools
  for each row execute function public.set_tools_updated_at();

drop trigger if exists user_tool_connections_set_updated_at on public.user_tool_connections;
create trigger user_tool_connections_set_updated_at
  before update on public.user_tool_connections
  for each row execute function public.set_tools_updated_at();

alter table public.tools enable row level security;
alter table public.user_tool_connections enable row level security;
alter table public.agent_tool_runs enable row level security;

drop policy if exists tools_read_active on public.tools;
create policy tools_read_active
  on public.tools
  for select
  to authenticated
  using (is_active = true);

drop policy if exists user_tool_connections_read_own on public.user_tool_connections;
create policy user_tool_connections_read_own
  on public.user_tool_connections
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists user_tool_connections_insert_own on public.user_tool_connections;
create policy user_tool_connections_insert_own
  on public.user_tool_connections
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.tools as t
      where t.id = user_tool_connections.tool_id
        and t.is_active = true
    )
  );

drop policy if exists user_tool_connections_update_own on public.user_tool_connections;
create policy user_tool_connections_update_own
  on public.user_tool_connections
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists agent_tool_runs_read_own on public.agent_tool_runs;
create policy agent_tool_runs_read_own
  on public.agent_tool_runs
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on table public.tools from anon, authenticated;
revoke all on table public.user_tool_connections from anon, authenticated;
revoke all on table public.agent_tool_runs from anon, authenticated;

grant usage on schema public to authenticated, service_role;
grant select on table public.tools to authenticated;
grant select on table public.user_tool_connections to authenticated;
grant insert (
  user_id,
  tool_id,
  status,
  composio_connected_account_id,
  composio_connection_request_id,
  connected_label,
  connected_email,
  metadata,
  last_checked_at,
  connected_at
) on public.user_tool_connections to authenticated;
grant update (
  status,
  composio_connected_account_id,
  composio_connection_request_id,
  connected_label,
  connected_email,
  metadata,
  last_checked_at,
  connected_at
) on public.user_tool_connections to authenticated;
grant select on table public.agent_tool_runs to authenticated;

grant all on table public.tools to service_role;
grant all on table public.user_tool_connections to service_role;
grant all on table public.agent_tool_runs to service_role;

insert into public.tools (
  name,
  slug,
  toolkit_slug,
  description,
  category,
  logo_url,
  logo_key,
  actions,
  composio_auth_config_id,
  is_active,
  sort_order
)
values
  (
    'Gmail',
    'gmail',
    'gmail',
    'Send, search, and manage email with Gmail.',
    'Email',
    'https://cdn.simpleicons.org/gmail/EA4335',
    'gmail',
    '[{"name":"GMAIL_SEND_EMAIL","description":"Send an email."},{"name":"GMAIL_SEARCH_EMAILS","description":"Search messages in Gmail."}]'::jsonb,
    'ac_cTxcieYY4OIG',
    true,
    10
  ),
  (
    'Slack',
    'slack',
    'slack',
    'Send messages and search conversations in Slack.',
    'Messaging',
    'https://cdn.simpleicons.org/slack/4A154B',
    'slack',
    '[{"name":"SLACK_SEND_MESSAGE","description":"Send a message to a Slack conversation."},{"name":"SLACK_SEARCH_MESSAGES","description":"Search Slack messages."}]'::jsonb,
    'ac_ZQIFMZUVDdK9',
    true,
    20
  ),
  (
    'Google Calendar',
    'googlecalendar',
    'googlecalendar',
    'Create and manage events in Google Calendar.',
    'Calendar',
    'https://cdn.simpleicons.org/googlecalendar/4285F4',
    'google_calendar',
    '[{"name":"GOOGLECALENDAR_CREATE_EVENT","description":"Create a calendar event."},{"name":"GOOGLECALENDAR_FIND_EVENT","description":"Find calendar events."}]'::jsonb,
    'placeholder_googlecalendar_auth_config_id',
    true,
    30
  )
on conflict (slug) do update set
  name = excluded.name,
  toolkit_slug = excluded.toolkit_slug,
  description = excluded.description,
  category = excluded.category,
  logo_url = excluded.logo_url,
  logo_key = excluded.logo_key,
  actions = excluded.actions,
  composio_auth_config_id = excluded.composio_auth_config_id,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order,
  updated_at = now();

commit;