-- Production cron dispatcher for `agent-run`.
--
-- Run this in Supabase SQL Editor after deploying `agent-run`.
-- This creates one global cron job that asks the Edge Function to run all due
-- rows from `public.scheduled_agent_tasks`.
--
-- Important:
-- - Do not put a hardcoded userId or task here.
-- - User-created schedules should be saved in `public.scheduled_agent_tasks`.
-- - The Edge Function should handle `mode = "run_due_schedules"`.
-- - Replace the two vault secret values before running this file.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault with schema vault;

select vault.create_secret(
  'https://YOUR_PROJECT_REF.supabase.co',
  'muse_agent_project_url'
);

select vault.create_secret(
  'YOUR_SUPABASE_SERVICE_ROLE_KEY',
  'muse_agent_service_role_key'
);

-- Keep this cron setup re-runnable by removing the previous job if it exists.
do $$
begin
  perform cron.unschedule('muse-agent-run-due-schedules');
exception
  when others then
    null;
end;
$$;

select cron.schedule(
  'muse-agent-run-due-schedules',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'muse_agent_project_url'
    )
      || '/functions/v1/agent-run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'muse_agent_service_role_key'
      ),
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'muse_agent_service_role_key'
      )
    ),
    body := jsonb_build_object(
      'mode', 'run_due_schedules',
      'source', 'pg_cron',
      'triggeredAt', now()
    )
  );
  $$
);