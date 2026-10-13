import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'UnsafeUrlError';
    this.status = 400;
  }
}

/** True for loopback, private, link-local, CGNAT, multicast, unique-local and other non-public addresses. */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(l);
  }
  return true; // not an IP we understand
}

/** Syntactic check; DNS is checked again at connect time by safeLookup. */
export function assertSafeUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new UnsafeUrlError('Not a valid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new UnsafeUrlError('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new UnsafeUrlError('URLs with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeUrlError('Internal hostnames are not allowed');
  }
  if (net.isIP(host) && isPrivateIp(host)) throw new UnsafeUrlError('Private IP addresses are not allowed');
  return u;
}

/** Resolves and validates at connection time, which closes the DNS-rebinding gap of a check-then-fetch. */
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true, ...opts }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad) return cb(new UnsafeUrlError(`${hostname} resolves to a non-public address`));
    if (opts?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/**
 * GET with SSRF protections: scheme/host validation, validated DNS, manual redirect handling
 * (each hop re-validated), timeout and a hard response size cap.
 */
export function safeGet(url, { timeoutMs = 12000, maxBytes = 3_000_000, maxRedirects = 4, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const hop = (current, left) => {
      let u;
      try {
        u = assertSafeUrl(current);
      } catch (e) {
        return reject(e);
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(
        u,
        {
          lookup: safeLookup,
          timeout: timeoutMs,
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; ProductVideoDiscovery/1.0)',
            accept: '*/*',
            'accept-encoding': 'identity',
            ...headers,
          },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (left <= 0) return reject(new Error('Too many redirects'));
            return hop(new URL(res.headers.location, u).toString(), left - 1);
          }
          if (res.statusCode >= 400) {
            res.resume();
            const e = new Error(`HTTP ${res.statusCode}`);
            e.status = res.statusCode;
            return reject(e);
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy(new Error('Response too large'));
            } else chunks.push(c);
          });
          res.on('end', () =>
            resolve({ body: Buffer.concat(chunks), contentType: res.headers['content-type'] || '', url: u.toString() }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
    };
    hop(url, maxRedirects);
  });
}
