'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../server'),'utf8').split('const server=http.createServer')[0];
const context=vm.createContext({require:name=>name==='./accounts'?{}:require(name),process,console,Buffer,setTimeout,clearTimeout});
vm.runInContext(source+'\nglobalThis.gameRules={startGame,updateVision,applyCommand,cleanupAndVictory,playerBase,moveUnits,attackAndGather,tickBuildings,aiPlay,passable,findPath,idx,makeBuilding};',context);
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
