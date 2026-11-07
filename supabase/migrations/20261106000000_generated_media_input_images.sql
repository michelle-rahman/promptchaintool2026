-- Store attached source images privately alongside generated captions.
alter table public.generated_media
  add column if not exists input_image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'promptloom-inputs',
  'promptloom-inputs',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $$ begin
  create policy "Promptloom superadmins view input images" on storage.objects
    for select to authenticated
    using (bucket_id = 'promptloom-inputs' and public.is_promptloom_superadmin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Promptloom superadmins upload input images" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'promptloom-inputs' and public.is_promptloom_superadmin());
exception when duplicate_object then null; end $$;
