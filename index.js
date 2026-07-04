// PUNO Bot v3 — Baileys v7 (soporte @lid nativo) + HubSpot opcional
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from 'baileys';
import Groq from 'groq-sdk';
import http from 'http';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import pino from 'pino';

process.on('uncaughtException', err => console.error('uncaughtException:', err.message));
process.on('unhandledRejection', reason => console.error('unhandledRejection:', reason));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const AUTH_DIR = 'auth_info_baileys';

// ── Reset de sesión controlado ──────────────────────────────
// Cambia el valor de AUTH_RESET en Railway (p.ej. "1" -> "2")
// para forzar un borrado de sesión y mostrar QR nuevo.
// No se borra en reinicios normales.
(function maybeResetAuth() {
  const want = process.env.AUTH_RESET || '';
  const markerFile = path.join(AUTH_DIR, '.reset_marker');
  let have = '';
  try { have = fs.readFileSync(markerFile, 'utf8'); } catch {}
  if (want && want !== have) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('AUTH_RESET: sesion borrada (marker ' + have + ' -> ' + want + ')');
    } catch (e) { console.log('AUTH_RESET error: ' + e.message); }
  }
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(markerFile, want);
  } catch {}
})();

const BIENVENIDA = 'Hola, soy PUNO, asistente de PUNEX GROUP. \u{1F331}\nAyudamos a empresas de todo el mundo a encontrar y adquirir exportaciones peruanas de calidad verificada, gestionando todo el proceso desde el origen.\n¿En qué puedo ayudarle hoy?';

const SYSTEM_PROMPT = 'Eres PUNO, asistente comercial de PUNEX GROUP S.A.C., empresa de Lima, Perú.\nAyudamos a empresas de todo el mundo a encontrar y adquirir exportaciones peruanas de calidad verificada, gestionando todo el proceso desde el origen.\n\nTONO: Cálido, cercano y profesional. Máximo 3-4 líneas por mensaje. Usa algún emoji ocasional (no excesivo). Una sola pregunta por mensaje. Natural, como una persona real.\n\nEXPORTACIONES PRINCIPALES: jengibre, cúrcuma, vainilla, maíz morado, superalimentos peruanos.\n\nFLUJO PARA COMPRADORES:\n1. Qué exportación peruana busca\n2. Volumen aproximado\n3. País de destino\n4. Nombre y empresa\n5. Si ha importado antes desde Perú\n6. Certificaciones requeridas (orgánico, Global GAP, etc.)\nAl terminar: Perfecto, le paso estos datos a un agente PUNEX y les contacta directo. \u{1F91D}\n\nFLUJO PARA PROVEEDORES/EXPORTADORES:\n1. Qué producto/variedad ofrece\n2. Volumen disponible\n3. Mercados objetivo\n4. Nombre, empresa y ubicación\n5. Certificaciones que posee\nAl terminar: Bien, un agente PUNEX les contacta para ver si hacemos match con compradores actuales. \u{1F91D}\n\nSOBRE PUNEX GROUP:\n- Empresa de Lima, Perú\n- Conectamos compradores internacionales con proveedores peruanos verificados\n- Gestionamos todo el proceso: sourcing, negociación, logística y documentación\n\nREGLAS:\n- Nunca inventes precios\n- Si preguntan precio, di que depende del volumen y se detallará en propuesta formal\n- Responde en español por defecto, en inglés si el cliente escribe en inglés\n- Responde SOLO el mensaje de WhatsApp, sin explicaciones extra\n- Si no sabes algo específico sobre PUNEX, di que un agente PUNEX les dará los detalles';

const historial = {};
const pausados = new Set();
let currentQR = null;
let botReady = false;

// ── HubSpot (opcional: requiere HUBSPOT_TOKEN) ──────────────
const HS_TOKEN = process.env.HUBSPOT_TOKEN || '';
const hsCache = {}; // jid -> { contactId, noteId, buffer }

async function hsFetch(url, method, body) {
  const res = await fetch('https://api.hubapi.com' + url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + HS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error('HubSpot ' + res.status + ': ' + (await res.text()).substring(0, 200));
  return res.json();
}

async function hsEnsureContact(jid, phone, name) {
  if (!HS_TOKEN) return null;
  if (hsCache[jid]?.contactId) return hsCache[jid].contactId;
  let contactId = null;
  if (phone) {
    try {
      const found = await hsFetch('/crm/v3/objects/contacts/search', 'POST', {
        filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: '+' + phone }] }],
        properties: ['phone'], limit: 1
      });
      if (found.total > 0) contactId = found.results[0].id;
    } catch (e) { console.log('HS search err: ' + e.message); }
  }
  if (!contactId) {
    try {
      const created = await hsFetch('/crm/v3/objects/contacts', 'POST', {
        properties: {
          phone: phone ? '+' + phone : undefined,
          firstname: name || 'WhatsApp Lead',
          lifecyclestage: 'lead',
          hs_lead_status: 'NEW'
        }
      });
      contactId = created.id;
      console.log('HS contacto creado: ' + contactId);
    } catch (e) { console.log('HS create err: ' + e.message); return null; }
  }
  hsCache[jid] = hsCache[jid] || {};
  hsCache[jid].contactId = contactId;
  return contactId;
}

async function hsLogMessage(jid, phone, name, userText, botText) {
  if (!HS_TOKEN) return;
  try {
    const contactId = await hsEnsureContact(jid, phone, name);
    if (!contactId) return;
    const c = hsCache[jid];
    const stamp = new Date().toISOString().substring(0, 16).replace('T', ' ');
    const entry = '[' + stamp + ' UTC]\nCliente: ' + userText + '\nPUNO: ' + botText;
    if (c.noteId) {
      c.buffer = c.buffer + '\n\n' + entry;
      await hsFetch('/crm/v3/objects/notes/' + c.noteId, 'PATCH', {
        properties: { hs_note_body: c.buffer.substring(0, 60000) }
      });
    } else {
      const header = '\u{1F4F1} Conversacion WhatsApp PUNO' + (name ? ' - ' + name : '') + (phone ? ' (+' + phone + ')' : '');
      c.buffer = header + '\n\n' + entry;
      const note = await hsFetch('/crm/v3/objects/notes', 'POST', {
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: c.buffer },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
        }]
      });
      c.noteId = note.id;
    }
  } catch (e) { console.log('HS log err: ' + e.message); }
}

// Extraer numero de telefono real (v7: remoteJidAlt trae el PN cuando el chat es @lid)
function extractPhone(msg) {
  const jid = msg.key.remoteJid || '';
  const alt = msg.key.remoteJidAlt || '';
  const pn = jid.endsWith('@s.whatsapp.net') ? jid : (alt.endsWith('@s.whatsapp.net') ? alt : '');
  return pn ? pn.split('@')[0].split(':')[0] : '';
}

// ── HTTP server para QR ─────────────────────────────────────
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

// ── Bot principal ───────────────────────────────────────────
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log('WA version:', version.join('.'));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['PUNO Bot', 'Chrome', '3.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    getMessage: async () => undefined
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; botReady = false; console.log('QR listo -> abrir /qr'); }
    if (connection === 'open') {
      currentQR = null; botReady = true;
      console.log('PUNO conectado ✓');
    }
    if (connection === 'close') {
      botReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Conexion cerrada, codigo:', code);
      if (code !== DisconnectReason.loggedOut && code !== DisconnectReason.connectionReplaced) {
        setTimeout(start, 5000);
      } else {
        currentQR = null;
        console.log('Sesion cerrada. Cambia AUTH_RESET en Railway para generar QR nuevo.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid || '';
      const fromMe = msg.key.fromMe;
      const body = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || '';

      if (jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || !body.trim()) continue;

      const texto = body.trim().toLowerCase();

      if (fromMe) {
        if (texto === '#pausa') pausados.add(jid);
        else if (texto === '#activar') pausados.delete(jid);
        continue;
      }
      if (pausados.has(jid)) continue;

      const textoOriginal = body.trim();
      const phone = extractPhone(msg);
      const name = msg.pushName || '';
      console.log('MSG ' + jid + (phone ? ' (+' + phone + ')' : '') + ': "' + textoOriginal.substring(0, 50) + '"');

      try { sock.readMessages([msg.key]).catch(() => {}); } catch {}

      if (!historial[jid]) historial[jid] = [];
      try {
        if (historial[jid].length === 0) {
          await sock.sendMessage(jid, { text: BIENVENIDA });
          historial[jid].push({ role: 'assistant', content: BIENVENIDA });
          console.log('BIENVENIDA -> ' + jid);
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

        await sock.sendMessage(jid, { text: respuesta });
        console.log('OK -> ' + jid + ': ' + respuesta.substring(0, 60));

        hsLogMessage(jid, phone, name, textoOriginal, respuesta).catch(() => {});

      } catch (err) {
        console.error('ERR: ' + err.message);
        try {
          await sock.sendMessage(jid, { text: 'Gracias por escribir a PUNEX GROUP. Un agente te responderá pronto.' });
        } catch (e2) { console.error('ERR fallback: ' + e2.message); }
      }
    }
  });
}

start();
