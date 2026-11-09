import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const GEMINI_FALLBACK_ORDER = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

type Provider = { id: string; name: string; provider_key: string; is_active: boolean };
type Model = { id: string; name: string; model_key: string; provider_id: string | null; is_active: boolean; provider?: Provider };

function isGeminiModel(model: Model) {
  const providerKey = model.provider?.provider_key?.toLowerCase() || '';
  return /^gemini-[a-z0-9.-]+$/i.test(model.model_key) && (providerKey.includes('gemini') || providerKey.includes('google'));
}

async function generateWithFallback(
  apiKey: string,
  models: Model[],
  systemInstruction: string,
  parts: Array<Record<string, unknown>>,
) {
  let lastMessage = 'Gemini could not generate a response.';
  let totalLatency = 0;

  for (const model of models) {
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.model_key)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts }],
        }),
      });
    } catch (error) {
      totalLatency += performance.now() - started;
      lastMessage = error instanceof Error ? error.message : 'Could not reach the Gemini API.';
      continue;
    }

    const result = await response.json().catch(() => ({}));
    totalLatency += performance.now() - started;
    if (response.ok) return { result, model, error: null as string | null, latencyMs: Math.round(totalLatency), status: 200 };

    lastMessage = result?.error?.message || `Gemini returned HTTP ${response.status}.`;
    if (response.status === 429) {
      return { result: null, model, error: `Gemini rate/quota limit reached. Check this API key's project limits in AI Studio. ${lastMessage}`, latencyMs: Math.round(totalLatency), status: 429 };
    }
    if (response.status !== 503 && response.status < 500) {
      return { result: null, model, error: lastMessage, latencyMs: Math.round(totalLatency), status: response.status };
    }
  }

  return {
    result: null,
    model: models[0] || null,
    error: `Gemini is currently at capacity across the active catalog models. Please try again later. ${lastMessage}`,
    latencyMs: Math.round(totalLatency),
    status: 503,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Sign in to run a prompt chain.' }, 401);
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: 'Your session expired. Sign in again.' }, 401);
  const { data: profile } = await supabase.from('profiles').select('is_superadmin').eq('id', user.id).maybeSingle();
  if (!profile?.is_superadmin) return json({ error: 'Superadmin access is required.' }, 403);

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) return json({ error: 'The GEMINI_API_KEY secret is not configured in Supabase Edge Function Secrets.' }, 503);

  let secretKey: string | undefined;
  try { secretKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default; } catch { /* use legacy key below */ }
  secretKey ||= Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secretKey) return json({ error: 'Supabase did not provide its server-side secret key, so this run cannot be logged.' }, 503);
  const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: { chain_id?: string; input_text?: string; image_data?: string | null };
  try { body = await req.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
  if (!body.chain_id || typeof body.chain_id !== 'string') return json({ error: 'Choose a prompt chain to run.' }, 400);
  if ((body.input_text?.length || 0) > 30000) return json({ error: 'Text input must be 30,000 characters or less.' }, 413);
  if (body.image_data && (!/^data:image\/(png|jpeg|webp);base64,/.test(body.image_data) || body.image_data.length > 14_000_000)) return json({ error: 'Use a PNG, JPG, or WEBP image up to 10 MB.' }, 413);

  const { data: steps, error: stepError } = await supabase.from('prompt_chain_steps')
    .select('id,model_id,name,system_prompt,prompt_template,step_order').eq('chain_id', body.chain_id).order('step_order');
  if (stepError) return json({ error: stepError.message }, 400);
  if (!steps?.length) return json({ error: 'This chain needs at least one step.' }, 400);

  const [modelResult, providerResult] = await Promise.all([
    supabase.from('llm_models').select('id,name,model_key,provider_id,is_active').eq('is_active', true),
    supabase.from('llm_providers').select('id,name,provider_key,is_active').eq('is_active', true),
  ]);
  if (modelResult.error || providerResult.error) {
    return json({ error: `Could not read the shared LLM catalog: ${modelResult.error?.message || providerResult.error?.message}` }, 400);
  }
  const providerById = new Map<string, Provider>();
  for (const provider of providerResult.data || []) providerById.set(provider.id, provider as Provider);
  const activeModels: Model[] = (modelResult.data || []).map((model: Model) => ({ ...model, provider: providerById.get(model.provider_id || '') }))
    .filter((model: Model) => model.provider?.is_active);
  const geminiModels = activeModels.filter(isGeminiModel);
  const modelRank = (model: Model) => {
    const index = GEMINI_FALLBACK_ORDER.indexOf(model.model_key);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const orderedGeminiModels = [...geminiModels].sort((a, b) => modelRank(a) - modelRank(b));
  const defaultModel = orderedGeminiModels[0];
  if (!defaultModel) return json({ error: 'There are no active Gemini models in the shared LLM catalog. Add a Gemini provider and model in the admin panel first.' }, 400);

  const { data: requestRecord, error: requestError } = await admin.from('generation_requests').insert({
    user_id: user.id,
    request_type: 'prompt_chain',
    status: 'processing',
    input_text: body.input_text?.trim() || null,
    prompt_chain_id: body.chain_id,
  }).select('id').single();
  if (requestError || !requestRecord) return json({ error: `Could not record this run in the admin panel: ${requestError?.message || 'No request ID was returned.'}` }, 500);

  const updateRequest = async (status: string, errorMessage: string | null = null) => {
    const { error } = await admin.from('generation_requests').update({ status, error_message: errorMessage, completed_at: new Date().toISOString() }).eq('id', requestRecord.id);
    return error;
  };
  const logLlmResponse = async (record: Record<string, unknown>) => {
    const { error } = await admin.from('llm_responses').insert({ request_id: requestRecord.id, ...record });
    return error;
  };

  let output = body.input_text?.trim() || '';
  for (const [index, step] of steps.entries()) {
    const assignedModel = step.model_id ? activeModels.find(model => model.id === step.model_id) : null;
    if (step.model_id && !assignedModel) {
      const message = `Step ${index + 1} points to a model that is no longer active in the admin catalog. Edit this step and choose an active model.`;
      await updateRequest('failed', message);
      return json({ error: message }, 400);
    }
    const chosenModel = assignedModel || defaultModel;
    if (!isGeminiModel(chosenModel)) {
      const message = `Step ${index + 1} uses ${chosenModel.provider?.name || 'an unsupported provider'}. This runner currently supports Gemini models only.`;
      await logLlmResponse({ model_id: chosenModel.id, step_id: step.id, prompt_text: step.prompt_template, response_text: message, status: 'failed' });
      await updateRequest('failed', message);
      return json({ error: message }, 400);
    }
    const fallbackModels = [chosenModel, ...orderedGeminiModels.filter(model => model.id !== chosenModel.id)];
    const previousOutput = output;
    const instruction = `${step.system_prompt ? `${step.system_prompt}\n\n` : ''}${step.prompt_template}`.replaceAll('{{input}}', output || '(no previous text output)');
    const systemInstruction = `You are performing step ${index + 1} of a creative prompt chain. Follow the step instructions carefully and return only the requested result.\n\nInstructions:\n${instruction}`;
    const parts: Array<Record<string, unknown>> = [{ text: `Starting input / previous step output:\n${output || '(No text was provided.)'}` }];
    if (index === 0 && body.image_data) {
      const [dataHeader, imageBytes] = body.image_data.split(',', 2);
      const mimeType = dataHeader.slice(5).split(';')[0];
      parts.push({ inline_data: { mime_type: mimeType, data: imageBytes } });
    }

    const promptForLog = `${systemInstruction}\n\nInput / previous step output:\n${previousOutput || '(No text was provided.)'}${index === 0 && body.image_data ? '\n[Image attached]' : ''}`;
    const generated = await generateWithFallback(geminiKey, fallbackModels, systemInstruction, parts);
    if (generated.error || !generated.result || !generated.model) {
      const message = `Step ${index + 1}: ${generated.error || 'The model returned no result.'}`;
      const logError = await logLlmResponse({ model_id: generated.model?.id || chosenModel.id, step_id: step.id, prompt_text: promptForLog, response_text: message, status: 'failed', latency_ms: generated.latencyMs });
      await updateRequest('failed', message);
      if (logError) return json({ error: `${message} The failure could not be added to llm_responses: ${logError.message}` }, 500);
      return json({ error: message }, generated.status === 429 ? 429 : 502);
    }

    const result = generated.result;
    output = result.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('').trim() || '';
    const usage = result.usageMetadata || {};
    if (!output) {
      const message = `Step ${index + 1} returned an empty result.`;
      const logError = await logLlmResponse({ model_id: generated.model.id, step_id: step.id, prompt_text: promptForLog, response_text: message, status: 'failed', latency_ms: generated.latencyMs, input_tokens: usage.promptTokenCount ?? null, output_tokens: usage.candidatesTokenCount ?? null });
      await updateRequest('failed', message);
      if (logError) return json({ error: `${message} The failure could not be added to llm_responses: ${logError.message}` }, 500);
      return json({ error: message }, 502);
    }

    const logError = await logLlmResponse({
      model_id: generated.model.id,
      step_id: step.id,
      prompt_text: promptForLog,
      response_text: output,
      status: 'completed',
      latency_ms: generated.latencyMs,
      input_tokens: usage.promptTokenCount ?? null,
      output_tokens: usage.candidatesTokenCount ?? null,
    });
    if (logError) {
      const message = `Step ${index + 1} ran, but its LLM response could not be logged: ${logError.message}`;
      await updateRequest('failed', message);
      return json({ error: message }, 500);
    }
  }

  let inputImagePath: string | null = null;
  if (body.image_data) {
    const [dataHeader, encoded] = body.image_data.split(',', 2);
    const mimeType = dataHeader.slice(5).split(';')[0];
    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    inputImagePath = `${user.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from('promptloom-inputs').upload(inputImagePath, bytes, { contentType: mimeType, upsert: false });
    if (uploadError) {
      const message = `The captions were generated, but the attached image could not be saved: ${uploadError.message}`;
      await updateRequest('failed', message);
      return json({ error: message }, 400);
    }
  }

  const { data: saved, error: saveError } = await supabase.from('generated_media').insert({
    chain_id: body.chain_id, input_text: body.input_text?.trim() || null, input_image_path: inputImagePath, output_text: output,
  }).select().single();
  if (saveError) {
    const message = `The result was generated but could not be saved: ${saveError.message}`;
    await updateRequest('failed', message);
    return json({ error: message }, 400);
  }
  const completionError = await updateRequest('completed');
  if (completionError) return json({ error: `The result was saved, but its request log could not be completed: ${completionError.message}` }, 500);
  return json({ media: saved, request_id: requestRecord.id });
});
