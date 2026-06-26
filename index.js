const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

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
- Si preguntan precio: "Depende del volumen y condiciones — eso lo define Martín con propuesta formal"
- Responde en español por defecto. Si el usuario escribe en inglés, responde en inglés
- Solo responde el mensaje, sin meta-comentarios ni explicaciones extra
- Si no entiendes el mensaje, pide que aclaren con naturalidad`;

const historial = {};
const esNuevoUsuario = {};
let currentQR = null;

// Servidor HTTP para mostrar el QR como imagen escaneable
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (currentQR) {
      try {
        const qrDataURL = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PUNO - Escanea el QR</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 20px; background: #f0f0f0; }
    img { max-width: 300px; border: 10px solid white; border-radius: 8px; }
    h2 { color: #128C7E; }
    p { color: #555; }
  </style>
  <meta http-equiv="refresh" content="30">
</head>
<body>
  <h2>📱 PUNO WhatsApp Bot</h2>
  <p>Escanea este QR con WhatsApp Business → Dispositivos vinculados → Vincular dispositivo</p>
  <img src="${qrDataURL}" alt="QR Code">
  <p><small>Esta página se actualiza automáticamente cada 30 segundos</small></p>
</body>
</html>`);
      } catch (err) {
        res.writeHead(500);
        res.end('Error generando QR: ' + err.message);
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PUNO - Cargando...</title>
  <meta http-equiv="refresh" content="5">
  <style>body { font-family: sans-serif; text-align: center; padding: 40px; }</style>
</head>
<body>
  <h2>⏳ PUNO está iniciando...</h2>
  <p>El QR aparecerá aquí en unos segundos. Esta página se actualiza sola.</p>
</body>
</html>`);
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>PUNO Bot activo ✅</h1><p><a href="/qr">Ver QR de WhatsApp</a></p>');
  }
});

server.listen(PORT, () => {
  console.log(`\n🌐 Servidor QR en puerto ${PORT} — visita /qr para escanear\n`);
});

// Chromium para Railway
const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH
  || '/root/.nix-profile/bin/chromium';

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

client.on('auth_failure', msg => {
  console.error('❌ Autenticación fallida:', msg);
});

client.on('disconnected', reason => {
  console.log('⚠️  WhatsApp desconectado:', reason);
});

client.on('message', async msg => {
  if (msg.fromMe) return;
  if (msg.from.endsWith('@g.us')) return;
  const texto = msg.body ? msg.body.trim() : '';
  if (!texto) return;

  const sender = msg.from;
  console.log(`\n📩 [${sender}]: ${texto}`);

  if (!historial[sender]) {
    historial[sender] = [];
    esNuevoUsuario[sender] = true;
  }

  if (esNuevoUsuario[sender]) {
    esNuevoUsuario[sender] = false;
    const bienvenida = '¡Hola! Soy PUNO, asistente de PUNEX GROUP. Conectamos compradores internacionales con proveedores peruanos. ¿Busca importar producto peruano o quiere conectar con compradores para exportar?';
    await msg.reply(bienvenida);
    historial[sender].push({ role: 'assistant', content: bienvenida });
    return;
  }

  historial[sender].push({ role: 'user', content: texto });
  if (historial[sender].length > 20) historial[sender] = historial[sender].slice(-20);

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
    console.log(`✅ Respuesta enviada a ${sender}`);
  } catch (err) {
    console.error('❌ Error API:', err.message);
    try { await msg.reply('Hubo un problema técnico. Intenta de nuevo.'); } catch (_) {}
  }
});

console.log('🚀 Iniciando PUNO...');
client.initialize();
