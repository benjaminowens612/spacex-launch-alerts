// Web Push sender using only WebCrypto, so it runs unchanged in Deno (Edge
// Functions) and Node (tests).
//   RFC 8291  Message Encryption for Web Push (aes128gcm)
//   RFC 8292  VAPID (ES256 JWT in the Authorization header)

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

/** One-block HKDF (RFC 5869) — every output we need is ≤ 32 bytes. */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

// ---------- VAPID keys ----------

/** Generate an exportable P-256 key pair; returns JWKs for storage. */
export async function generateVapidKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicKey: await subtle.exportKey('jwk', pair.publicKey),
    privateKey: await subtle.exportKey('jwk', pair.privateKey),
  };
}

/** Uncompressed (65-byte) public key, base64url — the browser's applicationServerKey. */
export function applicationServerKey(publicJwk) {
  return b64urlEncode(concat(new Uint8Array([4]), b64urlDecode(publicJwk.x), b64urlDecode(publicJwk.y)));
}

async function vapidAuthHeader(endpoint, keys, subject, now = Date.now()) {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const key = await subtle.importKey('jwk', keys.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto returns the raw r||s signature, which is exactly JOSE's ES256 format.
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${applicationServerKey(keys.publicKey)}`;
}

// ---------- payload encryption (aes128gcm) ----------

/**
 * Encrypt `payload` for a browser subscription. `subscription.keys` holds the
 * browser's p256dh public key and auth secret (both base64url).
 */
export async function encryptPayload(subscription, payload) {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);

  const local = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle.exportKey('raw', local.publicKey));
  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext followed by the 0x02 "last record" delimiter.
  const plain = concat(typeof payload === 'string' ? enc.encode(payload) : payload, new Uint8Array([2]));
  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/**
 * Send one push. Resolves to { status, ok, gone } — `gone` means the
 * subscription no longer exists (404/410) and should be deleted.
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {unknown} payload
 * @param {{ keys: { publicKey: JsonWebKey, privateKey: JsonWebKey }, subject: string, ttl?: number, urgency?: string, topic?: string }} options
 */
export async function sendPush(subscription, payload, { keys, subject, ttl = 3600, urgency = 'high', topic } = {}) {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidAuthHeader(subscription.endpoint, keys, subject),
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await fetch(subscription.endpoint, { method: 'POST', headers, body });
  const text = res.ok ? '' : await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410, error: text.slice(0, 300) };
}

// Exported for tests.
export const _internal = { vapidAuthHeader, hkdf };
