// Auto-generado: contenido movido desde public/index.html para CSP estricta

// ── CSRF auto-header: añade X-CSRF-Token en cada fetch de mutación ───────────
(function(){
  function readCookie(name){
    const m = document.cookie.match('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\\/\+^])/g,'\\$1') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  const SAFE = new Set(['GET','HEAD','OPTIONS']);
  const _fetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    init = init || {};
    let method = (init.method || (typeof input === 'object' && input && input.method) || 'GET');
    method = String(method).toUpperCase();
    if (!SAFE.has(method)) {
      const tok = readCookie('csrf');
      if (tok) {
        const headers = new Headers(init.headers || {});
        headers.set('X-CSRF-Token', tok);
        init.headers = headers;
      }
    }
    return _fetch(input, init);
  };
})();

const $ = id => document.getElementById(id);
let topics=[], qResults=[], mapSVG='', mapW=0, mapH=0, busy=false, qActiveTab=0;
let maqResults=[];
let currentUser=null;
let historyItems=[], histFilter='';
let templates=[], activeTplId='default-scormxpress', customColors=null;
// Moodle state
let moo = { connected:false, url:'', token:'', userid:null, courses:[], selectedCourse:null };

const cfg = {
  numQ:20, qMode:'pertopic', numOpts:4,
  diffMode:'single', diffSingle:'alto', diffBajo:30, diffMedio:40, diffAlto:30,
  typeMode:'teorico', typeMixPct:50,
  polarityMode:'positive', polarityPositivePct:80,
  minW:30, maxW:80,
  expMode:'unico', penalty:'none',
  pages:3, mapDepth:'completo', mapStyle:'radial',
  // Maquetación → autoevaluación integrada
  maqQuizEnabled:false, maqQuizType:'3opt', maqQuizNum:10, maqQuizDiff:'medio', maqQuizDist:'end'
};
const MAP_COLORS=[{bg:'#e1f5ee',s:'#085041',t:'#04342C'},{bg:'#e6f1fb',s:'#185FA5',t:'#042C53'},{bg:'#faece7',s:'#993C1D',t:'#4A1B0C'},{bg:'#EEEDFE',s:'#534AB7',t:'#26215C'},{bg:'#faeeda',s:'#854F0B',t:'#412402'},{bg:'#EAF3DE',s:'#3B6D11',t:'#173404'},{bg:'#FBEAF0',s:'#993556',t:'#4B1528'}];

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function setCfg(k,v){cfg[k]=v;refreshUI();}
function actSeg(id,idx){document.querySelectorAll(`#${id} button`).forEach((b,i)=>b.classList.toggle('on',i===idx));}
function showDiff(m){$('diffSingle').style.display=m==='single'?'block':'none';$('diffMix').style.display=m==='mix'?'block':'none';}
function syncDiff(){const b=+$('dB').value,m=+$('dM').value,a=+$('dA').value;cfg.diffBajo=b;cfg.diffMedio=m;cfg.diffAlto=a;$('dBv').textContent=b+'%';$('dMv').textContent=m+'%';$('dAv').textContent=a+'%';const t=b+m+a;$('dSum').className='dsum '+(t===100?'ok':'warn');$('dSum').textContent=t===100?'✓ Total: 100%':'⚠ Total: '+t+'%';}
function syncMix(){const v=+$('mixR').value;cfg.typeMixPct=v;$('mixV').textContent=v+'%';$('mixDesc').textContent=`${100-v}% teóricas · ${v}% prácticas`;}
function syncPol(){const v=+$('polR').value;cfg.polarityPositivePct=v;$('polV').textContent=v+'%';$('polRneg').value=100-v;$('polVneg').textContent=(100-v)+'%';}
function syncLen(w,v){if(w==='min'){cfg.minW=+v;$('mnV').textContent=v;}else{cfg.maxW=+v;$('mxV').textContent=v;}}
function setLen(mn,mx){cfg.minW=mn;cfg.maxW=mx;$('mnR').value=mn;$('mnV').textContent=mn;$('mxR').value=mx;$('mxV').textContent=mx;}
function syncPages(v){cfg.pages=+v;$('pagesV').textContent=v+' pág.';$('pagesW').textContent='≈ '+(+v*480)+' palabras';refreshUI('s');}
function setExp(m){cfg.expMode=m;['unico','separados','zip'].forEach(x=>{const el=$('exp'+x.charAt(0).toUpperCase()+x.slice(1));if(el)el.classList.toggle('on',x===m);});}
function setPenalty(p){cfg.penalty=p;['none','third','half','full'].forEach(x=>$('pen-'+x).classList.toggle('on',x===p));const h={none:'Sin penalización (solo efecto en GIFT).',third:'Penaliza -1/3 pregunta por error (solo en GIFT).',half:'Penaliza -1/2 pregunta por error (solo en GIFT).',full:'Penaliza -1 pregunta completa por error (solo en GIFT).'};$('penHint').textContent=h[p];}
function setMaqQuiz(on){cfg.maqQuizEnabled=!!on;document.querySelectorAll('#segMaqQ button').forEach((b,i)=>b.classList.toggle('on',(i===0&&!on)||(i===1&&on)));$('maqQuizOpts').style.display=on?'block':'none';}
function syncMaqQNum(v){cfg.maqQuizNum=+v;$('maqQNumV').textContent=v;}
$('nqR').oninput=e=>{cfg.numQ=+e.target.value;$('nqN').value=e.target.value;refreshUI();};
$('nqN').oninput=e=>{const v=Math.min(200,Math.max(1,+e.target.value||1));cfg.numQ=v;$('nqR').value=v;refreshUI();};

function setTab(t){
  ['q','s','m','ma','hist'].forEach(x=>{
    $(`tab-${x}`).classList.toggle('on',x===t);
    const panel=$(`panel-${x}`);
    if(panel){panel.style.display=x===t?'flex':'none';panel.style.flexDirection='column';}
    const sb=$(`sb-${x}`);
    if(sb)sb.style.display=x===t?'block':'none';
  });
  // Documentos sidebar visible en todo menos historial
  $('sb-docs').style.display=t==='hist'?'none':'block';
  refreshUI(t);
  if(t==='hist')loadHistory();
  if(t==='ma')renderTplChips();
}
function getQPerTopic(i){const n=topics.length;if(cfg.qMode==='pertopic')return cfg.numQ;return i===n-1?cfg.numQ-Math.floor(cfg.numQ/n)*(n-1):Math.floor(cfg.numQ/n);}

function refreshUI(tab){
  const t=tab||(document.querySelector('.tab.on')?.id?.replace('tab-','')||'q');
  const has=topics.length>0;
  $('factions').style.display=has?'flex':'none';$('fcount').style.display=has?'block':'none';
  $('fcount').textContent=`${topics.length} documento${topics.length!==1?'s':''} cargado${topics.length!==1?'s':''}`;

  if(t==='q'){
    $('q-empty').style.display=has?'none':'block';$('q-actions').style.display=has?'flex':'none';
    if(has){$('q-actions').style.flexDirection='column';$('q-actions').style.gap='.875rem';}
    const h={2:'A, B (V/F)',3:'A, B, C',4:'A, B, C, D',5:'A, B, C, D, E'};$('optsHint').textContent=h[cfg.numOpts]||'A, B, C, D';
    const total=cfg.qMode==='pertopic'?cfg.numQ*topics.length:cfg.numQ;
    $('qTotal').textContent=has?`→ ~${total} preguntas en total`:'';
    $('qModeLabel').textContent=cfg.qMode==='pertopic'?'(por tema)':'(total)';
    $('qModeInfo').textContent=cfg.qMode==='pertopic'?'Cada tema recibe N preguntas':'N preguntas distribuidas entre todos los temas';
    const polH={positive:'Todas se formulan en positivo ("¿Cuál es correcta?")',negative:'Todas en negativo ("¿Cuál NO es...?", "Señala la incorrecta")',mix:`${cfg.polarityPositivePct}% positivas · ${100-cfg.polarityPositivePct}% negativas`};
    $('polHint').textContent=polH[cfg.polarityMode];
    if(has){$('qDesc').textContent=`${cfg.qMode==='pertopic'?cfg.numQ+' preg/tema × '+topics.length+' temas':cfg.numQ+' preguntas'} · ${cfg.numOpts} opciones · ${cfg.polarityMode==='positive'?'positivas':cfg.polarityMode==='negative'?'negativas':'mixtas'}`;$('btnGen').textContent=`Generar banco (~${total} preguntas)`;}
  }
  if(t==='s'){$('s-empty').style.display=has?'none':'block';$('s-actions').style.display=has?'block':'none';renderTopicSel('sumSel','sum');const sel=getSelected('sum');if(has){$('sDesc').textContent=sel.length?`${sel.length} tema${sel.length!==1?'s':''} · ${cfg.pages} pág. c/u (≈${cfg.pages*480} pal.)`:'Selecciona al menos un tema';$('btnSum').disabled=sel.length===0;}}
  if(t==='m'){$('m-empty').style.display=has?'none':'block';$('m-actions').style.display=has?'block':'none';renderTopicSel('mapSel','map');const dh=cfg.mapStyle==='novak'?{simple:'~8 conceptos · 1 nivel',completo:'~16 conceptos · 2 niveles + cross-links',detallado:'~24 conceptos · 3 niveles + cross-links'}:{simple:'4-5 ramas · 2-3 subnodos',completo:'6-7 ramas · 3-4 subnodos',detallado:'7-8 ramas · 4-5 subnodos'};$('depthHint').textContent=dh[cfg.mapDepth]||'';}
  if(t==='ma'){
    $('ma-empty').style.display=has?'none':'block';
    renderTopicSel('maqSel','maq');
    const sel=getSelected('maq');
    $('ma-actions').style.display=has&&sel.length?'block':'none';
    const cnt=$('maqSelCount');if(cnt)cnt.textContent=sel.length?`(${sel.length})`:'';
    if(has&&sel.length){
      if(sel.length===1){
        const tp=topics.find(t=>t.id===sel[0]);
        if(tp){
          const imgNote=tp.imageCount>0?` · ${tp.imageCount} imagen${tp.imageCount!==1?'es':''}`:'';
          const tblNote=tp.tableCount>0?` · ${tp.tableCount} tabla${tp.tableCount!==1?'s':''}`:'';
          const largeNote=tp.largeDoc?' · <span style="color:var(--p);font-weight:600">documento grande — procesamiento por secciones</span>':'';
          const pgNote=tp.pages?` · ${tp.pages} págs`:'';
          $('maSelectedInfo').innerHTML=`📄 <strong>${esc(tp.name.replace(/\.[^.]+$/,''))}</strong> · ${tp.type.toUpperCase()}${pgNote}${tp.words?' · '+tp.words.toLocaleString()+' palabras':''}${imgNote}${tblNote}${largeNote}`;
        }
        $('btnMaq').textContent='✨ Maquetar según SCORMXPRESS';
      } else {
        const selTopics=sel.map(id=>topics.find(t=>t.id===id)).filter(Boolean);
        const totalImg=selTopics.reduce((s,t)=>s+(t.imageCount||0),0);
        const totalTbl=selTopics.reduce((s,t)=>s+(t.tableCount||0),0);
        const anyLarge=selTopics.some(t=>t.largeDoc);
        $('maSelectedInfo').innerHTML=`📄 <strong>${sel.length} documentos seleccionados</strong>${totalImg?` · ${totalImg} imágenes`:''}${totalTbl?` · ${totalTbl} tablas`:''}${anyLarge?' · <span style="color:var(--p);font-weight:600">incluye docs grandes</span>':''}`;
        $('btnMaq').textContent=`✨ Maquetar ${sel.length} documentos`;
      }
    }
    // Hints
    const qth={vf:'Verdadero / Falso · una afirmación por pregunta',
               '3opt':'Una sola respuesta correcta · A, B, C',
               '4opt':'Una sola respuesta correcta · A, B, C, D'};
    const qte=$('maqQTypeHint');if(qte)qte.textContent=qth[cfg.maqQuizType]||'';
    const qdh={end:'Las preguntas y soluciones aparecerán al final del Word, en página propia.',
               inline:'Las preguntas se distribuirán a lo largo del texto en cuadros destacados.'};
    const qdhe=$('maqQDistHint');if(qdhe)qdhe.textContent=qdh[cfg.maqQuizDist]||qdh.end;
    renderTplChips();
  }
}

function renderTopics(){
  $('flist').innerHTML=topics.map((t,i)=>{
    const meta=t.type==='pdf'?(t.pages?t.pages+'p · '+t.sizeKB+'KB':t.sizeKB+'KB'):t.words?.toLocaleString()+' pal.';
    const imgBadge=t.imageCount?`<span class="fimg-badge">📷${t.imageCount}</span>`:'';
    const bigBadge=t.largeDoc?'<span class="flarge-badge">LARGO</span>':'';
    return `<div class="fitem"><span class="ftag ${t.type}">${t.type.toUpperCase()}</span><span class="fname" title="${esc(t.name)}">${esc(t.name.replace(/\.[^.]+$/,''))}</span><span class="fmeta">${meta}</span>${imgBadge}${bigBadge}<button class="fx" data-id="${t.id}">×</button></div>`;
  }).join('');
  $('flist').querySelectorAll('.fx').forEach(b=>b.onclick=()=>{topics=topics.filter(t=>t.id!==b.dataset.id);renderTopics();refreshUI();});
}

function renderTopicSel(elId,mode){
  const el=$(elId);if(!el)return;
  if(!topics.length){el.innerHTML='<div style="font-size:12px;color:var(--txt3);padding:.5rem">Sin documentos</div>';return;}
  const multi = mode==='sum' || mode==='maq';
  const cls = mode==='sum' ? 'sch' : (mode==='maq' ? 'mch' : '');
  el.innerHTML=topics.map((t,i)=>{
    const big=t.largeDoc?' <span class="flarge-badge">LARGO</span>':'';
    const tblBadge = t.tableCount?`<span class="ftbl-badge" style="margin-left:2px">▦${t.tableCount}</span>`:'';
    return `<label class="tsel-item"><input type="${multi?'checkbox':'radio'}" ${multi?`class="${cls}"`:`name="${mode}topic"`} data-id="${t.id}" ${i===0?'checked':''}><span class="tsel-name" title="${esc(t.name)}">${esc(t.name.replace(/\.[^.]+$/,''))}</span><span class="tsel-tag ${t.type}">${t.type.toUpperCase()}</span>${t.imageCount?`<span class="fimg-badge" style="margin-left:2px">📷${t.imageCount}</span>`:''}${tblBadge}${big}</label>`;
  }).join('');
  el.querySelectorAll('input').forEach(inp=>inp.addEventListener('change',()=>refreshUI()));
}

function getSelected(mode){
  if(mode==='sum')return Array.from(document.querySelectorAll('.sch:checked')).map(c=>c.dataset.id);
  if(mode==='maq')return Array.from(document.querySelectorAll('.mch:checked')).map(c=>c.dataset.id);
  const r=document.querySelector(`input[name="${mode}topic"]:checked`);
  return r?[r.dataset.id]:topics.length?[topics[0].id]:[];
}
function selAll(mode,val){
  const cls = mode==='sum' ? '.sch' : '.mch';
  document.querySelectorAll(cls).forEach(c=>c.checked=val);
  refreshUI(mode==='sum'?'s':'ma');
}
function clearAll(){topics=[];qResults=[];maqResults=[];renderTopics();refreshUI();['q','s','m','ma'].forEach(t=>{if($(`${t}-results`))$(`${t}-results`).style.display='none';});}

const dz=$('dz'),fi=$('fi');
dz.onclick=()=>fi.click();
dz.ondragover=e=>{e.preventDefault();dz.classList.add('over');};
dz.ondragleave=()=>dz.classList.remove('over');
dz.ondrop=e=>{e.preventDefault();dz.classList.remove('over');doUpload(e.dataTransfer.files);};
fi.onchange=e=>{doUpload(e.target.files);e.target.value='';};

async function doUpload(fileList){
  const valid=Array.from(fileList).filter(f=>/\.(docx?|pdf)$/i.test(f.name));
  if(!valid.length){showErr('q','Solo se aceptan .docx y .pdf');return;}
  if(topics.length+valid.length>100){showErr('q','Máximo 100 documentos');return;}
  dz.querySelector('.drop-lbl').textContent='Subiendo y extrayendo contenido...';
  const form=new FormData();valid.forEach(f=>form.append('files',f));
  try{
    const res=await fetch('/api/upload',{method:'POST',body:form});
    const data=await res.json();
    if(!data.success)throw new Error(data.error);
    topics=[...topics,...data.topics];
    renderTopics();refreshUI();
  }catch(e){showErr('q','Error: '+e.message);}
  dz.querySelector('.drop-lbl').textContent='Arrastra archivos aquí';
}

async function readSSE(url,body,onEvent){
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const reader=res.body.getReader();
  const dec=new TextDecoder();
  let buf='';
  while(true){
    const{done,value}=await reader.read();
    if(done)break;
    buf+=dec.decode(value,{stream:true});
    const lines=buf.split('\n');
    buf=lines.pop();
    for(const line of lines){
      if(!line.startsWith('data:'))continue;
      try{onEvent(JSON.parse(line.slice(5).trim()));}catch(_){}
    }
  }
}

// ── Preguntas ─────────────────────────────────────────────────────────────────
async function genSample(){
  if(!topics.length||busy)return;
  $('sampleLoading').style.display='flex';$('sampleResult').style.display='none';$('btnSample').disabled=true;
  const t=topics[0];
  try{
    await readSSE('/api/generate',{topicIds:[t.id],config:{...cfg,numQ:1,generationMode:'pertopic',typeMode:cfg.typeMode==='mix'?'practico':cfg.typeMode,diffMode:'single',diffSingle:cfg.diffSingle,polarityMode:cfg.polarityMode==='mix'?'positive':cfg.polarityMode,extraCtx:$('extraCtx').value}},ev=>{
      if(ev.type==='topic_result'){
        $('sampleBox').innerHTML=ev.text.split('\n').map(l=>l.startsWith('ANSWER:')?`<span class="l-ans">${esc(l)}</span>`:esc(l)).join('\n');
        $('sampleResult').style.display='block';
      }
    });
  }catch(e){showErr('q','Error: '+e.message);}
  $('sampleLoading').style.display='none';$('btnSample').disabled=false;
}

async function genQuestions(){
  if(!topics.length||busy)return;busy=true;qResults=[];showPanel('q','progress');
  const tl=$('topicList');tl.innerHTML='';
  const tEls={};
  topics.forEach(t=>{
    const div=document.createElement('div');
    div.className='tp wait';div.id=`tp-${t.id}`;
    div.innerHTML=`<span class="tp-ico">○</span><span class="tp-name">${esc(t.name.replace(/\.[^.]+$/,''))}</span><span class="tp-n">${getQPerTopic(topics.indexOf(t))} preg.</span>`;
    tl.appendChild(div);tEls[t.id]=div;
  });
  try{
    await readSSE('/api/generate',{topicIds:topics.map(t=>t.id),config:{...cfg,generationMode:cfg.qMode,extraCtx:$('extraCtx').value}},ev=>{
      if(ev.type==='topic_start'){const el=tEls[topics[ev.ti]?.id];if(el){el.className='tp act';el.querySelector('.tp-ico').innerHTML='<span class="spin">⟳</span>';}}
      if(ev.type==='batch'){$('progBar').style.width=ev.pct+'%';$('progPct').textContent=ev.pct+'%';$('progLbl').textContent=ev.label;}
      if(ev.type==='topic_result'){
        qResults.push({name:ev.name,text:ev.text,count:ev.count});
        const el=tEls[topics[ev.ti]?.id];
        if(el){el.className='tp done';el.querySelector('.tp-ico').textContent='✓';el.querySelector('.tp-n').textContent=ev.count+' preg.';}
      }
      if(ev.type==='error'){showErr('q','Error: '+ev.message);showPanel('q','actions');}
      if(ev.type==='complete'){
        renderQResults();showPanel('q','results');
        // Guardar en historial
        const total=qResults.reduce((s,r)=>s+r.count,0);
        const titleTxt=qResults.length===1?qResults[0].name.replace(/\.[^.]+$/,''):`${qResults.length} temas · ${total} preguntas`;
        saveToHistory('questions',titleTxt,{total,topics:qResults.length,numOpts:cfg.numOpts,polarity:cfg.polarityMode,difficulty:cfg.diffMode==='single'?cfg.diffSingle:'mixta',type:cfg.typeMode,penalty:cfg.penalty},{qResults,config:{...cfg}});
      }
    });
  }catch(e){showErr('q','Error: '+e.message);showPanel('q','actions');}
  busy=false;
}

function renderQResults(){
  const total=qResults.reduce((s,r)=>s+r.count,0);
  const polIco=cfg.polarityMode==='positive'?'+':cfg.polarityMode==='negative'?'−':'±';
  $('qStats').innerHTML=`<div class="stat"><div class="stat-n">${total}</div><div class="stat-l">Preguntas</div></div><div class="stat"><div class="stat-n">${qResults.length}</div><div class="stat-l">Temas</div></div><div class="stat"><div class="stat-n">${cfg.numOpts}</div><div class="stat-l">Opciones</div></div><div class="stat"><div class="stat-n">${polIco}</div><div class="stat-l">Formulación</div></div><div class="stat"><div class="stat-n">${{none:'0',third:'-⅓',half:'-½',full:'-1'}[cfg.penalty]}</div><div class="stat-l">Penaliz.</div></div>`;
  const bar=$('qTabBar');bar.innerHTML='';
  qResults.forEach((r,i)=>{
    const b=document.createElement('button');b.className='rtab'+(i===0?' on':'');
    b.textContent=r.name.replace(/\.[^.]+$/,'');
    b.onclick=()=>{qActiveTab=i;Array.from(bar.children).forEach((x,j)=>x.classList.toggle('on',j===i));showQContent(i);};
    bar.appendChild(b);
  });
  if(qResults.length>1){
    const b=document.createElement('button');b.className='rtab';b.textContent='📄 Combinado';
    const idx=qResults.length;
    b.onclick=()=>{qActiveTab=idx;Array.from(bar.children).forEach((x,j)=>x.classList.toggle('on',j===idx));showQContent(idx);};
    bar.appendChild(b);
  }
  showQContent(0);
}
function buildCombined(){return qResults.map(r=>`$CATEGORY: ${r.name.replace(/\.[^.]+$/,'')}\n\n${r.text}`).join('\n\n');}
function showQContent(idx){
  const isCombo=idx===qResults.length;
  const text=isCombo?buildCombined():(qResults[idx]||qResults[0]).text;
  $('qPreview').innerHTML=text.split('\n').map(l=>{
    if(l.startsWith('ANSWER:'))return`<span class="l-ans">${esc(l)}</span>`;
    if(l.startsWith('$CATEGORY'))return`<span class="l-cat">${esc(l)}</span>`;
    return esc(l);
  }).join('\n');
  const dl=$('qDl');dl.innerHTML='';
  if(isCombo){
    addDl(dl,'↓ Aiken combinado',()=>dlTxt(buildCombined(),'banco_completo_aiken.txt'));
    addGift(dl,'↓ GIFT combinado',()=>dlTxt(aikenToGift(buildCombined(),cfg.penalty),'banco_completo.gift'));
  }else{
    const r=qResults[idx]||qResults[0];const safe=safeName(r.name);
    addDl(dl,`↓ Aiken: ${safe}.txt`,()=>dlTxt(r.text,`${safe}_aiken.txt`));
    addGift(dl,`↓ GIFT: ${safe}.gift`,()=>dlTxt(aikenToGift(r.text,cfg.penalty),`${safe}.gift`));
    if(qResults.length>1&&cfg.expMode==='unico')addDl(dl,'↓ Aiken único',()=>dlTxt(buildCombined(),'banco_aiken.txt'));
  }
  if(qResults.length>1&&cfg.expMode!=='unico')addDlZip(dl,`↓ ZIP (${qResults.length} temas)`,dlZipAll);
  if(qResults.length===1){
    addDl(dl,'↓ Aiken .txt',()=>dlTxt(qResults[0].text,'banco_preguntas_aiken.txt'));
    addGift(dl,'↓ GIFT (con pen.)',()=>dlTxt(aikenToGift(qResults[0].text,cfg.penalty),'banco_preguntas.gift'));
  }
  if(moo.connected&&moo.selectedCourse)$('btnMooImport').disabled=false;
}

function aikenToGift(aikenText,penalty){
  const pm={none:null,third:-33.33333,half:-50,full:-100};const pp=pm[penalty];
  function escG(s){return s.replace(/([~={#}:])/g,'\\$1');}
  const lines=aikenText.split('\n');
  let out='// GIFT — Suite Académica Moodle v8.1\n// Penalización: '+penalty+'\n\n';
  let i=0,qn=0;
  while(i<lines.length){
    const line=lines[i].trim();
    if(line.startsWith('$CATEGORY:')){out+=line+'\n\n';i++;continue;}
    if(!line||/^[A-E]\.\s/.test(line)||line.startsWith('ANSWER:')){i++;continue;}
    const ql=[];
    while(i<lines.length&&!/^[A-E]\.\s/.test(lines[i].trim())&&!lines[i].trim().startsWith('ANSWER:')&&lines[i].trim()){ql.push(lines[i].trim());i++;}
    const qt=ql.join(' ');if(!qt)continue;
    const opts=[];
    while(i<lines.length&&/^[A-E]\.\s/.test(lines[i].trim())){const o=lines[i].trim();opts.push({letter:o[0],text:o.substring(3).trim()});i++;}
    let corr='';
    if(i<lines.length&&lines[i].trim().startsWith('ANSWER:')){corr=lines[i].trim().replace('ANSWER:','').trim();i++;}
    if(!qt||!opts.length||!corr)continue;
    qn++;
    out+=`::P${qn}::${escG(qt)} {\n`;
    for(const o of opts){
      const t=escG(o.text);
      if(o.letter===corr)out+=`  =${t}\n`;
      else out+=pp!==null?`  ~%${pp}%${t}\n`:`  ~${t}\n`;
    }
    out+='}\n\n';
  }
  return out;
}
async function dlZipAll(){
  const files=qResults.map(r=>({name:`${safeName(r.name)}_aiken.txt`,content:r.text}));
  files.push({name:'banco_completo_aiken.txt',content:buildCombined()});
  files.push({name:'banco_completo.gift',content:aikenToGift(buildCombined(),cfg.penalty)});
  await dlZip(files,'banco_preguntas.zip');
}
function resetQ(){qResults=[];showPanel('q','actions');refreshUI();}

// ── Moodle ────────────────────────────────────────────────────────────────────
async function mooTest(){
  const url=$('mooUrl').value.trim(), token=$('mooToken').value.trim();
  if(!url||!token){$('mooConnStatus').innerHTML='<div class="moo-status err">Introduce la URL y el token.</div>';return;}
  $('mooConnStatus').innerHTML='<div class="moo-status info"><span class="spin">⟳</span> Conectando con Moodle...</div>';
  try{
    const res=await fetch('/api/moodle/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,token})});
    const data=await res.json();
    if(!data.success)throw new Error(data.error);
    moo.connected=true;moo.url=url;moo.token=token;moo.userid=data.userid;
    $('mooConnStatus').innerHTML='';$('mooSiteName').textContent=`${data.sitename} (${data.username}) · ${data.release}`;
    $('mooCourseSection').style.display='block';
    await mooLoadCourses();
  }catch(e){$('mooConnStatus').innerHTML=`<div class="moo-status err">Error: ${esc(e.message)}</div>`;}
}
async function mooLoadCourses(){
  $('mooCourseSelect').innerHTML='<option value="">Cargando cursos...</option>';
  try{
    const res=await fetch('/api/moodle/courses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:moo.url,token:moo.token,userid:moo.userid})});
    const data=await res.json();
    if(!data.success)throw new Error(data.error);
    moo.courses=data.courses;
    $('mooCourseSelect').innerHTML='<option value="">-- Seleccionar curso --</option>'+data.courses.map(c=>`<option value="${c.id}">[${esc(c.shortname)}] ${esc(c.fullname)}</option>`).join('');
    $('mooCourseSelect').onchange=()=>{moo.selectedCourse=+$('mooCourseSelect').value||null;$('btnMooImport').disabled=!moo.selectedCourse||!qResults.length;};
  }catch(e){$('mooCourseSelect').innerHTML='<option value="">Error cargando cursos</option>';}
}
async function mooImport(){
  if(!moo.connected||!moo.selectedCourse||!qResults.length)return;
  $('btnMooImport').disabled=true;
  $('mooImportStatus').innerHTML='<div class="moo-status info"><span class="spin">⟳</span> Subiendo banco de preguntas a Moodle...</div>';
  try{
    const giftContent=aikenToGift(buildCombined(),cfg.penalty);
    const course=moo.courses.find(c=>c.id===moo.selectedCourse);
    const filename=(course?.shortname||'banco').replace(/[^a-zA-Z0-9_]/g,'_');
    const res=await fetch('/api/moodle/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:moo.url,token:moo.token,courseid:moo.selectedCourse,giftContent,filename})});
    const data=await res.json();
    if(!res.ok||!data.success)throw new Error(data.error);
    const icon=data.method==='direct'?'✓':'📁';
    $('mooImportStatus').innerHTML=`<div class="moo-status ok">${icon} ${esc(data.message)}</div>`;
  }catch(e){$('mooImportStatus').innerHTML=`<div class="moo-status err">Error: ${esc(e.message)}</div>`;}
  $('btnMooImport').disabled=false;
}
function mooDisconnect(){moo={connected:false,url:'',token:'',userid:null,courses:[],selectedCourse:null};$('mooCourseSection').style.display='none';$('mooConnStatus').innerHTML='';$('mooImportStatus').innerHTML='';$('mooCourseSelect').innerHTML='<option value="">-- Seleccionar curso --</option>';$('mooUrl').value='';$('mooToken').value='';}

// ── Resúmenes ─────────────────────────────────────────────────────────────────
async function genSummaries(){
  const selIds=getSelected('sum');if(!selIds.length||busy)return;
  busy=true;showPanel('s','progress');
  const results=[];
  try{
    await readSSE('/api/summarize',{topicIds:selIds,pages:cfg.pages},ev=>{
      if(ev.type==='progress'){const pct=Math.round((ev.current-1)/ev.total*100);$('sumBar').style.width=pct+'%';$('sumLbl').textContent=`Resumiendo "${ev.name.replace(/\.[^.]+$/,'')}" (${ev.current}/${ev.total})...`;}
      if(ev.type==='result'){results.push(ev);}
      if(ev.type==='error'){showErr('s','Error: '+ev.message);showPanel('s','actions');}
      if(ev.type==='complete'){
        $('sumBar').style.width='100%';
        renderSumResults(results);showPanel('s','results');
        // Historial
        const titleTxt=results.length===1?results[0].name.replace(/\.[^.]+$/,''):`${results.length} resúmenes`;
        saveToHistory('summary',titleTxt,{count:results.length,pages:cfg.pages,totalWords:results.reduce((s,r)=>s+(r.wordCount||0),0)},{results});
      }
    });
  }catch(e){showErr('s','Error: '+e.message);showPanel('s','actions');}
  busy=false;
}
function renderSumResults(results){
  const el=$('s-results');el.innerHTML='';
  results.forEach((r,i)=>{
    const safe=safeName(r.name);
    const d=document.createElement('div');d.className='sum-card';
    d.innerHTML=`<div class="card-title">${esc(r.name.replace(/\.[^.]+$/,''))}</div><div class="dl-row" style="margin-bottom:.75rem"><span style="font-size:12px;color:var(--txt2);align-self:center">${(r.wordCount||0).toLocaleString()} palabras · ~${Math.round((r.wordCount||0)/480)} pág.</span><button class="btn-dl" data-i="${i}">↓ Texto .txt</button><button class="btn-word" data-wi="${i}">↓ Word .docx</button></div><div class="sum-preview">${esc(r.text)}</div>`;
    d.querySelector('.btn-dl').onclick=()=>dlTxt(results[i].text,`resumen_${safe}.txt`);
    d.querySelector('.btn-word').onclick=()=>dlSummaryDocx(results[i]);
    el.appendChild(d);
  });
  if(results.length>1){
    const d=document.createElement('div');
    d.style.cssText='margin-top:.5rem;display:flex;gap:8px';
    d.innerHTML=`<button class="btn-dlz">↓ ZIP (.txt)</button><button class="btn-word" style="flex:none">↓ ZIP (.docx)</button>`;
    d.querySelector('.btn-dlz').onclick=()=>dlZip(results.map(r=>({name:`resumen_${safeName(r.name)}.txt`,content:r.text})),'resumenes.zip');
    d.querySelector('.btn-word').onclick=async()=>{
      const blobs=await Promise.all(results.map(r=>fetch('/api/summary-docx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:r.name,text:r.text})}).then(res=>res.blob()).then(b=>b.arrayBuffer()).then(buf=>({name:`resumen_${safeName(r.name)}.docx`,content:Array.from(new Uint8Array(buf))}))));
      await dlZip(blobs,'resumenes_word.zip');
    };
    el.appendChild(d);
  }
}
async function dlSummaryDocx(r){
  try{
    const res=await fetch('/api/summary-docx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:r.name,text:r.text})});
    if(!res.ok)throw new Error('Error del servidor');
    const blob=await res.blob();const u=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=u;a.download=`resumen_${safeName(r.name)}.docx`;a.click();URL.revokeObjectURL(u);
  }catch(e){showErr('s','Error generando Word: '+e.message);}
}

// ── Mapas ─────────────────────────────────────────────────────────────────────
function setMapStyle(s){cfg.mapStyle=s;$('msRad').classList.toggle('on',s==='radial');$('msNov').classList.toggle('on',s==='novak');$('styleHint').textContent=s==='novak'?'Mapa Novak: conceptos + frases de enlace + cross-links.':'Mapa radial: centro → ramas → subnodos.';refreshUI('m');}
async function genMap(){
  const selIds=getSelected('map');if(!selIds.length||busy)return;
  busy=true;mapSVG='';showPanel('m','progress');
  try{
    const res=await fetch('/api/map',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topicId:selIds[0],depth:cfg.mapDepth,style:cfg.mapStyle})});
    const data=await res.json();
    if(!data.success)throw new Error(data.error);
    const result=data.style==='novak'?buildNovakSVG(data.data):buildMapSVG(data.data);
    mapSVG=result.svg;mapW=result.width;mapH=result.height;
    $('mapWrap').innerHTML=mapSVG;showPanel('m','results');
    // Historial (compatible con ambos estilos)
    const tp=topics.find(t=>t.id===selIds[0]);
    const histMeta=data.style==='novak'
      ? {depth:cfg.mapDepth,style:'novak',concepts:data.data.concepts.length,propositions:data.data.propositions.length}
      : {depth:cfg.mapDepth,style:'radial',branches:data.data.branches.length};
    saveToHistory('map',data.data.title||(tp?tp.name.replace(/\.[^.]+$/,''):'Mapa'),histMeta,{mapData:data.data,mapStyle:data.style,svg:mapSVG,width:mapW,height:mapH});
  }catch(e){showErr('m','Error: '+e.message);showPanel('m','actions');}
  busy=false;
}
function buildMapSVG(data){
  const PAD=40,RW=130,RH=52,BW=155,BH=38,NW=205,NH=30,SLOT=46,GCOL=70;
  const C=MAP_COLORS;
  const total=data.branches.reduce((s,b)=>s+(b.nodes?.length||1),0);
  const H=Math.max(total*SLOT+PAD*2,320);
  const W=PAD+RW+GCOL+BW+GCOL+NW+PAD;
  const rX=PAD+RW/2,rY=H/2,bX=PAD+RW+GCOL+BW/2,nX=PAD+RW+GCOL+BW+GCOL+NW/2;
  let cy=PAD;
  data.branches.forEach((b,bi)=>{const cnt=b.nodes?.length||1;b._y=cy+cnt*SLOT/2;b._c=C[bi%C.length];b._ny=(b.nodes||[]).map((_,ni)=>cy+SLOT*ni+SLOT/2);cy+=cnt*SLOT;});
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="white"/>`;
  data.branches.forEach(b=>{
    svg+=bz(rX+RW/2,rY,bX-BW/2,b._y,b._c.s,2);
    (b.nodes||[]).forEach((_,ni)=>{svg+=bz(bX+BW/2,b._y,nX-NW/2,b._ny[ni],b._c.s,1.3);});
    svg+=rbox(bX,b._y,BW,BH,7,b._c.bg,b._c.s,b.label,b._c.t,12,500);
    (b.nodes||[]).forEach((node,ni)=>{svg+=rbox(nX,b._ny[ni],NW,NH,5,'white',b._c.s+'99',node,'#1a1917',11,400);});
  });
  svg+=rbox(rX,rY,RW,RH,9,'#1a1917','#1a1917',data.title,'white',12,600);
  return{svg:svg+'</svg>',width:W,height:H};
}

// ── Render Novak: conceptos + frases de enlace compartidas + cross-links ─────
function buildNovakSVG(data){
  const concepts=data.concepts||[];
  const props=(data.propositions||[]).filter(p=>p&&p.from&&p.to&&p.phrase);
  if(!concepts.length)return{svg:'<svg></svg>',width:0,height:0};

  const PAL=[
    {bg:'#1a1917',t:'#fff',s:'#1a1917'},        // nivel 0 (raíz oscura)
    {bg:'#e1f5ee',t:'#04342C',s:'#085041'},     // nivel 1 (verde)
    {bg:'#e6f1fb',t:'#042C53',s:'#185FA5'},     // nivel 2 (azul)
    {bg:'#faeeda',t:'#412402',s:'#854F0B'},     // nivel 3+ (ámbar)
    {bg:'#EEEDFE',t:'#26215C',s:'#534AB7'},     // nivel 4 (violeta)
  ];
  function boxSize(lv){if(lv===0)return{w:210,h:62};if(lv===1)return{w:160,h:54};return{w:140,h:44};}

  const byLevel={};
  concepts.forEach(c=>{const lv=Math.max(0,Math.min(c.level??0,4));(byLevel[lv]=byLevel[lv]||[]).push({...c,level:lv});});
  const levels=Object.keys(byLevel).map(Number).sort((a,b)=>a-b);
  function parentOf(id){const e=props.find(p=>p.to===id);return e?e.from:null;}
  levels.forEach(lv=>{if(lv===0)return;byLevel[lv].sort((a,b)=>{const pa=parentOf(a.id)||'',pb=parentOf(b.id)||'';return pa.localeCompare(pb);});});

  const PAD_X=40,PAD_Y=40,GAP_X=28,GAP_Y=145;
  const levelWidths={};
  levels.forEach(lv=>{const items=byLevel[lv];levelWidths[lv]=items.reduce((s,c)=>s+boxSize(c.level).w,0)+(items.length-1)*GAP_X;});
  const W=Math.max(...Object.values(levelWidths),600)+PAD_X*2;
  const H=levels.length*GAP_Y+PAD_Y*2;

  const pos={};
  levels.forEach((lv,lvIdx)=>{
    const items=byLevel[lv];
    const totalW=levelWidths[lv];
    let x=(W-totalW)/2;
    const y=PAD_Y+lvIdx*GAP_Y;
    items.forEach(c=>{const sz=boxSize(c.level);pos[c.id]={x:x+sz.w/2,y:y+sz.h/2,w:sz.w,h:sz.h,level:c.level};x+=sz.w+GAP_X;});
  });

  function wrap(phrase,maxC,maxLines){
    if(phrase.length<=maxC)return[phrase];
    const words=phrase.split(' '),lines=[];
    let i=0;
    while(i<words.length&&lines.length<maxLines-1){
      let line='';
      while(i<words.length){
        const cand=line?line+' '+words[i]:words[i];
        if(cand.length>maxC&&line)break;
        line=cand; i++;
      }
      lines.push(line);
    }
    let last=words.slice(i).join(' ');
    if(last){if(last.length>maxC)last=last.substring(0,maxC-1)+'…';lines.push(last);}
    for(let j=0;j<lines.length;j++)if(lines[j].length>maxC)lines[j]=lines[j].substring(0,maxC-1)+'…';
    return lines;
  }

  // Agrupar proposiciones por (origen, frase) — una pastilla con flechas en abanico
  const groups=new Map();
  props.forEach(p=>{
    const key=p.from+'\u0001'+(p.phrase||'').trim();
    if(!groups.has(key))groups.set(key,{from:p.from,phrase:p.phrase,tos:[]});
    if(!groups.get(key).tos.includes(p.to))groups.get(key).tos.push(p.to);
  });

  let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Segoe UI',system-ui,sans-serif"><rect width="${W}" height="${H}" fill="white"/>`;
  svg+=`<defs><marker id="arrN" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#5c5a55"/></marker></defs>`;

  groups.forEach(g=>{
    const a=pos[g.from];
    const targets=g.tos.map(id=>pos[id]).filter(Boolean);
    if(!a||!targets.length)return;
    const phrase=(g.phrase||'').trim();
    const FS=10.5,LH=FS+2,CHARW=FS*0.55;

    // Cross-link (1 destino, mismo nivel)
    if(targets.length===1&&a.level===targets[0].level){
      const b=targets[0];
      const goRight=a.x<b.x;
      const x1=a.x+(goRight?a.w/2:-a.w/2),y1=a.y;
      const x2=b.x+(goRight?-b.w/2:b.w/2),y2=b.y;
      const mx=(x1+x2)/2,my=y1-26;
      svg+=`<path d="M${x1},${y1} Q${mx},${my} ${x2},${y2}" fill="none" stroke="#5c5a55" stroke-width="1.2" opacity="0.65" stroke-dasharray="4 3" marker-end="url(#arrN)"/>`;
      if(phrase){
        const maxC=Math.max(14,Math.floor((Math.max(230,Math.abs(x2-x1)*0.8)-14)/CHARW));
        const lines=wrap(phrase,maxC,2);
        const realCh=Math.max(...lines.map(l=>l.length));
        const tw=realCh*CHARW+14,th=lines.length*LH+6;
        svg+=`<rect x="${mx-tw/2}" y="${my-th/2}" width="${tw}" height="${th}" rx="9" fill="#fff" stroke="#5c5a55" stroke-width="0.8" opacity="0.97"/>`;
        const sY=my-(lines.length-1)*LH/2;
        lines.forEach((ln,i)=>svg+=`<text x="${mx}" y="${sY+i*LH}" text-anchor="middle" dominant-baseline="central" font-size="${FS}" fill="#1a1917" font-style="italic">${esc(ln)}</text>`);
      }
      return;
    }

    // Jerárquico: pastilla compartida + flechas en abanico
    const cx=targets.reduce((s,t)=>s+t.x,0)/targets.length;
    const tTopY=targets.reduce((s,t)=>s+(t.y-t.h/2),0)/targets.length;
    const px=cx;
    const py=(a.y+a.h/2+tTopY)/2;

    let tw=0,th=0,phraseLines=[];
    if(phrase){
      const minTx=Math.min(...targets.map(t=>t.x));
      const maxTx=Math.max(...targets.map(t=>t.x));
      const span=Math.max(240,(maxTx-minTx)*0.85,Math.abs(a.x-cx)*1.1);
      const maxC=Math.max(16,Math.floor((span-14)/CHARW));
      phraseLines=wrap(phrase,maxC,2);
      const realCh=Math.max(...phraseLines.map(l=>l.length));
      tw=realCh*CHARW+14;
      th=phraseLines.length*LH+6;
    }

    // Origen → top de la pastilla
    const sx=a.x,sy=a.y+a.h/2;
    const pTop=py-th/2;
    const cy1=sy+(pTop-sy)*0.55;
    svg+=`<path d="M${sx},${sy} C${sx},${cy1} ${px},${pTop-6} ${px},${pTop}" fill="none" stroke="#5c5a55" stroke-width="1.3" opacity="0.7"/>`;

    // Pastilla con texto
    if(phrase){
      svg+=`<rect x="${px-tw/2}" y="${py-th/2}" width="${tw}" height="${th}" rx="9" fill="#fff" stroke="#5c5a55" stroke-width="0.8" opacity="0.97"/>`;
      const sY=py-(phraseLines.length-1)*LH/2;
      phraseLines.forEach((ln,i)=>svg+=`<text x="${px}" y="${sY+i*LH}" text-anchor="middle" dominant-baseline="central" font-size="${FS}" fill="#1a1917" font-style="italic">${esc(ln)}</text>`);
    }

    // Pastilla → cada destino
    const pBot=py+th/2;
    targets.forEach(b=>{
      const bx=b.x,by=b.y-b.h/2;
      const cyb=pBot+(by-pBot)*0.55;
      svg+=`<path d="M${px},${pBot} C${px},${pBot+6} ${bx},${cyb} ${bx},${by}" fill="none" stroke="#5c5a55" stroke-width="1.3" opacity="0.7" marker-end="url(#arrN)"/>`;
    });
  });

  // Conceptos encima
  concepts.forEach(c=>{
    const p=pos[c.id];if(!p)return;
    const palette=PAL[Math.min(c.level??0,PAL.length-1)];
    const x=p.x-p.w/2,y=p.y-p.h/2;
    const fs=c.level===0?12.5:(c.level===1?12:11);
    const fw=c.level===0?700:(c.level===1?600:500);
    const rad=c.level===0?12:8;
    const sw=c.level===0?1.8:1.2;
    svg+=`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" rx="${rad}" fill="${palette.bg}" stroke="${palette.s}" stroke-width="${sw}"/>`;
    const maxC=Math.floor((p.w-12)/(fs*0.52));
    const text=(c.text||'').replace(/\\n/g,'\n');
    const rawLines=text.split('\n');
    const lines=[];
    rawLines.forEach(rl=>{
      if(rl.length<=maxC){lines.push(rl);return;}
      const words=rl.split(' ');let cur='';
      words.forEach(w=>{const t=cur?cur+' '+w:w;if(t.length>maxC&&cur){lines.push(cur);cur=w;}else cur=t;});
      if(cur)lines.push(cur);
    });
    const lh=fs+2;
    const startY=p.y-(lines.length-1)*lh/2;
    lines.forEach((ln,i)=>{
      svg+=`<text x="${p.x}" y="${startY+i*lh}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" font-weight="${fw}" fill="${palette.t}">${esc(ln)}</text>`;
    });
  });

  svg+=`</svg>`;
  return{svg,width:W,height:H};
}
function bz(x1,y1,x2,y2,c,w){const mx=(x1+x2)/2;return`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${c}" stroke-width="${w}" opacity="0.45"/>`;}
function rbox(cx,cy,w,h,r,fill,stroke,label,tc,fs,fw){
  const x=cx-w/2,y=cy-h/2;
  let s=`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;
  const maxC=Math.floor((w-14)/(fs*0.52));
  const words=label.split(' ');const lines=[];let cur='';
  words.forEach(word=>{const test=(cur?cur+' ':'')+word;if(test.length>maxC&&cur){lines.push(cur);cur=word;}else cur=test;});
  if(cur)lines.push(cur);
  const lh=fs+2,tot=lines.length*lh,sy=cy-tot/2+lh/2;
  lines.forEach((ln,i)=>{s+=`<text x="${cx}" y="${sy+i*lh}" text-anchor="middle" dominant-baseline="middle" fill="${tc}" font-size="${fs}" font-weight="${fw}" font-family="'Segoe UI',system-ui,sans-serif">${esc(ln)}</text>`;});
  return s;
}
async function svgToPng(){return new Promise(res=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=mapW*2;c.height=mapH*2;const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,c.width,c.height);ctx.scale(2,2);ctx.drawImage(img,0,0);res(c.toDataURL('image/png'));};img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(mapSVG);});}
async function dlMapPng(){if(!mapSVG)return;const png=await svgToPng();const a=document.createElement('a');a.href=png;a.download='mapa_conceptual.png';a.click();}
async function dlMapPdf(){if(!mapSVG)return;const png=await svgToPng();const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';s.onload=()=>{const{jsPDF}=window.jspdf;const orient=mapW>mapH?'landscape':'portrait';const pdf=new jsPDF({orientation:orient,unit:'px',format:[mapW,mapH]});pdf.addImage(png,'PNG',0,0,mapW,mapH);pdf.save('mapa_conceptual.pdf');};document.head.appendChild(s);}
function dlMapSvg(){if(!mapSVG)return;dlTxt(mapSVG,'mapa_conceptual.svg');}

// ── Maquetación (multi-documento + SSE con chunking paralelo) ────────────────
async function genMaqueta(){
  const selIds=getSelected('maq');if(!selIds.length||busy)return;
  busy=true;
  maqResults=[]; // [{topicId, name, data, stats, hasImages, hasTables, quiz}]
  showPanel('ma','progress');
  $('maProgBar').style.width='0%';$('maProgPct').textContent='0%';
  $('maProgLbl').textContent='Iniciando...';
  // Lista de progreso por documento
  const list=$('maTopicList');list.innerHTML='';
  const tEls={};
  selIds.forEach(id=>{
    const tp=topics.find(t=>t.id===id);if(!tp)return;
    const div=document.createElement('div');
    div.className='tp wait';div.id=`mt-${id}`;
    div.innerHTML=`<span class="tp-ico">○</span><span class="tp-name">${esc(tp.name.replace(/\.[^.]+$/,''))}</span><span class="tp-n">en cola</span>`;
    list.appendChild(div);tEls[id]=div;
  });

  try{
    await readSSE('/api/maqueta-batch',{topicIds:selIds},async ev=>{
      if(ev.type==='batch_start'){
        $('maProgLbl').textContent=`Maquetando ${ev.total} documento${ev.total!==1?'s':''}...`;
      }
      if(ev.type==='topic_start'){
        const id=selIds[ev.ti];const el=tEls[id];
        if(el){el.className='tp act';el.querySelector('.tp-ico').innerHTML='<span class="spin">⟳</span>';el.querySelector('.tp-n').textContent='procesando...';}
        $('maProgLbl').textContent=`Documento ${ev.ti+1}/${ev.total}: "${ev.name.replace(/\.[^.]+$/,'')}"`;
        const pct=Math.round((ev.ti/ev.total)*100);
        $('maProgBar').style.width=pct+'%';$('maProgPct').textContent=pct+'%';
      }
      if(ev.type==='topic_progress'){
        const id=selIds[ev.ti];const el=tEls[id];
        if(el){el.querySelector('.tp-n').textContent=ev.label||'';}
      }
      if(ev.type==='topic_complete'){
        const id=selIds[ev.ti];const el=tEls[id];
        const st=ev.stats||{};
        const titles=(st.h1||0)+(st.h2||0)+(st.h3||0);
        const ic=st.img||0,tc=st.table||0;
        if(el){el.className='tp done';el.querySelector('.tp-ico').textContent='✓';el.querySelector('.tp-n').textContent=`${titles} tít · ${st.p||0} párr · ${ic} img · ${tc} tablas`;}
        const tp=topics.find(t=>t.id===id);
        const result={topicId:id, name:ev.name, data:ev.data, stats:st, hasImages:ev.hasImages, hasTables:ev.hasTables, quiz:null, topicWords:tp?.words};
        maqResults.push(result);
        // Si el quiz está activo, generamos en paralelo (no bloquea siguiente doc)
        if(cfg.maqQuizEnabled){generateMaqQuizFor(result).catch(()=>{});}
      }
      if(ev.type==='topic_error'){
        const id=selIds[ev.ti];const el=tEls[id];
        if(el){el.className='tp wait';el.querySelector('.tp-ico').textContent='✗';el.querySelector('.tp-n').textContent='error: '+ev.message;el.style.color='var(--r)';}
      }
      if(ev.type==='batch_complete'){
        $('maProgBar').style.width='100%';$('maProgPct').textContent='100%';
        $('maProgLbl').textContent='Completado.';
        renderMaResults();
        showPanel('ma','results');
        // Historial
        try{
          for(const r of maqResults){
            const tp=topics.find(t=>t.id===r.topicId);
            const st=r.stats||{};
            const h1c=st.h1||0,h2c=st.h2||0,h3c=st.h3||0,pc=st.p||0,lc=(st.ul||0)+(st.ol||0),ic=st.img||0,tc=st.table||0;
            saveToHistory('maqueta',r.data.title||(tp?tp.name.replace(/\.[^.]+$/,''):'Documento'),
              {titles:h1c+h2c+h3c,paragraphs:pc,lists:lc,images:ic,tables:tc,topicName:tp?.name||null,
               quiz:cfg.maqQuizEnabled?{type:cfg.maqQuizType,num:cfg.maqQuizNum,diff:cfg.maqQuizDiff,dist:cfg.maqQuizDist}:null},
              {data:r.data,topicId:r.topicId});
          }
        }catch(_){}
      }
      if(ev.type==='error'){showErr('ma','Error: '+ev.message);showPanel('ma','actions');}
    });
  }catch(e){showErr('ma','Error: '+e.message);showPanel('ma','actions');}
  busy=false;
}

function renderMaResults(){
  const banner=$('maQuizBanner');
  if(cfg.maqQuizEnabled){
    banner.style.display='block';
    const tipoLbl=cfg.maqQuizType==='vf'?'V/F':cfg.maqQuizType==='3opt'?'3 opciones':'4 opciones';
    const distLbl=cfg.maqQuizDist==='inline'?'distribuidas en el texto':'al final del documento';
    banner.innerHTML=`<span class="spin">⟳</span> Generando autoevaluación (${cfg.maqQuizNum} preguntas · ${tipoLbl} · ${distLbl})...`;
  } else {
    banner.style.display='none';
  }
  $('maBatchSummary').innerHTML=`<strong>${maqResults.length}</strong> documento${maqResults.length!==1?'s':''} maquetado${maqResults.length!==1?'s':''}. Descarga individualmente o en ZIP.`;
  const list=$('maResultsList');list.innerHTML='';
  maqResults.forEach((r,i)=>{
    const st=r.stats||{};
    const h1c=st.h1||0,h2c=st.h2||0,h3c=st.h3||0,pc=st.p||0,lc=(st.ul||0)+(st.ol||0),ic=st.img||0,tc=st.table||0;
    const card=document.createElement('div');
    card.className='card';card.style.padding='.875rem';card.style.background='var(--sur2)';
    const safeNm=esc(r.data.title||r.name.replace(/\.[^.]+$/,''));
    card.innerHTML=`
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="font-size:13px;font-weight:600;color:var(--txt);margin-bottom:.25rem">${safeNm}</div>
          <div style="font-size:11px;color:var(--txt3)">${h1c+h2c+h3c} títulos · ${pc} párrafos · ${lc} listas · ${ic} imágenes · ${tc} tablas</div>
        </div>
        <button class="btn-maq" style="width:auto;padding:7px 12px;font-size:12px" data-i="${i}">⬇ Descargar Word</button>
      </div>
      <details style="margin-top:.5rem"><summary style="font-size:11px;cursor:pointer;color:var(--txt2)">Ver estructura detectada</summary>
        <div class="maq-outline" style="margin-top:.375rem">${renderOutline(r.data)}</div>
      </details>`;
    card.querySelector('.btn-maq').onclick=()=>dlOneMaqueta(i);
    list.appendChild(card);
  });
  $('maDlAllZip').style.display=maqResults.length>1?'block':'none';
}
function renderOutline(data){
  const lines=[];
  (data.blocks||[]).forEach(b=>{
    if(b.t==='h1')lines.push(`<div class="maq-h1">${esc((b.n?b.n+' ':'')+b.text)}</div>`);
    else if(b.t==='h2')lines.push(`<div class="maq-h2">${esc((b.n?b.n+' ':'')+b.text)}</div>`);
    else if(b.t==='h3')lines.push(`<div class="maq-h3">${esc((b.n?b.n+' ':'')+b.text)}</div>`);
    else if(b.t==='img')lines.push(`<div class="maq-img">📷 Imagen ${typeof b.idx==='number'?b.idx+1:''}</div>`);
    else if(b.t==='table')lines.push(`<div class="maq-img">▦ Tabla ${typeof b.idx==='number'?b.idx+1:''}</div>`);
  });
  return lines.length?lines.join(''):'<div style="color:var(--txt3);font-size:12px">Sin títulos detectados.</div>';
}

async function generateMaqQuizFor(result){
  try{
    const res=await fetch('/api/maqueta-quiz',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topicId:result.topicId,type:cfg.maqQuizType,num:cfg.maqQuizNum,diff:cfg.maqQuizDiff})});
    const data=await res.json();
    if(!res.ok||!data.success)throw new Error(data.error||'Error');
    if(data.questions?.length){
      result.quiz={type:data.type, mode:cfg.maqQuizDist, questions:data.questions};
    }
    refreshQuizBanner();
  }catch(e){
    refreshQuizBanner('error: '+e.message);
  }
}
function refreshQuizBanner(errMsg){
  const banner=$('maQuizBanner');if(!banner)return;
  if(!cfg.maqQuizEnabled){banner.style.display='none';return;}
  const total=maqResults.length;
  const ready=maqResults.filter(r=>r.quiz&&r.quiz.questions&&r.quiz.questions.length).length;
  banner.style.display='block';
  if(errMsg){
    banner.innerHTML=`<span style="color:var(--r)">⚠ Error generando alguna autoevaluación: ${esc(errMsg)}. Los demás Words se generarán normalmente.</span>`;
  } else if(ready===total){
    const tipoLbl=cfg.maqQuizType==='vf'?'V/F':cfg.maqQuizType==='3opt'?'3 opciones':'4 opciones';
    const distLbl=cfg.maqQuizDist==='inline'?'distribuidas en el texto':'al final del documento';
    banner.innerHTML=`✓ Autoevaluación lista en <strong>${ready}/${total}</strong> documentos (${tipoLbl} · dif. ${cfg.maqQuizDiff} · ${distLbl}).`;
  } else {
    banner.innerHTML=`<span class="spin">⟳</span> Generando autoevaluaciones... ${ready}/${total} listas.`;
  }
}

async function dlOneMaqueta(idx){
  const r=maqResults[idx];if(!r)return;
  try{
    const body={data:r.data, topicId:r.topicId};
    if(customColors){body.colors=customColors;}
    else if(activeTplId){body.templateId=activeTplId;}
    if(r.quiz&&r.quiz.questions&&r.quiz.questions.length){body.quiz=r.quiz;}
    const res=await fetch('/api/maqueta-docx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!res.ok){const e=await res.json().catch(()=>({error:'Error'}));throw new Error(e.error||'Error');}
    const blob=await res.blob();const u=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=u;a.download=`${safeName(r.data.title||r.name||'documento')}_maquetado.docx`;a.click();URL.revokeObjectURL(u);
  }catch(e){showErr('ma','Error: '+e.message);}
}
async function dlMaquetaZip(){
  if(!maqResults.length)return;
  try{
    const body={items:maqResults.map(r=>({data:r.data,topicId:r.topicId,quiz:r.quiz||null}))};
    if(customColors){body.colors=customColors;}
    else if(activeTplId){body.templateId=activeTplId;}
    const res=await fetch('/api/maqueta-zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!res.ok){const e=await res.json().catch(()=>({error:'Error'}));throw new Error(e.error||'Error');}
    const blob=await res.blob();const u=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=u;a.download=`maquetados_${maqResults.length}_documentos.zip`;a.click();URL.revokeObjectURL(u);
  }catch(e){showErr('ma','Error: '+e.message);}
}

function resetMaqueta(){maqResults=[];showPanel('ma','actions');refreshUI('ma');}

// ── Plantillas de color ───────────────────────────────────────────────────────
async function loadTemplates(){
  try{
    const res=await fetch('/api/templates');templates=await res.json();
    renderTemplateSelect();
    applyTemplate(activeTplId);
  }catch(e){console.warn('No se pudieron cargar plantillas',e);}
}
function renderTemplateSelect(){
  const sel=$('tplSelect');
  const built=templates.filter(t=>t.builtin);
  const custom=templates.filter(t=>!t.builtin);
  let html='<optgroup label="Plantillas por defecto">';
  built.forEach(t=>html+=`<option value="${t.id}">${esc(t.name)}</option>`);
  html+='</optgroup>';
  if(custom.length){
    html+='<optgroup label="Mis plantillas">';
    custom.forEach(t=>html+=`<option value="${t.id}">${esc(t.name)}</option>`);
    html+='</optgroup>';
  }
  sel.innerHTML=html;sel.value=activeTplId;
}
function applyTemplate(id){
  const t=templates.find(x=>x.id===id);
  if(!t)return;
  activeTplId=id;customColors=null;
  $('tplSelect').value=id;
  const c=t.colors;
  $('cH1').value='#'+c.h1;$('cH2').value='#'+c.h2;$('cH3').value='#'+c.h3;
  $('cLH1').value='#'+c.lineH1;$('cLH2').value='#'+c.lineH2;$('cTT').value='#'+(c.title||c.h2);
  renderTplPreview(c);
  $('tplName').value='';
  $('btnTplUpdate').style.display=t.builtin?'none':'inline-block';
  $('btnTplDel').style.display=t.builtin?'none':'inline-block';
  $('tplMsg').textContent='';
  renderTplChips();
}
function renderTplPreview(c){
  $('tplPreview').innerHTML=[
    ['H1',c.h1],['H2',c.h2],['H3',c.h3],['L1',c.lineH1],['L2',c.lineH2],['Tt',c.title||c.h2]
  ].map(([l,col])=>`<div class="chip" style="background:#${col}" title="${l} #${col}"></div>`).join('');
}
function renderTplChips(){
  if(!activeTplId)return;
  const colors=customColors||templates.find(t=>t.id===activeTplId)?.colors||{};
  const el=$('maTplChips');
  if(el)el.innerHTML=[colors.h1,colors.h2,colors.h3,colors.lineH1].filter(Boolean).map(c=>`<div style="width:14px;height:14px;border-radius:3px;background:#${c};border:1px solid #ccc"></div>`).join('');
  const nameEl=$('maActiveTpl');
  if(nameEl){
    const t=templates.find(x=>x.id===activeTplId);
    nameEl.textContent=customColors?'Colores personalizados':(t?.name||'—');
  }
}
function onTplChange(){
  applyTemplate($('tplSelect').value);
}
function onColorChange(){
  customColors={
    h1:$('cH1').value.replace('#','').toUpperCase(),
    h2:$('cH2').value.replace('#','').toUpperCase(),
    h3:$('cH3').value.replace('#','').toUpperCase(),
    lineH1:$('cLH1').value.replace('#','').toUpperCase(),
    lineH2:$('cLH2').value.replace('#','').toUpperCase(),
    title:$('cTT').value.replace('#','').toUpperCase()
  };
  renderTplPreview(customColors);
  renderTplChips();
  $('tplMsg').innerHTML='<span style="color:var(--amb)">⚡ Colores personalizados activos. Se usarán al descargar. Guarda como plantilla para reutilizar.</span>';
}
async function saveAsNewTemplate(){
  const name=$('tplName').value.trim();
  if(!name){$('tplMsg').innerHTML='<span style="color:var(--r)">Introduce un nombre.</span>';return;}
  const colors=customColors||(templates.find(t=>t.id===activeTplId)?.colors);
  if(!colors){$('tplMsg').innerHTML='<span style="color:var(--r)">No hay colores para guardar.</span>';return;}
  try{
    const res=await fetch('/api/templates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,colors})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error);
    await loadTemplates();
    activeTplId=data.template.id;customColors=null;
    applyTemplate(activeTplId);
    $('tplMsg').innerHTML=`<span style="color:var(--g)">✓ Plantilla "${esc(name)}" guardada.</span>`;
  }catch(e){$('tplMsg').innerHTML=`<span style="color:var(--r)">Error: ${esc(e.message)}</span>`;}
}
async function updateTemplate(){
  if(activeTplId.startsWith('default-')){$('tplMsg').innerHTML='<span style="color:var(--r)">No se pueden modificar las plantillas por defecto.</span>';return;}
  const t=templates.find(x=>x.id===activeTplId);
  const name=$('tplName').value.trim()||t.name;
  const colors=customColors||t.colors;
  try{
    const res=await fetch('/api/templates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:activeTplId,name,colors})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error);
    await loadTemplates();
    customColors=null;
    applyTemplate(activeTplId);
    $('tplMsg').innerHTML='<span style="color:var(--g)">✓ Plantilla actualizada.</span>';
  }catch(e){$('tplMsg').innerHTML=`<span style="color:var(--r)">Error: ${esc(e.message)}</span>`;}
}
async function deleteTemplate(){
  if(activeTplId.startsWith('default-'))return;
  if(!confirm('¿Eliminar esta plantilla?'))return;
  try{
    const res=await fetch('/api/templates/'+activeTplId,{method:'DELETE'});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error);
    activeTplId='default-scormxpress';customColors=null;
    await loadTemplates();
    $('tplMsg').innerHTML='<span style="color:var(--g)">✓ Plantilla eliminada.</span>';
  }catch(e){$('tplMsg').innerHTML=`<span style="color:var(--r)">Error: ${esc(e.message)}</span>`;}
}

// ── Historial ─────────────────────────────────────────────────────────────────
async function saveToHistory(type,title,meta,content){
  try{
    await fetch('/api/history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,title,meta,content})});
  }catch(e){console.warn('No se pudo guardar historial:',e);}
}
async function loadHistory(){
  const el=$('histList');el.innerHTML='<div class="hist-empty">Cargando historial...</div>';
  try{
    const url='/api/history'+(histFilter?`?type=${histFilter}`:'');
    const res=await fetch(url);
    const items=await res.json();
    historyItems=items;
    renderHistory();
  }catch(e){el.innerHTML='<div class="hist-empty">Error cargando historial.</div>';}
}
function setHistFilter(btn){
  document.querySelectorAll('#histFilters .hist-filter').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  histFilter=btn.dataset.type||'';
  loadHistory();
}
function renderHistory(){
  const el=$('histList');
  if(!historyItems.length){el.innerHTML='<div class="hist-empty">Aún no hay entradas en el historial.<br><span style="font-size:11px">Genera preguntas, resúmenes, mapas o maquetaciones y aparecerán aquí.</span></div>';return;}
  const typeMap={questions:{ico:'📝',label:'Preguntas',badge:'hist-badge-q'},summary:{ico:'📄',label:'Resumen',badge:'hist-badge-s'},map:{ico:'🗺',label:'Mapa',badge:'hist-badge-m'},maqueta:{ico:'✨',label:'Maquetación',badge:'hist-badge-ma'}};
  el.innerHTML=historyItems.map(h=>{
    const tp=typeMap[h.type]||{ico:'📌',label:h.type,badge:''};
    const date=new Date(h.createdAt).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'short'});
    const tags=[];
    if(h.type==='questions'){
      if(h.meta?.total)tags.push(`${h.meta.total} preg.`);
      if(h.meta?.polarity)tags.push(h.meta.polarity==='positive'?'positivas':h.meta.polarity==='negative'?'negativas':'mixtas');
      if(h.meta?.difficulty)tags.push(`dif. ${h.meta.difficulty}`);
    } else if(h.type==='summary'){
      if(h.meta?.count)tags.push(`${h.meta.count} doc${h.meta.count>1?'s':''}`);
      if(h.meta?.totalWords)tags.push(`${h.meta.totalWords.toLocaleString()} pal.`);
    } else if(h.type==='map'){
      if(h.meta?.depth)tags.push(h.meta.depth);
      if(h.meta?.branches)tags.push(`${h.meta.branches} ramas`);
    } else if(h.type==='maqueta'){
      if(h.meta?.titles)tags.push(`${h.meta.titles} títulos`);
      if(h.meta?.chunked)tags.push(`📑 ${h.meta.chunks} secciones`);
    }
    return `<div class="hist-item">
      <div class="hist-ico">${tp.ico}</div>
      <div class="hist-body">
        <div class="hist-title">${esc(h.title)}</div>
        <div class="hist-meta">
          <span class="tag ${tp.badge}" style="padding:1px 6px;border-radius:3px">${tp.label}</span>
          <span>${date}</span>
          ${tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}
        </div>
      </div>
      <div class="hist-actions">
        <button class="btn-load" onclick="loadFromHistory('${h.id}')">↻ Cargar</button>
        <button class="btn-del" onclick="deleteHistoryEntry('${h.id}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}
async function loadFromHistory(id){
  try{
    const res=await fetch('/api/history/'+id);
    const entry=await res.json();
    if(!entry||entry.error)throw new Error(entry?.error||'No se encontró');
    if(entry.type==='questions'){
      qResults=entry.content.qResults||[];
      // Restaurar algo de la configuración (sin forzar cambios drásticos)
      if(entry.content.config){
        const c=entry.content.config;
        if(c.numOpts)cfg.numOpts=c.numOpts;
        if(c.penalty)cfg.penalty=c.penalty;
      }
      renderQResults();
      setTab('q');
      showPanel('q','results');
    } else if(entry.type==='summary'){
      renderSumResults(entry.content.results||[]);
      setTab('s');showPanel('s','results');
    } else if(entry.type==='map'){
      const m=entry.content;
      mapSVG=m.svg;mapW=m.width;mapH=m.height;
      $('mapWrap').innerHTML=mapSVG;
      setTab('m');showPanel('m','results');
    } else if(entry.type==='maqueta'){
      // Cargar como un único resultado en el modelo multi-doc
      const data=entry.content.data;
      const topicId=entry.content.topicId;
      const blocks=data.blocks||[];
      const st=blocks.reduce((s,b)=>{s[b.t]=(s[b.t]||0)+1;return s;},{});
      const tp=topics.find(t=>t.id===topicId);
      const result={
        topicId,
        name: data.title || tp?.name || (entry.title||'Documento')+'.docx',
        data,
        stats: st,
        hasImages: !!(st.img),
        hasTables: !!(st.table),
        quiz: null,
        topicWords: tp?.words || 0,
        fromHistory: true
      };
      maqResults=[result];
      renderTplChips();
      renderMaResults();
      // Aviso si el topic original ya no está en cache
      const banner=$('maQuizBanner');
      if(topicId && !topics.find(t=>t.id===topicId)){
        banner.style.display='block';
        banner.innerHTML='<span style="color:var(--amb)">⚠ El documento original ya no está cargado en esta sesión. Las imágenes/tablas embebidas no se incluirán al descargar. Vuelve a subir el archivo si las necesitas.</span>';
      } else {
        banner.style.display='none';
      }
      setTab('ma');showPanel('ma','results');
    }
  }catch(e){alert('Error cargando entrada: '+e.message);}
}
async function deleteHistoryEntry(id){
  if(!confirm('¿Eliminar esta entrada del historial?'))return;
  try{
    await fetch('/api/history/'+id,{method:'DELETE'});
    loadHistory();
  }catch(e){alert('Error: '+e.message);}
}
async function clearHistory(){
  if(!confirm('¿Vaciar TODO el historial? Esta acción no se puede deshacer.'))return;
  try{
    const url='/api/history'+(histFilter?`?type=${histFilter}`:'');
    await fetch(url,{method:'DELETE'});
    loadHistory();
  }catch(e){alert('Error: '+e.message);}
}

// ── Utilidades ────────────────────────────────────────────────────────────────
function dlTxt(text,fn){const b=new Blob([text],{type:'text/plain;charset=utf-8'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=fn;a.click();URL.revokeObjectURL(u);}
function safeName(n){return(n||'doc').replace(/\.[^.]+$/,'').replace(/[^\w\-áéíóúüñÁÉÍÓÚÜÑ]/g,'_').substring(0,60);}
function addDl(row,label,fn){const b=document.createElement('button');b.className='btn-dl';b.textContent=label;b.onclick=fn;row.appendChild(b);}
function addGift(row,label,fn){const b=document.createElement('button');b.className='btn-gift';b.textContent=label;b.onclick=fn;row.appendChild(b);}
function addDlZip(row,label,fn){const b=document.createElement('button');b.className='btn-dlz';b.textContent=label;b.onclick=fn;row.appendChild(b);}
async function dlZip(files,filename){const res=await fetch('/api/zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files})});const blob=await res.blob();const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=filename;a.click();URL.revokeObjectURL(u);}
function showPanel(tab,state){['empty','actions','progress','results'].forEach(s=>{const el=$(`${tab}-${s}`);if(el)el.style.display='none';});const el=$(`${tab}-${state}`);if(el){el.style.display='block';if(state==='actions'){el.style.display='flex';el.style.flexDirection='column';el.style.gap='.875rem';}}}
function showErr(tab,msg){const el=$(`${tab}-err`);if(el){el.textContent=msg;el.style.display='block';setTimeout(()=>el.style.display='none',9000);}}

// ── Usuarios (panel) ──────────────────────────────────────────────────────────
async function initAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href='/login'; return; }
    currentUser = await res.json();
    const label = document.getElementById('userBtnLabel');
    label.textContent = (currentUser.name||currentUser.username) + (currentUser.role==='admin'?' ⚙':'');
    if (currentUser.mustChangePassword) {
      alert('Debes cambiar la contraseña antes de continuar. Se ha abierto el panel de cuenta.');
      try { openPanel(); } catch(_) {}
    } else if (currentUser.role === 'admin' && currentUser.requireTotpForAdmins && !currentUser.totpEnabled) {
      alert('Como administrador debes activar 2FA antes de continuar. Se ha abierto el panel de cuenta.');
      try { openPanel(); } catch(_) {}
    }
  } catch(_) { window.location.href='/login'; }
}
function openPanel() {
  document.getElementById('panelTitle').textContent = currentUser.role==='admin'?'Cuenta y usuarios':'Mi cuenta';
  document.getElementById('panelBody').innerHTML = renderPanelContent();
  document.getElementById('overlay').classList.add('show');
  if (currentUser.role==='admin') loadUsers();
}
function closePanel() { document.getElementById('overlay').classList.remove('show'); }
function renderPanelContent() {
  const isAdmin = currentUser.role==='admin';
  return `<div class="panel-section">
    <div class="panel-section-title">Mi cuenta</div>
    <div class="user-row">
      <div class="user-avatar">${(currentUser.name||'?')[0].toUpperCase()}</div>
      <div class="user-info">
        <div class="user-name">${esc(currentUser.name)}</div>
        <div class="user-meta">@${esc(currentUser.username)} · <span class="role-badge ${currentUser.role}">${currentUser.role==='admin'?'Administrador':'Usuario'}</span></div>
      </div>
    </div>
    <div style="margin-top:.875rem">
      <div class="panel-section-title">Cambiar contraseña</div>
      <div class="form-field" style="margin-bottom:6px"><label class="form-label">Contraseña actual</label><input class="form-input" type="password" id="cpCurrent" placeholder="Contraseña actual"></div>
      <div class="form-row">
        <div class="form-field"><label class="form-label">Nueva contraseña</label><input class="form-input" type="password" id="cpNew" placeholder="Mín. 12 caracteres con mayúsculas, números o símbolos"></div>
        <div class="form-field"><label class="form-label">Repetir</label><input class="form-input" type="password" id="cpNew2" placeholder="Repetir"></div>
      </div>
      <div class="panel-err" id="cpErr"></div><div class="panel-ok" id="cpOk"></div>
      <button class="btn-main" style="margin-top:.5rem;padding:8px;font-size:12px" onclick="changePassword()">Cambiar contraseña</button>
    </div>
    <div style="margin-top:.875rem">
      <div class="panel-section-title">Autenticación de dos factores (2FA)</div>
      <div id="totpStatus" style="font-size:12px;color:var(--txt2);margin-bottom:6px">
        ${currentUser?.totpEnabled
          ? `<span style="color:var(--g)">✓ 2FA activado</span> · <span style="color:var(--txt3)">Códigos de respaldo restantes: ${currentUser.backupCodesRemaining ?? 0}</span>`
          : (currentUser?.role === 'admin' && currentUser?.requireTotpForAdmins
              ? '<span style="color:var(--r)">⚠ Como administrador DEBES activar 2FA para usar el resto de funciones.</span>'
              : '<span style="color:var(--txt3)">No activado. Recomendado para cuentas con privilegios.</span>')}
      </div>
      <div id="totpBox"></div>
      <div class="panel-err" id="tfErr"></div><div class="panel-ok" id="tfOk"></div>
      ${currentUser?.totpEnabled
        ? `<button class="btn-main" style="margin-top:.5rem;padding:8px;font-size:12px" onclick="regenerateBackupCodes()">Regenerar códigos de respaldo</button>
           <button class="btn-main" style="margin-top:.5rem;padding:8px;font-size:12px;background:var(--r);margin-left:6px" onclick="disable2FA()">Desactivar 2FA</button>`
        : '<button class="btn-main" style="margin-top:.5rem;padding:8px;font-size:12px" onclick="start2FA()">Activar 2FA</button>'}
    </div>
  </div>
  ${isAdmin?`<div class="panel-section">
    <div class="panel-section-title">Gestión de usuarios</div>
    <div id="userList" style="margin-bottom:.875rem"><div style="font-size:12px;color:var(--txt3)">Cargando...</div></div>
    <div class="panel-section-title">Añadir usuario</div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Usuario</label><input class="form-input" type="text" id="nuUser" placeholder="nombre.usuario"></div>
      <div class="form-field"><label class="form-label">Nombre completo</label><input class="form-input" type="text" id="nuName" placeholder="Nombre Apellido"></div>
    </div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Contraseña</label><input class="form-input" type="password" id="nuPass" placeholder="Mín. 12 caracteres con mayúsculas, números o símbolos"></div>
      <div class="form-field"><label class="form-label">Rol</label><select class="form-select" id="nuRole"><option value="user">Usuario</option><option value="admin">Administrador</option></select></div>
    </div>
    <div class="panel-err" id="nuErr"></div><div class="panel-ok" id="nuOk"></div>
    <button class="btn-main" style="margin-top:.5rem;padding:8px;font-size:12px" onclick="addUser()">Añadir usuario</button>
  </div>`:''}
  <div style="margin-top:.875rem;padding-top:.875rem;border-top:1px solid var(--brd)">
    <button class="btn-main" style="background:var(--r);padding:9px;font-size:13px" onclick="doLogout()">Cerrar sesión</button>
  </div>`;
}
async function loadUsers() {
  const el=document.getElementById('userList'); if(!el)return;
  try {
    const res=await fetch('/api/admin/users');const users=await res.json();
    if(!Array.isArray(users))throw new Error();
    el.innerHTML=users.map(u=>`<div class="user-row" id="ur-${u.id}">
      <span class="status-dot ${u.active?'on':'off'}"></span>
      <div class="user-avatar" style="width:28px;height:28px;font-size:11px">${(u.name||'?')[0].toUpperCase()}</div>
      <div class="user-info">
        <div class="user-name">${esc(u.name)} <span class="role-badge ${u.role}">${u.role==='admin'?'Admin':'Usuario'}</span></div>
        <div class="user-meta">@${esc(u.username)} · ${u.active?'Activo':'Inactivo'} · Login: ${u.lastLogin?new Date(u.lastLogin).toLocaleDateString('es-ES'):'Nunca'}</div>
      </div>
      <div class="user-actions">
        <button class="btn-icon" onclick="toggleUser('${u.id}',${!u.active})" title="${u.active?'Desactivar':'Activar'}">${u.active?'⏸':'▶'}</button>
        <button class="btn-icon" onclick="resetPass('${u.id}')" title="Restablecer contraseña">🔑</button>
        <button class="btn-icon del" onclick="deleteUser('${u.id}')" title="Eliminar">🗑</button>
      </div></div>`).join('');
  }catch(_){if(el)el.innerHTML='<div style="font-size:12px;color:var(--r)">Error cargando usuarios.</div>';}
}
async function addUser(){
  const u=gv('nuUser'),n=gv('nuName'),p=gv('nuPass'),r=gv('nuRole');
  pm('nuErr','nuOk','');
  if(!u||!n||!p){pm('nuErr','nuOk','Rellena todos los campos.',true);return;}
  try{const res=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,name:n,password:p,role:r})});const d=await res.json();if(!res.ok)throw new Error(d.error);pm('nuOk','nuErr',`✓ Usuario "${n}" creado.`);['nuUser','nuName','nuPass'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});loadUsers();}
  catch(e){pm('nuErr','nuOk',e.message,true);}
}
async function toggleUser(id,active){try{await fetch(`/api/admin/users/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({active})});loadUsers();}catch(e){alert('Error: '+e.message);}}
async function deleteUser(id){if(!confirm('¿Eliminar este usuario?'))return;try{const res=await fetch(`/api/admin/users/${id}`,{method:'DELETE'});const d=await res.json();if(!res.ok)throw new Error(d.error);loadUsers();}catch(e){alert('Error: '+e.message);}}
async function resetPass(id){const np=prompt('Nueva contraseña (mín. 12 caracteres, con mayúsculas/números/símbolos):');if(!np)return;if(np.length<12){alert('Mín. 12 caracteres con mayúsculas, números o símbolos.');return;}try{const res=await fetch(`/api/admin/users/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:np})});const d=await res.json();if(!res.ok)throw new Error(d.error);alert('✓ Contraseña restablecida.');}catch(e){alert('Error: '+e.message);}}
async function changePassword(){const c=gv('cpCurrent'),n=gv('cpNew'),n2=gv('cpNew2');pm('cpErr','cpOk','');if(!c||!n||!n2){pm('cpErr','cpOk','Rellena todos los campos.',true);return;}if(n!==n2){pm('cpErr','cpOk','Las contraseñas no coinciden.',true);return;}if(n.length<12){pm('cpErr','cpOk','Mín. 12 caracteres con mayúsculas, números o símbolos.',true);return;}try{const res=await fetch('/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:c,newPassword:n})});const d=await res.json();if(!res.ok)throw new Error(d.error);pm('cpOk','cpErr','✓ Contraseña cambiada.');['cpCurrent','cpNew','cpNew2'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});}catch(e){pm('cpErr','cpOk',e.message,true);}}
async function doLogout(){await fetch('/api/auth/logout',{method:'POST'});window.location.href='/login';}
function gv(id){return document.getElementById(id)?.value.trim()||'';}
function pm(errId,okId,msg,isErr=false){const err=document.getElementById(errId),ok=document.getElementById(okId);if(!err||!ok)return;if(!msg){err.style.display='none';ok.style.display='none';}else if(isErr||(!msg.startsWith('✓')&&errId)){err.textContent=msg;err.style.display='block';ok.style.display='none';}else{ok.textContent=msg;ok.style.display='block';err.style.display='none';}}

// ── 2FA (TOTP) ────────────────────────────────────────────────────────────────
async function start2FA(){
  pm('tfErr','tfOk','');
  try {
    const res = await fetch('/api/auth/totp/setup', { method:'POST' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'No se pudo iniciar 2FA.');
    document.getElementById('totpBox').innerHTML = `
      <div style="margin-bottom:8px;font-size:12px;color:var(--txt2)">
        Escanea este QR con tu app (Google Authenticator, 1Password, Authy…) e introduce el código de 6 dígitos.
      </div>
      <img src="${d.qr}" alt="QR 2FA" style="display:block;margin:6px 0;border:1px solid var(--brd);border-radius:6px;max-width:200px">
      <div style="font-size:11px;color:var(--txt3);margin-bottom:6px;word-break:break-all">
        Clave manual: <code>${d.secret}</code>
      </div>
      <div class="form-row">
        <div class="form-field"><label class="form-label">Código 2FA</label>
          <input class="form-input" type="text" id="tfCode" inputmode="numeric" maxlength="6" placeholder="000000"></div>
        <div class="form-field" style="display:flex;align-items:flex-end">
          <button class="btn-main" style="padding:8px;font-size:12px" onclick="confirm2FA()">Confirmar</button>
        </div>
      </div>`;
    setTimeout(() => document.getElementById('tfCode')?.focus(), 50);
  } catch(e){ pm('tfErr','tfOk', e.message, true); }
}
async function confirm2FA(){
  pm('tfErr','tfOk','');
  const code = gv('tfCode');
  if (!/^\d{6}$/.test(code)) { pm('tfErr','tfOk','Código de 6 dígitos.',true); return; }
  try {
    const res = await fetch('/api/auth/totp/enable', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ code })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'No se pudo activar 2FA.');
    pm('tfOk','tfErr','✓ 2FA activado. Guarda los códigos de respaldo en lugar seguro.');
    // Mostrar los backup codes UNA vez
    if (Array.isArray(d.backupCodes) && d.backupCodes.length) {
      showBackupCodes(d.backupCodes);
    } else {
      setTimeout(async () => { await initAuth(); openPanel(); }, 1200);
    }
  } catch(e){ pm('tfErr','tfOk', e.message, true); }
}
function showBackupCodes(codes){
  const box = document.getElementById('totpBox');
  if (!box) return;
  const list = codes.map(c => `<code style="display:inline-block;padding:4px 8px;margin:3px;border:1px solid var(--brd);border-radius:4px;background:#fafaf6;font-family:monospace;font-size:13px">${c}</code>`).join('');
  box.innerHTML = `
    <div style="background:#fffbeb;border:1px solid #f5d97a;padding:10px;border-radius:6px;margin-top:8px">
      <div style="font-size:12px;font-weight:600;color:#7a5b00;margin-bottom:6px">⚠ Guarda estos códigos de respaldo</div>
      <div style="font-size:11px;color:var(--txt2);margin-bottom:8px">
        Cada uno se puede usar UNA vez si pierdes el acceso a tu app de autenticación.
        No se mostrarán de nuevo.
      </div>
      <div>${list}</div>
      <button class="btn-main" style="margin-top:10px;padding:6px 12px;font-size:12px" onclick="copyBackupCodes()">Copiar todos</button>
      <button class="btn-main" style="margin-top:10px;padding:6px 12px;font-size:12px;background:var(--txt3);margin-left:6px" onclick="closeBackupCodes()">He guardado los códigos</button>
      <textarea id="bcTextarea" style="position:absolute;left:-9999px">${codes.join('\n')}</textarea>
    </div>`;
}
function copyBackupCodes(){
  const ta = document.getElementById('bcTextarea');
  if (!ta) return;
  ta.select();
  try { document.execCommand('copy'); alert('Códigos copiados al portapapeles.'); } catch(_){}
}
async function closeBackupCodes(){
  await initAuth();
  openPanel();
}
async function regenerateBackupCodes(){
  const password = prompt('Para regenerar los códigos de respaldo, introduce tu contraseña:');
  if (!password) return;
  try {
    const res = await fetch('/api/auth/totp/backup-codes/regenerate', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ password })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'No se pudieron regenerar.');
    showBackupCodes(d.backupCodes);
    pm('tfOk','tfErr','✓ Nuevos códigos generados. Los anteriores ya no son válidos.');
  } catch(e){ pm('tfErr','tfOk', e.message, true); }
}
async function disable2FA(){
  const password = prompt('Para desactivar 2FA, introduce tu contraseña actual:');
  if (!password) return;
  pm('tfErr','tfOk','');
  try {
    const res = await fetch('/api/auth/totp/disable', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ password })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'No se pudo desactivar 2FA.');
    pm('tfOk','tfErr','✓ 2FA desactivado.');
    setTimeout(async () => { await initAuth(); openPanel(); }, 800);
  } catch(e){ pm('tfErr','tfOk', e.message, true); }
}

// ── Init ──────────────────────────────────────────────────────────────────────
initAuth();
loadTemplates();
setTab('q');
refreshUI('q');
