const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const http = require('http');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');

process.on('uncaughtException', err => console.error('uncaughtException:', err.message));
process.on('unhandledRejection', reason => console.error('unhandledRejection:', reason));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BIENVENIDA = `Hola, soy PUNO, asistente de PUNEX GROUP. 🌱
Ayudamos a empresas de todo el mundo a encontrar y adquirir exportaciones peruanas de calidad verificada, gestionando todo el proceso desde el origen.
¿En qué puedo ayudarle hoy?`;

const SYSTEM_PROMPT = `Eres PUNO, asistente comercial de PUNEX GROUP S.A.C., empresa de Lima, Perú.
Ayudamos a empresas de todo el mundo a encontrar y adquirir exportaciones peruanas de calidad verificada, gestionando todo el proceso desde el origen.

TONO: Cálido, cercano y profesional. Máximo 3-4 líneas por mensaje. Usa algún emoji ocasional (no excesivo). Una sola pregunta por mensaje. Natural, como una persona real.

EXPORTACIONES PRINCIPALES: jengibre, cúrcuma, vainilla, cacao, café, superalimentos, textiles peruanos.

FLUJO PARA COMPRADORES:
1. Qué exportación peruana busca
2. Volumen aproximado
3. País de destino
4. Nombre y empresa
5. Si ha importado antes desde Perú
6. Certificaciones requeridas (orgánico, Global GAP, etc.)
Al terminar: "Perfecto, le paso estos datos a un agente PUNEX y les contacta directo. 🤝"

FLUJO PARA PROVEEDORES/EXPORTADORES:
1. Qué producto/variedad ofrece
2. Volumen disponible
3. Mercados objetivo
4. Nombre, empresa y ubicación
5. Certificaciones que posee
Al terminar: "Bien, un agente PUNEX les contacta para ver si hacemos match con compradores actuales. 🤝"

SOBRE PUNEX GROUP:
- Empresa de Lima, Perú
- Conectamos compradores internacionales con proveedores peruanos verificados
- Gestionamos todo el proceso: sourcing, negociación, logística y documentación
- Trabajamos con jengibre, cúrcuma, vainilla, cacao, café, superalimentos y textiles

REGLAS:
- Nunca inventes precios
- Si preguntan precio, di que depende del volumen y se detallará en propuesta formal
- Responde en español por defecto, en inglés si el cliente escribe en inglés
- Responde SOLO el mensaje de WhatsApp, sin explicaciones extra
- Si no sabes algo específico sobre PUNEX, di que un agente PUNEX les dará los detalles`;

const historial = {};
const pausados = new Set();
let currentQR = null;
let botReady = false;

// Mapa @lid -> @s.whatsapp.net
const lidToJid = {};

const normLid = (jid) => jid ? jid.replace(/:[0-9]+@lid$/, '@lid') : jid;

function resolveJid(rawJid) {
  if (!rawJid) return rawJid;
  if (!rawJid.endsWith('@lid')) return rawJid;
  const lid = normLid(rawJid);
  return lidToJid[lid] || rawJid;
}

function mapContact(c) {
  if (!c || !c.id) return;
  if (c.id.endsWith('@s.whatsapp.net') && c.lid) {
    const lid = normLid(c.lid);
    if (!lidToJid[lid]) {
      lidToJid[lid] = c.id;
      console.log('MAP: ' + lid + ' -> ' + c.id);
    }
  }
  if (c.id.endsWith('@lid') && c.phone) {
    const lid = normLid(c.id);
    const phoneJid = c.phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    if (!lidToJid[lid]) {
      lidToJid[lid] = phoneJid;
      console.log('MAP (phone field): ' + lid + ' -> ' + phoneJid);
    }
  }
}

const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
  if (req.url !== '/qr') { res.writeHead(302, { Location: '/qr' }); return res.end(); }
  if (currentQR) {
    const img = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>PUNO QR</title><style>body{background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:#fff}img{border:8px solid #fff;border-radius:12px}p{opacity:.6}</style></head><body><h2>Escanea con WhatsApp Business</h2><img src="' + img + '"/><p>Se actualiza cada 30 seg</p></body></html>');
  }
  if (botReady) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>PUNO</title><style>body{background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:#0f0;text-align:center}</style></head><body><div><h2>PUNO ACTIVO</h2><p>El bot esta conectado y respondiendo mensajes.</p></div></body></html>');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>PUNO</title><style>body{background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:#fff;text-align:center}</style></head><body><div><h2>PUNO iniciando...</h2><p>El QR aparecera en unos segundos.</p></div></body></html>');
}).listen(PORT, () => console.log('QR server en puerto ' + PORT));

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();
  console.log('Baileys version:', version.join('.'));

  const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['PUNO Bot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: true,
    getMessage: async (key) => {
      const msg = await store.loadMessage(key.remoteJid, key.id);
      return msg?.message || undefined;
    }
  });

  store.bind(sock.ev);

  sock.ev.on('contacts.upsert', (contacts) => {
    console.log('contacts.upsert: ' + contacts.length);
    contacts.forEach((c, i) => {
      if (i < 30) console.log('  [' + i + '] ' + JSON.stringify(c).substring(0, 250));
      mapContact(c);
    });
    console.log('lidToJid: ' + Object.keys(lidToJid).length + ' entradas');
  });

  sock.ev.on('contacts.update', (updates) => {
    updates.forEach(u => {
      console.log('  contacts.update: ' + JSON.stringify(u).substring(0, 200));
      mapContact(u);
    });
  });

  sock.ev.on('chats.upsert', (chats) => {
    chats.forEach(chat => {
      if (chat.lid) {
        console.log('  chat con lid: id=' + chat.id + ' lid=' + chat.lid);
        if (chat.id && !chat.id.endsWith('@g.us') && !chat.id.endsWith('@lid')) {
          const lid = normLid(chat.lid);
          if (!lidToJid[lid]) { lidToJid[lid] = chat.id; console.log('MAP (chat): ' + lid + ' -> ' + chat.id); }
        }
      }
    });
  });

  sock.ev.on('messaging-history.set', ({ chats = [], contacts: hc = [], isLatest }) => {
    console.log('messaging-history.set: ' + hc.length + ' contactos | ' + chats.length + ' chats | isLatest=' + isLatest);
    hc.forEach((c, i) => {
      if (i < 20) console.log('  [hist ' + i + '] ' + JSON.stringify(c).substring(0, 250));
      mapContact(c);
    });
    chats.forEach(chat => {
      if (chat.lid && chat.id && !chat.id.endsWith('@g.us') && !chat.id.endsWith('@lid')) {
        const lid = normLid(chat.lid);
        if (!lidToJid[lid]) { lidToJid[lid] = chat.id; console.log('MAP (hist chat): ' + lid + ' -> ' + chat.id); }
      }
    });
    console.log('lidToJid tras history sync: ' + Object.keys(lidToJid).length);
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; botReady = false; qrcode.generate(qr, { small: true }); console.log('QR listo en /qr'); }
    if (connection === 'open') {
      currentQR = null; botReady = true;
      console.log('PUNO conectado a WhatsApp');
      console.log('lidToJid al conectar:', JSON.stringify(lidToJid));
    }
    if (connection === 'close') {
      botReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Conexion cerrada, codigo:', code);
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 5000);
      else { currentQR = null; console.log('Sesion cerrada. Reinicia para nuevo QR.'); }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid || '';
      const fromMe = msg.key.fromMe;
      const body = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';

      if (jid === 'status@broadcast' || jid.endsWith('@g.us') || !body.trim()) continue;

      const texto = body.trim().toLowerCase();

      if (fromMe) {
        if (texto === '#pausa') { pausados.add(jid); console.log('Pausa:', jid); }
        else if (texto === '#activar') { pausados.delete(jid); console.log('Activar:', jid); }
        continue;
      }
      if (pausados.has(jid)) continue;

      const pushName = msg.pushName || '';
      const textoOriginal = body.trim();

      let sendJid = resolveJid(jid);

      if (sendJid.endsWith('@lid')) {
        const storeContact = store.contacts?.[jid] || store.contacts?.[normLid(jid)];
        if (storeContact?.id && !storeContact.id.endsWith('@lid')) {
          sendJid = storeContact.id;
          lidToJid[normLid(jid)] = sendJid;
          console.log('MAP (store): ' + normLid(jid) + ' -> ' + sendJid);
        }
      }

      console.log('MSG: jid=' + jid + ' | pushName="' + pushName + '" | sendJid=' + sendJid + ' | texto="' + textoOriginal.substring(0, 50) + '"');

      if (sendJid.endsWith('@lid')) {
        console.log('WARN: no se pudo resolver ' + jid + ' a phone JID. lidToJid tiene ' + Object.keys(lidToJid).length + ' entradas.');
        console.log('Store contacts keys: ' + Object.keys(store.contacts || {}).slice(0, 10).join(', '));
      }

      if (!historial[jid]) historial[jid] = [];

      try {
        if (historial[jid].length === 0) {
          await sock.sendMessage(sendJid, { text: BIENVENIDA }, { quoted: msg });
          historial[jid].push({ role: 'assistant', content: BIENVENIDA });
          console.log('Bienvenida ->', sendJid);
        }

        const resp = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...historial[jid],
            { role: 'user', content: textoOriginal }
          ],
          max_tokens: 350
        });

        const respuesta = resp.choices[0].message.content.trim();
        historial[jid].push({ role: 'user', content: textoOriginal }, { role: 'assistant', content: respuesta });
        if (historial[jid].length > 20) historial[jid] = historial[jid].slice(-20);

        await sock.sendMessage(sendJid, { text: respuesta }, { quoted: msg });
        console.log('Respuesta -> ' + sendJid + ': ' + respuesta.substring(0, 60));
      } catch (err) {
        console.error('Error:', err.message);
        try {
          await sock.sendMessage(sendJid, {
            text: 'Gracias por escribir a PUNEX GROUP. Hemos recibido tu mensaje. Un responsable te responderá en breve.'
          }, { quoted: msg });
        } catch (e2) { console.error('Fallback error:', e2.message); }
      }
    }
  });
}

start();
