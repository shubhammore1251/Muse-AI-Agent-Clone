-- Scheduled AI agent tasks table for Muse AI.
-- Run this in the Supabase SQL Editor before enabling the cron dispatcher in
-- functions/agent-run/schedule.sql.

create extension if not exists pgcrypto;

create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.scheduled_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  original_prompt text not null,
  task_type text not null check (task_type in ('generic_prompt')),
  task_payload jsonb not null default '{}'::jsonb,
  schedule_rule jsonb not null default '{}'::jsonb,
  timezone text not null default 'UTC',
  delivery text not null default 'chat' check (length(trim(delivery)) > 0),
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('completed', 'failed')),
  last_run_summary text,
  last_run_error text,
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.scheduled_agent_tasks
add column if not exists last_run_status text
check (last_run_status in ('completed', 'failed'));

alter table public.scheduled_agent_tasks
add column if not exists last_run_summary text;

alter table public.scheduled_agent_tasks
add column if not exists last_run_error text;

update public.scheduled_agent_tasks
set
  task_type = 'generic_prompt',
  task_payload = task_payload || jsonb_build_object(
    'prompt', original_prompt,
    'task', original_prompt,
    'useOpenAi', true
  )
where task_type <> 'generic_prompt';

alter table public.scheduled_agent_tasks
drop constraint if exists scheduled_agent_tasks_task_type_check;

alter table public.scheduled_agent_tasks
add constraint scheduled_agent_tasks_task_type_check
check (task_type in ('generic_prompt'));

alter table public.scheduled_agent_tasks
drop constraint if exists scheduled_agent_tasks_delivery_check;

alter table public.scheduled_agent_tasks
add constraint scheduled_agent_tasks_delivery_check
check (length(trim(delivery)) > 0);

drop trigger if exists set_scheduled_agent_tasks_updated_at on public.scheduled_agent_tasks;
create trigger set_scheduled_agent_tasks_updated_at
before update on public.scheduled_agent_tasks
for each row
execute function public.update_updated_at_column();

create index if not exists idx_scheduled_agent_tasks_user_id
on public.scheduled_agent_tasks (user_id);

create index if not exists idx_scheduled_agent_tasks_due
on public.scheduled_agent_tasks (status, next_run_at)
where status = 'active';

alter table public.scheduled_agent_tasks enable row level security;

drop policy if exists "Users can select their own scheduled tasks" on public.scheduled_agent_tasks;
create policy "Users can select their own scheduled tasks"
on public.scheduled_agent_tasks
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own scheduled tasks" on public.scheduled_agent_tasks;
create policy "Users can insert their own scheduled tasks"
on public.scheduled_agent_tasks
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own scheduled tasks" on public.scheduled_agent_tasks;
create policy "Users can update their own scheduled tasks"
on public.scheduled_agent_tasks
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own scheduled tasks" on public.scheduled_agent_tasks;
create policy "Users can delete their own scheduled tasks"
on public.scheduled_agent_tasks
for delete
to authenticated
using ((select auth.uid()) = user_id);