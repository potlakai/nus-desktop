(() => {
'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api={setPreference:(key,value)=>window.home.mapSet(key,value).catch(()=>{})};
const TYPE_LABELS={core:'Companion',folder:'Folder',source:'File',routine:'Routine',app:'Keeps',session:'Conversation'};
// A small map shows every node at any zoom; the semantic zoom only thins out big ones.
const SMALL_MAP=30;
const state={data:null,map:{positions:{},scale:1,offsetX:0,offsetY:0,viewportLoaded:false}};
function renderMap() {
  const stage=$('#map-stage'); if(!stage)return;
  let shouldFitViewport=false;
  const nodes=[]; const edges=[];
  nodes.push({id:'nus',type:'core',label:'Nūs',meta:'Your Companion',status:'ready',tone:'ok'});
  state.data.folders.forEach(f=>{const id='folder-'+f.id;nodes.push({id,type:'folder',label:f.label,meta:f.files+' files',status:f.enabled?'on':'off',tone:'ok',folderId:f.id});edges.push(['nus',id]);(f.topFiles||[]).forEach(s=>{const sid='file-'+s.id;nodes.push({id:sid,type:'source',label:s.title,meta:'File',status:'indexed',tone:'ok',folderId:f.id});edges.push([id,sid]);});});
  state.data.routines.forEach((r,i)=>{const id='routine-'+i;nodes.push({id,type:'routine',label:r.name,meta:r.steps.length+' steps',status:'saved',tone:'ok',savedAt:r.savedAt});edges.push(['nus',id]);});
  [...new Set(state.data.keeps.map(k=>k.app.process))].forEach((app,i)=>{const id='app-'+i;nodes.push({id,type:'app',label:app,meta:state.data.keeps.filter(k=>k.app.process===app).length+' keeps',status:'kept',tone:'ok',app});edges.push(['nus',id]);});
  state.data.sessions.slice(0,6).forEach(s=>{const id='session-'+s.id;nodes.push({id,type:'session',label:s.title||s.first_line||'Session',meta:new Date(s.started_at).toLocaleDateString(),status:'saved',tone:'ok',sessionId:s.id});edges.push(['nus',id]);});
  const STOPWORDS=new Set(['the','and','for','with','from','into','your','this','that','week','weekly','chapter','exam','homework','assignment','review','study','notes','file','import','course']);
  const nodeTokens=(node)=>new Set(String(node.label).toLowerCase().split(/[^a-z0-9]+/).filter((w)=>w.length>3&&!STOPWORDS.has(w)));
  const structural=new Set(edges.map(([a,b])=>`${a}|${b}`).concat(edges.map(([a,b])=>`${b}|${a}`)));
  const simEdges=[];
  const linkable=nodes.filter((node)=>node.type!=='core');
  for(let i=0;i<linkable.length&&simEdges.length<12;i++){
    const tokensA=nodeTokens(linkable[i]);
    if(!tokensA.size)continue;
    for(let j=i+1;j<linkable.length&&simEdges.length<12;j++){
      if(structural.has(`${linkable[i].id}|${linkable[j].id}`))continue;
      const shared=[...nodeTokens(linkable[j])].filter((w)=>tokensA.has(w));
      if(shared.length)simEdges.push([linkable[i].id,linkable[j].id]);
    }
  }
  state.map.graph={nodes,edges,simEdges};
  const saved=state.data.preferences.companion_map_layout||{}; state.map.positions={...saved,...state.map.positions};
  if(!state.map.viewportLoaded){
    const viewport=state.data.preferences.companion_map_viewport;
    if(viewport&&Number.isFinite(viewport.scale)&&Number.isFinite(viewport.offsetX)&&Number.isFinite(viewport.offsetY)){
      state.map.scale=viewport.scale;
      state.map.offsetX=viewport.offsetX;
      state.map.offsetY=viewport.offsetY;
    }else{
      state.map.scale=state.data.preferences.map_scale||1;
      shouldFitViewport=true;
    }
    state.map.viewportLoaded=true;
  }
  nodes.forEach((node,index)=>{if(!state.map.positions[node.id]){const ring=node.type==='core'?0:node.type==='folder'?180:330;const siblings=nodes.filter((item)=>item.type===node.type);const at=siblings.findIndex((item)=>item.id===node.id);const offsets={folder:-.8,source:1.9,routine:4.3,app:2.7,session:5,core:0};const angle=(at/Math.max(1,siblings.length))*Math.PI*2+offsets[node.type];state.map.positions[node.id]={x:stage.clientWidth/2+(ring?Math.cos(angle)*ring:0)-85,y:stage.clientHeight/2+(ring?Math.sin(angle)*ring*0.5:0)-41};}});
  $('#map-nodes').innerHTML=nodes.map((node)=>{const pos=state.map.positions[node.id];return `<article class="map-node ${node.type}" role="button" tabindex="0" aria-label="${esc(node.label)}" data-node="${node.id}" style="left:${pos.x}px;top:${pos.y}px"><div class="node-top"><small>${TYPE_LABELS[node.type]||node.type}</small><b class="node-status ${node.tone}">${esc(node.status)}</b></div><strong>${esc(node.label)}</strong><span>${esc(node.meta)}</span></article>`;}).join('');
  applyMapScale();
  drawMapEdges(edges); bindMapDrag(edges);
  if(shouldFitViewport)fitMapViewport(false,false);
}
// Semantic-zoom thresholds get hysteresis: detail turns ON above 0.78 and OFF
// below 0.72 (sim edges 0.93/0.87), so hovering the boundary can't flicker.
function mapNodeVisible(id){
  if((state.map.graph?.nodes||[]).length<SMALL_MAP)return true;
  if(state.map.detailOn===undefined)state.map.detailOn=state.map.scale>0.75;
  if(!state.map.detailOn)  {
    const node=(state.map.graph?.nodes||[]).find((n)=>n.id===id);
    return !node||node.type==='core'||node.type==='folder';
  }
  return true;
}
function updateMapThresholds(){
  const s=state.map.scale;
  if(state.map.detailOn===undefined)state.map.detailOn=s>0.75;
  else if(state.map.detailOn&&s<0.72)state.map.detailOn=false;
  else if(!state.map.detailOn&&s>0.78)state.map.detailOn=true;
  if(state.map.simOn===undefined)state.map.simOn=s>=0.9;
  else if(state.map.simOn&&s<0.87)state.map.simOn=false;
  else if(!state.map.simOn&&s>0.93)state.map.simOn=true;
}
// Pan only moves the world transform; nothing inside the world changes.
// Scale changes additionally re-resolve node visibility and edge paths.
function applyMapTransform(){
  const world=$('#map-world');
  world.style.transform=`translate(${state.map.offsetX}px, ${state.map.offsetY}px) scale(${state.map.scale})`;
  world.style.transformOrigin='0 0';
  $('#zoom-label').textContent=`${Math.round(state.map.scale*100)}%`;
}
function applyMapScale(){
  applyMapTransform();
  updateMapThresholds();
  const scale=state.map.scale;
  $$('.map-node').forEach((node)=>{node.style.display=mapNodeVisible(node.dataset.node)?'':'none';node.classList.toggle('detailed',scale>=1.1);});
  if(state.map.graph)scheduleMapEdges();
}
let mapViewportSaveTimer=null;
function persistMapViewport(){
  clearTimeout(mapViewportSaveTimer);
  mapViewportSaveTimer=setTimeout(()=>api.setPreference('companion_map_viewport',{
    scale:state.map.scale,
    offsetX:Math.round(state.map.offsetX),
    offsetY:Math.round(state.map.offsetY),
  }),180);
}
function setMapScale(next,anchor){
  const stage=$('#map-stage');
  const previous=state.map.scale;
  const scale=Math.min(1.6,Math.max(0.2,Math.round(next*1000)/1000));
  const point=anchor||{x:stage.clientWidth/2,y:stage.clientHeight/2};
  const worldX=(point.x-state.map.offsetX)/previous;
  const worldY=(point.y-state.map.offsetY)/previous;
  state.map.scale=scale;
  state.map.offsetX=point.x-worldX*scale;
  state.map.offsetY=point.y-worldY*scale;
  applyMapScale();
  persistMapViewport();
}
// Wheel zoom eases toward a target instead of applying each tick raw: the
// scale lerps ~28% of the remaining distance per frame, anchored under the
// cursor, so fast scrolling feels fluid instead of stepped.
let mapZoomAnim=null;
function glideMapScale(target,anchor){
  target=Math.min(1.6,Math.max(0.2,target));
  mapZoomAnim={target,anchor};
  requestAnimationFrame(function step(){
    if(!mapZoomAnim)return;
    const diff=mapZoomAnim.target-state.map.scale;
    if(Math.abs(diff)<0.004){setMapScale(mapZoomAnim.target,mapZoomAnim.anchor);mapZoomAnim=null;return;}
    setMapScale(state.map.scale+diff*0.28,mapZoomAnim.anchor);
    requestAnimationFrame(step);
  });
}
$('#zoom-in').addEventListener('click',()=>glideMapScale((mapZoomAnim?.target??state.map.scale)+0.1));
$('#zoom-out').addEventListener('click',()=>glideMapScale((mapZoomAnim?.target??state.map.scale)-0.1));
// Where the line from this card's centre toward the other card leaves this card.
const NODE_W=170,NODE_H=82;
function edgePoint(from,to){
  const cx=from.x+NODE_W/2,cy=from.y+NODE_H/2,dx=to.x-from.x,dy=to.y-from.y;
  if(!dx&&!dy)return{x:cx,y:cy};
  const t=Math.min(dx?(NODE_W/2)/Math.abs(dx):Infinity,dy?(NODE_H/2)/Math.abs(dy):Infinity);
  return{x:Math.round(cx+dx*t),y:Math.round(cy+dy*t)};
}
function drawMapEdges(edges){
  const svg=$('#map-edges');
  const path=([a,b],cls)=>{const start=state.map.positions[a],end=state.map.positions[b];if(!start||!end||!mapNodeVisible(a)||!mapNodeVisible(b))return'';const p=edgePoint(start,end),q=edgePoint(end,start);return `<path class="${cls}" d="M ${p.x} ${p.y} L ${q.x} ${q.y}"/>`;};
  const simEdges=state.map.simOn?(state.map.graph?.simEdges||[]):[];
  svg.innerHTML=edges.map((edge)=>path(edge,'map-edge')).join('')+simEdges.map((edge)=>path(edge,'map-edge sim')).join('');
}
// Edge redraws are coalesced to one per animation frame: dragging a node fires
// pointermove far faster than 60Hz and each redraw rebuilds the SVG innerHTML.
let mapEdgeFrame=null;
function scheduleMapEdges(){
  if(mapEdgeFrame||!state.map.graph)return;
  mapEdgeFrame=requestAnimationFrame(()=>{mapEdgeFrame=null;drawMapEdges(state.map.graph.edges);});
}
function bindMapDrag(edges){
  $$('.map-node').forEach((node)=>{
    node.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();window.openMapNode(state.map.graph.nodes.find(n=>n.id===node.dataset.node));}};
    node.onpointerdown=(event)=>{
      if(event.button!==0)return;
      event.preventDefault();
      event.stopPropagation();
      node.classList.add('dragging');
      node.setPointerCapture(event.pointerId);
      const id=node.dataset.node,start={x:event.clientX,y:event.clientY},origin={...state.map.positions[id]};
      node.onpointermove=(move)=>{
        const zoom=state.map.scale||1;
        state.map.positions[id]={x:origin.x+(move.clientX-start.x)/zoom,y:origin.y+(move.clientY-start.y)/zoom};
        node.style.left=`${state.map.positions[id].x}px`;
        node.style.top=`${state.map.positions[id].y}px`;
        scheduleMapEdges();
      };
      let moved=false;
      const originalMove=node.onpointermove;node.onpointermove=e=>{if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>5)moved=true;originalMove(e);};
      const finish=async(event)=>{
        node.classList.remove('dragging');
        node.onpointermove=null;
        node.onpointerup=null;
        node.onpointercancel=null;
        await api.setPreference('companion_map_layout',state.map.positions);
        if(!moved&&event.type!=='pointercancel')window.openMapNode(state.map.graph.nodes.find(n=>n.id===id));
      };
      node.onpointerup=finish;
      node.onpointercancel=finish;
    };
  });
}
function fitMapViewport(persist=true,animate=true){
  const stage=$('#map-stage');
  const positions=(state.map.graph?.nodes||[]).map(n=>state.map.positions[n.id]).filter(Boolean);
  if(!positions.length)return;
  const minX=Math.min(...positions.map((p)=>p.x));
  const minY=Math.min(...positions.map((p)=>p.y));
  const maxX=Math.max(...positions.map((p)=>p.x+NODE_W));
  const maxY=Math.max(...positions.map((p)=>p.y+NODE_H));
  const width=Math.max(1,maxX-minX),height=Math.max(1,maxY-minY),padding=40;
  const toScale=Math.min(1.2,Math.max(.2,Math.min((stage.clientWidth-padding*2)/width,(stage.clientHeight-padding*2)/height)));
  const toX=(stage.clientWidth-width*toScale)/2-minX*toScale;
  const toY=(stage.clientHeight-height*toScale)/2-minY*toScale;
  if(!animate){
    state.map.scale=toScale;state.map.offsetX=toX;state.map.offsetY=toY;
    applyMapScale();
    if(persist)persistMapViewport();
    return;
  }
  // Center map glides home over ~280ms instead of jumping.
  const from={scale:state.map.scale,x:state.map.offsetX,y:state.map.offsetY};
  const t0=performance.now();
  mapZoomAnim=null;
  requestAnimationFrame(function step(now){
    const t=Math.min(1,(now-t0)/280);
    const e=1-Math.pow(1-t,3); // ease-out cubic
    state.map.scale=from.scale+(toScale-from.scale)*e;
    state.map.offsetX=from.x+(toX-from.x)*e;
    state.map.offsetY=from.y+(toY-from.y)*e;
    applyMapScale();
    if(t<1)requestAnimationFrame(step);
    else if(persist)persistMapViewport();
  });
}
const mapStage=$('#map-stage');
let mapPan=null;
mapStage.addEventListener('pointerdown',(event)=>{
  if(event.button!==0||event.target.closest('.map-node,button'))return;
  event.preventDefault();
  mapStage.setPointerCapture(event.pointerId);
  mapStage.classList.add('dragging');
  mapPan={x:event.clientX,y:event.clientY,offsetX:state.map.offsetX,offsetY:state.map.offsetY};
});
mapStage.addEventListener('pointermove',(event)=>{
  if(!mapPan)return;
  state.map.offsetX=mapPan.offsetX+event.clientX-mapPan.x;
  state.map.offsetY=mapPan.offsetY+event.clientY-mapPan.y;
  applyMapTransform(); // pan never changes what is visible, only where it sits
});
function finishMapPan(){if(!mapPan)return;mapPan=null;mapStage.classList.remove('dragging');persistMapViewport();}
mapStage.addEventListener('pointerup',finishMapPan);
mapStage.addEventListener('pointercancel',finishMapPan);
mapStage.addEventListener('wheel',(event)=>{
  event.preventDefault();
  const rect=mapStage.getBoundingClientRect();
  const direction=Math.exp(-event.deltaY*.0015);
  const base=mapZoomAnim?.target??state.map.scale;
  glideMapScale(base*direction,{x:event.clientX-rect.left,y:event.clientY-rect.top});
},{passive:false});
$('#map-fit').addEventListener('click',()=>fitMapViewport());


window.companionMap={render(data){state.data=data;renderMap();}};
})();
