import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

async function generateWithFallback(apiKey: string, systemInstruction: string, parts: Array<Record<string, unknown>>) {
  let lastMessage = 'Gemini could not generate a response.';

  for (const model of GEMINI_MODELS) {
    let response: Response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts }],
        }),
      });
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : 'Could not reach the Gemini API.';
      continue;
    }

    const result = await response.json().catch(() => ({}));
    if (response.ok) return { result, error: null as string | null, status: 200 };

    lastMessage = result?.error?.message || `Gemini returned HTTP ${response.status}.`;
    if (response.status !== 503 && response.status !== 429 && response.status < 500) {
      return { result: null, error: lastMessage, status: response.status };
    }
    if (response.status === 429) {
      return { result: null, error: `Gemini rate/quota limit reached. Check this API key's project limits in AI Studio. ${lastMessage}`, status: 429 };
    }
  }

  return {
    result: null,
    error: `Gemini is currently at capacity across the available Flash models. Please try again later. ${lastMessage}`,
    status: 503,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) return json({ error: 'The GEMINI_API_KEY secret is not configured in Supabase Edge Function Secrets.' }, 503);
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
    .select('name,system_prompt,prompt_template,step_order').eq('chain_id', body.chain_id).order('step_order');
  if (stepError) return json({ error: stepError.message }, 400);
  if (!steps?.length) return json({ error: 'This chain needs at least one step.' }, 400);

  let output = body.input_text?.trim() || '';
  try {
    for (const [index, step] of steps.entries()) {
      const instruction = `${step.system_prompt ? `${step.system_prompt}\n\n` : ''}${step.prompt_template}`.replaceAll('{{input}}', output || '(no previous text output)');
      const parts: Array<Record<string, unknown>> = [{ text: `Starting input / previous step output:\n${output || '(No text was provided.)'}` }];
      if (index === 0 && body.image_data) {
        const [dataHeader, imageBytes] = body.image_data.split(',', 2);
        const mimeType = dataHeader.slice(5).split(';')[0];
        parts.push({ inline_data: { mime_type: mimeType, data: imageBytes } });
      }
      const generated = await generateWithFallback(
        geminiKey,
        `You are performing step ${index + 1} of a creative prompt chain called "${step.name}". Follow the step instructions carefully and return only the requested result.\n\nInstructions:\n${instruction}`,
        parts,
      );
      if (generated.error) return json({ error: `Step ${index + 1}: ${generated.error}` }, generated.status === 429 ? 429 : 502);
      const result = generated.result!;
      output = result.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('').trim() || '';
      if (!output) return json({ error: `Step ${index + 1} returned an empty result.` }, 502);
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not run the prompt chain.' }, 502);
  }

  let inputImagePath: string | null = null;
  if (body.image_data) {
    const [dataHeader, encoded] = body.image_data.split(',', 2);
    const mimeType = dataHeader.slice(5).split(';')[0];
    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    inputImagePath = `${user.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from('promptloom-inputs').upload(inputImagePath, bytes, {
      contentType: mimeType,
      upsert: false,
    });
    if (uploadError) return json({ error: `The captions were generated, but the attached image could not be saved: ${uploadError.message}` }, 400);
  }

  const { data: saved, error: saveError } = await supabase.from('generated_media').insert({
    chain_id: body.chain_id, input_text: body.input_text?.trim() || null, input_image_path: inputImagePath, output_text: output,
  }).select().single();
  if (saveError) return json({ error: `The result was generated but could not be saved: ${saveError.message}` }, 400);
  return json({ media: saved });
});
