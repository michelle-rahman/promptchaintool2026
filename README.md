# Promptloom

A small, Vercel-ready prompt-chain studio backed by Supabase. It supports Google OAuth with a `profiles.is_superadmin` gate, prompt-chain and step CRUD, step reordering, sequential text generation with optional image input, saved outputs, search, and light/dark/system themes.

## Supabase setup

1. In the Supabase SQL editor, run [`supabase/migrations/20261105000000_promptloom.sql`](supabase/migrations/20261105000000_promptloom.sql). It expects the existing `public.profiles` table to contain `id` (the matching `auth.users.id`) and `is_superadmin boolean`. The migration adds a self-profile read policy plus superadmin-only policies for the tool tables.
2. In **Authentication → Providers → Google**, enable Google using the same OAuth client setup as your other apps. In **Authentication → URL Configuration**, add `http://localhost:8000/` and `https://promptchaintool2026.vercel.app/` to the allowed redirect URLs. The OAuth callback URI for Google Cloud is `https://exzfdcrmdgcyaozmtmvg.supabase.co/auth/v1/callback`.
3. Set the model secret for the edge function, then deploy it:

   ```sh
   supabase secrets set OPENAI_API_KEY=your_key
   supabase functions deploy run-prompt-chain
   ```

   The function uses `gpt-4o-mini`; it sends each step to the OpenAI Chat Completions API in order and passes the previous result forward. The first step can also receive a PNG, JPG, or WEBP image.

The browser connects to project `exzfdcrmdgcyaozmtmvg` with its publishable key. The key is intended for client applications; database access is restricted by row-level security. The edge function checks the signed-in user's profile again before generating output.

## Run locally

Serve this folder from a local web server, such as `python3 -m http.server 8000`, then open `http://localhost:8000`. Add that URL to Supabase's auth redirect allowlist. This is a static app and does not need a build step.

## Deploy

Import this repository as a Vercel project with the repository root as the project root. No Vercel build command or output directory is required. Turn off Vercel Deployment Protection for the public-facing preview if it needs to open in Incognito; app data remains protected by Supabase auth and RLS.
