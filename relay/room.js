/* Terra Shape Explorer – shared session room.
   One Room is one shared session. It knows who is connected and what each person may do; it never looks inside the design.
   The Cloudflare worker (worker.js) and the self tests (tests.html) both use this file; relay_local.py is a copy of the same rules for testing on your own computer.

   A connection is anything with send(text) and close(). Messages are JSON:
     hello {id, dev, name, key, create}   first message. create:true starts a new room (you become the owner); otherwise key is one of the room's keys.
     name {name}                          change your display name
     op {...}                             a design change: passed to everyone (the sender too) if you may edit
     chunk {kind:'op'|'state', to?, ...}  one piece of a long message; passed on like the message it is part of
     state {to, data}                     the whole design, sent to someone who just joined
     kick {id} · xfer {id} · end · leave  owner only (except leave)
   The room sends: welcome, roster, need {id}, op, state, chunk, keys, owner, kicked, ended, error {code}. */
(function(root){
'use strict';
const ROLES={owner:1,edit:1,view:1};
function randomKey(n){const a='abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';const b=new Uint8Array(n||22);(root.crypto||crypto).getRandomValues(b);for(const x of b)s+=a[x%a.length];return s;}
const clean=(s,n)=>String(s==null?'':s).replace(/[\u0000-\u001f]/g,'').trim().slice(0,n);
class Room{
 // o.timer(kind, gen, ms): a host that can sleep between messages (the Cloudflare relay) keeps timers itself and calls fire(kind, gen) when one is due; otherwise o.setTimeout (or setTimeout) is used.
 // o.change(): called after anything the room has to remember changed (not for design changes, which it only passes on), so such a host can save it (dump / restore).
 constructor(o){o=o||{};this.later=o.setTimeout||((f,ms)=>setTimeout(f,ms));this.timer=o.timer||null;this.change=o.change||null;this.rand=o.rand||randomKey;this.ownerWait=o.ownerWait??60000;this.emptyWait=o.emptyWait??600000;this.reset();}
 reset(){this.keys=null;this.members=[];this.banned=new Set();this.ownerId=null;this.gen=(this.gen||0)+1;}
 roster(){return this.members.map(m=>({id:m.id,name:m.name,role:m.role}));}
 send(m,o){try{m.conn.send(JSON.stringify(o));}catch(e){}}
 all(o,skip){const s=JSON.stringify(o);for(const m of this.members)if(m!==skip)try{m.conn.send(s);}catch(e){}}
 tell(){this.all({t:'roster',owner:this.ownerId,roster:this.roster()});}
 // a new connection: returns {message(text), close()} for the server to call
 open(conn){return{message:text=>this.msg(conn,text),close:()=>this.drop(conn)};}
 // a message from a connection (found by the connection itself, so a host that slept can hand back the same one)
 msg(conn,text){let o;try{o=JSON.parse(text);}catch(e){return;}if(!o||typeof o!=='object')return;
  const me=this.members.find(m=>m.conn===conn);
  if(!me){if(o.t!=='hello'||conn.said)return;conn.said=true;const fail=code=>{try{conn.send(JSON.stringify({t:'error',code}));}catch(e){}try{conn.close();}catch(e){}};if(this.hello(conn,o,fail))this.changed();return;}
  this.handle(me,o);if(o.t!=='op'&&o.t!=='chunk'&&o.t!=='state')this.changed();}
 drop(conn){const me=this.members.find(m=>m.conn===conn);if(me){this.gone(me);this.changed();}}
 changed(){if(this.change)try{this.change();}catch(e){}}
 // timers by name, so a host can keep them while it sleeps
 after(kind,ms){const gen=this.gen;if(this.timer)this.timer(kind,gen,ms);else this.later(()=>this.fire(kind,gen),ms);}
 fire(kind,gen){if(this.gen!==gen)return;
  if(kind==='owner'){if(this.ownerId)return;const n=this.members.find(m=>m.role==='edit');if(n)this.promote(n,null);} // an owner who dropped out did not come back: the longest-standing editor takes over
  else if(kind==='empty'){if(!this.members.length)this.reset();}
  this.changed();}
 // what the room has to remember, without the connections; restore puts it back with each member's connection
 dump(){return{keys:this.keys,ownerId:this.ownerId,banned:[...this.banned],gen:this.gen,members:this.members.map(m=>({id:m.id,dev:m.dev,name:m.name,role:m.role}))};}
 restore(d,connOf){this.keys=d.keys||null;this.ownerId=d.ownerId||null;this.banned=new Set(d.banned||[]);this.gen=d.gen||1;this.members=[];for(const m of d.members||[]){const conn=connOf(m);if(conn){conn.said=true;this.members.push({id:m.id,dev:m.dev,name:m.name,role:m.role,conn});}}}
 hello(conn,o,fail){
  const id=clean(o.id,40),dev=clean(o.dev,40),name=clean(o.name,40)||'Guest';if(!id){fail('bad');return null;}
  let role;
  if(o.create){if(this.keys&&this.members.length){fail('exists');return null;}this.reset();this.keys={owner:this.rand(),edit:this.rand(),view:this.rand()};role='owner';}
  else{if(!this.keys){fail('gone');return null;}const k=String(o.key||'');role=k===this.keys.owner?'owner':k===this.keys.edit?'edit':k===this.keys.view?'view':null;
   if(!role){fail('badkey');return null;}if(dev&&this.banned.has(dev)){fail('banned');return null;}}
  const old=this.members.find(m=>m.id===id);if(old){this.members.splice(this.members.indexOf(old),1);try{old.conn.close();}catch(e){}}
  if(role==='owner'&&this.ownerId&&this.ownerId!==id&&this.members.some(m=>m.id===this.ownerId))role='edit';
  const others=this.members.slice();
  if(!others.length&&role!=='owner'){fail('empty');return null;}
  const me={id,dev,name,role,conn};this.members.push(me);if(role==='owner')this.ownerId=id;
  this.send(me,{t:'welcome',you:id,role,owner:this.ownerId,roster:this.roster(),keys:role==='owner'?this.keys:undefined,alone:!others.length});
  if(others.length){const src=others.find(m=>m.id===this.ownerId)||others.find(m=>m.role==='edit')||others[0];this.send(src,{t:'need',id});}
  this.tell();return me;
 }
 handle(me,o){
  const boss=me.role==='owner',edit=boss||me.role==='edit',to=o.to!=null&&this.members.find(m=>m.id===o.to);
  switch(o.t){
   case'name':me.name=clean(o.name,40)||me.name;this.tell();break;
   case'op':if(edit){o.from=me.id;this.all(o);}break;
   case'state':if(to)this.send(to,{t:'state',from:me.id,data:o.data});break;
   case'chunk':o.from=me.id;if(o.kind==='state'){if(to)this.send(to,o);}else if(o.kind==='op'&&edit)this.all(o);break;
   case'kick':{const m=this.members.find(m=>m.id===o.id);if(!boss||!m||m===me)break;if(m.dev)this.banned.add(m.dev);this.send(m,{t:'kicked'});this.members.splice(this.members.indexOf(m),1);try{m.conn.close();}catch(e){}this.tell();break;}
   case'xfer':{const m=this.members.find(m=>m.id===o.id);if(!boss||!m||m===me||m.role!=='edit')break;this.promote(m,me);break;}
   case'end':if(!boss)break;this.all({t:'ended'},me);for(const m of this.members)try{m.conn.close();}catch(e){}this.reset();break;
   case'leave':this.members.splice(this.members.indexOf(me),1);try{me.conn.close();}catch(e){}this.gone(me,true);break;
  }
 }
 promote(m,from){
  if(from)from.role='edit';m.role='owner';this.ownerId=m.id;this.keys.owner=this.rand();
  this.send(m,{t:'keys',keys:this.keys});this.all({t:'owner',id:m.id,from:from?from.id:null});this.tell();
 }
 // someone left or lost their connection
 gone(me,left){
  const i=this.members.indexOf(me);if(i>=0)this.members.splice(i,1);
  if(me.role==='owner'&&this.ownerId===me.id){this.ownerId=null;
   // an owner who drops out without ending the session or handing it on: after a while the longest-standing editor takes over
   this.after('owner',this.ownerWait);}
  if(!this.members.length)this.after('empty',this.emptyWait);
  else this.tell();
 }
}
root.TSERoom=Room;root.TSERoomKey=randomKey;
})(typeof globalThis!=='undefined'?globalThis:this);
