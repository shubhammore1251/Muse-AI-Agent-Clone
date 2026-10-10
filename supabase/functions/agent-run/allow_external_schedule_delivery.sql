alter table public.scheduled_agent_tasks
drop constraint if exists scheduled_agent_tasks_delivery_check;

alter table public.scheduled_agent_tasks
add constraint scheduled_agent_tasks_delivery_check
check (length(trim(delivery)) > 0);