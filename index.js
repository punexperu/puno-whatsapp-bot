const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const http = require('http');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');

process.on('uncaughtException', err => {
  console.error('WARN uncaughtException:', err.message);
});
process.on('unhandledRejection', reason => {
  console.error('WARN unhandledRejection:', reason);
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BIENVENIDA = `Hola, soy PUNO, asistente de PUNEX GROUP. 👋
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
const pausados = new Set(); // contactos donde Martín toma el control manual
let currentQR = null;
let botReady = false;

const lidToJid = {}; // mapa @lid -> @s.whatsapp.net para fix entrega multi-device

// Normaliza @lid eliminando sufijo de dispositivo (ej: 12345:0@lid -> 12345@lid)
const normalizeLid = (jid) => {
  if (!jid || !jid.endsWith('@lid')) return jid;
  return jid.replace(/:[d]+@lid$/, '@lid');
};

const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (currentQR) {
      try {
        const qrDataURL = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
        const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>PUNO QR</title>'
          + '<style>body{background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:#fff}'
          + 'h2{margin-bottom:16px}img{border:8px solid #fff;border-radius:12px}p{margin-top:12px;opacity:.7}</style></head>'
          + '<body><h2>Escanea con WhatsApp Business</h2><img src="' + qrDataURL + '" />'
          + '<p>Se actualiza cada 30 segundos</p></body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500);
        res.end('Error generando QR: ' + e.message);
      }
    } else if (botReady) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>PUNO</title><style>body{background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:#0f0;text-align:center}</style></head><body><div><h2>PUNO ACTIVO</h2><p>El bot esta conectado y respondiendo mensajes.</p></div></body></html>');
    } else {
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>PUNO</title>'
        + '<style>body{background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:#fff;text-align:center}</style></head>'
        + '<body><div><h2>PUNO iniciando...</h2><p>El QR aparecera en unos segundos. Esta pagina se recarga sola.</p></div></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    }
  } else {
    res.writeHead(302, { Location: '/qr' });
    res.end();
  }
});
server.listen(PORT, () => console.log('Servidor QR activo en puerto ' + PORT));

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();
  console.log('Usando Baileys WA version:', version.join('.'));

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['PUNO Bot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined
  });

  // Rastrear contactos para resolver @lid -> @s.whatsapp.net (fix WhatsApp multi-device)
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      // Caso A: contacto guardado con phone JID + lid (sync inicial)
      if (c.id && c.id.endsWith('@s.whatsapp.net') && c.lid) {
        const lid = normalizeLid(c.lid);
        lidToJid[lid] = c.id;
        console.log(`Contacto mapeado: ${lid} -> ${c.id}`);
      }
      // Caso B: contacto cuyo id ES el @lid (contacto no guardado)
      if (c.id && c.id.endsWith('@lid')) {
        const lid = normalizeLid(c.id);
        console.log(`Contacto @lid detectado: ${lid} | nombre: ${c.name || c.notify || 'desconocido'}`);
      }
    }
  });
  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      if (u.id && u.id.endsWith('@s.whatsapp.net') && u.lid) {
        const lid = normalizeLid(u.lid);
        lidToJid[lid] = u.id;
      }
    }
  });
  // Fuente adicional de mapeos: objetos de chat
  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats) {
      if (chat.id && !chat.id.endsWith('@g.us') && !chat.id.endsWith('@lid') && chat.lid) {
        const lid = normalizeLid(chat.lid);
        lidToJid[lid] = chat.id;
        console.log(`Chat mapeado: ${lid} -> ${chat.id}`);
      }
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      botReady = false;
      console.log('QR generado - abre /qr en el navegador para escanearlo');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      currentQR = null;
      botReady = true;
      console.log('PUNO activo y conectado a WhatsApp');
    }

    if (connection === 'close') {
      botReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexion cerrada, codigo:', statusCode, '| Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 5000);
      } else {
        currentQR = null;
        console.log('Sesion cerrada. Reinicia para nuevo QR.');
      }
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

      if (jid === 'status@broadcast') continue;
      if (jid.endsWith('@g.us')) continue;
      if (!body.trim()) continue;

      const texto = body.trim().toLowerCase();

      // Control manual de Martín: #pausa para tomar el control, #activar para ceder al bot
      if (fromMe) {
        if (texto === '#pausa') {
          pausados.add(jid);
          console.log(`Pausa activada para ${jid}`);
        } else if (texto === '#activar') {
          pausados.delete(jid);
          console.log(`Bot reactivado para ${jid}`);
        }
        continue;
      }

      if (pausados.has(jid)) continue;

      const sender = jid;
      const textoOriginal = body.trim();

      // Resolver @lid a @s.whatsapp.net para que las respuestas lleguen correctamente
      const normalSender = normalizeLid(sender);
      let sendJid = normalSender;
      if (normalSender.endsWith('@lid')) {
        if (lidToJid[normalSender]) {
          sendJid = lidToJid[normalSender];
          console.log(`@lid resuelto: ${normalSender} -> ${sendJid}`);
        } else {
          console.log(`WARN @lid sin resolver: ${normalSender} | map tiene ${Object.keys(lidToJid).length} entradas`);
          // Fallback: enviamos al @lid directo (Baileys intentará enrutar)
        }
      }

      console.log(`>>> MSG de ${sender} | enviar a: ${sendJid} | texto: ${textoOriginal.substring(0, 50)}`);

      if (!historial[sender]) historial[sender] = [];

      try {
        if (historial[sender].length === 0) {
          await sock.sendMessage(sendJid, { text: BIENVENIDA }, { quoted: msg });
          historial[sender].push({ role: 'assistant', content: BIENVENIDA });
          console.log('Bienvenida enviada a ' + sendJid);
        }

        const response = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...historial[sender],
            { role: 'user', content: textoOriginal }
          ],
          max_tokens: 350
        });

        const respuesta = response.choices[0].message.content.trim();

        historial[sender].push(
          { role: 'user', content: textoOriginal },
          { role: 'assistant', content: respuesta }
        );
        if (historial[sender].length > 20) historial[sender] = historial[sender].slice(-20);

        await sock.sendMessage(sendJid, { text: respuesta }, { quoted: msg });
        console.log('Respuesta enviada a ' + sendJid + ': ' + respuesta.substring(0, 60));
      } catch (err) {
        console.error('Error al responder a ' + sender + ':', err.message);
        // Fallback obligatorio cuando Groq o el envío fallan
        const fallback = 'Gracias por escribir a PUNEX GROUP. Hemos recibido tu mensaje. Un responsable revisará tu consulta y te responderá en breve.';
        try {
          await sock.sendMessage(sendJid, { text: fallback }, { quoted: msg });
          console.log('Fallback enviado a ' + sendJid);
        } catch (err2) {
          console.error('Error al enviar fallback:', err2.message);
        }
      }
    }
  });
}

connectToWhatsApp();
