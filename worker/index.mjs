import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import rtc from '../server/rtc-config.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const open = socket => socket.readyState === 1;
const randomId = () => randomBytes(24).toString('hex');
const MAX_PACKET = 100000;

// A single fixed object owns both accounts. Clients cannot choose another room.
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!['/', '/health', '/ws'].includes(pathname)) return new Response('Not found', { status: 404 });
    if (pathname !== '/ws' && request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    return env.FN_ROOM.get(env.FN_ROOM.idFromName('fn-private-room')).fetch(request);
  },
};

export class PrivateRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (name TEXT PRIMARY KEY, token TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS login_limits (address TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until INTEGER NOT NULL)');
    if (typeof WebSocketRequestResponsePair !== 'undefined') ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  accounts() {
    const accounts = [1, 2].map(i => ({ name: this.env[`USER_${i}`], password: this.env[`PASSWORD_${i}`] }));
    if (accounts.some(a => typeof a.name !== 'string' || !a.name || a.name.length > 64 || typeof a.password !== 'string' || a.password.length < 16 || a.password.length > 128 || a.password.startsWith('replace-with-')) || accounts[0].name === accounts[1].name) return null;
    return accounts;
  }

  metadata(socket) { return socket.deserializeAttachment() || {}; }
  sockets() { return this.ctx.getWebSockets().filter(open); }
  authenticated(socket) {
    const data = this.metadata(socket);
    if (!data.name) return false;
    const session = this.sql.exec('SELECT token FROM sessions WHERE name = ?', data.name).toArray()[0];
    return Boolean(session && safeEqual(session.token, data.token));
  }
  emit(socket, event, data) { if (open(socket)) socket.send(JSON.stringify({ event, data })); }
  broadcast(event, data) { for (const socket of this.sockets()) if (this.authenticated(socket)) this.emit(socket, event, data); }
  sendTo(name, event, data) { for (const socket of this.sockets()) if (this.metadata(socket).name === name && this.authenticated(socket)) this.emit(socket, event, data); }
  presence() { this.broadcast('presence', [...new Set(this.sockets().filter(s => this.authenticated(s)).map(s => this.metadata(s).name))]); }
  readCall() { const row = this.sql.exec("SELECT value FROM room_state WHERE key = 'call'").toArray()[0]; return row ? JSON.parse(row.value) : null; }
  saveCall(call) { this.sql.exec("INSERT OR REPLACE INTO room_state (key, value) VALUES ('call', ?)", JSON.stringify(call)); }
  endCall(reason) {
    const call = this.readCall();
    if (!call) return;
    this.sql.exec("DELETE FROM room_state WHERE key = 'call'");
    for (const name of [call.caller, call.callee]) this.sendTo(name, 'call-ended', { id: call.id, reason });
  }
  async scheduleAlarm() {
    const deadlines = this.sockets().filter(s => !this.metadata(s).name).map(s => this.metadata(s).expires);
    const call = this.readCall();
    if (call && !call.accepted) deadlines.push(call.expires);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }

  async fetch(request) {
    const accounts = this.accounts();
    if (new URL(request.url).pathname !== '/ws') {
      this.sql.exec('SELECT 1');
      return json({ status: accounts ? 'ok' : 'needs_configuration', transport: 'websocket', callsConfigured: Boolean((this.env.CF_TURN_KEY_ID && this.env.CF_TURN_API_TOKEN) || (this.env.TURN_URLS && this.env.TURN_SHARED_SECRET)) }, accounts ? 200 : 503);
    }
    if (!accounts) return new Response('Configure the two account passwords first.', { status: 503 });
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
    // No credentials in URLs, access logs or WebSocket subprotocols. Authentication
    // is the first encrypted WebSocket message; unauthenticated sockets expire.
    const address = createHash('sha256').update(request.headers.get('CF-Connecting-IP') || 'unknown').digest('hex');
    const limit = this.sql.exec('SELECT attempts, until FROM login_limits WHERE address = ?', address).toArray()[0];
    if (limit && limit.until > Date.now() && limit.attempts >= 8) return new Response('Too many login attempts', { status: 429 });
    if (this.sockets().filter(s => !this.metadata(s).name).length >= 12) return new Response('Try again shortly', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ address, expires: Date.now() + 20000 });
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  deny(socket, message) {
    this.emit(socket, 'connect_error', { message });
    socket.close(4001, 'Authentication rejected');
  }

  authenticate(socket, auth) {
    const meta = this.metadata(socket);
    if (meta.name) return;
    if (meta.expires <= Date.now()) return this.deny(socket, 'انتهت مهلة تسجيل الدخول');
    const limit = this.sql.exec('SELECT attempts, until FROM login_limits WHERE address = ?', meta.address).toArray()[0];
    if (limit && limit.until > Date.now() && limit.attempts >= 8) return this.deny(socket, 'محاولات كثيرة. حاول بعد عشر دقائق.');
    const account = this.accounts()?.find(a => typeof auth?.username === 'string' && auth.username.length <= 64 && typeof auth.password === 'string' && auth.password.length <= 128 && safeEqual(a.name, auth.username) && safeEqual(a.password, auth.password));
    if (!account) {
      const now = Date.now(), fresh = !limit || limit.until <= now;
      this.sql.exec('DELETE FROM login_limits WHERE until <= ?', now);
      const count = this.sql.exec('SELECT COUNT(*) AS total FROM login_limits').toArray()[0].total;
      if (count >= 5000 && !limit) return this.deny(socket, 'محاولات كثيرة. حاول لاحقًا.');
      this.sql.exec('INSERT OR REPLACE INTO login_limits (address, attempts, until) VALUES (?, ?, ?)', meta.address, fresh ? 1 : limit.attempts + 1, fresh ? now + 600000 : limit.until);
      return this.deny(socket, 'اسم المستخدم أو كلمة المرور غير صحيحين');
    }
    const previous = this.sql.exec('SELECT token FROM sessions WHERE name = ?', account.name).toArray()[0];
    const resuming = previous && typeof auth.sessionToken === 'string' && auth.sessionToken.length <= 128 && safeEqual(previous.token, auth.sessionToken);
    const existing = this.sockets().filter(s => s !== socket && this.metadata(s).name === account.name && this.authenticated(s));
    if (existing.length && !resuming) return this.deny(socket, 'الحساب مفتوح بالفعل على جهاز آخر');
    const token = resuming ? previous.token : randomId();
    this.sql.exec('INSERT OR REPLACE INTO sessions (name, token) VALUES (?, ?)', account.name, token);
    this.sql.exec('DELETE FROM login_limits WHERE address = ?', meta.address);
    socket.serializeAttachment({ name: account.name, token, windowStart: Date.now(), events: 0 });
    for (const old of existing) {
      old.serializeAttachment({ replaced: true });
      this.emit(old, 'server-disconnect', {});
      old.close(4002, 'Session resumed on another connection');
    }
    const messages = this.sql.exec('SELECT id, sender AS "from", text, at FROM (SELECT rowid, * FROM messages ORDER BY at DESC, rowid DESC LIMIT 500) ORDER BY at ASC, rowid ASC').toArray();
    this.emit(socket, 'ready', { name: account.name, partner: this.accounts().find(a => a.name !== account.name).name, messages, sessionToken: token });
    this.presence();
  }

  async webSocketMessage(socket, value) {
    if (!open(socket)) return;
    if (value === 'ping') { socket.send('pong'); return; }
    if (typeof value !== 'string' || new TextEncoder().encode(value).length > MAX_PACKET) { socket.close(1009, 'Invalid packet'); return; }
    let packet;
    try { packet = JSON.parse(value); } catch { socket.close(1003, 'Invalid JSON'); return; }
    if (!packet || typeof packet.event !== 'string') { socket.close(1003, 'Invalid event'); return; }
    const ack = data => { if (Number.isSafeInteger(packet.id) && packet.id > 0 && open(socket)) socket.send(JSON.stringify({ ack: packet.id, data })); };
    try {
      if (packet.event === 'auth') { this.authenticate(socket, packet.data); await this.scheduleAlarm(); return; }
      if (!this.authenticated(socket)) { this.deny(socket, 'سجل الدخول أولًا'); return; }
      const meta = this.metadata(socket), now = Date.now();
      if (now - meta.windowStart >= 10000) { meta.windowStart = now; meta.events = 0; }
      meta.events++;
      socket.serializeAttachment(meta);
      if (meta.events > 600) { ack({ error: 'طلبات كثيرة. حاول بعد لحظات.' }); return; }
      const name = meta.name, data = packet.data;
      let call = this.readCall();
      if (call && !call.accepted && call.expires <= now) { this.endCall('unanswered'); call = null; }
      switch (packet.event) {
        case 'message': {
          const text = typeof data === 'string' ? data.trim().slice(0, 2000) : '';
          if (!text) { ack({ error: 'الرسالة فارغة' }); break; }
          const message = { id: randomId(), from: name, text, at: now };
          this.sql.exec('INSERT INTO messages (id, sender, text, at) VALUES (?, ?, ?, ?)', message.id, name, text, now);
          this.broadcast('message', message); ack({ ok: true }); break;
        }
        case 'rtc-config': {
          // Chat remains available without TURN. Calls fail explicitly until it
          // is configured; there is no unreliable STUN-only production fallback.
          try {
            const config = await rtc.createRtcProvider({ ...this.env, NODE_ENV: 'production' })(name);
            if (this.authenticated(socket)) ack(config);
          } catch { ack({ error: 'خدمة المكالمات غير متاحة. يلزم ضبط TURN على الخادم.' }); }
          break;
        }
        case 'call': {
          const peer = this.accounts().find(a => a.name !== name).name;
          if (call) { ack({ error: 'توجد مكالمة جارية بالفعل' }); break; }
          if (!this.sockets().some(s => this.metadata(s).name === peer && this.authenticated(s))) { ack({ error: 'الطرف الآخر غير متصل' }); break; }
          call = { id: randomId(), caller: name, callee: peer, type: data === 'video' ? 'video' : 'voice', accepted: false, expires: now + 60000 };
          this.saveCall(call); await this.scheduleAlarm(); ack({ id: call.id, type: call.type }); break;
        }
        case 'call-ready':
          if (call && call.id === data?.id && call.caller === name && !call.ringing) { call.ringing = true; this.saveCall(call); this.sendTo(call.callee, 'incoming-call', { id: call.id, from: name, type: call.type }); }
          break;
        case 'call-answer':
          if (!call || call.id !== data?.id || call.callee !== name || call.accepted) { ack({ error: 'انتهت المكالمة' }); break; }
          if (data.accept !== true) { this.endCall('declined'); ack({ ok: true }); await this.scheduleAlarm(); break; }
          call.accepted = true; this.saveCall(call); await this.scheduleAlarm(); ack({ ok: true }); this.sendTo(call.caller, 'call-accepted', { id: call.id }); break;
        case 'call-signal':
          if (call && call.id === data?.id && call.accepted && [call.caller, call.callee].includes(name) && data.signal && ['offer', 'answer', 'candidate'].includes(data.signal.type)) this.sendTo(name === call.caller ? call.callee : call.caller, 'call-signal', { id: call.id, signal: data.signal });
          break;
        case 'call-end':
          if (call && call.id === data?.id && [call.caller, call.callee].includes(name)) { this.endCall('ended'); await this.scheduleAlarm(); }
          break;
        default: ack({ error: 'طلب غير معروف' });
      }
    } catch { ack({ error: 'تعذر تنفيذ الطلب. حاول مرة أخرى.' }); }
  }

  async cleanup(socket) {
    const name = this.metadata(socket).name;
    socket.serializeAttachment({ closed: true });
    if (name && !this.sockets().some(s => s !== socket && this.metadata(s).name === name && this.authenticated(s))) {
      const call = this.readCall();
      if (call && [call.caller, call.callee].includes(name)) this.endCall('disconnected');
    }
    this.presence();
    await this.scheduleAlarm();
  }
  async webSocketClose(socket, code) { socket.close(code === 1005 || code === 1006 ? 1000 : code, 'Closed'); await this.cleanup(socket); }
  async webSocketError(socket) { socket.close(1011, 'Connection error'); await this.cleanup(socket); }
  async alarm() {
    for (const socket of this.sockets()) if (!this.metadata(socket).name && this.metadata(socket).expires <= Date.now()) socket.close(4001, 'Login timed out');
    const call = this.readCall();
    if (call && !call.accepted && call.expires <= Date.now()) this.endCall('unanswered');
    this.sql.exec('DELETE FROM login_limits WHERE until <= ?', Date.now());
    await this.scheduleAlarm();
  }
}
