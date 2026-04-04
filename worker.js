// ================================================================
//  TRAMPA WORKER v3.0
//  Rutas:
//    POST /           → proxy Anthropic (chatbot manual)
//    POST /signal     → recibe evento del EA (ENTRADA_ZONA / SALIDA_ZONA / PATRON)
//    GET  /signals    → devuelve patrones recientes (web app)
//    GET  /signals/:symbol → patrones de un par concreto
//    GET  /pelicula/:symbol → película completa (todos los eventos) de un par
//    POST /subscribe  → registra dispositivo para notificaciones push
// ================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Chatbot manual (ruta original) ──────────────────────────────
      if (path === '/' && request.method === 'POST') {
        return handleChatbot(request, env);
      }

      // ── Señal del EA ────────────────────────────────────────────────
      if (path === '/signal' && request.method === 'POST') {
        return handleSignal(request, env);
      }

      // ── Señales para la web app ─────────────────────────────────────
      if (path === '/signals' && request.method === 'GET') {
        return handleGetSignals(env);
      }

      if (path.startsWith('/signals/') && request.method === 'GET') {
        const symbol = path.replace('/signals/', '').toUpperCase();
        return handleGetSignalsBySymbol(symbol, env);
      }

      // ── Película completa de un símbolo ────────────────────────────
      if (path.startsWith('/pelicula/') && request.method === 'GET') {
        const symbol = path.replace('/pelicula/', '').toUpperCase();
        return handleGetPelicula(symbol, env);
      }

      // ── Registro dispositivo push ───────────────────────────────────
      if (path === '/subscribe' && request.method === 'POST') {
        return handleSubscribe(request, env);
      }

      return json({ error: 'Not found' }, 404);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// ================================================================
//  CHATBOT — proxy Anthropic (sin cambios respecto a v1)
// ================================================================
async function handleChatbot(request, env) {
  const body = await request.json();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return json(data, res.status);
}

// ================================================================
//  SIGNAL — recibe evento del EA (ENTRADA_ZONA / SALIDA_ZONA / PATRON)
// ================================================================
async function handleSignal(request, env) {
  const evento = await request.json();

  evento.id         = Date.now().toString();
  evento.receivedAt = new Date().toISOString();

  // ── Guardar en película del símbolo (todos los eventos) ────────
  await storePelicula(evento, env);

  // ── Solo para PATRON: análisis Claude + push ───────────────────
  if (evento.tipo === 'PATRON') {
    const pelicula = await env.SIGNALS.get('pel_' + evento.symbol, 'json') || [];
    const analysis = await generateAnalysis(evento, pelicula, env);
    evento.analysis = analysis;

    // Actualizar película con análisis
    await storePelicula(evento, env);

    // Guardar también en lista de patrones recientes (para web app)
    await storePatron(evento, env);

    // Notificación push
    await sendPushToAll(evento, analysis, env);
  }

  return json({ ok: true, id: evento.id });
}

// ================================================================
//  GET SIGNALS — solo patrones (para la web app)
// ================================================================
async function handleGetSignals(env) {
  const signals = await env.SIGNALS.get('all', 'json') || [];
  return json(signals);
}

async function handleGetSignalsBySymbol(symbol, env) {
  const signals = await env.SIGNALS.get('sym_' + symbol, 'json') || [];
  return json(signals);
}

// ================================================================
//  GET PELICULA — todos los eventos de un símbolo
// ================================================================
async function handleGetPelicula(symbol, env) {
  const pelicula = await env.SIGNALS.get('pel_' + symbol, 'json') || [];
  return json(pelicula);
}

// ================================================================
//  SUBSCRIBE — guarda subscripción push del navegador
// ================================================================
async function handleSubscribe(request, env) {
  const sub  = await request.json();
  const subs = await env.SIGNALS.get('push_subs', 'json') || [];

  // Evitar duplicados por endpoint
  const idx = subs.findIndex(s => s.endpoint === sub.endpoint);
  if (idx >= 0) subs[idx] = sub;
  else          subs.push(sub);

  await env.SIGNALS.put('push_subs', JSON.stringify(subs));
  return json({ ok: true });
}

// ================================================================
//  ALMACENAMIENTO KV
// ================================================================

// Película completa del símbolo — todos los eventos (últimos 200)
async function storePelicula(evento, env) {
  const key = 'pel_' + evento.symbol;
  const pel = await env.SIGNALS.get(key, 'json') || [];
  const idx = pel.findIndex(e => e.id === evento.id);
  if (idx >= 0) pel[idx] = evento;
  else          pel.unshift(evento);
  if (pel.length > 200) pel.splice(200);
  await env.SIGNALS.put(key, JSON.stringify(pel));
}

// Lista de patrones recientes (solo PATRON) — para web app
async function storePatron(patron, env) {
  // Lista general — últimas 100
  const all = await env.SIGNALS.get('all', 'json') || [];
  const idxAll = all.findIndex(s => s.id === patron.id);
  if (idxAll >= 0) all[idxAll] = patron;
  else             all.unshift(patron);
  if (all.length > 100) all.splice(100);
  await env.SIGNALS.put('all', JSON.stringify(all));

  // Lista por símbolo — últimas 20
  const symKey = 'sym_' + patron.symbol;
  const sym    = await env.SIGNALS.get(symKey, 'json') || [];
  const idxSym = sym.findIndex(s => s.id === patron.id);
  if (idxSym >= 0) sym[idxSym] = patron;
  else             sym.unshift(patron);
  if (sym.length > 20) sym.splice(20);
  await env.SIGNALS.put(symKey, JSON.stringify(sym));
}

// ================================================================
//  ANÁLISIS AUTOMÁTICO CON CLAUDE
//  Recibe el patrón actual + la película completa del símbolo
// ================================================================
async function generateAnalysis(patron, pelicula, env) {
  try {
    const dir  = patron.dir === 1 ? 'ALCISTA' : 'BAJISTA';
    const zona = patron.tipoZona === 'ZS' ? 'Zona Soporte' : 'Zona Resistencia';

    // Construir resumen de la película (últimos 20 eventos relevantes)
    const historial = pelicula
      .filter(e => e.id !== patron.id)
      .slice(0, 20)
      .map(e => {
        if (e.tipo === 'ENTRADA_ZONA')
          return `[${e.timestamp}] ENTRÓ en ${e.tipoZona} ${e.tf} [${e.zonaTop}-${e.zonaBottom}]`;
        if (e.tipo === 'SALIDA_ZONA')
          return `[${e.timestamp}] SALIÓ ${e.resultado} de ${e.tipoZona} ${e.tf}`;
        if (e.tipo === 'PATRON')
          return `[${e.timestamp}] PATRÓN ${e.patron} ${e.dir===1?'ALCISTA':'BAJISTA'} en ${e.tf}/${e.patronTf} — ${e.posicionZona} de zona`;
        return '';
      })
      .filter(Boolean)
      .join('\n');

    const userPrompt =
`PELÍCULA DE ${patron.symbol} (historial reciente):
${historial || 'Sin historial previo'}

NUEVO EVENTO — Patrón Trampa:
Par: ${patron.symbol}
Zona: ${zona} [${patron.tf}] ${patron.zonaTop} - ${patron.zonaBottom}
Patrón: ${patron.patron} ${dir} detectado en ${patron.patronTf}
Posición del cierre respecto a zona: ${patron.posicionZona}
Precio actual: ${patron.precio}
Confluencia MTF: ${patron.confluencia || 'ninguna'}
Hora: ${patron.timestamp}

Con todo el contexto anterior responde en 4 líneas máximo:
1. ¿Qué está construyendo el precio? (estructura)
2. ¿Este patrón tiene sentido con el historial?
3. ¿Hacia dónde apunta ahora?
4. ¿Operar, vigilar o ignorar?`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: 'Eres un analista de trading experto en el Sistema Trampa: trampas de liquidez, zonas Ki (soportes/resistencias clave), confluencia multi-timeframe y seguimiento del precio entre zonas. Recibes una película cronológica de eventos y un nuevo patrón. Razonas con todo el contexto. Respuestas directas, sin adornos, en español.',
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const data = await res.json();
    return data.content?.[0]?.text || '';
  } catch (e) {
    return '';
  }
}

// ================================================================
//  NOTIFICACIONES PUSH (Web Push / VAPID)
//  Requiere en Cloudflare: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
//  Generar con: npx web-push generate-vapid-keys
// ================================================================
async function sendPushToAll(patron, analysis, env) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;

  const subs = await env.SIGNALS.get('push_subs', 'json') || [];
  if (!subs.length) return;

  const dir     = patron.dir === 1 ? '🟢' : '🔴';
  const zona    = patron.tipoZona === 'ZS' ? 'Soporte' : 'Resistencia';
  const payload = JSON.stringify({
    title: `${dir} ${patron.symbol} — ${patron.patron} [${patron.tf}/${patron.patronTf}] ${patron.posicionZona}`,
    body:  analysis
           ? analysis.split('\n')[0]
           : `${zona} · Precio: ${patron.precio}`,
    symbol: patron.symbol,
    id:     patron.id,
    icon:   '/bot-avatar.jpg',
  });

  for (const sub of subs) {
    try {
      await sendWebPush(sub, payload, env);
    } catch (e) {
      console.error('Push failed for', sub.endpoint, e.message);
    }
  }
}

async function sendWebPush(subscription, payload, env) {
  const { endpoint, keys: { p256dh, auth } } = subscription;
  const audience = new URL(endpoint).origin;
  const expiry   = Math.floor(Date.now() / 1000) + 43200; // 12h

  // ── JWT VAPID ────────────────────────────────────────────────
  const vapidHeader  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const vapidPayload = b64url(JSON.stringify({ aud: audience, exp: expiry, sub: 'mailto:lams1801@gmail.com' }));
  const toSign = `${vapidHeader}.${vapidPayload}`;

  const privKeyBytes = base64UrlDecode(env.VAPID_PRIVATE_KEY);
  const privateKey   = await crypto.subtle.importKey(
    'raw', privKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const sig    = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(toSign));
  const jwt    = `${toSign}.${arrayToBase64Url(sig)}`;

  // ── Cifrado payload (RFC 8291 aes128gcm) ────────────────────
  const encrypted = await encryptPayload(payload, p256dh, auth);

  await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
    },
    body: encrypted,
  });
}

// ── Cifrado RFC 8291 ─────────────────────────────────────────────────
async function encryptPayload(plaintext, p256dhB64, authB64) {
  const clientPublicKey = base64UrlDecode(p256dhB64);
  const clientAuth      = base64UrlDecode(authB64);
  const salt            = crypto.getRandomValues(new Uint8Array(16));

  // Generar par de claves del servidor
  const serverPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPub  = new Uint8Array(await crypto.subtle.exportKey('raw', serverPair.publicKey));

  // ECDH → shared secret
  const clientKey = await crypto.subtle.importKey('raw', clientPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared    = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverPair.privateKey, 256));

  // HKDF PRK (pseudo-random key)
  const prk = await hkdfExtract(clientAuth, shared);

  // Derivar CEK (16 bytes) y nonce (12 bytes)
  const keyInfo   = concat(new TextEncoder().encode('Content-Encoding: aes128gcm\0'), new Uint8Array(1));
  const nonceInfo = concat(new TextEncoder().encode('Content-Encoding: nonce\0'),     new Uint8Array(1));

  const cek   = await hkdfExpand(prk, salt, keyInfo,   16);
  const nonce = await hkdfExpand(prk, salt, nonceInfo, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data   = new TextEncoder().encode(plaintext);

  // Padding: 2 bytes de longitud + datos + byte 0x02 (record delimiter)
  const padded = new Uint8Array(data.length + 2);
  padded.set(data, 2);

  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // Cabecera: salt(16) | rs(4 bytes = 4096) | keylen(1) | serverPub | ciphertext
  const rs     = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  const keylen = new Uint8Array([serverPub.length]);
  return concat(salt, rs, keylen, serverPub, encrypted).buffer;
}

// ── HKDF helpers ─────────────────────────────────────────────────────
async function hkdfExtract(salt, ikm) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
}

async function hkdfExpand(prk, salt, info, length) {
  // IKM = prk, salt usado como contexto junto con info
  const ikmKey = await crypto.subtle.importKey(
    'raw', prk,
    { name: 'HKDF' }, false, ['deriveBits']
  );
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    ikmKey, length * 8
  ));
}

// ── Utils ─────────────────────────────────────────────────────────────
function b64url(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function arrayToBase64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
