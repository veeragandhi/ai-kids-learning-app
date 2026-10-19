-- AmigosNest initial schema (run in the Supabase SQL Editor, or via `supabase db push`).
-- Dual-runtime (Web + Desktop) local-first learning platform.
-- Children are pseudonymous (nickname + emoji avatar only) and cascade-delete
-- with their parent account.
--
-- Local-first boundary: lesson content, embeddings, quiz attempts, and Ask
-- sessions are stored ON DEVICE (IndexedDB / localStorage / uploads/ +
-- embeddings/vectors.json) and never leave it. Supabase holds only auth,
-- the pseudonymous child profile, document metadata, and the per-concept
-- progress rollup that a parent dashboard reads.

-- 1. Pseudonymous Child Profiles under Parent Account
create table if not exists children (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references auth.users(id) on delete cascade not null,
  nickname text not null,
  avatar text default '🦊',
  age int not null check (age >= 3 and age <= 18),
  voice text default 'neutral',
  language text default 'en',
  preferences jsonb default '{"sound": true, "theme": "default", "default_hint_level": 1}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. Uploaded Worksheets / Source Materials — METADATA ONLY for the parent
--    dashboard. The file bytes and extracted text stay on-device (uploads/
--    and uploads/documents.json via lib/documents.ts) and are never sent to
--    Supabase, so this table carries no lesson content.
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references auth.users(id) on delete cascade not null,
  child_id uuid references children(id) on delete cascade not null,
  name text not null,
  ocr_status text check (ocr_status in ('pending', 'processing', 'completed', 'failed')) default 'completed',
  approved boolean default true,
  created_at timestamptz default now()
);

-- 3. Long-term Skill & Mastery Rollup (parent-dashboard read model)
create table if not exists progress (
  id uuid primary key default gen_random_uuid(),
  child_id uuid references children(id) on delete cascade not null,
  concept text not null,
  subject text default 'General',
  attempts int default 1,
  correct int default 0,
  mastery_score numeric(3,2) default 0.10 check (mastery_score >= 0.0 and mastery_score <= 1.0),
  last_seen timestamptz default now(),
  next_review_due timestamptz default now(),
  unique(child_id, concept)
);

-- Row Level Security
alter table children enable row level security;
alter table documents enable row level security;
alter table progress enable row level security;

-- Parent Access Isolation Policies
create policy "Parent owns children" on children
  for all using (auth.uid() = parent_id) with check (auth.uid() = parent_id);

create policy "Parent owns documents" on documents
  for all using (auth.uid() = parent_id) with check (auth.uid() = parent_id);

create policy "Parent manages progress via children" on progress
  for all using (exists (select 1 from children where children.id = progress.child_id and children.parent_id = auth.uid()));

-- Grants: tables created as postgres are not accessible to the
-- authenticated app role until granted (missing grants = 42501
-- "permission denied for table ..."). RLS policies alone are not enough.
grant select, insert, update, delete on children to authenticated;
grant select, insert, update, delete on documents to authenticated;
grant select, insert, update, delete on progress to authenticated;

-- Keep updated_at fresh for rows that carry it
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists children_touch_updated_at on children;
create trigger children_touch_updated_at
  before update on children
  for each row execute function public.touch_updated_at();
