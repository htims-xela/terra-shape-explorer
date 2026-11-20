# Shared session relay

The app's **Collaborate** section lets several people work on one design at once. Their browsers talk through this small relay server. The relay only knows who is in each session and what they're allowed to do. It passes design changes along and never stores them.

| File | What it is |
|---|---|
| `room.js` | The rules for one session: keys, roles, removing people, handing over, ending. Used by the worker and by `tests.html`. |
| `worker.js`, `wrangler.toml` | The relay as a Cloudflare Worker (one Durable Object per session), using hibernation so idle sessions cost nothing. |
| `hibernate-test.mjs` | Checks `worker.js` with the room put to sleep between every two events: `node relay/hibernate-test.mjs`. Run it before a deploy. |
| `relay_local.py` | The same rules in plain Python, for testing on your own computer. Nothing to install. |

If you change the rules, change `room.js` and `relay_local.py` together.

## Testing on your own computer

```bash
python3 relay/relay_local.py
```

It listens on `ws://127.0.0.1:8787`. When the app is opened from `localhost` / `127.0.0.1`, it uses this relay automatically (add `?relay=ws://…` to use another one). Open the app in two tabs or two browsers, start a session in one, and open an invite link in the other.

## Putting it online (Cloudflare, free plan)

1. Install Node.js, then `npm install -g wrangler` and `wrangler login`.
2. From this folder, run `wrangler deploy`. It prints an address like `https://terra-shape-relay.<account>.workers.dev`.
3. In `index.html`, set `COL_RELAY_URL` to that address with `wss://` in front, e.g. `wss://terra-shape-relay.<account>.workers.dev`.
4. If the app is served from somewhere other than `htims-xela.github.io`, add that origin to `ALLOW` in `worker.js`.

## Limits of this prototype

- The relay uses Cloudflare's WebSocket hibernation: while nobody sends anything, the session's room sleeps and isn't billed, even with people connected. So an open but quiet session, or a forgotten tab, costs next to nothing.
- To wake up where it left off, a room keeps a small record in its own storage: the invite keys, who is in it and with which role, who was removed, and its timers. The design itself is never stored: the relay only passes changes on.
- Once everyone has left, the session is gone after ten minutes, and its record is deleted. Ending a session deletes it straight away.
- Restarting or redeploying the relay drops everyone's connection, but the session survives: the apps reconnect by themselves and carry on. Anyone who is back before the owner keeps retrying for up to two minutes.
- Invite links are the only key. Anyone with an edit link can edit, so share links privately. Removing someone blocks their browser from rejoining with that link, but a different browser could still use it.
- If two people change the same measure at the same moment, the later change wins.

## The app's password

The public site asks for a password before the app opens. `index.html` holds only a fingerprint of it (`GATE.hash`), never the password itself. To set or change the password, run this and put the printed fingerprint into `GATE.hash`:

```bash
python3 -c "import hashlib,getpass;print(hashlib.pbkdf2_hmac('sha256',getpass.getpass('Password: ').encode(),b'terra-shape-explorer',200000).hex())"
```

A device that has typed the password remembers it. Changing the password locks every device again. An empty `GATE.hash` turns the password off.

Someone who opens a shared-session invite link gets into that session without the password, but only while the session lasts. Nothing is remembered, and when the session ends they're back at the password screen. This lock only keeps casual visitors out: the page's source is public, so anyone determined can get around it.
