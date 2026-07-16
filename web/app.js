  const $=id=>document.getElementById(id);
  const API = window.API_BASE || '';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const LS_KEY='thingino_builder_uid', MY_KEY='thingino_my_build';
  const getUid=()=>localStorage.getItem(LS_KEY)||'';
  const setUid=u=>{ if(u) localStorage.setItem(LS_KEY,u); };
  let myId=localStorage.getItem(MY_KEY)||null;
  const setMy=id=>{ myId=id; if(id) localStorage.setItem(MY_KEY,id); else localStorage.removeItem(MY_KEY); };
  const REFS=['master','ciao','stable'], REF_KEY='thingino_ref';
  let curRef=REFS.includes(localStorage.getItem(REF_KEY))?localStorage.getItem(REF_KEY):'master';

  let allowed=new Set(), maxConc=6, avgSecs=null, userHourly=2, retentionMins=30, curCommit=null, you=null, youAt=0;
  const ACTIVE=new Set(['queued','running','cancelling']);

  const fmt=s=>{ s=Math.max(0,Math.floor(s)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; };
  const mins=s=> s==null?'–':I18N.t('min_approx',{n:Math.max(1,Math.round(s/60))});
  const spin=()=>'<span class="spinner-border spinner-border-sm text-warning me-2"></span>';

  async function api(path, opts={}) {
    opts.headers = Object.assign({'X-Builder-Uid':getUid()}, opts.headers||{});
    let r, data=null;
    try { r = await fetch(API + path, opts); } catch { return {ok:false,status:0,data:null}; }
    try { data = await r.json(); } catch {}
    if (data && data.uid) setUid(data.uid);
    return {ok:r.ok, status:r.status, data};
  }

  function validate(){
    const v=$('board').value.trim(); $('go').disabled=!allowed.has(v)||$('board').disabled;
    const h=$('hint');
    if(v && !allowed.has(v)){ h.textContent=I18N.t('not_known_defconfig'); h.className='form-text text-danger'; }
    else { h.textContent=allowed.size?I18N.t('profiles_available',{n:allowed.size}):''; h.className='form-text muted'; }
  }
  // Cloudflare's free daily request limit answers with a bare non-JSON 429 (our own
  // throttle 429s always carry a JSON error), so that shape means "out of capacity".
  // Visitors just get the generic maintenance banner; the admin portal shows the cause.
  const overCap=r=>r.status===429&&!r.data;
  function capacityBanner(){
    const b=$('banner');
    b.innerHTML='<i class="bi bi-exclamation-triangle me-1"></i>'+I18N.t('builds_disabled');
    b.classList.remove('d-none');
    $('board').disabled=true; $('go').disabled=true;
  }
  // Camera lists are cached per branch, keyed by the branch commit (the list is derived
  // from the commit, so the commit IS its version): instant render from cache, and
  // /api/defconfigs is fetched only when stats reports a commit we haven't seen.
  const DC_KEY=r=>'thingino_defconfigs:'+r;
  let dcCommit=null;
  function applyBoards(list){ list.sort(); allowed=new Set(list); $('boards').innerHTML=list.map(b=>`<option value="${esc(b)}">`).join(''); validate(); }
  async function fetchBoards(commit){
    const r=await api('/api/defconfigs?ref='+encodeURIComponent(curRef));
    if(overCap(r)){ capacityBanner(); return; }
    const {ok,data}=r;
    if(!ok||!Array.isArray(data)){ if(!allowed.size){ const h=$('hint'); h.textContent=I18N.t('cameras_load_failed'); h.className='form-text text-danger'; } return; }
    applyBoards(data); dcCommit=commit;
    try{ localStorage.setItem(DC_KEY(curRef),JSON.stringify({commit,list:data})); }catch(_){}
  }
  function noteCommit(c){
    if(!c||dcCommit===c) return;
    // A list fetched before we knew the commit belongs to it (same server-side cache).
    if(dcCommit===null&&allowed.size){ dcCommit=c; try{ localStorage.setItem(DC_KEY(curRef),JSON.stringify({commit:c,list:[...allowed]})); }catch(_){} return; }
    fetchBoards(c);
  }
  function loadBoards(){
    allowed=new Set(); dcCommit=null;
    let c=null; try{ c=JSON.parse(localStorage.getItem(DC_KEY(curRef))||'null'); }catch(_){}
    if(c&&Array.isArray(c.list)&&c.list.length){ dcCommit=c.commit||null; applyBoards(c.list); }
    else fetchBoards(null);
  }

  function renderGlobal(d){
    curCommit=d.commit||null;
    $('stats').innerHTML=`<i class="bi bi-hdd-stack me-1"></i><b>${esc(d.running)}</b>/${esc(d.max_concurrent)} ${I18N.t('stats_building')} &nbsp;·&nbsp; <b>${esc(d.queued)}</b> ${I18N.t('stats_queued')} &nbsp;·&nbsp; ${I18N.t('stats_typical')} <b>${mins(d.avg_build_secs)}</b>`;
    const cb=$('commit-badge');
    if(curCommit){ cb.textContent=I18N.t('commit_badge_text',{branch:curRef,commit:curCommit.slice(0,7)}); cb.href='https://github.com/themactep/thingino-firmware/commit/'+curCommit; cb.classList.remove('d-none'); } else cb.classList.add('d-none');
    if(d.version){ const v=$('version'); if(v) v.textContent=d.version; }
    const b=$('banner');
    if(d.builds_enabled===false){ b.innerHTML='<i class="bi bi-exclamation-triangle me-1"></i>'+I18N.t('builds_disabled'); b.classList.remove('d-none'); }
    else b.classList.add('d-none');
    // During maintenance (kill switch off) the picker is disabled, not just the banner.
    const off=d.builds_enabled===false;
    if($('board').disabled!==off){ $('board').disabled=off; validate(); }
    renderFooterLimits();
  }

  // Footer help text with the live limits (per-user hourly, concurrency, retention);
  // reflects admin-portal overrides. Re-run on stats refresh, init, and language switch.
  function renderFooterLimits(){
    const el=$('footer-limits');
    if(el) el.innerHTML=I18N.t('footer_limits',{user:userHourly,conc:maxConc,mins:retentionMins});
  }

  function renderYou(){
    const picker=$('picker'), mb=$('mybuild');
    if(!you){ mb.classList.add('d-none'); mb.innerHTML=''; picker.classList.remove('d-none'); return; }
    picker.classList.toggle('d-none', ACTIVE.has(you.state));
    mb.classList.remove('d-none');
    const live=(you.elapsed_secs||0)+(Date.now()-youAt)/1000;
    const meta=`<div class="small muted mt-2">${I18N.t('meta_defconfig')} <code>${esc(you.defconfig)}</code><br>${I18N.t('meta_build_id')} <code>${esc(you.build_id)}</code>${you.deduped?`<br><span class="text-warning">${I18N.t('deduped_note')}</span>`:''}</div>`;
    let h='';
    if(you.state==='queued')
      h=`<div class="alert alert-secondary mb-0">${spin()}<strong>${I18N.t('state_queued')}</strong> ${I18N.t('queued_position',{n:esc(you.position)})}${meta}<div class="mt-2"><button class="btn btn-outline-secondary btn-sm" id="cancel">${I18N.t('cancel_btn')}</button></div></div>`;
    else if(you.state==='running')
      h=`<div class="alert alert-secondary mb-0">${spin()}<strong>${I18N.t('state_building')}</strong> ${fmt(live)}${meta}<div class="mt-2"><button class="btn btn-outline-secondary btn-sm" id="cancel">${I18N.t('cancel_btn')}</button></div></div>`;
    else if(you.state==='cancelling')
      h=`<div class="alert alert-warning mb-0">${spin()}<strong>${I18N.t('state_cancelling')}</strong><div class="small">${I18N.t('cancelling_note')}</div>${meta}</div>`;
    else if(you.state==='done')
      h=`<div class="alert alert-success mb-0"><i class="bi bi-check-circle-fill me-1"></i><strong>${I18N.t('state_done')}</strong>${meta}
        <div class="mt-2 d-flex gap-2 flex-wrap"><a class="btn btn-thingino btn-sm" href="${esc(you.download_url)}" download><i class="bi bi-download me-1"></i>${I18N.t('download_btn')}</a>
        <button class="btn btn-outline-secondary btn-sm" id="again">${I18N.t('build_another_btn')}</button></div>
        <div class="small text-warning mt-2"><i class="bi bi-clock me-1"></i>${I18N.t('download_window_note',{mins:retentionMins})}</div></div>`;
    else if(you.state==='failed')
      h=`<div class="alert alert-danger mb-0"><i class="bi bi-exclamation-triangle-fill me-1"></i><strong>${I18N.t('state_failed')}</strong>${meta}<div class="mt-2"><button class="btn btn-outline-warning btn-sm" id="again">${I18N.t('try_again_btn')}</button></div></div>`;
    else
      h=`<div class="alert alert-secondary mb-0"><strong>${you.state==='expired'?I18N.t('state_expired'):I18N.t('state_cancelled')}</strong>${meta}<div class="mt-2"><button class="btn btn-outline-secondary btn-sm" id="again">${I18N.t('build_again_btn')}</button></div></div>`;
    mb.innerHTML=h;
    const c=$('cancel'); if(c) c.onclick=cancelBuild;
    const a=$('again'); if(a) a.onclick=()=>{ setMy(null); you=null; renderYou(); $('board').focus(); };
  }

  let srvVer=null, lastData=0, lastStatsData=null;
  // One poller per browser: tabs share results over a BroadcastChannel, and a momentary
  // Web Lock keeps two tabs from fetching at the same instant. Absent either API, tabs
  // just poll independently like before.
  const bc=('BroadcastChannel' in window)?new BroadcastChannel('thingino_stats'):null;

  // Apply a stats payload (own fetch or another tab's broadcast) to this tab's UI.
  function consume(data, askedMy){
    lastData=Date.now(); lastStatsData=data;
    // Version handshake: when a deploy changes the server version, reload once so this
    // tab picks up the new page code instead of polling on stale timers forever.
    if(data.version){ if(srvVer===null) srvVer=data.version; else if(data.version!==srvVer){ location.reload(); return; } }
    maxConc=data.max_concurrent||6; avgSecs=data.avg_build_secs; userHourly=data.user_hourly||userHourly;
    if(data.retention_secs) retentionMins=Math.max(1,Math.round(data.retention_secs/60));
    renderGlobal(data); noteCommit(data.commit);
    if(!myId && data.you){ setMy(data.you.build_id); }
    // Embedded status of our tracked build (only trust it if it was asked for us).
    if(askedMy && askedMy===myId && 'my_build' in data){
      if(data.my_build===null){ setMy(null); you=null; renderYou(); }
      else { you=data.my_build; youAt=Date.now(); renderYou(); }
    }
  }

  async function doFetch(){
    // Track our build only while it can still change (active, or done awaiting expiry);
    // its status rides along on the stats request (?my=), one request instead of two.
    const wantMy=(myId && (!you || ACTIVE.has(you.state) || you.state==='done'))?myId:null;
    const r=await api('/api/stats?ref='+encodeURIComponent(curRef)+(wantMy?'&my='+encodeURIComponent(wantMy):''));
    if(overCap(r)){ capacityBanner(); return; }
    const {ok,data}=r;
    if(!ok||!data) return;
    consume(data, wantMy);
    if(wantMy && !('my_build' in data)){
      // Older broker without ?my support: fall back to the separate status poll.
      const s=await api('/api/status/'+wantMy);
      if(s.status===404){ setMy(null); you=null; renderYou(); }
      else if(s.ok&&s.data&&s.data.state){ you=s.data; youAt=Date.now(); renderYou(); }
    }
    if(!myId&&you){ you=null; renderYou(); }
    if(bc) bc.postMessage({ref:curRef,my:wantMy,data});
  }

  async function refresh(force){
    if(force){ await doFetch(); return; } // user action: never skipped, never lock-dropped
    // Skip if this browser already has fresh-enough data (typically another tab's).
    const need=(you&&ACTIVE.has(you.state))?4000:12500;
    if(Date.now()-lastData<need) return;
    if(navigator.locks){ await navigator.locks.request('thingino_poll',{ifAvailable:true},async l=>{ if(l) await doFetch(); }); }
    else await doFetch();
  }

  if(bc) bc.onmessage=e=>{
    const m=e.data||{};
    if(m.ref!==curRef||!m.data) return;
    consume(m.data, (m.my&&m.my===myId)?m.my:null);
  };

  async function submit(){
    const defconfig=$('board').value.trim();
    if(!allowed.has(defconfig)) return;
    $('go').disabled=true;
    const {ok,status,data}=await api('/api/build',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({defconfig,ref:curRef})});
    if(!ok){ const h=$('hint'); h.textContent=(data&&data.error)||I18N.t('request_failed',{status}); h.className='form-text text-danger'; $('go').disabled=false; return; }
    setMy(data.build_id);
    you={build_id:data.build_id, defconfig:data.defconfig, state:data.state||'queued', position:data.position||0, elapsed_secs:0, download_url:data.download_url, deduped:data.deduped};
    youAt=Date.now(); renderYou(); refresh(true);
  }

  async function cancelBuild(){
    if(!you) return;
    const b=$('cancel'); if(b){ b.disabled=true; b.textContent=I18N.t('state_cancelling'); }
    const {data}=await api(`/api/cancel/${you.build_id}`,{method:'POST'});
    if(data&&data.state){ you.state=(data.state==='cancelled')?'cancelled':'cancelling'; youAt=Date.now(); renderYou(); }
    refresh(true);
  }

  /* ---- Opt-in help balloons (? button / Settings toggle; off by default) ---- */
  let helpMode = localStorage.getItem('thingino_help')==='1';
  let _helpBalloon=null, _helpHover=null;

  function applyHelpMode(){
    document.body.classList.toggle('help-on', helpMode);
    const b=$('btn-help'); if(b) b.classList.toggle('help-active', helpMode);
    const s=$('setting-help'); if(s) s.checked=helpMode;
    // Suppress native title tooltips while help mode is on so they don't double up
    // with our balloons; restore them when it's off.
    const els=document.querySelectorAll('[data-help]');
    for(let i=0;i<els.length;i++){
      const el=els[i];
      if(helpMode && el.hasAttribute('title')){ el.setAttribute('data-saved-title', el.getAttribute('title')); el.removeAttribute('title'); }
      else if(!helpMode && el.hasAttribute('data-saved-title')){ el.setAttribute('title', el.getAttribute('data-saved-title')); el.removeAttribute('data-saved-title'); }
    }
    if(!helpMode) hideHelpBalloon();
  }
  function setHelp(on){ helpMode=!!on; localStorage.setItem('thingino_help', helpMode?'1':'0'); applyHelpMode(); }

  function hideHelpBalloon(){ _helpHover=null; if(_helpBalloon) _helpBalloon.classList.remove('show'); }
  function showHelpBalloon(el){
    if(!_helpBalloon){ _helpBalloon=document.createElement('div'); _helpBalloon.className='help-balloon'; document.body.appendChild(_helpBalloon); }
    // data-help holds an i18n key; resolve it (fall back to the raw value).
    _helpBalloon.textContent = window.I18N ? I18N.t(el.getAttribute('data-help')) : el.getAttribute('data-help');
    _helpBalloon.classList.add('show');
    const r=el.getBoundingClientRect();
    const bw=_helpBalloon.offsetWidth, bh=_helpBalloon.offsetHeight;
    const left=Math.min(Math.max(8, r.left), window.innerWidth-bw-8);
    let top=r.bottom+9, above=false;
    if(top+bh > window.innerHeight-8){ top=r.top-bh-9; above=true; } // flip above if it would overflow
    if(top<8) top=8;
    _helpBalloon.classList.toggle('above', above);
    _helpBalloon.style.left=left+'px';
    _helpBalloon.style.top=top+'px';
  }
  /* Track the topmost helpable element under the cursor; elementFromPoint respects
   * z-order (a control in the Settings overlay wins) and resolves disabled buttons. */
  document.addEventListener('mousemove', e=>{
    if(!helpMode) return;
    const top=document.elementFromPoint(e.clientX, e.clientY);
    const el=top&&top.closest ? top.closest('[data-help]') : null;
    if(el){ if(el!==_helpHover){ _helpHover=el; showHelpBalloon(el); } }
    else if(_helpHover){ hideHelpBalloon(); }
  });

  $('board').addEventListener('input',validate);
  $('board').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!$('go').disabled) submit(); });
  $('go').addEventListener('click',submit);
  function openSettings(){ const r=$('branch-'+curRef); if(r) r.checked=true; $('settings-overlay').classList.remove('d-none'); }
  function closeSettings(){ $('settings-overlay').classList.add('d-none'); }
  function saveSettings(){
    const sel=document.querySelector('.branch-radio:checked');
    if(sel&&REFS.includes(sel.value)&&sel.value!==curRef){ curRef=sel.value; localStorage.setItem(REF_KEY,curRef); loadBoards(); wake(true); }
    closeSettings();
  }
  $('settings-btn').addEventListener('click',openSettings);
  $('settings-cancel').addEventListener('click',closeSettings);
  $('settings-save').addEventListener('click',saveSettings);
  $('settings-overlay').addEventListener('click',e=>{ if(e.target===$('settings-overlay')) closeSettings(); });
  $('btn-help').addEventListener('click',()=>setHelp(!helpMode));
  $('setting-help').addEventListener('change',e=>setHelp(e.target.checked));
  I18N.apply(); renderFooterLimits(); I18N.selector('lang-slot'); applyHelpMode();
  window.addEventListener('i18nchange',()=>{ I18N.apply(); renderFooterLimits(); validate(); renderYou(); if(lastStatsData) renderGlobal(lastStatsData); applyHelpMode(); });
  loadBoards(); refresh(true);
  // Poll gently: 5s while your own build is active; idle backs off 15s -> 30s -> 60s;
  // nothing at all while the tab is hidden. wake() snaps back to the fast cadence on
  // user activity (typing, branch switch, tab becoming visible).
  let wait=1, idleLvl=0;
  function wake(now){ idleLvl=0; wait=Math.min(wait,3); if(now&&!document.hidden) refresh(true); }
  setInterval(()=>{
    if(document.hidden) return;
    if(you&&ACTIVE.has(you.state)){ idleLvl=0; wait=1; refresh(); return; }
    if(--wait>0) return;
    refresh();
    idleLvl=Math.min(idleLvl+1,2); wait=[3,6,12][idleLvl];
  },5000);
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden){ wake(false); refresh(); } });
  $('board').addEventListener('input',()=>wake(false));
  setInterval(()=>{ if(!document.hidden&&you&&you.state==='running') renderYou(); }, 1000);
