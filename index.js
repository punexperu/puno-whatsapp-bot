const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const http = require('http')
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');

process.on('uncaughtException', err => console.error('uncaughtException:', err.message));
process.on('unhandledRejection', reason => console.error('unhandledRejection:', reason));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BIENVENIDA = 'Hola, soy PUNO, asistente de PUNEX GROUP. 🌱\nAyudamos a empresas de todo el mundo a encontrar y adquirir exportaciones peruanas de calidad verificada, gestionando todo el proceso desde el origen.\n¿En qué puedo ayudarle hoy?';

const SYSTEM_PROMPT = 'Eres PUNO, asistente comercial de PUNEX GROUP S.A.C., empresa de Lima, Perú.\nAyudamos a empresas de todo el mundo a encontrar y adquirir exportaciones peruanas de calidad verificada, gestionando todo el proceso desde el origen.\n\nTONO: Cálido, cercano y profesional. Máximo 3-4 líneas por mensaje. Usa algún emoji ocasional (no excesivo). Una sola pregunta por mensaje. Natural, como una persona real.\n\nEXPORTACIONES PRINCIPALES: jengibre, cúrcuma, vainilla, cacao, café, superalimentos, textiles peruanos.\n\nFLUJO PARA COMPRADORES:\n1. Qué exportación peruana busca\n2. Volumen aproximado\n3. País de destino\n4. Nombre y empresa\n5. Si ha importado antes desde Perú\n6. Certificaciones requeridas (orgánico, Global GAP, etc.)\nAl terminar: Perfecto, le paso estos datos a un agente PUNEX y les contacta directo. 🤝\n\nFLUJO PARA PROVEEDORES/EXPORTADORES:\n1. Qué producto/variedad ofrece\n2. Volumen disponible\n3. Mercados objetivo\n4. Nombre, empresa y ubicación\n5. Certificaciones que posee\nAl terminar: Bien, un agente PUNEX les contacta para ver si hacemos match con compradores actuales. 🤝\n\nSOBRE PUNEX GROUP:\n- Empresa de Lima, Perú\n- Conectamos compradores internacionales con proveedores peruanos verificados\n- Gestionamos todo el proceso: sourcing, negociación, logística y documentación\n- Trabajamos con jengibre, cúrcuma, vainilla, cacao, café, superalimentos y textiles\n\nREGLAS:\n- Nunca inventes precios\n- Si preguntan precio, di que depende del volumen y se detallará en propuesta formal\n- Responde en español por defecto, en inglés si el cliente escribe en inglés\n- Responde SOLO el mensaje de WhatsApp, sin explicaciones extra\n- Si no sabes algo específico sobre PUNEX, di que un agente PUNEX les dará los detalles';

const historial = {};
const pausados = new Set();
let currentQR = null;
let botReady = false;

// Mapa @lid -> @s.whatsapp.net (fix WhatsApp Multi-Device)
const lidToJid = {};
const normLid = (jid) => jid ? jid.replace(/:[0-9]+@lid$/, '@lid') : jid;

function resolveJid(rawJid) {
  if (!rawJid || !rawJid.endsWith('@lid')) return rawJid;
  return lidToJid[normLid(rawJid)] || rawJid;
}

function mapContact(c) {
  if (!c || !c.id) return;
  if (c.id.endsWith('@s.whatsapp.net') && c.lid) {
    const lid = normLid(c.lid);
    if (!lidToJid[lid]) { lidToJid[lid] = c.id; console.log('MAP: ' + lid + ' -> ' + c.id); }
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

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['PUNO Bot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    getMessage: async () => undefined
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    console.log('contacts.upsert: ' + contacts.length);
    contacts.forEach((c, i) => {
      if (i < 30) console.log('  [' + i + '] ' + JSON.stringify(c).substring(0, 200));
      mapContact(c);
    });
    console.log('lidToJid: ' + Object.keys(lidToJid).length + ' entradas');
  });

  sock.ev.on('contacts.update', (updates) => {
    updates.forEach(u => { console.log('  upd: ' + JSON.stringify(u).substring(0, 200)); mapContact(u); });
  });

  sock.ev.on('chats.upsert', (chats) => {
    chats.forEach(chat => {
      if (chat.lid && chat.id && !chat.id.endsWith('@g.us') && !chat.id.endsWith('@lid')) {
        const lid = normLid(chat.lid);
        if (!lidToJid[lid]) { lidToJid[lid] = chat.id; console.log('MAP-CHAT: ' + lid + ' -> ' + chat.id); }
      }
    });
  });

  sock.ev.on('messaging-history.set', ({ chats = [], contacts: hc = [], isLatest }) => {
    console.log('history.set: ' + hc.length + ' contactos | ' + chats.length + ' chats | isLatest=' + isLatest);
    hc.forEach((c, i) => { if (i < 20) console.log('  [h' + i + '] ' + JSON.stringify(c).substring(0, 200)); mapContact(c); });
    chats.forEach(chat => {
      if (chat.lid && chat.id && !chat.id.endsWith('@g.us') && !chat.id.endsWith('@lid')) {
        const lid = normLid(chat.lid);
        if (!lidToJid[lid]) { lidToJid[lid] = chat.id; console.log('MAP-HIST: ' + lid + ' -> ' + chat.id); }
      }
    });
    console.log('lidToJid tras sync: ' + Object.keys(lidToJid).length);
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; botReady = false; qrcode.generate(qr, { small: true }); console.log('QR listo'); }
    if (connection === 'open') {
      currentQR = null; botReady = true;
      console.log('PUNO conectado ✓ | lidToJid: ' + JSON.stringify(lidToJid));
    }
    if (connection === 'close') {
      botReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Conexion cerrada, codigo:', code);
      if (code !== DisconnectReason.loggedOut && code !== DisconnectReason.connectionReplaced) setTimeout(start, 5000);
      else { currentQR = null; console.log('Sesion cerrada.'); }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid || '';
      const fromMe = msg.key.fromMe;
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';

      if (jid === 'status@broadcast' || jid.endsWith('@g.us') || !body.trim()) continue;
      const texto = body.trim().toLowerCase();

      if (fromMe) {
        if (texto === '#pausa') pausados.add(jid);
        else if (texto === '#activar') pausados.delete(jid);
        continue;
      }
      if (pausados.has(jid)) continue;

      const textoOriginal = body.trim();
      const sendJid = resolveJid(jid);

      console.log('MSG: ' + jid + ' -> sendJid=' + sendJid + ' | "' + textoOriginal.substring(0, 40) + '"');
      if (sendJid.endsWith('@lid')) console.log('WARN @lid sin resolver | lidToJid=' + Object.keys(lidToJid).length);

      try { sock.readMessages([msg.key]).catch(()=>{}); } catch(e) {}

        if (!historial[jid]) historial[jid] = [];
      try {
        if (historial[jid].length === 0) {
          await sock.sendMessage(jid, { text: BIENVENIDA });
          historial[jid].push({ role: 'assistant', content: BIENVENIDA });
        }
        const resp = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...historial[jid], { role: 'user', content: textoOriginal }],
          max_tokens: 350
        });
        const respuesta = resp.choices[0].message.content.trim();
        historial[jid].push({ role: 'user', content: textoOriginal }, { role: 'assistant', content: respuesta });
        if (historial[jid].length > 20) historial[jid] = historial[jid].slice(-20);
        await sock.sendMessage(jid, { text: respuesta });
        console.log('OK -> ' + sendJid + ': ' + respuesta.substring(0, 50));
      } catch (err) {
        console.error('Error:', err.message);
        try { await sock.sendMessage(sendJid, { text: 'Gracias por escribir a PUNEX GROUP. Un agente te responderá pronto.' }, { quoted: msg }); } catch (e) {}
      }
    }
  });
}

start();
