/* Terra Shape Explorer – shared session relay for Cloudflare Workers (one Durable Object per room).
   wss://<your-worker>/room/<room id>  — the app connects here; everything else gets a short text reply.
   The room rules are in room.js. Rooms live in memory only: when everyone has left for ten minutes the room is gone. */
import './room.js';
const Room=globalThis.TSERoom;
const ALLOW=[/^https:\/\/htims-xela\.github\.io$/,/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/]; // pages that may connect

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
 constructor(state){this.room=new Room({});}
 async fetch(req){
  const[client,server]=Object.values(new WebSocketPair());server.accept();
  const h=this.room.open({send:s=>server.send(s),close:()=>{try{server.close(1000,'');}catch(e){}}});
  server.addEventListener('message',e=>{if(typeof e.data==='string'&&e.data.length<=1100000)h.message(e.data);});
  server.addEventListener('close',()=>h.close());server.addEventListener('error',()=>h.close());
  return new Response(null,{status:101,webSocket:client});
 }
}
