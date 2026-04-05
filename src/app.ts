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
import { parseOrder } from './parser';
import {
  setPendingClarification,
  getPendingClarification,
  clearPendingClarification,
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
  const VALOR_POR_KM = 1000;
  const KM_MINIMO = 2;

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
    ? "\n\n📝 Observaciones:\n" + order.observacionesGenerales.trim()
    : "";
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
          await sendWhatsAppMessage(process.env.VILLA_DOMICILIOS_DESTINO, domicilioMsg);
          console.log("✅ MENSAJE ENVIADO A DOMICILIOS VILLA");
        } catch (error) {
          console.error("❌ ERROR ENVIANDO A DOMICILIOS VILLA:", error);
        }
      }
    }

    console.log("🖨️ IMPRIMIR COMANDA VILLA:");
    console.log(resumenInterno);
    return;
  }

  console.warn("⚠️ SUCURSAL NO RECONOCIDA EN ROUTING:", order.sucursal);
}
// 👇 DESPUÉS sigue tu endpoint
app.post("/whatsapp", async (req: Request, res: Response) => { 
    if (!req.body.entry?.[0]?.changes?.[0]?.value?.messages) {
  return res.sendStatus(200);
}

  const message = req.body;

  console.log("============== PAYLOAD ==============");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=====================================");

  const messageData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!messageData) {
    console.log("No hay mensaje de usuario");
    return res.sendStatus(200);
  }

  const phone = messageData.from;   
  const customer = await getCustomerByPhone(phone);
  const text = messageData.text?.body 
  || messageData.interactive?.button_reply?.id 
  || messageData.interactive?.list_reply?.id 
  || "mensaje";
   

  if (!phone) {
    console.log("Evento sin telefono");
    return res.sendStatus(200);
  }

  let currentOrder = getOrder(phone);

  console.log("STEP ACTUAL:", currentOrder?.step);
  console.log("TIPO ENTREGA ACTUAL:", currentOrder?.tipoEntrega);
  console.log("PHONE:", phone);
  console.log("TEXT:", text);

let replyMessage = "";
const parseResult = parseOrder(text);
const parsedItems = parseResult.items;
const lower = text.toLowerCase().trim();

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
    lower.includes("buen día") ||
    lower.includes("buen dia") ||
    lower.includes("buenas tardes") ||
    lower.includes("buenas noches") ||
    lower.includes("quiero pedir") ||
    lower.includes("nuevo pedido")
  )
) {
  createOrUpdateOrder(phone, []);
  updateOrderStep(phone, "esperando_menu_principal");
  currentOrder = getOrder(phone)!;

  if (customer) {
   const nombreCliente = (customer?.name && customer.name.trim() !== "") 
  ? `, ${customer.name.trim()}` 
  : "";

replyMessage =
  `Hola${nombreCliente} 👋\n\n` +
  `Qué bueno tenerte de vuelta en LAS CREPES ✨\n\n` +
  `¿Deseas pedir lo mismo de siempre o quieres algo diferente? 😋\n\n` +
  `A. Lo mismo\n` +
  `B. Quiero pedir algo nuevo`;
  } else {
    replyMessage =
      "Hola 👋 Bienvenido a LAS CREPES✨\n\n" +
      "Qué alegría atenderte. Cuéntame, ¿qué deseas hacer hoy?\n\n" +
      "A. Recoger en tienda 🏪\n" +
      "B. Domicilio 🚚\n" +
      "C. Agendar pedido 📅\n" +
      "D. Hacer reserva 🍽️\n" +
      "E. PQR 📝\n" +
      "F. Otros 💬";
  }

  await sendWhatsAppMessage(phone, replyMessage);
  return res.sendStatus(200);
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

  if (parseResult.ambiguousChoice) {
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
  createOrUpdateOrder(phone, []);
  updateOrderStep(phone, "esperando_menu_principal");
  currentOrder = getOrder(phone)!;

  if (customer) {
   const nombreCliente = (customer?.name && customer.name.trim() !== "") 
  ? `, ${customer.name.trim()}` 
  : "";

replyMessage =
  `Hola${nombreCliente} 👋\n\n` +
  `Qué bueno tenerte de vuelta en LAS CREPES ✨\n\n` +
  `¿Deseas pedir lo mismo de siempre o quieres algo diferente? 😋\n\n` +
  `A. Lo mismo\n` +
  `B. Quiero pedir algo nuevo`;
  } else {
    replyMessage =
      "Hola 👋 Bienvenido a LAS CREPES✨\n\n" +
      "Qué alegría atenderte. Cuéntame, ¿qué deseas hacer hoy?\n\n" +
      "A. Recoger en tienda 🏪\n" +
      "B. Domicilio 🚚\n" +
      "C. Agendar pedido 📅\n" +
      "D. Hacer reserva 🍽️\n" +
      "E. PQR 📝\n" +
      "F. Otros 💬";
  }

  await sendWhatsAppMessage(phone, replyMessage);
  return res.sendStatus(200);
}

if (currentOrder?.step === "esperando_aclaracion_producto") {
  const opciones = currentOrder.aclaracionPendiente?.opciones || [];

const numSeleccion = parseInt(lower) - 1;
if (!isNaN(numSeleccion) && numSeleccion >= 0 && numSeleccion < opciones.length) {
  const seleccion = opciones[numSeleccion];
    const allProducts = menu.categorias.flatMap((c: any) => c.productos);
    const product = allProducts.find((p: any) => p.id === seleccion.productoId);

    if (product) {
      createOrUpdateOrder(phone, [
        {
          producto: product.nombre,
          cantidad: 1,
          precio: product.precio,
          extras: []
        }
      ]);

      clearPendingClarification(phone);
      updateOrderStep(phone, "armando_pedido");
      currentOrder = getOrder(phone)!;

      const resumen = currentOrder.items
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

  updateOrderStep(phone, "post_agregar_producto");

replyMessage =
  "Perfecto 👌\n\n" +
  "Estoy registrando:\n\n" +
  resumen +
  "\n\n¿Qué deseas hacer ahora?\n\n" +
  "1. Confirmar pedido ✅\n" +
  "2. Agregar más productos ➕\n" +
  "3. Eliminar productos ➖\n" +
  "4. Dejar observación 📝";
    } else {
      replyMessage = "No pude encontrar esa opción. Inténtalo de nuevo 😊";
    }
 } else {
  replyMessage = `Por favor respóndeme con un número entre 1 y ${opciones.length} 😊`;
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

  updateOrderStep(phone, "esperando_tipo_entrega_repetido");
  currentOrder = getOrder(phone)!;

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

  const observacionGeneralTexto = getObservacionGeneralTexto(order);

  replyMessage =
    "🔥 Perfecto, estoy repitiendo tu último pedido\n\n" +
    "Tu pedido es:\n" +
    resumen +
    observacionGeneralTexto +
    "\n\n¿Cómo deseas recibirlo hoy?\n\n" +
    "A. Recoger en tienda 🏪\n" +
    "B. Domicilio 🚚";
      } else {
        replyMessage =
          "No encontré un pedido anterior 😊\n\n" +
          "Cuéntame qué deseas pedir.";
      }

    } else if (
      lower === "b" ||
      lower.includes("nuevo") ||
      lower.includes("diferente") ||
      lower.includes("otra cosa")
    ) {

      updateOrderStep(phone, "esperando_menu_nuevo");
      currentOrder = getOrder(phone)!;

      replyMessage =
        "Perfecto 👌\n\n" +
        "¿Qué deseas hacer hoy?\n\n" +
        "A. Recoger en tienda 🏪\n" +
        "B. Domicilio 🚚\n" +
        "C. Agendar pedido 📅\n" +
        "D. Hacer reserva 🍽️\n" +
        "E. PQR 📝\n" +
        "F. Otros 💬";

    } else {

      replyMessage =
        `Hola ${customer.name || ""} 👋\n\n` +
        `Qué bueno tenerte de vuelta en LAS CREPES ✨\n\n` +
        `¿Deseas pedir lo mismo de siempre o quieres algo diferente? 😋\n\n` +
        `A. Lo mismo\n` +
        `B. Quiero pedir algo nuevo`;
    }

} else if (
    lower === "a" ||
    lower.includes("domicilio") ||
    lower.includes("enviar") ||
    lower.includes("envio") ||
    lower.includes("envío")
  ) {
    currentOrder.canal = "domicilio";
    updateOrderDeliveryType(phone, "domicilio");
    updateOrderStep(phone, "esperando_sucursal");
    currentOrder = getOrder(phone)!;

    await sendWhatsAppButtons(phone,
      "Perfecto 👌\n\n¿Para cuál sucursal es tu pedido?",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  } else if (
    lower === "b" ||
    lower.includes("domicilio") ||
    lower.includes("enviar") ||
    lower.includes("envio") ||
    lower.includes("envío")
  ) {
    currentOrder.canal = "domicilio";
    updateOrderDeliveryType(phone, "domicilio");
    updateOrderStep(phone, "esperando_sucursal");
    currentOrder = getOrder(phone)!;

    await sendWhatsAppButtons(phone,
      "Perfecto 👌\n\n¿Para cuál sucursal es tu pedido?",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  } else if (
    lower === "c" ||
    lower.includes("agendar") ||
    lower.includes("programar") ||
    lower.includes("pedido programado")
  ) {
    replyMessage =
      "Perfecto 👌\n\n" +
      "Muy pronto podrás agendar pedidos por este medio.\n\n" +
      "Por ahora puedo ayudarte con pedidos inmediatos para recoger o domicilio.";

  } else if (
    lower === "d" ||
    lower.includes("reserva") ||
    lower.includes("reservar") ||
    lower.includes("mesa")
  ) {
    replyMessage =
      "Perfecto 👌\n\n" +
      "Muy pronto podrás hacer reservas por este medio.\n\n" +
      "Por ahora, si deseas, puedo ayudarte con un pedido para recoger o domicilio.";

  } else if (
    lower === "e" ||
    lower.includes("pqr") ||
    lower.includes("queja") ||
    lower.includes("reclamo") ||
    lower.includes("peticion") ||
    lower.includes("petición") ||
    lower.includes("sugerencia")
  ) {
    replyMessage =
      "Claro 😊\n\n" +
      "Por favor escríbeme tu solicitud, queja, reclamo o sugerencia, y te ayudaremos a gestionarla.";

  } else if (
    lower === "f" ||
    lower.includes("otros") ||
    lower.includes("otra cosa") ||
    lower.includes("ayuda")
  ) {
    replyMessage =
      "Con gusto 😊\n\n" +
      "Cuéntame en qué puedo ayudarte.";

} else {
    replyMessage =
      "Hola 👋 Bienvenido a LAS CREPES ✨\n\n" +
      "Qué alegría atenderte 😊\n\n" +
      "Elige una de estas opciones para continuar:\n\n" +
      "A. Recoger en tienda 🏪\n" +
      "B. Domicilio 🚚\n" +
      "C. Agendar pedido 📅\n" +
      "D. Hacer reserva 🍽️\n" +
      "E. PQR 📝\n" +
      "F. Otros 💬";
  }

} else if (currentOrder?.step === "esperando_menu_nuevo") {
  if (
    lower === "a" ||
    lower.includes("recoger") ||
    lower.includes("tienda")
  ) {
    currentOrder.canal = "recoger";
    updateOrderDeliveryType(phone, "recoger");
    updateOrderStep(phone, "esperando_sucursal");
    currentOrder = getOrder(phone)!;

     await sendWhatsAppButtons(phone,
      "Perfecto 👌\n\n¿Para cuál sucursal es tu pedido?",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  } else if (
    lower === "b" ||
    lower.includes("domicilio") ||
    lower.includes("enviar") ||
    lower.includes("envio") ||
    lower.includes("envío")
  ) {
    currentOrder.canal = "domicilio";
    updateOrderDeliveryType(phone, "domicilio");
    updateOrderStep(phone, "esperando_sucursal");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "Perfecto 👌\n\n¿Para cuál sucursal es tu pedido?",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  } else if (
    lower === "c" ||
    lower.includes("agendar") ||
    lower.includes("programar") ||
    lower.includes("pedido programado")
  ) {
    replyMessage =
      "Perfecto 👌\n\n" +
      "Muy pronto podrás agendar pedidos por este medio.\n\n" +
      "Por ahora puedo ayudarte con pedidos inmediatos para recoger o domicilio.";

  } else if (
    lower === "d" ||
    lower.includes("reserva") ||
    lower.includes("reservar") ||
    lower.includes("mesa")
  ) {
    replyMessage =
      "Perfecto 👌\n\n" +
      "Muy pronto podrás hacer reservas por este medio.\n\n" +
      "Por ahora, si deseas, puedo ayudarte con un pedido para recoger o domicilio.";

  } else if (
    lower === "e" ||
    lower.includes("pqr") ||
    lower.includes("queja") ||
    lower.includes("reclamo") ||
    lower.includes("peticion") ||
    lower.includes("petición") ||
    lower.includes("sugerencia")
  ) {
    replyMessage =
      "Claro 😊\n\n" +
      "Por favor escríbeme tu solicitud, queja, reclamo o sugerencia, y te ayudaremos a gestionarla.";

  } else if (
    lower === "f" ||
    lower.includes("otros") ||
    lower.includes("otra cosa") ||
    lower.includes("ayuda")
  ) {
    replyMessage =
      "Con gusto 😊\n\n" +
      "Cuéntame en qué puedo ayudarte.";

  } else {
    replyMessage =
      "Hola 👋 Bienvenido a LAS CREPES ✨\n\n" +
      "Qué alegría atenderte 😊\n\n" +
      "Elige una de estas opciones para continuar:\n\n" +
      "A. Recoger en tienda 🏪\n" +
      "B. Domicilio 🚚\n" +
      "C. Agendar pedido 📅\n" +
      "D. Hacer reserva 🍽️\n" +
      "E. PQR 📝\n" +
      "F. Otros 💬";
  }
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

    const observacionGeneralTexto = getObservacionGeneralTexto(order);

    replyMessage =
      "Perfecto 👌\n\n" +
      "Tu pedido es:\n" +
      resumen +
      observacionGeneralTexto +
      "\n\nSubtotal: $" + totals.subtotal +
      "\nDomicilio: $" + totals.domicilio +
      "\nTotal: $" + totals.total +
      "\n📍 Dirección: No aplica" +
      "\n\n¿Qué deseas hacer?\n\n" +
      "A. Confirmar pedido ✅\n" +
      "B. Eliminar productos ➖\n" +
      "C. Agregar más productos ➕\n" +
      "D. Agregar observación 📝";

  } else if (
    lower === "b" ||
    lower.includes("domicilio")
  ) {
    updateOrderDeliveryType(phone, "domicilio");

    if (customer?.last_address) {
      updateOrderStep(phone, "esperando_confirmacion_direccion");
      currentOrder = getOrder(phone)!;

      replyMessage =
        "Perfecto 👍\n\n" +
        "¿Deseas usar la misma dirección?\n\n" +
        `📍 ${customer.last_address}\n\n` +
        "A. Sí, esa misma\n" +
        "B. No, quiero cambiarla";
    } else {
      updateOrderStep(phone, "esperando_direccion");
      currentOrder = getOrder(phone)!;

      replyMessage =
        "Perfecto 👍\n\n" +
        "¿Me compartes tu dirección por favor?";
    }

  } else {
    replyMessage =
      "¿Cómo deseas recibirlo hoy?\n\n" +
      "A. Recoger en tienda 🏪\n" +
      "B. Domicilio 🚚";
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
      "Perfecto 👌\n\n¿Para cuál sucursal es tu pedido?",
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

  replyMessage =
    "Perfecto 👌\n\n" +
    "Estoy registrando:\n\n" +
    resumen +
    "\n\n¿Qué deseas hacer ahora?\n\n" +
    "1. Confirmar pedido ✅\n" +
    "2. Agregar más productos ➕\n" +
    "3. Eliminar productos ➖\n" +
    "4. Dejar observación 📝";
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

// 🔥 ESTA LÍNEA TE FALTABA
const observacionGeneralTexto = getObservacionGeneralTexto(order);

replyMessage =
  "Perfecto 👌\n\n" +
  "Tu pedido es:\n" +
  resumen +
  observacionGeneralTexto +
  "\n\nSubtotal: $" + totals.subtotal +
  "\nDomicilio: $" + totals.domicilio +
  "\nTotal: $" + totals.total +
  "\n📍 Dirección: " + (order.direccion || "No aplica") +
  "\n\n¿Qué deseas hacer?\n\n" +
  "A. Confirmar pedido ✅\n" +
  "B. Retirar productos ➖\n" +
  "C. Agregar más productos ➕";
    }
  }

} else if (currentOrder?.step === "esperando_tipo_entrega") {
  if (currentOrder?.tipoEntrega === "domicilio") {
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
      const observacionGeneralTexto = getObservacionGeneralTexto(order);

 replyMessage =
  "Perfecto 👌\n\n" +
 "Tu pedido es:\n" + 
  resumen +
  observacionGeneralTexto +
  "\n\nSubtotal: $" + totals.subtotal +
  "\nDomicilio: $" + totals.domicilio +
  "\nTotal: $" + totals.total +
  "\n📍 Dirección: " + (order.direccion || "No aplica") +
  "\n\n¿Qué deseas hacer?\n\n" +
  "A. Confirmar pedido ✅\n" +
  "B. Retirar productos ➖\n" +
  "C. Agregar más productos ➕";
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
 const observacionGeneralTexto = getObservacionGeneralTexto(order);
  updateOrderStep(phone, "esperando_confirmacion");
  currentOrder = getOrder(phone)!;

 replyMessage =
  "Perfecto 👌\n\n" +
 "Tu pedido es:\n" +
   resumen +
   observacionGeneralTexto +
  "\n\nSubtotal: $" + totals.subtotal +
  "\n🛵 Domicilio: $" + totals.domicilio + (descripcionDomicilio ? ` (${descripcionDomicilio})` : "") +
  "\nTotal: $" + totals.total +
  "\n📍 Dirección: " + (order.direccion || "No aplica") +
  "\n\n¿Qué deseas hacer?\n\n" +
  "A. Confirmar pedido ✅\n" +
  "B. Retirar productos ➖\n" +
  "C. Agregar más productos ➕";

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
    updateOrderStep(phone, "esperando_pago");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n¿Cómo deseas pagar?\n" +
      "• Efectivo\n" +
      "• Nequi\n" +
      "• Daviplata\n" +
      "• Bancolombia";

  } else if (
    lower === "b" ||
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
    replyMessage =
      "Respóndeme por favor:\n\n" +
      "A. Confirmar pedido ✅\n" +
      "B. Eliminar productos ➖\n" +
      "C. Agregar más productos ➕\n" +
      "D. Agregar observación 📝";
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
 const observacionGeneralTexto = getObservacionGeneralTexto(order);
      updateOrderStep(phone, "esperando_confirmacion");
      currentOrder = getOrder(phone)!;
 
      replyMessage =
        "Perfecto 👌\n\n" +
        "Tu pedido actualizado es:\n" +
        resumen +
        "\n\nSubtotal: $" + totals.subtotal +
        "\nDomicilio: $" + totals.domicilio +
        "\nTotal: $" + totals.total +
        "\n📍 Dirección: " + (order.direccion || "No aplica") +
        "\n\n¿Qué deseas hacer?\n\n" +
        "A. Confirmar pedido ✅\n" +
        "B. Eliminar productos ➖\n" +
        "C. Agregar más productos ➕";
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

  const observacionGeneralTexto = getObservacionGeneralTexto(order);

  replyMessage =
    "Perfecto 👌\n\n" +
    "Tu pedido es:\n" +
    resumen +
    observacionGeneralTexto +
    "\n\nSubtotal: $" + totals.subtotal +
    "\nDomicilio: $" + totals.domicilio +
    "\nTotal: $" + totals.total +
    "\n📍 Dirección: " + (order.direccion || "No aplica") +
    "\n\n¿Qué deseas hacer?\n\n" +
    "A. Confirmar pedido ✅\n" +
    "B. Eliminar productos ➖\n" +
    "C. Agregar más productos ➕\n" +
    "D. Agregar observación 📝";

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

    replyMessage =
      "Perfecto 👍\n\n" +
      "Tu dirección anterior es:\n" +
      `📍 ${customer.last_address}\n\n` +
      "¿Qué deseas hacer?\n\n" +
      "A. Sí, enviar a esa misma dirección\n" +
      "B. No, quiero cambiarla";

    await sendWhatsAppMessage(phone, replyMessage);
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

    const observacionGeneralTexto = getObservacionGeneralTexto(order);

    replyMessage =
      "Perfecto 👌\n\n" +
      "Tu pedido es:\n" +
      resumen +
      observacionGeneralTexto +
      "\n\nSubtotal: $" + totals.subtotal +
      "\nDomicilio: $" + totals.domicilio +
      "\nTotal: $" + totals.total +
      "\n📍 Dirección: " + (order.direccion || "No aplica") +
      "\n\n¿Qué deseas hacer?\n\n" +
      "A. Confirmar pedido ✅\n" +
      "B. Eliminar productos ➖\n" +
      "C. Agregar más productos ➕\n" +
      "D. Agregar observación 📝";

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

  } else {
    replyMessage =
      "Respóndeme con una opción:\n\n" +
      "1. Confirmar pedido\n" +
      "2. Agregar más productos\n" +
      "3. Eliminar productos\n" +
      "4. Observación";
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

    replyMessage =
      `El total de tu pedido es: $${totals.total} 😊\n\n` +
      "¿Cómo deseas pagar?\n" +
      "• Efectivo\n" +
      "• Nequi\n" +
      "• Daviplata\n" +
      "• Bancolombia";
   } else if (
    lower.includes("datafono") ||
    lower.includes("datáfono") ||
    lower.includes("tarjeta") ||
    lower.includes("credito") ||
    lower.includes("crédito") ||
    lower.includes("debito") ||
    lower.includes("débito")
  ) {
    replyMessage =
      "Por ahora no tenemos pago con datáfono 😊\n\n" +
      "Puedes pagar con:\n" +
      "• Efectivo\n" +
      "• Nequi\n" +
      "• Daviplata\n" +
      "• Bancolombia";   

  } else if (lower.includes("efectivo")) {
    updateOrderPayment(phone, "efectivo");
    updateOrderStep(phone, "confirmado");
    currentOrder = getOrder(phone)!;

    const order = getOrder(phone)!;
    const totals = calculateTotal(order);

    await upsertCustomer({
      phone: phone,
      name: order.nombre,
      last_address: order.direccion,
      last_order: order.items,
      last_order_at: new Date().toISOString()
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

    const observacionGeneralTexto = getObservacionGeneralTexto(order);

    const tiempoTexto =
      order.tipoEntrega === "domicilio"
        ? "50 min 🚚"
        : "15 min 🏪";

    const resumenCliente =
      "🔥 Pedido confirmado\n\n" +
      "👤 Nombre: " + (order.nombre || customer?.name || "Cliente") + "\n" +
      "📞 Tel: " + order.telefono + "\n\n" +
      "🧾 Tu pedido:\n" +
      resumen +
      observacionGeneralTexto +
      "\n\n" +
      "💰 Subtotal: $" + totals.subtotal + "\n" +
      "🚚 Domicilio: $" + totals.domicilio + "\n" +
      "💵 Total: $" + totals.total + "\n\n" +
      "📍 Dirección:\n" + (order.direccion || "No aplica") + "\n\n" +
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
    replyMessage =
      "Por ahora no tenemos pago con datáfono 😊\n\n" +
      "Puedes pagar con:\n" +
      "• Efectivo\n" +
      "• Nequi\n" +
      "• Daviplata\n" +
      "• Bancolombia";

  } else if (lower.includes("nequi")) {
    updateOrderPayment(phone, "nequi");
    updateOrderStep(phone, "esperando_comprobante");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "Pago por Nequi:\n" +
      "📱 3207218267\n\n" +
      "Cuando realices el pago, envíame el comprobante o escribe 'listo'.";

  } else if (lower.includes("daviplata")) {
    updateOrderPayment(phone, "daviplata");
    updateOrderStep(phone, "esperando_comprobante");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "Pago por Daviplata:\n" +
      "📱 3207218267\n\n" +
      "Cuando realices el pago, envíame el comprobante o escribe 'listo'.";

  } else if (lower.includes("bancolombia") || lower.includes("transferencia")) {
    updateOrderPayment(phone, "bancolombia");
    updateOrderStep(phone, "esperando_comprobante");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "Transferencia Bancolombia:\n" +
      "🏦 Cuenta de ahorros\n" +
      "💳 27033825108\n\n" +
      "Cuando realices el pago, envíame el comprobante o escribe 'listo'.";

  } else {
    replyMessage =
      "¿Cómo deseas pagar?\n" +
      "• Efectivo\n" +
      "• Nequi\n" +
      "• Daviplata\n" +
      "• Bancolombia";
  
}
} else if (currentOrder?.step === "esperando_comprobante") {

  // 🔥 RESPONDER TOTAL AQUÍ TAMBIÉN
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

    replyMessage =
      `El total de tu pedido es: $${totals.total} 😊\n\n` +
      "Cuando realices el pago, envíame el comprobante o escribe 'listo'.";

  } else if (lower.includes("listo") || lower.includes("ya")) {

    updateOrderStep(phone, "confirmado");
    currentOrder = getOrder(phone)!;

    const order = getOrder(phone)!;
    const totals = calculateTotal(order);

    await upsertCustomer({
      phone: phone,
      name: order.nombre,
      last_address: order.direccion,
      last_order: order.items,
      last_order_at: new Date().toISOString()
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

    // 🔥 INCLUIR OBSERVACIONES GENERALES
    const observacionGeneralTexto = getObservacionGeneralTexto(order);

    const tiempoTexto =
      order.tipoEntrega === "domicilio"
        ? "50 min 🚚"
        : "15 min 🏪";

    replyMessage =
      "🔥 Pedido confirmado\n\n" +
      "👤 Nombre: " + (order.nombre || customer?.name || "Cliente") + "\n" +
      "📞 Tel: " + order.telefono + "\n\n" +
      "🧾 Tu pedido:\n" +
      resumen +
      observacionGeneralTexto +
      "\n\n" +
      "💰 Subtotal: $" + totals.subtotal + "\n" +
      "🚚 Domicilio: $" + totals.domicilio + "\n" +
      "💵 Total: $" + totals.total + "\n\n" +
      "📍 Dirección:\n" + (order.direccion || "No aplica") + "\n\n" +
      "💳 Pago: " + (order.formaPago || "No definido") + "\n" +
      "⏱ Tiempo estimado: " + tiempoTexto + "\n" +
      "🕐 Hora del pedido: " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }) + "\n\n" +
      "🏪 Sucursal: " + (order.sucursal === "la_villa" ? "La Villa" : order.sucursal === "circunvalar" ? "Av. Circunvalar" : "Por definir") + "\n" +
      "🙏 Gracias por tu pedido en LAS CREPES 🥞";

    console.log("========== ORDEN FINAL JSON ==========");
    console.log(JSON.stringify(orderJSON, null, 2));

  } else {
    replyMessage =
      "Cuando realices el pago, envíame el comprobante o escribe 'listo'.";
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
    replyMessage =
      "Tu pedido fue confirmado ✅\n\n" +
      "Si deseas, puedes preguntarme cómo va tu pedido.";
 

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

          replyMessage =
            `Perfecto 👍\n\n¿Deseas usar la misma dirección de siempre?\n\n` +
            `📍 ${customer.last_address}\n\n` +
            `A. Sí, esa misma\n` +
            `B. No, quiero cambiarla`;
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
 const observacionGeneralTexto = getObservacionGeneralTexto(order);
        replyMessage =
          "Perfecto 👌\n\n" +
         "Tu pedido es:\n" +
         resumen +
         observacionGeneralTexto +
          "\n\nSubtotal: $" + totals.subtotal +
          "\nTotal: $" + totals.total +
          "\n\n¿Qué deseas hacer?\n\n" +
          "A. Confirmar pedido ✅\n" +
          "B. Eliminar Productos \n" +
          "C. Agregar más productos ➕";
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

} else if (lower === "a" || lower.includes("si") || lower.includes("sí") || lower.includes("esa misma")) {
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

    const observacionGeneralTexto = getObservacionGeneralTexto(order);

    replyMessage =
      "Perfecto 👌\n\n" +
      "Tu pedido es:\n" +
      resumen +
      observacionGeneralTexto +
      "\n\nSubtotal: $" + totals.subtotal +
      "\n🛵 Domicilio: $" + totals.domicilio + (descripcionDomicilio ? ` (${descripcionDomicilio})` : "") +
      "\nTotal: $" + totals.total +
      "\n📍 Dirección: " + (order.direccion || "No aplica") +
      "\n\n¿Qué deseas hacer?\n\n" +
      "A. Confirmar pedido ✅\n" +
      "B. Eliminar productos ➖\n" +
      "C. Agregar más productos ➕\n" +
      "D. Agregar observación 📝";

  } else if (
    lower === "b" ||
    lower.includes("cambiar")
  ) {
    updateOrderStep(phone, "esperando_direccion");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👍\n\n¿Me compartes la nueva dirección por favor?";
  } else {
    replyMessage =
      "Respóndeme por favor:\n\n" +
      "A. Sí, enviar a esa misma dirección\n" +
      "B. No, quiero cambiarla";
  
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
  replyMessage =
    "Hola 👋 Qué alegría atenderte en Las Crepes de París 🥞\n\n" +
    "Puedes hacer tu pedido aquí:\n" +
    "https://las-crepes.ola.click/products?utm_source=Chatbot&utm_campaign=place_an_order\n\n" +
    "O si prefieres, escríbeme qué deseas pedir y yo te ayudo por aquí 😊";

} else {
  replyMessage =
    "Con gusto te ayudo 😊\n\n" +
    "Puedes pedirme una crepe así:\n" +
    "• 1 París\n" +
    "• 2 Hawaianas\n" +
    "• 1 Nutella y 1 Tropical\n\n" +
    "También puedo ayudarte con domicilio o recoger.";
}

console.log("ENVIANDO MENSAJE A:", phone);
 await sendWhatsAppMessage(phone, replyMessage);
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
