// ================================================================
//  TRAMPA WORKER v4.0
//  Rutas:
//    POST /              → proxy Anthropic (chatbot manual)
//    POST /signal        → recibe evento del EA (ENTRADA_ZONA / SALIDA_ZONA / PATRON)
//    GET  /signals       → devuelve patrones recientes (web app)
//    GET  /signals/:sym  → patrones de un par concreto
//    GET  /pelicula/:sym → película completa de un par
//    POST /subscribe     → registra dispositivo para notificaciones push
//    POST /screenshot    → recibe screenshot del EA → crea entrada bitácora
//    GET  /bitacora/:sym → entradas de bitácora de un par (o ALL)
//    GET  /image/:id     → imagen PNG de una entrada de bitácora
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
      if (path === '/' && request.method === 'POST') {
        return handleChatbot(request, env);
      }
      if (path === '/signal' && request.method === 'POST') {
        return handleSignal(request, env);
      }
      if (path === '/signals' && request.method === 'GET') {
        return handleGetSignals(env);
      }
      if (path.startsWith('/signals/') && request.method === 'GET') {
        const symbol = path.replace('/signals/', '').toUpperCase();
        return handleGetSignalsBySymbol(symbol, env);
      }
      if (path.startsWith('/pelicula/') && request.method === 'GET') {
        const symbol = path.replace('/pelicula/', '').toUpperCase();
        return handleGetPelicula(symbol, env);
      }
      if (path === '/subscribe' && request.method === 'POST') {
        return handleSubscribe(request, env);
      }
      if (path === '/screenshot' && request.method === 'POST') {
        return handleScreenshot(request, env);
      }
      if (path.startsWith('/bitacora/') && request.method === 'GET') {
        const symbol = path.replace('/bitacora/', '').toUpperCase();
        return handleGetBitacora(symbol, env);
      }
      if (path.startsWith('/image/') && request.method === 'GET') {
        const id = path.replace('/image/', '');
        return handleGetImage(id, env);
      }
      return json({ error: 'Not found' }, 404);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// ================================================================
//  CHATBOT — proxy Anthropic
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
//  SIGNAL — recibe evento del EA
// ================================================================
async function handleSignal(request, env) {
  const evento = await request.json();

  evento.id         = Date.now().toString();
  evento.receivedAt = new Date().toISOString();

  // Guardar en película del símbolo (todos los eventos)
  await storePelicula(evento, env);

  // Solo para PATRON: análisis Claude + push + lista web
  if (evento.tipo === 'PATRON') {
    const pelicula = await env.SIGNALS.get('pel_' + evento.symbol, 'json') || [];
    const analysis = await generateAnalysis(evento, pelicula, env);
    evento.analysis = analysis;
    await storePelicula(evento, env);
    await storePatron(evento, env);
    await sendPushToAll(evento, analysis, env);
  }

  return json({ ok: true, id: evento.id });
}

// ================================================================
//  GET SIGNALS — patrones para la web app
// ================================================================
async function handleGetSignals(env) {
  const signals = await env.SIGNALS.get('all', 'json') || [];
  return json(signals);
}

async function handleGetSignalsBySymbol(symbol, env) {
  const signals = await env.SIGNALS.get('sym_' + symbol, 'json') || [];
  return json(signals);
}

async function handleGetPelicula(symbol, env) {
  const pelicula = await env.SIGNALS.get('pel_' + symbol, 'json') || [];
  return json(pelicula);
}

// ================================================================
//  SUBSCRIBE
// ================================================================
async function handleSubscribe(request, env) {
  const sub  = await request.json();
  const subs = await env.SIGNALS.get('push_subs', 'json') || [];
  const idx  = subs.findIndex(s => s.endpoint === sub.endpoint);
  if (idx >= 0) subs[idx] = sub;
  else          subs.push(sub);
  await env.SIGNALS.put('push_subs', JSON.stringify(subs));
  return json({ ok: true });
}

// ================================================================
//  ALMACENAMIENTO KV
// ================================================================
async function storePelicula(evento, env) {
  const key = 'pel_' + evento.symbol;
  const pel = await env.SIGNALS.get(key, 'json') || [];
  const idx = pel.findIndex(e => e.id === evento.id);
  if (idx >= 0) pel[idx] = evento;
  else          pel.unshift(evento);
  if (pel.length > 200) pel.splice(200);
  await env.SIGNALS.put(key, JSON.stringify(pel));
}

async function storePatron(patron, env) {
  const all    = await env.SIGNALS.get('all', 'json') || [];
  const idxAll = all.findIndex(s => s.id === patron.id);
  if (idxAll >= 0) all[idxAll] = patron;
  else             all.unshift(patron);
  if (all.length > 100) all.splice(100);
  await env.SIGNALS.put('all', JSON.stringify(all));

  const symKey = 'sym_' + patron.symbol;
  const sym    = await env.SIGNALS.get(symKey, 'json') || [];
  const idxSym = sym.findIndex(s => s.id === patron.id);
  if (idxSym >= 0) sym[idxSym] = patron;
  else             sym.unshift(patron);
  if (sym.length > 20) sym.splice(20);
  await env.SIGNALS.put(symKey, JSON.stringify(sym));
}

// ================================================================
//  ANÁLISIS CON CLAUDE — usa la película completa como contexto
// ================================================================
async function generateAnalysis(patron, pelicula, env) {
  try {
    const dir  = patron.dir === 1 ? 'ALCISTA' : 'BAJISTA';
    const zona = patron.tipoZona === 'ZS' ? 'Zona Soporte' : 'Zona Resistencia';

    const historial = pelicula
      .filter(e => e.id !== patron.id)
      .slice(0, 20)
      .map(e => {
        if (e.tipo === 'ENTRADA_ZONA')
          return '[' + e.timestamp + '] ENTRO en ' + e.tipoZona + ' ' + e.tf + ' [' + e.zonaTop + '-' + e.zonaBottom + ']';
        if (e.tipo === 'SALIDA_ZONA')
          return '[' + e.timestamp + '] SALIO ' + e.resultado + ' de ' + e.tipoZona + ' ' + e.tf;
        if (e.tipo === 'PATRON')
          return '[' + e.timestamp + '] PATRON ' + e.patron + ' ' + (e.dir===1?'ALCISTA':'BAJISTA') + ' en ' + e.tf + '/' + e.patronTf + ' - ' + e.posicionZona + ' de zona';
        return '';
      })
      .filter(Boolean)
      .join('\n');

    const prompt =
      'PELICULA DE ' + patron.symbol + ':\n' +
      (historial || 'Sin historial previo') + '\n\n' +
      'NUEVO PATRON:\n' +
      'Par: ' + patron.symbol + '\n' +
      zona + ' [' + patron.tf + ']: ' + patron.zonaTop + ' - ' + patron.zonaBottom + '\n' +
      'Patron: ' + patron.patron + ' ' + dir + ' en ' + patron.patronTf + '\n' +
      'Posicion respecto a zona: ' + patron.posicionZona + '\n' +
      'Precio: ' + patron.precio + '\n' +
      'Confluencia: ' + (patron.confluencia || 'ninguna') + '\n\n' +
      'Responde en 4 lineas:\n' +
      '1. Que esta construyendo el precio\n' +
      '2. Este patron tiene sentido con el historial\n' +
      '3. Hacia donde apunta\n' +
      '4. Operar, vigilar o ignorar';

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
        system: 'Eres un analista de trading experto en el Sistema Trampa: zonas Ki, trampas de liquidez, confluencia multi-timeframe. Recibes una pelicula cronologica de eventos y un nuevo patron. Razonas con todo el contexto. Respuestas directas en espanol.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    return data.content[0].text || '';
  } catch (e) {
    return '';
  }
}

// ================================================================
//  NOTIFICACIONES PUSH
// ================================================================
async function sendPushToAll(patron, analysis, env) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;
  const subs = await env.SIGNALS.get('push_subs', 'json') || [];
  if (!subs.length) return;

  const dir  = patron.dir === 1 ? '🟢' : '🔴';
  const zona = patron.tipoZona === 'ZS' ? 'Soporte' : 'Resistencia';
  const payload = JSON.stringify({
    title: dir + ' ' + patron.symbol + ' — ' + patron.patron + ' [' + patron.tf + '/' + patron.patronTf + '] ' + patron.posicionZona,
    body:  analysis ? analysis.split('\n')[0] : zona + ' · Precio: ' + patron.precio,
    symbol: patron.symbol,
    id:     patron.id,
    icon:   '/bot-avatar.jpg',
  });

  for (const sub of subs) {
    try {
      await sendWebPush(sub, payload, env);
    } catch (e) {
      console.error('Push failed:', sub.endpoint, e.message);
    }
  }
}

async function sendWebPush(subscription, payload, env) {
  const { endpoint, keys: { p256dh, auth } } = subscription;
  const audience = new URL(endpoint).origin;
  const expiry   = Math.floor(Date.now() / 1000) + 43200;

  const vapidHeader  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const vapidPayload = b64url(JSON.stringify({ aud: audience, exp: expiry, sub: 'mailto:lams1801@gmail.com' }));
  const toSign = vapidHeader + '.' + vapidPayload;

  const privKeyBytes = base64UrlDecode(env.VAPID_PRIVATE_KEY);
  const privateKey   = await crypto.subtle.importKey(
    'raw', privKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(toSign));
  const jwt = toSign + '.' + arrayToBase64Url(sig);

  const encrypted = await encryptPayload(payload, p256dh, auth);

  await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    'vapid t=' + jwt + ',k=' + env.VAPID_PUBLIC_KEY,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
    },
    body: encrypted,
  });
}

async function encryptPayload(plaintext, p256dhB64, authB64) {
  const clientPublicKey = base64UrlDecode(p256dhB64);
  const clientAuth      = base64UrlDecode(authB64);
  const salt            = crypto.getRandomValues(new Uint8Array(16));

  const serverPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPub  = new Uint8Array(await crypto.subtle.exportKey('raw', serverPair.publicKey));

  const clientKey = await crypto.subtle.importKey('raw', clientPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared    = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverPair.privateKey, 256));

  const prk = await hkdfExtract(clientAuth, shared);

  const keyInfo   = concat(new TextEncoder().encode('Content-Encoding: aes128gcm\0'), new Uint8Array(1));
  const nonceInfo = concat(new TextEncoder().encode('Content-Encoding: nonce\0'),     new Uint8Array(1));

  const cek   = await hkdfExpand(prk, salt, keyInfo,   16);
  const nonce = await hkdfExpand(prk, salt, nonceInfo, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data   = new TextEncoder().encode(plaintext);

  const padded = new Uint8Array(data.length + 2);
  padded.set(data, 2);

  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const rs     = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const keylen = new Uint8Array([serverPub.length]);
  return concat(salt, rs, keylen, serverPub, encrypted).buffer;
}

async function hkdfExtract(salt, ikm) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
}

async function hkdfExpand(prk, salt, info, length) {
  const ikmKey = await crypto.subtle.importKey('raw', prk, { name: 'HKDF' }, false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    ikmKey, length * 8
  ));
}

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

// ================================================================
//  SCREENSHOT → BITÁCORA
// ================================================================
async function handleScreenshot(request, env) {
  const formData = await request.formData();
  const symbol   = (formData.get('symbol') || '').toUpperCase();
  const tf       = (formData.get('tf')      || '').toUpperCase();
  const caption  = formData.get('caption')  || '';
  const ts       = formData.get('timestamp')|| new Date().toISOString();

  if (!symbol) return json({ error: 'symbol required' }, 400);

  const id = Date.now().toString();

  // Guardar imagen PNG en KV por separado (clave img_<id>)
  const imageFile = formData.get('image');
  let hasImage = false;
  if (imageFile) {
    const bytes  = await imageFile.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    await env.SIGNALS.put('img_' + id, base64);
    hasImage = true;
  }

  // Entrada de bitácora (sin imagen, solo metadatos)
  const entry = { id, symbol, tf, caption, timestamp: ts, hasImage };

  // Guardar en bita_SYMBOL
  const symKey = 'bita_' + symbol;
  const bySymbol = await env.SIGNALS.get(symKey, 'json') || [];
  bySymbol.unshift(entry);
  if (bySymbol.length > 30) bySymbol.splice(30);
  await env.SIGNALS.put(symKey, JSON.stringify(bySymbol));

  // Guardar en bita_all
  const allBita = await env.SIGNALS.get('bita_all', 'json') || [];
  allBita.unshift(entry);
  if (allBita.length > 100) allBita.splice(100);
  await env.SIGNALS.put('bita_all', JSON.stringify(allBita));

  return json({ ok: true, id });
}

async function handleGetBitacora(symbol, env) {
  const key = symbol === 'ALL' ? 'bita_all' : 'bita_' + symbol;
  const data = await env.SIGNALS.get(key, 'json') || [];
  return json(data);
}

async function handleGetImage(id, env) {
  const base64 = await env.SIGNALS.get('img_' + id);
  if (!base64) return new Response('Not found', { status: 404, headers: CORS });
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }
  });
}

// ================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
