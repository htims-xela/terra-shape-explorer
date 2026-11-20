// Checks relay/worker.js the way Cloudflare runs it: storage, alarms and hibernatable WebSockets, with the room put to sleep (memory wiped) between every two events.
// Run before a deploy:  node relay/hibernate-test.mjs
let NOW=1e12;Date.now=()=>NOW;
globalThis.Response=class{constructor(b,o){Object.assign(this,o||{});}};
class WS{constructor(){this.att=null;this.closed=false;this.got=[];this.peer=null;}send(s){if(this.closed)throw new Error('closed');this.peer.got.push(JSON.parse(s));}close(){this.closed=true;}serializeAttachment(a){this.att=JSON.parse(JSON.stringify(a));}deserializeAttachment(){return this.att;}}
globalThis.WebSocketPair=function(){const a=new WS(),b=new WS();a.peer=b;b.peer=a;return{0:a,1:b};};
const {RoomObject}=await import(new URL('./worker.js',import.meta.url));
const store=new Map();let alarm=null;const sockets=[];
const ctx={storage:{get:async k=>store.has(k)?JSON.parse(store.get(k)):undefined,put:async(k,v)=>{store.set(k,JSON.stringify(v));},deleteAll:async()=>store.clear(),setAlarm:async t=>{alarm=t;},deleteAlarm:async()=>{alarm=null;}},
 acceptWebSocket:ws=>sockets.push(ws),getWebSockets:()=>sockets.filter(s=>!s.closed)};
let obj=new RoomObject(ctx,{}),sleeps=0;const sleep=()=>{obj=new RoomObject(ctx,{});sleeps++;}; // memory gone, storage and sockets stay
let fails=0,checks=0;const ok=(c,m)=>{checks++;if(!c){fails++;console.log('FAIL',m);}};
async function join(){const res=await obj.fetch({});const client=res.webSocket,server=client.peer;sleep();return{client,server,send:async o=>{await obj.webSocketMessage(server,JSON.stringify(o));sleep();},last:t=>[...client.got].reverse().find(m=>m.t===t)};}
const A=await join();await A.send({t:'hello',id:'a',dev:'da',name:'Ann',create:true});
const K=A.last('welcome').keys;ok(A.last('welcome').role==='owner'&&K&&K.edit,'Ann creates the room');
const B=await join();await B.send({t:'hello',id:'b',dev:'db',name:'Bob',key:K.edit});
ok(B.last('welcome')&&B.last('welcome').role==='edit','Bob joins as editor after the room slept');ok(A.last('need')&&A.last('need').id==='b','Ann is asked to send Bob the design');
await A.send({t:'state',to:'b',data:{x:1}});ok(B.last('state')&&B.last('state').data.x===1,'the design reaches Bob');
await B.send({t:'op',n:1,ch:[['p.w0.tamaD',60]]});ok(A.last('op')&&A.last('op').from==='b'&&B.last('op'),'Bob’s change reaches both, room asleep in between');
const C=await join();await C.send({t:'hello',id:'c',dev:'dc',name:'Cy',key:K.view});ok(C.last('welcome').role==='view','Cy joins to watch');
const n0=A.client.got.length;await C.send({t:'op',n:1,ch:[['x',1]]});ok(A.client.got.length===n0,'a watcher’s change goes nowhere');
await A.send({t:'name',name:'Ann B'});ok(B.last('roster').roster.find(r=>r.id==='a').name==='Ann B','a new name is kept');
await A.send({t:'kick',id:'c'});ok(C.last('kicked')&&C.server.closed,'Ann removes Cy');
const C2=await join();await C2.send({t:'hello',id:'c2',dev:'dc',name:'Cy',key:K.view});ok(C2.last('error')&&C2.last('error').code==='banned','and Cy can’t come back, though the room slept');
await obj.webSocketClose(A.server);A.server.closed=true;sleep();ok(B.last('roster').owner===null,'Ann drops out');ok(alarm&&alarm-NOW>=59000,'an alarm is set for the hand-over');
NOW+=61000;await obj.alarm();sleep();ok(B.last('keys')&&B.last('owner').id==='b','a minute later, Bob takes over, from the alarm');
const K2=B.last('keys').keys;await obj.webSocketClose(B.server);B.server.closed=true;sleep();
ok(store.size===1&&alarm,'everyone left: the room waits, with an alarm');
const D=await join();await D.send({t:'hello',id:'b',dev:'db',name:'Bob',key:K2.owner});ok(D.last('welcome')&&D.last('welcome').role==='owner','Bob comes back within ten minutes and is owner again');
await obj.webSocketClose(D.server);D.server.closed=true;sleep();NOW+=601000;await obj.alarm();sleep();
ok(store.size===0&&!alarm,'ten minutes after everyone left, the room is gone and nothing is kept');
const E=await join();await E.send({t:'hello',id:'e',dev:'de',name:'Ed',key:K2.edit});ok(E.last('error')&&E.last('error').code==='gone','an old link finds the session ended');
// end for everyone
const F=await join();await F.send({t:'hello',id:'f',dev:'df',name:'Fay',create:true});const KF=F.last('welcome').keys;const G=await join();await G.send({t:'hello',id:'g',dev:'dg',name:'Gus',key:KF.edit});
await F.send({t:'end'});ok(G.last('ended')&&store.size===0,'the owner ends the session: everyone is told and nothing is kept');
// a big message in pieces passes; a too-long one is dropped
const H=await join();await H.send({t:'hello',id:'h',dev:'dh',name:'H',create:true});const big='x'.repeat(1200000);const before=H.client.got.length;await obj.webSocketMessage(H.server,JSON.stringify({t:'op',n:1,ch:[['k',big]]}));ok(H.client.got.length===before,'an over-long message is dropped');
console.log(`${checks-fails}/${checks} checks passed, room put to sleep ${sleeps} times`);process.exit(fails?1:0);
