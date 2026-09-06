  const $=id=>document.getElementById(id);
  const API = window.API_BASE || '';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const LS_KEY='thingino_builder_uid', MY_KEY='thingino_my_build', DIS_KEY='thingino_dismissed';
  const getUid=()=>localStorage.getItem(LS_KEY)||'';
  const setUid=u=>{ if(u) localStorage.setItem(LS_KEY,u); };
  let myId=localStorage.getItem(MY_KEY)||null;
  let dismissedId=localStorage.getItem(DIS_KEY)||null;
  const setMy=id=>{ myId=id; if(id) localStorage.setItem(MY_KEY,id); else localStorage.removeItem(MY_KEY); };
  const REF_KEY='thingino_ref', REFS_KEY='thingino_refs';
  // Which branches the builder offers is an admin setting, delivered on every /api/stats.
  // The last list seen is cached so the Settings dialog is populated before a return visit's
  // first poll answers; the trio below is only the first-ever-visit seed, and matches the
  // broker's own built-in fallback. refsKnown says whether the current list came from the
  // broker: until it has, this page is guessing and must not tell anyone a branch is wrong.
  let REFS=['master','ciao','stable'], DEF_REF='master', refsKnown=false;
  try{
    const c=JSON.parse(localStorage.getItem(REFS_KEY)||'null');
    if(c&&Array.isArray(c.list)&&c.list.length){ REFS=c.list; DEF_REF=REFS.includes(c.def)?c.def:REFS[0]; refsKnown=true; }
  }catch(_){}
  let curRef=null;   // resolved by resolveRef() below, once the share link has been read

  let allowed=new Set(), maxConc=6, avgSecs=null, userHourly=2, retentionMins=30, curCommit=null, you=null, youAt=0;
  const ACTIVE=new Set(['queued','running','cancelling']);
  /* ---- extra build options (allowlisted by the broker; id -> checkbox) ----------
   * Fetched once from /api/build-options with the page's language. A 404 (broker
   * predating the endpoint) leaves the list empty and the section hidden: nothing
   * here is required for a plain build. Selection is remembered across visits. */
  const OPTS_KEY='thingino_opts', OPT_RE=/^[a-z0-9_-]+(,[a-z0-9_-]+)*$/;   // canonical form the broker accepts
  let OPTS=[];   // [{id,label,desc}] as delivered
  // Session-level selection override: a share link's ?opts= applies to this visit only
  // (same rule as a link's branch: it must not rewrite the saved default), but it has
  // to survive re-renders (language switch), so it lives here, not just in linkOpts.
  let sessionOpts=null;
  function checkedOpts(){ return OPTS.filter(o=>{ const c=document.getElementById('opt-'+o.id); return c&&c.checked; }).map(o=>o.id); }
  function renderOptions(){
    const box=$('options');
    if(!box) return;
    if(!OPTS.length){ box.classList.add('d-none'); box.innerHTML=''; return; }
    box.innerHTML='<div class="small muted mb-1">'+esc(I18N.t('options_label'))+'</div>'+OPTS.map(o=>
      '<div class="form-check">'
      +`<input class="form-check-input build-option" type="checkbox" id="opt-${esc(o.id)}">`
      +`<label class="form-check-label small" for="opt-${esc(o.id)}">${esc(o.label)}`
      +(o.desc?`<div class="small muted">${esc(o.desc)}</div>`:'')
      +'</label></div>').join('');
    if(linkOpts){ sessionOpts=linkOpts; linkOpts=null; }   // a share link's selection wins once
    let saved=sessionOpts;
    if(!saved){ try{ saved=(localStorage.getItem(OPTS_KEY)||'').split(',').filter(Boolean); }catch(_){ saved=[]; } }
    for(const o of OPTS){ const c=document.getElementById('opt-'+o.id); if(c) c.checked=saved.indexOf(o.id)>=0; }
    box.classList.remove('d-none');
    box.querySelectorAll('.build-option').forEach(c=>c.addEventListener('change',()=>{
      sessionOpts=null;   // an explicit click returns control to the saved preference
      try{ localStorage.setItem(OPTS_KEY,checkedOpts().join(',')); }catch(_){}
      syncUrl();
    }));
  }
  async function fetchOptions(){
    const r=await api('/api/build-options');
    if(!r.ok||!Array.isArray(r.data)) return;   // older broker / transient error: no options
    OPTS=r.data.filter(o=>o&&typeof o.id==='string'&&OPT_RE.test(o.id));
    renderOptions(); syncUrl();
  }
  // Poll cadence: 5s while your own build is active; idle backs off 15s -> 30s -> 60s;
  // nothing at all while the tab is hidden. wake() snaps back to the fast cadence on user
  // activity (typing, branch switch, tab becoming visible). Declared up here with the rest
  // of the state, not down beside the interval that drives it: `wake` is now also reached
  // from a stats response (applyRefs), which can land before a declaration further down has
  // run, and a `let` read from inside its dead zone throws.
  let wait=1, idleLvl=0;
  function wake(now){ idleLvl=0; wait=Math.min(wait,3); if(now&&!document.hidden) refresh(true); }

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

  // The hint shares a flex row with the share button, so its layout classes live in the
  // markup and only the colour is toggled here. Assigning className (as this used to)
  // silently dropped them, leaving the text sitting off-centre against the button.
  const setHint=(text,danger)=>{
    const h=$('hint');
    h.textContent=text;
    h.classList.toggle('text-danger',!!danger);
    h.classList.toggle('muted',!danger);
  };
  function validate(){
    const v=$('board').value.trim(); $('go').disabled=!allowed.has(v)||$('board').disabled;
    // Nothing to share until the box holds a real profile. Not tied to the Build button:
    // during maintenance the picker is disabled but an already-chosen camera is still
    // worth sharing ("this is the one, try later").
    const sh=$('share'); if(sh) sh.disabled=!allowed.has(v);
    if(v && !allowed.has(v)) setHint(I18N.t('not_known_defconfig'),1);
    else setHint(allowed.size?I18N.t('profiles_available',{n:allowed.size}):'',0);
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
  function applyBoards(list){ list.sort(); allowed=new Set(list); $('boards').innerHTML=list.map(b=>`<option value="${esc(b)}">`).join(''); validate(); checkLink(); }
  async function fetchBoards(commit){
    const r=await api('/api/defconfigs?ref='+encodeURIComponent(curRef));
    if(overCap(r)){ capacityBanner(); return; }
    const {ok,data}=r;
    if(!ok||!Array.isArray(data)){ if(!allowed.size) setHint(I18N.t('cameras_load_failed'),1); return; }
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

  /* ---- share links: ?board=<defconfig>&branch=<ref> ------------------------
   * Pre-fills the picker from a link someone shared. It deliberately never starts the
   * build: a link that did would let one forum post burn the global hourly cap for
   * everyone who clicked it. */
  const DEFCONFIG_RE=/^[a-z0-9_+]+$/;   // the token shape the Worker and build.yml enforce
  let linkBoard='', linkRef='', linkMsg=null, linkProbed=false, linkOpts=null;
  (function readLink(){
    const q=new URLSearchParams(location.search);
    const b=(q.get('board')||'').trim(), r=(q.get('branch')||'').trim(), o=(q.get('opts')||'').trim();
    // The bad token is not echoed back into the page: it came from the URL, so it is
    // attacker-controlled, and the message reads fine without it.
    if(b){ if(DEFCONFIG_RE.test(b)) linkBoard=b; else linkMsg={k:'link_bad_board',sticky:1}; }
    // Options from a link are only shape-checked here; unknown ids are dropped when the
    // catalog arrives, and the broker is the real gate at build time.
    if(o&&OPT_RE.test(o)) linkOpts=o.split(',');
    // Kept raw and judged in resolveRef(): whether this branch is offered depends on a
    // list that may not have arrived yet, and a verdict reached against the seed list
    // above would be a guess.
    linkRef=r;
  })();
  // The branch this visit uses: the one a share link named, else the saved default, else
  // the broker's. An unknown link branch is called out rather than silently coerced (the
  // API normalises anything it doesn't recognise, so a typo would quietly build the wrong
  // one) — but only once a real list has proved it unknown.
  //
  // The link's branch applies to this visit only: REF_KEY is deliberately left alone, so
  // following someone's link never rewrites your own saved default.
  function resolveRef(){
    if(linkRef){
      if(REFS.includes(linkRef)) return linkRef;
      if(refsKnown&&!linkMsg) setLinkMsg({k:'link_bad_branch',p:{refs:esc(REFS.join(', '))},sticky:1});
    }
    const saved=localStorage.getItem(REF_KEY);
    return REFS.includes(saved)?saved:DEF_REF;
  }
  // The offered list as it arrives on /api/stats. Runs on every poll, so it returns at the
  // first compare unless something actually changed.
  function applyRefs(list,def){
    if(!Array.isArray(list)||!list.length) return;
    const d=list.includes(def)?def:list[0];
    if(refsKnown&&d===DEF_REF&&list.length===REFS.length&&list.every((r,i)=>r===REFS[i])) return;
    const wasKnown=refsKnown, saved=localStorage.getItem(REF_KEY);
    REFS=list.slice(); DEF_REF=d; refsKnown=true;
    try{ localStorage.setItem(REFS_KEY,JSON.stringify({list:REFS,def:DEF_REF})); }catch(_){}
    // A link branch may only now be judgeable, and a verdict reached against the seed list
    // may only now be wrong, so re-decide it against the list we actually got.
    if(linkMsg&&linkMsg.k==='link_bad_branch') setLinkMsg(null);
    // Retired out from under a visitor who had explicitly chosen it. Say so and let their
    // saved default go: quietly building a branch nobody picked is exactly what the
    // share-link handling exists to prevent. A list we were only guessing at before proves
    // nothing, and neither does a default that moved under someone who never chose one.
    const retired=wasKnown&&saved&&!REFS.includes(saved);
    if(retired) localStorage.removeItem(REF_KEY);
    const was=curRef, want=resolveRef();
    if(want!==was){
      curRef=want; linkProbed=false; loadBoards(); syncUrl();
      // The payload that carried this list was fetched for the branch we just left, so its
      // commit is not this branch's. Hide the badge rather than relabel someone else's
      // commit with the new branch's name, and refetch now so the gap is one round-trip
      // instead of a poll interval.
      const cb=$('commit-badge'); if(cb) cb.classList.add('d-none');
      wake(true);
      if(retired&&!linkMsg) setLinkMsg({k:'branch_gone',p:{was:esc(was),branch:esc(want)},sticky:1});
    }
    renderBranchOptions();
  }
  // The branch radios: built here, not in the markup, because which branches exist is an
  // admin setting. Names go in as text (repo data, not ours); only the "(default)" marker
  // is translated. Ids are positional so a name with a dot or a slash in it stays out of
  // the id and the label's `for`.
  function renderBranchOptions(){
    const box=$('branch-list');
    if(!box) return;
    box.innerHTML=REFS.map((r,i)=>
      '<div class="form-check" data-help="help_branch">'
      +`<input class="form-check-input branch-radio" type="radio" name="branch" id="branch-opt-${i}" value="${esc(r)}">`
      +`<label class="form-check-label" for="branch-opt-${i}">${esc(r)}`
      +(r===DEF_REF?` <span class="small muted">${esc(I18N.t('branch_default'))}</span>`:'')
      +'</label></div>').join('');
    const els=box.querySelectorAll('.branch-radio');
    for(let i=0;i<els.length;i++) els[i].checked=(els[i].value===curRef);
  }
  function renderLinkMsg(){
    const m=$('linkmsg');
    if(!linkMsg){ m.classList.add('d-none'); m.innerHTML=''; return; }
    if(linkMsg.raw) m.innerHTML=linkMsg.raw;
    else{
      m.innerHTML='<i class="bi bi-exclamation-triangle me-1"></i>'+I18N.t(linkMsg.k,linkMsg.p||{})
        +(linkMsg.sw?` <button class="btn btn-sm btn-outline-warning ms-2" id="link-switch">${I18N.t('link_switch',{branch:esc(linkMsg.sw)})}</button>`:'');
      const b=$('link-switch'); if(b) b.onclick=()=>switchTo(linkMsg.sw);
    }
    m.classList.remove('d-none');
  }
  const setLinkMsg=v=>{ linkMsg=v; renderLinkMsg(); };
  // Switching from the offer below is also for this visit only, same reasoning: the
  // Settings dialog stays the one place that changes your default branch.
  function switchTo(ref){
    if(!REFS.includes(ref)||ref===curRef) return;
    curRef=ref; linkProbed=false; setLinkMsg(null); loadBoards(); wake(true); syncUrl();
  }
  // Configs come and go per branch, so a shared camera may simply not exist on the shared
  // branch. Look for it on the others before calling it a dead end. Their lists are cached
  // per branch, so this usually costs no request at all, and only ever runs on a miss.
  //
  // Cached lists are free and all get checked; a cold one costs a request, so only the
  // first few get probed, default branch first. With the branch list admin-editable this
  // can no longer be "try them all" — the point is a helpful offer, not an exhaustive
  // search, and twenty enabled branches would otherwise mean nineteen requests on a miss.
  const COLD_PROBES=3;
  async function otherBranchWith(board){
    const rest=REFS.filter(r=>r!==curRef).sort((a,b)=>(b===DEF_REF)-(a===DEF_REF));
    const cold=[];
    for(const r of rest){
      let list=null;
      try{ const c=JSON.parse(localStorage.getItem(DC_KEY(r))||'null'); if(c&&Array.isArray(c.list)) list=c.list; }catch(_){}
      if(list){ if(list.indexOf(board)>=0) return r; }
      else cold.push(r);
    }
    for(const r of cold.slice(0,COLD_PROBES)){
      const res=await api('/api/defconfigs?ref='+encodeURIComponent(r));
      if(res.ok&&Array.isArray(res.data)&&res.data.indexOf(board)>=0) return r;
    }
    return null;
  }
  // Runs whenever the camera list changes: a shared board missing from this branch gets a
  // real explanation (plus a one-click switch when another branch has it) instead of the
  // generic "not a known defconfig" hint.
  async function checkLink(){
    if(!linkBoard) return;
    if(allowed.has(linkBoard)){ linkProbed=false; if(linkMsg&&!linkMsg.sticky) setLinkMsg(null); return; }
    if(linkProbed) return;
    linkProbed=true;
    const other=await otherBranchWith(linkBoard);
    if(!allowed.size||allowed.has(linkBoard)) return;   // the list arrived or changed while probing
    const p={board:esc(linkBoard),branch:esc(curRef)};
    setLinkMsg(other?{k:'link_not_on_branch',p,sw:other}:{k:'link_not_anywhere',p});
  }
  // The link that reproduces what is selected right now. Board only when it is a real one
  // for this branch; the branch always, so sharing just a branch works too.
  function shareUrl(){
    const u=new URL(location.origin+location.pathname);
    const v=$('board').value.trim();
    if(allowed.has(v)) u.searchParams.set('board',v);
    u.searchParams.set('branch',curRef);
    const o=checkedOpts(); if(o.length) u.searchParams.set('opts',o.join(','));
    return u.toString();
  }
  // Mirror the selection into the address bar so copying it by hand works too. replaceState,
  // never pushState, so this adds no history entries to back out through. An untouched visit
  // keeps a clean URL: params appear only once there is a real camera to share.
  function syncUrl(){
    const v=$('board').value.trim();
    history.replaceState(null,'',allowed.has(v)?shareUrl():location.origin+location.pathname);
  }

  /* Notice levels: GitHub's five markdown alert types, each in a Bootstrap alert variant
   * (note and caution keep the colours the old info and danger levels had) and with the
   * Bootstrap icon closest to GitHub's octicon for it: info, light-bulb, report, alert,
   * stop. info/danger are what note/caution used to be called, mapped here so a notice
   * posted before the rename keeps rendering in the right colour. */
  const NOTICE={
    note:      {cls:'alert-info',    icon:'info-circle'},
    tip:       {cls:'alert-success', icon:'lightbulb'},
    important: {cls:'alert-purple',  icon:'exclamation-square'},
    warning:   {cls:'alert-warning', icon:'exclamation-triangle'},
    caution:   {cls:'alert-danger',  icon:'exclamation-octagon'},
  };
  const NOTICE_ALIAS={info:'note',danger:'caution'};
  const noticeLevel=l=>{ const s=NOTICE_ALIAS[l]||l; return NOTICE[s]?s:'note'; };

  function renderGlobal(d){
    curCommit=d.commit||null;
    $('stats').innerHTML=`<i class="bi bi-hdd-stack me-1"></i><b>${esc(d.running)}</b>/${esc(d.max_concurrent)} ${I18N.t('stats_building')} &nbsp;·&nbsp; <b>${esc(d.queued)}</b> ${I18N.t('stats_queued')} &nbsp;·&nbsp; ${I18N.t('stats_typical')} <b>${mins(d.avg_build_secs)}</b>`;
    const cb=$('commit-badge');
    if(curCommit){ cb.textContent=I18N.t('commit_badge_text',{branch:curRef,commit:curCommit.slice(0,7)}); cb.href='https://github.com/themactep/thingino-firmware/commit/'+curCommit; cb.classList.remove('d-none'); } else cb.classList.add('d-none');
    if(d.version){ const v=$('version'); if(v) v.textContent=d.version;
      const av=$('about-version'); if(av) av.textContent=d.version; }
    const b=$('banner');
    if(d.builds_enabled===false){ b.innerHTML='<i class="bi bi-exclamation-triangle me-1"></i>'+I18N.t('builds_disabled'); b.classList.remove('d-none'); }
    else b.classList.add('d-none');
    // Admin-posted notice: informational only, so unlike the banner above it never touches
    // the picker. The text is admin-typed and this is a public page, so it goes in as text
    // and only the icon and the level label are markup. It is one notice at a time, by
    // construction server-side.
    // The level's label ("Note", "Tip", …) is the visitor's language, the text stays the
    // language the admin wrote it in: the label is ours to translate, the text is theirs.
    const nb=$('notice'), n=d.notice;
    if(n&&n.text){
      const lvl=noticeLevel(n.level);
      // `pulse` rides along in the class string deliberately. A CSS animation only restarts
      // when its class is missing at a style recalculation, so reassigning a string that
      // still carries it leaves the loops running and the 10s/60s cadence survives every
      // poll. Dropping it and re-adding it separately would restart the pulse each time.
      nb.className='alert '+NOTICE[lvl].cls+' py-2 small pulse';
      // dir="auto" on the text only: the admin writes the notice in their own language, so
      // its base direction comes from its own first strong character, not from the visitor's
      // page. Without it an English notice on an Arabic page throws its trailing punctuation
      // to the wrong end (and an Arabic notice on an English page does the same).
      nb.innerHTML='<i class="bi bi-'+NOTICE[lvl].icon+' me-1"></i><b class="notice-label me-1"></b><span class="notice-text" dir="auto"></span>';
      nb.querySelector('.notice-label').textContent=I18N.t('notice_'+lvl);
      nb.querySelector('.notice-text').textContent=n.text;
    } else { nb.className='alert py-2 small d-none'; nb.textContent=''; }
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

  // Stop tracking the finished build: drops the box and the localStorage pointer. Nothing
  // server-side changes, the box is only this page's record of it.
  // The id is remembered because the VPS broker's stats carry a `you` for the requester's
  // latest build whatever its state, and consume() adopts that when nothing is tracked:
  // without this the box would come straight back on the next poll. (The Worker sends no
  // `you` at all, so this only bites the broker deployment.)
  const clearMine=()=>{
    if(myId){ dismissedId=myId; try{ localStorage.setItem(DIS_KEY,myId); }catch(_){} }
    setMy(null); you=null; renderYou(); $('board').focus();
  };
  // Dismiss for the states whose box is purely a record (failed / cancelled / expired).
  // Deliberately not on 'done': its box holds a live download link, and there is already
  // a Build another button for moving on, so an X there would be a one-click way to lose
  // the link to a build that took half an hour.
  const dismissBtn=()=>`<button type="button" class="btn-close btn-close-white" id="dismiss" title="${esc(I18N.t('dismiss_btn'))}" aria-label="${esc(I18N.t('dismiss_btn'))}"></button>`;
  function renderYou(){
    const picker=$('picker'), mb=$('mybuild');
    if(!you){ mb.classList.add('d-none'); mb.innerHTML=''; picker.classList.remove('d-none'); return; }
    picker.classList.toggle('d-none', ACTIVE.has(you.state));
    mb.classList.remove('d-none');
    const live=(you.elapsed_secs||0)+(Date.now()-youAt)/1000;
    const meta=`<div class="small muted mt-2">${I18N.t('meta_defconfig')} <code>${esc(you.defconfig)}</code>${you.options?`<br>${I18N.t('meta_options')} <code>${esc(you.options)}</code>`:''}<br>${I18N.t('meta_build_id')} <code>${esc(you.build_id)}</code>${you.deduped?`<br><span class="text-warning">${I18N.t('deduped_note')}</span>`:''}</div>`;
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
      h=`<div class="alert alert-danger alert-dismissible mb-0">${dismissBtn()}<i class="bi bi-exclamation-triangle-fill me-1"></i><strong>${I18N.t('state_failed')}</strong>${meta}<div class="mt-2"><button class="btn btn-outline-warning btn-sm" id="again">${I18N.t('try_again_btn')}</button></div></div>`;
    else
      h=`<div class="alert alert-secondary alert-dismissible mb-0">${dismissBtn()}<strong>${you.state==='expired'?I18N.t('state_expired'):I18N.t('state_cancelled')}</strong>${meta}<div class="mt-2"><button class="btn btn-outline-secondary btn-sm" id="again">${I18N.t('build_again_btn')}</button></div></div>`;
    mb.innerHTML=h;
    const c=$('cancel'); if(c) c.onclick=cancelBuild;
    const a=$('again'); if(a) a.onclick=clearMine;
    const d=$('dismiss'); if(d) d.onclick=clearMine;
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
    // After noteCommit, deliberately: this payload was fetched for the branch this tab is
    // on, so it belongs to that branch's cache even if the list below moves us off it.
    applyRefs(data.branches, data.branch_default);
    if(!myId && data.you && data.you.build_id!==dismissedId){ setMy(data.you.build_id); }
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
    const opts=checkedOpts();
    const {ok,status,data}=await api('/api/build',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({defconfig,ref:curRef,options:opts})});
    if(!ok){ setHint((data&&data.error)||I18N.t('request_failed',{status}),1); $('go').disabled=false; return; }
    setMy(data.build_id);
    you={build_id:data.build_id, defconfig:data.defconfig, options:data.options||opts.join(','), state:data.state||'queued', position:data.position||0, elapsed_secs:0, download_url:data.download_url, deduped:data.deduped};
    youAt=Date.now(); renderYou(); refresh(true);
  }

  async function cancelBuild(){
    if(!you) return;
    const b=$('cancel'); if(b){ b.disabled=true; b.textContent=I18N.t('state_cancelling'); }
    const {data}=await api(`/api/cancel/${you.build_id}`,{method:'POST'});
    if(data&&data.state){ you.state=(data.state==='cancelled')?'cancelled':'cancelling'; youAt=Date.now(); renderYou(); }
    refresh(true);
  }

  /* ---- Opt-in help balloons (Settings toggle; off by default) ---- */
  let helpMode = localStorage.getItem('thingino_help')==='1';
  let _helpBalloon=null, _helpHover=null;

  function applyHelpMode(){
    document.body.classList.toggle('help-on', helpMode);
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

  // Typing supersedes whatever the link said, so its message goes and the URL follows along.
  $('board').addEventListener('input',()=>{ validate(); if(linkMsg) setLinkMsg(null); syncUrl(); });
  $('board').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!$('go').disabled) submit(); });
  $('go').addEventListener('click',submit);
  $('share').addEventListener('click',async()=>{
    const url=shareUrl(), lbl=$('share').querySelector('span'), was=lbl.textContent;
    // Clipboard needs a secure context and permission; when it is refused, show the URL
    // instead so the link is still copyable by hand.
    try{ await navigator.clipboard.writeText(url); }
    catch{ setLinkMsg({raw:`<i class="bi bi-link-45deg me-1"></i><code style="word-break:break-all">${esc(url)}</code>`}); return; }
    lbl.textContent=I18N.t('share_copied');
    setTimeout(()=>{ lbl.textContent=was; },1500);
  });
  function openSettings(){ renderBranchOptions(); $('settings-overlay').classList.remove('d-none'); }
  function closeSettings(){ $('settings-overlay').classList.add('d-none'); }
  function saveSettings(){
    const sel=document.querySelector('.branch-radio:checked');
    if(sel&&REFS.includes(sel.value)&&sel.value!==curRef){ curRef=sel.value; localStorage.setItem(REF_KEY,curRef); linkProbed=false; loadBoards(); wake(true); syncUrl(); }
    closeSettings();
  }
  // Privacy opens in an overlay: markup in index.html, wiring shared with the admin page
  // in privacy-modal.js (loaded before this file).
  $('settings-btn').addEventListener('click',openSettings);
  $('settings-cancel').addEventListener('click',closeSettings);
  $('settings-save').addEventListener('click',saveSettings);
  $('settings-overlay').addEventListener('click',e=>{ if(e.target===$('settings-overlay')) closeSettings(); });
  // About: a plain show/hide of static, already-translated markup. Closes the way the
  // Settings dialog does, on either close control or a click on the backdrop itself.
  const showAbout=on=>$('about-overlay').classList.toggle('d-none',!on);
  $('btn-about').addEventListener('click',()=>showAbout(true));
  $('about-close').addEventListener('click',()=>showAbout(false));
  $('about-close-x').addEventListener('click',()=>showAbout(false));
  $('about-overlay').addEventListener('click',e=>{ if(e.target===$('about-overlay')) showAbout(false); });
  // Escape dismisses whichever is open, the way the backdrop already does.
  // Settings persists through Save, so leaving it this way discards.
  document.addEventListener('keydown',e=>{ if(e.key!=='Escape') return; closeSettings(); showAbout(false); });
  $('setting-help').addEventListener('change',e=>setHelp(e.target.checked));
  I18N.apply(); renderFooterLimits(); I18N.selector('lang-slot'); applyHelpMode();
  window.addEventListener('i18nchange',()=>{ I18N.apply(); renderFooterLimits(); validate(); renderYou(); renderLinkMsg(); renderBranchOptions(); if(lastStatsData) renderGlobal(lastStatsData); applyHelpMode(); fetchOptions(); });
  // Seed the picker from a share link before the first list load, so the board is already
  // in place when checkLink() gets to judge it against this branch.
  if(linkBoard) $('board').value=linkBoard;
  // Now that setLinkMsg exists to carry its verdict on the link's branch.
  curRef=resolveRef(); renderBranchOptions();
  renderLinkMsg();
  fetchOptions();
  loadBoards(); refresh(true);
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
