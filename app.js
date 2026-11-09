const SUPABASE_URL = 'https://exzfdcrmdgcyaozmtmvg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-4QAid15Hwg5bBdWUMd-_w_-wBUxFRx';
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: true },
});
const $ = (s) => document.querySelector(s);
const state = { user: null, chains: [], steps: [], models: [], providers: [], selected: null, editStepId: null, filter: 'all', image: null, theme: localStorage.getItem('promptloom-theme') || 'system' };
const artClasses = ['green','lav','peach','blue','pink','gold'];
const artSymbols = ['✳','✦','◌','⌁','✿','✧'];
const GEMINI_MODEL_ORDER = ['gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.5-flash-lite'];

function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600); }
function friendlyError(error) { if(error?.code==='42501') return 'Supabase denied this write. Run the Promptloom Supabase migrations after the admin-panel migration.'; return error?.message?.replace(/^.*?: /,'') || 'Something went wrong. Please try again.'; }
async function functionErrorMessage(error) {
  if (error?.name === 'FunctionsFetchError') return 'Could not reach run-prompt-chain. Deploy the Supabase Edge Function and check its CORS settings.';
  if (error?.context && typeof error.context.clone === 'function') {
    const response=error.context, body=await response.clone().json().catch(()=>null);
    if(body?.error) return body.error;
    if(response.status) return `run-prompt-chain returned HTTP ${response.status}. Check the Supabase Edge Function logs.`;
  }
  return friendlyError(error);
}
function applyTheme() { const dark = state.theme === 'dark' || (state.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); document.body.classList.toggle('theme-dark', dark); $('#theme-toggle').textContent = state.theme === 'light' ? '☼' : state.theme === 'dark' ? '☾' : '◐'; }
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }
async function initialize() {
  applyTheme();
  const { data: { session } } = await sbClient.auth.getSession();
  if (!session) return showLogin();
  await acceptSession(session);
}
async function acceptSession(session) {
  const { data: profile, error } = await sbClient.from('profiles').select('is_superadmin').eq('id', session.user.id).maybeSingle();
  if (error || !profile?.is_superadmin) { await sbClient.auth.signOut(); showLogin(); $('#login-note').textContent = error ? `Could not verify superadmin profile: ${friendlyError(error)}` : 'This account does not have superadmin access.'; return; }
  state.user = session.user; $('#user-email').textContent = session.user.email || 'Superadmin'; $('#avatar').textContent = $('#top-avatar').textContent = (session.user.email || 'S').slice(0,1).toUpperCase(); showApp(); await loadModelCatalog(); await loadChains();
}
async function loadModelCatalog() {
  const [modelResult, providerResult] = await Promise.all([
    sbClient.from('llm_models').select('id,name,model_key,provider_id,is_active').eq('is_active',true).order('name'),
    sbClient.from('llm_providers').select('id,name,provider_key,is_active').eq('is_active',true).order('name'),
  ]);
  if(modelResult.error||providerResult.error){toast(`Could not load the LLM catalog: ${friendlyError(modelResult.error||providerResult.error)}`);return;}
  state.providers=providerResult.data||[];
  const providers=new Map(state.providers.map(provider=>[provider.id,provider]));
  state.models=(modelResult.data||[]).map(model=>({...model,provider:providers.get(model.provider_id)}));
}
function isGeminiModel(model) { const providerKey=(model?.provider?.provider_key||'').toLowerCase(); return /^gemini-[a-z0-9.-]+$/i.test(model?.model_key||'')&&(providerKey.includes('gemini')||providerKey.includes('google')); }
function defaultGeminiModel() { const models=state.models.filter(isGeminiModel); return models.find(model=>GEMINI_MODEL_ORDER.includes(model.model_key))||models[0]||null; }
function modelTitle(model) { return `${model.name} · ${model.provider?.name||'Provider'} (${model.model_key})`; }
async function loadChains() {
  const { data, error } = await sbClient.from('prompt_chains').select('*, prompt_chain_steps(count)').order('updated_at', {ascending:false});
  if (error) { toast(friendlyError(error)); state.chains = []; } else state.chains = (data || []).map(c=>({...c,step_count:c.prompt_chain_steps?.[0]?.count||0}));
  renderChains();
  if (state.selected) { const latest = state.chains.find(c => c.id === state.selected.id); if (latest) { state.selected = latest; await openChain(latest, false); } else backToList(); }
}
function formatDate(value) { if (!value) return 'just now'; const d = new Date(value); const days = Math.floor((Date.now()-d.getTime())/86400000); if (days < 1) return 'Today'; if (days === 1) return 'Yesterday'; if (days < 7) return `${days} days ago`; return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
function renderChains() {
  const query = $('#search').value.trim().toLowerCase(); let list = [...state.chains];
  if (state.filter === 'recent') list = list.slice(0,6);
  if (query) list = list.filter(c => `${c.name} ${c.description || ''}`.toLowerCase().includes(query));
  $('#chain-count').textContent = state.chains.length; $('#all-count').textContent = state.chains.length;
  $('#chain-list').innerHTML = list.map((c,i)=>`<article class="chain-card" data-id="${c.id}"><div class="card-top"><div class="chain-art ${artClasses[i%6]}">${artSymbols[i%6]}</div><button class="card-menu" data-menu="${c.id}" aria-label="Chain actions">···</button></div><h3>${escapeHtml(c.name)}</h3><p class="description">${escapeHtml(c.description || 'A fresh canvas for your next idea.')}</p><div class="card-bottom"><div class="step-pills"><span>${Number(c.step_count)||0} ${Number(c.step_count)===1?'step':'steps'}</span><span class="mini-dots"><i></i><i></i><i></i></span></div><span class="updated">Edited ${formatDate(c.updated_at)}</span></div></article>`).join('');
  $('#empty-state').classList.toggle('hidden', state.chains.length > 0); $('#chain-list').classList.toggle('hidden', state.chains.length === 0 || !!state.selected || $('#media-page').classList.contains('hidden') === false);
  $('#toolbar').classList?.toggle('hidden', state.chains.length === 0);
  if (state.selected) $('#chain-list').classList.add('hidden');
  document.querySelectorAll('.chain-card').forEach(card=>card.addEventListener('click',e=>{if(!e.target.closest('[data-menu]')) openChain(state.chains.find(c=>c.id===card.dataset.id));}));
  document.querySelectorAll('[data-menu]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation(); const c=state.chains.find(x=>x.id===btn.dataset.menu); const choice=prompt(`Chain: ${c.name}\nType "edit" to rename or "delete" to remove.`, ''); if(choice?.toLowerCase()==='edit') editChain(c); if(choice?.toLowerCase()==='delete') deleteChain(c);}));
}
function escapeHtml(value='') { return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function openChain(chain, set=true) {
  if (!chain) return; if (set) state.selected = chain;
  $('#chain-list').classList.add('hidden'); $('#empty-state').classList.add('hidden'); $('#toolbar').classList.add('hidden'); $('#detail').classList.remove('hidden'); $('#media-page').classList.add('hidden');
  $('#detail-name').textContent=chain.name; $('#detail-description').textContent=chain.description || 'A fresh canvas for your next idea.';
  const {data,error}=await sbClient.from('prompt_chain_steps').select('*').eq('chain_id',chain.id).order('step_order');
  if(error){toast(friendlyError(error));return;} state.steps=(data||[]).map(s=>{const model=state.models.find(m=>m.id===s.model_id);return {...s,title:s.title||s.name,prompt:s.prompt||s.prompt_template,position:s.step_order??s.position??1,step_order:s.step_order??s.position??1,model_name:model?.name||null,provider_name:model?.provider?.name||null};}); renderSteps(); await loadMedia(chain.id);
}
function renderSteps() {
  $('#steps-list').innerHTML=state.steps.length?state.steps.map((s,i)=>`<article class="step-card"><div class="step-number">${String(i+1).padStart(2,'0')}</div><div class="step-content"><h4>${escapeHtml(s.title)}</h4><p class="step-model">${escapeHtml(s.model_name?`${s.model_name}${s.provider_name?` · ${s.provider_name}`:''}`:'No model selected')}</p><p>${escapeHtml(s.prompt)}</p></div><div class="step-controls"><button data-up="${s.id}" title="Move up" ${i===0?'disabled':''}>↑</button><button data-down="${s.id}" title="Move down" ${i===state.steps.length-1?'disabled':''}>↓</button><button data-edit-step="${s.id}" title="Edit">✎</button><button data-delete-step="${s.id}" title="Delete">×</button></div></article>`).join(''):'<div class="empty-media">No steps yet. Add the first step to start the chain.</div>';
  document.querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>moveStep(b.dataset.up,-1)); document.querySelectorAll('[data-down]').forEach(b=>b.onclick=()=>moveStep(b.dataset.down,1));
  document.querySelectorAll('[data-edit-step]').forEach(b=>b.onclick=()=>editStep(state.steps.find(s=>s.id===b.dataset.editStep)));
  document.querySelectorAll('[data-delete-step]').forEach(b=>b.onclick=()=>deleteStep(b.dataset.deleteStep));
}
async function moveStep(id,delta) {
  const index=state.steps.findIndex(s=>s.id===id), other=index+delta; if(other<0||other>=state.steps.length)return;
  const first=state.steps[index], second=state.steps[other], temporary=Math.max(...state.steps.map(s=>Math.max(s.step_order,s.position)))+1;
  let result=await sbClient.from('prompt_chain_steps').update({step_order:temporary,position:temporary}).eq('id',first.id);
  if(result.error){toast(friendlyError(result.error));return;}
  result=await sbClient.from('prompt_chain_steps').update({step_order:first.step_order,position:first.position}).eq('id',second.id);
  if(result.error){await sbClient.from('prompt_chain_steps').update({step_order:first.step_order,position:first.position}).eq('id',first.id);toast(friendlyError(result.error));await openChain(state.selected,false);return;}
  result=await sbClient.from('prompt_chain_steps').update({step_order:second.step_order,position:second.position}).eq('id',first.id);
  if(result.error){await sbClient.from('prompt_chain_steps').update({step_order:second.step_order,position:second.position}).eq('id',second.id);await sbClient.from('prompt_chain_steps').update({step_order:first.step_order,position:first.position}).eq('id',first.id);toast(friendlyError(result.error));await openChain(state.selected,false);return;}
  const next=[...state.steps];next[index]={...first,step_order:second.step_order,position:second.step_order};next[other]={...second,step_order:first.step_order,position:first.step_order};[next[index],next[other]]=[next[other],next[index]];state.steps=next;renderSteps();toast('Step order updated');
}
function openChainDialog(chain=null) { const form=$('#chain-form'); form.reset(); form.dataset.id=chain?.id||''; $('#chain-modal-title').textContent=chain?'Edit chain':'Create a chain'; form.elements.name.value=chain?.name||''; form.elements.description.value=chain?.description||''; $('#chain-dialog').showModal(); }
function editChain(chain) { openChainDialog(chain); }
async function saveChain(e) { e.preventDefault(); const f=e.currentTarget, id=f.dataset.id; const payload={name:f.elements.name.value.trim(),description:f.elements.description.value.trim()||null}; const result=id?await sbClient.from('prompt_chains').update(payload).eq('id',id).select().single():await sbClient.from('prompt_chains').insert(payload).select().single(); if(result.error){toast(friendlyError(result.error));return;} $('#chain-dialog').close(); toast(id?'Chain updated':'Chain created'); await loadChains(); if(!id) openChain(result.data); }
function openStepDialog(step=null) { const f=$('#step-form'); f.reset(); f.dataset.id=step?.id||''; $('#step-modal-title').textContent=step?'Edit step':'Add a step'; f.elements.title.value=step?.title||''; f.elements.prompt.value=step?.prompt||''; const select=f.elements.model_id, supported=state.models.filter(isGeminiModel), fallback=defaultGeminiModel(); select.innerHTML=supported.length?supported.map(model=>`<option value="${escapeHtml(model.id)}">${escapeHtml(modelTitle(model))}</option>`).join(''):'<option value="">No active Gemini models in the shared catalog</option>'; select.disabled=!supported.length; select.required=!!supported.length; select.value=supported.some(model=>model.id===step?.model_id)?step.model_id:(fallback?.id||''); $('#step-dialog').showModal(); }
function editStep(step){openStepDialog(step);}
async function saveStep(e) { e.preventDefault(); const f=e.currentTarget,id=f.dataset.id, existing=state.steps.find(s=>s.id===id), order=id?existing.step_order:Math.max(0,...state.steps.map(s=>Math.max(s.step_order,s.position)))+1,title=f.elements.title.value.trim(),prompt=f.elements.prompt.value.trim(); const payload={chain_id:state.selected.id,name:title,title,prompt_template:prompt,prompt,step_order:order,position:order,model_id:f.elements.model_id.value||null}; const result=id?await sbClient.from('prompt_chain_steps').update(payload).eq('id',id):await sbClient.from('prompt_chain_steps').insert(payload); if(result.error){toast(friendlyError(result.error));return;} $('#step-dialog').close(); toast(id?'Step updated':'Step added'); await loadChains(); }
async function deleteStep(id) { const step=state.steps.find(s=>s.id===id); if(!confirm(`Delete “${step.title}”?`))return; const {error}=await sbClient.from('prompt_chain_steps').delete().eq('id',id); if(error){toast(friendlyError(error));return;} toast('Step deleted'); await loadChains(); }
async function deleteChain(chain=state.selected) { if(!chain||!confirm(`Delete “${chain.name}” and all its steps?`))return; const {error}=await sbClient.from('prompt_chains').delete().eq('id',chain.id); if(error){toast(friendlyError(error));return;} state.selected=null; toast('Chain deleted'); await loadChains(); }
function backToList(){state.selected=null;$('#detail').classList.add('hidden');$('#media-page').classList.add('hidden');$('#toolbar').classList.remove('hidden');renderChains();}
async function loadMedia(chainId) { const {data,error}=await sbClient.from('generated_media').select('*').eq('chain_id',chainId).order('created_at',{ascending:false}).limit(20); if(error){$('#media-list').innerHTML='<div class="empty-media">Generated media is unavailable until the database setup is complete.</div>';return;} $('#media-list').innerHTML=data?.length?(await Promise.all(data.map(mediaRow))).join(''):'<div class="empty-media">Nothing generated yet. Run this chain to see what it creates.</div>'; }
async function mediaRow(m,chainName='') { let image=''; if(m.input_image_path){const {data}=await sbClient.storage.from('promptloom-inputs').createSignedUrl(m.input_image_path,3600);if(data?.signedUrl)image=`<img src="${escapeHtml(data.signedUrl)}" alt="Attached input image" loading="lazy">`;} return `<article class="media-row">${image?`<div class="media-thumb input-image-thumb">${image}</div>`:'<div class="media-thumb">✦</div>'}<div class="media-copy"><b>${escapeHtml(chainName||'Chain output')}</b>${image?'<small class="image-caption">Attached image</small>':''}<p>${escapeHtml(m.output_text||'No text output')}</p><small>${formatDate(m.created_at)}${m.input_text?` · Input: ${escapeHtml(m.input_text.slice(0,90))}`:''}</small></div></article>`; }
async function runChain() {
  if(!state.steps.length){toast('Add at least one step before running this chain.');return;} const input=$('#run-input').value.trim(); if(!input&&!state.image){toast('Add some text or an image as your starting point.');return;}
  const btn=$('#run-chain');btn.disabled=true;btn.innerHTML='<span class="spinner">◌</span> Running your chain…';
  try { let image_data=null; if(state.image) image_data=await fileToDataUrl(state.image); const {data,error}=await sbClient.functions.invoke('run-prompt-chain',{body:{chain_id:state.selected.id,input_text:input,image_data}}); if(error)throw error; toast('Your chain is complete'); await loadMedia(state.selected.id); await loadChains(); }
  catch(e){toast(await functionErrorMessage(e));} finally {btn.disabled=false;btn.innerHTML='Run chain <span>↗</span>';}
}
function fileToDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});}
async function showAllMedia(){state.selected=null;$('#detail').classList.add('hidden');$('#chain-list').classList.add('hidden');$('#empty-state').classList.add('hidden');$('#toolbar').classList.add('hidden');$('#media-page').classList.remove('hidden');const {data,error}=await sbClient.from('generated_media').select('*, prompt_chains(name)').order('created_at',{ascending:false}).limit(100);$('#all-media-list').innerHTML=error?'<div class="empty-media">Could not load media.</div>':data?.length?(await Promise.all(data.map(m=>mediaRow(m,m.prompt_chains?.name||'Prompt chain')))).join(''):'<div class="empty-media">Your generated outputs will show up here.</div>';}
$('#google-signin').onclick=async()=>{const button=$('#google-signin');button.disabled=true;$('#login-note').textContent='Connecting to Google…';try{const {error}=await sbClient.auth.signInWithOAuth({provider:'google',options:{redirectTo:`${location.origin}/`}});if(error)throw error;}catch(error){$('#login-note').textContent=`Google sign-in failed. Check Supabase Google provider and redirect settings. ${friendlyError(error)}`;button.disabled=false;}};
$('#create-chain').onclick=$('#empty-create').onclick=$('#new-chain-tip').onclick=e=>{e.preventDefault();openChainDialog();};
$('#chain-form').addEventListener('submit',saveChain);$('#step-form').addEventListener('submit',saveStep);
document.querySelectorAll('.close-modal').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#chain-list').addEventListener('click',()=>{});$('#search').addEventListener('input',renderChains);
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');state.filter=t.dataset.filter;renderChains();});
$('#edit-chain').onclick=()=>editChain(state.selected);$('#delete-chain').onclick=()=>deleteChain();$('#back-list').onclick=backToList;$('#add-step').onclick=$('#add-step-bottom').onclick=()=>openStepDialog();$('#run-chain').onclick=runChain;$('#refresh-media').onclick=()=>loadMedia(state.selected.id);
$('#run-image').addEventListener('change',e=>{const f=e.target.files[0];if(f&&f.size>10*1024*1024){toast('Image must be 10 MB or smaller.');e.target.value='';return;}state.image=f||null;$('#image-name').textContent=f?`Attached: ${f.name}`:'';$('#image-name').classList.toggle('hidden',!f);});
$('#theme-toggle').onclick=()=>{state.theme=state.theme==='system'?'light':state.theme==='light'?'dark':'system';localStorage.setItem('promptloom-theme',state.theme);applyTheme();};
$('#signout').onclick=async()=>{await sbClient.auth.signOut();state.user=null;showLogin();};$('#media-nav').onclick=showAllMedia;$('#top-avatar').onclick=()=>toast(`Signed in as ${state.user?.email||'superadmin'}`);
sbClient.auth.onAuthStateChange((_event,session)=>{if(session&&!state.user)acceptSession(session);else if(!session&&state.user){state.user=null;showLogin();}});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(state.theme==='system')applyTheme();});
initialize();
