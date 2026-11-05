import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const openAiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openAiKey) return json({ error: 'The OPENAI_API_KEY secret is not configured for this project.' }, 503);
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Sign in to run a prompt chain.' }, 401);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: 'Your session expired. Sign in again.' }, 401);
  const { data: profile } = await supabase.from('profiles').select('is_superadmin').eq('id', user.id).maybeSingle();
  if (!profile?.is_superadmin) return json({ error: 'Superadmin access is required.' }, 403);

  let body: { chain_id?: string; input_text?: string; image_data?: string | null };
  try { body = await req.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
  if (!body.chain_id || typeof body.chain_id !== 'string') return json({ error: 'Choose a prompt chain to run.' }, 400);
  if ((body.input_text?.length || 0) > 30000) return json({ error: 'Text input must be 30,000 characters or less.' }, 413);
  if (body.image_data && (!/^data:image\/(png|jpeg|webp);base64,/.test(body.image_data) || body.image_data.length > 14_000_000)) return json({ error: 'Use a PNG, JPG, or WEBP image up to 10 MB.' }, 413);

  const { data: steps, error: stepError } = await supabase.from('prompt_chain_steps')
    .select('title,prompt,position').eq('chain_id', body.chain_id).order('position');
  if (stepError) return json({ error: stepError.message }, 400);
  if (!steps?.length) return json({ error: 'This chain needs at least one step.' }, 400);

  let output = body.input_text?.trim() || '';
  try {
    for (const [index, step] of steps.entries()) {
      const instruction = step.prompt.replaceAll('{{input}}', output || '(no previous text output)');
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: `Starting input / previous step output:\n${output || '(No text was provided.)'}` }];
      if (index === 0 && body.image_data) content.push({ type: 'image_url', image_url: { url: body.image_data, detail: 'auto' } });
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.8, messages: [
          { role: 'system', content: `You are performing step ${index + 1} of a creative prompt chain called "${step.title}". Follow the step instructions carefully and return only the requested result.\n\nInstructions:\n${instruction}` },
          { role: 'user', content },
        ] }),
      });
      const result = await response.json();
      if (!response.ok) return json({ error: result?.error?.message || `AI request failed at step ${index + 1}.` }, 502);
      output = result.choices?.[0]?.message?.content?.trim() || '';
      if (!output) return json({ error: `Step ${index + 1} returned an empty result.` }, 502);
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not run the prompt chain.' }, 502);
  }

  const { data: saved, error: saveError } = await supabase.from('generated_media').insert({
    chain_id: body.chain_id, input_text: body.input_text?.trim() || null, output_text: output,
  }).select().single();
  if (saveError) return json({ error: `The result was generated but could not be saved: ${saveError.message}` }, 400);
  return json({ media: saved });
});
