/* Terra Shape Explorer – shared session relay for Cloudflare Workers (one Durable Object per room).
   wss://<your-worker>/room/<room id>  — the app connects here; everything else gets a short text reply.
   The room rules are in room.js.

   The connections use Cloudflare's WebSocket Hibernation API: while nobody sends anything the room is put to sleep and is not billed,
   even with people connected. Sleeping clears memory, so the room keeps what it has to remember (keys, owner, who is in it and with
   which role, who was removed, pending timers) in its own storage, and each connection carries its member id. When a message arrives
   the room is woken, read back and carries on. Design changes are only passed on, never stored.
   Timers (an owner who dropped out, a room everyone left) are kept in storage and run by the room's alarm.
   When the room is over (ended, or empty for ten minutes) its storage is cleared. */
import './room.js';
const Room=globalThis.TSERoom;
const ALLOW=[/^https:\/\/htims-xela\.github\.io$/,/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/]; // pages that may connect
const MAX=1100000; // longest message passed on (the app sends long ones in pieces of 200 000)

export default{
 async fetch(req,env){
  const url=new URL(req.url),m=url.pathname.match(/^\/room\/([A-Za-z0-9]{8,40})$/);
  if(!m)return new Response('Terra Shape Explorer relay',{status:200});
  if(req.headers.get('Upgrade')!=='websocket')return new Response('Expected a WebSocket',{status:426});
  const origin=req.headers.get('Origin')||'';if(!ALLOW.some(r=>r.test(origin)))return new Response('Not allowed',{status:403});
  return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
 }
};

export class RoomObject{
 constructor(ctx,env){this.ctx=ctx;this.conns=new WeakMap();this.ready=null;this.room=null;this.timers=[];}
 // one connection object per WebSocket, for the room rules (the same one every time, so the rules can find its member)
 conn(ws){let c=this.conns.get(ws);if(!c){c={ws,send:s=>{try{ws.send(s);}catch(e){}},close:()=>{try{ws.close(1000,'');}catch(e){}}};this.conns.set(ws,c);}return c;}
 // the room as it was before it slept (or a fresh one)
 load(){return this.ready||(this.ready=(async()=>{
  const r=new Room({timer:(kind,gen,ms)=>this.timer(kind,gen,ms),change:()=>this.save()}),d=await this.ctx.storage.get('room');
  if(d){const byId=new Map();for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment();if(a&&a.id)byId.set(a.id,ws);}
   r.restore(d,m=>{const ws=byId.get(m.id);return ws?this.conn(ws):null;});this.timers=Array.isArray(d.timers)?d.timers:[];
   // anyone who left while it slept is gone now
   if(r.members.length!==(d.members||[]).length){for(const m of d.members||[])if(!r.members.some(x=>x.id===m.id)&&m.id===r.ownerId){r.ownerId=null;r.after('owner',r.ownerWait);}if(!r.members.length&&r.keys)r.after('empty',r.emptyWait);this.save();}}
  this.room=r;return r;})());}
 save(){const r=this.room;if(!r)return;
  for(const m of r.members)if(!m.conn.tagged){try{m.conn.ws.serializeAttachment({id:m.id});}catch(e){}m.conn.tagged=true;}
  if(!r.keys&&!r.members.length){this.timers=[];this.ctx.storage.deleteAll();this.ctx.storage.deleteAlarm();return;} // the room is over: nothing is kept
  this.ctx.storage.put('room',Object.assign(r.dump(),{timers:this.timers}));}
 timer(kind,gen,ms){this.timers=this.timers.filter(t=>!(t.kind===kind&&t.gen===gen));this.timers.push({kind,gen,at:Date.now()+ms});this.alarmAt();}
 alarmAt(){if(this.timers.length)this.ctx.storage.setAlarm(Math.min(...this.timers.map(t=>t.at)));else this.ctx.storage.deleteAlarm();}
 async alarm(){const r=await this.load(),now=Date.now(),due=this.timers.filter(t=>t.at<=now+50);this.timers=this.timers.filter(t=>t.at>now+50);
  for(const t of due)r.fire(t.kind,t.gen);this.alarmAt();this.save();}
 async fetch(req){
  const[client,server]=Object.values(new WebSocketPair());
  this.ctx.acceptWebSocket(server); // hibernatable: no charge while it waits
  return new Response(null,{status:101,webSocket:client});
 }
 async webSocketMessage(ws,data){if(typeof data!=='string'||data.length>MAX)return;const r=await this.load();r.msg(this.conn(ws),data);}
 async webSocketClose(ws){const r=await this.load();r.drop(this.conn(ws));try{ws.close(1000,'');}catch(e){}}
 async webSocketError(ws){const r=await this.load();r.drop(this.conn(ws));}
}
