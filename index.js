const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres PUNO, asistente comercial de PUNEX GROUP S.A.C.
Conectamos compradores internacionales con proveedores peruanos verificados.

TONO: Profesional, directo, cálido. Máximo 3-4 líneas por mensaje.
Sin emojis excesivos. Una sola pregunta por mensaje.

FLUJO DE CALIFICACIÓN:
1. Qué producto busca
2. Volumen aproximado
3. País de destino
4. Nombre y empresa
5. Si ha importado antes desde Perú
6. Certificaciones requeridas (orgánico, Global GAP, etc.)

Si menciona que tiene producto para exportar, adapta el guion:
pregunta qué producto, volumen disponible y mercados objetivo.

REGLAS:
- Nunca inventes precios
- Si preguntan precio, di que depende del volumen y se detallará en propuesta formal
- Responde SOLO el mensaje de WhatsApp, sin explicaciones extra`;

const historial = {};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  }
});

client.on('qr', qr => {
  console.log('\n📱 Escanea este QR con tu WhatsApp Business:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('\n✅ PUNO está activo y listo para responder en WhatsApp\n');
});

client.on('message', async msg => {
  if (msg.fromMe) return;
  if (msg.isGroupMsg) return;

  const sender = msg.from;
  const texto = msg.body.trim();
  if (!texto) return;

  console.log(`\n📩 Mensaje de ${sender}: ${texto}`);

  if (!historial[sender]) historial[sender] = [];
  historial[sender].push({ role: 'user', content: texto });

  // Limitar historial a últimos 10 mensajes para ahorrar tokens
  if (historial[sender].length > 10) {
    historial[sender] = historial[sender].slice(-10);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: historial[sender]
    });

    const respuesta = response.content[0].text.trim();
    historial[sender].push({ role: 'assistant', content: respuesta });

    await msg.reply(respuesta);
    console.log(`✅ Respuesta enviada: ${respuesta.substring(0, 60)}...`);

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
});

client.initialize();
