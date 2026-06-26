const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

// ── Manejo global de errores para evitar crashes ──────────────────────────────
process.on('uncaughtException', err => {
  console.error('⚠️  Error no controlado (bot sigue activo):', err.message);
});
process.on('unhandledRejection', reason => {
  console.error('⚠️  Promesa rechazada (bot sigue activo):', reason);
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres PUNO, asistente de PUNEX GROUP S.A.C., empresa de Lima, Perú.

Tu trabajo: conectar compradores internacionales con proveedores peruanos verificados, y ayudar a exportadores peruanos a encontrar compradores.

TONO: Directo, cálido, sin frases de consultor. Máximo 3-4 líneas por mensaje. Una sola pregunta a la vez.

FLUJO PARA COMPRADORES (quien busca producto peruano):
1. ¿Qué producto busca exactamente?
2. ¿Volumen aproximado y frecuencia?
3. ¿País de destino?
4. ¿Nombre y empresa?
5. ¿Ha importado antes desde Perú?
6. ¿Necesita certificaciones? (orgánico, Global GAP, Fairtrade, Kosher, etc.)
→ Al terminar: "Perfecto, le paso estos datos a Martín y les contacta directo."

FLUJO PARA EXPORTADORES/PROVEEDORES (quien tiene producto peruano para vender):
1. ¿Qué producto y variedad?
2. ¿Volumen disponible y frecuencia?
3. ¿Mercados objetivo o con los que ya trabaja?
4. ¿Nombre, empresa y ubicación?
5. ¿Tiene certificaciones?
→ Al terminar: "Bien, Martín les contacta para ver si hacemos match con compradores actuales."

REGLAS:
- Nunca inventes precios ni prometas nada específico
- Si preguntan precio: "Depende del volumen y condiciones — eso lo define Martín con propuesta formal."
- Responde en español por defecto. Si el usuario escribe en inglés, responde en inglés.
- Solo responde el mensaje, sin meta-comentarios ni explicaciones extra`;

const historial = {};
let currentQR = null;

// ── Servidor HTTP para mostrar el QR escaneable ───────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (currentQR) {
      try {
        const qrDataURL = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="30">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PUNO - Escanea el QR</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 40px; background: #f0f0f0; }
    h1 { color: #25D366; }
    img { border: 8px solid white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
    p { color: #666; }
  </style>
</head>
<body>
  <h1>PUNO Bot - WhatsApp</h1>
  <p>Escanea este código con WhatsApp Business → Dispositivos vinculados</p>
  <img src="${qrDataURL}" alt="QR Code" width="300" height="300">
  <p><small>Se actualiza cada 30 segundos</small></p>
</body>
</html>`);
      } catch (e) {
        res.writeHead(500); res.end('Error generando QR');
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PUNO - Cargando...</title>
  <style>body { font-family: sans-serif; text-align: center; padding: 60px; } h1 { color: #25D366; }</style>
</head>
<body>
  <h1>PUNO Bot</h1>
  <p>⏳ Bot iniciando o ya conectado. Si ya escaneaste el QR, ¡ya está listo!</p>
  <p><small>Esta página se recarga sola cada 5 segundos</small></p>
</body>
</html>`);
    }
  } else {
    res.writeHead(302, { Location: '/qr' });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n🌐 Servidor QR en puerto ${PORT} — visita /qr para escanear\n`);
});

// ── Cliente WhatsApp ──────────────────────────────────────────────────────────
const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/root/.nix-profile/bin/chromium';

console.log('\n🚀 Iniciando PUNO...\n');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: chromiumPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-extensions'
    ],
    headless: true
  }
});

client.on('qr', qr => {
  currentQR = qr;
  console.log('\n📱 QR generado. Abre /qr en el navegador para escanearlo.\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  currentQR = null;
  console.log('\n✅ PUNO está activo y escuchando en WhatsApp\n');
});

client.on('disconnected', reason => {
  console.log('⚠️  WhatsApp desconectado:', reason);
  currentQR = null;
});

// ── Manejador de mensajes ─────────────────────────────────────────────────────
client.on('message', async msg => {
  // Ignorar: estados de WhatsApp, mensajes propios, grupos, sin texto
  if (msg.from === 'status@broadcast') return;
  if (msg.fromMe) return;
  if (msg.isGroupMsg) return;
  if (!msg.body || !msg.body.trim()) return;

  const sender = msg.from;
  const texto = msg.body.trim();

  console.log(`\n📩 [${sender}]: ${texto}\n`);

  if (!historial[sender]) historial[sender] = [];
  historial[sender].push({ role: 'user', content: texto });

  // Mantener máximo 10 mensajes por conversación
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
    console.log(`✅ Respuesta: ${respuesta.substring(0, 80)}...\n`);

  } catch (err) {
    console.error('❌ Error al responder:', err.message);
    // No re-lanzamos el error para que el bot siga activo
  }
});

client.initialize();
