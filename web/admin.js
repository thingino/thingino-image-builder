document.querySelectorAll('form').forEach(function(f){ f.addEventListener('submit', function(e){ e.preventDefault(); }); });
const API = window.API_BASE || '';
const TK='thingino_admin_token';
const tok=()=>localStorage.getItem(TK)||'';
const $=id=>document.getElementById(id);
const short=s=>s?String(s).slice(0,8):'';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ipExpanded=new Set();
const ipcell=(full,bucket)=>{ const f=full||'', b=bucket||full||''; return `<code class="ipc" data-full="${esc(f)}" data-bucket="${esc(b)}" style="cursor:pointer" title="${esc(I18N.t('title_ip_toggle'))}">${esc(ipExpanded.has(f)?b:f)}</code>`; };
function buildAction(b){ const id=esc(b.build_id);
  if(['queued','running','cancelling'].includes(b.state)) return ` <a href="#" class="bact text-danger ms-1" data-act="cancel" data-id="${id}" title="${esc(I18N.t('title_cancel_build'))}">✕</a>`;
  if(['done','failed'].includes(b.state)) return ` <a href="#" class="bact text-secondary small ms-1" data-act="expire" data-id="${id}" title="${esc(I18N.t('title_remove_artifact'))}">${I18N.t('act_remove')}</a>`;
  return ''; }
// Run id, linked to its Actions run so a failed build is one click from its logs. The
// repo comes from the API (config.js is rewritten at deploy time, so it can't hold it).
// An expired build's run was deleted by the reaper, so that one stays plain text.
let ghRepo=null;
const runcell=(r,state)=>{ if(!r) return ''; const c=`<code>${esc(r)}</code>`;
  return (ghRepo&&state!=='expired')?`<a href="https://github.com/${esc(ghRepo)}/actions/runs/${encodeURIComponent(r)}" target="_blank" rel="noopener">${c}</a>`:c; };
const tfmt=ts=>new Date(ts*1000).toLocaleTimeString();
const dur=(a,b)=>{ if(!a||!b) return '–'; const s=b-a; return `${Math.floor(s/60)}m${String(s%60).padStart(2,'0')}s`; };
const ago=ts=>{ const s=Math.floor(Date.now()/1000)-ts; if(s<60)return I18N.t('ago_seconds',{n:s}); if(s<3600)return I18N.t('ago_minutes',{n:Math.floor(s/60)}); return I18N.t('ago_hours',{n:Math.floor(s/3600)}); };
const PILL={queued:'bg-info text-dark',running:'bg-primary',cancelling:'bg-warning text-dark',done:'bg-success',failed:'bg-danger',cancelled:'bg-secondary',expired:'bg-dark border'};
const stateLabel=s=>{ const v=I18N.t('state_'+s); return v==='state_'+s?s:v; };
// An expired build keeps its terminal result in `outcome`, so show e.g. "expired (done)".
const pill=(s,o)=>{ const t=(s==='expired'&&o)?`${stateLabel(s)} (${stateLabel(o)})`:stateLabel(s); return `<span class="badge ${PILL[s]||'bg-secondary'}" title="${esc(t)}">${esc(t)}</span>`; };
const tile=(l,n)=>`<div class="col-6 col-md-3 col-lg-2"><div class="card text-center h-100"><div class="card-body py-2 px-1"><div class="fs-4 fw-bold">${n??0}</div><div class="small muted text-uppercase">${l}</div></div></div></div>`;

// Cloudflare's free daily request limit answers admin endpoints with a bare 429 (none of
// our own admin routes emit 429), so that status means "out of capacity". Admin sees the
// real cause; the public page just shows the generic maintenance banner.
const capText=()=>{ const n=new Date(), reset=new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()+1)); return I18N.t('over_capacity',{t:reset.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}); };
function showCap(on){ const b=$('cap-banner'); if(b){ if(on) b.textContent=capText(); b.style.display=on?'':'none'; } }
async function adminGet(){ const r=await fetch(API+'/api/admin/stats',{headers:{Authorization:'Bearer '+tok()}}); if(r.status===401){ const e=new Error('unauthorized'); e.auth=1; throw e; } if(r.status===429){ const e=new Error('capacity'); e.cap=1; throw e; } if(!r.ok) throw new Error('http '+r.status); return r.json(); }
let masterMode=false;
function setMaster(on){ masterMode=on;
  $('username').style.display=on?'none':''; $('password').style.display=on?'none':''; $('token').style.display=on?'':'none';
  $('master-toggle').textContent=on?I18N.t('userpass_toggle'):I18N.t('master_toggle');
  $('gate-hint').textContent=on?I18N.t('master_hint'):I18N.t('signin_hint');
}
async function login(){
  $('gate-err').textContent='';
  const body=masterMode?{token:$('token').value.trim(),totp:$('totp').value.trim()}
    :{username:$('username').value.trim().toLowerCase(),password:$('password').value,totp:$('totp').value.trim()};
  const r=await fetch(API+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.session){ localStorage.setItem(TK,d.session); show(); }
  else { $('gate-err').textContent=(r.status===429&&!d.error)?capText():(d.error||I18N.t('err_invalid_creds')); localStorage.removeItem(TK); }
}
function show(){ $('gate').style.display='none'; $('app').style.display=''; refresh(); }
async function logout(){ try{ await fetch(API+'/api/admin/logout',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); }catch{} localStorage.removeItem(TK); location.reload(); }

// Inactivity logout: 2h without real user input ends the session. The server enforces the
// same window per-request on its side; this client check covers a visible tab, whose 10s
// stats poll would otherwise keep the session alive forever. Last input is tracked in
// localStorage (throttled), so activity in any tab counts for all tabs and survives reloads.
const IDLE_MS=2*3600*1000, LA='thingino_admin_last_input';
let laWrote=0;
const touchIdle=()=>{ const t=Date.now(); if(t-laWrote>30000){ laWrote=t; try{ localStorage.setItem(LA,String(t)); }catch{} } };
['pointerdown','keydown','wheel','touchstart'].forEach(e=>document.addEventListener(e,touchIdle,{passive:true,capture:true}));
// True (and starts the logout) when the last user input is too old; a missing marker is
// seeded to "now" instead of logging out, so pre-existing sessions get a full window.
function idledOut(){ const la=parseInt(localStorage.getItem(LA)||'0',10);
  if(!la){ touchIdle(); return false; }
  if(Date.now()-la>IDLE_MS){ logout(); return true; }
  return false; }

let enabled=true;
let srvVer=null;
async function refresh(){
  let d; try{ d=await adminGet(); }catch(e){ if(e&&e.auth){ logout(); } else if(e&&e.cap){ showCap(true); } return; }
  showCap(false);
  // Version handshake: reload once when a deploy changes the server version, so open
  // admin tabs stop running stale page code.
  if(d.version){ if(srvVer===null) srvVer=d.version; else if(d.version!==srvVer){ location.reload(); return; } }
  enabled=d.builds_enabled;
  ghRepo=d.repo||null;
  $('kill-state').innerHTML=enabled?'<span class="text-success">'+I18N.t('kill_enabled')+'</span>':'<span class="text-danger">'+I18N.t('kill_disabled')+'</span>';
  const kb=$('kill-btn'); kb.textContent=enabled?I18N.t('kill_disable'):I18N.t('kill_enable'); kb.className='btn btn-sm '+(enabled?'btn-outline-danger':'btn-thingino');
  $('kill-extra').textContent=I18N.t('kill_extra',{n:d.max_concurrent,m:Math.round(d.retention_secs/60)});
  $('ver').textContent=d.version||'–';
  if(d.update_available){
    $('upd-badge').innerHTML='<span class="badge text-bg-warning ms-1">'+I18N.t('update_available',{v:esc(d.latest_version)})+'</span>';
    $('upd-btn').style.display=''; $('upd-btn').dataset.v=d.latest_version||'';
  } else {
    $('upd-badge').innerHTML=d.latest_version?'<span class="text-success small ms-1">'+I18N.t('up_to_date')+'</span>':'';
    $('upd-btn').style.display='none';
  }
  renderLimits(d.limits, d.usage);
  isMaster=!!d.master; if(d.master||d.manage_users){ if(!usersShown){ $('users-card').style.display=''; usersShown=true; renderUsers(); } } else $('users-card').style.display='none';
  const c=d.counts||{};
  $('tiles').innerHTML=[['state_running',c.running],['state_queued',c.queued],['state_done',c.done],['state_failed',c.failed],['state_cancelled',c.cancelled],['state_expired',c.expired],['tile_24h',d.last24h],['tile_total_done',d.total_done??0],['tile_avg_build',d.avg_build_secs?Math.round(d.avg_build_secs/60)+'m':'–']].map(([k,n])=>tile(I18N.t(k),n)).join('');
  $('builds-body').innerHTML=(d.recent_builds||[]).map(b=>`<tr><td><code>${esc(short(b.build_id))}</code></td><td>${esc(b.defconfig)}</td><td>${esc(b.ref||'–')}</td><td>${pill(b.state,b.outcome)}${buildAction(b)}</td><td><code>${esc(short(b.uid))}</code></td><td>${ipcell(b.ip,b.ip_bucket)}</td><td>${ago(b.created_ts)}</td><td>${dur(b.dispatched_ts,b.finished_ts)}</td><td>${runcell(b.run_id,b.state)}</td></tr>`).join('');
  $('events-body').innerHTML=(d.recent_events||[]).map(e=>`<tr><td>${tfmt(e.ts)}</td><td>${esc(e.kind)}</td><td><code>${esc(short(e.build_id))}</code></td><td><code>${esc(short(e.uid))}</code></td><td>${ipcell(e.ip,e.ip_bucket)}</td><td class="muted">${esc(e.detail)}</td></tr>`).join('');
  $('updated').textContent=I18N.t('updated',{t:new Date().toLocaleTimeString()});
}
async function toggle(){ await fetch(API+'/api/admin/toggle',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify({enabled:!enabled})}); refresh(); }
async function clearLogs(){ if(!confirm(I18N.t('confirm_clear_logs'))) return; await fetch(API+'/api/admin/clear-logs',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); refresh(); }
async function clearBuilds(){ if(!confirm(I18N.t('confirm_clear_builds'))) return; await fetch(API+'/api/admin/clear-builds',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); refresh(); }
async function resetLimits(){ if(!confirm(I18N.t('confirm_reset_limits'))) return; const r=await fetch(API+'/api/admin/reset-limits',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); if(r.ok) $('kill-extra').textContent=I18N.t('hourly_reset'); refresh(); }
let lastLimits=null, lastUsage=null, editingLimits=false;
const fmtLimits=(L,U)=>{ const pair=(u,m)=> U ? `<code>${u}</code> / <code>${m}</code>` : `<code>${m}</code>`;
  return `${I18N.t('lim_user_hourly')} <code>${L.userHourly}</code> · ${I18N.t('lim_ip_hourly')} <code>${L.ipHourly}</code> · ${I18N.t('lim_global_hourly')} ${pair(U&&U.globalHourly,L.globalHourly)} · ${I18N.t('lim_concurrent')} ${pair(U&&U.maxConcurrent,L.maxConcurrent)} · ${I18N.t('lim_queue')} ${pair(U&&U.maxQueue,L.maxQueue)} · ${I18N.t('lim_retention')} <code>${Math.round(L.retention/60)}</code> ${I18N.t('lim_min')}`; };
function renderLimits(L,U){ if(!L) return; lastLimits=L; lastUsage=U; if(!editingLimits) $('limits-view').innerHTML=fmtLimits(L,U); }
function editLimits(){ const L=lastLimits; if(!L) return; editingLimits=true; $('limits-msg').textContent='';
  $('lim-userHourly').value=L.userHourly; $('lim-ipHourly').value=L.ipHourly; $('lim-globalHourly').value=L.globalHourly; $('lim-maxConcurrent').value=L.maxConcurrent; $('lim-maxQueue').value=L.maxQueue; $('lim-retention').value=Math.round(L.retention/60);
  $('limits-view').style.display='none'; $('limits-edit').style.display='none'; $('limits-fields').style.display=''; $('limits-save').style.display=''; $('limits-cancel').style.display=''; }
function viewLimits(){ editingLimits=false;
  $('limits-view').style.display=''; $('limits-edit').style.display=''; $('limits-fields').style.display='none'; $('limits-save').style.display='none'; $('limits-cancel').style.display='none';
  if(lastLimits) $('limits-view').innerHTML=fmtLimits(lastLimits,lastUsage); }
async function saveLimits(){ const v=id=>parseInt($(id).value,10);
  const body={userHourly:v('lim-userHourly'),ipHourly:v('lim-ipHourly'),globalHourly:v('lim-globalHourly'),maxConcurrent:v('lim-maxConcurrent'),maxQueue:v('lim-maxQueue'),retention:Math.max(60,v('lim-retention')*60)};
  $('limits-msg').textContent=I18N.t('saving');
  try{ const r=await fetch(API+'/api/admin/limits',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json().catch(()=>({})); if(r.ok){ if(j.limits) lastLimits=j.limits; $('limits-msg').textContent=I18N.t('saved'); viewLimits(); } else $('limits-msg').textContent=j.error||I18N.t('failed'); }
  catch{ $('limits-msg').textContent=I18N.t('failed'); }
  refresh(); }
async function doUpdate(){
  const v=$('upd-btn').dataset.v||'';
  if(!confirm(I18N.t('confirm_update',{v:v?I18N.t('update_to_ver',{v:v}):''}))) return;
  $('upd-btn').disabled=true; $('upd-extra').textContent=I18N.t('requesting_update');
  try{ const r=await fetch(API+'/api/admin/update',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); const j=await r.json().catch(()=>({})); $('upd-extra').textContent=r.ok?(j.status||I18N.t('update_requested')):(j.error||I18N.t('update_failed')); }
  catch{ $('upd-extra').textContent=I18N.t('update_failed'); }
  $('upd-btn').disabled=false;
}

// --- admin user management (master only) + invite enrollment ---
let usersShown=false, isMaster=false;
const PRIVS=['clear_logs','clear_builds','reset_limits','edit_limits','kill_switch','manage_users'];
const privCell=u=>isMaster?PRIVS.map(p=>`<label class="me-2 small" style="white-space:nowrap"><input type="checkbox" class="privbox" data-u="${esc(u.username)}" data-p="${p}" ${(u.privileges||[]).includes(p)?'checked':''}> ${I18N.t('priv_'+p)}</label>`).join(''):(u.privileges||[]).map(p=>`<span class="badge bg-secondary me-1">${esc(I18N.t('priv_'+p))}</span>`).join('');
async function renderUsers(){
  const r=await fetch(API+'/api/admin/users',{headers:{Authorization:'Bearer '+tok()}});
  if(!r.ok) return; const d=await r.json().catch(()=>({}));
  $('users-body').innerHTML=(d.users||[]).map(u=>`<tr><td><code>${esc(u.username)}</code></td><td>${u.invite_token?`<a href="#" class="show-invite" data-u="${esc(u.username)}" data-t="${esc(u.invite_token)}" data-e="${u.invite_expires||0}" title="${esc(I18N.t('title_show_invite'))}">${I18N.t('state_invited')}</a>`:esc(u.state)}</td><td class="muted">${u.last_login?ago(u.last_login):I18N.t('never')}</td><td>${privCell(u)}</td><td><a href="#" class="deluser text-danger small" data-u="${esc(u.username)}">${I18N.t('act_remove')}</a></td></tr>`).join('') || `<tr><td colspan="5" class="muted small">${I18N.t('no_users')}</td></tr>`;
  // Drop a shown invite link once its user is no longer a pending invite (removed / enrolled / expired).
  const il=$('invite-link'), shown=il.dataset.user;
  if(shown && !(d.users||[]).some(u=>u.username===shown&&u.invite_token)){ il.innerHTML=''; delete il.dataset.user; }
}
function showInviteLink(username, token, expires){
  const link=location.origin+location.pathname+'?invite='+token;
  const mins=expires?Math.max(0,Math.round((expires-Math.floor(Date.now()/1000))/60)):60;
  $('invite-link').innerHTML=I18N.t('invite_link_intro',{u:`<code>${esc(username)}</code>`,n:mins})+`<br><code style="word-break:break-all">${esc(link)}</code> <button class="btn btn-sm btn-outline-secondary ms-1" id="copy-invite">${I18N.t('copy_btn')}</button>`;
  $('invite-link').dataset.user=username;  // remember whose link is shown, so removing that user can clear it
  const cb=$('copy-invite'); if(cb) cb.onclick=()=>{ navigator.clipboard.writeText(link).then(()=>{cb.textContent=I18N.t('copied');}); };
}
async function invite(){
  const u=$('invite-user').value.trim().toLowerCase(); if(!u) return;
  $('invite-link').textContent=I18N.t('creating');
  const r=await fetch(API+'/api/admin/users',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify({username:u})});
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.invite_token){ showInviteLink(d.username, d.invite_token, null); $('invite-user').value=''; renderUsers(); }
  else $('invite-link').innerHTML=`<span class="text-danger">${esc(d.error||I18N.t('failed'))}</span>`;
}
async function startEnroll(token){
  $('gate').style.display='none'; $('app').style.display='none'; $('enroll').style.display='';
  const r=await fetch(API+'/api/admin/invite/'+encodeURIComponent(token));
  const d=await r.json().catch(()=>({}));
  if(!r.ok){ $('enroll-msg').className='text-danger small mt-2'; $('enroll-msg').textContent=d.error||I18N.t('invalid_invite'); $('enroll-btn').disabled=true; return; }
  $('enroll-user').textContent=d.username; $('enroll-secret').textContent=d.secret;
  new QRCode($('enroll-qr'),{text:d.otpauth,width:168,height:168,correctLevel:QRCode.CorrectLevel.M});
  $('enroll-btn').onclick=()=>acceptInvite(token);
}
async function acceptInvite(token){
  const pw=$('enroll-pw').value, pw2=$('enroll-pw2').value, totp=$('enroll-totp').value.trim(), m=$('enroll-msg');
  if(pw.length<10){ m.className='text-danger small mt-2'; m.textContent=I18N.t('err_pw_short'); return; }
  if(pw!==pw2){ m.className='text-danger small mt-2'; m.textContent=I18N.t('err_pw_mismatch'); return; }
  m.className='small mt-2'; m.textContent=I18N.t('setting_up');
  const r=await fetch(API+'/api/admin/accept-invite',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,password:pw,totp})});
  const d=await r.json().catch(()=>({}));
  if(r.ok){ m.className='text-success small mt-2'; m.innerHTML=I18N.t('account_ready')+' <a href="'+esc(location.pathname)+'">'+I18N.t('signin_link')+'</a>'; $('enroll-btn').disabled=true; }
  else { m.className='text-danger small mt-2'; m.textContent=d.error||I18N.t('failed'); }
}
$('login').onclick=login;
$('master-toggle').onclick=e=>{ e.preventDefault(); setMaster(!masterMode); };
$('invite-btn').onclick=invite;
$('username').addEventListener('keydown',e=>{ if(e.key==='Enter') $('password').focus(); });
$('password').addEventListener('keydown',e=>{ if(e.key==='Enter') $('totp').focus(); });
$('token').addEventListener('keydown',e=>{ if(e.key==='Enter') $('totp').focus(); });
$('totp').addEventListener('keydown',e=>{ if(e.key==='Enter') login(); });
$('logout').onclick=logout;
$('kill-btn').onclick=toggle;
$('clearlogs-btn').onclick=clearLogs;
$('clearbuilds-btn').onclick=clearBuilds;
$('resetlimits-btn').onclick=resetLimits;
$('limits-edit').onclick=editLimits;
$('limits-save').onclick=saveLimits;
$('limits-cancel').onclick=viewLimits;
$('upd-btn').onclick=doUpdate;
// Click an IP to toggle between the full address and its /64 (v4 /32) bucket.
document.addEventListener('click',ev=>{ const c=ev.target.closest('.ipc'); if(!c) return; const f=c.dataset.full; if(ipExpanded.has(f)) ipExpanded.delete(f); else ipExpanded.add(f); c.textContent=ipExpanded.has(f)?c.dataset.bucket:c.dataset.full; });
// Per-build admin action: cancel (active) or remove artifact+run (finished).
document.addEventListener('click',async ev=>{ const x=ev.target.closest('.bact'); if(!x) return; ev.preventDefault();
  const act=x.dataset.act, id=x.dataset.id;
  if(!confirm(act==='cancel'?I18N.t('confirm_cancel_build',{id:id.slice(0,8)}):I18N.t('confirm_remove_build',{id:id.slice(0,8)}))) return;
  try{ await fetch(API+'/api/admin/'+(act==='cancel'?'cancel':'expire')+'/'+id,{method:'POST',headers:{Authorization:'Bearer '+tok()}}); }catch{}
  refresh(); });
// Remove an admin user (master only).
document.addEventListener('click',async ev=>{ const x=ev.target.closest('.deluser'); if(!x) return; ev.preventDefault();
  const u=x.dataset.u; if(!confirm(I18N.t('confirm_remove_user',{u:u}))) return;
  await fetch(API+'/api/admin/users/'+encodeURIComponent(u),{method:'DELETE',headers:{Authorization:'Bearer '+tok()}});
  const il=$('invite-link'); if(il.dataset.user===u){ il.innerHTML=''; delete il.dataset.user; }  // drop the shown link if it was this user's
  renderUsers(); });
// Click a pending "invited" admin to re-show its (still-valid) invite link.
document.addEventListener('click',ev=>{ const x=ev.target.closest('.show-invite'); if(!x) return; ev.preventDefault();
  showInviteLink(x.dataset.u, x.dataset.t, parseInt(x.dataset.e,10)||0); });
// Toggle a per-admin privilege (master only): gather that user's checked boxes and save the set.
document.addEventListener('change',async ev=>{ const x=ev.target.closest('.privbox'); if(!x) return;
  const u=x.dataset.u;
  const privileges=[...document.querySelectorAll('.privbox')].filter(b=>b.dataset.u===u&&b.checked).map(b=>b.dataset.p);
  await fetch(API+'/api/admin/users/'+encodeURIComponent(u)+'/privileges',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify({privileges})});
  renderUsers(); });
I18N.apply();
I18N.selector('lang-slot');
// On a language switch: re-apply static text everywhere, restore the gate hint/toggle for the
// current mode, and re-render the live app sections (kill/version/tiles/builds/events/limits + users).
window.addEventListener('i18nchange',function(){
  I18N.apply();
  setMaster(masterMode);
  if($('app').style.display!=='none'){ refresh(); if(usersShown) renderUsers(); }
});
const inviteParam=new URLSearchParams(location.search).get('invite');
if(inviteParam){ startEnroll(inviteParam); }
else if(tok()&&!idledOut()){ adminGet().then(show).catch(e=>{ if(e&&e.auth) localStorage.removeItem(TK); else show(); }); }
// Poll gently: 10s, and not at all while the tab is hidden (idle background admin tabs
// were burning the free request quota); refresh immediately when the tab comes back.
setInterval(()=>{ if(document.hidden) return; if($('app').style.display!=='none'&&!idledOut()) refresh(); },10000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&$('app').style.display!=='none'&&!idledOut()) refresh(); });
