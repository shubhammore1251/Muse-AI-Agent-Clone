-- Muse AI persistent context storage.
-- Embeddings use OpenAI text-embedding-3-small at 1536 dimensions.
-- HNSW cosine indexing anticipates a growing multi-user memory corpus; m=16
-- and ef_construction=64 are balanced defaults for recall and index cost.
-- Existing chat table DDL is not present in this repository, so thread and
-- message identifiers are retained as opaque references rather than guessed FKs.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
grant usage on schema public, extensions to authenticated, service_role;

set search_path = public, extensions;

create table if not exists public.context_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id text not null,
  summary text not null check (length(btrim(summary)) > 0),
  summary_version integer not null default 1 check (summary_version > 0),
  source_message_ids text[] not null default '{}',
  source_started_at timestamptz,
  source_ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint context_summaries_user_thread_unique unique (user_id, thread_id)
);

create table if not exists public.context_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id text,
  source_thread_id text,
  content text not null check (length(btrim(content)) between 1 and 4000),
  category text not null check (
    category in ('preference', 'fact', 'decision', 'architecture', 'error_resolution', 'open_task')
  ),
  embedding vector(1536),
  embedding_model text,
  source_message_ids text[] not null default '{}',
  superseded_by uuid references public.context_memories(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint context_memories_embedding_model_check check (
    (embedding is null and embedding_model is null)
    or (embedding is not null and nullif(btrim(embedding_model), '') is not null)
  )
);

create index if not exists context_summaries_user_updated_idx
  on public.context_summaries (user_id, updated_at desc);

create index if not exists context_memories_active_scope_idx
  on public.context_memories (user_id, thread_id, created_at desc)
  where archived_at is null;

create index if not exists context_memories_search_vector_idx
  on public.context_memories using gin (to_tsvector('simple', content))
  where archived_at is null;

create index if not exists context_memories_embedding_hnsw_idx
  on public.context_memories using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where archived_at is null
    and embedding is not null
    and embedding_model = 'text-embedding-3-small';

create unique index if not exists context_memories_active_content_uidx
  on public.context_memories (
    user_id,
    coalesce(thread_id, ''),
    md5(lower(btrim(content)))
  )
  where archived_at is null;

create or replace function public.set_context_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists context_summaries_set_updated_at on public.context_summaries;
create trigger context_summaries_set_updated_at
  before update on public.context_summaries
  for each row execute function public.set_context_updated_at();

drop trigger if exists context_memories_set_updated_at on public.context_memories;
create trigger context_memories_set_updated_at
  before update on public.context_memories
  for each row execute function public.set_context_updated_at();

alter table public.context_summaries enable row level security;
alter table public.context_memories enable row level security;

drop policy if exists context_summaries_own_rows on public.context_summaries;
create policy context_summaries_own_rows
  on public.context_summaries
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists context_memories_own_rows on public.context_memories;
create policy context_memories_own_rows
  on public.context_memories
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.context_summaries from anon, authenticated;
revoke all on table public.context_memories from anon, authenticated;
grant select, insert, update, delete on table public.context_summaries to authenticated;
grant select, insert, update, delete on table public.context_memories to authenticated;
grant all on table public.context_summaries to service_role;
grant all on table public.context_memories to service_role;

create or replace function public.search_context_memories(
  query_embedding vector(1536),
  active_thread_id text,
  query_text text default '',
  keyword_terms text[] default '{}',
  match_limit integer default 5
)
returns table (
  id uuid,
  user_id uuid,
  thread_id text,
  source_thread_id text,
  content text,
  category text,
  source_message_ids text[],
  similarity double precision,
  keyword_score real
)
language sql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
  with vector_hits as (
    select
      memory.id,
      (1 - (memory.embedding <=> query_embedding))::double precision as similarity
    from public.context_memories as memory
    where query_embedding is not null
      and memory.user_id = (select auth.uid())
      and (memory.thread_id is null or memory.thread_id = active_thread_id)
      and memory.archived_at is null
      and memory.embedding_model = 'text-embedding-3-small'
      and memory.embedding is not null
    order by memory.embedding <=> query_embedding
    limit least(greatest(coalesce(match_limit, 5), 1) * 4, 40)
  ),
  lexical_hits as (
    select
      memory.id,
      ts_rank_cd(
        to_tsvector('simple', memory.content),
        websearch_to_tsquery('simple', coalesce(query_text, ''))
      )::real as text_score,
      exists (
        select 1
        from unnest(coalesce(keyword_terms, '{}'::text[])) as keyword(term)
        where length(keyword.term) > 1
          and position(lower(keyword.term) in lower(memory.content)) > 0
      ) as exact_match
    from public.context_memories as memory
    where memory.user_id = (select auth.uid())
      and (memory.thread_id is null or memory.thread_id = active_thread_id)
      and memory.archived_at is null
      and (
        to_tsvector('simple', memory.content)
          @@ websearch_to_tsquery('simple', coalesce(query_text, ''))
        or exists (
          select 1
          from unnest(coalesce(keyword_terms, '{}'::text[])) as keyword(term)
          where length(keyword.term) > 1
            and position(lower(keyword.term) in lower(memory.content)) > 0
        )
      )
    order by exact_match desc, text_score desc
    limit least(greatest(coalesce(match_limit, 5), 1) * 2, 20)
  ),
  candidate_ids as (
    select id from vector_hits
    union
    select id from lexical_hits
  )
  select
    memory.id,
    memory.user_id,
    memory.thread_id,
    memory.source_thread_id,
    memory.content,
    memory.category,
    memory.source_message_ids,
    vector_hits.similarity,
    coalesce(lexical_hits.text_score, 0)
      + case when lexical_hits.exact_match then 1 else 0 end as keyword_score
  from candidate_ids
  join public.context_memories as memory on memory.id = candidate_ids.id
  left join vector_hits on vector_hits.id = memory.id
  left join lexical_hits on lexical_hits.id = memory.id
  order by
    coalesce(vector_hits.similarity, 0)
      + coalesce(lexical_hits.text_score, 0) * 0.2
      + case when lexical_hits.exact_match then 0.5 else 0 end desc
  limit least(greatest(coalesce(match_limit, 5), 1), 10);
$$;

revoke all on function public.search_context_memories(vector, text, text, text[], integer)
  from public, anon;
grant execute on function public.search_context_memories(vector, text, text, text[], integer)
  to authenticated;

comment on table public.context_summaries is
  'Versioned per-user, per-thread compact summaries; thread IDs reference existing chat_threads rows.';
comment on table public.context_memories is
  'User-owned durable facts and decisions; null thread_id denotes user-wide scope.';
comment on function public.search_context_memories(vector, text, text, text[], integer) is
  'RLS-scoped cosine and lexical retrieval; callers must use the authenticated user JWT.';