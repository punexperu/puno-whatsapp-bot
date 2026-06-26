const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

// Global error handlers - bot stays alive on any crash
process.on('uncaughtException', err => {
  console.error('WARN uncaughtException (bot sigue activo):', err.message);
});
process.on('unhandledRejection', reason => {
  console.error('WARN unhandledRejection (bot sigue activo):', reason);
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres PUNO, asistente comercial de PUNEX GROUP S.A.C., empresa de Lima, Peru.
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
- Responde SOLO el mensaje de WhatsApp, sin explicaciones extra`;

const historial = {};
let currentQR = null;

// HTTP server to serve scannable QR from any browser
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

// WhatsApp client
const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/root/.nix-profile/bin/chromium';
console.log('Chromium path:', chromiumPath);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: chromiumPath,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
      '--single-process', '--disable-gpu', '--disable-extensions'
    ],
    headless: true
  }
});

client.on('qr', qr => {
  currentQR = qr;
  console.log('QR generado - abre /qr en el navegador para escanearlo');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  currentQR = null;
  console.log('PUNO activo y escuchando en WhatsApp');
});

client.on('disconnected', reason => {
  currentQR = null;
  console.log('WhatsApp desconectado:', reason);
});

// Message handler
client.on('message', async msg => {
  if (msg.from === 'status@broadcast') return;
  if (msg.fromMe) return;
  if (msg.isGroupMsg) return;
  if (!msg.body || !msg.body.trim()) return;

  const sender = msg.from;
  const texto = msg.body.trim();
  console.log('Mensaje de ' + sender + ': ' + texto.substring(0, 80));

  if (!historial[sender]) historial[sender] = [];
  historial[sender].push({ role: 'user', content: texto });
  if (historial[sender].length > 10) {
    historial[sender] = historial[sender].slice(-10);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      system: SYSTEM_PROMPT,
      messages: historial[sender]
    });
    const respuesta = response.content[0].text.trim();
    historial[sender].push({ role: 'assistant', content: respuesta });
    await msg.reply(respuesta);
    console.log('Respuesta enviada a ' + sender);
  } catch (err) {
    console.error('Error al responder a ' + sender + ':', err.message);
  }
});

client.initialize();
