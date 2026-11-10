module.exports = ({ config }) => {
  const serverUrl = process.env.FN_SERVER_URL || config.extra?.serverUrl;
  const serverTransport = process.env.FN_SERVER_TRANSPORT || config.extra?.serverTransport || (serverUrl && new URL(serverUrl).hostname.endsWith('.workers.dev') ? 'websocket' : 'socket.io');
  if (!['websocket', 'socket.io'].includes(serverTransport)) throw new Error('FN_SERVER_TRANSPORT must be websocket or socket.io.');
  if (process.env.FN_ONLINE_BUILD === '1') {
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('An online build requires FN_SERVER_URL with the deployed HTTPS address.');
  }
  return { ...config, extra: { ...config.extra, serverUrl, serverTransport } };
};
