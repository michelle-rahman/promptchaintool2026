-- Promptloom schema. profiles(id) is expected to reference auth.users(id).
create or replace function public.is_promptloom_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_superadmin is true
  );
$$;

revoke all on function public.is_promptloom_superadmin() from public;
grant execute on function public.is_promptloom_superadmin() to authenticated;

-- Let a signed-in user read their own access flag; the flag itself remains admin managed.
alter table public.profiles enable row level security;
do $$ begin
  create policy "Users can read their own profile" on public.profiles
    for select to authenticated using (id = (select auth.uid()));
exception when duplicate_object then null; end $$;

create table if not exists public.prompt_chains (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  description text check (description is null or char_length(description) <= 500),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.prompt_chain_steps (
  id uuid primary key default gen_random_uuid(),
  chain_id uuid not null references public.prompt_chains(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  prompt text not null check (char_length(prompt) between 1 and 12000),
  position integer not null check (position > 0),
  created_at timestamptz not null default now(),
  unique(chain_id, position) deferrable initially deferred
);
create table if not exists public.generated_media (
  id uuid primary key default gen_random_uuid(),
  chain_id uuid not null references public.prompt_chains(id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  input_text text,
  output_text text not null,
  created_at timestamptz not null default now()
);

create or replace function public.touch_prompt_chain()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists prompt_chains_touch_updated_at on public.prompt_chains;
create trigger prompt_chains_touch_updated_at before update on public.prompt_chains
for each row execute function public.touch_prompt_chain();

create or replace function public.bump_prompt_chain_on_step_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare affected_chain uuid;
begin
  affected_chain := case when tg_op = 'DELETE' then old.chain_id else new.chain_id end;
  update public.prompt_chains set updated_at = now() where id = affected_chain;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists prompt_steps_touch_chain on public.prompt_chain_steps;
create trigger prompt_steps_touch_chain after insert or update or delete on public.prompt_chain_steps
for each row execute function public.bump_prompt_chain_on_step_change();

alter table public.prompt_chains enable row level security;
alter table public.prompt_chain_steps enable row level security;
alter table public.generated_media enable row level security;
do $$ begin
  create policy "Superadmins manage prompt chains" on public.prompt_chains
    for all to authenticated using (public.is_promptloom_superadmin()) with check (public.is_promptloom_superadmin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "Superadmins manage prompt steps" on public.prompt_chain_steps
    for all to authenticated using (public.is_promptloom_superadmin()) with check (public.is_promptloom_superadmin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "Superadmins manage generated media" on public.generated_media
    for all to authenticated using (public.is_promptloom_superadmin()) with check (public.is_promptloom_superadmin());
exception when duplicate_object then null; end $$;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.prompt_chains, public.prompt_chain_steps, public.generated_media to authenticated;
