# Promptloom

A small, Vercel-ready prompt-chain studio backed by Supabase. It supports Google OAuth with PKCE and a `profiles.is_superadmin` gate, prompt-chain and step CRUD, step reordering, sequential text generation with optional image input, saved outputs, search, and light/dark/system themes.

## Supabase setup

1. In the Supabase SQL editor, run [`supabase/migrations/20261105000000_promptloom.sql`](supabase/migrations/20261105000000_promptloom.sql), then [`supabase/migrations/20261105000001_shared_prompt_chain_access.sql`](supabase/migrations/20261105000001_shared_prompt_chain_access.sql). Run these after the admin-panel schema: it deliberately made prompt chains read-only, while this tool needs superadmin-only create/update/delete access. The migrations expect `public.profiles.id` to match `auth.users.id` and `profiles.is_superadmin` to be true for the account using the tool. The compatibility migration also supports the existing Week 7 step columns.
2. In **Authentication → Providers → Google**, enable Google using the same OAuth client setup as your other apps. In **Authentication → URL Configuration**, add `http://localhost:8000/` and `https://promptchaintool2026.vercel.app/` to the allowed redirect URLs. The OAuth callback URI for Google Cloud is `https://exzfdcrmdgcyaozmtmvg.supabase.co/auth/v1/callback`.
3. In the Supabase Dashboard, open **Edge Functions → Secrets** and add `GEMINI_API_KEY` there (Vercel environment variables are not passed to Supabase Functions). Then, from the repository folder, authenticate and deploy:

   ```sh
   npx supabase login
   npx supabase link --project-ref exzfdcrmdgcyaozmtmvg
   npx supabase functions deploy run-prompt-chain
   ```

   The function uses Gemini 3.8 Flash through the `generateContent` API. It sends each step in order and passes the previous result forward. The first step can also receive a PNG, JPG, or WEBP image.

The browser is a static site and connects to project `exzfdcrmdgcyaozmtmvg` with its publishable key in `app.js`; Vercel `NEXT_PUBLIC_*` variables are not injected into static files. The key is intended for client applications; database access is restricted by row-level security. The edge function checks the signed-in user's profile again before generating output.

## Run locally

Serve this folder from a local web server, such as `python3 -m http.server 8000`, then open `http://localhost:8000`. Add that URL to Supabase's auth redirect allowlist. This is a static app and does not need a build step.

## Deploy

Import this repository as a Vercel project with the repository root as the project root. No Vercel build command or output directory is required. Turn off Vercel Deployment Protection for the public-facing preview if it needs to open in Incognito; app data remains protected by Supabase auth and RLS.
