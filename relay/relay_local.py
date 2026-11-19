#!/usr/bin/env python3
"""Terra Shape Explorer – shared session relay for testing on your own computer.

    python3 relay/relay_local.py            # listens on ws://127.0.0.1:8787/room/<room id>

Plain Python, nothing to install. The room rules are the same as room.js (used by the Cloudflare worker);
change both together. Only for local testing: it listens on this computer only and keeps rooms in memory.
"""
import asyncio, base64, hashlib, json, re, secrets, string, struct, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
OWNER_WAIT, EMPTY_WAIT = 60, 600


def rand_key(n=22):
    return ''.join(secrets.choice(ALPHA) for _ in range(n))


def clean(s, n):
    s = '' if s is None else str(s)
    return re.sub(r'[\x00-\x1f]', '', s).strip()[:n]


class Member:
    def __init__(self, id, dev, name, role, conn):
        self.id, self.dev, self.name, self.role, self.conn = id, dev, name, role, conn


class Room:
    def __init__(self):
        self.gen = 0
        self.reset()

    def reset(self):
        self.keys, self.members, self.banned, self.owner_id = None, [], set(), None
        self.gen += 1

    def roster(self):
        return [{'id': m.id, 'name': m.name, 'role': m.role} for m in self.members]

    def send(self, m, o):
        m.conn.send(json.dumps(o))

    def all(self, o, skip=None):
        s = json.dumps(o)
        for m in list(self.members):
            if m is not skip:
                m.conn.send(s)

    def tell(self):
        self.all({'t': 'roster', 'owner': self.owner_id, 'roster': self.roster()})

    def find(self, id):
        return next((m for m in self.members if m.id == id), None)

    def hello(self, conn, o):
        def fail(code):
            conn.send(json.dumps({'t': 'error', 'code': code}))
            conn.close()
        id, dev, name = clean(o.get('id'), 40), clean(o.get('dev'), 40), clean(o.get('name'), 40) or 'Guest'
        if not id:
            return fail('bad')
        if o.get('create'):
            if self.keys and self.members:
                return fail('exists')
            self.reset()
            self.keys = {'owner': rand_key(), 'edit': rand_key(), 'view': rand_key()}
            role = 'owner'
        else:
            if not self.keys:
                return fail('gone')
            k = str(o.get('key') or '')
            role = {self.keys['owner']: 'owner', self.keys['edit']: 'edit', self.keys['view']: 'view'}.get(k)
            if not role:
                return fail('badkey')
            if dev and dev in self.banned:
                return fail('banned')
        old = self.find(id)
        if old:
            self.members.remove(old)
            old.conn.close()
        if role == 'owner' and self.owner_id and self.owner_id != id and self.find(self.owner_id):
            role = 'edit'
        others = list(self.members)
        if not others and role != 'owner':
            return fail('empty')
        me = Member(id, dev, name, role, conn)
        self.members.append(me)
        if role == 'owner':
            self.owner_id = id
        w = {'t': 'welcome', 'you': id, 'role': role, 'owner': self.owner_id, 'roster': self.roster(), 'alone': not others}
        if role == 'owner':
            w['keys'] = self.keys
        self.send(me, w)
        if others:
            src = self.find(self.owner_id) or next((m for m in others if m.role == 'edit'), None) or others[0]
            self.send(src, {'t': 'need', 'id': id})
        self.tell()
        return me

    def handle(self, me, o):
        t = o.get('t')
        boss = me.role == 'owner'
        edit = boss or me.role == 'edit'
        to = self.find(o.get('to')) if o.get('to') is not None else None
        if t == 'name':
            me.name = clean(o.get('name'), 40) or me.name
            self.tell()
        elif t == 'op':
            if edit:
                o['from'] = me.id
                self.all(o)
        elif t == 'state':
            if to:
                self.send(to, {'t': 'state', 'from': me.id, 'data': o.get('data')})
        elif t == 'chunk':
            o['from'] = me.id
            if o.get('kind') == 'state':
                if to:
                    self.send(to, o)
            elif o.get('kind') == 'op' and edit:
                self.all(o)
        elif t == 'kick':
            m = self.find(o.get('id'))
            if boss and m and m is not me:
                if m.dev:
                    self.banned.add(m.dev)
                self.send(m, {'t': 'kicked'})
                self.members.remove(m)
                m.conn.close()
                self.tell()
        elif t == 'xfer':
            m = self.find(o.get('id'))
            if boss and m and m is not me and m.role == 'edit':
                self.promote(m, me)
        elif t == 'end':
            if boss:
                self.all({'t': 'ended'}, me)
                for m in list(self.members):
                    m.conn.close()
                self.reset()
        elif t == 'leave':
            if me in self.members:
                self.members.remove(me)
            me.conn.close()
            self.gone(me)

    def promote(self, m, frm):
        if frm:
            frm.role = 'edit'
        m.role = 'owner'
        self.owner_id = m.id
        self.keys['owner'] = rand_key()
        self.send(m, {'t': 'keys', 'keys': self.keys})
        self.all({'t': 'owner', 'id': m.id, 'from': frm.id if frm else None})
        self.tell()

    def gone(self, me):
        if me in self.members:
            self.members.remove(me)
        gen = self.gen
        loop = asyncio.get_event_loop()
        if me.role == 'owner' and self.owner_id == me.id:
            self.owner_id = None
            def later():
                if self.gen != gen or self.owner_id:
                    return
                n = next((m for m in self.members if m.role == 'edit'), None)
                if n:
                    self.promote(n, None)
            loop.call_later(OWNER_WAIT, later)
        if not self.members:
            loop.call_later(EMPTY_WAIT, lambda: self.reset() if self.gen == gen and not self.members else None)
        else:
            self.tell()


ROOMS = {}


def unmask(data, mask):
    if not data:
        return data
    m = (mask * (len(data) // 4 + 1))[:len(data)]
    return (int.from_bytes(data, 'big') ^ int.from_bytes(m, 'big')).to_bytes(len(data), 'big')


class Conn:
    """One WebSocket connection: text frames only, as the app sends."""
    def __init__(self, writer):
        self.w, self.open = writer, True

    def frame(self, op, data):
        n = len(data)
        head = bytes([0x80 | op])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack('>H', n)
        else:
            head += bytes([127]) + struct.pack('>Q', n)
        self.w.write(head + data)

    def send(self, s):
        if self.open:
            try:
                self.frame(1, s.encode())
            except Exception:
                self.open = False

    def close(self):
        if self.open:
            self.open = False
            try:
                self.frame(8, b'\x03\xe8')
                self.w.close()
            except Exception:
                pass


async def serve(reader, writer):
    try:
        req = await reader.readuntil(b'\r\n\r\n')
    except Exception:
        writer.close()
        return
    lines = req.decode('latin-1').split('\r\n')
    m = re.match(r'GET /room/([A-Za-z0-9]{8,40}) HTTP', lines[0])
    hdr = {k.strip().lower(): v.strip() for k, _, v in (l.partition(':') for l in lines[1:] if ':' in l)}
    if not m or 'sec-websocket-key' not in hdr:
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 27\r\n\r\nTerra Shape Explorer relay\n')
        await writer.drain()
        writer.close()
        return
    acc = base64.b64encode(hashlib.sha1((hdr['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
    writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n').encode())
    room = ROOMS.setdefault(m.group(1), Room())
    conn = Conn(writer)
    me = None
    buf = b''
    try:
        while conn.open:
            b0, b1 = await reader.readexactly(2)
            op, n = b0 & 15, b1 & 127
            if n == 126:
                n = struct.unpack('>H', await reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', await reader.readexactly(8))[0]
            if n > 8_000_000:
                break
            mask = await reader.readexactly(4) if b1 & 128 else b'\0\0\0\0'
            data = unmask(await reader.readexactly(n), mask)
            if op == 8:
                break
            if op == 9:
                conn.frame(10, data)
                continue
            if op in (0, 1):
                buf += data
                if not b0 & 128:
                    continue
                text, buf = buf.decode('utf-8', 'replace'), b''
                try:
                    o = json.loads(text)
                except Exception:
                    continue
                if not isinstance(o, dict):
                    continue
                if me is None:
                    if o.get('t') == 'hello':
                        me = room.hello(conn, o)
                elif me in room.members:
                    room.handle(me, o)
                await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        conn.open = False
        if me is not None and me in room.members and me.conn is conn:
            room.gone(me)
        try:
            writer.close()
        except Exception:
            pass


async def main():
    srv = await asyncio.start_server(serve, '127.0.0.1', PORT)
    print(f'Relay on ws://127.0.0.1:{PORT}/room/<id>  (Ctrl+C to stop)', flush=True)
    async with srv:
        await srv.serve_forever()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
