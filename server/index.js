require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { openStorage } = require('./storage');
const { createRtcProvider } = require('./rtc-config');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

async function main() {
  const credentials = [1, 2].map(i => ({ name: process.env[`USER_${i}`], password: process.env[`PASSWORD_${i}`] }));
  if (credentials.some(c => !c.name || !c.password || c.name.length > 64 || c.password.length > 128 || c.password.startsWith('replace-with-')) || credentials[0].name === credentials[1].name) throw new Error('Configure two distinct accounts in server/.env or the hosting secret environment.');
  if (process.env.NODE_ENV === 'production' && credentials.some(c => c.password.length < 16)) throw new Error('Production account passwords must have at least 16 characters.');
  const getRtcConfig = createRtcProvider();
  const storage = await openStorage();
  const http = createServer(async (req, res) => {
    if (req.url !== '/' && req.url !== '/health') { res.writeHead(404); return res.end(); }
    try { await storage.ping(); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ status: 'ok' })); }
    catch { res.writeHead(503); res.end('Unavailable'); }
  });
  const io = new Server(http, { maxHttpBufferSize: 100000, pingInterval: 10000, pingTimeout: 15000 });
  const online = new Map(); const sessions = new Map(); const failures = new Map();
  let activeCall = null; let ringTimer = null;
  const sendTo = (name, event, data) => { const id = online.get(name); if (id) io.to(id).emit(event, data); };
  function endCall(reason) {
    if (!activeCall) return;
    clearTimeout(ringTimer); ringTimer = null;
    const previous = activeCall; activeCall = null;
    for (const name of [previous.caller, previous.callee]) sendTo(name, 'call-ended', { id: previous.id, reason });
  }
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    const address = socket.handshake.address || 'unknown';
    const bucket = failures.get(address);
    if (bucket && bucket.until > Date.now() && bucket.count >= 8) return next(new Error('محاولات كثيرة. حاول بعد عشر دقائق.'));
    const account = credentials.find(c => typeof auth.username === 'string' && typeof auth.password === 'string' && auth.username.length <= 64 && auth.password.length <= 128 && safeEqual(c.name, auth.username) && safeEqual(c.password, auth.password));
    if (!account) {
      if (failures.size > 10000) failures.clear();
      failures.set(address, { count: bucket && bucket.until > Date.now() ? bucket.count + 1 : 1, until: bucket && bucket.until > Date.now() ? bucket.until : Date.now() + 600000 });
      return next(new Error('اسم المستخدم أو كلمة المرور غير صحيحين'));
    }
    failures.delete(address);
    const knownToken = sessions.get(account.name);
    const resuming = knownToken && typeof auth.sessionToken === 'string' && safeEqual(knownToken, auth.sessionToken);
    if (online.has(account.name) && !resuming) return next(new Error('الحساب مفتوح بالفعل على جهاز آخر'));
    if (resuming && online.has(account.name)) io.sockets.sockets.get(online.get(account.name))?.disconnect(true);
    const token = resuming ? knownToken : randomBytes(32).toString('hex');
    sessions.set(account.name, token); socket.data.sessionToken = token;
    socket.data.username = account.name; online.set(account.name, socket.id); next();
  });
  io.on('connection', async socket => {
    const name = socket.data.username;
    // Register cleanup immediately, including when a database read is interrupted.
    socket.on('disconnect', () => {
      if (online.get(name) !== socket.id) return;
      online.delete(name); if (activeCall && [activeCall.caller, activeCall.callee].includes(name)) endCall('disconnected');
      io.emit('presence', [...online.keys()]);
    });
    socket.on('rtc-config', async ack => {
      if (typeof ack !== 'function') return;
      try { ack(await getRtcConfig(name)); } catch { ack({ error: 'خدمة المكالمات غير متاحة حاليًا. حاول مرة أخرى.' }); }
    });
    socket.on('message', async (value, ack) => {
      const text = typeof value === 'string' ? value.trim().slice(0, 2000) : '';
      if (!text) return;
      const message = { id: randomBytes(12).toString('hex'), from: name, text, at: Date.now() };
      try { await storage.insert(message); io.emit('message', message); if (typeof ack === 'function') ack({ ok: true }); }
      catch { if (typeof ack === 'function') ack({ error: 'تعذر حفظ الرسالة' }); }
    });
    socket.on('call', (type, ack) => {
      if (typeof ack !== 'function') return;
      const peer = credentials.find(c => c.name !== name).name;
      if (!online.has(peer)) return ack({ error: 'الطرف الآخر غير متصل' });
      if (activeCall) return ack({ error: 'توجد مكالمة جارية بالفعل' });
      activeCall = { id: randomBytes(24).toString('hex'), caller: name, callee: peer, type: type === 'video' ? 'video' : 'voice', accepted: false };
      ringTimer = setTimeout(() => endCall('unanswered'), 60000); ringTimer.unref();
      ack({ id: activeCall.id, type: activeCall.type });
    });
    socket.on('call-ready', ({ id } = {}) => {
      if (activeCall && activeCall.id === id && activeCall.caller === name && !activeCall.ringing) {
        activeCall.ringing = true; sendTo(activeCall.callee, 'incoming-call', { id, from: name, type: activeCall.type });
      }
    });
    socket.on('call-answer', ({ id, accept } = {}, ack) => {
      if (!activeCall || activeCall.id !== id || activeCall.callee !== name || activeCall.accepted) return typeof ack === 'function' && ack({ error: 'انتهت المكالمة' });
      if (accept !== true) { endCall('declined'); return typeof ack === 'function' && ack({ ok: true }); }
      activeCall.accepted = true; clearTimeout(ringTimer); ringTimer = null;
      if (typeof ack === 'function') ack({ ok: true });
      sendTo(activeCall.caller, 'call-accepted', { id });
    });
    socket.on('call-signal', ({ id, signal } = {}) => {
      if (!activeCall || activeCall.id !== id || !activeCall.accepted || ![activeCall.caller, activeCall.callee].includes(name)) return;
      if (!signal || !['offer', 'answer', 'candidate'].includes(signal.type) || JSON.stringify(signal).length > 100000) return;
      sendTo(name === activeCall.caller ? activeCall.callee : activeCall.caller, 'call-signal', { id, signal });
    });
    socket.on('call-end', ({ id } = {}) => { if (activeCall && activeCall.id === id && [activeCall.caller, activeCall.callee].includes(name)) endCall('ended'); });
    try {
      const messages = await storage.history();
      if (!socket.connected) return;
      socket.emit('ready', { name, partner: credentials.find(c => c.name !== name).name, messages, sessionToken: socket.data.sessionToken });
      io.emit('presence', [...online.keys()]);
    } catch { socket.emit('service-error', 'تعذر تحميل الرسائل'); socket.disconnect(true); }
  });
  http.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log('F&N server listening'));
  process.once('SIGTERM', () => { endCall('server-restarting'); io.close(async () => { await storage.close(); process.exit(0); }); });
}
main().catch(error => { console.error('Server startup failed:', error.message); process.exit(1); });
