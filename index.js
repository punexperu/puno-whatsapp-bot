const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: `Eres PUNO, asistente comercial de PUNEX GROUP S.A.C., empresa de Lima, Peru.
Conectamos compradores internacionales con proveedores peruanos verificados.

TONO: Profesional, directo, calido. Maximo 3-4 lineas por mensaje. Sin emojis excesivos. Una sola pregunta por mensaje.

FLUJO PARA COMPRADORES:
1. Que producto busca
2. Volumen aproximado
3. Pais de destino
4. Nombre y empresa
5. Si ha importado antes desde Peru
6. Certificaciones requeridas (organico, Global GAP, etc.)
Al terminar: "Perfecto, le paso estos datos a Martin y les contacta directo."

FLUJO PARA EXPORTADORES:
1. Que producto/variedad
2. Volumen disponible
3. Mercados objetivo
4. Nombre, empresa y ubicacion
5. Certificaciones que posee
Al terminar: "Bien, Martin les contacta para ver si hacemos match con compradores actuales."

REGLAS:
- Nunca inventes precios
- Si preguntan precio, di que depende del volumen y se detallara en propuesta formal
- Responde en espanol por defecto, en ingles si el cliente escribe en ingles
- Responde SOLO el mensaje de WhatsApp, sin explicaciones extra`
});

const historial = {};
let currentQR = null;
let botReady = false;

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

      console.log('>>> EVENTO from:', jid, '| fromMe:', fromMe, '| body:', body.substring(0, 50));

      if (jid === 'status@broadcast') continue;
      if (jid.endsWith('@g.us')) continue;
      if (fromMe) continue;
      if (!body.trim()) continue;

      const sender = jid;
      const texto = body.trim();
      console.log('Procesando de ' + sender + ': ' + texto.substring(0, 80));

      if (!historial[sender]) historial[sender] = [];

      try {
        const chat = model.startChat({
          history: historial[sender],
          generationConfig: { maxOutputTokens: 350 }
        });

        const result = await chat.sendMessage(texto);
        const respuesta = result.response.text().trim();

        historial[sender].push(
          { role: 'user', parts: [{ text: texto }] },
          { role: 'model', parts: [{ text: respuesta }] }
        );
        if (historial[sender].length > 20) historial[sender] = historial[sender].slice(-20);

        await sock.sendMessage(sender, { text: respuesta });
        console.log('Respuesta enviada a ' + sender + ': ' + respuesta.substring(0, 60));
      } catch (err) {
        console.error('Error al responder a ' + sender + ':', err.message);
      }
    }
  });
}

connectToWhatsApp();
