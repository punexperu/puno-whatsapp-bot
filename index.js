const {
default: makeWASocket,
DisconnectReason,
useMultiFileAuthState,
fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const http = require('http');
const fs = require('fs');
const path = require('path');
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

// ────────────────────────────────────────────────
// Mapa @lid → @s.whatsapp.net (WhatsApp Multi-Device)
// Bootstrap con mapeos conocidos (extraídos de WhatsApp Web)
// ────────────────────────────────────────────────
const LID_MAP_FILE = path.join('auth_info_baileys', 'lid_map.json');

const lidToJid = {
  // Anna Lehmann (+34 631 563 885) — extraído de WA Web ContactCollection
  '17596715937872@lid': '34631563885@s.whatsapp.net'
};

// Cargar mapeos persistidos del disco
function loadLidMap() {
  try {
    if (fs.existsSync(LID_MAP_FILE)) {
      const saved = JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8'));
      let added = 0;
      for (const [lid, jid] of Object.entries(saved)) {
        if (!lidToJid[lid]) { lidToJid[lid] = jid; added++; }
      }
      console.log('LID_MAP loaded: ' + Object.keys(saved).length + ' entries, ' + added + ' new');
    }
  } catch(e) {
    console.log('LID_MAP load error: ' + e.message);
  }
}

// Persistir el mapa actualizado
function saveLidMap() {
  try {
    fs.mkdirSync('auth_info_baileys', { recursive: true });
    fs.writeFileSync(LID_MAP_FILE, JSON.stringify(lidToJid, null, 2));
  } catch(e) {
    console.log('LID_MAP save error: ' + e.message);
  }
}

const normLid = (jid) => jid ? jid.replace(/:[0-9]+@lid$/, '@lid') : jid;

function resolveJid(rawJid) {
  if (!rawJid || !rawJid.endsWith('@lid')) return rawJid;
  const norm = normLid(rawJid);
  return lidToJid[norm] || rawJid;
}

function mapContact(c) {
  if (!c || !c.id) return;
  // Caso 1: id es phone JID, lid es el @lid
  if (c.id.endsWith('@s.whatsapp.net') && c.lid) {
    const lid = normLid(typeof c.lid === 'string' ? c.lid : c.lid.toString());
    if (!lidToJid[lid]) {
      lidToJid[lid] = c.id;
      console.log('MAP (contact): ' + lid + ' -> ' + c.id);
      saveLidMap();
    }
  }
  // Caso 2: id ES el @lid y tiene notify/phone — extraer phone del pushName o notify
  // (no hay campo phone en Baileys contacts, pero por si acaso)
}

// ────────────────────────────────────────────────
// HTTP server para QR
// ────────────────────────────────────────────────
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
  res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>PUNO</title></head><body><h2>Iniciando...</h2></body></html>');
}).listen(PORT, () => console.log('QR server en puerto ' + PORT));

// ────────────────────────────────────────────────
// Bot principal
// ────────────────────────────────────────────────
async function start() {
  loadLidMap();

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();
  console.log('Baileys version:', version.join('.'));
  console.log('lidToJid bootstrap:', Object.keys(lidToJid).length, 'entries');

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

  // ── Contactos ──
  sock.ev.on('contacts.upsert', (contacts) => {
    console.log('contacts.upsert: ' + contacts.length);
    contacts.forEach(mapContact);
    console.log('lidToJid: ' + Object.keys(lidToJid).length);
  });

  sock.ev.on('contacts.update', (updates) => {
    updates.forEach(mapContact);
  });

  sock.ev.on('chats.upsert', (chats) => {
    chats.forEach(chat => {
      if (chat.lid && chat.id && !chat.id.endsWith('@g.us') && !chat.id.endsWith('@lid')) {
        const lid = normLid(chat.lid);
        if (!lidToJid[lid]) {
          lidToJid[lid] = chat.id;
          console.log('MAP-CHAT: ' + lid + ' -> ' + chat.id);
          saveLidMap();
        }
      }
    });
  });

  sock.ev.on('messaging-history.set', ({ chats = [], contacts: hc = [], isLatest }) => {
    console.log('history.set: ' + hc.length + ' contactos | ' + chats.length + ' chats | isLatest=' + isLatest);
    hc.forEach(mapContact);
    chats.forEach(chat => {
      if (chat.lid && chat.id && !chat.id.endsWith('@g.us') && !chat.id.endsWith('@lid')) {
        const lid = normLid(chat.lid);
        if (!lidToJid[lid]) {
          lidToJid[lid] = chat.id;
          console.log('MAP-HIST: ' + lid + ' -> ' + chat.id);
          saveLidMap();
        }
      }
    });
    console.log('lidToJid tras sync: ' + Object.keys(lidToJid).length);
  });

  // ── Presencia — puede revelar JID real del @lid ──
  sock.ev.on('presence.update', ({ id, presences }) => {
    // id es el JID del chat, presences es un mapa de participant -> presence
    console.log('PRESENCE id=' + id + ' presences_keys=' + Object.keys(presences || {}).join(','));
    // Si id es @lid, ver si presences tiene @s.whatsapp.net como participant
    if (id && id.endsWith('@lid')) {
      const lid = normLid(id);
      for (const [participant, pres] of Object.entries(presences || {})) {
        if (participant.endsWith('@s.whatsapp.net') && !lidToJid[lid]) {
          lidToJid[lid] = participant;
          console.log('MAP-PRESENCE: ' + lid + ' -> ' + participant);
          saveLidMap();
        }
      }
    }
  });

  // ── Conexión ──
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; botReady = false; qrcode.generate(qr, { small: true }); console.log('QR listo'); }
    if (connection === 'open') {
      currentQR = null; botReady = true;
      console.log('PUNO conectado ✓ | lidToJid: ' + Object.keys(lidToJid).length + ' entries');
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
  // Confirmación real de entrega. sendMessage() puede devolver OK aunque
  // WhatsApp rechace el mensaje después (por ejemplo, error 463).
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (!key?.fromMe || update?.status === undefined) continue;
      const reason = update.messageStubParameters?.join(' | ') || '';
      console.log(
        'ACK: id=' + (key.id || '') +
        ' jid=' + (key.remoteJid || '') +
        ' status=' + update.status +
        (reason ? ' reason=' + reason : '')
      );
    }
  });


  // ── Mensajes ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid || '';
      const fromMe = msg.key.fromMe;
      const body = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption || '';

      if (jid === 'status@broadcast' || jid.endsWith('@g.us') || !body.trim()) continue;

      const texto = body.trim().toLowerCase();

      if (fromMe) {
        if (texto === '#pausa') pausados.add(jid);
        else if (texto === '#activar') pausados.delete(jid);
        continue;
      }
      if (pausados.has(jid)) continue;

      const textoOriginal = body.trim();

      // ── DIAGNÓSTICO: volcar estructura completa para @lid ──
      if (jid.endsWith('@lid')) {
        try {
          // Intentar extraer phone JID de campos del mensaje
          const msgFields = {
            key: msg.key,
            pushName: msg.pushName,
            participant: msg.participant,
            verifiedBizName: msg.verifiedBizName,
            broadcast: msg.broadcast,
            messageStubType: msg.messageStubType,
            messageStubParameters: msg.messageStubParameters,
            // Campos de routing/device
            userReceipt: msg.userReceipt,
            reactions: msg.reactions,
            // Ver todos los keys del objeto msg
            ALL_KEYS: Object.keys(msg)
          };
          console.log('LID_MSG_FIELDS:', JSON.stringify(msgFields).substring(0, 2000));

          // Intentar extraer phone de msg.key.senderPn (campo directo en Multi-Device)
          const senderPn = msg.key?.senderPn;
          if (senderPn && senderPn.endsWith('@s.whatsapp.net')) {
            const lid = normLid(jid);
            if (!lidToJid[lid]) {
              lidToJid[lid] = senderPn;
              console.log('MAP-SENDERPN: ' + lid + ' -> ' + senderPn);
              saveLidMap();
            }
          }

          // Si msg.participant tiene el JID del teléfono
          if (msg.participant && msg.participant.endsWith('@s.whatsapp.net')) {
            const lid = normLid(jid);
            if (!lidToJid[lid]) {
              lidToJid[lid] = msg.participant;
              console.log('MAP-PARTICIPANT: ' + lid + ' -> ' + msg.participant);
              saveLidMap();
            }
          }
        } catch(diagErr) {
          console.log('DIAG_ERR: ' + diagErr.message);
        }
      }

      // En WhatsApp Multi-Device, las cuentas @lid deben recibirse y enviarse
      // usando el mismo @lid — el servidor WA hace el enrutamiento internamente.
      // Enviar a @s.whatsapp.net para una cuenta @lid resulta en silencio (ack sin entrega).
      const finalJid = jid;
      const resolvedPhone = resolveJid(jid); // solo para logging
      console.log('MSG: ' + jid + ' -> finalJid=' + finalJid + ' (phone ref: ' + resolvedPhone + ') | "' + textoOriginal.substring(0, 40) + '"');

      try { sock.readMessages([msg.key]).catch(() => {}); } catch(e) {}

      // Suscribirse a presencia ayuda a Baileys a establecer sesion Signal con el @lid
      if (jid.endsWith('@lid')) {
        try { await sock.presenceSubscribe(jid); } catch(_) {}
      }

      if (!historial[jid]) historial[jid] = [];
      try {
        if (historial[jid].length === 0) {
          await sock.sendMessage(finalJid, { text: BIENVENIDA });
          historial[jid].push({ role: 'assistant', content: BIENVENIDA });
          console.log('BIENVENIDA -> ' + finalJid);
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

        await sock.sendMessage(finalJid, { text: respuesta });
        console.log('OK -> ' + finalJid + ': ' + respuesta.substring(0, 60));

      } catch (err) {
        console.error('ERR send: ' + err.message);
        try {
          await sock.sendMessage(finalJid, { text: 'Gracias por escribir a PUNEX GROUP. Un agente te responderá pronto.' });
        } catch(e2) {
          console.error('ERR fallback: ' + e2.message);
        }
      }
    }
  });
}

start();
