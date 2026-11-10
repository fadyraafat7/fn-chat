// The mobile app uses the same event/ack interface for Socket.IO and Workers.
// Workers speaks native WebSocket, not the Socket.IO wire protocol.
class WorkerSocket {
  constructor(url, options = {}) {
    this.url = url.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws';
    this.auth = { ...options.auth };
    this.WebSocket = options.WebSocketImpl || globalThis.WebSocket;
    this.handlers = new Map(); this.pending = new Map(); this.nextId = 1;
    this.connected = false; this.active = true; this.stopped = false; this.attempt = 0;
    this.startTimer = setTimeout(() => this.connect(), 0);
  }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event).add(handler); return this; }
  off(event, handler) { if (handler) this.handlers.get(event)?.delete(handler); else this.handlers.delete(event); return this; }
  dispatch(event, data) { for (const handler of this.handlers.get(event) || []) handler(data); }
  clearTimers() { clearTimeout(this.deadline); clearInterval(this.heartbeat); }
  failPending() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.callback(...(item.errorFirst ? [new Error('Connection interrupted')] : [{ error: 'انقطع الاتصال' }])); }
    this.pending.clear();
  }
  connect() {
    clearTimeout(this.startTimer); clearTimeout(this.retry);
    if (this.ws && this.ws.readyState <= 1) return this;
    this.stopped = false; this.active = true;
    const ws = new this.WebSocket(this.url); this.ws = ws;
    this.deadline = setTimeout(() => { if (this.ws === ws) ws.close(); }, 75000);
    ws.onopen = () => { if (this.ws === ws && !this.stopped) ws.send(JSON.stringify({ event: 'auth', data: this.auth })); };
    ws.onmessage = ({ data }) => {
      if (this.ws !== ws || this.stopped) return;
      this.lastSeen = Date.now();
      if (data === 'pong') return;
      let packet; try { packet = JSON.parse(data); } catch { return; }
      if (packet.ack) {
        const item = this.pending.get(packet.ack);
        if (item) { clearTimeout(item.timer); this.pending.delete(packet.ack); item.callback(...(item.errorFirst ? [null, packet.data] : [packet.data])); }
        return;
      }
      if (packet.event === 'connect_error') {
        this.active = false; this.stopped = true; this.connected = false; this.clearTimers(); this.failPending();
        this.dispatch('connect_error', new Error(packet.data?.message || 'تعذر تسجيل الدخول')); ws.close(); return;
      }
      if (packet.event === 'server-disconnect') {
        this.stopped = true; this.active = false; this.connected = false; this.clearTimers(); this.failPending();
        this.dispatch('disconnect', 'io server disconnect'); ws.close(); return;
      }
      if (packet.event === 'ready') {
        this.auth.sessionToken = packet.data.sessionToken;
        this.connected = true; this.attempt = 0; this.clearTimers();
        this.heartbeat = setInterval(() => { if (Date.now() - this.lastSeen > 60000) ws.close(); else if (ws.readyState === 1) ws.send('ping'); }, 25000);
        this.dispatch('connect');
      }
      if (typeof packet.event === 'string') this.dispatch(packet.event, packet.data);
    };
    ws.onerror = () => { if (this.ws === ws && !this.stopped) this.dispatch('connect_error', new Error('تعذر الاتصال بالخادم')); };
    ws.onclose = ({ code } = {}) => {
      if (this.ws !== ws) return;
      this.ws = null; this.connected = false; this.clearTimers(); this.failPending();
      if (this.stopped) return;
      if (code === 4001 || code === 4002) {
        this.active = false; this.stopped = true; this.dispatch('disconnect', 'io server disconnect');
        this.dispatch('connect_error', new Error('انتهى الاتصال. سجّل الدخول مرة أخرى.')); return;
      }
      this.dispatch('disconnect', 'transport close');
      this.retry = setTimeout(() => this.connect(), Math.min(10000, 2000 * 2 ** Math.min(this.attempt++, 3)));
    };
    return this;
  }
  send(event, args, timeout) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    if (!this.connected || this.ws?.readyState !== 1) {
      if (callback) callback(...(timeout ? [new Error('Not connected')] : [{ error: 'غير متصل' }]));
      return this;
    }
    const packet = { event, data: args[0] };
    if (callback) {
      const id = this.nextId++; packet.id = id;
      const timer = setTimeout(() => { this.pending.delete(id); callback(...(timeout ? [new Error('Request timed out')] : [{ error: 'انتهت مهلة الطلب' }])); }, timeout || 20000);
      this.pending.set(id, { callback, timer, errorFirst: Boolean(timeout) });
    }
    try { this.ws.send(JSON.stringify(packet)); }
    catch { this.ws.close(); this.failPending(); }
    return this;
  }
  emit(event, ...args) { return this.send(event, args, null); }
  timeout(ms) { return { emit: (event, ...args) => this.send(event, args, ms) }; }
  disconnect() {
    const wasConnected = this.connected;
    this.stopped = true; this.active = false; this.connected = false;
    clearTimeout(this.startTimer); clearTimeout(this.retry); this.clearTimers();
    this.failPending(); const ws = this.ws; this.ws = null; ws?.close();
    if (wasConnected) this.dispatch('disconnect', 'io client disconnect');
    return this;
  }
}
module.exports = { WorkerSocket, createWorkerSocket: (url, options) => new WorkerSocket(url, options) };
