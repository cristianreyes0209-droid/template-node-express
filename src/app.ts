import "dotenv/config";
import "./db";
import cron from "node-cron";
import { upsertCustomer, getCustomerByPhone, setTestMode, getNextOrderNumber } from "./db";
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestListener } from 'node:http';
import express, {
    NextFunction,
    Request,
    RequestHandler,
    Response,
} from 'express';
import 'express-async-errors';
import pino from 'pino';
import helmet from 'helmet';
import compression from 'compression';
import { getClientIp } from 'request-ip';
import * as ev from 'express-validator';
import { Config } from './config';
import { menu } from './menu';
import { parseOrder, parseWithAI, classifyWithAI, normalizeText, isQuestion, isAmbiguousText } from './parser';
import {
  setPendingClarification,
  getPendingClarification,
  clearPendingClarification,
  clearOrder,
  createOrUpdateOrder,
  getOrder,
  updateOrderName,
  updateOrderStep,
  updateOrderAddress,
  updateOrderDeliveryType,
  updateOrderPayment,
  updateOrderGeneralNotes, // 👈 ESTA LÍNEA
  updateOrderDireccionNotes,
  calculateTotal,
  buildOrderJSON
} from "./orders";

export type App = {
    requestListener: RequestListener;
    shutdown: () => Promise<void>;
};

declare global {
    namespace Express {
        interface Request {
            abortSignal: AbortSignal;
        }
    }
}
async function sendWhatsAppMessage(phone: string, message: string) {
  console.log("SEND FUNC V2");
  console.log("PHONE ID ENV:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("TOKEN ENV START:", process.env.WHATSAPP_TOKEN?.slice(0, 20));
  console.log("TOKEN ENV END:", process.env.WHATSAPP_TOKEN?.slice(-20));
  console.log("TOKEN ENV LENGTH:", process.env.WHATSAPP_TOKEN?.length);
  console.log("TOKEN HAS NEWLINE:", process.env.WHATSAPP_TOKEN?.includes("\n"));
  console.log("TOKEN HAS SPACE:", process.env.WHATSAPP_TOKEN?.includes(" "));

  const response = await fetch(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(process.env.WHATSAPP_TOKEN || "").trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: message }
      })
    }
  );

 const data = await response.json();
  console.log("RESPUESTA META:", data);
}

async function sendWhatsAppButtons(phone: string, body: string, buttons: {id: string, title: string}[]) {
  const safeBody = (body || "¿Qué deseas hacer?").trim().slice(0, 1024);
  const response = await fetch(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(process.env.WHATSAPP_TOKEN || "").trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: {
            buttons: buttons.map(btn => ({
              type: "reply",
              reply: { id: btn.id, title: btn.title }
            }))
          }
        }
      })
    }
  );
  const data = await response.json();
  console.log("RESPUESTA BOTONES META:", data);
}
function isWithinBusinessHours(tipoEntrega: "domicilio" | "recoger"): boolean {
  // Obtenemos la hora actual en Bogotá usando toLocaleString
  const bogotaStr = new Date().toLocaleString("en-US", { timeZone: "America/Bogota" });
  const bogotaDate = new Date(bogotaStr);

  const day = bogotaDate.getDay(); // 0=domingo, 5=viernes, 6=sábado
  const totalMinutes = bogotaDate.getHours() * 60 + bogotaDate.getMinutes();

  const open = 15 * 60 + 30; // 3:30pm
  const isWeekend = day === 5 || day === 6; // viernes o sábado

  let close: number;
  if (tipoEntrega === "recoger") {
    close = isWeekend ? 23 * 60 : 22 * 60 + 30; // 11pm / 10:30pm
  } else {
    close = isWeekend ? 22 * 60 + 30 : 22 * 60; // 10:30pm / 10pm
  }

  return totalMinutes >= open && totalMinutes < close;
}

async function sendWhatsAppImageById(phone: string, mediaId: string) {
  const response = await fetch(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(process.env.WHATSAPP_TOKEN || "").trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "image",
        image: { id: mediaId }
      })
    }
  );
  const data = await response.json();
  console.log("RESPUESTA IMAGEN META:", data);
}

async function sendWhatsAppLocation(phone: string, latitude: number, longitude: number, name?: string) {
  const response = await fetch(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(process.env.WHATSAPP_TOKEN || "").trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "location",
        location: { latitude, longitude, name: name || "Ubicación del cliente", address: "" }
      })
    }
  );
  const data = await response.json();
  console.log("RESPUESTA LOCATION META:", data);
}

async function calcularDomicilio(direccionCliente: string, sucursal: string): Promise<{
  distanciaKm: number;
  valorDomicilio: number;
  descripcion: string;
}> {
  const sucursales: Record<string, string> = {
    "la_villa": "Calle 83 #16a-22, Barrio La Villa, Pereira, Colombia",
    "circunvalar": "Avenida Circunvalar #8-94, Pereira, Colombia"
  };

  const origenDecodificado = sucursales[sucursal] || sucursales["la_villa"];
  const origen = encodeURIComponent(origenDecodificado);
  const destinoDecodificado = direccionCliente + ", Pereira, Colombia";
  const destino = encodeURIComponent(destinoDecodificado);
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  console.log("📍 DOMICILIO - Origen:", origenDecodificado);
  console.log("📍 DOMICILIO - Destino:", destinoDecodificado);

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origen}&destinations=${destino}&mode=driving&key=${apiKey}`;

  const response = await fetch(url);
  const data = await response.json();

  console.log("GOOGLE MAPS RESPONSE:", JSON.stringify(data, null, 2));

  const elemento = data.rows?.[0]?.elements?.[0];

  if (!elemento || elemento.status !== "OK") {
    console.log("📍 DOMICILIO - Sin resultado OK, usando base $4500");
    return { distanciaKm: 0, valorDomicilio: 4500, descripcion: "Domicilio base" };
  }

  const distanciaMetros = elemento.distance.value;
  const distanciaKm = distanciaMetros / 1000;
  const MINIMO = 4500;
  const VALOR_POR_KM = 1000;
  const KM_MINIMO = 3;
  let valorDomicilio = MINIMO;
  if (distanciaKm > KM_MINIMO) {
    valorDomicilio = MINIMO + Math.ceil(distanciaKm - KM_MINIMO) * VALOR_POR_KM;
  }

  valorDomicilio = Math.ceil(valorDomicilio / 500) * 500;

  // Aplicar mínimo si la distancia es <1km o el valor calculado es <$4.500
  if (distanciaKm < 1 || valorDomicilio < 4500) {
    valorDomicilio = 4500;
  }

  console.log(`DISTANCIA CALCULADA: ${Math.round(distanciaKm * 10) / 10}km, VALOR: $${valorDomicilio}, ORIGEN: ${origenDecodificado}, DESTINO: ${destinoDecodificado}`);

  return {
    distanciaKm: Math.round(distanciaKm * 10) / 10,
    valorDomicilio,
    descripcion: `${Math.round(distanciaKm * 10) / 10}km → $${valorDomicilio.toLocaleString("es-CO")}`
  };
}

const inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

const LARGE_JSON_PATH = '/large-json-payload';
const APPLICATION_JSON = 'application/json';

export const initApp = async (
    config: Config,
    logger: pino.Logger
): Promise<App> => {
    const app = express();
    app.set('trust proxy', true);
    app.use(
        express.raw({
            limit: '1kb',
            type: (req) => req.headers['content-type'] !== APPLICATION_JSON,
        })
    );
    app.use(
        express.json({
            limit: '50kb',
            type: (req) => {
                return (
                    req.headers['content-type'] === APPLICATION_JSON &&
                    req.url !== LARGE_JSON_PATH
                );
            },
        })
    );
    app.use((req, res, next) => {
        const start = new Date().getTime();
        const ac = new AbortController();
        req.abortSignal = ac.signal;
        res.on('close', ac.abort.bind(ac));

        const requestId = req.headers['x-request-id']?.[0] || randomUUID();

        const l = logger.child({ requestId });

        let bytesRead = 0;
        req.on('data', (chunk: Buffer) => {
            bytesRead += chunk.length;
        });

        let bytesWritten = 0;
        const oldWrite = res.write;
        const oldEnd = res.end;
        res.write = function (chunk: Buffer | string, ...rest) {
            if (chunk) bytesWritten += chunk.length;

            // @ts-ignore
            return oldWrite.apply(res, [chunk, ...rest]);
        };
        // @ts-ignore
        res.end = function (chunk?: Buffer | string, ...rest) {
            if (chunk) bytesWritten += chunk.length;

            // @ts-ignore
            return oldEnd.apply(res, [chunk, ...rest]);
        };

        res.on('finish', () => {
            l.info(
                {
                    duration: new Date().getTime() - start,
                    method: req.method,
                    path: req.path,
                    status: res.statusCode,
                    ua: req.headers['user-agent'],
                    ip: getClientIp(req),
                    br: bytesRead,
                    bw: bytesWritten,
                },
                'Request handled'
            );
        });

        asl.run({ logger: l, requestId }, () => next());
    });
    app.use(helmet());
    app.use(compression());

    app.get(config.healthCheckEndpoint, (req, res) => {
        res.sendStatus(200);
    });

    app.get('/hi', (req, res) => {
        const s = asl.getStore();
        s?.logger.info('hi');
        res.send('hi');
    });

    app.post(
        '/echo',
        makeValidationMiddleware([ev.body('name').notEmpty()]),
        (req, res) => {
            res.json({ msg: `hi ${req.body.name}` });
        }
    );

    app.post(
        LARGE_JSON_PATH,
        express.json({ limit: '5mb', type: APPLICATION_JSON }),
        (req, res) => {
            // TODO: handle large json payload
            res.end();
        }
    );
app.get('/whatsapp', (req, res) => {
  const VERIFY_TOKEN = "crepes_token";

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFICADO");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }

  return res.status(400).send("Missing hub params");
});

const CREBOT_SUFFIX = "\n\nSoy CreBot 🤖 y estoy en período de prueba. Si tienes alguna dificultad puedes comunicarte al 315 191 3928.";

    function formatObservaciones(obs?: string) {
  if (!obs) return "";

  return obs
    .split(",")
    .map(o => o.trim())
    .join(" • ");
}
function getObservacionGeneralTexto(order: any) {
  return order.observacionesGenerales?.trim()
    ? "\n📝 Observación: " + order.observacionesGenerales.trim()
    : "";
}

const PALABRAS_DIRECCION = ["timbre", "porteria", "portería", "puerta", "piso", "apto", "apartamento", "casa", "edificio", "llamar", "tocar", "interior", "torre", "bloque", "local"];

function esObservacionDireccion(text: string): boolean {
  const norm = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return PALABRAS_DIRECCION.some(p => norm.includes(p));
}

function buildResumenFooter(order: any, totals: { subtotal: number; domicilio: number; total: number }, descripcionDomicilio?: string) {
  const domicilioLinea = order.tipoEntrega === "domicilio"
    ? "\n🛵 Domicilio: $" + totals.domicilio + (descripcionDomicilio ? ` (${descripcionDomicilio})` : "")
    : "";
  const obsLinea = getObservacionGeneralTexto(order);
  const obsDir = order.observacionDireccion?.trim() ? "\n📋 Obs. dirección: " + order.observacionDireccion.trim() : "";
  const entregaLinea = order.tipoEntrega === "domicilio"
    ? "\n📍 Dirección: " + (order.direccion || "No aplica") + obsDir
    : "\n🏪 Recoger en tienda";
  return "\n\nSubtotal: $" + totals.subtotal + domicilioLinea + "\nTotal: $" + totals.total + (obsLinea ? "\n" + obsLinea : "") + entregaLinea;
}
   // 🔥 AQUÍ PEGAS LA FUNCIÓN
async function handleOperationalRouting(order: any, totals: any) {
  const numeroOrden = await getNextOrderNumber();
  order.numeroOrden = numeroOrden;

  const sucursalTexto = order.sucursal === "la_villa" ? "La Villa" : order.sucursal === "circunvalar" ? "Av. Circunvalar" : order.sucursal || "No definida";

  const listaProductos = order.items.map((i: any) => {
    const obsTexto = i.observaciones ? ` (${i.observaciones})` : "";
    const extrasTexto = i.extras && i.extras.length > 0
      ? " +" + i.extras.map((e: any) => e.nombre).join(", +")
      : "";
    const precioLinea = ((i.precio || 0) + (i.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * i.cantidad;
    return `* ${i.cantidad} ${i.producto}${i.variante ? " - " + i.variante : ""}${obsTexto}${extrasTexto} - $${precioLinea.toLocaleString("es-CO")}`;
  }).join("\n");

  const direccionLinea = order.tipoEntrega === "domicilio"
    ? (order.direccion || "Sin dirección") + (order.observacionDireccion?.trim() ? `\n📋 Obs. dirección: ${order.observacionDireccion.trim()}` : "")
    : "Recoger en tienda";

  const resumenDomiciliarios =
    `🔔 Pedido #${numeroOrden} - Listo para recoger en 20 minutos\n\n` +
    `👤 Nombre: ${order.nombre || "Cliente"}\n` +
    `📞 Tel: ${order.telefono}\n\n` +
    `🧾 Productos:\n${listaProductos}\n\n` +
    `💰 Subtotal: $${totals.subtotal.toLocaleString("es-CO")}\n` +
    `🛵 Domicilio: $${totals.domicilio.toLocaleString("es-CO")}\n` +
    `💵 Total: $${totals.total.toLocaleString("es-CO")}\n\n` +
    `📍 Dirección: ${direccionLinea}\n` +
    `💳 Pago: ${order.formaPago || "No definido"}\n` +
    `🏪 Sucursal: ${sucursalTexto}` +
    (order.observacionesGenerales?.trim() ? `\n📝 Observación: ${order.observacionesGenerales.trim()}` : "") +
    (order.factura ? `\n\n📄 Factura: ${order.factura}` : "");

  // Mantener resumenInterno para circunvalar y logs
  const resumenInterno = resumenDomiciliarios;

  console.log("=== ROUTING OPERATIVO ===");
  console.log("SUCURSAL:", order.sucursal);
  console.log("TIPO ENTREGA:", order.tipoEntrega);
  console.log("FORMA PAGO:", order.formaPago);
  console.log("CIRCUNVALAR_PHONE:", process.env.CIRCUNVALAR_PHONE);
  console.log("VILLA_DOMICILIOS_DESTINO:", process.env.VILLA_DOMICILIOS_DESTINO);

  const sucursal = (order.sucursal || "").toString().trim().toLowerCase();

  if (sucursal === "circunvalar") {
    console.log("✅ ENTRÓ A RUTA CIRCUNVALAR");

    if (!process.env.CIRCUNVALAR_PHONE) {
      console.error("❌ CIRCUNVALAR_PHONE no está definida");
      return;
    }

    try {
      await sendWhatsAppMessage(process.env.CIRCUNVALAR_PHONE, resumenInterno);
      console.log("✅ MENSAJE ENVIADO A CIRCUNVALAR");
    } catch (error) {
      console.error("❌ ERROR ENVIANDO A CIRCUNVALAR:", error);
    }

    return;
  }

  if (sucursal === "la_villa") {
    console.log("✅ ENTRÓ A RUTA LA VILLA");

    if (order.tipoEntrega === "domicilio") {
      const domicilioMsg =
        "🚚 DOMICILIO VILLA\n\n" +
        `👤 ${order.nombre || "Cliente"}\n` +
        `📞 ${order.telefono}\n` +
        `📍 ${order.direccion || "Sin dirección"}\n` +
        `💳 Pago: ${order.formaPago || "No definido"}\n` +
        `💰 Pedido: $${totals.subtotal}\n` +
        `🛵 Domicilio: $${totals.domicilio}\n` +
        (order.formaPago === "efectivo"
          ? `💵 Cobrar: $${totals.total}\n`
          : "");

      if (!process.env.VILLA_DOMICILIOS_DESTINO) {
        console.error("❌ VILLA_DOMICILIOS_DESTINO no está definida");
      } else {
        try {
          await sendWhatsAppMessage(process.env.VILLA_DOMICILIOS_DESTINO, domicilioMsg);
          console.log("✅ MENSAJE ENVIADO A DOMICILIOS VILLA");
        } catch (error) {
          console.error("❌ ERROR ENVIANDO A DOMICILIOS VILLA:", error);
        }
      }
    }

    const DESTINOS_VILLA = ["573217233342", "573151913928"];
    for (const destino of DESTINOS_VILLA) {
      try {
        await sendWhatsAppMessage(destino, resumenDomiciliarios);
        console.log(`✅ RESUMEN ENVIADO A ${destino}`);
      } catch (error) {
        console.error(`❌ ERROR ENVIANDO A ${destino}:`, error);
      }
    }

    console.log("🖨️ IMPRIMIR COMANDA VILLA:");
    console.log(resumenDomiciliarios);
    return;
  }

  console.warn("⚠️ SUCURSAL NO RECONOCIDA EN ROUTING:", order.sucursal);
}
// 👇 DESPUÉS sigue tu endpoint
app.post("/whatsapp", async (req: Request, res: Response) => {
  console.log("============== PAYLOAD ==============");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=====================================");

  const entry = req.body.entry?.[0];
  const changes = entry?.changes;
  const value = changes?.[0]?.value;
  const messages = value?.messages;

  console.log("ENTRY ID:", entry?.id);
  console.log("CHANGES:", JSON.stringify(changes));
  console.log("VALUE:", JSON.stringify(value));
  console.log("MESSAGES:", JSON.stringify(messages));

  if (!messages || messages.length === 0) {
    console.log("SIN MENSAJES");
    return res.sendStatus(200);
  }

  const messageData = messages[0];

  if (!messageData) {
    console.log("No hay mensaje de usuario");
    return res.sendStatus(200);
  }

  const phone = messageData.from;

  // Ignorar mensajes de grupos (tienen @ en el ID)
  if (phone.includes("@g.us")) {
    return res.sendStatus(200);
  }
  const customer = await getCustomerByPhone(phone);
  const text = messageData.text?.body
  || messageData.interactive?.button_reply?.id
  || messageData.interactive?.list_reply?.id
  || "mensaje";

  const tipoMensaje = messageData.type || "desconocido";

  console.log("=== PROCESANDO MENSAJE ===");
  console.log("PHONE:", phone);
  console.log("TEXT:", text);
  console.log("TIPO:", tipoMensaje);
  console.log("==========================");

  if (!phone) {
    console.log("Evento sin telefono");
    return res.sendStatus(200);
  }

  let currentOrder = getOrder(phone);

  // Limpiar timer de inactividad al recibir cualquier mensaje
  const existingTimer = inactivityTimers.get(phone);
  if (existingTimer) {
    clearTimeout(existingTimer);
    inactivityTimers.delete(phone);
  }

  // Reiniciar timer si hay un pedido en curso (no confirmado, no esperando asesor)
  const noTimer = currentOrder?.step === "esperando_asesor" || currentOrder?.step === "esperando_mensaje_fuera_horario";
  if (currentOrder && currentOrder.step !== "confirmado" && !noTimer) {
    const timer = setTimeout(async () => {
      const order = getOrder(phone);
      if (order && order.step !== "confirmado") {
        await sendWhatsAppMessage(phone,
          "¿Sigues ahí? 😊 Tu pedido está guardado. Escríbeme cuando quieras continuar."
        );
      }
      inactivityTimers.delete(phone);
    }, 10 * 60 * 1000);
    inactivityTimers.set(phone, timer);
  }

  // Verificar horario de atención solo si el cliente no está en medio de un pedido
  if (!currentOrder || currentOrder.step === "esperando_menu_principal") {
    const tipoEntrega = currentOrder?.tipoEntrega === "domicilio" ? "domicilio" : "recoger";
    if (!currentOrder?.testMode && !customer?.test_mode && !isWithinBusinessHours(tipoEntrega)) {
      createOrUpdateOrder(phone, []);
      updateOrderStep(phone, "esperando_mensaje_fuera_horario");
      currentOrder = getOrder(phone)!;
      await sendWhatsAppMessage(phone,
        "Gracias por escribirnos 😊\n\n" +
        "En este momento estamos fuera de horario de atención.\n\n" +
        "🕐 Nuestro horario es:\n" +
        "• Domingo a jueves: 4:00pm – 10:00pm\n" +
        "• Viernes y sábado: 4:00pm – 10:30pm\n\n" +
        "¡Te esperamos pronto! 🥞\n\n" +
        "Si necesitas atención urgente, déjanos tu mensaje y nos pondremos en contacto contigo 📩"
      );
      return res.sendStatus(200);
    }
  }

  console.log("STEP ACTUAL:", currentOrder?.step);
  console.log("TIPO ENTREGA ACTUAL:", currentOrder?.tipoEntrega);
  console.log("PHONE:", phone);
  console.log("TEXT:", text);

let replyMessage = "";
// Steps donde el parser de reglas NO debe correr (respuestas a botones, datos personales, etc.)
const skipParsing =
  currentOrder?.step === "esperando_observacion_general" ||
  currentOrder?.step === "esperando_nombre" ||
  currentOrder?.step === "esperando_direccion" ||
  currentOrder?.step === "esperando_jalapenos" ||
  currentOrder?.step === "esperando_queso_dulce";

// Steps donde se intenta el parser de reglas primero, y la IA solo si no detecta producto
const useRulesThenAI =
  !skipParsing && (
    currentOrder?.step === "armando_pedido" ||
    currentOrder?.step === "post_agregar_producto"
  );

let parseResult: { items: any[]; ambiguousChoice?: any; upselling?: string } =
  { items: [], ambiguousChoice: undefined, upselling: undefined };

// Resultado de la IA para uso posterior en los handlers
let aiClassification: import('./parser').AIClassification | null = null;

if (skipParsing) {
  // No parsear nada — el handler sabe qué esperar
} else if (useRulesThenAI) {
  // 1. Parser de reglas primero
  if (!isQuestion(text)) {
    parseResult = parseOrder(text);
  }
  // 2. Solo si no detectó productos → llamar a Gemini para clasificar
  if (parseResult.items.length === 0 && !parseResult.ambiguousChoice) {
    const currentItems = currentOrder?.items.map((i: any) => ({
      producto: i.producto,
      precio: i.precio,
      variante: i.variante
    })) || [];
    aiClassification = await classifyWithAI(text, currentItems, currentOrder?.step || "");
    if (aiClassification?.intent === "producto") {
      parseResult = { items: aiClassification.items, upselling: aiClassification.upselling };
      aiClassification = null; // Manejado como producto, no como otro intent
    }
  }
} else {
  // Resto de steps: parser de reglas normal con fallback a IA legacy
  if (!isQuestion(text)) {
    parseResult = parseOrder(text);
    if (
      parseResult.items.length === 0 &&
      !parseResult.ambiguousChoice &&
      text.trim().split(/\s+/).length > 3
    ) {
      const aiResult = await parseWithAI(text);
      if (aiResult.items.length > 0) parseResult = aiResult;
    }
  }
}

const parsedItems = parseResult.items;
const aiUpselling: string = parseResult.upselling || "";
const lower = text.toLowerCase().trim();

const HORARIO_MSG =
  "🕐 Nuestro horario es:\n\n" +
  "📅 Domingo a jueves:\n" +
  "🏪 Local: 3:30 PM - 10:30 PM\n" +
  "🛵 Domicilios: 3:30 PM - 10:00 PM\n\n" +
  "📅 Viernes y sábado:\n" +
  "🏪 Local: 3:30 PM - 11:00 PM\n" +
  "🛵 Domicilios: 3:30 PM - 10:30 PM\n\n" +
  "📍 La Villa - Calle 83 #16a-22\n" +
  "📍 Av. Circunvalar #8-94 local 1";

const esConsultaHorario =
  lower.includes("a qué hora") ||
  lower.includes("a que hora") ||
  lower.includes("que hora") ||
  lower.includes("horario") ||
  lower.includes("abren") ||
  lower.includes("cierran") ||
  lower.includes("hasta qué hora") ||
  lower.includes("hasta que hora") ||
  lower.includes("desde qué hora") ||
  lower.includes("desde que hora") ||
  lower.includes("abierto") ||
  lower.includes("cerrado");

const esMensajeLargo = text.length > 200 || text.includes("Vengo de https://las-crepes.ola.click");

if (esConsultaHorario && !esMensajeLargo) {
  await sendWhatsAppMessage(phone, HORARIO_MSG);
  return res.sendStatus(200);
}

const esConsultaUbicacion =
  lower.includes("donde estan") ||
  lower.includes("dónde están") ||
  lower.includes("donde quedan") ||
  lower.includes("dónde quedan") ||
  lower.includes("donde queda") ||
  lower.includes("dónde queda") ||
  lower.includes("direccion") ||
  lower.includes("dirección") ||
  lower.includes("ubicacion") ||
  lower.includes("ubicación") ||
  lower.includes("como llegar") ||
  lower.includes("cómo llegar");

if (esConsultaUbicacion && !esMensajeLargo) {
  await sendWhatsAppMessage(phone,
    "📍 Nuestras sucursales:\n\n" +
    "🏪 La Villa\n" +
    "Calle 83 #16a-22, Pereira\n" +
    "https://maps.app.goo.gl/KvWtZ9r2vQKdcmXU6\n\n" +
    "🏪 Av. Circunvalar\n" +
    "Circunvalar #8-94 local 1, Pereira\n" +
    "https://maps.app.goo.gl/xRrJgWBGSNPdTnir9\n\n" +
    "Elige la sucursal más cercana a tu destino para que tu domicilio sea más económico 🛵"
  );
  return res.sendStatus(200);
}

if (lower === "test") {
  clearOrder(phone);
  createOrUpdateOrder(phone, []);
  const testOrder = getOrder(phone)!;
  testOrder.testMode = true;
  currentOrder = testOrder;
  await setTestMode(phone, true);
  await sendWhatsAppMessage(phone, "Modo test activado ✅ El horario de atención no aplica.");
  if (customer) {
    await sendWhatsAppButtons(phone,
      `Hola${customer.name ? ", " + customer.name : ""}. ¿Cómo te podemos servir?` + CREBOT_SUFFIX,
      [
        { id: "a", title: "Lo mismo de siempre 🔄" },
        { id: "b", title: "Pedir algo nuevo 🥞" },
        { id: "3", title: "Otros 💬" }
      ]
    );
  } else {
    await sendWhatsAppButtons(phone,
      "👋 Hola, Bienvenido/a a LAS CREPES! ¿Cómo te podemos servir?" + CREBOT_SUFFIX,
      [
        { id: "1", title: "Hacer un pedido 🥞" },
        { id: "2", title: "Ver menu 📋" },
        { id: "3", title: "Otros 💬" }
      ]
    );
  }
  return res.sendStatus(200);
}

if (lower === "reset") {
  clearOrder(phone);
  await setTestMode(phone, false);
  await sendWhatsAppMessage(phone, "Sesión reiniciada ✅");
  if (customer) {
    await sendWhatsAppButtons(phone,
      `Hola${customer.name ? ", " + customer.name : ""}. ¿Cómo te podemos servir?` + CREBOT_SUFFIX,
      [
        { id: "a", title: "Lo mismo de siempre 🔄" },
        { id: "b", title: "Pedir algo nuevo 🥞" },
        { id: "3", title: "Otros 💬" }
      ]
    );
  } else {
    await sendWhatsAppButtons(phone,
      "👋 Hola, Bienvenido/a a LAS CREPES! ¿Cómo te podemos servir?" + CREBOT_SUFFIX,
      [
        { id: "1", title: "Hacer un pedido 🥞" },
        { id: "2", title: "Ver menu 📋" },
        { id: "3", title: "Otros 💬" }
      ]
    );
  }
  return res.sendStatus(200);
}

if (text.includes("Vengo de https://las-crepes.ola.click")) {
  createOrUpdateOrder(phone, []);
  const order = getOrder(phone)!;
  order.holaclick_order = text;
  if (customer?.name) updateOrderName(phone, customer.name);
  updateOrderStep(phone, "esperando_sucursal_holaclick");
  currentOrder = getOrder(phone)!;
  await sendWhatsAppMessage(phone, "Gracias por tu pedido en HolaClick ✅ Vamos a procesarlo.");
  await sendWhatsAppButtons(phone,
    "¿En qué sucursal deseas recoger o desde dónde te enviamos el domicilio?",
    [
      { id: "la_villa", title: "La Villa 🏪" },
      { id: "circunvalar", title: "Av. Circunvalar 🏪" }
    ]
  );
 return res.sendStatus(200);
}

if (text.includes("Vengo de https://las-crepes.ola.click")) {
  const order = getOrder(phone) || createOrUpdateOrder(phone, []);
  updateOrderStep(phone, "esperando_sucursal_holaclick");
  currentOrder = getOrder(phone)!;
  currentOrder.holaclick_order = text;
  await sendWhatsAppButtons(phone,
    "Gracias por tu pedido en HolaClick ✅ Vamos a procesarlo.\n\n¿Para cuál sucursal es tu pedido?",
    [
      { id: "a", title: "La Villa" },
      { id: "b", title: "Av. Circunvalar" }
    ]
  );
  return res.sendStatus(200);
}

    console.log("=== DIAGNÓSTICO ===");
console.log("CUSTOMER:", customer?.name);
console.log("CURRENT ORDER:", currentOrder?.step);
console.log("LOWER:", lower);
console.log("===================");

if (
  currentOrder?.step === "armando_pedido" &&
  parsedItems.length === 0 &&
  !parseResult.ambiguousChoice
) {
  // Manejar intents de IA que no son "producto"
  if (aiClassification) {
    if (aiClassification.intent === "pregunta") {
      await sendWhatsAppMessage(phone, aiClassification.respuesta);
      return res.sendStatus(200);
    }
    if (aiClassification.intent === "observacion" && currentOrder.items.length > 0) {
      const idx = (aiClassification.productoIndex ?? -1) >= 0
        ? aiClassification.productoIndex!
        : currentOrder.items.length - 1;
      const targetItem = currentOrder.items[idx] || currentOrder.items[currentOrder.items.length - 1];
      if (targetItem) {
        targetItem.observaciones = targetItem.observaciones
          ? `${targetItem.observaciones}, ${aiClassification.texto}`
          : aiClassification.texto;
      }
      await sendWhatsAppButtons(phone,
        `Anotado ✅ "${aiClassification.texto}"\n\n¿Algo más?`,
        [{ id: "confirmar", title: "Confirmar ✅" }, { id: "agregar_mas", title: "Agregar más ➕" }, { id: "eliminar", title: "Eliminar ➖" }]
      );
      return res.sendStatus(200);
    }
    if (aiClassification.intent === "extra" && currentOrder.items.length > 0) {
      const lastItem = currentOrder.items[currentOrder.items.length - 1];
      lastItem.extras = lastItem.extras || [];
      lastItem.extras.push({ nombre: aiClassification.nombre, precio: aiClassification.precio, cantidad: 1 });
      await sendWhatsAppButtons(phone,
        `Agregado ✅ ${aiClassification.nombre} (+$${aiClassification.precio.toLocaleString("es-CO")})\n\n¿Algo más?`,
        [{ id: "confirmar", title: "Confirmar ✅" }, { id: "agregar_mas", title: "Agregar más ➕" }, { id: "eliminar", title: "Eliminar ➖" }]
      );
      return res.sendStatus(200);
    }
    if (aiClassification.intent === "ambiguo" && aiClassification.opciones.length > 0) {
      setPendingClarification(phone, aiClassification.opciones);
      updateOrderStep(phone, "esperando_aclaracion_producto");
      currentOrder = getOrder(phone)!;
      replyMessage = "¿Te refieres a:\n\n" +
        aiClassification.opciones.map((op, i) => `${i + 1}. ${op.nombre}`).join("\n") +
        "\n\nRespóndeme con el número 😊";
      await sendWhatsAppMessage(phone, replyMessage);
      return res.sendStatus(200);
    }
  }

  // Solicitud de ver menú en medio del pedido
  if (lower.includes("menu") || lower.includes("menú") || lower.includes("carta") || lower === "ver menu") {
    await sendWhatsAppMessage(phone,
      "Aquí tienes el menú completo 📋\n\nhttps://linktr.ee/qr/b0379e47-8522-4dd8-b3ed-aa1d5f4a8f8a?utm_source=qr_code\n\nCuando estés listo, escríbeme qué deseas pedir 😊"
    );
    return res.sendStatus(200);
  }

  // Sin clasificación IA ni parser — respuesta de fallback
  if (
    lower.includes("ayuda") ||
    lower.includes("como pedir") ||
    lower.includes("cómo pedir")
  ) {
    replyMessage =
      "Claro 😊\n\n" +
      "Puedes escribir tu pedido así:\n" +
      "• 1 Hawaiana\n" +
      "• 1 París sin queso\n" +
      "• 2 Ranchera\n\n" +
      "Por ahora te recomiendo agregar un producto por mensaje para que salga perfecto.";
  } else {
    replyMessage =
      "No logré entender bien tu pedido 😅\n\n" +
      "Puedes escribirlo así:\n" +
      "• 1 Hawaiana\n" +
      "• 2 Ranchera\n" +
      "• 1 Especial\n\n" +
      "O escribe ayuda 😊";
  }

  await sendWhatsAppMessage(phone, replyMessage);
  return res.sendStatus(200);
}

if (
  currentOrder?.step === "confirmado" &&
  (
    lower.includes("hola") ||
    lower.includes("buenas") ||
    lower.includes("buenos dias") ||
    lower.includes("buena tarde") ||
    lower.includes("buen dia") ||
    lower.includes("buenas tardes") ||
    lower.includes("buenas noches") ||
    lower.includes("quiero pedir") ||
    lower.includes("nuevo pedido")
  )
) {
  const confirmedAt = currentOrder.confirmedAt ? new Date(currentOrder.confirmedAt).getTime() : 0;
  const twoHoursMs = 2 * 60 * 60 * 1000;
  if (Date.now() - confirmedAt < twoHoursMs) {
    await sendWhatsAppMessage(phone, "Tu pedido ya fue confirmado ✅. Si necesitas algo más escríbenos.");
    return res.sendStatus(200);
  }

  createOrUpdateOrder(phone, []);
  updateOrderStep(phone, "esperando_menu_principal");
  currentOrder = getOrder(phone)!;

  if (customer) {
   const nombreCliente = (customer?.name && customer.name.trim() !== "") 
  ? `, ${customer.name.trim()}` 
  : "";


await sendWhatsAppButtons(phone,
   (nombreCliente ? `Hola${nombreCliente}, que bueno tenerte de vuelta. ¿Como te podemos servir hoy?` : "Que bueno tenerte de vuelta. ¿Como te podemos servir?") + CREBOT_SUFFIX,
  [
    { id: "a", title: "Lo mismo de siempre" },
    { id: "b", title: "Pedir algo nuevo" },
    { id: "3", title: "Otros" }
  ]
);
return res.sendStatus(200);
  } else {
   await sendWhatsAppButtons(phone,
  "Bienvenido a LAS CREPES. ¿Como te podemos servir?" + CREBOT_SUFFIX,
  [
    { id: "1", title: "Hacer un pedido" },
    { id: "2", title: "Ver menú" },
    { id: "3", title: "Otros" }
  ]
);
return res.sendStatus(200);
      }
  }

  console.log("==== DEBUG PARSER ====");
  console.log("TEXT:", text);
  console.log("LOWER:", lower);
  console.log("STEP:", currentOrder?.step);
  console.log("PARSED ITEMS:", JSON.stringify(parsedItems, null, 2));
  console.log("AMBIGUOUS CHOICE:", JSON.stringify(parseResult.ambiguousChoice, null, 2));
  console.log("======================");
  console.log("PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("TOKEN:", process.env.WHATSAPP_TOKEN?.slice(0, 10));

  if (parseResult.ambiguousChoice && currentOrder?.step !== "esperando_aclaracion_producto") {
    setPendingClarification(phone, parseResult.ambiguousChoice.opciones);
    updateOrderStep(phone, "esperando_aclaracion_producto");
    currentOrder = getOrder(phone)!;

    console.log("STEP DESPUÉS DE AMBIGÜEDAD:", currentOrder?.step);
    console.log("ACLARACIÓN GUARDADA:", currentOrder?.aclaracionPendiente);

  replyMessage =
  "¿Te refieres a:\n\n" +
  parseResult.ambiguousChoice.opciones
    .map((op: any, i: number) => `${i + 1}. ${op.nombre}`)
    .join("\n") +
  "\n\nRespóndeme con el número 😊";

    await sendWhatsAppMessage(phone, replyMessage);
    return res.sendStatus(200);
  }

if (!currentOrder) {
  if (lower === "2" || lower.includes("menu") || lower.includes("menú") || lower.includes("ver menu") || lower.includes("carta")) {
    await sendWhatsAppButtons(phone,
      "Aquí puedes ver nuestro menú completo 📋\n\nhttps://linktr.ee/qr/b0379e47-8522-4dd8-b3ed-aa1d5f4a8f8a?utm_source=qr_code\n\n¿Deseas hacer un pedido?",
      [
        { id: "1", title: "Sí, hacer un pedido" },
        { id: "3", title: "Otros" }
      ]
    );
    return res.sendStatus(200);
  }
  if (lower === "1" || lower.includes("pedido") || lower.includes("pedir") || lower.includes("hacer un pedido")) {
    createOrUpdateOrder(phone, []);
    updateOrderStep(phone, "esperando_tipo_entrega");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "¿Cómo deseas recibir tu pedido?",
      [
        { id: "domicilio", title: "Domicilio 🚚" },
        { id: "recoger", title: "Recoger en tienda 🏪" }
      ]
    );
    return res.sendStatus(200);
  }
  createOrUpdateOrder(phone, []);
  updateOrderStep(phone, "esperando_menu_principal");
  currentOrder = getOrder(phone)!;
  if (customer) {
    const nombreCliente = (customer?.name && customer.name.trim() !== "") 
      ? `, ${customer.name.trim()}` 
      : "";
    const bodyMsg = (nombreCliente
      ? `Hola${nombreCliente}. Que bueno tenerte de vuelta. ¿Como te podemos servir?`
      : "Que bueno tenerte de vuelta. ¿Como te podemos servir?") + CREBOT_SUFFIX;
    console.log("BODY IF CUSTOMER:", JSON.stringify(bodyMsg));
    await sendWhatsAppButtons(phone,
      bodyMsg,
      [
       { id: "a", title: "Lo mismo de siempre" },
       { id: "b", title: "Pedir algo nuevo" },
       { id: "3", title: "Otros" }
      ]
    );
    return res.sendStatus(200);
  } else {
    await sendWhatsAppButtons(phone,
      "👋 Hola, Bienvenido/a a LAS CREPES! Estamos aquí para asegurarnos de darte la mejor atención para que puedas realizar tu pedido sin complicaciones. ¿Como te podemos servir?" + CREBOT_SUFFIX,
      [
        { id: "1", title: "Hacer un pedido 🥞" },
        { id: "2", title: "Ver menu 📋" },
        { id: "3", title: "Otros 💬" }
      ]
    );
    return res.sendStatus(200);
  }
}

if (currentOrder?.step === "esperando_aclaracion_producto") {
  const opciones = currentOrder.aclaracionPendiente?.opciones || [];

  // Intentar por número primero, luego por nombre parcial
  const numSeleccion = parseInt(lower) - 1;
  let seleccion: { nombre: string; productoId: string } | undefined;

  if (!isNaN(numSeleccion) && numSeleccion >= 0 && numSeleccion < opciones.length) {
    seleccion = opciones[numSeleccion];
  } else {
    const lowerNorm = normalizeText(lower);
    seleccion = opciones.find((op: any) => {
      const opNorm = normalizeText(op.nombre);
      return opNorm.includes(lowerNorm) ||
        lowerNorm.split(/\s+/).some((w: string) => w.length >= 3 && opNorm.includes(w));
    });
  }

  if (seleccion) {
    const allProducts = menu.categorias.flatMap((c: any) => c.productos);
    const product = allProducts.find((p: any) => p.id === seleccion!.productoId);

    if (product) {
      clearPendingClarification(phone);

      if (product.variantes && product.variantes.length > 0) {
        currentOrder.pendingProduct = { id: product.id, nombre: product.nombre, precio: product.precio };
        updateOrderStep(phone, "esperando_variante_producto");
        currentOrder = getOrder(phone)!;

        const botonesVariantes = product.variantes.slice(0, 3).map((v: any) => ({
          id: `variante_${v.id}`,
          title: `${v.nombre} $${v.precio.toLocaleString("es-CO")}`
        }));

        await sendWhatsAppButtons(phone,
          `¿Cómo lo deseas?\n\n${product.nombre}`,
          botonesVariantes
        );
        return res.sendStatus(200);
      }

      createOrUpdateOrder(phone, [
        {
          producto: product.nombre,
          cantidad: 1,
          precio: product.precio,
          extras: []
        }
      ]);

      updateOrderStep(phone, "post_agregar_producto");
      currentOrder = getOrder(phone)!;

      const resumen = currentOrder.items
        .map((item: any) => {
          const observacionesTexto = item.observaciones ? ` (${formatObservaciones(item.observaciones)})` : "";
          const extrasTexto = item.extras && item.extras.length > 0
            ? " +" + item.extras.map((extra: any) =>
                extra.cantidad > 1 ? `${extra.cantidad} ${extra.nombre}` : extra.nombre
              ).join(", +")
            : "";
          const precioLinea = ((item.precio || 0) + (item.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * item.cantidad;
          return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto} - $${precioLinea.toLocaleString("es-CO")}`;
        })
        .join("\n");

      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nEstoy registrando:\n\n" + resumen + "\n\n📝 Si deseas una observacion escribela, o elige:",
        [
          { id: "confirmar", title: "Confirmar" },
          { id: "agregar_mas", title: "Agregar mas" },
          { id: "eliminar", title: "Eliminar" }
        ]
      );
      return res.sendStatus(200);
    } else {
      await sendWhatsAppMessage(phone, "No pude encontrar esa opción. Inténtalo de nuevo 😊");
      return res.sendStatus(200);
    }
  } else {
    await sendWhatsAppMessage(phone,
      `Por favor respóndeme con el número o el nombre del producto:\n\n` +
      opciones.map((op: any, i: number) => `${i + 1}. ${op.nombre}`).join("\n")
    );
    return res.sendStatus(200);
  }

} else if (currentOrder?.step === "esperando_variante_producto") {
  const pending = currentOrder.pendingProduct;

  if (!pending) {
    updateOrderStep(phone, "armando_pedido");
    replyMessage = "Ocurrió un error. ¿Qué deseas pedir?";
  } else {
    const allProducts = (menu.categorias as any[]).reduce((acc: any[], c: any) => acc.concat(c.productos), []);
    const product = allProducts.find((p: any) => p.id === pending.id);
    const variantes: any[] = product?.variantes || [];

    // Buscar variante por id del botón o por texto
    let varianteElegida = variantes.find((v: any) => lower === `variante_${v.id}`);
    if (!varianteElegida) {
      varianteElegida = variantes.find((v: any) =>
        v.aliases?.some((a: string) => lower.includes(a)) ||
        lower.includes(v.nombre.toLowerCase())
      );
    }

    if (varianteElegida) {
      createOrUpdateOrder(phone, [
        {
          producto: pending.nombre,
          cantidad: 1,
          precio: varianteElegida.precio,
          variante: varianteElegida.nombre,
          extras: []
        }
      ]);
      currentOrder.pendingProduct = undefined;

      // Preguntas post-variante
      if (pending.id === "mexicana") {
        updateOrderStep(phone, "esperando_jalapenos");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          "¿La deseas con jalapeños?",
          [{ id: "con_jalapenos", title: "Con jalapeños 🌶️" }, { id: "sin_jalapenos", title: "Sin jalapeños" }]
        );
        return res.sendStatus(200);
      }
      if (["nutella_crepe", "chocolate_crepe", "arequipe_crepe"].includes(pending.id)) {
        updateOrderStep(phone, "esperando_queso_dulce");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          "¿La deseas con queso doble crema?",
          [{ id: "con_queso_dulce", title: "Con queso 🧀" }, { id: "sin_queso_dulce", title: "Sin queso" }]
        );
        return res.sendStatus(200);
      }

      updateOrderStep(phone, "post_agregar_producto");
      currentOrder = getOrder(phone)!;

      const resumen = currentOrder.items
        .map((item: any) => {
          const extrasTexto = item.extras && item.extras.length > 0
            ? " +" + item.extras.map((e: any) => e.nombre).join(", +")
            : "";
          const precioLinea = ((item.precio || 0) + (item.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * item.cantidad;
          return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${extrasTexto} - $${precioLinea.toLocaleString("es-CO")}`;
        })
        .join("\n");

      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nEstoy registrando:\n\n" + resumen + "\n\n📝 Si deseas una observacion escribela, o elige:",
        [
          { id: "confirmar", title: "Confirmar" },
          { id: "agregar_mas", title: "Agregar mas" },
          { id: "eliminar", title: "Eliminar" }
        ]
      );
      return res.sendStatus(200);
    } else {
      const botonesVariantes = variantes.slice(0, 3).map((v: any) => ({
        id: `variante_${v.id}`,
        title: `${v.nombre} $${v.precio.toLocaleString("es-CO")}`
      }));
      await sendWhatsAppButtons(phone,
        `¿Cómo lo deseas?\n\n${pending.nombre}`,
        botonesVariantes
      );
      return res.sendStatus(200);
    }
  }

} else if (currentOrder?.step === "esperando_menu_principal") {

  if (customer) {

    if (
      lower === "a" ||
      lower.includes("lo mismo") ||
      lower.includes("igual") ||
      lower.includes("el mismo")
    ) {

      if (customer.last_order) {
        const order = getOrder(phone)!;
        order.items = customer.last_order;
        order.direccion = customer.last_address;
        order.nombre = customer.name;
        updateOrderName(phone, customer.name || "");
          if (customer.last_sucursal) {
  order.sucursal = customer.last_sucursal;
}
        updateOrderStep(phone, "esperando_tipo_entrega_repetido");
        currentOrder = getOrder(phone)!;

        const resumen = order.items.map((item: any) => {
          const observacionesTexto = item.observaciones
            ? ` (${formatObservaciones(item.observaciones)})`
            : "";
          const extrasTexto =
            item.extras && item.extras.length > 0
              ? " +" + item.extras.map((extra: any) =>
                  extra.cantidad > 1
                    ? `${extra.cantidad} ${extra.nombre}`
                    : extra.nombre
                ).join(", +")
              : "";
          return `* ${item.cantidad} ${item.producto}${observacionesTexto}${extrasTexto}`;
        }).join("\n");

        const observacionGeneralTexto = getObservacionGeneralTexto(order);

        await sendWhatsAppButtons(phone,
          "🔥 Perfecto, estoy repitiendo tu último pedido\n\nTu pedido es:\n" + resumen + observacionGeneralTexto + "\n\n¿Cómo deseas recibirlo hoy?",
          [
            { id: "a", title: "Recoger en tienda 🏪" },
            { id: "b", title: "Domicilio 🚚" }
          ]
        );
        return res.sendStatus(200);

      } else {
        updateOrderStep(phone, "esperando_tipo_entrega");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          "No encontré un pedido anterior 😊\n\n¿Cómo deseas recibir tu pedido?",
          [
            { id: "domicilio", title: "Domicilio 🚚" },
            { id: "recoger", title: "Recoger en tienda 🏪" }
          ]
        );
        return res.sendStatus(200);
      }

   } else if (
      lower === "b" ||
      lower.includes("nuevo") ||
      lower.includes("diferente") ||
      lower.includes("otra cosa")
    ) {
      updateOrderStep(phone, "esperando_tipo_entrega");
      currentOrder = getOrder(phone)!;

      await sendWhatsAppButtons(phone,
        "¿Como deseas recibir tu pedido?",
        [
          { id: "domicilio", title: "Domicilio" },
          { id: "recoger", title: "Recoger en tienda" }
        ]
      );
      return res.sendStatus(200);
  } else if (lower === "3" || lower.includes("otros") || lower.includes("ayuda") || lower.includes("pqr")) {
      updateOrderStep(phone, "esperando_ayuda");
      currentOrder = getOrder(phone)!;
      replyMessage = "Con gusto te ayudo 😊\n\nCuéntame en qué puedo ayudarte.";
  } else {
      await sendWhatsAppButtons(phone,
        (customer.name?.trim() ? `Hola, ${customer.name.trim()}. ` : "") + "Qué bueno tenerte de vuelta en LAS CREPES ¿Qué deseas hacer?" + CREBOT_SUFFIX,
        [
          { id: "a", title: "Lo mismo de siempre 🔄" },
          { id: "b", title: "Pedir algo nuevo 🥞" },
          { id: "3", title: "Otros 💬" }
        ]
      );
      return res.sendStatus(200);
    }
  } else if (lower === "1" || lower.includes("pedido") || lower.includes("pedir")) {
  updateOrderStep(phone, "esperando_tipo_entrega");
  currentOrder = getOrder(phone)!;

  await sendWhatsAppButtons(phone,
    "¿Cómo deseas recibir tu pedido?",
    [
      { id: "domicilio", title: "Domicilio 🚚" },
      { id: "recoger", title: "Recoger en tienda 🏪" }
    ]
  );
  return res.sendStatus(200);

} else if (lower === "2" || lower.includes("menu") || lower.includes("menú")) {
  await sendWhatsAppButtons(phone,
    "Aquí puedes ver nuestro menú completo 📋\n\nhttps://linktr.ee/qr/b0379e47-8522-4dd8-b3ed-aa1d5f4a8f8a?utm_source=qr_code\n\n¿Deseas hacer un pedido?",
    [
      { id: "1", title: "Sí, hacer un pedido 🥞" },
      { id: "3", title: "Otros 💬" }
    ]
  );
  return res.sendStatus(200);

} else if (lower === "3" || lower.includes("otros") || lower.includes("ayuda") || lower.includes("pqr")) {
  updateOrderStep(phone, "esperando_ayuda");
  currentOrder = getOrder(phone)!;
  replyMessage =
    "Con gusto te ayudo 😊\n\n" +
    "Cuéntame en qué puedo ayudarte.";

} else {
  await sendWhatsAppButtons(phone,
    "Hola  Bienvenido a LAS CREPES \n\n¿Qué deseas hacer?",
    [
      { id: "1", title: "Hacer un pedido 🥞" },
      { id: "2", title: "Ver menú 📋" },
      { id: "3", title: "Otros 💬" }
    ]
  );
  return res.sendStatus(200);
}

} else if (currentOrder?.step === "esperando_sucursal_holaclick") {
  if (lower === "la_villa" || lower.includes("villa")) {
    currentOrder.sucursal = "la_villa";
  } else if (lower === "circunvalar" || lower.includes("circunvalar")) {
    currentOrder.sucursal = "circunvalar";
  } else {
    await sendWhatsAppButtons(phone,
      "¿En qué sucursal deseas recoger o desde dónde te enviamos el domicilio?",
      [
        { id: "la_villa", title: "La Villa 🏪" },
        { id: "circunvalar", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  }

  const holaclickText = currentOrder.holaclick_order || "";
  const totalMatch = holaclickText.match(/Total[:\s]*\$?([\d.,]+)/i);
  const totalTexto = totalMatch ? `$${totalMatch[1]}` : "";
  const bodyPago = totalTexto
    ? `El total de tu pedido es ${totalTexto} 💰\n¿Cómo deseas pagar?`
    : "¿Cómo deseas pagar?";

  updateOrderStep(phone, "esperando_pago_holaclick");
  await sendWhatsAppButtons(phone, bodyPago, [
    { id: "efectivo", title: "Efectivo 💵" },
    { id: "nequi", title: "Nequi/Daviplata 📱" },
    { id: "bancolombia", title: "Bancolombia 🏦" }
  ]);
  return res.sendStatus(200);
} else if (currentOrder?.step === "esperando_pago_holaclick") {
  let formaPago = "";
  if (lower.includes("efectivo")) {
    formaPago = "efectivo";
  } else if (lower.includes("nequi") || lower.includes("daviplata")) {
    formaPago = "nequi/daviplata";
  } else if (lower.includes("bancolombia") || lower.includes("transferencia")) {
    formaPago = "bancolombia";
  }

  if (!formaPago) {
    const holaclickText2 = currentOrder.holaclick_order || "";
    const totalMatch2 = holaclickText2.match(/Total[:\s]*\$?([\d.,]+)/i);
    const bodyPago2 = totalMatch2
      ? `El total de tu pedido es $${totalMatch2[1]} 💰\n¿Cómo deseas pagar?`
      : "¿Cómo deseas pagar?";
    await sendWhatsAppButtons(phone, bodyPago2, [
      { id: "efectivo", title: "Efectivo 💵" },
      { id: "nequi", title: "Nequi/Daviplata 📱" },
      { id: "bancolombia", title: "Bancolombia 🏦" }
    ]);
    return res.sendStatus(200);
  }

  updateOrderPayment(phone, formaPago);
  currentOrder = getOrder(phone)!;

  const holaclickTotalMatch = (currentOrder.holaclick_order || "").match(/Total[:\s]*\$?([\d.,]+)/i);
  const holaclickTotalTexto = holaclickTotalMatch ? `$${holaclickTotalMatch[1]}` : "";
  const sucursalTextoHC = currentOrder.sucursal === "la_villa" ? "La Villa" : "Av. Circunvalar";

  if (formaPago === "nequi/daviplata") {
    const nequiNum = currentOrder.sucursal === "circunvalar" ? "3205839477" : "3207218267";
    updateOrderStep(phone, "esperando_comprobante_holaclick");
    await sendWhatsAppButtons(phone,
      `Perfecto 👌\n\n${holaclickTotalTexto ? `El total a pagar es: ${holaclickTotalTexto}\n\n` : ""}Pago por Nequi/Daviplata:\n📱 ${nequiNum}\n\nCuando realices el pago envíame el comprobante 📸`,
      [{ id: "listo", title: "Listo, ya pagué ✅" }]
    );
    return res.sendStatus(200);
  } else if (formaPago === "bancolombia") {
    const bancoNum = currentOrder.sucursal === "circunvalar" ? "27000004514" : "27033825108";
    updateOrderStep(phone, "esperando_comprobante_holaclick");
    replyMessage =
      "Perfecto 👌\n\n" +
      (holaclickTotalTexto ? `El total a pagar es: ${holaclickTotalTexto}\n\n` : "") +
      "Transferencia Bancolombia:\n" +
      "🏦 Cuenta de ahorros\n" +
      `💳 ${bancoNum}\n\n` +
      "Cuando realices el pago envíame el comprobante 📸";
  } else {
    // Efectivo → confirmar pedido directamente
    updateOrderStep(phone, "confirmado");
    clearTimeout(inactivityTimers.get(phone));
    inactivityTimers.delete(phone);
    currentOrder = getOrder(phone)!;
    currentOrder.confirmedAt = new Date().toISOString();

    const orderEfHC = getOrder(phone)!;
    const holaclickResumenEf = orderEfHC.holaclick_order || "";
    const resumenInternoEfHC =
      "🔥 PEDIDO HOLACLICK\n\n" +
      `👤 ${orderEfHC.nombre || customer?.name || "Cliente"}\n` +
      `📞 ${phone}\n\n` +
      `📋 Pedido original:\n${holaclickResumenEf}\n\n` +
      `🏬 Sucursal: ${sucursalTextoHC}\n` +
      `💳 Pago: Efectivo`;

    const DESTINOS_EF_HC = ["573207218267", "573151913928"];
    for (const destino of DESTINOS_EF_HC) {
      try { await sendWhatsAppMessage(destino, resumenInternoEfHC); }
      catch (e) { console.error(`❌ ERROR enviando pedido holaclick efectivo a ${destino}:`, e); }
    }

    replyMessage =
      "¡Tu pedido fue confirmado! 🔥\n\n" +
      `🏬 Sucursal: ${sucursalTextoHC}\n` +
      `💳 Pago: Efectivo\n\n` +
      "Pronto estará listo 🥞";
  }

} else if (currentOrder?.step === "esperando_comprobante_holaclick") {

  const imageId = messageData.image?.id;
  const esListo = lower.includes("listo") || lower.includes("ya pague") || lower.includes("ya pagué");

  if (imageId) {
    updateOrderStep(phone, "confirmado");
    clearTimeout(inactivityTimers.get(phone));
    inactivityTimers.delete(phone);
    currentOrder = getOrder(phone)!;
    currentOrder.confirmedAt = new Date().toISOString();

    const order = getOrder(phone)!;
    const holaclickResumen = order.holaclick_order || "";
    const sucursalTexto = order.sucursal === "la_villa" ? "La Villa" : "Av. Circunvalar";

    const resumenHolaclick =
      "🔥 PEDIDO HOLACLICK\n\n" +
      `👤 ${order.nombre || customer?.name || "Cliente"}\n` +
      `📞 ${phone}\n\n` +
      `📋 Pedido original:\n${holaclickResumen}\n\n` +
      `🏬 Sucursal: ${sucursalTexto}\n` +
      `💳 Pago: ${order.formaPago || ""}`;

    const DESTINOS_HOLACLICK = ["573207218267", "573151913928"];

    for (const destino of DESTINOS_HOLACLICK) {
      try {
        await sendWhatsAppMessage(destino, resumenHolaclick);
        await sendWhatsAppImageById(destino, imageId);
      } catch (e) { console.error(`❌ ERROR reenviando comprobante holaclick a ${destino}:`, e); }
    }

    replyMessage = "Gracias, comprobante recibido ✅ Tu pedido está en proceso 🔥";
  } else if (esListo) {
    replyMessage = "Estamos esperando tu comprobante de pago 📸";
  } else {
    replyMessage = "Cuando realices el pago envíame el comprobante 📸";
  }

} else if (currentOrder?.step === "esperando_mensaje_fuera_horario") {
  try {
    await sendWhatsAppMessage("573151913928",
      `🔔 Mensaje fuera de horario\n👤 Tel: ${phone}\n💬 Mensaje: ${text}\n⚠️ Atiende esta solicitud`
    );
  } catch (e) { console.error("❌ ERROR reenviando mensaje fuera de horario:", e); }
  updateOrderStep(phone, "esperando_asesor");
  replyMessage = "Gracias por tu mensaje ✅ Un asesor se pondrá en contacto contigo pronto 😊";

} else if (currentOrder?.step === "esperando_ayuda") {
  updateOrderStep(phone, "esperando_asesor");
  currentOrder = getOrder(phone)!;

  const nombreCliente = currentOrder.nombre || customer?.name || phone;
  const mensajeAsesor =
    "Mensaje de cliente\n" +
    `👤 Nombre: ${nombreCliente}\n` +
    `📞 Tel: ${phone}\n` +
    `💬 Mensaje: ${text}`;
  try {
    await sendWhatsAppMessage("573151913928", mensajeAsesor);
  } catch (e) { console.error("❌ ERROR reenviando mensaje a asesor:", e); }

  replyMessage = "Gracias por escribirnos. En breve un asesor te contactará 😊";

} else if (currentOrder?.step === "esperando_asesor") {
  const nombreAsesor = currentOrder.nombre || customer?.name || phone;
  const mensajeReenvio =
    `💬 MENSAJE DE CLIENTE\n\n` +
    `👤 Nombre: ${nombreAsesor}\n` +
    `📞 Tel: ${phone}\n` +
    `💬 Mensaje: ${text}`;
  try {
    await sendWhatsAppMessage("573151913928", mensajeReenvio);
    console.log("✅ MENSAJE REENVIADO A ASESOR 573151913928 desde", phone);
  } catch (e) { console.error("❌ ERROR reenviando a asesor:", e); }
  replyMessage = "Con gusto 😊 Un asesor te atenderá pronto.";
} else if (currentOrder?.step === "esperando_tipo_entrega_repetido") {
  if (
    lower === "a" ||
    lower.includes("recoger") ||
    lower.includes("tienda")
  ) {
    updateOrderDeliveryType(phone, "recoger");
    updateOrderStep(phone, "esperando_confirmacion");
    currentOrder = getOrder(phone)!;

    const order = getOrder(phone)!;
    const totals = calculateTotal(order);

    const resumen = order.items.map((item: any) => {
      const observacionesTexto = item.observaciones
        ? ` (${formatObservaciones(item.observaciones)})`
        : "";

      const extrasTexto =
        item.extras && item.extras.length > 0
          ? " +" +
            item.extras.map((extra: any) =>
              extra.cantidad > 1
                ? `${extra.cantidad} ${extra.nombre}`
                : extra.nombre
            ).join(", +")
          : "";

      return `* ${item.cantidad} ${item.producto}${observacionesTexto}${extrasTexto}`;
    }).join("\n");

  await sendWhatsAppButtons(phone,
    "Perfecto 👌\n\nTu pedido es:\n" +
    resumen +
    buildResumenFooter(order, totals) +
    "\n\n📝 Si deseas hacer una observación escríbela ahora, o elige una opción:",
    [
      { id: "confirmar", title: "Confirmar" },
      { id: "agregar_mas", title: "Agregar mas" },
      { id: "eliminar", title: "Eliminar" }
    ]
  );
  return res.sendStatus(200);
  } else if (
    lower === "b" ||
    lower.includes("domicilio")
  ) {
    updateOrderDeliveryType(phone, "domicilio");

    // Asegurar que el nombre esté en la orden antes de pedir dirección
    if (customer?.name && !getOrder(phone)?.nombre) {
      updateOrderName(phone, customer.name);
    }
    currentOrder = getOrder(phone)!;

    if (customer?.last_address) {
      updateOrderStep(phone, "esperando_confirmacion_direccion");
      currentOrder = getOrder(phone)!;

  await sendWhatsAppButtons(phone,
  `Perfecto 👍\n\n¿Deseas usar la misma dirección?\n\n📍 ${customer.last_address}`,
  [
    { id: "a", title: "Sí, esa misma ✅" },
    { id: "b", title: "No, cambiarla 📍" }
  ]
);
return res.sendStatus(200);
    } else if (!currentOrder.nombre) {
      // Cliente sin nombre ni dirección previa — pedir nombre primero
      updateOrderStep(phone, "esperando_nombre");
      currentOrder = getOrder(phone)!;
      replyMessage = "Perfecto 👍\n\nAntes de continuar, ¿cuál es tu nombre?";
    } else {
      updateOrderStep(phone, "esperando_direccion");
      currentOrder = getOrder(phone)!;

      replyMessage =
        "Perfecto 👍\n\n" +
        "Envíame tu ubicación 📍 para mayor exactitud, o escríbeme tu dirección.";
    }

  } else {
    await sendWhatsAppButtons(phone,
  "¿Cómo deseas recibirlo hoy?",
  [
    { id: "a", title: "Recoger en tienda 🏪" },
    { id: "b", title: "Domicilio 🚚" }
  ]
);
return res.sendStatus(200);
  }
} else if (currentOrder?.step === "esperando_sucursal") {
  if (
    lower === "a" ||
    lower.includes("villa") ||
    lower.includes("la villa")
  ) {
    currentOrder.sucursal = "la_villa";
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👍\n\n" +
      "Puedes hacer tu pedido aquí:\n" +
      "https://las-crepes.ola.click/products?utm_source=Chatbot&utm_campaign=place_an_order\n\n" +
      "O si prefieres, escríbeme lo que deseas pedir y yo te ayudo por aquí 😊";

  } else if (
    lower === "b" ||
    lower.includes("circunvalar") ||
    lower.includes("avenida circunvalar") ||
    lower.includes("av circunvalar")
  ) {
    currentOrder.sucursal = "circunvalar";
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👍\n\n" +
      "Puedes hacer tu pedido aquí:\n" +
      "https://las-crepes.ola.click/products?utm_source=Chatbot&utm_campaign=place_an_order\n\n" +
      "O si prefieres, escríbeme lo que deseas pedir y yo te ayudo por aquí 😊";

  } else {
    await sendWhatsAppButtons(phone,
      "Elige la sucursal más cercana a tu destino. Esto hace tu domicilio más económico 🛵",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  }
} else if (
  parsedItems.length > 0 &&
  currentOrder?.step === "armando_pedido"
) {
  // Si algún jugo fue detectado sin variante, preguntar agua o leche primero
  const allMenuProducts = (menu.categorias as any[]).reduce((acc: any[], c: any) => acc.concat(c.productos), []);
  const itemNeedingVariant = parsedItems.find(item => {
    if (item.variante) return false;
    const prod = allMenuProducts.find((p: any) => p.id === item.productoId);
    return prod?.tipo === "jugo";
  });

  if (itemNeedingVariant) {
    const prod = allMenuProducts.find((p: any) => p.id === itemNeedingVariant.productoId)!;
    currentOrder.pendingProduct = { id: prod.id, nombre: prod.nombre, precio: prod.precio };
    updateOrderStep(phone, "esperando_variante_producto");
    currentOrder = getOrder(phone)!;
    const botonesVariantes = prod.variantes.slice(0, 3).map((v: any) => ({
      id: `variante_${v.id}`,
      title: `${v.nombre} $${v.precio.toLocaleString("es-CO")}`
    }));
    await sendWhatsAppButtons(phone,
      `¿Cómo deseas tu ${prod.nombre}?`,
      botonesVariantes
    );
    return res.sendStatus(200);
  }

  createOrUpdateOrder(phone, parsedItems);
  currentOrder = getOrder(phone)!;

  // Preguntas post-producto
  const lastItem = parsedItems[parsedItems.length - 1];
  if (lastItem?.productoId === "mexicana") {
    updateOrderStep(phone, "esperando_jalapenos");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "¿La deseas con jalapeños?",
      [{ id: "con_jalapenos", title: "Con jalapeños 🌶️" }, { id: "sin_jalapenos", title: "Sin jalapeños" }]
    );
    return res.sendStatus(200);
  }
  if (["nutella_crepe", "chocolate_crepe", "arequipe_crepe"].includes(lastItem?.productoId)) {
    updateOrderStep(phone, "esperando_queso_dulce");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "¿La deseas con queso doble crema?",
      [{ id: "con_queso_dulce", title: "Con queso 🧀" }, { id: "sin_queso_dulce", title: "Sin queso" }]
    );
    return res.sendStatus(200);
  }

  const order = getOrder(phone)!;
  updateOrderStep(phone, "post_agregar_producto");
  currentOrder = getOrder(phone)!;

  const resumen = order.items
    .map((item: any) => {
      const observacionesTexto = item.observaciones
        ? ` (${item.observaciones})`
        : "";

      const extrasTexto =
        item.extras && item.extras.length > 0
          ? " +" +
            item.extras
              .map((extra: any) =>
                extra.cantidad > 1
                  ? `${extra.cantidad} ${extra.nombre}`
                  : extra.nombre
              )
              .join(", +")
          : "";

      const precioLinea = ((item.precio || 0) + (item.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * item.cantidad;
      return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto} - $${precioLinea.toLocaleString("es-CO")}`;
    })
    .join("\n");

 await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nEstoy registrando:\n\n" +
  resumen +
  (aiUpselling ? `\n\n💡 ${aiUpselling}` : "") +
  "\n\n📝 Si deseas una observación escríbela, o elige:",
  [
    { id: "confirmar", title: "Confirmar ✅" },
    { id: "agregar_mas", title: "Agregar más ➕" },
    { id: "eliminar", title: "Eliminar ➖" }
  ]
);
return res.sendStatus(200);
} else if (currentOrder?.step === "esperando_jalapenos") {
  const withJalapenos = lower === "con_jalapenos" || lower.includes("con") || lower.includes("jalap");
  // Actualizar la observación del último item (la Mexicana)
  const orderJal = getOrder(phone)!;
  const lastItemJal = orderJal.items[orderJal.items.length - 1];
  if (lastItemJal) {
    const obsActual = lastItemJal.observaciones ? lastItemJal.observaciones + ", " : "";
    lastItemJal.observaciones = withJalapenos ? obsActual + "con jalapeños" : obsActual + "sin jalapeños";
  }
  updateOrderStep(phone, "post_agregar_producto");
  currentOrder = getOrder(phone)!;
  const resumenJal = currentOrder.items.map((item: any) => {
    const obs = item.observaciones ? ` (${item.observaciones})` : "";
    const ext = item.extras?.length > 0 ? " +" + item.extras.map((e: any) => e.nombre).join(", +") : "";
    const precio = ((item.precio || 0) + (item.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * item.cantidad;
    return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${obs}${ext} - $${precio.toLocaleString("es-CO")}`;
  }).join("\n");
  await sendWhatsAppButtons(phone,
    "Perfecto 👌\n\nEstoy registrando:\n\n" + resumenJal + "\n\n📝 Si deseas una observación escríbela, o elige:",
    [{ id: "confirmar", title: "Confirmar ✅" }, { id: "agregar_mas", title: "Agregar más ➕" }, { id: "eliminar", title: "Eliminar ➖" }]
  );
  return res.sendStatus(200);

} else if (currentOrder?.step === "esperando_queso_dulce") {
  const withQueso = lower === "con_queso_dulce" || lower.includes("con") || lower.includes("queso");
  const orderQD = getOrder(phone)!;
  const lastItemQD = orderQD.items[orderQD.items.length - 1];
  if (lastItemQD) {
    const obsActual = lastItemQD.observaciones ? lastItemQD.observaciones + ", " : "";
    lastItemQD.observaciones = withQueso ? obsActual + "con queso doble crema" : obsActual + "sin queso";
  }
  updateOrderStep(phone, "post_agregar_producto");
  currentOrder = getOrder(phone)!;
  const resumenQD = currentOrder.items.map((item: any) => {
    const obs = item.observaciones ? ` (${item.observaciones})` : "";
    const ext = item.extras?.length > 0 ? " +" + item.extras.map((e: any) => e.nombre).join(", +") : "";
    const precio = ((item.precio || 0) + (item.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * item.cantidad;
    return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${obs}${ext} - $${precio.toLocaleString("es-CO")}`;
  }).join("\n");
  await sendWhatsAppButtons(phone,
    "Perfecto 👌\n\nEstoy registrando:\n\n" + resumenQD + "\n\n📝 Si deseas una observación escríbela, o elige:",
    [{ id: "confirmar", title: "Confirmar ✅" }, { id: "agregar_mas", title: "Agregar más ➕" }, { id: "eliminar", title: "Eliminar ➖" }]
  );
  return res.sendStatus(200);

} else if (currentOrder?.step === "esperando_nombre") {
  if (
    lower === "si" ||
    lower === "sí" ||
    lower === "no" ||
    lower === "ok" ||
    lower === "ya" ||
    lower === "vale" ||
    lower === "listo" ||
    lower === "domicilio" ||
    lower === "recoger"
  ) {
    replyMessage = "Por favor dime tu nombre para continuar 😊";
  } else {
    const nombreRecibido = text.trim();
    updateOrderName(phone, nombreRecibido);
    currentOrder = getOrder(phone)!;
    // Persistir nombre en Supabase inmediatamente
    await upsertCustomer({ phone, name: nombreRecibido }).catch(err =>
      console.error("❌ Error guardando nombre en Supabase:", err)
    );

    if (currentOrder.tipoEntrega === "domicilio") {
      updateOrderStep(phone, "esperando_direccion");
      currentOrder = getOrder(phone)!;
      replyMessage = "Perfecto 👍\n\nEnvíame tu ubicación 📍 para mayor exactitud, o escríbeme tu dirección.";
    } else {
      updateOrderStep(phone, "esperando_confirmacion");
      currentOrder = getOrder(phone)!;

   const order = getOrder(phone)!;
const totals = calculateTotal(order);

const resumen = order.items
  .map((item: any) => {
    const observacionesTexto = item.observaciones
      ? ` (${formatObservaciones(item.observaciones)})`
      : "";

    const extrasTexto =
      item.extras && item.extras.length > 0
        ? " +" +
          item.extras
            .map((extra: any) =>
              extra.cantidad > 1
                ? `${extra.cantidad} ${extra.nombre}`
                : extra.nombre
            )
            .join(", +")
        : "";

    return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
  })
  .join("\n");

await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido es:\n" +
  resumen +
  buildResumenFooter(order, totals) +
  "\n\n📝 Si deseas una observación escríbela, o elige:",
  [
    { id: "confirmar", title: "Confirmar" },
    { id: "agregar_mas", title: "Agregar mas" },
    { id: "eliminar", title: "Eliminar" }
  ]
);
return res.sendStatus(200);
    }
  }

} else if (currentOrder?.step === "esperando_tipo_entrega") {
  if (lower === "domicilio" || lower.includes("domicilio")) {
    updateOrderDeliveryType(phone, "domicilio");
    updateOrderStep(phone, "esperando_sucursal");
    currentOrder = getOrder(phone)!;

    await sendWhatsAppButtons(phone,
      "Elige la sucursal más cercana a tu destino. Esto hace tu domicilio más económico 🛵",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);

  } else if (lower === "recoger" || lower.includes("recoger") || lower.includes("tienda")) {
    updateOrderDeliveryType(phone, "recoger");
    updateOrderStep(phone, "esperando_sucursal");
    currentOrder = getOrder(phone)!;

    await sendWhatsAppButtons(phone,
      "Elige la sucursal más cercana a tu destino. Esto hace tu domicilio más económico 🛵",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);

  } else {
    await sendWhatsAppButtons(phone,
      "¿Como deseas recibir tu pedido?",
      [
        { id: "domicilio", title: "Domicilio" },
        { id: "recoger", title: "Recoger en tienda" }
      ]
    );
    return res.sendStatus(200);
  }
} else if (currentOrder?.step === "esperando_direccion") {
  // Detectar mensaje de ubicación (location pin de WhatsApp)
  if (messageData.type === "location" && messageData.location?.latitude && messageData.location?.longitude) {
    const { latitude, longitude } = messageData.location;
    let direccionGeocoded = `${latitude},${longitude}`;

    const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
    if (mapsKey) {
      try {
        const geoRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${mapsKey}`
        );
        const geoData = await geoRes.json() as any;
        if (geoData.results?.[0]?.formatted_address) {
          direccionGeocoded = geoData.results[0].formatted_address;
        }
      } catch (e) {
        console.error("❌ Error geocoding location:", e);
      }
    }

    updateOrderAddress(phone, direccionGeocoded);
    const orderForCoords = getOrder(phone);
    if (orderForCoords) orderForCoords.locationCoords = { latitude, longitude };
  } else {
    updateOrderAddress(phone, text);
  }

  const order = getOrder(phone)!;

  let valorDomicilio = 4500;
  let descripcionDomicilio = "";
  try {
    const calculo = await calcularDomicilio(text, order.sucursal || "la_villa");
    valorDomicilio = calculo.valorDomicilio;
    descripcionDomicilio = calculo.descripcion;
    order.valorDomicilio = valorDomicilio;
  } catch (e) {
    console.log("Error calculando domicilio:", e);
  }

  const totals = calculateTotal(order, valorDomicilio);
 
 

  const resumen = order.items
    .map((item: any) => {
      const observacionesTexto = item.observaciones
        ? ` (${item.observaciones})`
        : "";

      const extrasTexto =
        item.extras && item.extras.length > 0
          ? " +" +
            item.extras
              .map((extra: any) =>
                extra.cantidad > 1
                  ? `${extra.cantidad} ${extra.nombre}`
                  : extra.nombre
              )
              .join(", +")
          : "";

      return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
    })
    .join("\n");
  updateOrderStep(phone, "esperando_confirmacion");
  currentOrder = getOrder(phone)!;

await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido es:\n" +
  resumen +
  buildResumenFooter(order, totals) +
  "\n\n📝 Si deseas una observación escríbela, o elige:",
  [
    { id: "confirmar", title: "Confirmar ✅" },
    { id: "eliminar", title: "Eliminar ➖" },
    { id: "agregar_mas", title: "Agregar más ➕" }
  ]
);
return res.sendStatus(200);
} else if (currentOrder?.step === "esperando_confirmacion") {
 if (
  lower === "confirmar" ||
  lower === "a" ||
  lower === "1" ||
  lower === "si" ||
  lower === "sí" ||
  lower.includes("confirmar") ||
  lower.includes("confirmado") ||
  lower.includes("listo") ||
  lower.includes("dale") ||
  lower.includes("de una") ||
  lower.includes("va")

 ) {
    // Guardar nombre del perfil si el pedido no tiene nombre aún
    if (customer?.name && !currentOrder.nombre) {
      updateOrderName(phone, customer.name);
      currentOrder = getOrder(phone)!;
    }

    // Nunca avanzar si no hay nombre
    if (!currentOrder.nombre) {
      updateOrderStep(phone, "esperando_nombre");
      currentOrder = getOrder(phone)!;
      await sendWhatsAppMessage(phone, "Antes de continuar, ¿cuál es tu nombre?");
      return res.sendStatus(200);
    }

    if (currentOrder.tipoEntrega === "domicilio" && !currentOrder.direccion) {
      if (customer?.last_address) {
        updateOrderStep(phone, "esperando_confirmacion_direccion");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          `¿Deseas enviar a tu direccion anterior?\n📍 ${customer.last_address}`,
          [
            { id: "a", title: "Si, esa misma" },
            { id: "b", title: "No, cambiarla" }
          ]
        );
        return res.sendStatus(200);
      } else {
        updateOrderStep(phone, "esperando_direccion");
        currentOrder = getOrder(phone)!;
        replyMessage = "Envíame tu ubicación 📍 para mayor exactitud, o escríbeme tu dirección.";
        await sendWhatsAppMessage(phone, replyMessage);
        return res.sendStatus(200);
      }
    }

    updateOrderStep(phone, "esperando_pago");
    currentOrder = getOrder(phone)!;

    const totalsParaPago = calculateTotal(getOrder(phone)!);
   await sendWhatsAppButtons(phone,
  `El total de tu pedido es $${totalsParaPago.total} 💰\n¿Cómo deseas pagar?`,
  [
    { id: "efectivo", title: "Efectivo 💵" },
    { id: "nequi", title: "Nequi/Daviplata 📱" },
    { id: "bancolombia", title: "Bancolombia 🏦" }
  ]
);
return res.sendStatus(200);

  } else if (
    lower === "eliminar" ||
    lower === "b" ||
    lower === "3" ||
    lower.includes("retirar") ||
    lower.includes("eliminar") ||
    lower.includes("quitar")
  ) {
    updateOrderStep(phone, "retirando_productos");
    currentOrder = getOrder(phone)!;

    const resumen = currentOrder.items
      .map((item: any, index: number) =>
        `* ${index + 1}. ${item.producto}${item.variante ? " - " + item.variante : ""}`
      )
      .join("\n");

    replyMessage =
      "Perfecto 👍\n\n" +
      "¿Qué producto deseas retirar?\n\n" +
      resumen +
      "\n\nRespóndeme con el número del producto.";

  } else if (
    lower === "agregar_mas" ||
    lower === "c" ||
    lower === "2" ||
    lower.includes("agregar") ||
    lower.includes("más") ||
    lower.includes("mas")
  ) {
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "¿Qué deseas agregar?\n\n" +
      "Puedes escribir otra crepe, bebida, topping o hacer una observación.";

  } else if (
    lower === "d" ||
    lower.includes("observacion") ||
    lower.includes("observación")
  ) {
    updateOrderStep(phone, "esperando_observacion_general");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "Escríbeme la observación para tu pedido 😊";

  } else {
  await sendWhatsAppButtons(phone,
  "¿Qué deseas hacer?",
  [
    { id: "confirmar", title: "Confirmar ✅" },
    { id: "agregar_mas", title: "Agregar más ➕" },
    { id: "eliminar", title: "Eliminar ➖" }
  ]
);
return res.sendStatus(200);
  }
} else if (currentOrder?.step === "retirando_productos") {
  const order = getOrder(phone)!;
  const index = Number(lower) - 1;

  if (!Number.isNaN(index) && index >= 0 && index < order.items.length) {
    order.items.splice(index, 1);
    currentOrder = getOrder(phone)!;

    if (!order.items || order.items.length === 0) {
      updateOrderStep(phone, "armando_pedido");
      currentOrder = getOrder(phone)!;
        if (customer?.name) {
        updateOrderName(phone, customer.name);
      }

      replyMessage =
        "Listo 👍 Ya retiré ese producto.\n\n" +
        "Tu pedido quedó vacío.\n\n" +
        "¿Qué deseas pedir?";
    } else {
      const totals = calculateTotal(order);

      const resumen = order.items
        .map((item: any) => {
          const observacionesTexto = item.observaciones
            ? ` (${formatObservaciones(item.observaciones)})`
            : "";

          const extrasTexto =
            item.extras && item.extras.length > 0
              ? " +" +
                item.extras
                  .map((extra: any) =>
                    extra.cantidad > 1
                      ? `${extra.cantidad} ${extra.nombre}`
                      : extra.nombre
                  )
                  .join(", +")
              : "";

          return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
        })
        .join("\n");
      updateOrderStep(phone, "esperando_confirmacion");
      currentOrder = getOrder(phone)!;

    await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido actualizado es:\n" +
  resumen +
  buildResumenFooter(order, totals) +
  "\n\n📝 Si deseas una observación escríbela, o elige:",
 [
    { id: "confirmar", title: "Confirmar" },
    { id: "agregar_mas", title: "Agregar mas" },
    { id: "eliminar", title: "Eliminar" }
  ]
);
return res.sendStatus(200);
    }
  } else {
    const resumen = order.items
      .map((item: any, i: number) => `* ${i + 1}. ${item.producto}${item.variante ? " - " + item.variante : ""}`)
      .join("\n");

    replyMessage =
      "No entendí cuál producto deseas retirar 😊\n\n" +
      "Respóndeme con el número:\n\n" +
      resumen;
  }

} else if (currentOrder?.step === "esperando_observacion_general") {

  const texto = text.toLowerCase();

  // 👇 AQUÍ VA LA LÓGICA DE MISMA DIRECCIÓN
  if (
    texto.includes("misma direccion") ||
    texto.includes("misma dirección") ||
    texto === "la misma" ||
    texto === "igual"
  ) {
    
   if (customer?.last_address) {
  updateOrderAddress(phone, customer.last_address);
}
  }

  if (esObservacionDireccion(text)) {
    updateOrderDireccionNotes(phone, text);
  } else {
    updateOrderGeneralNotes(phone, text);
  }
  updateOrderStep(phone, "esperando_confirmacion");
  currentOrder = getOrder(phone)!;

  const order = getOrder(phone)!;
  const totals = calculateTotal(order);

  const resumen = order.items
    .map((item: any) => {
      const observacionesTexto = item.observaciones
        ? ` (${formatObservaciones(item.observaciones)})`
        : "";

      const extrasTexto =
        item.extras && item.extras.length > 0
          ? " +" +
            item.extras
              .map((extra: any) =>
                extra.cantidad > 1
                  ? `${extra.cantidad} ${extra.nombre}`
                  : extra.nombre
              )
              .join(", +")
          : "";

      return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
    })
    .join("\n");

await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido es:\n" +
  resumen +
  buildResumenFooter(order, totals) +
  "\n\n📝 Si deseas una observación escríbela ahora, o elige una opción:",
 [
    { id: "confirmar", title: "Confirmar" },
    { id: "agregar_mas", title: "Agregar mas" },
    { id: "eliminar", title: "Eliminar" }
  ]
);
return res.sendStatus(200);
    } else if (currentOrder?.step === "post_agregar_producto") {

  // Ver menú en medio del pedido
  if (lower.includes("menu") || lower.includes("menú") || lower.includes("carta") || lower === "ver menu") {
    await sendWhatsAppMessage(phone,
      "Aquí tienes el menú completo 📋\n\nhttps://linktr.ee/qr/b0379e47-8522-4dd8-b3ed-aa1d5f4a8f8a?utm_source=qr_code\n\nCuando estés listo, elige una opción 😊"
    );
    return res.sendStatus(200);
  }

  if (lower === "confirmar" || lower === "1") {
    if (!currentOrder.nombre && !customer?.name) {
      updateOrderStep(phone, "esperando_nombre");
      replyMessage =
        "Perfecto 👍\n\nAntes de continuar, ¿cómo es tu nombre?";
      await sendWhatsAppMessage(phone, replyMessage);
      return res.sendStatus(200);
    }

    if (customer?.name && !currentOrder.nombre) {
      updateOrderName(phone, customer.name);
    }

   if (currentOrder.tipoEntrega === "domicilio" && !currentOrder.direccion) {
  if (customer?.last_address) {
    updateOrderStep(phone, "esperando_confirmacion_direccion");
    currentOrder = getOrder(phone)!;

  await sendWhatsAppButtons(phone,
  `Perfecto 👍\n\nTu dirección anterior es:\n📍 ${customer.last_address}\n\n¿Deseas enviar a esa dirección?`,
  [
    { id: "a", title: "Sí, esa misma ✅" },
    { id: "b", title: "No, cambiarla 📍" }
  ]
);
return res.sendStatus(200);
  }

  updateOrderStep(phone, "esperando_direccion");
  replyMessage =
    "Perfecto 👍\n\nEnvíame tu ubicación 📍 para mayor exactitud, o escríbeme tu dirección.";
  await sendWhatsAppMessage(phone, replyMessage);
  return res.sendStatus(200);
}

    updateOrderStep(phone, "esperando_confirmacion");
    currentOrder = getOrder(phone)!;

    const order = getOrder(phone)!;
    const totals = calculateTotal(order);

    const resumen = order.items
      .map((item: any) => {
        const observacionesTexto = item.observaciones
          ? ` (${formatObservaciones(item.observaciones)})`
          : "";

        const extrasTexto =
          item.extras && item.extras.length > 0
            ? " +" +
              item.extras
                .map((extra: any) =>
                  extra.cantidad > 1
                    ? `${extra.cantidad} ${extra.nombre}`
                    : extra.nombre
                )
                .join(", +")
            : "";

        return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
      })
      .join("\n");

   await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido es:\n" +
  resumen +
  buildResumenFooter(order, totals) +
  "\n\n📝 Si deseas una observación escríbela, o elige:",
 [
    { id: "confirmar", title: "Confirmar" },
    { id: "agregar_mas", title: "Agregar mas" },
    { id: "eliminar", title: "Eliminar" }
  ]
);
return res.sendStatus(200);
  } else if (lower === "agregar_mas" || lower === "2" || lower.includes("agregar")) {
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "¿Qué deseas agregar?\n\n" +
      "Recuerda: un producto por mensaje 😊";

  } else if (lower === "eliminar" || lower === "3") {
    updateOrderStep(phone, "retirando_productos");
    currentOrder = getOrder(phone)!;

    const resumen = currentOrder.items
      .map((item: any, index: number) =>
        `* ${index + 1}. ${item.producto}${item.variante ? " - " + item.variante : ""}`
      )
      .join("\n");

    replyMessage =
      "Perfecto 👍\n\n" +
      "¿Qué producto deseas retirar?\n\n" +
      resumen +
      "\n\nO escribe:\n* todos\n\n" +
      'Respóndeme con el número del producto o escribe "todos".';

  } else if (lower === "4") {
    updateOrderStep(phone, "esperando_observacion_general");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "Escríbeme la observación para tu pedido 😊";

} else if (parsedItems.length > 0) {
    const order = createOrUpdateOrder(phone, parsedItems);
    currentOrder = getOrder(phone)!;
    const resumen2 = order.items.map((item: any) => {
      const obsTexto = item.observaciones ? ` (${formatObservaciones(item.observaciones)})` : "";
      const extrasTexto = item.extras && item.extras.length > 0
        ? " +" + item.extras.map((e: any) => e.cantidad > 1 ? `${e.cantidad} ${e.nombre}` : e.nombre).join(", +")
        : "";
      const precioLinea = ((item.precio || 0) + (item.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * item.cantidad;
      return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${obsTexto}${extrasTexto} - $${precioLinea.toLocaleString("es-CO")}`;
    }).join("\n");
    await sendWhatsAppButtons(phone,
      "Perfecto, agregué:\n\n" + resumen2 + "\n\n📝 Si deseas una observacion escribela, o elige:",
      [
        { id: "confirmar", title: "Confirmar" },
        { id: "agregar_mas", title: "Agregar mas" },
        { id: "eliminar", title: "Eliminar" }
      ]
    );
    return res.sendStatus(200);

} else if (aiClassification) {
  // IA respondió un intent no-producto en post_agregar_producto
  if (aiClassification.intent === "pregunta") {
    await sendWhatsAppMessage(phone, aiClassification.respuesta);
    return res.sendStatus(200);
  }
  if (aiClassification.intent === "observacion" && currentOrder.items.length > 0) {
    const idx = (aiClassification.productoIndex ?? -1) >= 0
      ? aiClassification.productoIndex!
      : currentOrder.items.length - 1;
    const targetItem = currentOrder.items[idx] || currentOrder.items[currentOrder.items.length - 1];
    if (targetItem) {
      targetItem.observaciones = targetItem.observaciones
        ? `${targetItem.observaciones}, ${aiClassification.texto}`
        : aiClassification.texto;
    }
    await sendWhatsAppButtons(phone,
      `Anotado ✅ "${aiClassification.texto}"\n\n¿Algo más?`,
      [{ id: "confirmar", title: "Confirmar ✅" }, { id: "agregar_mas", title: "Agregar más ➕" }, { id: "eliminar", title: "Eliminar ➖" }]
    );
    return res.sendStatus(200);
  }
  if (aiClassification.intent === "extra" && currentOrder.items.length > 0) {
    const lastItem = currentOrder.items[currentOrder.items.length - 1];
    lastItem.extras = lastItem.extras || [];
    lastItem.extras.push({ nombre: aiClassification.nombre, precio: aiClassification.precio, cantidad: 1 });
    await sendWhatsAppButtons(phone,
      `Agregado ✅ ${aiClassification.nombre} (+$${aiClassification.precio.toLocaleString("es-CO")})\n\n¿Algo más?`,
      [{ id: "confirmar", title: "Confirmar ✅" }, { id: "agregar_mas", title: "Agregar más ➕" }, { id: "eliminar", title: "Eliminar ➖" }]
    );
    return res.sendStatus(200);
  }
  // Ambiguo o sin match — guardar como observación
  if (text.length > 3) {
    if (esObservacionDireccion(text)) {
      updateOrderDireccionNotes(phone, text);
    } else {
      updateOrderGeneralNotes(phone, text);
    }
    updateOrderStep(phone, "esperando_confirmacion");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      `Anotado ✅\n\n📝 ${text}\n\n¿Qué deseas hacer?`,
      [{ id: "confirmar", title: "Confirmar" }, { id: "agregar_mas", title: "Agregar mas" }, { id: "eliminar", title: "Eliminar" }]
    );
    return res.sendStatus(200);
  }
} else if (text.length > 3 && !["hola", "ok", "dale", "bien", "listo"].includes(lower)) {
    if (esObservacionDireccion(text)) {
      updateOrderDireccionNotes(phone, text);
    } else {
      updateOrderGeneralNotes(phone, text);
    }
    updateOrderStep(phone, "esperando_confirmacion");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      `Anotado ✅\n\n📝 ${text}\n\n¿Qué deseas hacer?`,
      [
        { id: "confirmar", title: "Confirmar" },
        { id: "agregar_mas", title: "Agregar mas" },
        { id: "eliminar", title: "Eliminar" }
      ]
    );
    return res.sendStatus(200);
} else {
  await sendWhatsAppButtons(phone,
    "¿Que deseas hacer?",
    [
      { id: "confirmar", title: "Confirmar" },
      { id: "agregar_mas", title: "Agregar mas" },
      { id: "eliminar", title: "Eliminar" }
    ]
  );
  return res.sendStatus(200);
}
      
} else if (currentOrder?.step === "esperando_pago") {
      
  if (
    lower.includes("cuanto es") ||
    lower.includes("cuánto es") ||
    lower.includes("cuanto debo") ||
    lower.includes("cuánto debo") ||
    lower.includes("total") ||
    lower.includes("precio")
  ) {
    const order = getOrder(phone)!;
    const totals = calculateTotal(order);

   await sendWhatsAppButtons(phone,
  `El total de tu pedido es: $${totals.total} 😊\n\n¿Cómo deseas pagar?`,
  [
    { id: "efectivo", title: "Efectivo 💵" },
    { id: "nequi", title: "Nequi/Daviplata 📱" },
    { id: "bancolombia", title: "Bancolombia 🏦" }
  ]
);
return res.sendStatus(200);
   } else if (
    lower.includes("datafono") ||
    lower.includes("datáfono") ||
    lower.includes("tarjeta") ||
    lower.includes("credito") ||
    lower.includes("crédito") ||
    lower.includes("debito") ||
    lower.includes("débito")
  ) {
 await sendWhatsAppButtons(phone,
  "Por ahora no tenemos pago con datáfono 😊\n\nPuedes pagar con:",
  [
    { id: "efectivo", title: "Efectivo 💵" },
    { id: "nequi", title: "Nequi/Daviplata 📱" },
    { id: "bancolombia", title: "Bancolombia 🏦" }
  ]
);
return res.sendStatus(200);

  } else if (lower.includes("efectivo")) {
    updateOrderPayment(phone, "efectivo");
    updateOrderStep(phone, "esperando_factura");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "¿Necesitas factura electrónica?",
      [
        { id: "factura_si", title: "Sí, la necesito 🧾" },
        { id: "factura_no", title: "No, gracias" }
      ]
    );
    return res.sendStatus(200);

  } else if (
    lower.includes("datafono") ||
    lower.includes("datáfono") ||
    lower.includes("tarjeta")
  ) {
   await sendWhatsAppButtons(phone,
  "Por ahora no tenemos pago con datáfono 😊\n\nPuedes pagar con:",
  [
    { id: "efectivo", title: "Efectivo 💵" },
    { id: "nequi", title: "Nequi/Daviplata 📱" },
    { id: "bancolombia", title: "Bancolombia 🏦" }
  ]
);
return res.sendStatus(200);
  } else if (lower.includes("nequi")) {
    updateOrderPayment(phone, "nequi/daviplata");
    updateOrderStep(phone, "esperando_comprobante");
    currentOrder = getOrder(phone)!;

    const orderNequi = getOrder(phone)!;
    const totalsNequi = calculateTotal(orderNequi);
    try { await handleOperationalRouting(orderNequi, totalsNequi); } catch (e) { console.error(e); }

    const nequiNum = orderNequi.sucursal === "circunvalar" ? "3205839477" : "3207218267";
    await sendWhatsAppButtons(phone,
      `Perfecto 👌\n\nEl total a pagar es: $${totalsNequi.total.toLocaleString("es-CO")}\n\nPago por Nequi/Daviplata:\n📱 ${nequiNum}\n\nCuando realices el pago envíame el comprobante 📸`,
      [{ id: "listo", title: "Listo, ya pagué ✅" }]
    );
    return res.sendStatus(200);

  } else if (lower.includes("bancolombia") || lower.includes("transferencia")) {
    updateOrderPayment(phone, "bancolombia");
    updateOrderStep(phone, "esperando_comprobante");
    currentOrder = getOrder(phone)!;

    const orderBanco = getOrder(phone)!;
    const totalsBanco = calculateTotal(orderBanco);
    try { await handleOperationalRouting(orderBanco, totalsBanco); } catch (e) { console.error(e); }

    const bancoNum = orderBanco.sucursal === "circunvalar" ? "27000004514" : "27033825108";
    replyMessage =
      "Perfecto 👌\n\n" +
      `El total a pagar es: $${totalsBanco.total.toLocaleString("es-CO")}\n\n` +
      "Transferencia Bancolombia:\n" +
      "🏦 Cuenta de ahorros\n" +
      `💳 ${bancoNum}\n\n` +
      "Cuando realices el pago envíame el comprobante 📸";

} else {
  const totalsElse = calculateTotal(getOrder(phone)!);
   await sendWhatsAppButtons(phone,
  `El total de tu pedido es $${totalsElse.total} 💰\n¿Cómo deseas pagar?`,
  [
    { id: "efectivo", title: "Efectivo 💵" },
    { id: "nequi", title: "Nequi/Daviplata 📱" },
    { id: "bancolombia", title: "Bancolombia 🏦" }
  ]
);
return res.sendStatus(200);
  }
} else if (currentOrder?.step === "esperando_factura") {
  if (lower === "factura_si" || lower.includes("factura_si")) {
    updateOrderStep(phone, "esperando_datos_factura");
    currentOrder = getOrder(phone)!;
    replyMessage = "Por favor envíame tu NIT o cédula y razón social para la factura.";
  } else {
    // factura_no o cualquier otra respuesta → confirmar pedido directamente
    updateOrderStep(phone, "confirmado");
    clearTimeout(inactivityTimers.get(phone));
    inactivityTimers.delete(phone);
    currentOrder = getOrder(phone)!;
    currentOrder.confirmedAt = new Date().toISOString();

    const orderFact = getOrder(phone)!;
    const totalsFact = calculateTotal(orderFact);

    await upsertCustomer({ phone, name: orderFact.nombre, last_address: orderFact.direccion, last_order: orderFact.items, last_order_at: new Date().toISOString(), last_sucursal: orderFact.sucursal });
    try { await handleOperationalRouting(orderFact, totalsFact); } catch (e) { console.error(e); }

    if (orderFact.sucursal === "la_villa" && orderFact.locationCoords) {
      try {
        await sendWhatsAppLocation("573151913928", orderFact.locationCoords.latitude, orderFact.locationCoords.longitude, orderFact.nombre || "Cliente");
      } catch (e) { console.error("❌ Error enviando ubicación a domiciliarios:", e); }
    }

    if (orderFact.sucursal === "la_villa") {
      await fetch("https://rural-donated-indicated-timber.trycloudflare.com/imprimir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: orderFact.nombre || customer?.name || "Cliente",
          telefono: orderFact.telefono,
          pedidoTexto: orderFact.items.map((i: any) => {
            const obs = i.observaciones ? ` (${i.observaciones})` : "";
            const extras = i.extras?.length > 0 ? " +" + i.extras.map((e: any) => e.nombre).join(", +") : "";
            return `${i.cantidad} ${i.producto}${i.variante ? " - " + i.variante : ""}${extras}${obs}`;
          }),
          subtotal: totalsFact.subtotal,
          domicilio: totalsFact.domicilio,
          total: totalsFact.total,
          direccion: orderFact.direccion || "Recoger en tienda",
          pago: orderFact.formaPago || "No definido",
          tiempoEstimado: orderFact.tipoEntrega === "domicilio" ? "50 min" : "15 min",
          horaPedido: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }),
          sucursal: "La Villa"
        })
      }).catch(err => console.error("❌ Error impresora La Villa:", err));
    }

    const resumenFact = orderFact.items.map((item: any) => {
      const obsTexto = item.observaciones ? ` (${formatObservaciones(item.observaciones)})` : "";
      const extrasTexto = item.extras?.length > 0 ? " +" + item.extras.map((e: any) => e.cantidad > 1 ? `${e.cantidad} ${e.nombre}` : e.nombre).join(", +") : "";
      return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${obsTexto}${extrasTexto}`;
    }).join("\n");

    const tiempoFact = orderFact.tipoEntrega === "domicilio" ? "50 min 🚚" : "15 min 🏪";
    if (!orderFact.nombre && customer?.name) updateOrderName(phone, customer.name);

    replyMessage =
      "🔥 Pedido confirmado\n\n" +
      "👤 Nombre: " + (orderFact.nombre || customer?.name || "Cliente") + "\n" +
      "📞 Tel: " + orderFact.telefono + "\n\n" +
      "🧾 Tu pedido:\n" + resumenFact + "\n\n" +
      "💰 Subtotal: $" + totalsFact.subtotal + "\n" +
      (orderFact.tipoEntrega === "domicilio" ? "🚚 Domicilio: $" + totalsFact.domicilio + "\n" : "") +
      "💵 Total: $" + totalsFact.total + "\n" +
      (orderFact.observacionesGenerales?.trim() ? "📝 Observación: " + orderFact.observacionesGenerales.trim() + "\n" : "") +
      (orderFact.tipoEntrega === "domicilio" ? "📍 Dirección:\n" + (orderFact.direccion || "No aplica") : "🏪 Recoger en tienda") + "\n\n" +
      "💳 Pago: Efectivo\n" +
      "⏱ Tiempo estimado: " + tiempoFact + "\n" +
      "🕐 Hora: " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }) + "\n\n" +
      "🏪 Sucursal: " + (orderFact.sucursal === "la_villa" ? "La Villa" : orderFact.sucursal === "circunvalar" ? "Av. Circunvalar" : "Por definir") + "\n" +
      "🙏 Gracias por tu pedido en LAS CREPES 🥞";
  }

} else if (currentOrder?.step === "esperando_datos_factura") {
  // Guardar los datos de factura y confirmar
  const orderDf = getOrder(phone)!;
  orderDf.factura = text;
  updateOrderStep(phone, "confirmado");
  clearTimeout(inactivityTimers.get(phone));
  inactivityTimers.delete(phone);
  currentOrder = getOrder(phone)!;
  currentOrder.confirmedAt = new Date().toISOString();

  const totalsDf = calculateTotal(orderDf);

  await upsertCustomer({ phone, name: orderDf.nombre, last_address: orderDf.direccion, last_order: orderDf.items, last_order_at: new Date().toISOString(), last_sucursal: orderDf.sucursal });
  try { await handleOperationalRouting(orderDf, totalsDf); } catch (e) { console.error(e); }

  if (orderDf.sucursal === "la_villa" && orderDf.locationCoords) {
    try {
      await sendWhatsAppLocation("573151913928", orderDf.locationCoords.latitude, orderDf.locationCoords.longitude, orderDf.nombre || "Cliente");
    } catch (e) { console.error("❌ Error enviando ubicación a domiciliarios:", e); }
  }

  if (orderDf.sucursal === "la_villa") {
    await fetch("https://towns-cheats-resulting-same.trycloudflare.com/imprimir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: orderDf.nombre || customer?.name || "Cliente",
        telefono: orderDf.telefono,
        pedidoTexto: orderDf.items.map((i: any) => {
          const obs = i.observaciones ? ` (${i.observaciones})` : "";
          const extras = i.extras?.length > 0 ? " +" + i.extras.map((e: any) => e.nombre).join(", +") : "";
          return `${i.cantidad} ${i.producto}${i.variante ? " - " + i.variante : ""}${extras}${obs}`;
        }),
        subtotal: totalsDf.subtotal,
        domicilio: totalsDf.domicilio,
        total: totalsDf.total,
        direccion: orderDf.direccion || "Recoger en tienda",
        pago: orderDf.formaPago || "No definido",
        tiempoEstimado: orderDf.tipoEntrega === "domicilio" ? "50 min" : "15 min",
        horaPedido: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }),
        sucursal: "La Villa"
      })
    }).catch(err => console.error("❌ Error impresora La Villa:", err));
  }

  const resumenDf = orderDf.items.map((item: any) => {
    const obsTexto = item.observaciones ? ` (${formatObservaciones(item.observaciones)})` : "";
    const extrasTexto = item.extras?.length > 0 ? " +" + item.extras.map((e: any) => e.cantidad > 1 ? `${e.cantidad} ${e.nombre}` : e.nombre).join(", +") : "";
    return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${obsTexto}${extrasTexto}`;
  }).join("\n");

  const tiempoDf = orderDf.tipoEntrega === "domicilio" ? "50 min 🚚" : "15 min 🏪";
  if (!orderDf.nombre && customer?.name) updateOrderName(phone, customer.name);

  replyMessage =
    "🔥 Pedido confirmado\n\n" +
    "👤 Nombre: " + (orderDf.nombre || customer?.name || "Cliente") + "\n" +
    "📞 Tel: " + orderDf.telefono + "\n\n" +
    "🧾 Tu pedido:\n" + resumenDf + "\n\n" +
    "💰 Subtotal: $" + totalsDf.subtotal + "\n" +
    (orderDf.tipoEntrega === "domicilio" ? "🚚 Domicilio: $" + totalsDf.domicilio + "\n" : "") +
    "💵 Total: $" + totalsDf.total + "\n" +
    (orderDf.observacionesGenerales?.trim() ? "📝 Observación: " + orderDf.observacionesGenerales.trim() + "\n" : "") +
    (orderDf.tipoEntrega === "domicilio" ? "📍 Dirección:\n" + (orderDf.direccion || "No aplica") : "🏪 Recoger en tienda") + "\n\n" +
    "💳 Pago: Efectivo\n" +
    "📄 Factura electrónica: " + text + "\n" +
    "⏱ Tiempo estimado: " + tiempoDf + "\n" +
    "🕐 Hora: " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }) + "\n\n" +
    "🏪 Sucursal: " + (orderDf.sucursal === "la_villa" ? "La Villa" : orderDf.sucursal === "circunvalar" ? "Av. Circunvalar" : "Por definir") + "\n" +
    "🙏 Gracias por tu pedido en LAS CREPES 🥞";

} else if (currentOrder?.step === "esperando_comprobante") {

  const imageId = messageData.image?.id;

  if (imageId) {
    // Llegó imagen — confirmar y reenviar comprobante a la sucursal
    updateOrderStep(phone, "confirmado");
    clearTimeout(inactivityTimers.get(phone));
    inactivityTimers.delete(phone);
    currentOrder = getOrder(phone)!;
    currentOrder.confirmedAt = new Date().toISOString();

    const order = getOrder(phone)!;
    const totals = calculateTotal(order);

    await upsertCustomer({
      phone: phone,
      name: order.nombre,
      last_address: order.direccion,
      last_order: order.items,
      last_order_at: new Date().toISOString(),
      last_sucursal: order.sucursal
    });

    const resumenParaSucursal =
      "📸 COMPROBANTE DE PAGO\n\n" +
      `👤 ${order.nombre || customer?.name || "Cliente"}\n` +
      `📞 ${phone}\n\n` +
      "🧾 Productos:\n" +
      order.items.map((item: any) => {
        const obsTexto = item.observaciones ? ` (${item.observaciones})` : "";
        const extrasTexto = item.extras && item.extras.length > 0
          ? " +" + item.extras.map((e: any) => e.nombre).join(", +")
          : "";
        return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${obsTexto}${extrasTexto}`;
      }).join("\n") +
      `\n\n💰 Subtotal: $${totals.subtotal}` +
      (order.tipoEntrega === "domicilio" ? `\n🚚 Domicilio: $${totals.domicilio}` : "") +
      `\n💵 Total: $${totals.total}\n` +
      `💳 Pago: ${order.formaPago}\n` +
      `🏬 Sucursal: ${order.sucursal === "la_villa" ? "La Villa" : "Av. Circunvalar"}\n` +
      (order.tipoEntrega === "domicilio" && order.direccion ? `📍 Dirección: ${order.direccion}` : "🏪 Recoger en tienda");

    const DESTINOS_COMPROBANTE = ["573207218267", "573151913928"];

    for (const destino of DESTINOS_COMPROBANTE) {
      try {
        await sendWhatsAppMessage(destino, resumenParaSucursal);
        await sendWhatsAppImageById(destino, imageId);
      } catch (e) { console.error(`❌ ERROR reenviando comprobante a ${destino}:`, e); }
    }

    if (order.sucursal === "la_villa") {
      await fetch("https://towns-cheats-resulting-same.trycloudflare.com/imprimir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: order.nombre || customer?.name || "Cliente",
          telefono: order.telefono,
          pedidoTexto: order.items.map((i: any) => {
            const obs = i.observaciones ? ` (${i.observaciones})` : "";
            const extras = i.extras?.length > 0 ? " +" + i.extras.map((e: any) => e.nombre).join(", +") : "";
            return `${i.cantidad} ${i.producto}${i.variante ? " - " + i.variante : ""}${extras}${obs}`;
          }),
          subtotal: totals.subtotal,
          domicilio: totals.domicilio,
          total: totals.total,
          direccion: order.direccion || "Recoger en tienda",
          pago: order.formaPago || "No definido",
          tiempoEstimado: order.tipoEntrega === "domicilio" ? "50 min" : "15 min",
          horaPedido: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }),
          sucursal: "La Villa"
        })
      }).catch(err => console.error("❌ Error impresora La Villa:", err));
    }

    const resumenComprobante =
      "🔥 *Tu pedido fue confirmado*\n\n" +
      "🧾 Tu pedido:\n" +
      order.items.map((item: any) => {
        const obsTexto = item.observaciones ? ` (${formatObservaciones(item.observaciones)})` : "";
        const extrasTexto = item.extras && item.extras.length > 0
          ? " +" + item.extras.map((e: any) => e.cantidad > 1 ? `${e.cantidad} ${e.nombre}` : e.nombre).join(", +")
          : "";
        return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${obsTexto}${extrasTexto}`;
      }).join("\n") +
      `\n\n💰 Subtotal: $${totals.subtotal}` +
      (order.tipoEntrega === "domicilio" ? `\n🚚 Domicilio: $${totals.domicilio}` : "") +
      `\n💵 Total: $${totals.total}` +
      (order.direccion ? `\n📍 Dirección: ${order.direccion}` : "") +
      `\n💳 Pago: ${order.formaPago}`;

    await sendWhatsAppMessage(phone, resumenComprobante);
    replyMessage = "Gracias, comprobante recibido ✅ Tu pedido está en proceso 🔥";

  } else if (lower.includes("listo") || lower.includes("ya")) {
    replyMessage = "Estamos esperando tu comprobante de pago 📸";

  } else if (
    lower.includes("cuanto es") ||
    lower.includes("cuánto es") ||
    lower.includes("cuanto debo") ||
    lower.includes("cuánto debo") ||
    lower.includes("total") ||
    lower.includes("precio")
  ) {
    const order = getOrder(phone)!;
    const totals = calculateTotal(order);
    replyMessage = `El total de tu pedido es: $${totals.total} 😊\n\nCuando realices el pago envíame el comprobante 📸`;

  } else {
    replyMessage = "Cuando realices el pago envíame el comprobante 📸";
  }

} else if (currentOrder?.step === "confirmado") {
  if (
    lower.includes("como va") ||
    lower.includes("cómo va") ||
    lower.includes("cuanto falta") ||
    lower.includes("cuánto falta") ||
    lower.includes("demora") ||
    lower.includes("ya salio") ||
    lower.includes("ya salió") ||
    lower.includes("estado")
  ) {
    replyMessage =
      "Tu pedido sigue en preparación 👨‍🍳🚚\n\n" +
      "Tiempo estimado: 40-50 min. Te avisaremos si hay alguna novedad.";
  } else if (
    lower.includes("gracias") ||
    lower.includes("ok") ||
    lower.includes("vale") ||
    lower.includes("bueno")
  ) {
    replyMessage =
      "Con gusto 😊 Tu pedido ya está en proceso. Te avisaremos cualquier novedad.";
  } else {
    const confirmedAt = currentOrder.confirmedAt ? new Date(currentOrder.confirmedAt).getTime() : 0;
    const twoHoursMs = 2 * 60 * 60 * 1000;
    if (Date.now() - confirmedAt < twoHoursMs) {
      replyMessage = "Tu pedido ya fue confirmado ✅. Si necesitas algo más escríbenos.";
    } else {
      createOrUpdateOrder(phone, []);
      updateOrderStep(phone, "esperando_menu_principal");
      currentOrder = getOrder(phone)!;
      await sendWhatsAppButtons(phone,
        "👋 Hola, Bienvenido/a a LAS CREPES! ¿Como te podemos servir?",
        [
          { id: "1", title: "Hacer un pedido 🥞" },
          { id: "2", title: "Ver menú 📋" },
          { id: "3", title: "Otros 💬" }
        ]
      );
      return res.sendStatus(200);
    }
  }
} else if (currentOrder?.step === "armando_pedido") {
  if (
    lower.includes("si") ||
    lower.includes("sí") ||
    lower.includes("ya") ||
    lower.includes("ok") ||
    lower.includes("vale") ||
    lower.includes("dale") ||
    lower.includes("de una")
  ) {
    replyMessage =
      "Perfecto 👌 ¿Qué más deseas agregar?\n\n" +
      "Puedes escribir otra crepe, bebida, topping o una observación."
  } else if (
    lower.includes("no") ||
    lower.includes("nada") ||
    lower.includes("listo") ||
    lower.includes("no mas") ||
    lower.includes("no más") ||
    lower.includes("eso es todo")
  ) {
    if (!currentOrder.items || currentOrder.items.length === 0) {
      replyMessage =
        "Aún no veo productos en tu pedido 😊\n\n" +
        "Escríbeme qué deseas pedir, por ejemplo:\n" +
        "• 1 Camarones\n" +
        "• 1 Hawaiana\n" +
        "• 1 Mediterránea de camarones";
    } else if (customer?.name) {
      updateOrderName(phone, customer.name);
      currentOrder = getOrder(phone)!;

      if (currentOrder.tipoEntrega === "domicilio") {
        if (customer?.last_address) {
          updateOrderStep(phone, "esperando_confirmacion_direccion");
          currentOrder = getOrder(phone)!;

         await sendWhatsAppButtons(phone,
  `Perfecto 👍\n\n¿Deseas usar la misma dirección de siempre?\n\n📍 ${customer.last_address}`,
  [
    { id: "a", title: "Sí, esa misma ✅" },
    { id: "b", title: "No, cambiarla 📍" }
  ]
);
return res.sendStatus(200);
        } else {
          updateOrderStep(phone, "esperando_direccion");
          currentOrder = getOrder(phone)!;
          replyMessage = "Perfecto 👍\n\nEnvíame tu ubicación 📍 para mayor exactitud, o escríbeme tu dirección.";
        }
      } else {
        updateOrderStep(phone, "esperando_confirmacion");
        currentOrder = getOrder(phone)!;

        const order = getOrder(phone)!;
        const totals = calculateTotal(order);
    

        const resumen = order.items
          .map((item: any) => {
            const observacionesTexto = item.observaciones
              ? ` (${formatObservaciones(item.observaciones)})`
              : "";

            const extrasTexto =
              item.extras && item.extras.length > 0
                ? " +" +
                  item.extras
                    .map((extra: any) =>
                      extra.cantidad > 1
                        ? `${extra.cantidad} ${extra.nombre}`
                        : extra.nombre
                    )
                    .join(", +")
                : "";

            return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
          })
          .join("\n");
      await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido es:\n" +
  resumen +
  buildResumenFooter(order, totals) +
  "\n\n📝 Si deseas una observación escríbela, o elige:",
 [
    { id: "confirmar", title: "Confirmar" },
    { id: "agregar_mas", title: "Agregar mas" },
    { id: "eliminar", title: "Eliminar" }
  ]
);
return res.sendStatus(200);
      }
    } else {
      updateOrderStep(phone, "esperando_nombre");
      currentOrder = getOrder(phone)!;
      replyMessage =
        "Perfecto 👍\n\n" +
        "Antes de continuar, ¿cómo es tu nombre?";
    }
  } else {
    replyMessage =
      "¿Deseas agregar algo más? 😊\n\n" +
      "Puedes escribir otra crepe, bebida, topping, hacer observacion, o responder SI o NO.";
  }

} else if (currentOrder?.step === "esperando_confirmacion_direccion") {
  if (lower === "a" || lower.includes("si") || lower.includes("sí") || lower.includes("esa misma")) {
  updateOrderAddress(phone, customer?.last_address || "");
  
  const order = getOrder(phone)!;
  let valorDomicilio = 4500;
  let descripcionDomicilio = "";
  try {
    const calculo = await calcularDomicilio(customer?.last_address || "", order.sucursal || "la_villa");
    valorDomicilio = calculo.valorDomicilio;
    descripcionDomicilio = calculo.descripcion;
    order.valorDomicilio = valorDomicilio;
  } catch (e) {
    console.log("Error calculando domicilio:", e);
  }

  updateOrderStep(phone, "esperando_confirmacion");
  currentOrder = getOrder(phone)!;

  const totals = calculateTotal(order, valorDomicilio);

    const resumen = order.items
      .map((item: any) => {
        const observacionesTexto = item.observaciones
          ? ` (${formatObservaciones(item.observaciones)})`
          : "";

        const extrasTexto =
          item.extras && item.extras.length > 0
            ? " +" +
              item.extras
                .map((extra: any) =>
                  extra.cantidad > 1
                    ? `${extra.cantidad} ${extra.nombre}`
                    : extra.nombre
                )
                .join(", +")
            : "";

        return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
      })
      .join("\n");

  await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido es:\n" +
  resumen +
  buildResumenFooter(order, totals, descripcionDomicilio) +
  "\n\n📝 Si deseas una observación escríbela, o elige:",
[
    { id: "confirmar", title: "Confirmar" },
    { id: "agregar_mas", title: "Agregar mas" },
    { id: "eliminar", title: "Eliminar" }
  ]
);
return res.sendStatus(200);

} else if (
    lower === "b" ||
    lower.includes("cambiar")
  ) {
    updateOrderStep(phone, "esperando_direccion");
    currentOrder = getOrder(phone)!;
    replyMessage =
      "Perfecto 👍\n\nEnvíame tu ubicación 📍 para mayor exactitud, o escríbeme tu dirección.";
  } else {
   await sendWhatsAppButtons(phone,
  `Perfecto 👍\n\n¿Deseas usar la misma dirección de siempre?\n\n📍 ${customer.last_address}`,
  [
    { id: "a", title: "Sí, esa misma ✅" },
    { id: "b", title: "No, cambiarla 📍" }
  ]
);
return res.sendStatus(200);
  
}
} else if (
  lower.includes("hola") ||
  lower.includes("buenas") ||
  lower.includes("buenos dias") ||
  lower.includes("buen día") ||
  lower.includes("buen dia") ||
  lower.includes("buenas tardes") ||
  lower.includes("buenas noches")
) {
  await sendWhatsAppButtons(phone,
    "Hola  Bienvenido a LAS CREPES \n\n¿Qué deseas hacer?",
    [
      { id: "1", title: "Hacer un pedido 🥞" },
      { id: "2", title: "Ver menú 📋" },
      { id: "3", title: "Otros 💬" }
    ]
  );
  return res.sendStatus(200);
} else {
  replyMessage =
    "Con gusto te ayudo 😊\n\n" +
    "Puedes pedirme una crepe así:\n" +
    "• 1 París\n" +
    "• 2 Hawaianas\n" +
    "• 1 Nutella y 1 Tropical\n\n" +
    "También puedo ayudarte con domicilio o recoger.";
}

if (replyMessage) {
  console.log("ENVIANDO MENSAJE A:", phone);
  await sendWhatsAppMessage(phone, replyMessage);
}
return res.sendStatus(200);
});
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  asl.getStore()?.logger.error(err);

  if (res.headersSent) return;

  res.status(500);
  res.json({ msg: 'Something went wrong' });
});

// 🌅 Job diario: aviso de bot activo a las 9:00 AM hora Colombia
cron.schedule("0 9 * * *", async () => {
  const msg = "🌅 Buenos días! El bot de Las Crepes está activo y listo para recibir pedidos hoy.";
  const destinatarios = ["573207218267", "573151913928", "573217233342"];
  for (const numero of destinatarios) {
    try {
      await sendWhatsAppMessage(numero, msg);
      console.log(`✅ Mensaje de buenos días enviado a ${numero}`);
    } catch (e) {
      console.error(`❌ Error enviando buenos días a ${numero}:`, e);
    }
  }
}, { timezone: "America/Bogota" });

return {
  requestListener: app,
  shutdown: async () => {
    // add any cleanup code here including database/redis disconnecting and background job shutdown
  },
};
};
type Store = {
    logger: pino.Logger;
    requestId: string;
};

const asl = new AsyncLocalStorage<Store>();

export function makeValidationMiddleware(
    runners: ev.ContextRunner[]
): RequestHandler {
    return async function (req: Request, res: Response, next: NextFunction) {
        await Promise.all(runners.map((runner) => runner.run(req)));

        const errors = ev.validationResult(req);
        if (!errors.isEmpty()) {
            res.status(400).json({
                errors: errors.array(),
            });
            return;
        }

        next();
    };
}
