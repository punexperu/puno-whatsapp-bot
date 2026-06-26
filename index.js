const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');

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

// Detectar executable de Chromium para Railway/Linux
const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH
  || '/root/.nix-profile/bin/chromium'
  || '/usr/bin/chromium-browser'
  || '/usr/bin/chromium';

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
      '--disable-extensions',
      '--disable-background-networking'
    ],
    headless: true
  }
});

client.on('qr', qr => {
  console.log('\n📱 Escanea este QR con WhatsApp Business:\n');
  qrcode.generate(qr, { small: true });
  console.log('\n⏳ El QR expira en ~60 segundos. Escanea rápido.\n');
});

client.on('ready', () => {
  console.log('\n✅ PUNO está activo y escuchando en WhatsApp\n');
});

client.on('auth_failure', msg => {
  console.error('❌ Autenticación fallida:', msg);
  console.log('💡 Borra la carpeta .wwebjs_auth y reinicia para generar nuevo QR');
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
    console.log(`👋 Bienvenida enviada a ${sender}`);
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
    console.log(`✅ Respuesta: ${respuesta.substring(0, 80)}...`);
  } catch (err) {
    console.error('❌ Error API:', err.message);
    try {
      await msg.reply('Hubo un problema técnico. Intenta de nuevo en un momento.');
    } catch (sendErr) {
      console.error('❌ No se pudo enviar mensaje de error:', sendErr.message);
    }
  }
});

console.log('🚀 Iniciando PUNO... Chromium en:', chromiumPath);
client.initialize();
