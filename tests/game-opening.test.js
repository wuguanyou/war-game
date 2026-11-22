'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../server'),'utf8').split('const server=http.createServer')[0];
const accountStub={areFriends:async()=>false};
const context=vm.createContext({require:name=>name==='./accounts'?accountStub:require(name),process,console,Buffer,setTimeout,clearTimeout});
vm.runInContext(source+'\nglobalThis.gameRules={startGame,updateVision,applyCommand,cleanupAndVictory,playerBase,moveUnits,attackAndGather,tickBuildings,aiPlay,passable,findPath,idx,makeBuilding,makeUnit,lineOfSight,recordIncome,flushIncome,serialize,joinRoom,roomMembers,handleMessage,sockets,queueResult};',context);
const R=context.gameRules;
function fresh(seed=1){const g=R.startGame(seed);R.updateVision(g);return g;}
function step(g,seconds){for(let t=0;t<seconds;t+=.1){g.elapsed+=.1;R.moveUnits(g,.1);R.updateVision(g);R.attackAndGather(g,.1);R.tickBuildings(g,.1);R.cleanupAndVictory(g);}}
function build(g,type,x=6,y=6){R.applyCommand(g,0,{action:'build',building:type,x,y,units:g.units.filter(u=>u.owner===0).map(u=>u.id)});}
test('starts contain only villagers, with fair diagonal land and connected routes across seeds',()=>{
  for(let seed=1;seed<=40;seed++){
    const g=fresh(seed);
    assert.equal(g.tiles.some(t=>t.building),false);
    assert.equal(g.units.length,8);
    assert.ok(g.units.every(u=>u.type==='villager'));
    assert.ok(g.units.filter(u=>u.owner===0).every(u=>u.x<10&&u.y<10));
    assert.ok(g.units.filter(u=>u.owner===1).every(u=>u.x>30&&u.y>30));
    assert.ok(R.findPath(g,6.5,6.5,R.idx(33,33)));
    for(const u of g.units)assert.ok(R.passable(g,R.idx(Math.floor(u.x),Math.floor(u.y))));
    R.cleanupAndVictory(g);assert.equal(g.ended,false);
  }
});
test('base is freely placed, paid once, unlocks buildings only after completion, and is unique',()=>{
  const g=fresh();const wood=g.players[0].resources.wood;
  build(g,'barracks');assert.equal(g.tiles[R.idx(6,6)].building,null);
  build(g,'base',5,5);const b=R.playerBase(g,0);
  assert.ok(b?.underConstruction);assert.equal(b.x,5);assert.equal(b.y,5);
  assert.equal(g.players[0].resources.wood,wood-80);
  build(g,'base',6,6);assert.equal(g.tiles[R.idx(6,6)].building,null);
  build(g,'barracks',6,6);assert.equal(g.tiles[R.idx(6,6)].building,null);
  build(g,'base',5,5);assert.equal(g.players[0].resources.wood,wood-80);
  step(g,12);assert.equal(b.underConstruction,false);assert.equal(g.ended,false);
  build(g,'barracks',6,6);assert.equal(g.tiles[R.idx(6,6)].building?.type,'barracks');
  g.tiles[R.idx(5,5)].building=null;R.cleanupAndVictory(g);assert.equal(g.ended,true);assert.equal(g.winner,1);
});
test('water, resources, occupied tiles and unseen tiles reject base construction without payment',()=>{
  const g=fresh();const wood=g.players[0].resources.wood;
  for(const [x,y] of [[7,6],[0,0],[33,33],[9,4]]){build(g,'base',x,y);assert.equal(R.playerBase(g,0),null);assert.equal(g.players[0].resources.wood,wood);}
});
test('losing all villagers before placing a base ends the game',()=>{
  const g=fresh();g.units=g.units.filter(u=>u.owner!==0);R.cleanupAndVictory(g);assert.equal(g.winner,1);assert.equal(g.ended,true);
});
test('AI builds its base before barracks and resumes an interrupted base',()=>{
  const g=fresh();const room={game:g,ai:true};
  R.aiPlay(room);const b=R.playerBase(g,1);assert.ok(b?.underConstruction);
  assert.equal(g.tiles.some(t=>t.building?.type==='barracks'),false);
  for(const u of g.units.filter(u=>u.owner===1)){u.order=null;u.path=[];}
  R.aiPlay(room);assert.ok(g.units.some(u=>u.owner===1&&u.order?.kind==='build'));
  step(g,15);assert.equal(b.underConstruction,false);
  R.aiPlay(room);assert.ok(g.tiles.some(t=>t.building?.owner===1&&t.building.type==='barracks'));
});
test('demolition verifies ownership and identity, refunds materials and queued recruits, and stops workers',()=>{
  const g=fresh(),t=g.tiles[R.idx(6,6)];t.building=R.makeBuilding(0,'barracks',6,6);const id=t.building.id;
  t.building.queue=[{unit:'sword',remaining:4}];
  const before={...g.players[0].resources};
  const command={action:'demolish',x:6,y:6,buildingId:id};
  R.applyCommand(g,1,command);assert.equal(t.building.id,id);
  R.applyCommand(g,0,{...command,buildingId:'stale'});assert.equal(t.building.id,id);
  g.units[0].order={kind:'build',buildingId:id};
  R.applyCommand(g,0,command);assert.equal(t.building,null);assert.equal(g.units[0].order,null);
  assert.equal(g.players[0].resources.wood,before.wood+50+15);
  assert.equal(g.players[0].resources.stone,before.stone+17);
  assert.equal(g.players[0].resources.food,before.food+55);
  R.applyCommand(g,0,command);assert.equal(g.players[0].resources.wood,before.wood+65);
});
test('unfinished base cancellation permits another location; completed bases cannot be demolished',()=>{
  const g=fresh(),wood=g.players[0].resources.wood;
  build(g,'base');let b=R.playerBase(g,0);
  R.applyCommand(g,0,{action:'demolish',x:6,y:6,buildingId:b.id});
  assert.equal(g.players[0].resources.wood,wood);assert.equal(g.players[0].hasPlacedBase,false);
  R.cleanupAndVictory(g);assert.equal(g.ended,false);
  build(g,'base',5,5);step(g,12);b=R.playerBase(g,0);
  R.applyCommand(g,0,{action:'demolish',x:5,y:5,buildingId:b.id});assert.equal(R.playerBase(g,0).id,b.id);
});
test('archers shoot across walls and closed gates while buildings still block arrows',()=>{
  for(const type of ['wall','gate','barracks']){
    const g=fresh();for(let x=5;x<=9;x++){const t=g.tiles[R.idx(x,6)];t.terrain='grass';t.resource=null;}
    const archer=R.makeUnit(g,0,'archer',5,6),enemy=R.makeUnit(g,1,'sword',9,6);
    g.units=[archer,enemy];g.tiles[R.idx(7,6)].building=R.makeBuilding(1,type,7,6);
    R.updateVision(g);archer.stance='hold';
    assert.equal(R.lineOfSight(g,archer,enemy),false);
    assert.equal(R.lineOfSight(g,archer,enemy,true),type!=='barracks');
    R.attackAndGather(g,.1);
    assert.equal(enemy.hp<enemy.maxHp,type!=='barracks');
    if(type!=='barracks')assert.equal(archer.path.length,0);
  }
});
test('income numbers aggregate, throttle and represent actual gains; farms produce without workers',()=>{
  const g=fresh();g.elapsed=1;
  for(let i=0;i<20;i++)R.recordIncome(g,0,'wood',.1,6.5,6.5);
  R.flushIncome(g);assert.equal(g.effects.length,0);
  g.elapsed=4.1;R.flushIncome(g);assert.equal(g.effects.length,1);assert.equal(g.effects[0].amount,2);
  for(let i=0;i<10;i++)R.recordIncome(g,0,'stone',2,15+i,15);
  g.elapsed=8;R.flushIncome(g);assert.equal(g.effects.length,2);
  R.flushIncome(g);assert.equal(g.effects.length,2);
  const before=g.players[0].resources.food;g.tiles[R.idx(6,6)].building=R.makeBuilding(0,'farm',6,6);
  R.tickBuildings(g,60);assert.ok(Math.abs(g.players[0].resources.food-before-11.4)<1e-8);
});
test('villagers cost food, train in a completed base, and spawn without overlapping objects',()=>{
  const g=fresh();build(g,'base');const b=R.playerBase(g,0),food=g.players[0].resources.food;
  const cmd={action:'train',unit:'villager',x:6,y:6};
  R.applyCommand(g,0,cmd);assert.equal(b.queue.length,0);
  step(g,12);R.applyCommand(g,0,cmd);assert.equal(b.queue.length,1);assert.equal(g.players[0].resources.food,food-45);
  assert.equal(b.queue[0].remaining,13);const count=g.units.length;
  step(g,14);assert.equal(g.units.length,count+1);assert.equal(b.queue.length,0);
  const recruit=g.units.at(-1);assert.equal(recruit.type,'villager');assert.ok(R.passable(g,R.idx(Math.floor(recruit.x),Math.floor(recruit.y))));
});

test('building ownership reaches the client and income numbers remain private',()=>{
 const g=fresh();g.tiles[R.idx(6,6)].building=R.makeBuilding(0,'farm',6,6);
 g.effects=[{kind:'income',owner:0,resource:'food',amount:2,x:6.5,y:6.5,at:0},{kind:'income',owner:1,resource:'wood',amount:3,x:6.5,y:6.5,at:0}];
 const packet=R.serialize(g,0);assert.equal(packet.buildings[0].owner,0);assert.equal(packet.effects.length,1);assert.equal(packet.effects[0].owner,0);
});
function socket(account){return {account,messages:[],write(frame){const n=frame[1]&127,offset=n===126?4:n===127?10:2;this.messages.push(JSON.parse(frame.subarray(offset).toString()));}};}
test('matching displays server-owned names and avatars without private profile data and pauses commands during countdown',async()=>{
  const a=socket({id:'a',name:'海風隊長',avatar:'anchor:blue',bio:'private',settings:{secret:true}}),b=socket({id:'b',name:'島嶼守護者',avatar:'shield:gold'});
  R.joinRoom(a,{type:'create',name:'spoofed',avatar:'javascript:alert(1)'});
  assert.equal(a.messages.find(m=>m.type==='lobby').members[0].name,'海風隊長');
  R.joinRoom(b,{type:'join',room:a.room.id,name:'spoofed'});
  const match=a.messages.find(m=>m.type==='match');assert.equal(match.members[1].name,'島嶼守護者');assert.equal(match.members[1].avatar,'shield:gold');
  assert.equal(match.members[0].bio,undefined);assert.equal(match.members[0].settings,undefined);assert.equal(match.members[0].id,undefined);
  assert.ok(match.startsInMs>0&&match.startsInMs<=3500);
  const g=a.room.game;const command=JSON.stringify({type:'command',command:{action:'build',building:'base',x:6,y:6,units:g.units.filter(u=>u.owner===0).map(u=>u.id)}});
  await R.handleMessage(a,command);assert.equal(R.playerBase(g,0),null);
  a.room.readyAt=0;await R.handleMessage(a,command);assert.ok(R.playerBase(g,0));
});
test('battle invitations only reach accepted friends outside rooms',async()=>{
  const a=socket({id:'invite-a',name:'邀請者',avatar:'crown:gold'}),b=socket({id:'invite-b',name:'好友'});
  R.joinRoom(a,{type:'create'});R.sockets.add(a);R.sockets.add(b);
  try{
    const invite=JSON.stringify({type:'friendInvite',accountId:'invite-b'});
    await R.handleMessage(a,invite);assert.equal(b.messages.length,0);
    accountStub.areFriends=async(x,y)=>x==='invite-a'&&y==='invite-b';a.lastFriendInvite=0;
    await R.handleMessage(a,invite);assert.equal(b.messages[0].type,'friendInvite');assert.equal(b.messages[0].from.name,'邀請者');assert.equal(b.messages[0].room,a.room.id);
    b.room={};b.messages=[];a.lastFriendInvite=0;await R.handleMessage(a,invite);assert.equal(b.messages.length,0);
  }finally{accountStub.areFriends=async()=>false;R.sockets.delete(a);R.sockets.delete(b);}
});

test('tutorial practice delays attacks and never saves a match result',()=>{
 for(const tutorial of [false,true]){
 const g=fresh();g.tutorial=tutorial;g.elapsed=100;const t=g.tiles[R.idx(33,33)];t.building=R.makeBuilding(1,'base',33,33);g.players[1].base={x:33,y:33};g.players[1].hasPlacedBase=true;
 g.units.push(...[[30,31],[31,31],[30,32],[31,32]].map(([x,y])=>R.makeUnit(g,1,'sword',x,y)));R.updateVision(g);R.aiPlay({game:g,ai:true});
 assert.equal(g.units.filter(u=>u.owner===1&&u.type==='sword').some(u=>u.order!==null),!tutorial);
 }
 const game={ended:true};R.queueResult({tutorial:true,game});assert.equal(game.resultQueued,undefined);
});
