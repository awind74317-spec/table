const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i;

export function normalizeRemoteAccess(value) {
  if (value == null) return null;
  const url = new URL(value.origin);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(url.hostname)
      || value.origin !== url.origin || !String(value.userLogin || '').trim()) {
    throw new Error('手機連線設定無效：需要私人 Tailscale HTTPS 網址與使用者身份');
  }
  return { origin: url.origin, host: url.host, userLogin: String(value.userLogin).trim() };
}

export function requestAccess(req, remote) {
  const headers = req.headers;
  const host = String(headers.host || '');
  const origin = headers.origin;
  const proxied = ['x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto',
    'tailscale-user-login', 'tailscale-funnel-request'].some(key => key in headers);
  if (proxied || !LOOPBACK.test(host)) {
    // The server stays loopback-only; Serve strips spoofed identity headers before forwarding.
    if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        || host !== remote.host || headers['x-forwarded-host'] !== remote.host
        || headers['x-forwarded-proto'] !== 'https'
        || headers['tailscale-user-login'] !== remote.userLogin
        || 'tailscale-funnel-request' in headers) return { error: '私人手機連線未通過身份確認' };
    if (origin && origin !== remote.origin) return { error: 'forbidden origin' };
    return { remote: true, origin: remote.origin };
  }
  if (origin && origin !== 'null') {
    try { if (!LOOPBACK.test(new URL(origin).host)) return { error: 'forbidden origin' }; }
    catch { return { error: 'forbidden origin' }; }
  }
  return { remote: false, origin: `http://${host}` };
}
