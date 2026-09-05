const content=document.querySelector('#content');
const title=document.querySelector('#title');
const subtitle=document.querySelector('#subtitle');
const toast=document.querySelector('#toast');

let dark=true;
let running=true;
let selected='R02';
let zoom=1;
let lastFrame=performance.now();
let activePage='overview';
let lastInsightUpdate=0;
const junctionReservations={};
const WAIT_RADIUS=32;
const pickupProgress={};
const predictionCooldown={};
const collisionRobots=new Set();

const settings={routes:true,conflicts:true,ids:true,autoReroute:true,collisionGuard:true,uwbFallback:true,telemetry:true,simulationSpeed:'Very slow',telemetryRefresh:'Real-time',offlineRobots:{}};
const speedProfiles={'Very slow':0.22,Slow:0.30,Normal:0.42,Fast:0.62};
let telemetryTimer=null;
let mapResolution=1;

// Browser-side demo state schema: coordinates, status, destination, route nodes and conflicts.
const warehouseState={
  warehouseId:'WH-01',
  dimensions:{width:1200,height:600,gridMeters:10},
  robots:[],
  conflicts:[],
  updatedAt:new Date().toISOString()
};

const nodes={
  JA1:[120,80],JB1:[460,80],JC1:[800,80],JD1:[1080,80],
  JA2:[120,220],JB2:[460,220],JC2:[800,220],JD2:[1080,220],
  JA3:[120,360],JB3:[460,360],JC3:[800,360],JD3:[1080,360],
  JA4:[120,500],JB4:[460,500],JC4:[800,500],JD4:[1080,500]
};

const pickupNodes={
  PA1:[275,80],PB1:[615,80],PC1:[955,80],
  PA2:[275,220],PB2:[615,220],PC2:[955,220],
  PA3:[275,360],PB3:[615,360],PC3:[955,360]
};
const allNodes={...nodes,...pickupNodes};
const pickupStops=Object.entries(pickupNodes).map(([id,[x,y]])=>({id,x,y,label:`PICKUP ${id.slice(1)}`}));

// Legal travel graph: only aisle centre-lines and their intersections are routable.
const graph={};
Object.keys(nodes).forEach(k=>graph[k]=[]);
[['JA1','JB1'],['JB1','JC1'],['JC1','JD1'],['JA2','JB2'],['JB2','JC2'],['JC2','JD2'],['JA3','JB3'],['JB3','JC3'],['JC3','JD3'],['JA4','JB4'],['JB4','JC4'],['JC4','JD4'],['JA1','JA2'],['JA2','JA3'],['JA3','JA4'],['JB1','JB2'],['JB2','JB3'],['JB3','JB4'],['JC1','JC2'],['JC2','JC3'],['JC3','JC4'],['JD1','JD2'],['JD2','JD3'],['JD3','JD4']].forEach(([a,b])=>{graph[a].push(b);graph[b].push(a)});
function nearestNode(point){let best=null,d=Infinity;Object.entries(nodes).forEach(([k,p])=>{const dd=Math.hypot(point[0]-p[0],point[1]-p[1]);if(dd<d){d=dd;best=k}});return best}
function shortestNodePath(start,end){
  if(!nodes[start]||!nodes[end]) return [];
  const q=[start],prev={[start]:null};
  while(q.length){const u=q.shift();if(u===end)break;for(const v of graph[u]||[]){if(!(v in prev)){prev[v]=u;q.push(v)}}}
  if(!(end in prev)) return [start,end];
  const path=[];let cur=end;while(cur!==null){path.unshift(cur);cur=prev[cur]}return path;
}
function shortestRouteToPickup(start,pickupId){
  const pt=pickupNodes[pickupId];const target=nearestNode(pt);const base=shortestNodePath(start,target);
  return base.length?base.concat([pickupId]):[start,pickupId];
}
const robotSeed=[
  {id:'R01',status:'IDLE',battery:88,payload:'Loaded',speed:0,color:'#4fa7d1',route:['JA4','JB4','JC4','JD4'],plannedRoute:['JA4','JB4','JC4','JD4'],destination:'JD4',segment:0,t:.22},
  {id:'R02',status:'IDLE',battery:72,payload:'Loaded',speed:0,color:'#d9a347',route:['JB1','JB2','PB2','JC2','JC3','JD3'],plannedRoute:['JB1','JB2','PB2','JC2','JC3','JD3'],destination:'JD3',pickup:'PB2',segment:0,t:.58},
  {id:'R03',status:'CHARGING',battery:94,payload:'Empty',speed:0,color:'#55c98a',route:['JA4','JA4'],plannedRoute:['JA4','JA4'],destination:'JA4',segment:0,t:0},
  {id:'R04',status:'NAVIGATING',battery:64,payload:'Loaded',speed:.32,color:'#8b8fda',route:['JC1','PC1','JB1','JA1'],plannedRoute:['JC1','PC1','JB1','JA1'],destination:'JA1',pickup:'PC1',segment:0,t:.06},
  {id:'R05',status:'WAITING',battery:81,payload:'Loaded',speed:0,color:'#64b9d8',route:['JC1','JC2','JC3'],plannedRoute:['JC1','JC2','JC3'],destination:'JC3',segment:0,t:.38},
  {id:'R06',status:'NAVIGATING',battery:58,payload:'Loaded',speed:.28,color:'#c884d9',route:['JB2','JB1','JC1'],plannedRoute:['JB2','JB1','JC1'],alternateRoute:['JB2','JB3','JC3','JC2','JC1'],pickup:'PB1',destination:'JC1',segment:0,t:.12,routingState:'NORMAL',trajectory:[]},
  {id:'R07',status:'IDLE',battery:76,payload:'Empty',speed:0,color:'#7fc46a',route:['JA2','JB2','JB3','JC3'],plannedRoute:['JA2','JB2','JB3','JC3'],destination:'JC3',segment:0,t:.63},
  {id:'R08',status:'IDLE',battery:91,payload:'Loaded',speed:0,color:'#e38b58',route:['JA3','JB3','PB3','JC3','JC2'],plannedRoute:['JA3','JB3','PB3','JC3','JC2'],destination:'JC2',pickup:'PB3',segment:0,t:.34}
];

const robots=robotSeed.map(r=>{
  const [x,y]=nodes[r.route[r.segment]]||nodes[r.route[0]];
  return {...r,x,y,trajectory:r.trajectory||[[x,y]],routingState:r.routingState||'NORMAL',rerouteStep:r.rerouteStep||0,speed:r.status==='NAVIGATING'?0:0,waitingFor:null,waitUntil:0};
});
warehouseState.robots=robots;

const conflicts=[
  {id:'C-025',pair:'R06→R04',node:'JB1',severity:'HIGH',eta:'18 sec',status:'PREDICTED'},
  {id:'C-024',pair:'R02→R05',node:'JB2',severity:'HIGH',eta:'24 sec',status:'PREDICTED'},
  {id:'C-023',pair:'R08→R05',node:'JC3',severity:'MED',eta:'31 sec',status:'RESOLVING'}
];
warehouseState.conflicts=conflicts;

const reroutes=[
  {id:'RR-018',robot:'R02',from:'B2 → Packing',reason:'C-024 conflict',via:'Aisle 4',gain:'-11 m',state:'ACTIVE'},
  {id:'RR-017',robot:'R01',from:'A3 → Outbound',reason:'Congestion',via:'West lane',gain:'-8 m',state:'COMPLETE'},
  {id:'RR-016',robot:'R04',from:'C1 → Inbound',reason:'Signal degradation',via:'North lane',gain:'-4 m',state:'ACTIVE'}
];

const events=[
  ['14:36','Conflict predicted','R06 ↔ R04 · Junction B1','red'],
  ['14:35','Reroute approved','R02 moved to alternate aisle','amber'],
  ['14:34','Conflict resolving','R08 ↔ R05 · junction priority','blue'],
  ['14:32','Robot R04 link switched','Wi-Fi → UWB fallback · Zone C','amber'],
  ['14:30','Task T-114 assigned','Robot R02 · Packing station','normal'],
  ['14:21','Task T-104 assigned','Robot R01 · Outbound bay','normal'],
  ['14:12','Task T-099 completed','Robot R03 · charging cycle','green']
];

function toastMsg(s){
  toast.textContent=s;
  toast.classList.add('show');
  clearTimeout(window.tt);
  window.tt=setTimeout(()=>toast.classList.remove('show'),1800);
}

function statusClass(s){return s.toLowerCase().replace(/[^a-z]+/g,'-')}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

function robotSvg(r){
  const statusColor=r.status==='OFFLINE'?'#68757e':r.status==='CHARGING'?'#55c98a':r.status==='WAITING'?'#d9a347':r.color;
  const ids=settings.ids?`<g class="robot-label"><rect x="-24" y="-37" width="48" height="17" rx="3"/><text y="-25" text-anchor="middle">${r.id}</text></g>`:'';
  return `<g class="robot-marker ${r.status==='OFFLINE'?'offline':''}" data-robot="${r.id}" transform="translate(${r.x},${r.y})" style="--rc:${statusColor}">
    <circle class="robot-halo" r="19"/>
    <rect class="robot-body" x="-13" y="-10" width="26" height="20" rx="4"/>
    <path d="M-6 -3H6M0 -10V10"/>
    <circle class="robot-core" r="3"/>
    ${ids}
  </g>`;
}

function routePath(route){
  return (route||[]).map(n=>allNodes[n]).filter(Boolean).map(([x,y],i)=>`${i?'L':'M'}${x} ${y}`).join(' ');
}

function trajectoryPath(r){
  return (r.trajectory||[]).map(([x,y],i)=>`${i?'L':'M'}${x} ${y}`).join(' ');
}

function mapSvg(){
  const racks=[
    [150,105,'A1'],[490,105,'B1'],[830,105,'C1'],
    [150,245,'A2'],[490,245,'B2'],[830,245,'C2'],
    [150,385,'A3'],[490,385,'B3'],[830,385,'C3']
  ];
  const junctions=Object.entries(nodes);
  return `<svg id="warehouseSvg" viewBox="0 0 1200 600" shape-rendering="geometricPrecision" preserveAspectRatio="xMidYMid meet" aria-label="Warehouse map">
    <defs>
      <pattern id="mapGrid" width="30" height="30" patternUnits="userSpaceOnUse">
        <path d="M30 0H0V30" fill="none" stroke="#202a31" stroke-width="1"/>
      </pattern>
      <pattern id="rackPattern" width="16" height="12" patternUnits="userSpaceOnUse">
        <rect width="16" height="12" fill="#151d23"/>
        <path d="M0 12L12 0M5 12L16 1" stroke="#26323a" stroke-width="1"/>
      </pattern>
      <filter id="robotGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect width="1200" height="600" fill="#0b1014"/>
    <rect x="18" y="18" width="1164" height="564" rx="2" fill="url(#mapGrid)" stroke="#34414a" stroke-width="2"/>

    <g class="facility-labels">
      <rect x="0" y="48" width="78" height="64"/><text x="10" y="75">INBOUND</text><text x="10" y="95">DOCK</text>
      <rect x="0" y="454" width="82" height="68"/><text x="10" y="482">CHARGING</text><text x="10" y="502">AREA</text>
      <rect x="1120" y="188" width="80" height="64"/><text x="1131" y="215">PACKING</text><text x="1131" y="235">STATION</text>
      <rect x="1120" y="454" width="80" height="68"/><text x="1131" y="482">OUTBOUND</text><text x="1131" y="502">BAY</text>
    </g>

    <!-- Wide grey corridors are the only legal travel surface. Racks are physically between them. -->
    <g class="aisles">
      <path d="M78 80H1120M78 220H1120M78 360H1120M78 500H1120" stroke="#303b43" stroke-width="48"/>
      <path d="M120 32V548M460 32V548M800 32V548M1080 32V548" stroke="#303b43" stroke-width="48"/>
      <path d="M78 80H1120M78 220H1120M78 360H1120M78 500H1120" stroke="#151c22" stroke-width="38"/>
      <path d="M120 32V548M460 32V548M800 32V548M1080 32V548" stroke="#151c22" stroke-width="38"/>
      <path d="M78 80H1120M78 220H1120M78 360H1120M78 500H1120" stroke="#27343c" stroke-width="1.5" stroke-dasharray="9 10"/>
    </g>

    <g class="rack">${racks.map(([x,y,id])=>`<g>
      <rect x="${x}" y="${y}" width="250" height="82" rx="2" fill="url(#rackPattern)" stroke="#56636b" stroke-width="2"/>
      <rect x="${x+10}" y="${y+10}" width="230" height="62" fill="none" stroke="#344149" stroke-width="1"/>
      <text x="${x+14}" y="${y+24}">RACK ${id}</text>
    </g>`).join('')}</g>

    <g class="junctions">${junctions.map(([name,[x,y]])=>`<g><rect x="${x-10}" y="${y-10}" width="20" height="20" rx="2"/><text x="${x+14}" y="${y-14}">${name}</text></g>`).join('')}</g>

    <g class="route-layer" style="display:${settings.routes?'':'none'}">
      ${robots.map(r=>`<path class="planned-route robot-route-${r.id}" d="${routePath(r.plannedRoute||r.route)}"/>`).join('')}
      ${robots.map(r=>`<path class="active-route robot-route-live-${r.id}" d="${routePath(r.route)}"/>`).join('')}
      <path class="reroute-route" d="${routePath(robots.find(r=>r.id==='R06')?.alternateRoute||[])}"/>
      ${robots.map(r=>`<path class="trajectory-route trajectory-${r.id}" d="${trajectoryPath(r)}"/>`).join('')}
    </g>

    <g class="conflicts-map" style="display:${settings.conflicts?'':'none'}">
      ${conflicts.map(c=>{const [x,y]=nodes[c.node];return `<g class="conflict-zone" data-conflict="${c.id}">
        <circle cx="${x}" cy="${y}" r="34"/><circle cx="${x}" cy="${y}" r="7" class="conflict-core"/>
        <text x="${x}" y="${y-43}">${c.id} · ${c.pair}</text>
      </g>`}).join('')}
    </g>

    <g class="aisle-labels">
      <text x="235" y="91">AISLE 1</text><text x="575" y="91">AISLE 1</text><text x="915" y="91">AISLE 1</text>
      <text x="235" y="231">AISLE 2</text><text x="575" y="231">AISLE 2</text><text x="915" y="231">AISLE 2</text>
      <text x="235" y="371">AISLE 3</text><text x="575" y="371">AISLE 3</text><text x="915" y="371">AISLE 3</text>
      <text x="235" y="511">AISLE 4</text><text x="575" y="511">AISLE 4</text><text x="915" y="511">AISLE 4</text>
    </g>

    <g class="pickup-layer">${pickupStops.map(p=>`<g class="pickup-stop"><circle cx="${p.x}" cy="${p.y}" r="7"/><path d="M${p.x-3} ${p.y}h6M${p.x} ${p.y-3}v6"/><text x="${p.x}" y="${p.y+19}">${p.label}</text></g>`).join('')}</g>
    <g id="robotLayer">${robots.map(robotSvg).join('')}</g>
  </svg>`;
}

function mapHTML(){
  return `<div class="map-shell">
    <div class="map-head"><div><b>LIVE WAREHOUSE MAP · WH-01</b><small>100 × 100 m · NORTH ZONE · 8 EDGE ROBOTS</small></div>
      <div class="map-actions"><button onclick="zoomMap(1)">＋ Zoom</button><button onclick="zoomMap(-1)">−</button><button onclick="resetMap()">↻ Reset</button>
      <label><input ${settings.routes?'checked':''} type="checkbox" onchange="toggleSetting('routes',this.checked)"> Routes</label>
      <label><input ${settings.conflicts?'checked':''} type="checkbox" onchange="toggleSetting('conflicts',this.checked)"> Conflicts</label>
      <label><input ${settings.ids?'checked':''} type="checkbox" onchange="toggleSetting('ids',this.checked)"> Robot IDs</label></div>
    </div>
    <div class="warehouse" id="warehouseViewport"><div class="warehouse-canvas">${mapSvg()}</div>
      <div class="map-overlay"><div class="map-legend"><div class="legend-item"><i class="dot blue"></i> Live route</div><div class="legend-item"><i class="dot amber"></i> Planned</div><div class="legend-item"><i class="dot purple"></i> Rerouted</div><div class="legend-item"><i class="dot red"></i> Conflict</div><div class="legend-item"><i class="dot green"></i> Trajectory / history</div></div><div class="map-scale">10 m ─────────</div><div class="north">N<br>↑</div><div id="robotTooltip" class="robot-tooltip"></div></div>
    </div>
    <div class="map-insights">
      <section class="map-panel"><div class="panel-title"><b>TRAJECTORY</b><span>Actual robot motion</span></div><div id="trajectoryDetails" class="trajectory-details"></div></section>
      <section class="map-panel"><div class="panel-title"><b>REROUTE & COLLISION AVOIDANCE</b><span>Decision trace</span></div><div id="rerouteDetails" class="reroute-details"></div></section>
    </div>
  </div>`;
}

function overview(){
  const active=robots.filter(r=>r.status==='NAVIGATING').length;
  const idle=robots.filter(r=>r.status==='IDLE'||r.status==='CHARGING'||r.status==='WAITING').length;
  content.innerHTML=`<div class="metrics"><div><small>TOTAL ROBOTS</small><b>${String(robots.length).padStart(2,'0')}</b></div><div><small>ACTIVE</small><b>${String(active).padStart(2,'0')}</b></div><div><small>WAIT / CHARGE</small><b>${String(idle).padStart(2,'0')}</b></div><div><small>CONFLICTS OPEN</small><b class="redtxt">${conflicts.filter(c=>c.status!=='RESOLVED').length.toString().padStart(2,'0')}</b></div><div><small>REROUTING</small><b class="ambertxt">02</b></div><div><small>TASKS PENDING</small><b>06</b></div></div>
  <div class="dashboard-grid"><section class="card map-card">${mapHTML()}</section><section class="card events"><div class="section-head"><div><b>RECENT EVENTS</b><small>Fleet activity stream</small></div><button onclick="showPage('conflicts')">View conflicts →</button></div>${events.map(e=>`<div class="event ${e[3]}"><time>${e[0]}</time><div><b>${e[1]}</b><small>${e[2]}</small></div></div>`).join('')}</section></div>
  <div class="bottom-cards"><section class="card panel"><div class="section-head"><div><b>ROBOT TELEMETRY</b><small>Live edge-node data · 8 robots</small></div><button onclick="showPage('robots')">Manage fleet →</button></div>${robots.map(robotRow).join('')}</section><section class="card panel"><div class="section-head"><div><b>CONFLICT MONITOR</b><small>Decentralized coordination</small></div><span class="counter">${conflicts.length} OPEN</span></div>${conflicts.map(conflictRow).join('')}</section></div>`;
  bindMapInteractions();
}

function robotRow(r){return `<div class="robot-row"><div class="robot-name"><span class="mini-bot" style="--rc:${r.color}">${r.id}</span><div><b>${r.status === 'NAVIGATING'?'MOVING' : r.status}</b><small>${esc(r.task||'Live route telemetry')}</small></div></div><div class="battery"><span>${Math.round(r.battery)}%</span><i><em style="width:${r.battery}%"></em></i></div><div class="speed">${r.speed.toFixed(1)}<small> m/s</small></div><button onclick="selectRobot('${r.id}')">→</button></div>`}
function conflictRow(c){return `<div class="conflict-row"><strong>${c.id}</strong><span>${c.pair}</span><b>${c.node}</b><button onclick="resolveConflict('${c.id}')">${c.status==='RESOLVED'?'Resolved':'Resolve'}</button></div>`}

function detailHTML(){const r=robots.find(x=>x.id===selected)||robots[0];return `<div class="detail-title"><div class="bot-big">${r.id}</div><div><h2>${r.id} · Edge robot</h2><small>Route ${r.route.join(' → ')}</small></div><span class="status ${statusClass(r.status)}">${r.status}</span></div><div class="tele-grid"><div><small>BATTERY</small><b>${Math.round(r.battery)}%</b></div><div><small>SPEED</small><b>${r.speed.toFixed(1)} m/s</b></div><div><small>PAYLOAD</small><b>${r.payload}</b></div><div><small>TARGET</small><b>${r.destination}</b></div><div><small>PICKUP</small><b>${r.pickup||'—'}</b></div></div><div class="taskbox"><small>CURRENT MISSION</small><b>${r.task||'Live route navigation'}</b><span>Network: ${r.id==='R04'?'Wi-Fi + UWB fallback':'Wi-Fi primary'}</span></div><div class="control-row"><button class="primary" onclick="sendRobot('${r.id}')">Dispatch</button><button onclick="pauseRobot('${r.id}')">${r.status==='WAITING'?'Resume':'Pause'}</button><button class="danger" onclick="stopRobot('${r.id}')">E-Stop</button></div>`}

function robotsPage(){content.innerHTML=`<div class="page-grid"><section class="card panel"><div class="section-head"><div><b>LIVE FLEET</b><small>8 simulated edge robots · live telemetry</small></div><button class="primary" onclick="resumeFleet()">▶ Resume fleet</button></div>${robots.map(robotRow).join('')}</section><section class="card robot-detail">${detailHTML()}</section></div><section class="card list-card"><div class="section-head"><div><b>FLEET HEALTH</b><small>Connectivity, battery and navigation state</small></div><button onclick="toastMsg('Fleet health check completed')">Run health check</button></div><div class="table-row header"><span>ROBOT</span><span>MISSION</span><span>NETWORK</span><span>BATTERY</span><span>STATE</span></div>${robots.map(r=>`<div class="table-row"><b>${r.id}</b><span>${r.task||'Live navigation'}</span><span>${r.id==='R04'?'Wi-Fi + UWB fallback':'Wi-Fi primary'}</span><span>${Math.round(r.battery)}%</span><span class="pill ${r.status==='NAVIGATING'?'green':r.status==='WAITING'?'amber':r.status==='CHARGING'?'green':'red'}">${r.status}</span></div>`).join('')}</section>`}
function mapPage(){content.innerHTML=`<section class="card fullmap">${mapHTML()}<div class="map-command"><button onclick="resumeFleet()">▶ Start simulation</button><button onclick="pauseFleet()">Ⅱ Pause all</button><button class="danger" onclick="stopFleet()">■ Emergency stop</button></div></section>`;bindMapInteractions();updateMapInsights()}
function tasksPage(){const tasks=[['T-114','R02','Rack B2 → Packing','HIGH','ACTIVE'],['T-113','R04','Rack C1 → Inbound','NORMAL','ACTIVE'],['T-104','R01','Rack A3 → Outbound','NORMAL','ACTIVE'],['T-099','R03','Charging / standby','LOW','QUEUED'],['T-118','R05','Rack C2 → Packing','NORMAL','QUEUED'],['T-121','R08','Aisle 3 → Rack B3','LOW','ACTIVE']];content.innerHTML=`<section class="card list-card"><div class="section-head"><div><b>TASK QUEUE</b><small>6 assignments · priority-aware allocation</small></div><button class="primary" onclick="toastMsg('New task created in simulation queue')">＋ New task</button></div><div class="table-row header"><span>ID</span><span>ROBOT</span><span>ROUTE</span><span>PRIORITY</span><span>STATE</span></div>${tasks.map(t=>`<div class="table-row"><b>${t[0]}</b><span>${t[1]}</span><span>${t[2]}</span><span class="pill ${t[3]==='HIGH'?'red':t[3]==='NORMAL'?'amber':'green'}">${t[3]}</span><span>${t[4]}</span></div>`).join('')}</section>`}
function conflictsPage(){content.innerHTML=`<section class="card list-card"><div class="section-head"><div><b>CONFLICT RESOLUTION CENTER</b><small>Predict → negotiate → reserve → reroute</small></div><button class="primary" onclick="resolveAll()">Resolve all safe conflicts</button></div><div class="table-row header"><span>ID</span><span>ROBOTS</span><span>ZONE</span><span>ETA</span><span>STATE</span></div>${conflicts.map(c=>`<div class="table-row"><b>${c.id}</b><span>${c.pair}</span><span>${c.node}</span><span>${c.eta}</span><span class="pill ${c.severity==='HIGH'?'red':c.severity==='MED'?'amber':'green'}">${c.status}</span></div>`).join('')}</section><div class="bottom-cards"><section class="card module"><div class="module-icon">△</div><h2>Prediction engine</h2><p>Collision guard evaluates robot position, velocity, route reservation and junction priority every control cycle.</p><div class="module-grid"><div><small>LOOKAHEAD</small><b>12 s</b></div><div><small>CHECK RATE</small><b>10 Hz</b></div><div><small>OPEN</small><b class="redtxt">${conflicts.filter(c=>c.status!=='RESOLVED').length.toString().padStart(2,'0')}</b></div><div><small>RESOLVED</small><b class="greentxt">18</b></div></div></section><section class="card module"><div class="module-icon">⇄</div><h2>Priority arbitration</h2><p>Deadlock prevention gives the higher-priority task a temporary junction reservation while the other robot waits or reroutes.</p><button class="primary" onclick="toastMsg('Priority arbitration simulation executed')">Run arbitration</button></section></div>`}
function routingPage(){content.innerHTML=`<section class="card route-card"><div class="section-head"><div><b>REROUTING CONTROL</b><small>Dynamic alternate-path selection and congestion handling</small></div><button class="primary" onclick="runReroute()">↝ Run route optimizer</button></div>${reroutes.map(r=>`<div class="route-row"><strong>${r.id}</strong><span><b>${r.robot}</b> · ${r.from}<small style="display:block;color:#6e7b84;margin-top:3px">Reason: ${r.reason} · via ${r.via}</small></span><span><div class="route-line"><i></i></div><small style="display:block;color:#71808a;margin-top:3px">Distance ${r.gain}</small></span><span class="pill ${r.state==='ACTIVE'?'amber':'green'}">${r.state}</span></div>`).join('')}</section>`}
function communicationPage(){content.innerHTML=`<section class="card list-card"><div class="section-head"><div><b>COMMUNICATION FABRIC</b><small>Decentralized edge-to-edge fleet connectivity</small></div><button onclick="toastMsg('Network diagnostics complete')">Run diagnostics</button></div><div class="table-row header"><span>NODE</span><span>PRIMARY</span><span>FALLBACK</span><span>SIGNAL</span><span>STATE</span></div>${robots.map(r=>`<div class="table-row"><b>${r.id}</b><span>Wi-Fi 5 GHz</span><span>${r.id==='R04'?'UWB':'Bluetooth mesh'}</span><span>${r.id==='R04'?'-58':'-42'} dBm</span><span class="pill green">CONNECTED</span></div>`).join('')}</section>`}
function analyticsPage(){content.innerHTML=`<div class="metrics"><div><small>UTILIZATION</small><b>82%</b></div><div><small>AVG SPEED</small><b>1.1 m/s</b></div><div><small>MISSIONS TODAY</small><b>128</b></div><div><small>CONFLICTS</small><b>21</b></div><div><small>REROUTES</small><b>17</b></div><div><small>SUCCESS RATE</small><b class="greentxt">98.4%</b></div></div><div class="bottom-cards"><section class="card module"><div class="module-icon">▥</div><h2>Fleet utilization</h2><p>Active travel time remains highest around outbound and packing lanes, with charging automatically scheduled during low-demand windows.</p><div class="module-grid"><div><small>R01</small><b>89%</b></div><div><small>R02</small><b>92%</b></div><div><small>R03</small><b>41%</b></div><div><small>R04</small><b>84%</b></div></div></section><section class="card module"><div class="module-icon">△</div><h2>Safety performance</h2><p>No collision events recorded. Predicted conflicts are being handled by priority arbitration and local rerouting.</p><div class="module-grid"><div><small>COLLISIONS</small><b class="greentxt">0</b></div><div><small>NEAR MISSES</small><b>3</b></div><div><small>ESTOP</small><b>0</b></div><div><small>GUARD</small><b class="greentxt">ON</b></div></div></section></div>`}
function settingsPage(){
  const robotControls=robots.map(r=>`<div class="offline-row"><div><b>${r.id}</b><small>${r.task||'Warehouse mission'}</small></div><span class="pill ${r.status==='OFFLINE'?'red':'green'}">${r.status}</span><button class="toggle ${r.status!=='OFFLINE'?'on':''}" onclick="setRobotOffline('${r.id}',${r.status!=='OFFLINE'})"><i></i></button></div>`).join('');
  content.innerHTML=`<div class="settings-grid">
  <section class="card"><div class="section-head"><div><b>NAVIGATION & SAFETY</b><small>Controller behavior</small></div></div>${[['autoReroute','Automatic rerouting','Select the shortest safe alternate path when a conflict is predicted.'],['collisionGuard','Collision guard','Reserve intersections and make lower-priority robots wait before crossing.'],['uwbFallback','UWB fallback','Switch to local ranging when Wi-Fi quality degrades.']].map(s=>settingRow(...s)).join('')}</section>
  <section class="card"><div class="section-head"><div><b>MAP DISPLAY</b><small>Operator visualization</small></div></div>${[['routes','Show route network','Display active, planned, rerouted and trajectory paths.'],['conflicts','Show conflict zones','Display predicted conflict circles and IDs.'],['ids','Show robot IDs','Display robot labels on the live map.']].map(s=>settingRow(...s)).join('')}<div class="setting"><div class="setting-row"><div><b>Map resolution</b><p>Vector map rendering and display density.</p></div><select class="select" onchange="setMapResolution(this.value)"><option ${mapResolution===1?'selected':''}>High</option><option ${mapResolution===1.15?'selected':''}>Ultra</option></select></div></div></section>
  <section class="card"><div class="section-head"><div><b>SIMULATION</b><small>Realistic warehouse motion</small></div></div><div class="setting"><div class="setting-row"><div><b>Movement speed</b><p>Robots use gradual acceleration and a warehouse-safe crawl.</p></div><select class="select" onchange="setSimulationSpeed(this.value)"><option ${settings.simulationSpeed==='Very slow'?'selected':''}>Very slow</option><option ${settings.simulationSpeed==='Slow'?'selected':''}>Slow</option><option ${settings.simulationSpeed==='Normal'?'selected':''}>Normal</option><option ${settings.simulationSpeed==='Fast'?'selected':''}>Fast</option></select></div></div><div class="setting"><div class="setting-row"><div><b>Telemetry refresh</b><p>How often the dashboard panels refresh.</p></div><select class="select" onchange="setTelemetryRefresh(this.value)"><option ${settings.telemetryRefresh==='Real-time'?'selected':''}>Real-time</option><option ${settings.telemetryRefresh==='500 ms'?'selected':''}>500 ms</option><option ${settings.telemetryRefresh==='1.5 s'?'selected':''}>1.5 s</option></select></div></div></section>
  <section class="card"><div class="section-head"><div><b>ROBOT AVAILABILITY</b><small>Choose which robots are online</small></div><button onclick="setAllRobotsOffline(false)">Set all online</button></div><div class="offline-list">${robotControls}</div></section>
  <section class="card pickup-settings"><div class="section-head"><div><b>PICKUP STOPS</b><small>Load collection points placed on aisle centre-lines</small></div></div>${pickupStops.map(p=>`<div class="pickup-setting-row"><b>${p.id}</b><span>${p.label}</span><small>${p.x}, ${p.y} · legal aisle stop</small></div>`).join('')}</section>
  <section class="card"><div class="section-head"><div><b>SYSTEM STATUS</b><small>Current configuration</small></div></div><div class="setting"><b>Controller</b><p>Shortest-path planner · priority arbitration · junction reservations</p></div><div class="setting"><b>Warehouse</b><p>WH-01 · North Zone · rack-safe aisle graph</p></div><div class="setting"><b>State schema</b><p>Coordinates · status · pickup stop · destination · route nodes · trajectory · conflicts.</p></div></section></div><div class="setting-note">Demo environment only. All robot commands, pickup stops, routing and offline controls are simulated in the browser.</div>`;
}
function settingRow(key,label,desc){return `<div class="setting"><div class="setting-row"><div><b>${label}</b><p>${desc}</p></div><button class="toggle ${settings[key]?'on':''}" onclick="toggleSetting('${key}',!settings['${key}'])"><i></i></button></div></div>`}
const names={overview:['Overview','Real-time warehouse fleet monitoring and coordination'],robots:['Live Fleet','Monitor and control autonomous robots'],map:['Warehouse Map','Live navigation, routes and conflict zones'],tasks:['Tasks','Manage pickup, delivery and charging tasks'],conflicts:['Conflicts','Predicted collisions and resolution status'],routing:['Rerouting','Dynamic route selection and congestion handling'],communication:['Communication','Fleet network and edge communication'],analytics:['Analytics','Fleet performance and operational insights'],settings:['Settings','System and simulation preferences']};

function refreshSidebarStats(){const online=robots.filter(r=>r.status!=='OFFLINE').length;const count=document.querySelector('#robotCount');if(count)count.textContent=online;const foot=document.querySelector('.side-foot b');if(foot)foot.textContent=`${online}/8`;}

function showPage(p){
  activePage=p;
  document.querySelectorAll('.nav').forEach(x=>x.classList.toggle('active',x.dataset.page===p));
  [title.textContent,subtitle.textContent]=names[p];
  if(p==='overview')overview();else if(p==='robots')robotsPage();else if(p==='map')mapPage();else if(p==='tasks')tasksPage();else if(p==='conflicts')conflictsPage();else if(p==='routing')routingPage();else if(p==='communication')communicationPage();else if(p==='analytics')analyticsPage();else if(p==='settings')settingsPage();
  refreshSidebarStats();
  requestAnimationFrame(()=>applyZoom());
}

function selectRobot(id){selected=id; activePage='map'; showPage('map'); requestAnimationFrame(()=>{updateMapDom(); const el=document.querySelector(`[data-robot=\"${id}\"]`); if(el)el.classList.add('selected');}); toastMsg(`${id} selected · showing live path`)}
function buildShortestMission(r,pickupId,destination){
  const start=nearestNode([r.x,r.y]);const pickup=pickupNodes[pickupId];const pickupAnchor=nearestNode(pickup);const toPickup=shortestNodePath(start,pickupAnchor);const toDestination=shortestNodePath(pickupAnchor,destination);return [...toPickup,pickupId,...toDestination.slice(1)];
}
function sendRobot(id){const r=robots.find(x=>x.id===id);if(!r||r.status==='OFFLINE'){toastMsg(`${id} is offline`);return;} const pickup=r.pickup||'PB2';const dest=r.destination&&nodes[r.destination]?r.destination:'JD3';r.route=buildShortestMission(r,pickup,dest);r.plannedRoute=r.route.slice();r.segment=0;r.t=0;r.status='NAVIGATING';r.speed=0;r.task=`Shortest path → pickup ${pickup}`;pickupProgress[r.id]=false;running=true;toastMsg(`${id} dispatched on shortest rack-safe path`);showPage('robots')}
function pauseRobot(id){const r=robots.find(x=>x.id===id);if(!r||r.status==='OFFLINE')return;r.status=r.status==='WAITING'?'NAVIGATING':'WAITING';r.speed=r.status==='WAITING'?0:speedProfiles[settings.simulationSpeed];toastMsg(`${id} ${r.status==='WAITING'?'waiting at safe point':'resumed'}`);showPage('robots')}
function stopRobot(id){const r=robots.find(x=>x.id===id);r.status='IDLE';r.speed=0;toastMsg(`Emergency stop: ${id}`);showPage('robots')}
function resumeFleet(){running=true;robots.forEach(r=>{if(r.status==='OFFLINE'||(r.id==='R06'&&r.routingState==='REROUTING'))return;if(r.status==='WAITING'){r.status='NAVIGATING';r.speed=speedProfiles[settings.simulationSpeed];} });toastMsg('Simulation resumed — only active missions move');if(activePage==='map')updateMapInsights();else showPage(activePage)}
function pauseFleet(){running=false;robots.forEach(r=>{if(r.status==='NAVIGATING'){r.status='WAITING';r.speed=0}});toastMsg('Fleet paused');showPage(activePage)}
function stopFleet(){running=false;robots.forEach(r=>{r.status='IDLE';r.speed=0});toastMsg('EMERGENCY STOP issued to fleet');showPage(activePage)}
function resolveConflict(id){const c=conflicts.find(x=>x.id===id);if(c)c.status='RESOLVED';toastMsg(`${id} resolved — alternate path reserved`);showPage('conflicts')}
function resolveAll(){conflicts.forEach(c=>c.status='RESOLVED');toastMsg('All safe conflicts resolved by priority arbitration');showPage('conflicts')}
function runReroute(){toastMsg('Route optimizer found 2 safe alternate paths');}
function toggleSetting(key,value){settings[key]=value;toastMsg(`${key} ${value?'enabled':'disabled'}`);showPage(activePage)}
function setRobotOffline(id,offline){const r=robots.find(x=>x.id===id);if(!r)return;settings.offlineRobots[id]=offline;if(offline){r.status='OFFLINE';r.speed=0;}else{r.status='IDLE';r.speed=0;}refreshSidebarStats();toastMsg(`${id} ${offline?'set offline':'back online'}`);showPage('settings')}
function setAllRobotsOffline(offline){robots.forEach(r=>{settings.offlineRobots[r.id]=offline;r.status=offline?'OFFLINE':'IDLE';r.speed=0});refreshSidebarStats();toastMsg(offline?'All robots offline':'All robots online');showPage('settings')}
function setSimulationSpeed(value){settings.simulationSpeed=value;const base=speedProfiles[value]||.22;robots.forEach(r=>{if(r.status==='NAVIGATING')r.speed=base});toastMsg(`Movement profile: ${value}`);showPage('settings')}
function setTelemetryRefresh(value){settings.telemetryRefresh=value;clearInterval(telemetryTimer);const ms=value==='500 ms'?500:value==='1.5 s'?1500:0;if(ms)telemetryTimer=setInterval(()=>{if(document.querySelector('#trajectoryDetails'))updateMapInsights()},ms);toastMsg(`Telemetry refresh: ${value}`);showPage('settings')}
function setMapResolution(value){mapResolution=value==='Ultra'?1.15:1;document.documentElement.style.setProperty('--map-resolution',mapResolution);document.querySelectorAll('.warehouse').forEach(el=>el.style.minHeight=mapResolution>1?'540px':'500px');toastMsg(`Map resolution: ${value}`);showPage(activePage)}
function zoomMap(n){zoom=Math.max(.9,Math.min(1.35,zoom+n*.12));applyZoom();toastMsg(`Map zoom ${Math.round(zoom*100)}%`)}
function resetMap(){zoom=1;applyZoom();toastMsg('Map view reset')}
function applyZoom(){document.querySelectorAll('.warehouse-canvas').forEach(el=>el.style.transform=`scale(${zoom})`)}

function distanceToNode(r,nodeName){
  const p=nodes[nodeName];
  return p?Math.hypot(r.x-p[0],r.y-p[1]):Infinity;
}

function routeDistance(route, fromSegment=0, fromT=0){
  let d=0;
  if(!route || route.length<2) return 0;
  const firstA=allNodes[route[fromSegment]], firstB=allNodes[route[fromSegment+1]];
  if(firstA&&firstB) d += Math.hypot(firstB[0]-firstA[0],firstB[1]-firstA[1])*(1-fromT);
  for(let i=fromSegment+1;i<route.length-1;i++){
    const a=allNodes[route[i]],b=allNodes[route[i+1]];
    if(a&&b)d+=Math.hypot(b[0]-a[0],b[1]-a[1]);
  }
  return d;
}
function routeETA(r, route=r.route){
  const speed=Math.max(.08,speedProfiles[settings.simulationSpeed]||.22);
  return routeDistance(route,r.segment,r.t)/10/speed;
}
function routeHasNodeAhead(r,node){
  if(!r.route) return false;
  for(let i=r.segment+1;i<r.route.length;i++) if(r.route[i]===node) return true;
  return false;
}
function predictJunctionConflicts(){
  if(!settings.collisionGuard) return [];
  const predictions=[];
  const moving=robots.filter(r=>r.status==='NAVIGATING' && r.status!=='OFFLINE');
  for(let i=0;i<moving.length;i++) for(let j=i+1;j<moving.length;j++){
    const a=moving[i],b=moving[j];
    Object.keys(nodes).forEach(node=>{
      if(!routeHasNodeAhead(a,node)||!routeHasNodeAhead(b,node)) return;
      const ea=routeETA(a,a.route.slice(a.segment));
      const eb=routeETA(b,b.route.slice(b.segment));
      if(Math.abs(ea-eb)<4.0 && Math.min(ea,eb)<12){
        const key=[a.id,b.id,node].sort().join('|');
        if(!predictionCooldown[key] || performance.now()-predictionCooldown[key]>6000){
          predictionCooldown[key]=performance.now();
          predictions.push({node,a,b,ea,eb,priority:a.id<b.id?a:b});
        }
      }
    });
  }
  return predictions;
}
function chooseYieldRobot(a,b){
  // Deterministic priority: loaded payloads first, then lower ETA, then robot id.
  if(a.payload==='Loaded' && b.payload!=='Loaded') return b;
  if(b.payload==='Loaded' && a.payload!=='Loaded') return a;
  const ea=routeETA(a),eb=routeETA(b);
  if(Math.abs(ea-eb)>0.5) return ea<eb?b:a;
  return a.id.localeCompare(b.id)<0?b:a;
}
function safeAlternateRoute(r, conflictNode){
  const current=r.route;
  const start=current[r.segment] || nearestNode([r.x,r.y]);
  const destination=r.destination && nodes[r.destination] ? r.destination : nearestNode(current.length?allNodes[current[current.length-1]]:[r.x,r.y]);
  if(!start||!destination) return null;
  // Try shortest legal paths while excluding the predicted conflict junction.
  const originalGraph=graph[conflictNode]||[];
  const saved=originalGraph.slice();
  graph[conflictNode]=[];
  const alt=shortestNodePath(start,destination);
  graph[conflictNode]=saved;
  if(alt.length<2 || alt.includes(conflictNode)) return null;
  return alt;
}
function triggerPredictedAvoidance(){
  collisionRobots.clear();
  const preds=predictJunctionConflicts();
  preds.forEach(p=>{ collisionRobots.add(p.a.id); collisionRobots.add(p.b.id); });
  preds.forEach(p=>{
    const yieldRobot=chooseYieldRobot(p.a,p.b);
    if(yieldRobot.status==='OFFLINE' || yieldRobot.routingState==='REROUTING') return;
    const alt=safeAlternateRoute(yieldRobot,p.node);
    const now=performance.now();
    // Never teleport. Mark the robot as yielding and let it physically reach
    // a safe point before the alternate route is installed.
    yieldRobot.waitingFor=p.priority.id===yieldRobot.id?null:p.priority.id;
    yieldRobot.avoidanceNode=p.node;
    yieldRobot.rerouteReason=`Predicted collision at ${p.node}`;
    yieldRobot.waitUntil=now+2200;
    yieldRobot.status='WAITING';
    yieldRobot.speed=0;
    if(alt && settings.autoReroute){
      yieldRobot.originalRouteAtConflict=yieldRobot.route.slice();
      yieldRobot.pendingAlternateRoute=alt;
      yieldRobot.routingState='REROUTING';
      const rr=reroutes.find(x=>x.robot===yieldRobot.id) || {id:`RR-${String(Date.now()).slice(-3)}`,robot:yieldRobot.id,from:'Current mission',reason:'Predicted collision',via:'Alternate aisle',gain:'—',state:'ACTIVE'};
      rr.state='ACTIVE'; rr.reason=`Predicted collision at ${p.node}`; rr.via=alt.join(' → ');
      if(!reroutes.includes(rr)) reroutes.unshift(rr);
      events.unshift(['LIVE','Collision avoidance',`${yieldRobot.id} yielding before ${p.node} · predicted trajectory conflict`,'red']);
    } else {
      yieldRobot.routingState='WAITING';
      yieldRobot.pendingAlternateRoute=null;
    }
  });
  return preds;
}
function randomChoice(arr){return arr[Math.floor(Math.random()*arr.length)];}
function assignNewTask(r){
  if(r.status==='OFFLINE') return;
  const candidates=Object.keys(pickupNodes).filter(id=>id!==r.pickup);
  const pickup=randomChoice(candidates);
  const pickupJunction=nearestNode(pickupNodes[pickup]);
  const destinations=['JA1','JD1','JA4','JD4','JA2','JD2','JA3','JD3'].filter(n=>n!==pickupJunction);
  const dest=randomChoice(destinations);
  const base=shortestNodePath(nearestNode([r.x,r.y]),pickupJunction);
  const route=base.length?base.concat([pickup,...shortestNodePath(pickupJunction,dest).slice(1)]):[pickup,dest];
  r.route=route;
  r.plannedRoute=route.slice();
  r.destination=dest;
  r.pickup=pickup;
  r.segment=0;
  r.t=0;
  r.trajectory=[[r.x,r.y]];
  r.payload='Empty';
  r.status='NAVIGATING';
  r.routingState='NORMAL';
  r.task=`Auto-assigned: pickup at ${pickup}`;
  r.waitingFor=null;
  r.waitUntil=0;
  r.speed=0;
  events.unshift(['LIVE','New task assigned',`${r.id} · ${pickup} → ${dest}`,'green']);
}
function advanceRobot(r,dt){
  if(!running || r.status!=='NAVIGATING' || r.route.length<2 || r.status==='OFFLINE') return;
  const a=allNodes[r.route[r.segment]],b=allNodes[r.route[r.segment+1]];
  if(!a||!b) return;
  const nextNode=r.route[r.segment+1];
  const isJunction=!!nodes[nextNode];

  // Junction reservation: only one robot may occupy the conflict box.
  if(settings.collisionGuard && isJunction){
    const owner=junctionReservations[nextNode];
    if(owner && owner!==r.id){
      r.status='WAITING'; r.speed=0; r.waitingFor=owner; r.waitUntil=performance.now()+900; return;
    }
    const occupiedBy=robots.find(o=>o.id!==r.id && o.status!=='OFFLINE' && Math.hypot(o.x-b[0],o.y-b[1])<24);
    if(occupiedBy){
      r.status='WAITING'; r.speed=0; r.waitingFor=occupiedBy.id; r.waitUntil=performance.now()+900; return;
    }
    const dist=Math.hypot(r.x-b[0],r.y-b[1]);
    if(dist<WAIT_RADIUS) junctionReservations[nextNode]=r.id;
  }

  const targetSpeed=speedProfiles[settings.simulationSpeed]||.22;
  const segmentPx=Math.max(1,Math.hypot(b[0]-a[0],b[1]-a[1]));
  // Realistic acceleration/deceleration rather than frame-dependent jumps.
  r.speed += (targetSpeed-r.speed)*Math.min(1,dt/2600);
  const travelPx=(r.speed*dt/1000)*10;
  r.t += travelPx/segmentPx;

  if(r.t>=1){
    r.t=0;
    r.segment=Math.min(r.segment+1,r.route.length-2);
    r.x=b[0]; r.y=b[1];
    if(junctionReservations[nextNode]===r.id) delete junctionReservations[nextNode];

    const landed=r.route[r.segment];
    if(pickupNodes[landed] && !r.pickupLoaded){
      r.pickupLoaded=true; r.status='WAITING'; r.speed=0; r.payload='Loaded';
      r.task=`Loading at ${landed}`; r.waitUntil=performance.now()+3200; return;
    }
    if(r.segment===r.route.length-2){
      r.x=allNodes[r.route[r.segment+1]][0]; r.y=allNodes[r.route[r.segment+1]][1];
      r.status='IDLE'; r.speed=0; r.task='Mission complete'; r.pickupLoaded=false;
      setTimeout(()=>{if(r.status==='IDLE'&&settings.offlineRobots[r.id]!==true)assignNewTask(r);},900);
      return;
    }
  }

  const aa=allNodes[r.route[r.segment]],bb=allNodes[r.route[r.segment+1]];
  if(!aa||!bb) return;
  r.x=aa[0]+(bb[0]-aa[0])*r.t;
  r.y=aa[1]+(bb[1]-aa[1])*r.t;
  const last=r.trajectory[r.trajectory.length-1]||[];
  if(!last.length||Math.hypot(r.x-last[0],r.y-last[1])>0.7){
    r.trajectory.push([r.x,r.y]); if(r.trajectory.length>720) r.trajectory.shift();
  }
  r.battery=Math.max(8,r.battery-r.speed*dt*0.000001);
}
function updateMapDom(){
  const svg=document.querySelector('#warehouseSvg');
  if(!svg)return;
  robots.forEach(r=>{
    const el=svg.querySelector(`[data-robot="${r.id}"]`);
    if(el){el.setAttribute('transform',`translate(${r.x.toFixed(2)},${r.y.toFixed(2)})`);el.classList.toggle('selected',r.id===selected);}
    const live=svg.querySelector(`.robot-route-live-${r.id}`);
    const planned=svg.querySelector(`.robot-route-${r.id}`);
    const tr=svg.querySelector(`.trajectory-${r.id}`);
    const visible=r.id===selected;
    if(live){live.setAttribute('d',routePath(r.route));live.classList.toggle('path-collision',visible&&collisionRobots.has(r.id));live.style.display=visible?'':'none';}
    if(planned){planned.setAttribute('d',routePath(r.plannedRoute||r.route));planned.style.display=visible?'':'none';}
    if(tr){tr.setAttribute('d',trajectoryPath(r));tr.style.display=visible?'':'none';}
  });
  const reroute=svg.querySelector('.reroute-route');
  if(reroute){const r=robots.find(x=>x.id===selected);reroute.setAttribute('d',routePath(r?.alternateRoute||[]));reroute.style.display=(r&&r.routingState!=='NORMAL'&&r.alternateRoute)?'':'none';reroute.classList.toggle('path-collision',!!(r&&collisionRobots.has(r.id)));}
  svg.querySelectorAll('.conflict-zone').forEach(z=>{ const text=z.textContent||''; const selectedHit=selected && text.includes(selected); z.style.display=(settings.conflicts && selectedHit)?'':'none'; z.classList.toggle('selected-conflict',selectedHit&&collisionRobots.has(selected)); });
  updateMapInsights();
  const tooltip=document.querySelector('#robotTooltip');
  if(tooltip&&tooltip.dataset.robot){const r=robots.find(x=>x.id===tooltip.dataset.robot);if(r)tooltip.innerHTML=`<b>${r.id}</b><span>Battery ${Math.round(r.battery)}%</span><span>Payload ${esc(r.payload)}</span><span>Speed ${r.speed.toFixed(1)} m/s</span><span>${collisionRobots.has(r.id)?'⚠ Collision path predicted':'✓ Path clear'}</span>`}
}
function updateMapInsights(){
  const t=document.querySelector('#trajectoryDetails');
  const rr=document.querySelector('#rerouteDetails');
  if(t){
    const r=robots.find(x=>x.id===selected)||robots.find(x=>x.trajectory?.length>1)||robots[0];
    const points=r.trajectory?.length||0;
    t.innerHTML=`<div class="insight-main"><b>${r.id}</b><span>${r.status}</span></div><div class="insight-grid"><div><small>TRAVELLED</small><b>${Math.max(0,Math.round(points*0.12))} m</b></div><div><small>TRACE POINTS</small><b>${points}</b></div><div><small>SPEED</small><b>${r.speed.toFixed(2)} m/s</b></div></div><div class="trace-line"><i style="width:${Math.min(100,Math.max(8,points/1.8))}%"></i></div><small class="muted">Trajectory = actual travelled path. Red = predicted collision path; dashed = planned path.</small>`;
  }
  if(rr){
    const r=robots.find(x=>x.id==='R06');
    const state=r?.routingState||'NORMAL';
    rr.innerHTML=`<div class="reroute-step ${state!=='NORMAL'?'done':''}"><span>01</span><div><b>Conflict predicted</b><small>C-025 · R06 ↔ R04 · JB1</small></div></div><div class="reroute-step ${state==='REROUTING'||state==='REROUTED'||state==='COMPLETE'?'done':''}"><span>02</span><div><b>Collision avoidance</b><small>R06 slows and yields junction priority</small></div></div><div class="reroute-step ${state==='REROUTED'||state==='COMPLETE'?'done':''}"><span>03</span><div><b>Alternate route reserved</b><small>Original: JB2 → JB1 → JC1 · New: JB2 → JB3 → JC3 → JC2 → JC1</small></div></div><div class="reroute-state ${state}">${state==='NORMAL'?'Monitoring':state==='REROUTING'?'REROUTING IN PROGRESS':state==='REROUTED'?'REROUTED · SAFE':'ROUTE COMPLETE'}</div>`;
  }
}

function bindMapInteractions(){
  document.querySelectorAll('.robot-marker').forEach(el=>{
    el.addEventListener('mouseenter',()=>{
      const id=el.dataset.robot;const r=robots.find(x=>x.id===id);const tip=document.querySelector('#robotTooltip');if(!r||!tip)return;
      tip.dataset.robot=id;tip.innerHTML=`<b>${r.id}</b><span>Battery ${Math.round(r.battery)}%</span><span>Payload ${esc(r.payload)}</span><span>Speed ${r.speed.toFixed(1)} m/s</span>`;tip.classList.add('show');
    });
    el.addEventListener('mouseleave',()=>document.querySelector('#robotTooltip')?.classList.remove('show'));
    el.addEventListener('click',()=>selectRobot(el.dataset.robot));
  });
}

function releaseWaitingRobots(now){
  robots.forEach(r=>{
    if(r.status!=='WAITING'||r.status==='OFFLINE') return;
    if(r.waitUntil && now<r.waitUntil) return;
    const owner=r.waitingFor && robots.find(o=>o.id===r.waitingFor && o.status!=='OFFLINE');
    if(owner && Math.hypot(r.x-owner.x,r.y-owner.y)<34){
      r.waitUntil=now+700;
      return;
    }
    // If a reroute was predicted, install it from the current route segment
    // without changing x/y. Keeping the current t prevents teleportation.
    if(r.routingState==='REROUTING' && r.pendingAlternateRoute){
      const alt=r.pendingAlternateRoute.slice();
      const anchor=r.route[r.segment];
      if(anchor && alt[0]===anchor){
        r.route=alt;
        r.plannedRoute=r.originalRouteAtConflict||r.plannedRoute;
        r.segment=0;
        // Preserve the physical progress on the current segment only when the
        // first alternate segment starts at the same node.
        r.t=Math.min(0.98,Math.max(0,r.t));
      } else {
        // Wait until a route node is actually reached before switching paths.
        r.waitUntil=now+800; return;
      }
      r.pendingAlternateRoute=null;
      r.routingState='REROUTED';
      r.waitingFor=null;
      r.status='NAVIGATING';
      r.speed=0;
      events.unshift(['LIVE','Reroute active',`${r.id} resumed on safe alternate path`,'amber']);
      return;
    }
    if(r.waitingFor){
      const other=robots.find(o=>o.id===r.waitingFor && o.status!=='OFFLINE');
      if(other && Math.hypot(r.x-other.x,r.y-other.y)<34){r.waitUntil=now+700;return;}
      r.waitingFor=null;
    }
    r.status='NAVIGATING';
    r.speed=0;
    r.waitUntil=0;
  });
}
function animate(now){
  const dt=Math.min(50,now-lastFrame);lastFrame=now;
  releaseWaitingRobots(now);if(settings.collisionGuard) triggerPredictedAvoidance();robots.forEach(r=>advanceRobot(r,dt));
  warehouseState.updatedAt=new Date().toISOString();
  if(document.querySelector('#warehouseSvg'))updateMapDom();
  requestAnimationFrame(animate);
}

// Initial fleet allocation: every available robot receives a fresh, randomized mission.
// Charging is still represented by the task state, but no robot follows a permanently fixed demo path.
robots.forEach((r,index)=>{
  if(r.status==='OFFLINE') return;
  r.status='IDLE'; r.speed=0; r.routingState='NORMAL'; r.pickupLoaded=false;
  assignNewTask(r);
  // Stagger dispatch by a few control cycles to avoid an artificial startup jam.
  r.startDelay=(index%4)*650;
  r.waitUntil=performance.now()+r.startDelay;
  r.status='WAITING';
});

// Nav + theme controls.
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>showPage(b.dataset.page));
document.querySelector('#theme').onclick=()=>{dark=!dark;document.body.classList.toggle('light',!dark);document.querySelector('#theme span').textContent=dark?'Dark':'Light';document.querySelector('#theme').firstChild.textContent=dark?'☾ ':'☀ ';toastMsg(`${dark?'Dark':'Light'} mode enabled`)};

showPage('overview');
requestAnimationFrame(animate);

/* Demo authentication gate for Navसेतु. Frontend-only demo; not production security. */
(function initNavsetuLogin(){
  const loginScreen=document.querySelector('#loginScreen');
  const app=document.querySelector('#app');
  const form=document.querySelector('#loginForm');
  const user=document.querySelector('#loginUser');
  const pass=document.querySelector('#loginPass');
  const error=document.querySelector('#loginError');
  const toggle=document.querySelector('#togglePass');
  const logout=document.querySelector('#logoutBtn');
  if(!loginScreen||!app||!form) return;
  const AUTH_KEY='navsetu_demo_authenticated';
  function showDashboard(){loginScreen.style.display='none';app.classList.remove('auth-hidden');}
  function showLogin(){loginScreen.style.display='flex';app.classList.add('auth-hidden'); user.value='';pass.value='';error.textContent='';}
  if(sessionStorage.getItem(AUTH_KEY)==='true') showDashboard(); else showLogin();
  form.addEventListener('submit',function(e){
    e.preventDefault();
    const u=user.value.trim(), p=pass.value;
    if(u==='operator' && p==='navsetu123'){
      sessionStorage.setItem(AUTH_KEY,'true');
      error.textContent='';
      showDashboard();
      if(typeof toastMsg==='function') toastMsg('Signed in successfully');
    } else {
      error.textContent='Invalid username or password. Use the demo credentials below.';
      pass.select();
    }
  });
  toggle.addEventListener('click',function(){const hidden=pass.type==='password';pass.type=hidden?'text':'password';toggle.textContent=hidden?'Hide':'Show';});
  if(logout) logout.addEventListener('click',function(){sessionStorage.removeItem(AUTH_KEY);showLogin();});
})();
