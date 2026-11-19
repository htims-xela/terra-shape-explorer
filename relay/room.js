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
 constructor(o){o=o||{};this.later=o.setTimeout||((f,ms)=>setTimeout(f,ms));this.rand=o.rand||randomKey;this.ownerWait=o.ownerWait??60000;this.emptyWait=o.emptyWait??600000;this.reset();}
 reset(){this.keys=null;this.members=[];this.banned=new Set();this.ownerId=null;this.gen=(this.gen||0)+1;}
 roster(){return this.members.map(m=>({id:m.id,name:m.name,role:m.role}));}
 send(m,o){try{m.conn.send(JSON.stringify(o));}catch(e){}}
 all(o,skip){const s=JSON.stringify(o);for(const m of this.members)if(m!==skip)try{m.conn.send(s);}catch(e){}}
 tell(){this.all({t:'roster',owner:this.ownerId,roster:this.roster()});}
 // a new connection: returns {message(text), close()} for the server to call
 open(conn){
  let me=null;const room=this;
  const fail=code=>{try{conn.send(JSON.stringify({t:'error',code}));}catch(e){}try{conn.close();}catch(e){}};
  return{
   message(text){let o;try{o=JSON.parse(text);}catch(e){return;}if(!o||typeof o!=='object')return;
    if(!me){if(o.t!=='hello')return;me=room.hello(conn,o,fail);return;}
    if(!room.members.includes(me))return;
    room.handle(me,o);},
   close(){if(me&&room.members.includes(me)&&me.conn===conn)room.gone(me);me=null;}
  };
 }
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
  const gen=this.gen;
  if(me.role==='owner'&&this.ownerId===me.id){this.ownerId=null;
   // an owner who drops out without ending the session or handing it on: after a while the longest-standing editor takes over
   this.later(()=>{if(this.gen!==gen||this.ownerId)return;const n=this.members.find(m=>m.role==='edit');if(n)this.promote(n,null);},this.ownerWait);}
  if(!this.members.length)this.later(()=>{if(this.gen===gen&&!this.members.length)this.reset();},this.emptyWait);
  else this.tell();
 }
}
root.TSERoom=Room;root.TSERoomKey=randomKey;
})(typeof globalThis!=='undefined'?globalThis:this);
