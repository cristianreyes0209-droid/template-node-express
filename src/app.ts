import "dotenv/config";
import "./db";
import { upsertCustomer, getCustomerByPhone } from "./db";
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
import { parseOrder, normalizeText } from './parser';
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

async function calcularDomicilio(direccionCliente: string, sucursal: string): Promise<{
  distanciaKm: number;
  valorDomicilio: number;
  descripcion: string;
}> {
  const sucursales: Record<string, string> = {
    "la_villa": "Calle 83 #16a-22, Barrio La Villa, Pereira, Colombia",
    "circunvalar": "Avenida Circunvalar #8-94, Pereira, Colombia"
  };

  const origen = encodeURIComponent(sucursales[sucursal] || sucursales["la_villa"]);
  const destino = encodeURIComponent(direccionCliente + ", Pereira, Colombia");
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origen}&destinations=${destino}&mode=driving&key=${apiKey}`;

  const response = await fetch(url);
  const data = await response.json();

  console.log("GOOGLE MAPS RESPONSE:", JSON.stringify(data, null, 2));

  const elemento = data.rows?.[0]?.elements?.[0];

  if (!elemento || elemento.status !== "OK") {
    return { distanciaKm: 0, valorDomicilio: 4500, descripcion: "Domicilio base" };
  }

  const distanciaKm = elemento.distance.value / 1000;
 const MINIMO = 4500;
  const VALOR_POR_KM = 800;
  const KM_MINIMO = 3;
  let valorDomicilio = MINIMO;
  if (distanciaKm > KM_MINIMO) {
    valorDomicilio = MINIMO + Math.ceil(distanciaKm - KM_MINIMO) * VALOR_POR_KM;
  }

  valorDomicilio = Math.ceil(valorDomicilio / 500) * 500;

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
function buildResumenFooter(order: any, totals: { subtotal: number; domicilio: number; total: number }, descripcionDomicilio?: string) {
  const domicilioLinea = order.tipoEntrega === "domicilio"
    ? "\n🛵 Domicilio: $" + totals.domicilio + (descripcionDomicilio ? ` (${descripcionDomicilio})` : "")
    : "";
  const obsLinea = getObservacionGeneralTexto(order);
  const entregaLinea = order.tipoEntrega === "domicilio"
    ? "\n📍 Dirección: " + (order.direccion || "No aplica")
    : "\n🏪 Recoger en tienda";
  return "\n\nSubtotal: $" + totals.subtotal + domicilioLinea + "\nTotal: $" + totals.total + (obsLinea ? "\n" + obsLinea : "") + entregaLinea;
}
   // 🔥 AQUÍ PEGAS LA FUNCIÓN
async function handleOperationalRouting(order: any, totals: any) {
  const ahora = new Date();
  const horaTexto = ahora.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Bogota"
  });

  const resumenInterno =
    "🔥 NUEVO PEDIDO\n\n" +
    `🕐 Hora: ${horaTexto}\n` +
    `👤 ${order.nombre || "Cliente"}\n` +
    `📞 ${order.telefono}\n\n` +
    "🧾 Pedido:\n" +
    order.items.map((i: any) => `* ${i.cantidad} ${i.producto}`).join("\n") +
    `\n\n💰 Total: $${totals.total}\n` +
    `📍 ${order.direccion || "Recoger en tienda"}\n` +
    `🏬 Sucursal: ${order.sucursal || "No definida"}\n` +
    `🚚 Tipo: ${order.tipoEntrega || "No definido"}\n` +
    `💳 Pago: ${order.formaPago || "No definido"}`;

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
          await sendWhatsAppButtons(process.env.VILLA_DOMICILIOS_DESTINO, domicilioMsg, [
            { id: "aceptar", title: "Aceptar ✅" }
          ]);
          console.log("✅ MENSAJE ENVIADO A DOMICILIOS VILLA");
        } catch (error) {
          console.error("❌ ERROR ENVIANDO A DOMICILIOS VILLA:", error);
        }
      }
    }

    try {
      await sendWhatsAppMessage("573151913928", resumenInterno);
      console.log("✅ RESUMEN ENVIADO A 3151913928");
    } catch (error) {
      console.error("❌ ERROR ENVIANDO A 3151913928:", error);
    }

    console.log("🖨️ IMPRIMIR COMANDA VILLA:");
    console.log(resumenInterno);
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

  // Reiniciar timer si hay un pedido en curso (no confirmado)
  if (currentOrder && currentOrder.step !== "confirmado") {
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
    if (!isWithinBusinessHours(tipoEntrega)) {
      await sendWhatsAppMessage(phone,
        "Gracias por escribirnos 😊\n\n" +
        "En este momento estamos fuera de horario de atención.\n\n" +
        "🕐 Nuestro horario es:\n" +
        "• Domingo a jueves: 4:00pm – 10:00pm\n" +
        "• Viernes y sábado: 4:00pm – 10:30pm\n\n" +
        "¡Te esperamos pronto! 🥞"
      );
      return res.sendStatus(200);
    }
  }

  console.log("STEP ACTUAL:", currentOrder?.step);
  console.log("TIPO ENTREGA ACTUAL:", currentOrder?.tipoEntrega);
  console.log("PHONE:", phone);
  console.log("TEXT:", text);

let replyMessage = "";
const parseResult = (
  currentOrder?.step === "post_agregar_producto" ||
  currentOrder?.step === "esperando_observacion_general" ||
  currentOrder?.step === "esperando_nombre" ||
  currentOrder?.step === "esperando_direccion"
) ? { items: [], ambiguousChoice: undefined } : parseOrder(text);
const parsedItems = parseResult.items;
const lower = text.toLowerCase().trim();

if (lower === "reset") {
  clearOrder(phone);
  await sendWhatsAppMessage(phone, "Sesión reiniciada ✅");
  if (customer) {
    await sendWhatsAppButtons(phone,
      `Hola${customer.name ? ", " + customer.name : ""}. ¿Cómo te podemos servir?`,
      [
        { id: "a", title: "Lo mismo de siempre 🔄" },
        { id: "b", title: "Pedir algo nuevo 🥞" },
        { id: "3", title: "Otros 💬" }
      ]
    );
  } else {
    await sendWhatsAppButtons(phone,
      "👋 Hola, Bienvenido/a a LAS CREPES! ¿Cómo te podemos servir?",
      [
        { id: "1", title: "Hacer un pedido 🥞" },
        { id: "2", title: "Ver menu 📋" },
        { id: "3", title: "Otros 💬" }
      ]
    );
  }
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
   nombreCliente ? `Hola${nombreCliente}, que bueno tenerte de vuelta. ¿Como te podemos servir hoy?` : "Que bueno tenerte de vuelta. ¿Como te podemos servir?",
  [
    { id: "a", title: "Lo mismo de siempre" },
    { id: "b", title: "Pedir algo nuevo" },
    { id: "3", title: "Otros" }
  ]
);
return res.sendStatus(200);
  } else {
   await sendWhatsAppButtons(phone,
  "Bienvenido a LAS CREPES. ¿Como te podemos servir?",
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

if (text.includes("Vengo de https://las-crepes.ola.click")) {
  createOrUpdateOrder(phone, []);
  const order = getOrder(phone)!;
  order.holaclick_order = text;
  if (customer?.name) updateOrderName(phone, customer.name);
  updateOrderStep(phone, "esperando_sucursal_holaclick");
  await sendWhatsAppMessage(phone, "Tu pedido fue recibido ✅ Vamos a procesarlo.");
  await sendWhatsAppButtons(phone,
    "Elige la sucursal más cercana a tu destino. Esto hace tu domicilio más económico 🛵",
    [
      { id: "la_villa", title: "La Villa 🏪" },
      { id: "circunvalar", title: "Av. Circunvalar 🏪" }
    ]
  );
  return res.sendStatus(200);
}

if (!currentOrder) {
  createOrUpdateOrder(phone, []);
  updateOrderStep(phone, "esperando_menu_principal");
  currentOrder = getOrder(phone)!;
  if (customer) {
    const nombreCliente = (customer?.name && customer.name.trim() !== "") 
      ? `, ${customer.name.trim()}` 
      : "";
    const bodyMsg = nombreCliente
      ? `Hola${nombreCliente}. Que bueno tenerte de vuelta. ¿Como te podemos servir?`
      : "Que bueno tenerte de vuelta. ¿Como te podemos servir?";
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
      "👋 Hola, Bienvenido/a a LAS CREPES! Estamos aquí para asegurarnos de darte la mejor atención para que puedas realizar tu pedido sin complicaciones. ¿Como te podemos servir?",
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
          return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
        })
        .join("\n");

      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nEstoy registrando:\n\n" + resumen + "\n\n📝 Si deseas una observacion escribela, o elige:",
        [
          { id: "1", title: "Confirmar" },
          { id: "2", title: "Agregar mas" },
          { id: "3", title: "Eliminar" }
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
      updateOrderStep(phone, "post_agregar_producto");
      currentOrder = getOrder(phone)!;

      const resumen = currentOrder.items
        .map((item: any) => {
          const extrasTexto = item.extras && item.extras.length > 0
            ? " +" + item.extras.map((e: any) => e.nombre).join(", +")
            : "";
          return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${extrasTexto}`;
        })
        .join("\n");

      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nEstoy registrando:\n\n" + resumen + "\n\n📝 Si deseas una observacion escribela, o elige:",
        [
          { id: "1", title: "Confirmar" },
          { id: "2", title: "Agregar mas" },
          { id: "3", title: "Eliminar" }
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
        (customer.name?.trim() ? `Hola, ${customer.name.trim()}. ` : "") + "Qué bueno tenerte de vuelta en LAS CREPES ¿Qué deseas hacer?",
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
    "Aquí puedes ver nuestro menú completo 📋\n\nhttps://wa.me/c/573137160625\n\n¿Deseas hacer un pedido?",
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
    updateOrderStep(phone, "esperando_pago_holaclick");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "¿Cómo deseas pagar?",
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia 🏦" }
      ]
    );
    return res.sendStatus(200);
  } else if (lower === "circunvalar" || lower.includes("circunvalar")) {
    currentOrder.sucursal = "circunvalar";
    updateOrderStep(phone, "esperando_pago_holaclick");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "¿Cómo deseas pagar?",
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia 🏦" }
      ]
    );
    return res.sendStatus(200);
  } else {
    await sendWhatsAppButtons(phone,
      "Elige la sucursal más cercana a tu destino. Esto hace tu domicilio más económico 🛵",
      [
        { id: "la_villa", title: "La Villa 🏪" },
        { id: "circunvalar", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  }
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
    await sendWhatsAppButtons(phone,
      "¿Cómo deseas pagar?",
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia 🏦" }
      ]
    );
    return res.sendStatus(200);
  }

  updateOrderPayment(phone, formaPago);
  updateOrderStep(phone, "confirmado");
  clearTimeout(inactivityTimers.get(phone));
  inactivityTimers.delete(phone);
  currentOrder = getOrder(phone)!;
  currentOrder.confirmedAt = new Date().toISOString();

  const order = getOrder(phone)!;
  const holaclickResumen = order.holaclick_order || "";
  const sucursalTexto = order.sucursal === "la_villa" ? "La Villa" : "Av. Circunvalar";

  const resumenInterno =
    "🔥 PEDIDO HOLACLICK\n\n" +
    `👤 ${order.nombre || customer?.name || "Cliente"}\n` +
    `📞 ${phone}\n\n` +
    `📋 Pedido original:\n${holaclickResumen}\n\n` +
    `🏬 Sucursal: ${sucursalTexto}\n` +
    `💳 Pago: ${formaPago.charAt(0).toUpperCase() + formaPago.slice(1)}`;

  try {
    await handleOperationalRouting({ ...order, items: [] }, { subtotal: 0, domicilio: 0, total: 0 });
    // Enviar resumen completo según sucursal
    if (order.sucursal === "circunvalar" && process.env.CIRCUNVALAR_PHONE) {
      await sendWhatsAppMessage(process.env.CIRCUNVALAR_PHONE, resumenInterno);
    } else if (order.sucursal === "la_villa" && process.env.VILLA_DOMICILIOS_DESTINO) {
      await sendWhatsAppMessage(process.env.VILLA_DOMICILIOS_DESTINO, resumenInterno);
    }
  } catch (error) {
    console.error("❌ ERROR enviando pedido HolaClick:", error);
  }

  replyMessage =
    "Gracias por tu pedido 🔥 Ya está en proceso.\n\n" +
    `🏬 Sucursal: ${sucursalTexto}\n` +
    `💳 Pago: ${formaPago.charAt(0).toUpperCase() + formaPago.slice(1)}`;

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
      { id: "1", title: "Confirmar" },
      { id: "2", title: "Agregar mas" },
      { id: "3", title: "Eliminar" }
    ]
  );
  return res.sendStatus(200);
  } else if (
    lower === "b" ||
    lower.includes("domicilio")
  ) {
    updateOrderDeliveryType(phone, "domicilio");

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
    } else {
      updateOrderStep(phone, "esperando_direccion");
      currentOrder = getOrder(phone)!;

      replyMessage =
        "Perfecto 👍\n\n" +
        "¿Me compartes tu dirección por favor?";
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
  const order = createOrUpdateOrder(phone, parsedItems);
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

      return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${observacionesTexto}${extrasTexto}`;
    })
    .join("\n");

 await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nEstoy registrando:\n\n" +
  resumen +
  "\n\n📝 Si deseas una observación escríbela, o elige:",
  [
    { id: "1", title: "Confirmar ✅" },
    { id: "2", title: "Agregar más ➕" },
    { id: "3", title: "Eliminar ➖" }
  ]
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
    updateOrderName(phone, text);
    currentOrder = getOrder(phone)!;

    if (currentOrder.tipoEntrega === "domicilio") {
      updateOrderStep(phone, "esperando_direccion");
      currentOrder = getOrder(phone)!;
      replyMessage = "Perfecto 👍\n\n¿Me compartes tu dirección por favor?";
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
    { id: "1", title: "Confirmar" },
    { id: "2", title: "Agregar mas" },
    { id: "3", title: "Eliminar" }
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
  updateOrderAddress(phone, text);

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
    { id: "a", title: "Confirmar ✅" },
    { id: "b", title: "Eliminar ➖" },
    { id: "c", title: "Agregar más ➕" }
  ]
);
return res.sendStatus(200);
} else if (currentOrder?.step === "esperando_confirmacion") {
 if (
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
        replyMessage = "¿Me compartes tu direccion por favor?";
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
    { id: "1", title: "Confirmar ✅" },
    { id: "2", title: "Agregar más ➕" },
    { id: "3", title: "Eliminar ➖" }
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
    { id: "1", title: "Confirmar" },
    { id: "2", title: "Agregar mas" },
    { id: "3", title: "Eliminar" }
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

  updateOrderGeneralNotes(phone, text);
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
    { id: "1", title: "Confirmar" },
    { id: "2", title: "Agregar mas" },
    { id: "3", title: "Eliminar" }
  ]
);
return res.sendStatus(200);
    } else if (currentOrder?.step === "post_agregar_producto") {

  if (lower === "1") {
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
    "Perfecto 👍\n\n¿Me compartes tu dirección por favor?";
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
    { id: "1", title: "Confirmar" },
    { id: "2", title: "Agregar mas" },
    { id: "3", title: "Eliminar" }
  ]
);
return res.sendStatus(200);
  } else if (lower === "2") {
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "¿Qué deseas agregar?\n\n" +
      "Recuerda: un producto por mensaje 😊";

  } else if (lower === "3") {
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
      return `* ${item.cantidad} ${item.producto}${item.variante ? " - " + item.variante : ""}${obsTexto}${extrasTexto}`;
    }).join("\n");
    await sendWhatsAppButtons(phone,
      "Perfecto, agregué:\n\n" + resumen2 + "\n\n📝 Si deseas una observacion escribela, o elige:",
      [
        { id: "1", title: "Confirmar" },
        { id: "2", title: "Agregar mas" },
        { id: "3", title: "Eliminar" }
      ]
    );
    return res.sendStatus(200);

} else if (text.length > 3 && !["hola", "ok", "dale", "bien", "listo"].includes(lower)) {
    updateOrderGeneralNotes(phone, text);
    updateOrderStep(phone, "esperando_confirmacion");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      `Anotado ✅\n\n📝 ${text}\n\n¿Qué deseas hacer?`,
      [
        { id: "1", title: "Confirmar" },
        { id: "2", title: "Agregar mas" },
        { id: "3", title: "Eliminar" }
      ]
    );
    return res.sendStatus(200);
} else {
  await sendWhatsAppButtons(phone,
    "¿Que deseas hacer?",
    [
      { id: "1", title: "Confirmar" },
      { id: "2", title: "Agregar mas" },
      { id: "3", title: "Eliminar" }
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

   try {
  await handleOperationalRouting(order, totals);
} catch (error) {
  console.error("❌ ERROR GENERAL EN handleOperationalRouting:", error);
}

    const orderJSON = buildOrderJSON(order);

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

    const tiempoTexto =
      order.tipoEntrega === "domicilio"
        ? "50 min 🚚"
        : "15 min 🏪";

    if (!order.nombre && customer?.name) {
      updateOrderName(phone, customer.name);
    }

    const resumenCliente =
      "🔥 Pedido confirmado\n\n" +
      "👤 Nombre: " + (order.nombre || customer?.name || "Cliente") + "\n" +
      "📞 Tel: " + order.telefono + "\n\n" +
      "🧾 Tu pedido:\n" +
      resumen +
      "\n\n" +
      "💰 Subtotal: $" + totals.subtotal + "\n" +
      (order.tipoEntrega === "domicilio" ? "🚚 Domicilio: $" + totals.domicilio + "\n" : "") +
      "💵 Total: $" + totals.total + "\n" +
      (order.observacionesGenerales?.trim() ? "📝 Observación: " + order.observacionesGenerales.trim() + "\n" : "") +
      (order.tipoEntrega === "domicilio"
        ? "📍 Dirección:\n" + (order.direccion || "No aplica")
        : "🏪 Recoger en tienda") + "\n\n" +
      "💳 Pago: Efectivo\n" +
      "⏱ Tiempo estimado: " + tiempoTexto + "\n" +
      "🕐 Hora del pedido: " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }) + "\n\n" +
      "🏪 Sucursal: " + (order.sucursal === "la_villa" ? "La Villa" : order.sucursal === "circunvalar" ? "Av. Circunvalar" : "Por definir") + "\n" +
      "🙏 Gracias por tu pedido en LAS CREPES 🥞";

    console.log("========== ORDEN FINAL JSON ==========");
    console.log(JSON.stringify(orderJSON, null, 2));

    replyMessage = resumenCliente;

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
      `Perfecto 👌\n\nPago por Nequi/Daviplata:\n📱 ${nequiNum}\n\nCuando realices el pago envíame el comprobante 📸`,
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
      order.items.map((item: any) => `* ${item.cantidad} ${item.producto}`).join("\n") +
      `\n\n💰 Total: $${totals.total}\n` +
      `💳 Pago: ${order.formaPago}\n` +
      `🏬 Sucursal: ${order.sucursal === "la_villa" ? "La Villa" : "Av. Circunvalar"}`;

    try {
      await sendWhatsAppMessage("573207218267", resumenParaSucursal);
      await sendWhatsAppImageById("573207218267", imageId);
    } catch (e) { console.error("❌ ERROR reenviando comprobante:", e); }

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
          replyMessage = "Perfecto 👍\n\n¿Me compartes tu dirección por favor?";
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
    { id: "1", title: "Confirmar" },
    { id: "2", title: "Agregar mas" },
    { id: "3", title: "Eliminar" }
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
    { id: "1", title: "Confirmar" },
    { id: "2", title: "Agregar mas" },
    { id: "3", title: "Eliminar" }
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
      "Perfecto 👍\n\n¿Me compartes la nueva dirección por favor?";
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
