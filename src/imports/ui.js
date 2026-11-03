// One-time Google Drive import. Google access tokens live only in this view's closure.
function driveImportPanel(pid, onDone) {
  var root=h('section',{class:'card drive-import',hidden:true,'aria-label':'Google Drive import'}), msg=h('p',{role:'status','aria-live':'polite'}), list=h('div'), controls=h('div',{class:'row'}), account=h('p'), folder=h('select',{'aria-label':'Destination folder'}), jobs=h('div');
  var cfg, token=null, session=null, job=null, state=null, alive=true, busy=false, cancelled=false;
  var audience=h('p',{class:'muted small'});
  var base='/api/projects/'+enc(pid)+'/drive-import';
  S.cleanups.push(function(){alive=false;token=null;session=null;});
  async function call(method,path,body,key){return api(method,base+path,body,{key:key||uuid(),headers:token?{'x-google-access-token':token}:{}});}
  async function loadScript(src){
    await new Promise(function(resolve,reject){var s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=function(){reject(Error('Google scripts could not load. Check your connection and retry.'));};document.head.append(s);});
  }
  async function authorize(){
    if(!navigator.onLine)throw Error('Offline. Reconnect to authorize Google Drive.');
    if(!window.google?.accounts?.oauth2)await loadScript('https://accounts.google.com/gsi/client');
    var r=await new Promise(function(resolve,reject){
      var c=google.accounts.oauth2.initTokenClient({client_id:cfg.client_id,scope:'https://www.googleapis.com/auth/drive.file',include_granted_scopes:false,callback:function(v){v.error?reject(Error(v.error)):resolve(v);},error_callback:function(){reject(Error('Google authorization was closed or blocked; try again.'));}});c.requestAccessToken({prompt:'select_account'});
    });
    if(!alive)return;
    token=r.access_token;
    session=await call('POST','/sessions',{});
    account.textContent='Google account: '+session.account+' · Destination: '+(projectTitles[pid]||pid);
    if(job)await call('POST','/jobs/'+enc(job)+'/resume',{session_id:session.session_id});
  }
  async function choose(){
    if(!token)await authorize();
    if(!alive)return;
    if(!window.gapi)await loadScript('https://apis.google.com/js/api.js');
    await new Promise(function(resolve,reject){gapi.load('picker',{callback:resolve,onerror:function(){reject(Error('Google Picker unavailable'));}});});
    var ids=await new Promise(function(resolve){
      new google.picker.PickerBuilder().addView(new google.picker.DocsView().setIncludeFolders(false)).enableFeature(google.picker.Feature.MULTISELECT_ENABLED).setMaxItems(25).setOAuthToken(token).setDeveloperKey(cfg.api_key).setAppId(cfg.app_id).setOrigin(location.origin).setCallback(function(d){if(d.action===google.picker.Action.PICKED)resolve(d.docs.map(function(f){return f.id;}));else if(d.action===google.picker.Action.CANCEL)resolve([]);}).build().setVisible(true);
    });
    if(!ids.length||!alive)return;
    var r=await call('POST','/jobs',{session_id:session.session_id,file_ids:ids,folder_id:folder.value||null});job=r.job_id;cancelled=false;await inspect();
  }
  async function read(){
    var s=await call('GET','/jobs/'+enc(job)), cursor=s.next_cursor;while(cursor){var p=await call('GET','/jobs/'+enc(job)+'?cursor='+enc(cursor));s.items.push.apply(s.items,p.items);cursor=p.next_cursor;}state=s;draw();return s;
  }
  async function inspect(){
    await read();
    while(alive&&!cancelled&&state.state==='review'&&state.items.some(function(t){return ['selected','inspecting'].includes(t.state);})){await call('POST','/jobs/'+enc(job)+'/process',{});await read();}
  }
  function button(text,fn){return h('button',{type:'button',class:'secondary',onclick:function(){run(fn);}},text);}
  async function run(fn){
    if(busy)return;busy=true;msg.textContent='Working…';root.setAttribute('aria-busy','true');
    try{await fn();msg.textContent='Review the file outcomes below.';}catch(e){msg.textContent=(e.status===0?'Offline. Reconnect and resume. ':e.message||String(e))+' Your selection and completed copies are saved.';}
    finally{busy=false;root.setAttribute('aria-busy','false');}
  }
  async function edit(t,opts){await call('POST','/jobs/'+enc(job)+'/edit',Object.assign({item_id:t.id,manifest_version:state.manifest_version},opts));await inspect();}
  function draw(){
    if(!alive)return;
    account.textContent='Google account: '+state.account+' · Destination: '+(projectTitles[pid]||pid)+' · '+state.state;
    list.replaceChildren();
    state.items.forEach(function(t){
      var card=h('article',{class:'card'},h('strong',{text:t.title||t.source?.name||t.source_id}),h('p',{text:t.state+' · '+(t.size===null?'Checking size':fmtBytes(t.size))+' · '+(t.mime||'Checking format')}));
      if(t.source)card.append(h('a',{href:t.source.url,target:'_blank',rel:'noopener noreferrer'},'Open source in Google Drive'),h('p',{class:'muted small',text:t.source.mimeType+(t.source.native_snapshot?' · Exported snapshot; conversion may lose formatting or features.':'')}));
      if(t.kind==='markdown')card.append(h('p',{class:'muted small',text:'Google Markdown conversion can change tables, images, footnotes and links. Linked files and images are not copied.'}));
      if(t.preview)card.append(h('details',null,h('summary',{text:'Markdown source preview (up to 8,000 characters)'}),h('pre',{class:'raw',text:t.preview,tabIndex:0})));
      if(t.mime==='application/octet-stream')card.append(h('p',{text:'Downloadable Office file. Preview unavailable — download or open the source.'}));
      if(t.error_message)card.append(h('p',{text:t.error_message}));
      if(t.library_url)card.append(h('a',{href:t.library_url},'Open library copy'));
      if(state.state==='review'&&!['imported','cancelled'].includes(t.state)){
        card.append(button('Remove',function(){return edit(t,{remove:true});}));
        if(['already_imported','association_unavailable'].includes(t.error_code))card.append(button('Import another copy',function(){return edit(t,{another_copy:true});}));
      }
      list.append(card);
    });
    controls.replaceChildren();
    if(state.state==='cancelled')return;
    controls.append(button('Authorize / resume same Google account',async function(){await authorize();await inspect();}),button('Retry failed files',async function(){await call('POST','/jobs/'+enc(job)+'/retry',{});await inspect();}),h('button',{type:'button',class:'secondary',onclick:async function(){cancelled=true;try{await call('POST','/jobs/'+enc(job)+'/cancel',{});token=null;session=null;await read();msg.textContent='Cancelled unfinished work. Published copies remain.';}catch(e){cancelled=false;msg.textContent=e.message;}}},'Cancel remaining files'));
    if(state.state==='review'&&state.items.some(function(t){return t.state==='ready';})&&!state.items.some(function(t){return ['selected','inspecting','needs_reauthorization'].includes(t.state);})){controls.append(button('Confirm import',async function(){await call('POST','/jobs/'+enc(job)+'/confirm',{manifest_version:state.manifest_version});await publish();}));}
    if(state.state==='confirmed'&&state.items.some(function(t){return ['ready','publishing'].includes(t.state);})){controls.append(button('Continue import',publish));}
  }
  async function publish(){
    await read();while(alive&&!cancelled&&state.state==='confirmed'&&state.items.some(function(t){return ['ready','publishing'].includes(t.state);})){await call('POST','/jobs/'+enc(job)+'/process',{});await read();}onDone();
    if(!state.items.some(function(t){return ['ready','publishing','needs_reauthorization','failed'].includes(t.state);})&&session){await call('DELETE','/sessions/'+enc(session.session_id));token=null;session=null;}
  }
  root.append(h('h2',{text:'Import from Google Drive'}),account,audience,h('p',{text:'These files will be copied into this project. Agents with project access can read the copies. Drive changes will not update them automatically.'}),h('p',{class:'muted small',text:'Library permissions apply independently of Drive. Source links stay unchanged. Copies remain after disconnecting Google. Select up to 25 files within the remaining project quota. No folders or shortcuts.'}),msg,folder,jobs,list,controls);
  root.open=function(){root.hidden=!root.hidden;if(root.hidden)return;run(async function(){
    cfg=await call('GET','');
    if(!cfg.configured){msg.textContent='Google Drive import needs setup: configure GOOGLE_DRIVE_CLIENT_ID, GOOGLE_PICKER_API_KEY and GOOGLE_PICKER_APP_ID, enable the Drive and Picker APIs, and register this app origin in Google Cloud. See docs/google-drive-import.md.';return;}
    // Load provider libraries before the next click, preserving popup user activation.
    if(!window.google?.accounts?.oauth2)await loadScript('https://accounts.google.com/gsi/client');
    if(!window.gapi)await loadScript('https://apis.google.com/js/api.js');
    var labels=[];
    cfg.connections.connections.filter(function(c){return c.status==='active'&&c.projects.some(function(p){return p.id===pid;});}).forEach(function(c){labels.push(c.client_name);});
    cfg.connections.grants.filter(function(g){return g.project_id===pid&&g.status==='active';}).forEach(function(g){labels.push(g.label);});
    cfg.api_keys.keys.filter(function(k){return k.status==='active'&&k.projects.some(function(p){return p.project_id===pid;});}).forEach(function(k){labels.push(k.label);});
    audience.textContent='Agent connections with project access: '+(labels.join(', ')||'None currently')+'. Access is checked again on every library read.';
    folder.replaceChildren(h('option',{value:'',text:'Project root'}));(cfg.folders.folders||[]).forEach(function(f){folder.append(h('option',{value:f.id,text:f.title||f.name}));});
    controls.replaceChildren(button('Select files with Google Picker',choose));
    jobs.replaceChildren();cfg.jobs.forEach(function(j){jobs.append(button('Resume '+j.account_label+' · '+fmtDate(j.created_at),async function(){job=j.id;await read();}));});
    msg.textContent='Select files or reopen a saved import. Closing the page pauses unfinished work; authorize the same Google account to resume.';
  });};return root;
}
function driveSourceCard(source){
  return source?h('div',{class:'callout'},h('span',null,h('a',{href:source.source_url,target:'_blank',rel:'noopener noreferrer'},'Open source in Google Drive'),h('p',{text:'Imported '+fmtDate(source.imported_at)+' · One-time copy; automatic updates are off.'}))):null;
}
