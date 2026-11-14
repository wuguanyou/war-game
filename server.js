/* 風起群島 V5.1 — dependency-free authoritative prototype server */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const SIZE = 32, TILE = 28, TICK = 100;
const MID = SIZE / 2, BASE_X = [3, SIZE - 4];
const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
const WORK_RANGE = 1.1;
const RESOURCES = ['food','wood','stone','gold'];
const UNIT = {
  villager: {name:'村民',hp:70,speed:2.35,vision:4,range:0.8,damage:4,interval:1.1,cost:{food:45},time:13,canGather:true},
  sword: {name:'劍士',hp:145,speed:2.8,vision:4,range:1.25,damage:23,buildingDamage:18,interval:.9,cost:{food:55,wood:15},time:12},
  archer: {name:'弓箭手',hp:88,speed:2.65,vision:6,range:5.2,damage:17,buildingDamage:6,interval:1.15,cost:{food:45,wood:28},time:14},
  pike: {name:'長槍兵',hp:128,speed:2.55,vision:4,range:1.35,damage:20,buildingDamage:10,interval:1,cost:{food:55,wood:20},time:13},
  siege: {name:'攻城車',hp:230,speed:1.25,vision:3.5,range:3.1,damage:74,buildingDamage:90,interval:2.3,cost:{wood:70,stone:55,gold:20},time:27,siege:true}
};
const BUILDING_DPS=Object.fromEntries(Object.entries(UNIT).filter(([,unit])=>unit.buildingDamage).map(([type,unit])=>[
  type,Math.round(unit.buildingDamage/unit.interval*10)/10
]));
const BUILDING = {
  base: {name:'主基地',hp:1500,vision:7},
  barracks: {name:'兵營',hp:560,vision:2,cost:{wood:100,stone:35},time:12,buildOn:'land'},
  tower: {name:'防禦塔',hp:410,vision:7,cost:{wood:42,stone:58},time:11,buildOn:'land',range:5.8,damage:18,interval:1.1},
  wall: {name:'城牆',hp:420,vision:1,cost:{stone:20},time:5,buildOn:'land'},
  gate: {name:'城門',hp:320,vision:2,cost:{wood:25,stone:25},time:7,buildOn:'land'},
  farm: {name:'農場',hp:280,vision:2,cost:{wood:52},time:9,buildOn:'land',foodRate:0.19},
  gather: {name:'採集站',hp:330,vision:2,cost:{wood:45,stone:18},time:9,buildOn:'resource'}
};
const RESOURCE_META = {
  wood:{name:'木材',icon:'🌲',amount:[90,145]},
  stone:{name:'石材',icon:'⛰️',amount:[100,175]},
  gold:{name:'黃金',icon:'✦',amount:[35,70]},
  food:{name:'糧食',icon:'🍓',amount:[45,80]}
};
const rooms = new Map();
const sockets = new Set();
let nextUnit = 1, nextBuilding = 1;

function rngFor(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)|0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
function idx(x,y){return y*SIZE+x;}
function xy(i){return {x:i%SIZE,y:Math.floor(i/SIZE)};}
function inside(x,y){return Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<SIZE&&y<SIZE;}
function insideIsland(x,y){const dx=(x+.5-SIZE/2)/(SIZE/2),dy=(y+.5-SIZE/2)/(SIZE/2);return dx**4+dy**4<=1;}
function unitCount(g,p){return g.units.filter(u=>u.owner===p).length;}
function makeUnit(g,owner,type,x,y){const d=UNIT[type];return{id:`u${nextUnit++}`,owner,type,x:x+.5,y:y+.5,hp:d.hp,maxHp:d.hp,order:null,path:[],stance:'aggressive',cooldown:0,think:0,selectedBy:0};}
function makeBuilding(owner,type,x,y,complete=true){const d=BUILDING[type];return{id:`b${nextBuilding++}`,owner,type,x,y,hp:complete?d.hp:Math.ceil(d.hp*.25),maxHp:d.hp,underConstruction:!complete,progress:0,queue:[],cooldown:0,open:type==='gate'?false:undefined};}
function startGame(seed, names=['指揮官 A','指揮官 B']){
  const rnd=rngFor(seed),tiles=Array(SIZE*SIZE);
  for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE/2;x++){
    const safe=(x<=5&&Math.abs(y-MID)<=3);
    const onIsland=insideIsland(x,y);let terrain=onIsland?'grass':'water',resource=null,amount=0;
    if(onIsland&&!safe&&y!==MID){
      const r=rnd();
      if(r<.095)terrain='water';
      else if(r<.22){terrain='forest';resource='wood';}
      else if(r<.30){terrain='stone';resource='stone';}
      else if(r<.325){terrain='gold';resource='gold';}
      else if(r<.36){terrain='berry';resource='food';}
    }
    if(resource){const [lo,hi]=RESOURCE_META[resource].amount;amount=lo+Math.floor(rnd()*(hi-lo+1));}
    for(const xx of [x,SIZE-1-x])tiles[idx(xx,y)]={x:xx,y,terrain,resource,amount,owner:-1,hp:120,maxHp:120,building:null,variation:Math.floor(rnd()*4)};
  }
  // Guaranteed, mirrored approaches to wood, stone and food near each start.
  const guaranteed=[{dx:3,dy:-2,t:'forest',r:'wood'},{dx:4,dy:2,t:'stone',r:'stone'},{dx:5,dy:-1,t:'berry',r:'food'},{dx:5,dy:2,t:'forest',r:'wood'}];
  for(const q of guaranteed){const amount=RESOURCE_META[q.r].amount[0]+Math.floor(rnd()*(RESOURCE_META[q.r].amount[1]-RESOURCE_META[q.r].amount[0]+1));for(let p=0;p<2;p++){const bx=BASE_X[p],dir=p===0?1:-1,x=bx+dir*q.dx,y=MID+q.dy;const t=tiles[idx(x,y)];t.terrain=q.t;t.resource=q.r;t.amount=amount;}}
  const players=[0,1].map((p)=>({name:names[p]||`玩家 ${p+1}`,resources:{food:170,wood:145,stone:90,gold:35},base:{x:BASE_X[p],y:MID},connected:true}));
  const units=[];
  for(let p=0;p<2;p++){
    const bx=players[p].base.x,dir=p===0?1:-1;
    for(const [type,dx,dy] of [['villager',dir,0],['villager',dir,-1],['villager',dir,1],['villager',-dir,0],['sword',2*dir,0],['sword',2*dir,-1]])units.push(makeUnit(null,p,type,bx+dx,MID+dy));
    for(let y=MID-2;y<=MID+2;y++)for(let x=bx-2;x<=bx+2;x++){const t=tiles[idx(x,y)];if(t.terrain==='water'){t.terrain='grass';t.resource=null;t.amount=0;}t.owner=p;}
    tiles[idx(bx,MID)].building=makeBuilding(p,'base',bx,MID,true);
  }
  return {seed,tiles,players,units,elapsed:0,tick:0,ended:false,winner:-1,memories:[Array(SIZE*SIZE).fill(null),Array(SIZE*SIZE).fill(null)],visible:[new Set(),new Set()],ai:false,aiThink:0,log:[],effects:[]};
}
// makeUnit can be called before a game object exists; ids are process-unique.

function tileAt(g,x,y){if(!inside(x,y))return null;return g.tiles[idx(Math.floor(x),Math.floor(y))];}
function adjacentIndices(i){const {x,y}=xy(i);return DIRS.map(([dx,dy])=>[x+dx,y+dy]).filter(([a,b])=>inside(a,b)).map(([a,b])=>idx(a,b));}
function blocksPassage(b){return !!b&&!(b.type==='gate'&&!b.underConstruction&&b.open);}
function passable(g,i){
  const t=g.tiles[i];
  return !!t&&t.terrain!=='water'&&!blocksPassage(t.building)&&!(t.resource&&t.amount>0);
}
function findPath(g,startX,startY,goalIndex,blocked=-1){
  if(goalIndex===blocked||!passable(g,goalIndex))return null;
  return searchPath(g,startX,startY,i=>i===goalIndex,blocked);
}
function searchPath(g,startX,startY,isGoal,blocked=-1){
  const sx=Math.floor(startX),sy=Math.floor(startY);
  if(!inside(sx,sy))return null;
  const start=idx(sx,sy),prev=new Int32Array(SIZE*SIZE),queue=new Int32Array(SIZE*SIZE);
  prev.fill(-2);prev[start]=-1;queue[0]=start;
  let tail=1;
  for(let head=0;head<tail;head++){
    const current=queue[head];
    if(isGoal(current)){
      const path=[];
      for(let i=current;i!==start;i=prev[i])path.push(i);
      return path.reverse();
    }
    const x=current%SIZE,y=Math.floor(current/SIZE);
    for(const [dx,dy] of DIRS){
      const nx=x+dx,ny=y+dy;
      if(nx<0||nx>=SIZE||ny<0||ny>=SIZE)continue;
      const next=idx(nx,ny);
      if(prev[next]!==-2||next===blocked||!passable(g,next))continue;
      prev[next]=current;queue[tail++]=next;
    }
  }
  return null;
}
function center(i){const p=xy(i);return{x:p.x+.5,y:p.y+.5};}
function lineOfSight(g,a,b){
  let x0=Math.floor(a.x),y0=Math.floor(a.y),x1=Math.floor(b.x),y1=Math.floor(b.y);
  const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;let err=dx-dy;
  while(!(x0===x1&&y0===y1)){const e2=2*err;if(e2>-dy){err-=dy;x0+=sx;}if(e2<dx){err+=dx;y0+=sy;}if(x0===x1&&y0===y1)break;const t=tileAt(g,x0,y0);if(!t||blocksPassage(t.building))return false;}
  return true;
}
function visionFor(g,p){
  const v=new Set();const add=(x,y,r,circle=true)=>{const minX=Math.max(0,Math.floor(x-r)),maxX=Math.min(SIZE-1,Math.floor(x+r)),minY=Math.max(0,Math.floor(y-r)),maxY=Math.min(SIZE-1,Math.floor(y+r));for(let yy=minY;yy<=maxY;yy++)for(let xx=minX;xx<=maxX;xx++)if(!circle||Math.hypot(xx+.5-x,yy+.5-y)<=r)v.add(idx(xx,yy));};
  for(const t of g.tiles)if(t.owner===p)add(t.x+.5,t.y+.5,1.55,false);
  for(const u of g.units)if(u.owner===p)add(u.x,u.y,UNIT[u.type].vision,true);
  for(const t of g.tiles)if(t.building&&t.building.owner===p)add(t.x+.5,t.y+.5,BUILDING[t.building.type].vision||1.5,true);
  g.visible[p]=v;return v;
}
function updateVision(g){for(let p=0;p<2;p++)visionFor(g,p);}
const UNEXPLORED=Array.from({length:SIZE*SIZE},(_,i)=>{
  const {x,y}=xy(i);
  return {x,y,unseen:true,terrain:insideIsland(x,y)?null:'water'};
});
function serialize(g,p,previousTiles){
  const vis=g.visible[p],mem=g.memories[p];
  for(const i of vis){
    const {x,y,terrain,resource,amount,owner,hp,maxHp,building:b}=g.tiles[i];
    mem[i]={x,y,terrain,resource,amount,owner,hp,maxHp,building:b?{id:b.id,type:b.type,open:b.open,owner:b.owner,hp:b.hp,maxHp:b.maxHp,underConstruction:b.underConstruction,progress:b.progress,buildTime:b.buildTime}:null};
  }
  const tiles=[];
  for(let i=0;i<UNEXPLORED.length;i++){
    const memory=mem[i],visible=vis.has(i);
    const tile=memory?{...memory,visible,remembered:!visible}:UNEXPLORED[i];
    if(previousTiles){
      const signature=memory?JSON.stringify(tile):'';
      if(signature===previousTiles[i])continue;
      previousTiles[i]=signature;
    }
    tiles.push(tile);
  }
  const sees=(x,y)=>vis.has(idx(Math.floor(x),Math.floor(y)));
  const units=g.units.filter(u=>u.owner===p||sees(u.x,u.y)).map(u=>({
    id:u.id,owner:u.owner,type:u.type,x:u.x,y:u.y,hp:u.hp,maxHp:u.maxHp,stance:u.stance,moving:!!u.path?.length,
    work:u.work,workResource:u.workResource,facing:u.workFacing,strike:u.strike,hit:u.hit,
    order:u.owner===p&&u.order?{kind:u.order.kind,target:u.order.tile}:null
  }));
  const effects=g.effects.filter(e=>(e.owner===p||sees(e.x,e.y))&&(e.tx===undefined||sees(e.tx,e.ty)));
  const ownBuildings=[];for(const t of g.tiles)if(t.building&&t.building.owner===p)ownBuildings.push({id:t.building.id,x:t.x,y:t.y,type:t.building.type,open:t.building.open,hp:t.building.hp,maxHp:t.building.maxHp,underConstruction:t.building.underConstruction,progress:t.building.progress,buildTime:t.building.buildTime,queue:t.building.queue});
  const ownBase=g.tiles[idx(g.players[p].base.x,g.players[p].base.y)].building;
  const enemyBaseIndex=idx(g.players[1-p].base.x,g.players[1-p].base.y),enemySeen=vis.has(enemyBaseIndex);
  const logs=g.log.filter(x=>x.owner<0||x.owner===p||x.seenBy?.includes(p)).slice(0,10).map(({at,text})=>({at,text}));
  const mapUpdate=previousTiles?{tileChanges:tiles}:{tiles};
  return{type:'state',size:SIZE,room:g.roomId,slot:p,elapsed:g.elapsed,started:true,ended:g.ended,winner:g.winner,...mapUpdate,units,effects,buildings:ownBuildings,buildingDps:BUILDING_DPS,resources:g.players[p].resources,ownBaseHp:ownBase?.hp??0,enemyBaseVisible:enemySeen,enemyBaseHp:enemySeen?g.tiles[enemyBaseIndex].building?.hp:null,ownName:g.players[p].name,enemyName:g.players[1-p].name,logs,playerCount:2};
}
function validOwnedUnits(g,p,ids,types=null){return g.units.filter(u=>u.owner===p&&ids.includes(u.id)&&(!types||types.includes(u.type)));}
function pay(player,cost){if(!cost)return true;for(const [r,n] of Object.entries(cost))if((player.resources[r]||0)<n)return false;for(const [r,n] of Object.entries(cost))player.resources[r]-=n;return true;}
function moveOrder(g,u,goal,kind='move'){
  if(!inside(goal.x,goal.y))return false;const dest=idx(goal.x,goal.y),path=findPath(g,u.x,u.y,dest);if(path===null)return false;
  u.path=path;u.order=path.length?{kind,tile:dest}:null;return true;
}
function workPath(g,u,tileIndex){
  let best=null;
  for(const goal of adjacentIndices(tileIndex)){
    const path=findPath(g,u.x,u.y,goal,tileIndex);
    if(!path)continue;
    const c=center(goal);
    if(!path.length&&Math.hypot(u.x-c.x,u.y-c.y)>.05)path.push(goal);
    if(!best||path.length<best.length)best=path;
  }
  return best;
}
function workOrder(g,u,tileIndex,kind,path=workPath(g,u,tileIndex)){
  if(!path)return false;
  u.path=path;
  u.order={kind,tile:tileIndex,buildingId:kind==='build'?g.tiles[tileIndex].building.id:undefined};
  return true;
}
function attackOrder(g,u,target){u.order={kind:'attack',targetKind:target.kind,targetId:target.id??null,tile:target.tile??null,lastTargetCell:-1};u.path=[];u.think=0;}
function canBuild(type,t){if(!t||t.owner<0)return false;const d=BUILDING[type];if(!d||type==='base'||t.building||t.terrain==='water')return false;if(d.buildOn==='resource')return!!t.resource&&t.resource!=='food';return!t.resource;}
function applyCommand(g,p,msg){
  if(g.ended||!msg||typeof msg!=='object')return;
  const ids=Array.isArray(msg.units)?msg.units.filter(id=>typeof id==='string').slice(0,60):[];
  const selected=validOwnedUnits(g,p,ids),player=g.players[p];
  if(msg.action==='move'){
    if(!inside(msg.x,msg.y))return;const i=idx(msg.x,msg.y);if(!g.visible[p].has(i))return;
    let moved=0;for(const u of selected){const kind=u.stance==='aggressive'?'attackMove':'move';if(moveOrder(g,u,{x:msg.x,y:msg.y},kind))moved++;}if(selected.length&&!moved)sendTo(g,p,{type:'notice',text:'目的地被水域或建築阻擋，找不到通路。'});
  } else if(msg.action==='gather'){
    if(!inside(msg.x,msg.y)||!g.visible[p].has(idx(msg.x,msg.y)))return;const t=g.tiles[idx(msg.x,msg.y)];if(!t.resource||t.amount<=0)return;
    let sent=0;for(const u of selected)if(u.type==='villager'&&workOrder(g,u,idx(msg.x,msg.y),'gather'))sent++;if(!sent)sendTo(g,p,{type:'notice',text:'請選取可抵達資源旁空地的村民。'});
  } else if(msg.action==='attack'){
    if(!inside(msg.x,msg.y)||!g.visible[p].has(idx(msg.x,msg.y)))return;const i=idx(msg.x,msg.y),t=g.tiles[i];
    if(!selected.some(u=>u.type!=='villager')){sendTo(g,p,{type:'notice',text:'請先選取戰鬥單位。'});return;}
    if(t.building&&t.building.owner!==p){for(const u of selected)if(u.type!=='villager')attackOrder(g,u,{kind:'building',id:t.building.id,tile:i});return;}
    const enemy=g.units.find(u=>u.owner!==p&&Math.floor(u.x)===msg.x&&Math.floor(u.y)===msg.y&&g.visible[p].has(idx(Math.floor(u.x),Math.floor(u.y))));
    if(enemy){for(const u of selected)if(u.type!=='villager')attackOrder(g,u,{kind:'unit',id:enemy.id});return;}
    if(t.owner!==p&&t.building?.type!=='base'&&t.terrain!=='water'){
      const adjacent=adjacentIndices(i).some(n=>g.tiles[n].owner===p);
      if(!adjacent){sendTo(g,p,{type:'notice',text:'只能攻擊與我方領土相鄰的土地。'});return;}
      for(const u of selected)if(u.type!=='villager')attackOrder(g,u,{kind:'land',tile:i});
    }
  } else if(msg.action==='stance'){
    const stance=['aggressive','hold','force'].includes(msg.stance)?msg.stance:'aggressive';for(const u of selected){u.stance=stance;if(stance!=='aggressive'){u.order=null;u.path=[];}}
  } else if(msg.action==='gate'){
    if(!inside(msg.x,msg.y)||typeof msg.open!=='boolean')return;
    const gate=g.tiles[idx(msg.x,msg.y)].building;
    if(gate?.type!=='gate'||gate.owner!==p||gate.underConstruction||gate.open===msg.open)return;
    if(!msg.open&&g.units.some(u=>Math.floor(u.x)===msg.x&&Math.floor(u.y)===msg.y)){
      sendTo(g,p,{type:'notice',text:'城門下有單位，請清空門口再關門。'});
      return;
    }
    gate.open=msg.open;
  } else if(msg.action==='build'){
    const type=msg.building;if(!inside(msg.x,msg.y)||!Object.hasOwn(BUILDING,type)||type==='base')return;const i=idx(msg.x,msg.y),t=g.tiles[i];
    if(t.building?.owner===p&&t.building.underConstruction&&t.building.type===type){
      let resumed=false;
      for(const u of selected)if(u.type==='villager'&&workOrder(g,u,i,'build'))resumed=true;
      if(!resumed)sendTo(g,p,{type:'notice',text:'沒有村民可抵達工地旁。'});
      return;
    }
    if(t.owner!==p||!canBuild(type,t)){sendTo(g,p,{type:'notice',text:'建築需放在我方空地；採集站必須蓋在木、石或金資源格。'});return;}
    if(g.units.some(u=>Math.floor(u.x)===t.x&&Math.floor(u.y)===t.y)){sendTo(g,p,{type:'notice',text:'請先讓單位離開施工格。'});return;}
    const builders=selected.filter(u=>u.type==='villager').map(u=>({u,path:workPath(g,u,i)})).filter(b=>b.path);
    if(!builders.length){sendTo(g,p,{type:'notice',text:'先選取能到工地旁空地的村民。'});return;}
    const d=BUILDING[type];if(!pay(player,d.cost)){sendTo(g,p,{type:'notice',text:'資源不足，無法建造。'});return;}
    t.building=makeBuilding(p,type,t.x,t.y,false);t.building.buildTime=d.time;
    for(const {u,path} of builders)workOrder(g,u,i,'build',path);
    addLog(g,`${player.name}開始建造${d.name}。`,p,i);
  } else if(msg.action==='train'){
    const type=msg.unit;if(!Object.hasOwn(UNIT,type)||!inside(msg.x,msg.y))return;const t=g.tiles[idx(msg.x,msg.y)];const b=t.building;if(!b||b.owner!==p)return;
    if(b.underConstruction){sendTo(g,p,{type:'notice',text:'請等建築完工後再訓練。'});return;}
    const valid=type==='villager'?b.type==='base':b.type==='barracks';if(!valid){sendTo(g,p,{type:'notice',text:type==='villager'?'村民只能在主基地訓練。':'作戰單位需在兵營訓練。'});return;}
    if(b.queue.length>=5){sendTo(g,p,{type:'notice',text:'生產佇列已滿。'});return;}
    if(!pay(player,UNIT[type].cost)){sendTo(g,p,{type:'notice',text:'資源不足，無法生產。'});return;}
    b.queue.push({unit:type,remaining:UNIT[type].time});
  }
}
function addLog(g,text,owner=-1,tile=null){const seenBy=tile===null?[0,1]:[0,1].filter(p=>g.visible[p]?.has(tile));if(owner>=0&&!seenBy.includes(owner))seenBy.push(owner);g.log.unshift({at:g.elapsed,text,owner,seenBy});if(g.log.length>16)g.log.length=16;}
function sendTo(g,p,payload){const ws=g?.clients?.[p];if(ws)wsSend(ws,payload);}

function moveUnits(g,dt){
  for(const u of g.units){if(!u.path?.length)continue;const next=u.path[0];if(!passable(g,next)){
      const order=u.order;
      if(order?.kind==='move'||order?.kind==='attackMove'){
        if(!moveOrder(g,u,xy(order.tile),order.kind)){u.order=null;u.path=[];sendTo(g,u.owner,{type:'notice',text:'前方封住路線，部隊已停止。'});}
      }else if(order?.kind==='build'||order?.kind==='gather'){
        const site=g.tiles[order.tile];
        u.path=[];
        if((order.kind==='build'&&site.building?.id!==order.buildingId)||!workOrder(g,u,order.tile,order.kind)){u.order=null;sendTo(g,u.owner,{type:'notice',text:'沒有可抵達的工作位置。'});}
      }else u.path=[];
      if(!u.path.length)continue;
    }let budget=UNIT[u.type].speed*dt;u.moving=true;
    while(budget>0&&u.path.length&&passable(g,u.path[0])){const c=center(u.path[0]),dx=c.x-u.x,dy=c.y-u.y,d=Math.hypot(dx,dy);if(d<=budget){u.x=c.x;u.y=c.y;budget-=d;u.path.shift();}else{u.x+=dx/d*budget;u.y+=dy/d*budget;budget=0;}}
    if(!u.path.length){u.moving=false;if(u.order?.kind==='move'||u.order?.kind==='attackMove')u.order=null;}
  }
}
function resumeOrStop(g,u){const goal=u.order?.resumeMove;if(goal)moveOrder(g,u,goal,'attackMove');else{u.order=null;u.path=[];}}
function findTarget(g,u){const o=u.order;if(!o)return null;if(o.targetKind==='unit'){const target=g.units.find(x=>x.id===o.targetId&&x.owner!==u.owner);if(target)target.kind='unit';return target||null;}if(o.targetKind==='building'){for(const t of g.tiles)if(t.building?.id===o.targetId)return{kind:'building',building:t.building,tile:t};return null;}if(o.targetKind==='land')return{kind:'land',tile:g.tiles[o.tile]};return null;}
function pathToAttackRange(g,u,target,range){
  const ti=target.kind==='unit'?idx(Math.floor(target.x),Math.floor(target.y)):idx(target.tile.x,target.tile.y);
  if(u.order?.lastTargetCell===ti&&u.path?.length)return;
  if(u.order.retryPathAt>g.elapsed&&u.order.lastTargetCell===ti)return;
  const tx=target.kind==='unit'?target.x:target.tile.x+.5,ty=target.kind==='unit'?target.y:target.tile.y+.5;
  const path=searchPath(g,u.x,u.y,i=>{
    if(!passable(g,i)||(target.kind==='building'&&i===ti))return false;
    const c=center(i);
    return Math.hypot(c.x-tx,c.y-ty)<=range&&lineOfSight(g,c,{x:tx,y:ty});
  });
  u.order.lastTargetCell=ti;
  u.order.retryPathAt=path?0:g.elapsed+.5;
  u.path=path??[];
  if(path&&!path.length)path.push(idx(Math.floor(u.x),Math.floor(u.y)));
}
function damageUnit(g,u,damage,facing){
  u.hp-=damage;
  u.hit=g.elapsed;
  if(u.hp>0)return;
  const {id,owner,type,x,y}=u;
  g.effects.push({kind:'defeat',owner,type,x,y,facing,at:g.elapsed});
  g.units=g.units.filter(unit=>unit.id!==id);
  for(const attacker of g.units)if(attacker.order?.targetId===id)resumeOrStop(g,attacker);
}
function attackAndGather(g,dt){
  const vision=[g.visible[0],g.visible[1]];
  for(const u of g.units){if(u.hp<=0)continue;const d=UNIT[u.type];u.cooldown=Math.max(0,u.cooldown-dt);u.think-=dt;
    u.work=undefined;u.workResource=undefined;u.workFacing=undefined;
    if(u.order?.kind==='gather'){
      const t=g.tiles[u.order.tile];if(!t?.resource||t.amount<=0){u.order=null;u.path=[];continue;}
      const c=center(u.order.tile);
      if(u.path.length||Math.hypot(u.x-c.x,u.y-c.y)>WORK_RANGE)continue;
      const station=[u.order.tile,...adjacentIndices(u.order.tile)].some(i=>{
        const b=g.tiles[i].building;
        return b?.owner===u.owner&&b.type==='gather'&&!b.underConstruction;
      });
      u.work='gather';u.workResource=t.resource;u.workFacing=Math.sign(c.x-u.x)||undefined;
      const gatherers=g.units.filter(x=>x.owner===u.owner&&x.order?.kind==='gather'&&x.order.tile===u.order.tile).length;
      const base=.78*(station?1.55:1)/(1+Math.max(0,gatherers-1)*.45),gained=Math.min(t.amount,base*dt);t.amount-=gained;g.players[u.owner].resources[t.resource]+=gained;
      continue;
    }
    if(u.order?.kind==='build'){
      const t=g.tiles[u.order.tile],b=t?.building;if(!b||b.id!==u.order.buildingId){u.order=null;u.path=[];continue;}if(!b.underConstruction){u.order=null;u.path=[];continue;}
      const c=center(u.order.tile);if(Math.hypot(u.x-c.x,u.y-c.y)<=WORK_RANGE&&u.path.length===0){u.work='build';u.workFacing=Math.sign(c.x-u.x)||undefined;b.progress+=dt;if(b.progress>=b.buildTime){b.underConstruction=false;b.hp=b.maxHp;u.order=null;addLog(g,`${g.players[u.owner].name}完成${BUILDING[b.type].name}。`,u.owner,idx(t.x,t.y));}}
      continue;
    }
    let target=null;
    if(u.order?.kind==='attack'){
      target=findTarget(g,u);if(!target){resumeOrStop(g,u);continue;}
      if(target.kind==='unit'&&!vision[u.owner].has(idx(Math.floor(target.x),Math.floor(target.y)))){resumeOrStop(g,u);continue;}
      if(target.kind==='land'&&(target.tile.owner===u.owner||!adjacentIndices(idx(target.tile.x,target.tile.y)).some(i=>g.tiles[i].owner===u.owner))){u.order=null;u.path=[];continue;}
    } else if(u.stance!=='force'&&u.type!=='villager'&&u.think<=0&&(!u.order||u.order.kind==='attackMove')){u.think=.35;const resume=u.order?.kind==='attackMove'?xy(u.order.tile):null,limit=u.stance==='hold'?d.range:Math.min(d.vision,4.5);const enemy=g.units.filter(x=>x.owner!==u.owner&&vision[u.owner].has(idx(Math.floor(x.x),Math.floor(x.y)))&&Math.hypot(u.x-x.x,u.y-x.y)<=limit&&(u.stance!=='hold'||lineOfSight(g,u,x))).sort((a,b)=>Math.hypot(u.x-a.x,u.y-a.y)-Math.hypot(u.x-b.x,u.y-b.y))[0];if(enemy){attackOrder(g,u,{kind:'unit',id:enemy.id});if(resume)u.order.resumeMove=resume;if(u.stance==='hold')u.order.holdTarget=true;enemy.kind='unit';target=enemy;}}
    if(!target)continue;
    const tx=target.kind==='unit'?target.x:target.tile.x+.5,ty=target.kind==='unit'?target.y:target.tile.y+.5;
    const distance=Math.hypot(tx-u.x,ty-u.y),inRange=distance<=d.range&&lineOfSight(g,u,{x:tx,y:ty});
    if(u.order?.holdTarget&&distance>d.range){u.order=null;u.path=[];continue;}
    if(!inRange){pathToAttackRange(g,u,target,d.range);continue;}
    u.path=[];if(u.cooldown>0)continue;u.cooldown=d.interval;
    const facing=Math.sign(tx-u.x)||undefined;
    u.strike={at:g.elapsed,facing};
    const kind=u.type==='archer'?'arrow':u.type==='siege'?'shell':'impact';
    g.effects.push({kind,owner:u.owner,x:u.x,y:u.y,tx,ty,at:g.elapsed});
    if(target.kind==='unit'){
      let damage=d.damage;if(u.type==='pike'&&target.type==='siege')damage*=1.9;if(u.type==='sword'&&target.type==='archer')damage*=1.25;if(target.type==='siege'&&u.type!=='siege')damage*=1.2;
      damageUnit(g,target,damage,facing&&-facing);
    } else if(target.kind==='building'){
      const bonus=target.building.type==='tower'&&d.siege?1.35:1;
      target.building.hp-=d.buildingDamage*bonus;
      if(target.building.hp<=0){const ix=target.tile.y*SIZE+target.tile.x,isBase=target.building.type==='base';target.tile.building=null;for(const a of g.units)if(a.order?.targetId===target.building.id){if(!isBase&&adjacentIndices(ix).some(i=>g.tiles[i].owner===a.owner))a.order={kind:'attack',targetKind:'land',tile:ix,lastTargetCell:-1};else a.order=null;a.path=[];}addLog(g,`${g.players[u.owner].name}摧毀${BUILDING[target.building.type].name}。`,u.owner,ix);}
    } else if(target.kind==='land'){
      const tile=target.tile;tile.hp-=d.siege?d.damage:d.damage*.72;
      if(tile.hp<=0){tile.owner=u.owner;tile.hp=tile.maxHp;addLog(g,`${g.players[u.owner].name}奪下 (${tile.x+1}, ${tile.y+1}) 土地。`,u.owner,idx(tile.x,tile.y));u.order=null;u.path=[];}
    }
  }
}
function spawnTrainedUnit(g,t,type){
  const free=i=>{
    if(!passable(g,i))return false;
    const c=center(i);
    return !g.units.some(u=>Math.hypot(u.x-c.x,u.y-c.y)<.7||u.path.at(-1)===i);
  };
  const site=idx(t.x,t.y),exits=adjacentIndices(site).filter(free);
  if(!exits.length)return false;
  // Clear the doorway when there is an open tile beyond it.
  let exit=exits[0],rally;
  for(const i of exits){
    const next=adjacentIndices(i).find(j=>j!==site&&Math.abs(xy(j).x-t.x)+Math.abs(xy(j).y-t.y)===2&&free(j));
    if(next!==undefined){exit=i;rally=next;break;}
  }
  const p=xy(exit),u=makeUnit(g,t.building.owner,type,p.x,p.y);
  if(rally!==undefined)moveOrder(g,u,xy(rally));
  g.units.push(u);
  return true;
}
function tickBuildings(g,dt){
  for(const t of g.tiles){const b=t.building;if(!b)continue;
    if(b.underConstruction){const builders=g.units.filter(u=>u.owner===b.owner&&u.order?.kind==='build'&&u.order.buildingId===b.id).length;if(!builders&&b.progress>0)b.progress=Math.max(0,b.progress-dt*.2);continue;}
    if(b.type==='farm')g.players[b.owner].resources.food+=BUILDING.farm.foodRate*dt;
    if(b.queue?.length){
      const q=b.queue[0];q.remaining=Math.max(0,q.remaining-dt);
      if(q.remaining<=.000001){
        q.remaining=0;
        if(spawnTrainedUnit(g,t,q.unit))b.queue.shift();
      }
    }
    if(b.type==='tower'){b.cooldown=Math.max(0,b.cooldown-dt);if(b.cooldown<=0){const enemy=g.units.filter(u=>u.owner!==b.owner&&g.visible[b.owner].has(idx(Math.floor(u.x),Math.floor(u.y)))&&Math.hypot(u.x-(t.x+.5),u.y-(t.y+.5))<=BUILDING.tower.range&&lineOfSight(g,{x:t.x+.5,y:t.y+.5},u)).sort((a,c)=>a.hp-c.hp)[0];if(enemy){
      const x=t.x+.5,y=t.y+.5;
      g.effects.push({kind:'tower',owner:b.owner,x,y,tx:enemy.x,ty:enemy.y,at:g.elapsed});
      damageUnit(g,enemy,BUILDING.tower.damage,Math.sign(x-enemy.x)||undefined);b.cooldown=BUILDING.tower.interval;
    }}}
  }
}
function cleanupAndVictory(g){g.units=g.units.filter(u=>u.hp>0);const destroyed=[0,1].filter(p=>{const b=g.tiles[idx(g.players[p].base.x,g.players[p].base.y)].building;return!b||b.hp<=0;});if(destroyed.length){g.ended=true;g.winner=destroyed.length===2?-1:1-destroyed[0];addLog(g,g.winner<0?'雙方主基地同時摧毀，戰局平手。':`${g.players[g.winner].name}摧毀主基地，獲得勝利！`);}}
function tickGame(room,dt){const g=room.game;if(!g||g.ended)return;g.elapsed+=dt;g.tick++;
  g.effects=g.effects.filter(e=>g.elapsed-e.at<.8);
  moveUnits(g,dt);updateVision(g);attackAndGather(g,dt);tickBuildings(g,dt);cleanupAndVictory(g);
  if(room.ai){g.aiThink+=dt;if(g.aiThink>1.25){g.aiThink=0;aiPlay(room);}}
  if(g.ended||g.tick%2===0)broadcastState(room);
}
function aiPlay(room){
  const g=room.game,p=1,pl=g.players[p],enemyBase=idx(g.players[0].base.x,g.players[0].base.y);
  const owned=g.tiles.filter(t=>t.owner===p),villagers=g.units.filter(u=>u.owner===p&&u.type==='villager'),soldiers=g.units.filter(u=>u.owner===p&&u.type!=='villager');
  for(const v of villagers)if(!v.order){
    const resources=g.tiles.filter(t=>t.resource&&t.amount>3&&g.visible[p].has(idx(t.x,t.y))).sort((a,b)=>Math.abs(a.x-v.x)+Math.abs(a.y-v.y)-Math.abs(b.x-v.x)-Math.abs(b.y-v.y));
    resources.some(t=>workOrder(g,v,idx(t.x,t.y),'gather'));
  }
  const base=g.tiles[idx(pl.base.x,pl.base.y)].building;
  let barracks=owned.find(t=>t.building?.type==='barracks');
  if(!barracks&&canAIPay(pl,BUILDING.barracks.cost)){
    const builder=villagers.find(v=>!v.order||v.order.kind==='gather');
    if(builder)owned.some(t=>{
      if(!canBuild('barracks',t))return false;
      applyCommand(g,p,{action:'build',units:[builder.id],building:'barracks',x:t.x,y:t.y});
      return !!t.building;
    });
  }
  if(barracks?.building&&!barracks.building.underConstruction&&barracks.building.queue.length<3){const type=canAIPay(pl,UNIT.sword.cost)?'sword':canAIPay(pl,UNIT.archer.cost)?'archer':null;if(type)applyCommand(g,p,{action:'train',unit:type,x:barracks.x,y:barracks.y});}
  if(base&&base.queue.length<2&&pl.resources.food>=UNIT.villager.cost.food+UNIT.sword.cost.food){
    applyCommand(g,p,{action:'train',unit:'villager',x:base.x,y:base.y});
  }
  const frontier=g.tiles.filter(t=>t.owner!==p&&t.terrain!=='water'&&!t.building&&adjacentIndices(idx(t.x,t.y)).some(i=>g.tiles[i].owner===p)).sort((a,b)=>Math.abs(a.x-g.players[0].base.x)+Math.abs(a.y-MID)-Math.abs(b.x-g.players[0].base.x)-Math.abs(b.y-MID));
  if(frontier.length){const target=frontier[0];const idle=soldiers.filter(u=>!u.order);for(const u of idle.slice(0,Math.min(3,idle.length)))attackOrder(g,u,{kind:'land',tile:idx(target.x,target.y)});}
  const targetBase=g.tiles[enemyBase].building;if(targetBase&&soldiers.length>=8&&soldiers.every(u=>!u.order)){for(const u of soldiers)attackOrder(g,u,{kind:'building',id:targetBase.id,tile:enemyBase});}
}
function canAIPay(pl,cost){return Object.entries(cost).every(([k,v])=>pl.resources[k]>=v);}

function broadcast(room,payload){for(const ws of room.players)if(ws)wsSend(ws,payload);}
function broadcastState(room){
  const g=room.game;
  if(!g)return;
  updateVision(g);
  for(let p=0;p<2;p++){
    const ws=room.players[p];
    if(!ws||ws.destroyed)continue;
    // Skip stale snapshots on slow connections. A full snapshot is required only on a new socket.
    if(ws.writableLength>128*1024&&!g.ended)continue;
    const state=serialize(g,p,ws.lastTiles);
    if(ws.tileDeltas&&!ws.lastTiles)ws.lastTiles=state.tiles.map(tile=>tile.unseen?'':JSON.stringify(tile));
    wsSend(ws,state);
  }
}
function broadcastLobby(room){
  const count=room.ai?2:room.players.filter(Boolean).length;
  const names=room.names.map((name,slot)=>room.players[slot]||(room.ai&&slot===1)?name:null);
  for(const ws of room.players)if(ws)wsSend(ws,{type:'lobby',room:room.id,count,needed:2,ai:room.ai,names});
}
function randCode(){return crypto.randomBytes(3).toString('hex').toUpperCase();}
function safeName(s){return String(s||'玩家').replace(/[<>\u0000-\u001f]/g,'').slice(0,16)||'玩家';}
function joinRoom(ws,msg){
  let room,slot=-1;
  if(msg.type==='practice'){
    const id=randCode();room={id,players:[ws,null],tokens:[crypto.randomBytes(12).toString('hex'),null],names:[safeName(msg.name),'像素守軍'],ai:true,game:null,disconnectAt:null};rooms.set(id,room);slot=0;
  }else if(msg.type==='create'){
    let id=randCode();while(rooms.has(id))id=randCode();room={id,players:[ws,null],tokens:[crypto.randomBytes(12).toString('hex'),null],names:[safeName(msg.name),null],ai:false,game:null,disconnectAt:null};rooms.set(id,room);slot=0;
  }else if(msg.type==='join'&&msg.room){
    const id=String(msg.room).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12);room=rooms.get(id);
    if(!room){wsSend(ws,{type:'error',text:'找不到這個房間代碼。'});return;}
    if(msg.token){
      slot=room.tokens.findIndex(token=>token===msg.token);
      if(slot<0){wsSend(ws,{type:'error',text:'無法恢復原本的座位，請重新加入房間。'});return;}
      if(room.players[slot]&&room.players[slot]!==ws){const previous=room.players[slot];room.players[slot]=null;previous.end();}
    }
    if(slot<0)slot=room.players.findIndex((x,i)=>!x&&i===1&&!room.ai);
    if(slot<0){wsSend(ws,{type:'error',text:'房間已滿，請建立新房間。'});return;}
    room.players[slot]=ws;room.names[slot]=safeName(msg.name);room.disconnectAt=null;if(room.game)room.game.players[slot].name=room.names[slot];
  }else return;
  ws.room=room;ws.slot=slot;
  ws.tileDeltas=msg.tileDeltas===true;
  if(!room.tokens[slot])room.tokens[slot]=crypto.randomBytes(12).toString('hex');
  wsSend(ws,{type:'joined',room:room.id,slot,token:room.tokens[slot],ai:room.ai,name:room.names[slot]});
  broadcastLobby(room);
  if(room.ai||room.players[0]&&room.players[1]){
    if(!room.game){room.game=startGame(crypto.randomBytes(4).readUInt32LE(),[room.names[0],room.names[1]]);room.game.ai=room.ai;room.game.roomId=room.id;room.game.clients=room.players;addLog(room.game,'戰區同步完成，主基地耐久歸零為唯一勝利條件。');}
    broadcastState(room);
  }
}
function handleMessage(ws,text){let msg;try{msg=JSON.parse(text);}catch{return;}
  if(!ws.room){joinRoom(ws,msg);return;}
  if(msg.type==='command'&&ws.room.game)applyCommand(ws.room.game,ws.slot,msg.command);
  else if(msg.type==='ping')wsSend(ws,{type:'pong',now:Date.now()});
}

// Small RFC 6455 server so the prototype runs without downloading dependencies.
function wsSend(ws,obj){if(!ws||ws.destroyed||ws.writableEnded)return;try{const data=Buffer.from(JSON.stringify(obj));let head;if(data.length<126){head=Buffer.from([0x81,data.length]);}else if(data.length<65536){head=Buffer.alloc(4);head[0]=0x81;head[1]=126;head.writeUInt16BE(data.length,2);}else{head=Buffer.alloc(10);head[0]=0x81;head[1]=127;head.writeBigUInt64BE(BigInt(data.length),2);}ws.write(Buffer.concat([head,data]));}catch{}}
function wsFrame(op,payload=Buffer.alloc(0)){const n=payload.length;let h;if(n<126)h=Buffer.from([0x80|op,n]);else if(n<65536){h=Buffer.alloc(4);h[0]=0x80|op;h[1]=126;h.writeUInt16BE(n,2);}else{h=Buffer.alloc(10);h[0]=0x80|op;h[1]=127;h.writeBigUInt64BE(BigInt(n),2);}return Buffer.concat([h,payload]);}
function upgrade(req,socket,head){
  const key=req.headers['sec-websocket-key'];if(!key||req.headers.upgrade?.toLowerCase()!=='websocket'){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket._buf=Buffer.alloc(0);socket._appClosed=false;socket._appWaitingPong=false;sockets.add(socket);
  socket.on('data',chunk=>{socket._buf=Buffer.concat([socket._buf,chunk]);while(socket._buf.length>=2){const b0=socket._buf[0],b1=socket._buf[1],op=b0&15,masked=(b1&128)!==0;let len=b1&127,off=2;if(len===126){if(socket._buf.length<4)return;len=socket._buf.readUInt16BE(2);off=4;}else if(len===127){if(socket._buf.length<10)return;const big=socket._buf.readBigUInt64BE(2);if(big>2_000_000n){socket.destroy();return;}len=Number(big);off=10;}const maskBytes=masked?4:0;if(socket._buf.length<off+maskBytes+len)return;let payload=socket._buf.subarray(off+maskBytes,off+maskBytes+len);if(masked){payload=Buffer.from(payload);const mask=socket._buf.subarray(off,off+4);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];}socket._buf=socket._buf.subarray(off+maskBytes+len);if(op===8){socket.end(wsFrame(8));return;}if(op===9){socket.write(wsFrame(10,payload));continue;}if(op===10){socket._appWaitingPong=false;continue;}if(op===1)handleMessage(socket,payload.toString('utf8'));}});
  socket.on('close',()=>disconnect(socket));socket.on('end',()=>disconnect(socket));socket.on('error',()=>disconnect(socket));
  if(head?.length)socket.emit('data',head);
}
function disconnect(ws){if(ws._appClosed)return;ws._appClosed=true;sockets.delete(ws);const room=ws.room;if(!room||room.players[ws.slot]!==ws)return;room.players[ws.slot]=null;if(room.game&&!room.game.ended){room.disconnectAt=Date.now();broadcast(room,{type:'status',text:'對手連線中斷，戰局暫停等待重連。'});}else if(!room.players.some(Boolean))rooms.delete(room.id);}

const server=http.createServer((req,res)=>{
  let pathname='/';try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{}
  if(pathname==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('ok');return;}
  const file=path.resolve(__dirname,pathname==='/'?'index.html':pathname.replace(/^\/+/,'')),relative=path.relative(__dirname,file);
  const allowed=relative==='index.html'||(relative.startsWith(`assets${path.sep}`)&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  if(!allowed){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');return;}
  const contentType={'.png':'image/png','.jpg':'image/jpeg'}[path.extname(file)]||'text/html; charset=utf-8';
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(500);res.end('Unable to load game');return;}res.writeHead(200,{'Content-Type':contentType,'Cache-Control':contentType.startsWith('image/')?'public, max-age=86400':'no-store'});res.end(data);});
});
server.on('upgrade',upgrade);
setInterval(()=>{for(const socket of sockets){if(socket.destroyed)continue;if(socket._appWaitingPong){socket.destroy();continue;}socket._appWaitingPong=true;socket.write(wsFrame(9));}},25000);
setInterval(()=>{const now=Date.now();for(const [id,room]of rooms){if(room.game&&!room.game.ended){const connected=room.ai?!!room.players[0]:!!room.players[0]&&!!room.players[1];if(connected)tickGame(room,TICK/1000);else if(room.disconnectAt&&now-room.disconnectAt>120000){rooms.delete(id);}}else if(!room.players.some(Boolean))rooms.delete(id);}},TICK);
server.listen(PORT,HOST,()=>console.log(`風起群島伺服器已啟動： http://localhost:${PORT}`));
