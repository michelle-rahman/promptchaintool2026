-- Run after the Promptloom base migration. This also upgrades the Week 7
-- read-only prompt-chain tables so the Week 8 tool can manage them.
alter table public.prompt_chain_steps add column if not exists title text;
alter table public.prompt_chain_steps add column if not exists prompt text;
alter table public.prompt_chain_steps add column if not exists position integer;
alter table public.prompt_chain_steps add column if not exists name text;
alter table public.prompt_chain_steps add column if not exists system_prompt text;
alter table public.prompt_chain_steps add column if not exists prompt_template text;
alter table public.prompt_chain_steps add column if not exists step_order integer;

update public.prompt_chain_steps
set title = coalesce(nullif(title, ''), nullif(name, ''), 'Step'),
    name = coalesce(nullif(name, ''), nullif(title, ''), 'Step'),
    prompt = coalesce(nullif(prompt, ''), prompt_template, ''),
    prompt_template = coalesce(nullif(prompt_template, ''), prompt, ''),
    position = coalesce(position, step_order, 1),
    step_order = coalesce(step_order, position, 1);

alter table public.prompt_chain_steps alter column title set not null;
alter table public.prompt_chain_steps alter column prompt set not null;
alter table public.prompt_chain_steps alter column position set not null;
alter table public.prompt_chain_steps alter column name set not null;
alter table public.prompt_chain_steps alter column prompt_template set not null;
alter table public.prompt_chain_steps alter column step_order set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.prompt_chain_steps'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (chain_id, position)'
  ) then
    alter table public.prompt_chain_steps
      add constraint prompt_chain_steps_chain_id_position_key unique (chain_id, position);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.prompt_chain_steps'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (chain_id, step_order)'
  ) then
    alter table public.prompt_chain_steps
      add constraint prompt_chain_steps_chain_id_step_order_key unique (chain_id, step_order);
  end if;
end $$;

create or replace function public.is_promptloom_superadmin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_superadmin is true
  );
$$;
revoke all on function public.is_promptloom_superadmin() from public;
grant execute on function public.is_promptloom_superadmin() to authenticated;

alter table public.prompt_chains enable row level security;
alter table public.prompt_chain_steps enable row level security;
alter table public.generated_media enable row level security;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.prompt_chains, public.prompt_chain_steps, public.generated_media to authenticated;

do $$ begin
  create policy "Promptloom superadmins manage chains" on public.prompt_chains
    for all to authenticated using (public.is_promptloom_superadmin()) with check (public.is_promptloom_superadmin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "Promptloom superadmins manage steps" on public.prompt_chain_steps
    for all to authenticated using (public.is_promptloom_superadmin()) with check (public.is_promptloom_superadmin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "Promptloom superadmins manage media" on public.generated_media
    for all to authenticated using (public.is_promptloom_superadmin()) with check (public.is_promptloom_superadmin());
exception when duplicate_object then null; end $$;
