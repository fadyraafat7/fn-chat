module.exports = ({ config }) => {
  const serverUrl = process.env.FN_SERVER_URL || config.extra?.serverUrl;
  if (process.env.FN_ONLINE_BUILD === '1') {
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('An online build requires FN_SERVER_URL with the deployed HTTPS address.');
  }
  return { ...config, extra: { ...config.extra, serverUrl } };
};
