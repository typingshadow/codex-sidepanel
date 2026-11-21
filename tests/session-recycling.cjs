const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function harness(){
 const elements=new Map();let now=1_000_000;
 const get=id=>{if(!elements.has(id)) elements.set(id,{});return elements.get(id);};
 const c=vm.createContext({document:{getElementById:get},Date:{now:()=>now}});
 const source=fs.readFileSync(path.join(__dirname,'../extension/workspace.js'),'utf8');
 vm.runInContext(source.slice(0,source.indexOf('const permissions'))+'\nlet shown;',c);
 c.add=(key,age,protectedState=false,visible=false)=>{
  const entry={lastUsed:now-age,removed:false,frame:{remove(){entry.removed=true;},contentWindow:{codexSessionState:()=>({protected:protectedState})}}};
  c.entry=entry;c.key=key;vm.runInContext('frames.set(key,entry)',c);
  if(visible)vm.runInContext('shown=entry',c);
  return entry;
 };
 return {run:s=>vm.runInContext(s,c),add:c.add,get,c};
}
test('session count alone never triggers automatic recycling',()=>{
 const h=harness();const entries=[];
 for(let i=0;i<20;i++)entries.push(h.add(String(i),(20-i)*1000,false,i===19));
 assert.equal(h.run('recycleSessions()'),0);assert.equal(h.run('frames.size'),20);
 assert.ok(entries.every(e=>!e.removed));
});
test('automatic recycling starts exactly after two idle hours',()=>{
 const h=harness();const twoHours=2*60*60*1000;
 const old=h.add('old',twoHours);const recent=h.add('recent',twoHours-1);h.add('current',twoHours+1,false,true);
 assert.equal(h.run('recycleSessions()'),1);assert.ok(old.removed);assert.equal(recent.removed,false);
});
test('manual recycling protects current, running, draft and uncertain sessions',()=>{
 const h=harness();h.add('current',0,false,true);
 const protectedEntries=['task','draft','uncertain','loading'].map(key=>h.add(key,999999,true));
 const idle=h.add('idle',0);
 assert.equal(h.run('recycleSessions(true)'),1);assert.ok(idle.removed);
 assert.ok(protectedEntries.every(e=>!e.removed));assert.equal(h.run('frames.size'),5);
 assert.equal(h.get('recycle-sessions').disabled,true);
});
test('unknown or inaccessible panels are retained until their state is available',()=>{
 const h=harness();const unknown=h.add('unknown',999999);unknown.frame.contentWindow={};
 const inaccessible=h.add('inaccessible',999999);inaccessible.frame.contentWindow={codexSessionState(){throw Error('unavailable');}};
 assert.equal(h.run('recycleSessions(true)'),0);assert.equal(h.run('frames.size'),2);
});
test('expired protected sessions remain until they become idle',()=>{
 const h=harness();const twoHours=2*60*60*1000;
 const entry=h.add('task',twoHours+1,true);h.add('current',twoHours+1,false,true);
 assert.equal(h.run('recycleSessions()'),0);
 entry.frame.contentWindow.codexSessionState=()=>({protected:false});
 assert.equal(h.run('recycleSessions()'),1);assert.equal(h.run('frames.size'),1);
});
test('hidden restorable documents unload while session entries remain until the two-hour threshold',()=>{
 const h=harness(); const old=h.add('old',10); const active=h.add('active',0,false,true);
 old.frame.contentWindow.canUnloadCodexView=()=>true;
 active.frame.contentWindow.canUnloadCodexView=()=>true;
 assert.equal(h.run('recycleSessions()'),0);
 assert.ok(old.removed);assert.equal(old.frame,null);assert.equal(active.removed,false);
 assert.equal(h.run('frames.size'),2);
 assert.equal(h.run('recycleSessions(true)'),1);
});
