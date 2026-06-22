import "dotenv/config";
import "./db";
import cron from "node-cron";
import { upsertCustomer, getCustomerByPhone, setTestMode, getNextOrderNumber, getNextOrderNumberForDay, saveMessage, getConversaciones, getConversacion, savePedido, updatePedidoEstado, getPedidoById, getPedidosActivos, getPedidosArchivados, getPedidosUltimas24h } from "./db";
import path from "path";
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
import { parseOrder, parseWithAI, classifyWithAI, normalizeText, isQuestion } from './parser';
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
  saveMessage(phone, "bot", message).catch(() => {});
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
  saveMessage(phone, "bot", safeBody).catch(() => {});
}
function isWithinBusinessHours(_tipoEntrega: "domicilio" | "recoger"): boolean {
  const bogotaStr = new Date().toLocaleString("en-US", { timeZone: "America/Bogota" });
  const bogotaDate = new Date(bogotaStr);
  const totalMinutes = bogotaDate.getHours() * 60 + bogotaDate.getMinutes();
  const dayOfWeek = bogotaDate.getDay(); // 0=domingo, 6=sábado
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const open = isWeekend ? 12 * 60 : 15 * 60; // 12m fines de semana, 3pm días de semana
  const close = 22 * 60 + 15; // 10:15 PM todos los días
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

async function calcularDomicilio(direccionCliente: string, sucursal: string, subtotalPedido?: number): Promise<{
  distanciaKm: number;
  valorDomicilio: number;
  descripcion: string;
}> {
  const sucursales: Record<string, string> = {
    "la_villa": "Calle 83 #16a-22, Pereira, Risaralda, Colombia",
    "circunvalar": "Avenida Circunvalar #8-94, Pereira, Risaralda, Colombia"
  };

  const origenDecodificado = sucursales[sucursal] || sucursales["la_villa"];
  const origen = encodeURIComponent(origenDecodificado);
  const isCoords = /^-?\d+\.?\d*,-?\d+\.?\d*$/.test(direccionCliente.trim());
  const destinoDecodificado = isCoords ? direccionCliente.trim() : direccionCliente + ", Pereira, Colombia";
  const destino = encodeURIComponent(destinoDecodificado);
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origen}&destinations=${destino}&mode=driving&key=${apiKey}`;

  const response = await fetch(url);
  const data = await response.json();

  console.log("=== CÁLCULO DOMICILIO ===");
  console.log("SUCURSAL:", sucursal);
  console.log("ORIGEN:", origenDecodificado);
  console.log("DESTINO:", direccionCliente);
  console.log("GOOGLE MAPS KEY:", apiKey ? "PRESENTE" : "AUSENTE");
  console.log("RESPUESTA GOOGLE:", JSON.stringify(data));

  const elemento = data.rows?.[0]?.elements?.[0];

  if (!elemento || elemento.status !== "OK") {
    console.log("📍 DOMICILIO - Sin resultado OK, usando base $4500");
    console.log("========================");
    return { distanciaKm: 0, valorDomicilio: 4500, descripcion: "Domicilio base" };
  }

  const distanciaMetros = elemento.distance.value;
  const distanciaKm = distanciaMetros / 1000;
  const MINIMO = 4500;
  const VALOR_POR_KM = 500;
  const KM_MINIMO = 2;
  let valorDomicilio = MINIMO;
  if (distanciaKm > KM_MINIMO) {
    valorDomicilio = MINIMO + Math.ceil(distanciaKm - KM_MINIMO) * VALOR_POR_KM;
  }

  valorDomicilio = Math.ceil(valorDomicilio / 500) * 500;

  if (distanciaKm < 1 || valorDomicilio < 4500) {
    valorDomicilio = 4500;
  }

  // Domicilio gratis en pedidos >= $100.000
  if (subtotalPedido && subtotalPedido >= 100000) {
    valorDomicilio = 0;
  }

  const distKmRedondeado = Math.round(distanciaKm * 10) / 10;
  const descripcion = valorDomicilio === 0
    ? `${distKmRedondeado}km → 🎉 Domicilio gratis`
    : `${distKmRedondeado}km → $${valorDomicilio.toLocaleString("es-CO")}`;

  console.log("DISTANCIA KM:", distanciaKm);
  console.log("VALOR DOMICILIO:", valorDomicilio);
  console.log("========================");

  return { distanciaKm: distKmRedondeado, valorDomicilio, descripcion };
}

const inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
const phoneProcessing  = new Set<string>();
const processedMsgIds  = new Map<string, number>(); // messageId → timestamp ms

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
    app.use(express.static(path.join(__dirname, '../public')));

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
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "crepes_token";

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

const CREBOT_SUFFIX = "\n\n🎉 Si tu pedido supera los $100.000 el domicilio es *gratis*.\n\nSi necesitas contactarnos:\n📞 La Villa: 606 341 3020 | Circunvalar: 606 345 0257";

const MSG_BIENVENIDA_NUEVO =
  "👋 ¡Hola! Bienvenido/a a LAS CREPES 🥞\n\n" +
  "Estoy aquí para ayudarte paso a paso en tu elección y que tu experiencia ordenando y disfrutando de nuestras deliciosas crepes sea fácil y fluida.\n\n" +
  "¡Tú decides, yo te guío! ¡Comencemos! 😊";

const MSG_BIENVENIDA_RECURRENTE = (nombre?: string) =>
  nombre
    ? `👋 ¡Hola, ${nombre}! ¡Qué bueno tenerte de vuelta en LAS CREPES! 🥞\n\n` +
      "Estoy aquí para ayudarte paso a paso en tu elección y que tu experiencia ordenando y disfrutando de nuestras deliciosas crepes sea fácil y fluida.\n\n" +
      "¡Tú decides, yo te guío! ¡Comencemos! 😊"
    : "👋 ¡Qué bueno tenerte de vuelta en LAS CREPES! 🥞\n\n" +
      "Estoy aquí para ayudarte paso a paso en tu elección y que tu experiencia ordenando y disfrutando de nuestras deliciosas crepes sea fácil y fluida.\n\n" +
      "¡Tú decides, yo te guío! ¡Comencemos! 😊";

    function formatObservaciones(obs?: string) {
  if (!obs) return "";

  return obs
    .split(",")
    .map(o => o.trim())
    .join(" • ");
}
function formatLineaItem(item: any, withPrice = false): string {
  const extrasTexto = item.extras && item.extras.length > 0
    ? " +" + item.extras.map((e: any) => e.cantidad > 1 ? `${e.cantidad} ${e.nombre}` : e.nombre).join(", +")
    : "";
  const precioLinea = ((item.precio || 0) + (item.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * item.cantidad;
  const precioTexto = withPrice ? ` - $${precioLinea.toLocaleString("es-CO")}` : "";
  const linea = `* ${item.producto}${item.variante ? " - " + item.variante : ""}${extrasTexto} ×${item.cantidad}${precioTexto}`;
  const obsLinea = item.observaciones ? `\n  📝 ${formatObservaciones(item.observaciones)}` : "";
  return linea + obsLinea;
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
  const notaDomicilio = "\n⚠️ _El costo del domicilio es calculado por Google Maps y puede estar sujeto a ajustes._";
  const domicilioLinea = order.tipoEntrega === "domicilio"
    ? (totals.domicilio === 0
        ? "\n🎉 Domicilio gratis (pedido ≥ $100.000)"
        : "\n🛵 Domicilio: $" + totals.domicilio.toLocaleString("es-CO") + (descripcionDomicilio ? ` (${descripcionDomicilio})` : "") + notaDomicilio)
    : "";
  const obsLinea = getObservacionGeneralTexto(order);
  const obsDir = order.observacionDireccion?.trim() ? "\n📌 " + order.observacionDireccion.trim() : "";
  const entregaLinea = order.tipoEntrega === "domicilio"
    ? "\n📍 Dirección: " + (order.direccion || "No aplica") + obsDir
    : "\n🏪 Recoger en tienda";
  return "\n\nSubtotal: $" + totals.subtotal.toLocaleString("es-CO") + domicilioLinea + "\nTotal: $" + totals.total.toLocaleString("es-CO") + (obsLinea ? "\n" + obsLinea : "") + entregaLinea;
}
function parseOlaClickText(text: string) {
  const toNum = (s: string | undefined) =>
    parseInt((s || "0").replace(/\./g, ""), 10) || 0;

  const nombreMatch    = text.match(/^Nombre:\s*(.+)$/m);
  const direccionMatch = text.match(/^Direcci[oó]n:\s*(.+)$/m);
  const entregaMatch   = text.match(/^Entrega:\s*\$\s*([\d.,]+)/m);
  const totalMatch     =
    text.match(/\*?Total\s+a\s+pagar:\s*\$\s*([\d.,]+)\*?/im) ||
    text.match(/^\*?Total:\s*\$\s*([\d.,]+)\*?/im);
  const propinaMatch   = text.match(/propina\s+([\d.,]+)/i);
  const tipoServMatch  = text.match(/Tipo de servicio:\s*(\w+)/i);
  const coordMatch     = text.match(/query=([\d.-]+),([\d.-]+)/);

  // Dirección: quitar URL de Google Maps y limpiar
  let direccion = (direccionMatch?.[1] || "")
    .replace(/\s*\(https?:\/\/[^)]+\)/g, "")
    .replace(/\s*—\s*\d+\s*—\s*/, " — ")
    .trim();

  // Parsear productos línea a línea
  type HCItem = { producto: string; cantidad: number; precio: number; observaciones?: string; extras: { nombre: string; precio: number; cantidad: number }[] };
  const items: HCItem[] = [];
  let cur: HCItem | null = null;

  for (const line of text.split("\n")) {
    // Línea de cabecera: *X2 NOMBRE  $ 51.000* o *1 NOMBRE $ 19.000*
    const prod = line.match(/^\*X?(\d+)\s+(.+?)\s+\$\s*([\d.,]+)\*\s*$/);
    if (prod) {
      if (cur) items.push(cur);
      cur = { producto: prod[2].trim(), cantidad: parseInt(prod[1]), precio: toNum(prod[3]), extras: [] };
      continue;
    }
    if (!cur) continue;
    // Sub-precio base "1 Unidad(es)  $ X" — ignorar, ya capturado en cabecera
    if (/^\s+\d+\s+Unidad/i.test(line)) continue;
    // Extra con precio: +1 NOMBRE $ 7.000
    const exP = line.match(/^\s*\+\d+\s+(.+?)\s+\$\s*([\d.,]+)\s*$/);
    if (exP) { cur.extras.push({ nombre: exP[1].trim(), precio: toNum(exP[2]), cantidad: 1 }); continue; }
    // Extra sin precio: +1 CON JALAPEÑOS
    const exS = line.match(/^\s*\+\d+\s+(.+?)\s*$/);
    if (exS && !line.includes("$")) { cur.extras.push({ nombre: exS[1].trim(), precio: 0, cantidad: 1 }); continue; }
    // Comentario / observación
    const com = line.match(/^\s*Comentario:\s*(.+)$/i);
    if (com) { cur.observaciones = com[1].trim(); }
  }
  if (cur) items.push(cur);

  return {
    nombre:       (nombreMatch?.[1] || "").trim(),
    direccion,
    entrega:      toNum(entregaMatch?.[1]),
    totalAPagar:  toNum(totalMatch?.[1]),
    propina:      toNum(propinaMatch?.[1]),
    tipoServicio: (tipoServMatch?.[1] || "domicilio").toLowerCase(),
    coordLat:     coordMatch?.[1] || null,
    coordLng:     coordMatch?.[2] || null,
    items
  };
}
function parseCartaDigitalText(text: string) {
  // Strip variation selectors and zero-width joiners that WhatsApp adds to emojis
  text = text.replace(/[️︎‍]/g, "");
  const toNum = (s: string) => parseInt(s.replace(/\./g, "").replace(",", ""), 10) || 0;
  // Strip leading emoji/symbol from a line to get plain content
  const stripEmoji = (s: string) => s.replace(/^[\u{1F000}-\u{1FFFF}\u{2000}-\u{2BFF}]\s*/u, "").trim();

  type CDItem = {
    producto: string;
    variante?: string;
    cantidad: number;
    precio: number;
    observaciones?: string;
    extras: { nombre: string; precio: number; cantidad: number }[];
  };

  const items: CDItem[] = [];
  let cur: CDItem | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Producto: *1. Crepe de Paris (Solo Pollo)* ×2
    const prod = trimmed.match(/^\*\d+\.\s+(.+?)(?:\s+\((.+?)\))?\*\s*[×x](\d+)/u);
    if (prod) {
      if (cur) items.push(cur);
      cur = {
        producto: prod[1].trim(),
        variante: prod[2]?.trim(),
        cantidad: parseInt(prod[3]),
        precio: 0,
        extras: []
      };
      continue;
    }
    if (!cur) continue;
    if (trimmed.startsWith("*TOTAL")) continue;

    // Precio: línea que termina en $XX.XXX (no depende del emoji 💰)
    const precioMatch = trimmed.match(/\$\s*([\d.]+)\s*$/u);
    if (precioMatch) {
      cur.precio = Math.round(toNum(precioMatch[1]) / cur.cantidad);
      continue;
    }

    // Clasificar el contenido restante por el primer carácter del emoji
    const firstCP = [...trimmed][0];  // primer code point Unicode
    const content = stripEmoji(trimmed);
    if (!content) continue;

    // ➕ (U+2795) o + → extras
    if (firstCP === "➕" || firstCP === "+" || firstCP === "➕") {
      for (const ex of content.split(",")) {
        const nombre = ex.trim();
        if (nombre) cur.extras.push({ nombre, precio: 0, cantidad: 1 });
      }
      continue;
    }

    // 📝 (U+1F4DD) → observación
    if (firstCP === "📝" || firstCP === "\u{1F4DD}") {
      cur.observaciones = content;
      continue;
    }
  }
  if (cur) items.push(cur);

  const totalMatch = text.match(/\*TOTAL:\s*\$\s*([\d.,]+)\*/);
  return {
    items,
    total: toNum(totalMatch?.[1] || "0")
  };
}
async function handleOperationalRouting(order: any, totals: any) {
  const numeroOrden = await getNextOrderNumberForDay();
  order.numeroOrden = numeroOrden;

  const sucursalTexto = order.sucursal === "la_villa" ? "La Villa" : order.sucursal === "circunvalar" ? "Av. Circunvalar" : order.sucursal || "No definida";

  const listaProductos = order.items.map((i: any) => {
    const obsTexto = i.observaciones ? ` (${i.observaciones})` : "";
    const extrasTexto = i.extras && i.extras.length > 0
      ? " +" + i.extras.map((e: any) => e.nombre).join(", +")
      : "";
    const precioLinea = ((i.precio || 0) + (i.extras || []).reduce((s: number, e: any) => s + (e.precio || 0), 0)) * i.cantidad;
    return `* ${i.producto}${i.variante ? " - " + i.variante : ""}${obsTexto}${extrasTexto} ×${i.cantidad} - $${precioLinea.toLocaleString("es-CO")}`;
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
    (order.factura ? `\n\n📄 Factura: ${order.factura}` + (order.emailFactura ? `\n📧 Email factura: ${order.emailFactura}` : "") : "");

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
    try {
      await sendWhatsAppMessage("573217233342", resumenInterno);
      console.log("✅ RESUMEN PEDIDO ENVIADO A CIRCUNVALAR (573217233342)");
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

    try {
      await sendWhatsAppMessage("573151913928", resumenDomiciliarios);
      console.log("✅ RESUMEN PEDIDO ENVIADO A LA VILLA (573151913928)");
    } catch (error) {
      console.error("❌ ERROR ENVIANDO A LA VILLA:", error);
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

  const _fromPhone: string | undefined = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;

  try {

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

  // Deduplicación por messageId (retries de WhatsApp Cloud API)
  const msgId: string | undefined = messageData.id;
  if (msgId) {
    const now = Date.now();
    if (processedMsgIds.has(msgId)) {
      return res.sendStatus(200);
    }
    processedMsgIds.set(msgId, now);
    for (const [id, ts] of processedMsgIds) {
      if (now - ts > 60_000) processedMsgIds.delete(id);
    }
  }

  // Lock por teléfono (previene race condition con mensajes en ráfaga)
  if (phoneProcessing.has(phone)) {
    return res.sendStatus(200);
  }
  phoneProcessing.add(phone);

  const customer = await getCustomerByPhone(phone);
  const tieneUltimoPedido = !!(
    customer?.last_order &&
    Array.isArray(customer.last_order) &&
    customer.last_order.length > 0
  );
  const COORDS_REGEX = /^-?\d+\.\d+,-?\d+\.\d+$/;
  const tieneUltimaDir = !!(
    customer?.last_address &&
    customer.last_address.trim().length > 3 &&
    customer.last_address.trim() !== "null" &&
    !COORDS_REGEX.test(customer.last_address.trim())
  );
  const text = messageData.text?.body
  || messageData.interactive?.button_reply?.id
  || messageData.interactive?.list_reply?.id
  || "mensaje";

  saveMessage(phone, "cliente", text).catch(() => {});
  const lower = text.toLowerCase().trim();

  const tipoMensaje = messageData.type || "desconocido";
  // true cuando el mensaje viene de un clic en botón de WhatsApp (no texto escrito a mano)
  const esBoton = tipoMensaje === "interactive";

  // Ignorar mensajes que son solo emojis o símbolos sin texto procesable
  const textoReal = text.replace(/[^\w\sáéíóúüñÁÉÍÓÚÜÑ]/g, "").trim();
  if (!textoReal && !esBoton) return res.sendStatus(200);

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

  // Si el asesor intervino, ignorar el siguiente mensaje del cliente (no responder)
  if (currentOrder?.asesorIntervenido) {
    currentOrder.asesorIntervenido = false;
    currentOrder.inactivityPending = false;
    return res.sendStatus(200);
  }

  // Reset de sesión inactiva: +2h sin interactuar → empezar flujo nuevo (cualquier step salvo asesor)
  const esMsgPedidoEntrante =
    text.includes("PEDIDO - LAS CREPES") ||
    text.includes("Vengo de https://las-crepes.ola.click");
  if (currentOrder && currentOrder.step !== "esperando_asesor" && !esMsgPedidoEntrante) {
    const inactivoMs = Date.now() - (currentOrder.lastInteraction || Date.now());
    const DOS_HORAS_MS = 2 * 60 * 60 * 1000;
    if (inactivoMs > DOS_HORAS_MS) {
      clearOrder(phone);
      createOrUpdateOrder(phone, []);
      updateOrderStep(phone, "esperando_menu_principal");
      currentOrder = getOrder(phone)!;
      currentOrder.lastInteraction = Date.now();
      if (tieneUltimoPedido) {
        await sendWhatsAppButtons(phone,
          MSG_BIENVENIDA_RECURRENTE(customer?.name?.trim() || undefined) + CREBOT_SUFFIX,
          [
            { id: "a", title: "Pedido anterior 🔄" },
            { id: "b", title: "Pedir algo nuevo 🥞" },
            { id: "3", title: "Otros 💬" }
          ]
        );
      } else {
        await sendWhatsAppButtons(phone,
          MSG_BIENVENIDA_NUEVO + CREBOT_SUFFIX,
          [
            { id: "1", title: "Hacer un pedido 🥞" },
            { id: "2", title: "Ver menu 📋" },
            { id: "3", title: "Otros 💬" }
          ]
        );
      }
      return res.sendStatus(200);
    }
  }
  // Marcar actividad para la próxima medición de inactividad
  if (currentOrder) currentOrder.lastInteraction = Date.now();

  // Guard global: sesión activa con items en curso (protege contra flujos de bienvenida incorrectos)
  const sesionActiva = currentOrder != null
    && (currentOrder.items?.length ?? 0) > 0
    && currentOrder.step !== "esperando_menu_principal"
    && currentOrder.step !== "confirmado";

  // Limpiar timer de inactividad al recibir cualquier mensaje
  const existingTimer = inactivityTimers.get(phone);
  if (existingTimer) {
    clearTimeout(existingTimer);
    inactivityTimers.delete(phone);
  }

  // Si el cliente confirma tras ver ingredientes de un producto, agregarlo al pedido
  if (
    currentOrder?.pendingProductQuery &&
    (lower === "si" || lower === "sí" || lower === "dale" || lower === "sí quiero" ||
     lower === "si quiero" || lower === "quiero" || lower === "sí, pedirlo" || lower === "pedirlo")
  ) {
    const ppq = currentOrder.pendingProductQuery;
    currentOrder.pendingProductQuery = undefined;
    const allProdsPPQ = (menu.categorias as any[]).reduce((acc: any[], c: any) => acc.concat(c.productos), []);
    const prodPPQ = allProdsPPQ.find((p: any) => p.id === ppq.id);
    // Si tiene variantes, flujo normal de variante
    if (prodPPQ?.variantes && prodPPQ.variantes.length > 0) {
      currentOrder.pendingProduct = { id: ppq.id, nombre: ppq.nombre, precio: ppq.precio };
      updateOrderStep(phone, "esperando_variante_producto");
      currentOrder = getOrder(phone)!;
      const botonesVar = prodPPQ.variantes.slice(0, 3).map((v: any) => ({
        id: `variante_${v.id}`,
        title: `${v.nombre} $${v.precio.toLocaleString("es-CO")}`
      }));
      await sendWhatsAppButtons(phone, `¿Cómo lo deseas?\n\n${ppq.nombre}`, botonesVar);
    } else {
      createOrUpdateOrder(phone, [{ producto: ppq.nombre, cantidad: 1, precio: ppq.precio, extras: [] }]);
      updateOrderStep(phone, "post_agregar_producto");
      currentOrder = getOrder(phone)!;
      const resumenPPQ = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nEstoy registrando:\n\n" + resumenPPQ + "\n\n📝 Si deseas una observación escríbela, o elige:",
        [
          { id: "confirmar", title: "Confirmar ✅" },
          { id: "agregar_mas", title: "Agregar más ➕" },
          { id: "eliminar", title: "Eliminar ➖" }
        ]
      );
    }
    return res.sendStatus(200);
  }

  // Si el cliente responde tras el mensaje de inactividad, re-mostrar estado actual sin procesar el texto
  if (currentOrder?.inactivityPending && lower !== "reset" && !text.includes("PEDIDO - LAS CREPES") && !text.includes("Vengo de https://las-crepes.ola.click")) {
    // Consulta de menú/carta tras inactividad → enviar el menú
    if (lower.includes("carta") || lower.includes("menu") || lower.includes("menú")) {
      currentOrder.inactivityPending = false;
      await sendWhatsAppMessage(phone,
        "🥞 Aquí puedes ver nuestro menú completo:\n\nhttps://menu.tecmenu.com\n\n¿Deseas hacer un pedido? Escríbeme 😊"
      );
      return res.sendStatus(200);
    }
    // Botón = acción deliberada del cliente → procesar normalmente (no descartar)
    if (esBoton) {
      currentOrder.inactivityPending = false;
    } else {
    const stepInact = currentOrder.step;
    const carritoVacioInact = currentOrder.items.length === 0;
    // Si el carrito está vacío y el texto parece un pedido → procesar normalmente
    const stepsConParseo = new Set(["armando_pedido", "post_agregar_producto", "esperando_confirmacion"]);
    const parseInact = (carritoVacioInact && stepsConParseo.has(stepInact))
      ? parseOrder(normalizeText(lower))
      : null;
    if (parseInact && (parseInact.items.length > 0 || parseInact.ambiguousChoice)) {
      currentOrder.inactivityPending = false;
      // Caer al procesamiento normal — el texto se procesará como pedido
    } else {
      currentOrder.inactivityPending = false;
      if (stepInact === "esperando_asesor" || stepInact === "esperando_mensaje_fuera_horario") {
        return res.sendStatus(200);
      }
      const resumenActual = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
      if (stepsConParseo.has(stepInact)) {
        if (carritoVacioInact) {
          await sendWhatsAppMessage(phone,
            "Aquí estoy 😊 Aún no tienes productos en tu pedido.\n\n¿Qué deseas pedir?\n• Hawaiana\n• Ranchera\n• Parisina\n• Pollo y Carne..."
          );
        } else {
          const totals = calculateTotal(currentOrder);
          await sendWhatsAppButtons(phone,
            "Tu pedido sigue aquí 😊\n\n" + resumenActual + (currentOrder.tipoEntrega === "domicilio" ? `\n🚚 Domicilio: $${totals.domicilio.toLocaleString("es-CO")}` : "") + `\n💵 Total: $${totals.total.toLocaleString("es-CO")}\n\n¿Qué deseas hacer?`,
            [
              { id: "confirmar", title: "Confirmar ✅" },
              { id: "agregar_mas", title: "Agregar más ➕" },
              { id: "eliminar", title: "Eliminar ➖" }
            ]
          );
        }
      } else if (stepInact === "esperando_pago") {
        const totalsInact = calculateTotal(currentOrder);
        await sendWhatsAppButtons(phone,
          `El total de tu pedido es $${totalsInact.total.toLocaleString("es-CO")} 💰\n¿Cómo deseas pagar?`,
          [
            { id: "efectivo", title: "Efectivo 💵" },
            { id: "nequi", title: "Nequi/Daviplata 📱" },
            { id: "bancolombia", title: "Bancolombia/Llave🏦" }
          ]
        );
      } else if (stepInact === "esperando_comprobante" || stepInact === "esperando_comprobante_holaclick") {
        const totalsInact = calculateTotal(currentOrder);
        await sendWhatsAppMessage(phone,
          `Aquí estoy 😊\n\nEl total a pagar es: *$${totalsInact.total.toLocaleString("es-CO")}*\n\nCuando realices el pago envíame el comprobante 📸`
        );
      } else {
        await sendWhatsAppMessage(phone, "Aquí estoy 😊 ¿En qué te ayudo?");
      }
      return res.sendStatus(200);
    }
    }
  }

  // Cancelar timer si el pedido ya está confirmado
  const STEPS_SIN_TIMER = new Set(["confirmado", "esperando_asesor", "esperando_ayuda", "esperando_mensaje_fuera_horario"]);
  if (STEPS_SIN_TIMER.has(currentOrder?.step || "")) {
    const timerExistente = inactivityTimers.get(phone);
    if (timerExistente) {
      clearTimeout(timerExistente);
      inactivityTimers.delete(phone);
    }
  } else if (currentOrder) {
    // Solo armar timer si el mensaje de inactividad nunca se ha enviado en esta sesión
    if (!currentOrder.inactivityPending) {
      const timer = setTimeout(async () => {
        const order = getOrder(phone);
        if (order && !STEPS_SIN_TIMER.has(order.step) && !order.inactivityPending) {
          order.inactivityPending = true;
          await sendWhatsAppMessage(phone,
            "¿Sigues ahí? 😊 Si ya sabes qué ordenar escríbemelo y yo te guío para que realices tu pedido por acá."
          );
        }
        inactivityTimers.delete(phone);
      }, 10 * 60 * 1000);
      inactivityTimers.set(phone, timer);
    }
  }

  // Observación de entrega interceptada en cualquier step cuando hay dirección guardada
  const STEPS_NO_INTERCEPTAR = new Set(["esperando_direccion", "esperando_nombre", "esperando_observacion_general", "esperando_datos_factura", "esperando_confirmacion_direccion"]);
  if (
    currentOrder?.direccion &&
    !STEPS_NO_INTERCEPTAR.has(currentOrder.step || "") &&
    esObservacionDireccion(text)
  ) {
    updateOrderDireccionNotes(phone, text.trim());
    const msgAnotado = currentOrder.step === "confirmado"
      ? `Anotado ✅ "${text.trim()}" — se lo enviamos al repartidor 🛵`
      : `Anotado ✅ "${text.trim()}"`;
    await sendWhatsAppMessage(phone, msgAnotado);
    return res.sendStatus(200);
  }

  // ── Preguntas frecuentes — responden siempre, incluso fuera de horario ──────
  const _lower = lower.trim();
  const _esMsgLargo = text.length > 200;

  const _esConsultaHorario =
    _lower.includes("a qué hora") || _lower.includes("a que hora") ||
    _lower.includes("qué hora") || _lower.includes("que hora") ||
    _lower.includes("horario") ||
    _lower.includes("abren") || _lower.includes("cierran") ||
    _lower.includes("hasta qué hora") || _lower.includes("hasta que hora") ||
    _lower.includes("desde qué hora") || _lower.includes("desde que hora") ||
    _lower.includes("desde cuando") || _lower.includes("desde cuándo") ||
    _lower.includes("a partir de") ||
    _lower === "cerrado" || _lower === "abierto" ||
    _lower.includes("están cerrado") || _lower.includes("estan cerrado") ||
    _lower.includes("están abierto") || _lower.includes("estan abierto") ||
    _lower.includes("siguen abierto") || _lower.includes("siguen cerrado") ||
    _lower.includes("ya cerraron") || _lower.includes("ya abrieron") ||
    _lower.includes("todavía abierto") || _lower.includes("todavia abierto") ||
    _lower.includes("están abiertos") || _lower.includes("estan abiertos") ||
    _lower.includes("horario de atención") || _lower.includes("horario de atencion") ||
    _lower.includes("ya tienen servicio") || _lower.includes("tienen servicio") ||
    _lower === "horario" || _lower === "horas";

  if (_esConsultaHorario && !_esMsgLargo) {
    // Si además pregunta por la carta/menú, incluir el link del menú
    const tambienPideMenu = _lower.includes("carta") || _lower.includes("menu") || _lower.includes("menú");
    await sendWhatsAppMessage(phone,
      "🕐 Nuestro horario de atención:\n" +
      "• Lunes a viernes: 3:00 PM – 10:15 PM\n" +
      "• Sábados, domingos y festivos: 12:00 M – 10:15 PM\n\n" +
      "📍 La Villa - Calle 83 #16a-22\n" +
      "📍 Av. Circunvalar #8-94 local 1\n\n" +
      "📞 *606 341 3020*" +
      (tambienPideMenu ? "\n\n🥞 Y aquí está nuestro menú completo:\nhttps://menu.tecmenu.com" : "")
    );
    return res.sendStatus(200);
  }

  const _esConsultaUbicacion =
    _lower.includes("donde estan") || _lower.includes("dónde están") ||
    _lower.includes("donde quedan") || _lower.includes("dónde quedan") ||
    _lower.includes("donde queda") || _lower.includes("dónde queda") ||
    _lower.includes("ubicacion") || _lower.includes("ubicación") ||
    _lower.includes("como llegar") || _lower.includes("cómo llegar") ||
    _lower.includes("dónde es") || _lower.includes("donde es") ||
    _lower === "dirección" || _lower === "direccion";

  if (_esConsultaUbicacion && !_esMsgLargo && currentOrder?.step !== "esperando_direccion" && currentOrder?.step !== "esperando_asesor") {
    await sendWhatsAppMessage(phone,
      "📍 Nuestras sucursales:\n\n" +
      "🏪 *La Villa*\nCalle 83 #16a-22, Pereira\nhttps://maps.app.goo.gl/KvWtZ9r2vQKdcmXU6\n\n" +
      "🏪 *Av. Circunvalar*\nCircunvalar #8-94 local 1, Pereira\nhttps://maps.app.goo.gl/xRrJgWBGSNPdTnir9\n\n" +
      "📞 *606 341 3020*"
    );
    return res.sendStatus(200);
  }

  // Pregunta por opciones de bebidas (malteadas, jugos, limonadas) → listar sabores
  const _preguntaBebida = (kw: string) => lower.includes(kw) && (
    lower.includes("que ") || lower.includes("qué ") || lower.includes("cuales") || lower.includes("cuáles") ||
    lower.includes("cual ") || lower.includes("manej") || lower.includes("tienen") || lower.includes("tiene") ||
    lower.includes("hay") || lower.includes("sabor") || lower.includes("opcion") || lower.includes("cuanta")
  );
  const _bebidasCat = (menu.categorias as any[]).find((c: any) => c.id === "bebidas");
  if (_bebidasCat && !_esMsgLargo && (_preguntaBebida("malteada") || _preguntaBebida("jugo") || _preguntaBebida("limonada"))) {
    if (_preguntaBebida("malteada")) {
      const m = _bebidasCat.productos.find((p: any) => p.id === "malteada");
      const sabores = (m?.variantes || []).map((v: any) => v.nombre).join(", ");
      await sendWhatsAppMessage(phone, `🥤 Nuestras malteadas ($${(m?.precio || 17900).toLocaleString("es-CO")}): ${sabores}.\n\n¿Deseas agregar una? 😊`);
    } else if (_preguntaBebida("limonada")) {
      const l = _bebidasCat.productos.find((p: any) => p.id === "limonada");
      const ls = (l?.variantes || []).map((v: any) => `${v.nombre} $${v.precio.toLocaleString("es-CO")}`).join(", ");
      await sendWhatsAppMessage(phone, `🍋 Nuestras limonadas: ${ls}.\n\n¿Deseas agregar una? 😊`);
    } else {
      const jugos = _bebidasCat.productos.filter((p: any) => p.tipo === "jugo").map((p: any) => p.nombre.replace(/^Jugo de /, "")).join(", ");
      await sendWhatsAppMessage(phone, `🧃 Jugos naturales ($9.900 en agua / $11.500 en leche): ${jugos}.\n\n¿Deseas agregar uno? 😊`);
    }
    return res.sendStatus(200);
  }

  const _esConsultaMenu =
    _lower === "menu" || _lower === "menú" || _lower === "carta" ||
    _lower.includes("ver menu") || _lower.includes("ver menú") ||
    _lower.includes("ver carta") || _lower.includes("ver el menu") ||
    _lower.includes("la carta") || _lower.includes("el menu") || _lower.includes("el menú") ||
    _lower.includes("qué tienen") || _lower.includes("que tienen") ||
    _lower.includes("qué hay") || _lower.includes("que hay") ||
    _lower.includes("envíame el menu") || _lower.includes("enviame el menu") ||
    _lower.includes("manda el menu") || _lower.includes("manda la carta");

  if (_esConsultaMenu && !_esMsgLargo) {
    await sendWhatsAppMessage(phone,
      "🥞 Aquí puedes ver nuestro menú completo:\n\nhttps://menu.tecmenu.com\n\n" +
      "¿Deseas hacer un pedido? Escríbeme 😊"
    );
    return res.sendStatus(200);
  }

  const _esConsultaContacto =
    _lower.includes("teléfono") || _lower.includes("telefono") ||
    _lower.includes("número de contacto") || _lower.includes("numero de contacto") ||
    _lower.includes("cómo los llamo") || _lower.includes("como los llamo") ||
    _lower.includes("cómo los contacto") || _lower.includes("como los contacto") ||
    _lower.includes("número del local") || _lower.includes("numero del local") ||
    _lower.includes("número fijo") || _lower.includes("numero fijo") ||
    _lower.includes("datos de contacto") || _lower.includes("información de contacto") ||
    _lower.includes("informacion de contacto") ||
    _lower === "contacto" || _lower === "número" || _lower === "numero";

  if (_esConsultaContacto && !_esMsgLargo) {
    await sendWhatsAppMessage(phone,
      "📞 Puedes contactarnos al:\n\n" +
      "*606 341 3020* (línea fija)\n" +
      "*315 191 3928* (WhatsApp asesor)\n\n" +
      "📍 La Villa - Calle 83 #16a-22\n" +
      "📍 Av. Circunvalar #8-94 local 1\n\n" +
      "🕐 Horario: 3:00 PM a 10:15 PM todos los días"
    );
    return res.sendStatus(200);
  }
  // ────────────────────────────────────────────────────────────────────────────

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
        "Nuestro horario de atención es de 3:00 PM a 10:15 PM todos los días 🕐\n\n" +
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
  currentOrder?.step === "esperando_queso_dulce" ||
  currentOrder?.step === "esperando_confirmacion_direccion" ||
  currentOrder?.step === "post_agregar_producto" ||
  currentOrder?.step === "esperando_confirmacion" ||
  currentOrder?.step === "esperando_datos_factura" ||
  currentOrder?.step === "esperando_email_factura" ||
  currentOrder?.step === "confirmado" ||
  currentOrder?.step === "esperando_mensaje_fuera_horario";

// Palabras clave simples y mensajes de botones que NO deben llamar a Gemini

// Steps donde se intenta el parser de reglas primero, y la IA solo si no detecta producto
const useRulesThenAI =
  !skipParsing && currentOrder?.step === "armando_pedido";

// Gemini solo se llama si: mensaje tipo "text", más de 3 palabras, y no es keyword simple
const SKIP_AI_KEYWORDS = new Set([
  "si", "sí", "no", "hola", "reset", "confirmar", "agregar", "eliminar",
  "ok", "dale", "listo", "menu", "menú", "ayuda", "ayudarme",
  "recoger", "para recoger", "retirar", "para retirar", "en tienda", "para llevar"
]);
const stepNeedsAI = currentOrder?.step === "armando_pedido";
const shouldCallAI =
  tipoMensaje === "text" &&
  (stepNeedsAI ? text.trim().split(/\s+/).length >= 1 : text.trim().split(/\s+/).length > 3) &&
  !SKIP_AI_KEYWORDS.has(lower);

let parseResult: { items: any[]; ambiguousChoice?: any; upselling?: string; productoQuery?: string } =
  { items: [], ambiguousChoice: undefined, upselling: undefined };

// Resultado de la IA para uso posterior en los handlers
let aiClassification: import('./parser').AIClassification | null = null;

if (skipParsing) {
  // No parsear nada — el handler sabe qué esperar
} else if (useRulesThenAI) {
  // 1. Parser de reglas primero (siempre para detectar consultas de ingredientes)
  const ruleResult1 = parseOrder(text);
  if (ruleResult1.productoQuery) {
    parseResult = { items: [], productoQuery: ruleResult1.productoQuery };
  } else if (!isQuestion(text) || ruleResult1.items.length >= 2 || ruleResult1.ambiguousChoice) {
    parseResult = ruleResult1;
  }
  // 2. Solo si no detectó productos y el texto califica → llamar a Gemini para clasificar
  if (parseResult.items.length === 0 && !parseResult.ambiguousChoice && !parseResult.productoQuery && shouldCallAI) {
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
  const ruleResult2 = parseOrder(text);
  if (ruleResult2.productoQuery) {
    parseResult = { items: [], productoQuery: ruleResult2.productoQuery };
  } else if (!isQuestion(text) || ruleResult2.items.length >= 2 || ruleResult2.ambiguousChoice) {
    parseResult = ruleResult2;
    if (parseResult.items.length === 0 && !parseResult.ambiguousChoice && shouldCallAI) {
      const aiResult = await parseWithAI(text);
      if (aiResult.items.length > 0) parseResult = aiResult;
    }
  }
}

const parsedItems = parseResult.items;

const HORARIO_MSG =
  "🕐 Nuestro horario de atención es de 3:00 PM a 10:15 PM todos los días\n\n" +
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
  lower.includes("ubicacion") ||
  lower.includes("ubicación") ||
  lower.includes("como llegar") ||
  lower.includes("cómo llegar") ||
  lower === "donde están" ||
  lower === "donde quedan";

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
  // Si hay un pedido activo en progreso, re-mostrar los botones de acción
  if (currentOrder?.step === "post_agregar_producto" && currentOrder.items.length > 0) {
    const resumenUbic = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
    await sendWhatsAppButtons(phone,
      "Tu pedido hasta ahora:\n\n" + resumenUbic + "\n\n¿Qué deseas hacer?",
      [
        { id: "confirmar", title: "Confirmar ✅" },
        { id: "agregar_mas", title: "Agregar más ➕" },
        { id: "eliminar", title: "Eliminar ➖" }
      ]
    );
  }
  return res.sendStatus(200);
}

// Consulta de precio de un producto específico
const esPrecioProducto =
  lower.includes("qué vale") || lower.includes("que vale") ||
  lower.includes("cuánto vale") || lower.includes("cuanto vale") ||
  lower.includes("cuánto cuesta") || lower.includes("cuanto cuesta") ||
  lower.includes("precio de") || lower.includes("cuánto es la") || lower.includes("cuanto es la") ||
  lower.includes("cuánto es el") || lower.includes("cuanto es el") ||
  lower.includes("qué precio") || lower.includes("que precio");
if (esPrecioProducto) {
  // Extraer nombre del producto quitando las palabras de la pregunta
  const textoSinPregunta = normalizeText(lower)
    .replace(/que vale|cuanto vale|cuanto cuesta|precio de|cuanto es (la|el)|que precio tiene|que precio/g, "")
    .replace(/\bla\b|\bel\b|\bun\b|\buna\b|\bde\b/g, "")
    .trim();
  // Buscar en el menú completo usando parseOrder sobre el texto limpio
  const allProdsPrecio = (menu.categorias as any[])
    .filter((c: any) => c.id !== "extras")
    .flatMap((c: any) => c.productos as any[]);
  // Match por alias usando normalizeText
  const prodEncontrado = allProdsPrecio.find((p: any) => {
    const aliases: string[] = [p.nombre, ...(p.aliases || [])].map((a: string) => normalizeText(a));
    return aliases.some(a => a.includes(textoSinPregunta) || textoSinPregunta.includes(a));
  });
  if (prodEncontrado) {
    let precioMsg = `*${prodEncontrado.nombre}* tiene un precio de $${prodEncontrado.precio.toLocaleString("es-CO")} 💰`;
    if (prodEncontrado.variantes && prodEncontrado.variantes.length > 0) {
      precioMsg += "\n\n" + prodEncontrado.variantes.map((v: any) => `• ${v.nombre}: $${v.precio.toLocaleString("es-CO")}`).join("\n");
    }
    precioMsg += "\n\n¿Deseas agregarlo a tu pedido? 😊";
    await sendWhatsAppMessage(phone, precioMsg);
    return res.sendStatus(200);
  }
  // Si no encuentra el producto, deja caer al flujo normal (Gemini lo manejará)
}

// Pregunta sobre costo de domicilio
const esPreguntaTiempoDom =
  lower.includes("tiempo") || lower.includes("demora") || lower.includes("tarda") ||
  lower.includes("llega") || lower.includes("cuando") || lower.includes("cuándo") ||
  lower.includes("minutos") || lower.includes("hora");
const esConsultaCostoDomicilio =
  !esPreguntaTiempoDom &&
  lower.includes("domicilio") && (
    lower.includes("costo") || lower.includes("cuesta") ||
    lower.includes("cuánto") || lower.includes("cuanto") ||
    lower.includes("precio") || lower.includes("valor") ||
    lower.includes("cuál") || lower.includes("cual") ||
    lower.includes("qué costo") || lower.includes("que costo") ||
    lower.includes("cuánto es") || lower.includes("cuanto es")
  );
if (esConsultaCostoDomicilio && !esMensajeLargo) {
  await sendWhatsAppMessage(phone,
    "El valor del domicilio es calculado por Google Maps dependiendo de la distancia. Una vez ingreses tu dirección te arrojará el valor exacto 🛵"
  );
  return res.sendStatus(200);
}

// Pregunta por pago con tarjeta/datáfono → mostrar medios de pago disponibles
// (en cualquier step salvo los de pago, que ya lo manejan con botones)
const _stepTarjeta = currentOrder?.step;
const esPreguntaTarjeta =
  lower.includes("tarjeta") || lower.includes("datafono") || lower.includes("datáfono") ||
  lower.includes("credito") || lower.includes("crédito") ||
  lower.includes("debito") || lower.includes("débito");
if (
  esPreguntaTarjeta && !esMensajeLargo &&
  _stepTarjeta !== "esperando_pago" && _stepTarjeta !== "esperando_pago_holaclick"
) {
  await sendWhatsAppMessage(phone,
    "Por ahora no manejamos pago con tarjeta/datáfono 😊\n\n" +
    "Aceptamos:\n💵 Efectivo\n📱 Nequi/Daviplata\n🏦 Bancolombia/Llave"
  );
  return res.sendStatus(200);
}

// Pregunta sobre formas de pago — respuesta inmediata en cualquier step
const esPreguntaPago =
  lower.includes("formas de pago") || lower.includes("forma de pago") ||
  lower.includes("cómo pago") || lower.includes("como pago") ||
  lower.includes("se puede pagar") || lower.includes("puedo pagar") ||
  lower.includes("pago con nequi") || lower.includes("pago con bancolombia") ||
  lower.includes("pago con efectivo") || lower.includes("aceptan nequi") ||
  lower.includes("aceptan bancolombia") || lower.includes("métodos de pago") ||
  lower.includes("metodos de pago") || lower.includes("medios de pago") ||
  lower.includes("nequi") || lower.includes("bancolombia") || lower.includes("daviplata") ||
  lower.includes("transferencia") || lower.includes("número de cuenta") || lower.includes("numero de cuenta") ||
  lower.includes("datos para transferir") || lower.includes("consignacion") || lower.includes("consignación") ||
  lower.includes("datafono") || lower.includes("datáfono") || lower.includes("tarjeta") ||
  lower.includes("cuenta bancaria") || lower.includes("datos de pago");
const stepActualPago = currentOrder?.step;
const enStepDePago = stepActualPago === "esperando_pago"
  || stepActualPago === "esperando_comprobante"
  || stepActualPago === "esperando_pago_holaclick"
  || stepActualPago === "esperando_comprobante_holaclick"
  || stepActualPago === "esperando_asesor"
  || stepActualPago === "esperando_confirmacion";
if (esPreguntaPago && !esMensajeLargo && !enStepDePago) {
  // Si el cliente está armando pedido con items → avanzar al flujo de confirmación
  if (
    currentOrder &&
    (currentOrder.step === "armando_pedido" || currentOrder.step === "post_agregar_producto") &&
    currentOrder.items.length > 0 &&
    (lower.includes("transferencia") || lower.includes("nequi") || lower.includes("bancolombia") ||
     lower.includes("daviplata") || lower.includes("efectivo") ||
     lower.includes("pago con") || lower.includes("quiero pagar") || lower.includes("voy a pagar"))
  ) {
    updateOrderStep(phone, "esperando_confirmacion");
    currentOrder = getOrder(phone)!;
    const totals = calculateTotal(currentOrder);
    const resumen = currentOrder.items.map((item: any) => formatLineaItem(item)).join("\n");
    await sendWhatsAppButtons(phone,
      "Perfecto 👌\n\nTu pedido es:\n" + resumen +
      buildResumenFooter(currentOrder, totals, currentOrder.domicilioTexto) +
      "\n\n¿Qué deseas hacer?",
      [
        { id: "confirmar",   title: "✅ Confirmar" },
        { id: "agregar_mas", title: "➕ Agregar" },
        { id: "eliminar",    title: "➖ Quitar" },
        { id: "4",           title: "📝 Observación" }
      ]
    );
    return res.sendStatus(200);
  }
  const sucursal = currentOrder?.sucursal;
  let msgPago = "Aceptamos Efectivo 💵, Nequi/Daviplata 📱 y Bancolombia/Llave 🏦\n\n";
  if (sucursal === "circunvalar") {
    msgPago +=
      "📍 *Av. Circunvalar:*\n" +
      "• llave: *0040652828*\n" +
      "• Bancolombia: *270 0000 4514*\n" +
      "  🔑 Llave: 0040652828";
  } else if (sucursal === "la_villa") {
    msgPago +=
      "📍 *La Villa:*\n" +
      "• Nequi/Daviplata: *320 721 8267*\n" +
      "• Bancolombia: *270 3382 5108*\n" +
      "  🔑 Llave: @niet661";
  } else {
    msgPago +=
      "📍 *Av. Circunvalar:*\n" +
      "• Nequi/Daviplata: *320 583 9477*\n" +
      "• Bancolombia: *270 0000 4514*\n" +
      "  🔑 Llave: 0040652828\n\n" +
      "📍 *La Villa:*\n" +
      "• Nequi/Daviplata: *320 721 8267*\n" +
      "• Bancolombia: *270 3382 5108*\n" +
      "  🔑 Llave: @niet661";
  }
  await sendWhatsAppMessage(phone, msgPago);
  return res.sendStatus(200);
}

// Número de teléfono, precio o cantidad enviada en medio del flujo — ignorar silenciosamente
if (/^\d[\d\s.?,]*$/.test(lower.trim()) && currentOrder?.step === "armando_pedido") {
  if (lower.includes("?") && currentOrder.items.length > 0) {
    const totals = calculateTotal(currentOrder);
    await sendWhatsAppMessage(phone,
      `El total de tu pedido es $${totals.total.toLocaleString("es-CO")} 😊\n\n¿Deseas confirmar?`
    );
  }
  return res.sendStatus(200);
}

// Consulta de disponibilidad: "tiene Coca-Cola", "hay jugos", "tienen malteadas"
const esConsultaDisponibilidad =
  !esMensajeLargo && (
    /^(tienen?|hay|tienes)\s+\w/i.test(lower) ||
    lower.startsWith("tienen ") ||
    lower.startsWith("tiene ") ||
    lower.startsWith("hay ")
  );
if (esConsultaDisponibilidad) {
  // Consulta sobre domicilio como servicio
  if (lower.includes("domicilio") || lower.includes("delivery") || lower.includes("domicilios")) {
    await sendWhatsAppMessage(phone,
      "Sí, tenemos domicilio a toda la ciudad 🛵\n\n🕐 Nuestro horario de atención es de *3:00 PM a 10:15 PM* todos los días.\n\n¿Te ayudo con tu pedido? 😊"
    );
    return res.sendStatus(200);
  }
  // Consulta sobre horario / servicio / atención
  if (lower.includes("servicio") || lower.includes("atienden") || lower.includes("abren") ||
      lower.includes("cierran") || lower.includes("abierto") || lower.includes("abiertos")) {
    await sendWhatsAppMessage(phone,
      "🕐 Nuestro horario de atención es de *3:00 PM a 10:15 PM* todos los días 😊\n\n" +
      "📍 La Villa - Calle 83 #16a-22\n" +
      "📍 Av. Circunvalar #8-94 local 1"
    );
    return res.sendStatus(200);
  }
  const allProdsDisp = (menu.categorias as any[]).reduce((acc: any[], c: any) => acc.concat(c.productos), []);
  let matchedProd: any = null;
  for (const prod of allProdsDisp) {
    const candidates = [prod.nombre, ...(prod.aliases || [])].map((a: string) => normalizeText(a));
    if (candidates.some((c: string) => normalizeText(lower).includes(c) && c.length >= 3)) {
      matchedProd = prod;
      break;
    }
  }
  if (matchedProd) {
    await sendWhatsAppMessage(phone,
      `Sí, tenemos *${matchedProd.nombre}* a $${matchedProd.precio.toLocaleString("es-CO")} 😊\n\n¿Lo agrego a tu pedido?`
    );
  } else {
    await sendWhatsAppMessage(phone,
      `Aquí puedes ver todo nuestro menú:\n\nhttps://menu.tecmenu.com\n\n¿Te ayudo con algo más? 😊`
    );
  }
  return res.sendStatus(200);
}

// Corregir dirección — cualquier step con pedido activo
const esCorreccionDireccion =
  lower.includes("dirección está mal") || lower.includes("direccion esta mal") ||
  lower.includes("dirección es otra") || lower.includes("direccion es otra") ||
  lower.includes("dirección incorrecta") || lower.includes("direccion incorrecta") ||
  lower.includes("cambiar dirección") || lower.includes("cambiar direccion") ||
  lower.includes("otra dirección") || lower.includes("otra direccion") ||
  lower.startsWith("la dirección es") || lower.startsWith("la direccion es") ||
  lower.includes("dirección equivocada") || lower.includes("direccion equivocada");
if (esCorreccionDireccion && currentOrder && currentOrder.step !== "confirmado") {
  updateOrderStep(phone, "esperando_direccion");
  currentOrder = getOrder(phone)!;
  await sendWhatsAppMessage(phone, "Claro, dime tu dirección correcta 📍\n\nEj: Calle 12 #33-10, barrio Los Álamos");
  return res.sendStatus(200);
}

// Cancelar pedido — cualquier step excepto "confirmado"
if (
  currentOrder &&
  currentOrder.step !== "confirmado" &&
  (lower === "cancelar" || lower === "cancela" || lower.includes("cancelar pedido") || lower.includes("para cancelar"))
) {
  clearOrder(phone);
  await sendWhatsAppMessage(phone,
    "Tu pedido ha sido cancelado ✅. Cuando quieras hacer un nuevo pedido escríbenos.\nPara hablar con un asesor: 📱 315 191 3928"
  );
  return res.sendStatus(200);
}

// Consulta general de tiempo de entrega — responde antes que la queja de demora
const esConsultaTiempoEntrega =
  lower.includes("cuánto tarda") || lower.includes("cuanto tarda") ||
  lower.includes("cuánto se tarda") || lower.includes("cuanto se tarda") ||
  lower.includes("cuánto demora") || lower.includes("cuanto demora") ||
  lower.includes("cuánto se demora") || lower.includes("cuanto se demora") ||
  lower.includes("cuánto se puede demorar") || lower.includes("cuanto se puede demorar") ||
  lower.includes("tiempo de entrega") || lower.includes("tiempo del domicilio") ||
  lower.includes("cuánto tiempo") || lower.includes("cuanto tiempo");
if (esConsultaTiempoEntrega && !esMensajeLargo) {
  await sendWhatsAppMessage(phone,
    "🛵 Los domicilios tardan aproximadamente *40-50 minutos*.\n\n" +
    "🏪 Si vas a recoger en tienda, tu pedido estará listo en *15-20 minutos*.\n\n" +
    "Situaciones como el tráfico o el clima pueden hacer que el domicilio demore un poco más."
  );
  return res.sendStatus(200);
}

// Queja de demora — respuesta inmediata en cualquier step
const esQuejaDedemora =
  lower.includes("no ha llegado") ||
  lower.includes("no llega") ||
  lower.includes("hace rato pedi") ||
  lower.includes("hace rato pedí") ||
  lower.includes("lleva mucho") ||
  lower.includes("mucho tiempo") ||
  lower.includes("tarda mucho") ||
  lower.includes("una hora") ||
  lower.includes("cuando llega") ||
  lower.includes("cuándo llega") ||
  lower.includes("cuánto falta") ||
  lower.includes("cuanto falta") ||
  lower.includes("tardando") ||
  lower.includes("demorado") ||
  lower.includes("estado del pedido") ||
  lower.includes("mi pedido no") ||
  lower === "mi pedido";
if (esQuejaDedemora && !esMensajeLargo) {
  await sendWhatsAppMessage(phone,
    "Entendemos tu preocupación 😊 Por favor comunícate directamente al 📱 315 191 3928 para que un asesor te ayude con el estado de tu pedido."
  );
  return res.sendStatus(200);
}

// Cortesías — responder y continuar sin detener el flujo
// Excluir mensajes de carta digital (pueden contener "Mil gracias" en observaciones)
const esCortesia = !esMensajeLargo && !text.includes("🥞") && (
  /^(muchas?\s+)?gracia[s]?[!\s]*$|^muy\s+amables?[!\s]*$|^mil\s+gracias[!\s]*$|^(que|qué)\s+amables?[!\s]*$|^de\s+nada[!\s]*$/i.test(lower.trim()) ||
  /\b(muchas?\s+gracias|muy\s+amables?|mil\s+gracias|qu[eé]\s+amables?)\b/i.test(lower)
);
if (esCortesia) {
  await sendWhatsAppMessage(phone, "¡Estamos para servirte! 😊");
  return res.sendStatus(200);
}

// Cambio de tipo de entrega a "recoger" — botón viejo de WhatsApp o texto explícito
const esChangeToRecoger =
  lower === "recoger" ||
  lower === "para recoger" ||
  lower === "quiero recoger" ||
  lower === "voy a recoger" ||
  lower === "retirar" ||
  lower === "para retirar" ||
  lower === "para llevar" ||
  lower === "en tienda" ||
  lower.includes("retirar en") ||
  lower.includes("recoger en");

if (esChangeToRecoger && currentOrder && currentOrder.step !== "confirmado") {
  updateOrderDeliveryType(phone, "recoger");
  currentOrder = getOrder(phone)!;
  currentOrder.valorDomicilio = 0;
  currentOrder.sucursal = undefined;
  updateOrderStep(phone, "esperando_sucursal");
  currentOrder = getOrder(phone)!;
  await sendWhatsAppButtons(phone,
    "Perfecto, cambiado a *Recoger en tienda* 🏪\n\n¿En cuál sucursal recoges?",
    [
      { id: "a", title: "La Villa 📍" },
      { id: "b", title: "Av. Circunvalar 📍" }
    ]
  );
  return res.sendStatus(200);
}

// Consulta de toppings/extras disponibles
const esConsultaToppings =
  lower.includes("topping") ||
  (lower.includes("adicional") && (lower.includes("qu") || lower.includes("cu") || lower.includes("hay") || lower.includes("tiene") || lower.includes("cuál") || lower.includes("cual"))) ||
  (lower.includes("extra") && (lower.includes("qu") || lower.includes("cu") || lower.includes("hay") || lower.includes("tiene")));
if (esConsultaToppings && !esMensajeLargo) {
  await sendWhatsAppMessage(phone,
    "🍽️ Nuestros toppings y extras disponibles:\n\n" +
    "🥓 Tocineta $5.500\n" +
    "🍄 Champiñones $4.500\n" +
    "🌽 Maíz tierno $3.500\n" +
    "🍍 Piña $2.000\n" +
    "🌶️ Jalapeños $2.000\n" +
    "🍓 Fresa $3.000\n" +
    "🍌 Banano $2.000\n" +
    "🍑 Durazno $3.900\n" +
    "🍎 Manzana $2.500"
  );
  return res.sendStatus(200);
}

// Consulta de ingredientes de un producto ("qué tiene", "qué lleva", "ingredientes de")
const normTextIQ = normalizeText(text);
const ingredientQueryM =
  normTextIQ.match(/^(?:(?:quiero saber|me (?:puedes?|puede) decir)\s+)?que\s+(?:tiene|lleva|trae|contiene|incluye)\s+(?:la\s+|el\s+|una?\s+)?(.+?)[\?]?\s*$/) ||
  normTextIQ.match(/^ingredientes?\s+(?:de\s+)?(?:la\s+|el\s+|una?\s+)?(.+?)[\?]?\s*$/);

if (ingredientQueryM && !esMensajeLargo) {
  const queryTerm = ingredientQueryM[1].trim();
  const allProdsIQ = (menu.categorias as any[]).reduce((acc: any[], c: any) => acc.concat(c.productos), []);
  let bestProd: any = null;
  let bestScore = 0;
  for (const prod of allProdsIQ) {
    const candidates = [prod.nombre, ...(prod.aliases || [])].map((a: string) => normalizeText(a));
    for (const candidate of candidates) {
      let score = 0;
      if (candidate === queryTerm) score = 3;
      else if (candidate.includes(queryTerm) && queryTerm.length >= 4) score = 2;
      else if (queryTerm.includes(candidate) && candidate.length >= 4) score = 2;
      if (score > bestScore) { bestScore = score; bestProd = prod; }
    }
  }
  if (bestProd && bestScore > 0) {
    const tieneIngredientes = bestProd.ingredientes && bestProd.ingredientes.length > 0;
    const ingredientesTexto = tieneIngredientes
      ? bestProd.ingredientes.map((i: string) => `• ${i}`).join("\n")
      : "No tengo información detallada de ingredientes para este producto.";
    // Guardar el producto consultado para cuando el cliente confirme con "sí"
    if (!currentOrder) {
      createOrUpdateOrder(phone, []);
      currentOrder = getOrder(phone)!;
    }
    currentOrder.pendingProductQuery = { id: bestProd.id, nombre: bestProd.nombre, precio: bestProd.precio };
    await sendWhatsAppMessage(phone,
      `*${bestProd.nombre}* lleva:\n\n${ingredientesTexto}\n\n¿Deseas pedirlo? 😊`
    );
    return res.sendStatus(200);
  }
}

if (lower === "test") {
  clearOrder(phone);
  createOrUpdateOrder(phone, []);
  const testOrder = getOrder(phone)!;
  testOrder.testMode = true;
  currentOrder = testOrder;
  await setTestMode(phone, true);
  await sendWhatsAppMessage(phone, "Modo test activado ✅ El horario de atención no aplica.");
  if (tieneUltimoPedido) {
    await sendWhatsAppButtons(phone,
      MSG_BIENVENIDA_RECURRENTE(customer!.name?.trim() || undefined) + CREBOT_SUFFIX,
      [
        { id: "a", title: "Pedido anterior 🔄" },
        { id: "b", title: "Pedir algo nuevo 🥞" },
        { id: "3", title: "Otros 💬" }
      ]
    );
  } else {
    await sendWhatsAppButtons(phone,
      MSG_BIENVENIDA_NUEVO + CREBOT_SUFFIX,
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
  if (tieneUltimoPedido) {
    await sendWhatsAppButtons(phone,
      MSG_BIENVENIDA_RECURRENTE(customer!.name?.trim() || undefined) + CREBOT_SUFFIX,
      [
        { id: "a", title: "Pedido anterior 🔄" },
        { id: "b", title: "Pedir algo nuevo 🥞" },
        { id: "3", title: "Otros 💬" }
      ]
    );
  } else {
    await sendWhatsAppButtons(phone,
      MSG_BIENVENIDA_NUEVO + CREBOT_SUFFIX,
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
  if (!isWithinBusinessHours("domicilio") && !customer?.test_mode) {
    await sendWhatsAppMessage(phone,
      "Gracias por tu pedido 😊\n\n" +
      "En este momento estamos fuera de horario de atención.\n\n" +
      "🕐 Nuestro horario:\n" +
      "• Lunes a viernes: 3:00 PM – 10:15 PM\n" +
      "• Sábados, domingos y festivos: 12:00 M – 10:15 PM\n\n" +
      "Vuelve a enviarnos el pedido cuando abramos y lo procesamos 😊"
    );
    return res.sendStatus(200);
  }
  const sucursalPrevia = currentOrder?.sucursal;
  const hcParsed = parseOlaClickText(text);

  clearOrder(phone);
  createOrUpdateOrder(phone, []);
  const orderHC = getOrder(phone)!;
  orderHC.holaclick_order = text;
  orderHC.tipoEntrega = hcParsed.tipoServicio === "domicilio" ? "domicilio" : "recoger";

  // Poblar nombre, dirección, ítems y coordenadas desde el parser
  const hcNombre = hcParsed.nombre || customer?.name || "";
  if (hcNombre) updateOrderName(phone, hcNombre);
  if (hcParsed.direccion) orderHC.direccion = hcParsed.direccion;
  if (orderHC.tipoEntrega === "recoger") {
    orderHC.valorDomicilio = 0;
  }
  if (hcParsed.coordLat && hcParsed.coordLng) {
    orderHC.locationCoords = {
      latitude: parseFloat(hcParsed.coordLat),
      longitude: parseFloat(hcParsed.coordLng)
    };
  }
  if (hcParsed.items.length > 0) {
    createOrUpdateOrder(phone, hcParsed.items.map(i => ({
      producto:      i.producto,
      cantidad:      i.cantidad,
      precio:        i.precio,
      observaciones: i.observaciones,
      extras:        i.extras
    })));
  }
  currentOrder = getOrder(phone)!;

  if (sucursalPrevia) {
    currentOrder.sucursal = sucursalPrevia;

    // Calcular domicilio con coordenadas GPS
    if (orderHC.tipoEntrega === "domicilio" && orderHC.locationCoords) {
      try {
        const coordStr = `${orderHC.locationCoords.latitude},${orderHC.locationCoords.longitude}`;
        const calculo = await calcularDomicilio(coordStr, sucursalPrevia, hcParsed.totalAPagar);
        orderHC.valorDomicilio = calculo.valorDomicilio;
        orderHC.distanciaKm = calculo.distanciaKm;
        orderHC.domicilioTexto = calculo.descripcion;
      } catch (e) {
        console.error("❌ Error calculando domicilio HC:", e);
        orderHC.valorDomicilio = 4500;
      }
    }

    const subtotalHC = hcParsed.totalAPagar - (hcParsed.entrega ?? 0);
    const domicilioHC = orderHC.valorDomicilio ?? 0;
    const totalHC = subtotalHC + domicilioHC;
    const hcItemsList = hcParsed.items.map(i => {
      const extrasTexto = i.extras.filter(e => e.nombre).map(e =>
        `+${e.nombre}${e.precio > 0 ? ` $${e.precio.toLocaleString("es-CO")}` : ""}`
      ).join(", ");
      return `• ${i.producto} ×${i.cantidad} — $${i.precio.toLocaleString("es-CO")}` +
        (extrasTexto ? `\n  ${extrasTexto}` : "") +
        (i.observaciones ? `\n  📝 ${i.observaciones}` : "");
    }).join("\n");

    const hcBodyPago =
      "Gracias por tu pedido en OlaClick ✅\n\n" +
      (hcItemsList ? `🧾 Tu pedido:\n${hcItemsList}\n\n` : "") +
      `💰 Subtotal: $${subtotalHC.toLocaleString("es-CO")}\n` +
      (orderHC.tipoEntrega === "domicilio"
        ? `🛵 Domicilio: $${domicilioHC.toLocaleString("es-CO")}` +
          (orderHC.domicilioTexto ? ` (${orderHC.domicilioTexto})` : "") + "\n"
        : "") +
      `💵 Total: $${totalHC.toLocaleString("es-CO")}\n\n` +
      "¿Cómo deseas pagar?";

    updateOrderStep(phone, "esperando_pago_holaclick");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone, hcBodyPago, [
      { id: "efectivo", title: "Efectivo 💵" },
      { id: "nequi", title: "Nequi/Daviplata 📱" },
      { id: "bancolombia", title: "Bancolombia/Llave🏦" }
    ]);
  } else {
    updateOrderStep(phone, "esperando_sucursal_holaclick");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppMessage(phone, "Gracias por tu orden en OlaClick, vamos a procesarla 🥞");
    const msgSucursalHC = orderHC.tipoEntrega === "recoger"
      ? "¿En qué sucursal vas a recoger?"
      : "¿Desde qué sucursal deseas tu domicilio?";
    await sendWhatsAppButtons(phone,
      msgSucursalHC,
      [
        { id: "la_villa", title: "La Villa 🏪" },
        { id: "circunvalar", title: "Av. Circunvalar 🏪" }
      ]
    );
  }
  return res.sendStatus(200);
}

if (text.includes("PEDIDO - LAS CREPES")) {
  const cdParsed = parseCartaDigitalText(text);

  const prevTipoEntrega = currentOrder?.tipoEntrega;
  const prevSucursal    = currentOrder?.sucursal;

  clearOrder(phone);
  createOrUpdateOrder(phone, []);
  const orderCD = getOrder(phone)!;

  if (prevTipoEntrega) orderCD.tipoEntrega = prevTipoEntrega;
  if (prevSucursal)    orderCD.sucursal    = prevSucursal;

  // Excluir "extras" para evitar colisiones de nombre con crepes (ej. "Nutella" extra vs crepe Nutella)
  const allMenuProdsCD = (menu.categorias as any[])
    .filter((c: any) => c.id !== "extras")
    .reduce((acc: any[], c: any) => acc.concat(c.productos), []);

  if (cdParsed.items.length > 0) {
    createOrUpdateOrder(phone, cdParsed.items.map(i => {
      const normNombre = normalizeText(i.producto);
      const found = allMenuProdsCD.find((p: any) => {
        const candidates = [p.nombre, ...(p.aliases || [])].map((a: string) => normalizeText(a));
        return candidates.some((c: string) => c === normNombre || normNombre.includes(c));
      });
      let precio = i.precio;
      if (found) {
        let menuPrecio = found.precio;
        if (i.variante && found.variantes?.length) {
          const normVariante = normalizeText(i.variante);
          const foundVariant = found.variantes.find((v: any) => {
            const vCandidates = [v.nombre, ...(v.aliases || [])].map((a: string) => normalizeText(a));
            return vCandidates.some((c: string) => c === normVariante || normVariante.includes(c));
          });
          menuPrecio = foundVariant?.precio ?? found.precio;
        }
        // Solo corregir si la carta trae precio $0 (ítem gratuito / manipulación)
        if (precio === 0) {
          precio = menuPrecio;
        }
      }
      const cantidad = Math.max(1, Math.min(20, i.cantidad || 1));
      return {
        producto:      i.producto,
        variante:      i.variante,
        cantidad,
        precio,
        observaciones: i.observaciones,
        extras:        i.extras
      };
    }));
  }

  currentOrder = getOrder(phone)!;
  currentOrder.vieneDeCarta = true;
  updateOrderStep(phone, "post_agregar_producto");
  currentOrder = getOrder(phone)!;

  const totalesCD = calculateTotal(currentOrder);
  const preciosAjustados = totalesCD.subtotal !== cdParsed.total;
  const resumenCD = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
  await sendWhatsAppButtons(phone,
    `🥞 *Tu pedido de la carta digital:*\n\n${resumenCD}\n\n*Subtotal: $${totalesCD.subtotal.toLocaleString("es-CO")}*` +
    (preciosAjustados ? "\n⚠️ _Precios verificados con nuestro menú._" : "") +
    `\n\n¿Qué deseas hacer?`,
    [
      { id: "confirmar",   title: "Confirmar ✅" },
      { id: "agregar_mas", title: "Agregar más ➕" },
      { id: "eliminar",    title: "Eliminar ➖" }
    ]
  );
  return res.sendStatus(200);
}

    console.log("=== DIAGNÓSTICO ===");
console.log("CUSTOMER:", customer?.name);
console.log("CURRENT ORDER:", currentOrder?.step);
console.log("LOWER:", lower);
console.log("===================");

// Redirigir a asesor cuando el cliente pide ayuda durante el pedido
if (
  (currentOrder?.step === "armando_pedido" || currentOrder?.step === "post_agregar_producto") &&
  (lower === "ayuda" || lower === "ayudarme" || lower === "necesito ayuda" ||
   lower === "hablar con asesor" || lower === "quiero un asesor" || lower.startsWith("ayudarme"))
) {
  await sendWhatsAppMessage(phone,
    "Con gusto te ayudo 😊\n\nCuéntame en qué puedo ayudarte.\n\nSi necesitas hablar con un asesor puedes escribirnos al 📱 *315 191 3928*\n\no llamar directamente a una de nuestras sedes:\n📞 La Villa: *606 341 3020*\n📞 Circunvalar: *606 345 0257*"
  );
  return res.sendStatus(200);
}

if (
  currentOrder?.step === "armando_pedido" &&
  parsedItems.length === 0 &&
  !parseResult.ambiguousChoice
) {
  // Detectar preguntas de disponibilidad de producto (¿manejan X?, ¿tienen X?, etc.)
  const esPreguntaExistencia =
    text.includes("?") && (
      lower.includes("manejan") ||
      lower.includes("venden") ||
      lower.includes("preparan") ||
      lower.includes("tienen ") ||
      lower.includes("¿tienen") ||
      lower.startsWith("tienen ") ||
      lower.includes("¿hay ") ||
      lower.startsWith("hay ")
    );
  if (esPreguntaExistencia) {
    const matchProd =
      lower.match(/manejan\s+([^?.,!]+)/) ||
      lower.match(/venden\s+([^?.,!]+)/) ||
      lower.match(/tienen\s+([^?.,!]+)/) ||
      lower.match(/preparan\s+([^?.,!]+)/) ||
      lower.match(/hay\s+([^?.,!]+)/);
    const productoConsulta = matchProd?.[1]?.trim() || "ese producto";
    await sendWhatsAppMessage(phone,
      `Lo sentimos, no manejamos ${productoConsulta} 😊\n\n¿Deseas agregar otro producto a tu pedido?`
    );
    return res.sendStatus(200);
  }

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
        [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
      );
      return res.sendStatus(200);
    }
    if (aiClassification.intent === "extra" && currentOrder.items.length > 0) {
      const lastItem = currentOrder.items[currentOrder.items.length - 1];
      lastItem.extras = lastItem.extras || [];
      lastItem.extras.push({ nombre: aiClassification.nombre, precio: aiClassification.precio, cantidad: 1 });
      await sendWhatsAppButtons(phone,
        `Agregado ✅ ${aiClassification.nombre} (+$${aiClassification.precio.toLocaleString("es-CO")})\n\n¿Algo más?`,
        [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
      );
      return res.sendStatus(200);
    }
    if (aiClassification.intent === "ambiguo" && aiClassification.opciones.length > 0) {
      const cantOriginalAI = parseInt(lower.match(/^(\d+)\s/)?.[1] || "") || 1;
      setPendingClarification(phone, aiClassification.opciones, cantOriginalAI);
      updateOrderStep(phone, "esperando_aclaracion_producto");
      currentOrder = getOrder(phone)!;
      replyMessage = "¿Te refieres a:\n\n" +
        aiClassification.opciones.map((op: any, i: number) => `${i + 1}. ${op.nombre}`).join("\n")
        "\n\nRespóndeme con el número 😊";
      await sendWhatsAppMessage(phone, replyMessage);
      return res.sendStatus(200);
    }
  }

  // Consulta de precio/domicilio durante el armado del pedido
  if (
    lower.includes("cuánto") || lower.includes("cuanto") ||
    lower.includes("precio") || lower.includes("cuesta") ||
    lower.includes("domicilio") && (lower.includes("cuánto") || lower.includes("cuanto") || lower.includes("costo") || lower.includes("valor"))
  ) {
    const orderActual = getOrder(phone)!;
    if (orderActual.items.length > 0) {
      const totals = calculateTotal(orderActual);
      const domicilioTexto = orderActual.tipoEntrega === "domicilio"
        ? `\n🚚 Domicilio estimado: $${(orderActual.valorDomicilio ?? 4500).toLocaleString("es-CO")} (puede variar según dirección)`
        : "";
      await sendWhatsAppMessage(phone,
        `💰 Tu pedido hasta ahora:\n\n` +
        orderActual.items.map((item: any) => formatLineaItem(item, true)).join("\n") +
        `\n\n💵 Subtotal: $${totals.subtotal.toLocaleString("es-CO")}` +
        domicilioTexto +
        `\n\n¿Deseas agregar algo más o confirmamos? 😊`
      );
    } else {
      await sendWhatsAppMessage(phone, "Aún no tienes productos en tu pedido 😊 ¿Qué deseas pedir?");
    }
    return res.sendStatus(200);
  }

  // Solicitud de ver menú en medio del pedido
  if (lower === "2" || lower.includes("menu") || lower.includes("menú") || lower.includes("carta") || lower === "ver menu") {
    await sendWhatsAppMessage(phone,
      "Aquí tienes el menú completo 📋\n\nhttps://menu.tecmenu.com\n\n 😊"
    );
    return res.sendStatus(200);
  }

  // Modificador de producto sin clasificación IA (sin/poco/bien/con ...) → asociar al último ítem
  if (currentOrder.items.length > 0 && /^(sin|poco|bien|con|extra)\s+\S/i.test(text.trim())) {
    const lastItem = currentOrder.items[currentOrder.items.length - 1];
    lastItem.observaciones = lastItem.observaciones
      ? `${lastItem.observaciones}, ${text.trim()}`
      : text.trim();
    await sendWhatsAppButtons(phone,
      `Anotado ✅ "${text.trim()}"\n\n¿Algo más?`,
      [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
    );
    return res.sendStatus(200);
  }

  // ── Fallback inteligente: múltiples interpretaciones antes de rendirnos ──────

  // 0. Confirmación post-link OlaClick con carrito vacío ("ok", "sí", "por acá", etc.)
  const CONFIRM_POST_LINK = new Set(["ok", "si", "sí", "dale", "listo", "por aca", "por aqui", "por acá", "por aquí", "mejor aqui", "mejor aquí", "aqui", "aquí"]);
  if (CONFIRM_POST_LINK.has(lower) && currentOrder.items.length === 0) {
    await sendWhatsAppMessage(phone,
      "Perfecto 😊 ¿Qué deseas pedir?\n\nEscríbeme el producto, por ejemplo:\n• 1 Hawaiana\n• 1 Ranchera Mixta\n• 2 París"
    );
    return res.sendStatus(200);
  }

  // 1. Botón enviado como texto plano
  const esConfirmar = new Set(["confirmar", "1", "listo", "ok", "dale", "si", "sí", "okay", "perfecto", "confirmo", "vamos", "de una", "adelante", "va"]).has(lower);
  const esNadaMas = lower === "no" || lower === "nada" || lower === "nada más" || lower === "nada mas" || lower === "eso es todo" || lower === "es todo" || lower === "con eso" || lower === "ya está" || lower === "ya esta" || lower === "eso" || lower === "suficiente";
  if (esNadaMas && currentOrder.items.length > 0) {
    // Tratar igual que Confirmar
    updateOrderStep(phone, "post_agregar_producto");
    currentOrder = getOrder(phone)!;
    const resumenNada = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
    await sendWhatsAppButtons(phone,
      "Tu pedido hasta ahora:\n\n" + resumenNada + "\n\n¿Qué deseas hacer?",
      [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
    );
    return res.sendStatus(200);
  }
  const esAgregarMas = lower === "agregar_mas" || lower === "agregar más" || lower === "agregar mas" || lower === "agregar" || lower === "más" || lower === "mas";
  const esEliminar = lower === "eliminar" || lower === "borrar" || lower === "quitar" || lower === "eliminar producto";

  if (esConfirmar && currentOrder.items.length > 0) {
    updateOrderStep(phone, "post_agregar_producto");
    currentOrder = getOrder(phone)!;
    const resumenFallback = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
    await sendWhatsAppButtons(phone,
      "Tu pedido hasta ahora:\n\n" + resumenFallback + "\n\n¿Qué deseas hacer?",
      [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
    );
    return res.sendStatus(200);
  }

  if (esAgregarMas) {
    await sendWhatsAppMessage(phone, "¿Qué más deseas agregar? 😊 Escríbeme el producto.");
    return res.sendStatus(200);
  }

  if (esEliminar && currentOrder.items.length > 0) {
    updateOrderStep(phone, "retirando_productos");
    currentOrder = getOrder(phone)!;
    const listaEliminar = currentOrder.items.map((item: any, idx: number) =>
      `${idx + 1}. ${item.cantidad}x ${item.producto}${item.variante ? " – " + item.variante : ""}`
    ).join("\n");
    await sendWhatsAppMessage(phone, "¿Cuál producto deseas eliminar?\n\n" + listaEliminar + "\n\nEscribe el número del producto.");
    return res.sendStatus(200);
  }

  // 1b. Detección de helado (1 o 2 bolas) → agregar como extra del último ítem
  if (currentOrder.items.length > 0 && (lower.includes("helado") || /\bbolas?\b/.test(lower))) {
    const dosBolas = lower.includes("2 bola") || lower.includes("dos bola") ||
      lower.includes("2 bolas") || lower.includes("dos bolas");
    const heladoNombre = dosBolas ? "Helado 2 bolas" : "Helado 1 bola";
    const heladoPrecio = dosBolas ? 8000 : 5500;
    const lastItemH = currentOrder.items[currentOrder.items.length - 1];
    lastItemH.extras = lastItemH.extras || [];
    if (!lastItemH.extras.find((e: any) => e.nombre === heladoNombre)) {
      lastItemH.extras.push({ nombre: heladoNombre, precio: heladoPrecio, cantidad: 1 });
    }
    await sendWhatsAppButtons(phone,
      `Agregado ✅ ${heladoNombre} (+$${heladoPrecio.toLocaleString("es-CO")})\n\n¿Algo más?`,
      [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
    );
    return res.sendStatus(200);
  }

  // 2. Detección de extra/adición por keyword
  const EXTRAS_MAP: { keywords: string[]; nombre: string; precio: number }[] = [
    { keywords: ["tocineta", "tocino", "bacon"],                       nombre: "Tocineta",     precio: 5500 },
    { keywords: ["champiñon", "champinon", "champiñones", "hongos"],   nombre: "Champiñones",  precio: 4500 },
    { keywords: ["maiz", "maíz", "elote"],                             nombre: "Maíz tierno",  precio: 3500 },
    { keywords: ["piña", "pina", "anana"],                             nombre: "Piña",         precio: 2000 },
    { keywords: ["jalapeño", "jalapeno", "jalapeños"],                 nombre: "Jalapeños",    precio: 2000 },
    { keywords: ["fresa", "fresas", "frutilla"],                       nombre: "Fresa",        precio: 3000 },
    { keywords: ["banano", "banana", "guineo", "cambur"],              nombre: "Banano",       precio: 2000 },
    { keywords: ["durazno", "melocoton"],                              nombre: "Durazno",      precio: 3900 },
    { keywords: ["manzana"],                                            nombre: "Manzana",      precio: 2500 },
  ];
  const esAdicion = lower.includes("con ") || lower.includes("adicion") || lower.includes("adición") ||
    lower.includes("agregar ") || lower.includes("añadir") || lower.includes("añade") || lower.startsWith("extra ");
  if (currentOrder.items.length > 0) {
    const extraMatch = EXTRAS_MAP.find(e => e.keywords.some(k => lower.includes(k)));
    if (extraMatch && (esAdicion || lower.split(" ").length <= 3)) {
      const lastItem = currentOrder.items[currentOrder.items.length - 1];
      lastItem.extras = lastItem.extras || [];
      const yaExiste = lastItem.extras.find((e: any) => e.nombre === extraMatch.nombre);
      if (!yaExiste) {
        lastItem.extras.push({ nombre: extraMatch.nombre, precio: extraMatch.precio, cantidad: 1 });
      }
      await sendWhatsAppButtons(phone,
        `Agregado ✅ ${extraMatch.nombre} (+$${extraMatch.precio.toLocaleString("es-CO")})\n\n¿Algo más?`,
        [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
      );
      return res.sendStatus(200);
    }
  }

  // 3. Texto largo (≥4 palabras) → guardar como observación general
  const palabrasFallback = text.trim().split(/\s+/);
  if (palabrasFallback.length >= 4 && currentOrder.items.length > 0) {
    const obsActual = currentOrder.observacionesGenerales;
    currentOrder.observacionesGenerales = obsActual
      ? `${obsActual}. ${text.trim()}`
      : text.trim();
    await sendWhatsAppButtons(phone,
      `Anotado ✅ "${text.trim()}"\n\n¿Algo más?`,
      [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
    );
    return res.sendStatus(200);
  }

  // 4. Cómo pedir
  if (lower.includes("como pedir") || lower.includes("cómo pedir")) {
    replyMessage =
      "Claro 😊\n\n" +
      "Puedes escribir tu pedido así:\n" +
      "• 1 Hawaiana\n" +
      "• 1 París sin queso\n" +
      "• 2 Ranchera\n\n" +
      "Por ahora te recomiendo agregar un producto por mensaje para que salga perfecto.\n\n" +
      "Si necesitas hablar con un asesor puedes escribirnos al 📱 315 191 3928";
    await sendWhatsAppMessage(phone, replyMessage);
    return res.sendStatus(200);
  }

  // 5. Solicitud genérica de crepe ("otra", "una más", "lo mismo", etc.)
  const SOLICITUD_GENERICA_PATTERNS = ["otra", "otro", "una mas", "uno mas", "un mas", "una más", "uno más", "un más", "lo mismo", "igual", "quiero otra", "quiero otro", "quiero mas", "quiero más"];
  const esGenerico = lower === "crepe" || SOLICITUD_GENERICA_PATTERNS.some(p => lower === p || lower.includes(p));
  if (esGenerico) {
    await sendWhatsAppMessage(phone,
      "¿Qué crepe deseas agregar? 😊\n\nEj: Hawaiana, Ranchera, París, Pollo y Champiñones, Especial..."
    );
    return res.sendStatus(200);
  }

  // 6. Último recurso — probar Gemini como fallback conversacional
  if (tipoMensaje === "text" && !SKIP_AI_KEYWORDS.has(lower) && aiClassification === null) {
    try {
      const currentItemsFB = currentOrder?.items.map((i: any) => ({ producto: i.producto, precio: i.precio, variante: i.variante })) || [];
      const geminiFB = await classifyWithAI(text, currentItemsFB, currentOrder?.step || "");
      if (geminiFB?.intent === "pregunta" && geminiFB.respuesta) {
        await sendWhatsAppMessage(phone, geminiFB.respuesta);
        return res.sendStatus(200);
      }
    } catch (e) { console.error("❌ Error Gemini fallback:", e); }
  }
  if (currentOrder?.step === "armando_pedido") {
    const quierePedirPorAca =
      lower.includes("por aca") || lower.includes("por acá") ||
      lower.includes("por aqui") || lower.includes("por aquí") ||
      lower.includes("puedo hacerlo") || lower.includes("puedo pedirlo") ||
      lower.includes("puedo ordenar") || lower.includes("puedo pedir");
    if (quierePedirPorAca) {
      await sendWhatsAppMessage(phone,
        "¡Claro que sí! 😊 Puedes hacer tu pedido aquí mismo.\n\n" +
        "Escríbeme qué deseas pedir así:\n" +
        "• 1 Hawaiana\n" +
        "• 2 Ranchera\n" +
        "• 1 Especial"
      );
      return res.sendStatus(200);
    }
    currentOrder.armandoFallbacks = (currentOrder.armandoFallbacks || 0) + 1;
    if (currentOrder.armandoFallbacks >= 3) {
      currentOrder.armandoFallbacks = 0;
      updateOrderStep(phone, "esperando_asesor");
      currentOrder = getOrder(phone)!;
      const nombreAsesor = currentOrder.nombre || customer?.name || phone;
      const msgReenvio = `💬 CLIENTE SIN ENTENDER\n\n👤 ${nombreAsesor}\n📞 ${phone}\n💬 "${text}"`;
      try { await sendWhatsAppMessage("573151913928", msgReenvio); } catch(e) {}
      await sendWhatsAppMessage(phone,
        "Te comunico con un asesor 😊 En breve alguien te ayudará.\n\nO llámanos directamente:\n📞 La Villa: 606 341 3020 | Circunvalar: 606 345 0257"
      );
      return res.sendStatus(200);
    }
  }
  replyMessage =
    "No logré entender bien tu pedido 😅\n\n" +
    "Puedes escribirlo así:\n" +
    "• 1 Hawaiana\n" +
    "• 2 Ranchera\n" +
    "• 1 Especial\n\n" +
    "O escribe ayuda 😊";
  await sendWhatsAppMessage(phone, replyMessage);
  return res.sendStatus(200);
}

if (
  !sesionActiva &&
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
  const confirmedAt = currentOrder.confirmedAt ? new Date(currentOrder.confirmedAt).getTime() : currentOrder.lastInteraction;
  const twoHoursMs = 2 * 60 * 60 * 1000;
  if (Date.now() - confirmedAt < twoHoursMs) {
    const nombreConf = currentOrder.nombre || customer?.name || "";
    await sendWhatsAppButtons(phone,
      `Hola de nuevo${nombreConf ? " " + nombreConf : ""} 😊 Tu pedido está en proceso 🔥\n\n¿Deseas hacer algo más?`,
      [
        { id: "nuevo_pedido_conf", title: "Nuevo pedido 🥞" },
        { id: "hablar_asesor_conf", title: "Hablar con asesor 💬" }
      ]
    );
    return res.sendStatus(200);
  }

  createOrUpdateOrder(phone, []);
  updateOrderStep(phone, "esperando_menu_principal");
  currentOrder = getOrder(phone)!;

  if (tieneUltimoPedido) {
await sendWhatsAppButtons(phone,
   MSG_BIENVENIDA_RECURRENTE(customer?.name?.trim() || undefined) + CREBOT_SUFFIX,
  [
    { id: "a", title: "Pedido anterior 🔄" },
    { id: "b", title: "Pedir algo nuevo 🥞" },
    { id: "3", title: "Otros 💬" }
  ]
);
return res.sendStatus(200);
  } else {
   await sendWhatsAppButtons(phone,
  MSG_BIENVENIDA_NUEVO + CREBOT_SUFFIX,
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
    // Agregar los ítems no-ambiguos al carrito antes de pedir la aclaración
    if (parsedItems.length > 0) {
      createOrUpdateOrder(phone, parsedItems);
    }
    const cantOriginalParser = parseInt(lower.match(/^(\d+)\s/)?.[1] || "") || 1;
    setPendingClarification(phone, parseResult.ambiguousChoice.opciones, cantOriginalParser);
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

// Safety net: si hay pedido activo con items, nunca mostrar menú de bienvenida
if (currentOrder && currentOrder.items.length > 0 &&
  (currentOrder.step === "esperando_menu_principal" || currentOrder.step === "esperando_menu_nuevo")
) {
  const resumenSN = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
  updateOrderStep(phone, "post_agregar_producto");
  currentOrder = getOrder(phone)!;
  await sendWhatsAppButtons(phone,
    "Tu pedido hasta ahora:\n\n" + resumenSN + "\n\n¿Qué deseas hacer?",
    [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
  );
  return res.sendStatus(200);
}

if (!currentOrder) {
  if (lower === "2" || lower.includes("menu") || lower.includes("menú") || lower.includes("ver menu") || lower.includes("carta")) {
    await sendWhatsAppButtons(phone,
      "Aquí puedes ver nuestro menú completo 📋\n\nhttps://menu.tecmenu.com\n\n¿Deseas hacer un pedido?",
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
  if (tieneUltimoPedido) {
    const bodyMsg = MSG_BIENVENIDA_RECURRENTE(customer?.name?.trim() || undefined) + CREBOT_SUFFIX;
    await sendWhatsAppButtons(phone,
      bodyMsg,
      [
       { id: "a", title: "Pedido anterior 🔄" },
       { id: "b", title: "Pedir algo nuevo 🥞" },
       { id: "3", title: "Otros 💬" }
      ]
    );
    return res.sendStatus(200);
  } else {
    await sendWhatsAppButtons(phone,
      MSG_BIENVENIDA_NUEVO + CREBOT_SUFFIX,
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

  let seleccion: { nombre: string; productoId: string } | undefined;
  let cantidadSeleccion = currentOrder.aclaracionPendiente?.cantidad ?? 1;

  // Primero: detectar "2 rancheras mixtas" → cantidad=2 + nombre de producto
  // Evita que "2" se interprete como índice de opción cuando hay nombre después
  const cantNombreMatch = lower.match(/^(\d+)\s+(.+)/);
  if (cantNombreMatch) {
    const posNombre = normalizeText(cantNombreMatch[2]);
    const opByName = opciones.find((op: any) => {
      const opNorm = normalizeText(op.nombre);
      return opNorm.includes(posNombre) || posNombre.includes(opNorm) ||
        posNombre.split(/\s+/).some((w: string) => w.length >= 3 && opNorm.includes(w));
    });
    if (opByName) {
      seleccion = opByName;
      cantidadSeleccion = parseInt(cantNombreMatch[1]);
    }
  }

  // Si no se resolvió por "cantidad + nombre", intentar por número índice o nombre parcial
  if (!seleccion) {
    const numSeleccion = parseInt(lower) - 1;
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
          cantidad: cantidadSeleccion,
          precio: product.precio,
          extras: []
        }
      ]);

      updateOrderStep(phone, "post_agregar_producto");
      currentOrder = getOrder(phone)!;

      const resumen = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");

      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nEstoy registrando:\n\n" + resumen + "\n\n¿Qué deseas hacer?",
        [
          { id: "confirmar",   title: "✅ Confirmar" },
          { id: "eliminar",    title: "🗑️ Quitar" },
          { id: "4",           title: "📝 Observación" }
        ]
      );
      return res.sendStatus(200);
    } else {
      // Producto no encontrado — verificar si es una observación o modificador
      const esObsAclaracion = /^(sin|con|extra|poco|bien|deslechada|picante|sin cebolla|sin queso|sin salsa)\b/i.test(lower) ||
        /\b(sin|con extra|poco|bien cremada|deslechada)\b/i.test(lower);
      if (esObsAclaracion && currentOrder.items.length > 0) {
        // Guardar como observación del último ítem y confirmar
        const lastItem = currentOrder.items[currentOrder.items.length - 1];
        lastItem.observaciones = lastItem.observaciones
          ? `${lastItem.observaciones}, ${text.trim()}`
          : text.trim();
        clearPendingClarification(phone);
        updateOrderStep(phone, "post_agregar_producto");
        currentOrder = getOrder(phone)!;
        const resumenObs = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
        await sendWhatsAppButtons(phone,
          `Anotado ✅ "${text.trim()}"\n\n${resumenObs}\n\n¿Qué deseas hacer?`,
          [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
        );
      } else {
        await sendWhatsAppMessage(phone,
          `No pude encontrar esa opción 😊 Por favor elige:\n\n` +
          opciones.map((op: any, i: number) => `${i + 1}. ${op.nombre}`).join("\n")
        );
      }
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

    // Si llega un saludo → cliente quiere empezar de nuevo, borrar pendiente
    const esGreetingVariante =
      lower === "hola" || lower === "hi" || lower === "buenas" ||
      lower.startsWith("hola ") || lower.startsWith("buenas ") ||
      lower.includes("buen dia") || lower.includes("buen día");
    if (esGreetingVariante) {
      currentOrder.pendingProduct = undefined;
      currentOrder.itemsPendientes = undefined;
      updateOrderStep(phone, "armando_pedido");
      currentOrder = getOrder(phone)!;
      const resumenActualGV = currentOrder.items.length > 0
        ? currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n") + "\n\n¿Qué más deseas agregar?"
        : "¿Qué deseas pedir? 😊";
      await sendWhatsAppMessage(phone, resumenActualGV);
      return res.sendStatus(200);
    }

    // Buscar variante por id del botón o por texto
    let varianteElegida = variantes.find((v: any) => lower === `variante_${v.id}`);
    if (!varianteElegida) {
      varianteElegida = variantes.find((v: any) =>
        v.aliases?.some((a: string) => lower.includes(a)) ||
        lower.includes(v.nombre.toLowerCase())
      );
    }

    if (varianteElegida) {
      // Recuperar cantidad de la cola si existe, sino 1
      const cantidadVar = currentOrder.itemsPendientes?.find((i: any) => i.productoId === pending.id)?.cantidad ?? 1;
      createOrUpdateOrder(phone, [
        {
          producto: pending.nombre,
          cantidad: cantidadVar,
          precio: varianteElegida.precio,
          variante: varianteElegida.nombre,
          extras: []
        }
      ]);
      currentOrder.pendingProduct = undefined;
      // Sacar este item de la cola
      if (currentOrder.itemsPendientes) {
        const idx = currentOrder.itemsPendientes.findIndex((i: any) => i.productoId === pending.id);
        if (idx >= 0) currentOrder.itemsPendientes.splice(idx, 1);
      }

      // Preguntas post-variante (mexicana → jalapeños, dulces → queso)
      if (pending.id === "mexicana") {
        updateOrderStep(phone, "esperando_jalapenos");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          `¿Deseas tu ${pending.nombre} con jalapeños o sin jalapeños?`,
          [{ id: "con_jalapenos", title: "Con jalapeños 🌶️" }, { id: "sin_jalapenos", title: "Sin jalapeños" }]
        );
        return res.sendStatus(200);
      }
      if (["nutella_crepe","chocolate_crepe","arequipe_crepe"].includes(pending.id)) {
        updateOrderStep(phone, "esperando_queso_dulce");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          `¿Deseas tu ${pending.nombre} con queso o sin queso? 🧀`,
          [{ id: "con_queso_dulce", title: "Con queso 🧀" }, { id: "sin_queso_dulce", title: "Sin queso" }]
        );
        return res.sendStatus(200);
      }

      // Si quedan items en la cola que necesitan variante → preguntar el siguiente
      if (currentOrder.itemsPendientes && currentOrder.itemsPendientes.length > 0) {
        const nextPendingId = currentOrder.itemsPendientes[0].productoId;
        const allProductsQ = (menu.categorias as any[]).reduce((acc: any[], c: any) => acc.concat(c.productos), []);
        const nextProd = allProductsQ.find((p: any) => p.id === nextPendingId);
        if (nextProd && nextProd.variantes?.length > 0) {
          currentOrder.pendingProduct = { id: nextProd.id, nombre: nextProd.nombre, precio: nextProd.precio };
          updateOrderStep(phone, "esperando_variante_producto");
          currentOrder = getOrder(phone)!;
          const nextBotones = nextProd.variantes.slice(0, 3).map((v: any) => ({
            id: `variante_${v.id}`,
            title: `${v.nombre} $${v.precio.toLocaleString("es-CO")}`
          }));
          let nextPregunta = `¿Cómo deseas tu ${nextProd.nombre}?`;
          if (nextProd.id === "malteada") nextPregunta = `¿Qué sabor de malteada deseas?`;
          else if (nextProd.id === "limonada") nextPregunta = `¿Qué limonada deseas?`;
          else if (nextProd.id === "vegetariana") nextPregunta = `¿Qué salsa deseas para tu ${nextProd.nombre}?\n\n⚠️ La salsa bechamel contiene caldo de pollo.`;
          await sendWhatsAppButtons(phone, nextPregunta, nextBotones);
          return res.sendStatus(200);
        }
      }

      // Cola vacía — flujo normal
      currentOrder.itemsPendientes = undefined;
      updateOrderStep(phone, "post_agregar_producto");
      currentOrder = getOrder(phone)!;

      const resumen = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");

      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nEstoy registrando:\n\n" + resumen + "\n\n¿Qué deseas hacer?",
        [
          { id: "confirmar",   title: "✅ Confirmar" },
          { id: "eliminar",    title: "🗑️ Quitar" },
          { id: "4",           title: "📝 Observación" }
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

  if (tieneUltimoPedido) {

    if (
      lower === "a" ||
      lower.includes("lo mismo") ||
      lower.includes("igual") ||
      lower.includes("el mismo")
    ) {

      if (customer!.last_order) {
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

        const resumen = order.items.map((item: any) => formatLineaItem(item)).join("\n");

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
      lower === "confirmar" ||
      lower.includes("nuevo") ||
      lower.includes("diferente") ||
      lower.includes("otra cosa")
    ) {
      updateOrderStep(phone, "esperando_tipo_entrega");
      currentOrder = getOrder(phone)!;
      // Limpiar carrito anterior para empezar pedido nuevo
      currentOrder.items = [];
      currentOrder.direccion = undefined;
      currentOrder.tipoEntrega = undefined;
      currentOrder.valorDomicilio = undefined;
      currentOrder.formaPago = undefined;
      currentOrder.observacionesGenerales = undefined;
      currentOrder.observacionDireccion = undefined;
      currentOrder.upsellingFrutasMostrado = false;
      currentOrder.upsellingTocinetaMostrado = false;
      currentOrder.upsellingToppingsMostrado = false;

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
      replyMessage = "Con gusto te ayudo 😊\n\nCuéntame en qué puedo ayudarte.\n\nSi necesitas hablar con un asesor puedes escribirnos al 📱 *315 191 3928*\n\no llamar directamente a una de nuestras sedes:\n📞 La Villa: *606 341 3020*\n📞 Circunvalar: *606 345 0257*";
  } else {
      // Guard: sesión activa con items → re-mostrar resumen en vez de bienvenida
      if (sesionActiva) {
        const resumenGuard = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
        updateOrderStep(phone, "post_agregar_producto");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          "Tienes un pedido en proceso 😊\n\n" + resumenGuard + "\n\n¿Qué deseas hacer?",
          [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
        );
        return res.sendStatus(200);
      }
      if (tieneUltimoPedido) {
        await sendWhatsAppButtons(phone,
          "¿Qué deseas hacer?",
          [
            { id: "a", title: "Pedido anterior 🔄" },
            { id: "b", title: "Pedir algo nuevo 🥞" },
            { id: "3", title: "Otros 💬" }
          ]
        );
      } else {
        await sendWhatsAppButtons(phone,
          "¿Qué deseas hacer?",
          [
            { id: "1", title: "Hacer un pedido 🥞" },
            { id: "2", title: "Ver menu 📋" },
            { id: "3", title: "Otros 💬" }
          ]
        );
      }
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
    "Aquí puedes ver nuestro menú completo 📋\n\nhttps://menu.tecmenu.com\n\n¿Deseas hacer un pedido?",
    [
      { id: "1", title: "Hacer un pedido 🥞" },
      { id: "3", title: "Otros 💬" }
    ]
  );
  return res.sendStatus(200);

} else if (lower === "3" || lower.includes("otros") || lower.includes("ayuda") || lower.includes("pqr")) {
  updateOrderStep(phone, "esperando_ayuda");
  currentOrder = getOrder(phone)!;
  replyMessage =
    "Con gusto te ayudo 😊\n\nCuéntame en qué puedo ayudarte.\n\nSi necesitas hablar con un asesor puedes escribirnos al 📱 *315 191 3928*\n\no llamar directamente a una de nuestras sedes:\n📞 La Villa: *606 341 3020*\n📞 Circunvalar: *606 345 0257*";

} else {
  // Intentar parsear el texto como producto antes de mostrar botones
  const parseMenuPrincipal = parseOrder(lower);
  if (parseMenuPrincipal.items.length > 0 && !parseMenuPrincipal.ambiguousChoice) {
    createOrUpdateOrder(phone, parseMenuPrincipal.items);
    if (customer?.name && !getOrder(phone)?.nombre) updateOrderName(phone, customer.name);
    updateOrderStep(phone, "esperando_tipo_entrega");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone, "Perfecto 😊 ¿Cómo deseas recibir tu pedido?", [
      { id: "domicilio", title: "Domicilio 🛵" },
      { id: "recoger",   title: "Recoger en tienda 🏪" }
    ]);
    return res.sendStatus(200);
  }
  await sendWhatsAppButtons(phone,
    "¿Qué deseas hacer?",
    [
      { id: "1", title: "Hacer un pedido 🥞" },
      { id: "2", title: "Ver menú 📋" },
      { id: "3", title: "Otros 💬" }
    ]
  );
  return res.sendStatus(200);
}

} else if (currentOrder?.step === "esperando_sucursal_holaclick") {
  if (lower === "la_villa" || lower === "a" || lower.includes("villa")) {
    currentOrder.sucursal = "la_villa";
  } else if (lower === "circunvalar" || lower === "b" || lower.includes("circunvalar")) {
    currentOrder.sucursal = "circunvalar";
  } else if (!currentOrder.sucursal) {
    // Solo preguntar de nuevo si no se tiene sucursal guardada
    const msgHCSuc = currentOrder.tipoEntrega === "recoger"
      ? "¿En qué sucursal vas a recoger?"
      : "¿Desde qué sucursal deseas tu domicilio?";
    await sendWhatsAppButtons(phone,
      msgHCSuc,
      [
        { id: "la_villa", title: "La Villa 🏪" },
        { id: "circunvalar", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  }
  // Si ya había sucursal guardada, la usamos sin preguntar
  const orderHCSuc = getOrder(phone)!;
  const hcParsedSuc = parseOlaClickText(orderHCSuc.holaclick_order || "");

  // Calcular domicilio con coordenadas GPS
  if (orderHCSuc.tipoEntrega === "domicilio" && orderHCSuc.locationCoords) {
    try {
      const coordStr = `${orderHCSuc.locationCoords.latitude},${orderHCSuc.locationCoords.longitude}`;
      const calculo = await calcularDomicilio(coordStr, orderHCSuc.sucursal || "la_villa", hcParsedSuc.totalAPagar);
      orderHCSuc.valorDomicilio = calculo.valorDomicilio;
      orderHCSuc.distanciaKm = calculo.distanciaKm;
      orderHCSuc.domicilioTexto = calculo.descripcion;
    } catch (e) {
      console.error("❌ Error calculando domicilio HC sucursal:", e);
      orderHCSuc.valorDomicilio = 4500;
    }
  }

  const subtotalSuc = hcParsedSuc.totalAPagar - (hcParsedSuc.entrega ?? 0);
  const domicilioSuc = orderHCSuc.valorDomicilio ?? 0;
  const totalSuc = subtotalSuc + domicilioSuc;
  const hcItemsListSuc = hcParsedSuc.items.map(i => {
    const extrasTexto = i.extras.filter(e => e.nombre).map(e =>
      `+${e.nombre}${e.precio > 0 ? ` $${e.precio.toLocaleString("es-CO")}` : ""}`
    ).join(", ");
    return `• ${i.producto} ×${i.cantidad} — $${i.precio.toLocaleString("es-CO")}` +
      (extrasTexto ? `\n  ${extrasTexto}` : "") +
      (i.observaciones ? `\n  📝 ${i.observaciones}` : "");
  }).join("\n");

  const bodyPagoSuc =
    "Gracias por tu pedido en OlaClick ✅\n\n" +
    (hcItemsListSuc ? `🧾 Tu pedido:\n${hcItemsListSuc}\n\n` : "") +
    `💰 Subtotal: $${subtotalSuc.toLocaleString("es-CO")}\n` +
    (orderHCSuc.tipoEntrega === "domicilio"
      ? `🛵 Domicilio: $${domicilioSuc.toLocaleString("es-CO")}` +
        (orderHCSuc.domicilioTexto ? ` (${orderHCSuc.domicilioTexto})` : "") + "\n"
      : "") +
    `💵 Total: $${totalSuc.toLocaleString("es-CO")}\n\n` +
    "¿Cómo deseas pagar?";

  updateOrderStep(phone, "esperando_pago_holaclick");
  await sendWhatsAppButtons(phone, bodyPagoSuc, [
    { id: "efectivo", title: "Efectivo 💵" },
    { id: "nequi", title: "Nequi/Daviplata 📱" },
    { id: "bancolombia", title: "Bancolombia/Llave🏦" }
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
    const hcTotalHC = parseOlaClickText(currentOrder.holaclick_order || "").totalAPagar + (currentOrder.valorDomicilio ?? 0);
    const bodyPago2 = hcTotalHC > 0
      ? `El total de tu pedido es $${hcTotalHC.toLocaleString("es-CO")} 💰\n¿Cómo deseas pagar?`
      : "¿Cómo deseas pagar?";
    await sendWhatsAppButtons(phone, bodyPago2, [
      { id: "efectivo", title: "Efectivo 💵" },
      { id: "nequi", title: "Nequi/Daviplata 📱" },
      { id: "bancolombia", title: "Bancolombia/Llave🏦" }
    ]);
    return res.sendStatus(200);
  }

  updateOrderPayment(phone, formaPago);
  currentOrder = getOrder(phone)!;

  const hcTotalFinal = parseOlaClickText(currentOrder.holaclick_order || "").totalAPagar + (currentOrder.valorDomicilio ?? 0);
  const holaclickTotalTexto = hcTotalFinal > 0 ? `$${hcTotalFinal.toLocaleString("es-CO")}` : "";
  const sucursalTextoHC = currentOrder.sucursal === "la_villa" ? "La Villa" : "Av. Circunvalar";

  if (formaPago === "nequi/daviplata") {
    const nequiNum = currentOrder.sucursal === "circunvalar" ? "3205839477" : "3207218267";
    updateOrderStep(phone, "esperando_comprobante_holaclick");
    const msgNequi =
      "Perfecto 👌\n\n" +
      (holaclickTotalTexto ? `El total a pagar es: ${holaclickTotalTexto}\n\n` : "") +
      "Pago por Nequi/Daviplata:\n" +
      `📱 ${nequiNum}\n\n` +
      "Cuando realices el pago envíame el comprobante 📸";
    await sendWhatsAppButtons(phone, msgNequi, [{ id: "listo", title: "Listo, ya pagué ✅" }]);
    return res.sendStatus(200);
  } else if (formaPago === "bancolombia") {
    const bancoNum = currentOrder.sucursal === "circunvalar" ? "27000004514" : "27033825108";
    const bancoLlave = currentOrder.sucursal === "circunvalar" ? "0040652828" : "@niet661";
    updateOrderStep(phone, "esperando_comprobante_holaclick");
    replyMessage =
      "Perfecto 👌\n\n" +
      (holaclickTotalTexto ? `El total a pagar es: ${holaclickTotalTexto}\n\n` : "") +
      "Transferencia Bancolombia/Llave:\n" +
      "🏦 Cuenta de ahorros\n" +
      `💳 ${bancoNum}\n` +
      `🔑 Llave: ${bancoLlave}\n\n` +
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
    const hcParsedEf = parseOlaClickText(holaclickResumenEf);
    savePedido({ phone, nombre: orderEfHC.nombre || customer?.name, sucursal: orderEfHC.sucursal, forma_pago: "efectivo", canal: "holaclick", holaclick_order: holaclickResumenEf, confirmed_at: orderEfHC.confirmedAt, estado: 'recibido' }).catch(e => console.error("❌ savePedido HC:", e));
    const hcItemsTextoEf = hcParsedEf.items.length > 0
      ? hcParsedEf.items.map(i =>
          `• ${i.producto} ×${i.cantidad} — $${i.precio.toLocaleString("es-CO")}` +
          (i.extras.filter(e => e.nombre).map(e => `\n  +${e.nombre}${e.precio > 0 ? " $" + e.precio.toLocaleString("es-CO") : ""}`).join("")) +
          (i.observaciones ? `\n  📝 ${i.observaciones}` : "")
        ).join("\n")
      : holaclickResumenEf;
    const hcPropinaTextoEf = hcParsedEf.propina > 0
      ? `\n💡 Propina: $${hcParsedEf.propina.toLocaleString("es-CO")}` : "";
    const resumenInternoEfHC =
      "🔥 PEDIDO HOLACLICK\n\n" +
      `👤 ${orderEfHC.nombre || customer?.name || "Cliente"}\n` +
      `📞 ${phone}\n` +
      (hcParsedEf.direccion ? `📍 ${hcParsedEf.direccion}\n` : "") +
      `\n📋 Productos:\n${hcItemsTextoEf}\n\n` +
      `🏬 Sucursal: ${sucursalTextoHC}\n` +
      `💳 Pago: Efectivo${hcPropinaTextoEf}`;

    const destinoEfHC = orderEfHC.sucursal === "circunvalar" ? "573217233342" : "573151913928";
    try { await sendWhatsAppMessage(destinoEfHC, resumenInternoEfHC); }
    catch (e) { console.error(`❌ ERROR enviando pedido holaclick efectivo a ${destinoEfHC}:`, e); }

    replyMessage =
      "¡Tu pedido fue confirmado! 🔥\n\n" +
      `🏬 Sucursal: ${sucursalTextoHC}\n` +
      `💳 Pago: Efectivo\n\n` +
      "Pronto estará listo 🥞";
  }

} else if (currentOrder?.step === "esperando_comprobante_holaclick") {

  const imageId = messageData.image?.id;

  if (imageId) {
    updateOrderStep(phone, "confirmado");
    clearTimeout(inactivityTimers.get(phone));
    inactivityTimers.delete(phone);
    currentOrder = getOrder(phone)!;
    currentOrder.confirmedAt = new Date().toISOString();

    const order = getOrder(phone)!;
    const holaclickResumen = order.holaclick_order || "";
    const sucursalTexto = order.sucursal === "la_villa" ? "La Villa" : "Av. Circunvalar";
    const hcParsedComp = parseOlaClickText(holaclickResumen);
    savePedido({ phone, nombre: order.nombre || customer?.name, sucursal: order.sucursal, forma_pago: order.formaPago, canal: "holaclick", holaclick_order: holaclickResumen, confirmed_at: order.confirmedAt, estado: 'recibido' }).catch(e => console.error("❌ savePedido HC:", e));
    const hcItemsTextoComp = hcParsedComp.items.length > 0
      ? hcParsedComp.items.map(i =>
          `• ${i.producto} ×${i.cantidad} — $${i.precio.toLocaleString("es-CO")}` +
          (i.extras.filter(e => e.nombre).map(e => `\n  +${e.nombre}${e.precio > 0 ? " $" + e.precio.toLocaleString("es-CO") : ""}`).join("")) +
          (i.observaciones ? `\n  📝 ${i.observaciones}` : "")
        ).join("\n")
      : holaclickResumen;
    const hcPropinaTextoComp = hcParsedComp.propina > 0
      ? `\n💡 Propina: $${hcParsedComp.propina.toLocaleString("es-CO")}` : "";
    const resumenHolaclick =
      "🔥 PEDIDO HOLACLICK\n\n" +
      `👤 ${order.nombre || customer?.name || "Cliente"}\n` +
      `📞 ${phone}\n` +
      (hcParsedComp.direccion ? `📍 ${hcParsedComp.direccion}\n` : "") +
      `\n📋 Productos:\n${hcItemsTextoComp}\n\n` +
      `🏬 Sucursal: ${sucursalTexto}\n` +
      `💳 Pago: ${order.formaPago || ""}${hcPropinaTextoComp}`;

    const DESTINOS_HOLACLICK = order.sucursal === "circunvalar"
      ? ["573217233342", "573187105601"]
      : ["573151913928", "573207218267"];

    for (const destino of DESTINOS_HOLACLICK) {
      try {
        await sendWhatsAppMessage(destino, resumenHolaclick);
        await sendWhatsAppImageById(destino, imageId);
      } catch (e) { console.error(`❌ ERROR reenviando comprobante holaclick a ${destino}:`, e); }
    }

    replyMessage = "Gracias, comprobante recibido ✅ Tu pedido está en proceso 🔥";
  } else if (
    lower.includes("efectivo") || lower.includes("nequi") || lower.includes("daviplata") ||
    lower.includes("bancolombia") || lower.includes("cambiar pago") ||
    lower.includes("cambio de pago") || lower.includes("otro metodo") || lower.includes("otro método")
  ) {
    updateOrderStep(phone, "esperando_pago_holaclick");
    await sendWhatsAppButtons(phone,
      "Claro 😊 ¿Cómo deseas pagar?",
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia/Llave🏦" }
      ]
    );
    return res.sendStatus(200);
  } else {
    // Llegó texto en lugar de imagen — pedir foto
    replyMessage = "Por favor envía una foto del comprobante 📸";
  }

} else if (currentOrder?.step === "esperando_mensaje_fuera_horario") {
  // Si ya abrimos, reiniciar sesión y mostrar bienvenida
  if (isWithinBusinessHours("domicilio")) {
    clearOrder(phone);
    createOrUpdateOrder(phone, []);
    updateOrderStep(phone, "esperando_menu_principal");
    currentOrder = getOrder(phone)!;
    if (tieneUltimoPedido) {
      await sendWhatsAppButtons(phone,
        MSG_BIENVENIDA_RECURRENTE(customer!.name?.trim() || undefined) + CREBOT_SUFFIX,
        [
          { id: "a", title: "Pedido anterior 🔄" },
          { id: "b", title: "Pedir algo nuevo 🥞" },
          { id: "3", title: "Otros 💬" }
        ]
      );
    } else {
      await sendWhatsAppButtons(phone,
        MSG_BIENVENIDA_NUEVO + CREBOT_SUFFIX,
        [
          { id: "1", title: "Hacer un pedido 🥞" },
          { id: "2", title: "Ver menu 📋" },
          { id: "3", title: "Otros 💬" }
        ]
      );
    }
    return res.sendStatus(200);
  }
  // FAQ fuera de horario — responder sin escalar
  if (
    lower.includes("menu") || lower.includes("menú") ||
    lower.includes("carta") || lower.includes("qué tienen") || lower.includes("que tienen") ||
    lower === "ver menu" || lower === "ver menú"
  ) {
    await sendWhatsAppMessage(phone,
      "Aquí tienes el menú completo 📋\n\nhttps://menu.tecmenu.com\n\nRecuerda que estamos disponibles de 3:00 PM a 10:15 PM 😊"
    );
    return res.sendStatus(200);
  }

  if (
    lower.includes("horario") || lower.includes("hora") ||
    lower.includes("abren") || lower.includes("cierran") ||
    lower.includes("a qué hora") || lower.includes("cuando abren") || lower.includes("cuándo abren") ||
    lower.includes("atención") || lower.includes("atencion") ||
    lower.includes("atienden") || lower.includes("abiertos") || lower.includes("abierto") ||
    lower === "hola" || lower === "buenas" || lower === "buenas tardes" ||
    lower === "buenas noches" || lower === "buenos días" || lower === "buenos dias"
  ) {
    await sendWhatsAppMessage(phone,
      "Nuestro horario de atención es de *3:00 PM a 10:15 PM* 🕒\n\nEn cuanto abramos podrás hacer tu pedido 😊"
    );
    return res.sendStatus(200);
  }

  if (
    lower.includes("tienen domicilio") || lower.includes("hacen domicilio") ||
    lower.includes("tienen domicilios") || lower.includes("hacen domicilios") ||
    lower.includes("manejan domicilio") || lower.includes("realizan domicilio") ||
    lower.includes("delivery")
  ) {
    await sendWhatsAppMessage(phone,
      "Sí, hacemos domicilios 🛵\n\nNuestro horario de atención es de *3:00 PM a 10:15 PM* todos los días.\n\n¡Te esperamos! 😊"
    );
    return res.sendStatus(200);
  }

  // Cambiar step antes de los awaits para evitar duplicados por webhooks concurrentes
  updateOrderStep(phone, "esperando_asesor");
  try {
    await sendWhatsAppMessage("573151913928",
      `🔔 Mensaje fuera de horario\n👤 Tel: ${phone}\n💬 Mensaje: ${text}\n⚠️ Atiende esta solicitud`
    );
  } catch (e) { console.error("❌ ERROR reenviando mensaje fuera de horario:", e); }
  try {
    const nombreFH = currentOrder.nombre || customer?.name || phone;
    await sendWhatsAppMessage("573208580551",
      `🔔 *Escalada a asesor*\n👤 Nombre: ${nombreFH}\n📞 Tel: ${phone}\n🏬 Sucursal: ${currentOrder.sucursal || "No seleccionada"}\n💬 Último mensaje: ${text}`
    );
  } catch (e) { console.error("❌ ERROR notificando dueño (fuera horario):", e); }
  replyMessage = "Gracias por tu mensaje ✅ Un asesor se pondrá en contacto contigo pronto 😊";

} else if (currentOrder?.step === "esperando_ayuda") {
  // Saludo simple → no escalar, pedir que cuente su consulta
  const esGreetingAyuda =
    lower === "hola" || lower === "buenas" || lower === "buenos dias" ||
    lower === "buenas tardes" || lower === "buenas noches" || lower === "hi" ||
    lower.startsWith("hola ") || lower.startsWith("buenas ");
  if (esGreetingAyuda) {
    await sendWhatsAppMessage(phone,
      "Hola 😊 ¿En qué te puedo ayudar?\n\nCuéntame tu consulta o si prefieres hablar con un asesor escríbenos al 📱 *315 191 3928*"
    );
    return res.sendStatus(200);
  }

  // Si pregunta por el menú, mostrar link en vez de escalar
  if (
    lower.includes("menu") || lower.includes("menú") ||
    lower.includes("carta") || lower.includes("qué tienen") || lower.includes("que tienen") ||
    lower === "ver menu" || lower === "ver menú"
  ) {
    await sendWhatsAppMessage(phone,
      "Aquí tienes el menú completo 📋\n\nhttps://menu.tecmenu.com\n\nCuando estés listo, escríbeme qué deseas pedir 😊"
    );
    return res.sendStatus(200);
  }

  // Si pregunta por el precio de un producto, responder directamente
  const esPreguntaPrecioAyuda =
    lower.includes("precio") || lower.includes("vale") || lower.includes("cuesta") ||
    lower.includes("cuanto") || lower.includes("cuánto") || lower.includes("valor") ||
    lower.includes("cuestan") || lower.includes("valen");
  if (esPreguntaPrecioAyuda) {
    const textLimpio = normalizeText(text)
      .replace(/\b(cuanto|cuantos|cuánto|precio|precios|cuesta|cuestan|vale|valen|valor|tienen|tiene|me|pueden|dar|el|la|los|las|de|del|un|una|por|favor|digame|dime|cual|es|son)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (textLimpio.length > 1) {
      const parseResultAyuda = parseOrder(textLimpio);
      // Filtrar extras (ej. "Pollo desmechado" extra a $7.000) — solo mostrar productos principales
      const mainItemsAyuda = parseResultAyuda.items.filter((i: any) => !i.productoId?.startsWith("extra_"));
      if (mainItemsAyuda.length > 0) {
        const itemAyuda = mainItemsAyuda[0];
        const nombreMostrar = itemAyuda.variante
          ? `${itemAyuda.producto} - ${itemAyuda.variante}`
          : itemAyuda.producto;
        await sendWhatsAppMessage(phone,
          `*${nombreMostrar}* tiene un precio de *$${itemAyuda.precio.toLocaleString("es-CO")}* 😊\n\n¿Deseas ordenar? Escríbeme qué deseas pedir.`
        );
        return res.sendStatus(200);
      }
    }
  }

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
  try {
    await sendWhatsAppMessage("573208580551",
      `🔔 *Escalada a asesor*\n👤 Nombre: ${nombreCliente}\n📞 Tel: ${phone}\n🏬 Sucursal: ${currentOrder.sucursal || "No seleccionada"}\n💬 Último mensaje: ${text}`
    );
  } catch (e) { console.error("❌ ERROR notificando dueño (ayuda):", e); }

  replyMessage = "Gracias por escribirnos. En breve un asesor te contactará 😊\n\nTambién puedes comunicarte al establecimiento 📞 *606 341 3020*";

} else if (currentOrder?.step === "esperando_asesor") {
  // Bot completamente silencioso — reenviar al asesor sin responder al cliente
  const nombreAsesor = currentOrder.nombre || customer?.name || phone;
  const mensajeReenvio =
    `💬 MENSAJE DE CLIENTE\n\n` +
    `👤 Nombre: ${nombreAsesor}\n` +
    `📞 Tel: ${phone}\n` +
    `💬 Mensaje: ${text}`;
  try {
    await sendWhatsAppMessage("573151913928", mensajeReenvio);
    console.log("✅ MENSAJE REENVIADO A ASESOR desde", phone);
  } catch (e) { console.error("❌ ERROR reenviando a asesor:", e); }
  return res.sendStatus(200);
} else if (currentOrder?.step === "esperando_tipo_entrega_repetido") {
  if (
    lower === "a" ||
    lower.includes("recoger") ||
    lower.includes("tienda")
  ) {
    updateOrderDeliveryType(phone, "recoger");
    const ordRec = getOrder(phone)!;
    ordRec.sucursal = undefined; // que elija activamente la sucursal
    updateOrderStep(phone, "esperando_sucursal");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "Perfecto 🏪 ¿En cuál sucursal deseas recoger?",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
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

    if (tieneUltimaDir) {
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
    currentOrder = getOrder(phone)!;

    if (currentOrder.vieneDeCarta) {
      if (!currentOrder.nombre && !customer?.name) {
        updateOrderStep(phone, "esperando_nombre");
        await sendWhatsAppMessage(phone, "Perfecto 👍\n\n¿Cómo es tu nombre?");
      } else {
        if (customer?.name && !currentOrder.nombre) updateOrderName(phone, customer.name);
        if (!currentOrder.tipoEntrega) {
          updateOrderStep(phone, "esperando_tipo_entrega");
          await sendWhatsAppButtons(phone, "¿Cómo deseas recibir tu pedido?", [
            { id: "domicilio", title: "Domicilio 🛵" },
            { id: "recoger",   title: "Recoger en tienda 🏪" }
          ]);
        } else if (currentOrder.tipoEntrega === "domicilio") {
          if (tieneUltimaDir) {
            updateOrderStep(phone, "esperando_confirmacion_direccion");
            currentOrder = getOrder(phone)!;
            await sendWhatsAppButtons(phone,
              `Perfecto 👍\n\n¿Deseas usar tu dirección habitual?\n\n📍 ${customer.last_address}`,
              [{ id: "a", title: "Sí, esa misma ✅" }, { id: "b", title: "No, cambiarla 📍" }]
            );
          } else {
            updateOrderStep(phone, "esperando_direccion");
            currentOrder = getOrder(phone)!;
            await sendWhatsAppMessage(phone, "Perfecto 👍\n\nEnvíame tu ubicación 📍 o escríbeme tu dirección de domicilio.");
          }
        } else {
          updateOrderStep(phone, "post_agregar_producto");
          await sendWhatsAppButtons(phone, "Perfecto 👍 ¿Qué deseas hacer?", [
            { id: "confirmar",   title: "Confirmar ✅" },
            { id: "agregar_mas", title: "Agregar más ➕" },
            { id: "eliminar",    title: "Eliminar ➖" }
          ]);
        }
      }
      return res.sendStatus(200);
    }

    if (currentOrder.tipoEntrega === "domicilio" && currentOrder.items.length > 0) {
      if (tieneUltimaDir) {
        updateOrderStep(phone, "esperando_confirmacion_direccion");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          `Perfecto 👍\n\n¿Deseas usar tu dirección habitual?\n\n📍 ${customer.last_address}`,
          [{ id: "a", title: "Sí, esa misma ✅" }, { id: "b", title: "No, cambiarla 📍" }]
        );
      } else {
        updateOrderStep(phone, "esperando_direccion");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppMessage(phone, "Perfecto 👍\n\nEnvíame tu ubicación 📍 o escríbeme tu dirección de domicilio.");
      }
      return res.sendStatus(200);
    }

    if (currentOrder.tipoEntrega === "recoger" && currentOrder.items.length > 0) {
      updateOrderStep(phone, "esperando_confirmacion");
      currentOrder = getOrder(phone)!;
      const orderRec = getOrder(phone)!;
      const totalsRec = calculateTotal(orderRec);
      const resumenRec = orderRec.items.map((item: any) => formatLineaItem(item)).join("\n");
      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nTu pedido es:\n" + resumenRec +
        buildResumenFooter(orderRec, totalsRec, orderRec.domicilioTexto) +
        "\n\n📝 Si deseas hacer una observación escríbela ahora, o elige una opción:",
        [
          { id: "confirmar", title: "Confirmar" },
          { id: "agregar_mas", title: "Agregar mas" },
          { id: "eliminar", title: "Eliminar" }
        ]
      );
      return res.sendStatus(200);
    }

    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;
    replyMessage =
      "Perfecto 👍\n\nPuedes ver nuestro menú aquí:\nhttps://menu.tecmenu.com\n\n" +
      "🎉 Si tu pedido supera los $100.000 el domicilio es *gratis*.\n\n" +
      "Si necesitas contactarnos:\n📞 606 341 3020\n\n" +
      "Si ya sabes qué ordenar ¡te puedo tomar el pedido por acá! Escríbeme qué deseas 😊";

  } else if (
    lower === "b" ||
    lower.includes("circunvalar") ||
    lower.includes("avenida circunvalar") ||
    lower.includes("av circunvalar")
  ) {
    currentOrder.sucursal = "circunvalar";
    currentOrder = getOrder(phone)!;

    if (currentOrder.vieneDeCarta) {
      if (!currentOrder.nombre && !customer?.name) {
        updateOrderStep(phone, "esperando_nombre");
        await sendWhatsAppMessage(phone, "Perfecto 👍\n\n¿Cómo es tu nombre?");
      } else {
        if (customer?.name && !currentOrder.nombre) updateOrderName(phone, customer.name);
        if (!currentOrder.tipoEntrega) {
          updateOrderStep(phone, "esperando_tipo_entrega");
          await sendWhatsAppButtons(phone, "¿Cómo deseas recibir tu pedido?", [
            { id: "domicilio", title: "Domicilio 🛵" },
            { id: "recoger",   title: "Recoger en tienda 🏪" }
          ]);
        } else if (currentOrder.tipoEntrega === "domicilio") {
          if (tieneUltimaDir) {
            updateOrderStep(phone, "esperando_confirmacion_direccion");
            currentOrder = getOrder(phone)!;
            await sendWhatsAppButtons(phone,
              `Perfecto 👍\n\n¿Deseas usar tu dirección habitual?\n\n📍 ${customer.last_address}`,
              [{ id: "a", title: "Sí, esa misma ✅" }, { id: "b", title: "No, cambiarla 📍" }]
            );
          } else {
            updateOrderStep(phone, "esperando_direccion");
            currentOrder = getOrder(phone)!;
            await sendWhatsAppMessage(phone, "Perfecto 👍\n\nEnvíame tu ubicación 📍 o escríbeme tu dirección de domicilio.");
          }
        } else {
          updateOrderStep(phone, "post_agregar_producto");
          await sendWhatsAppButtons(phone, "Perfecto 👍 ¿Qué deseas hacer?", [
            { id: "confirmar",   title: "Confirmar ✅" },
            { id: "agregar_mas", title: "Agregar más ➕" },
            { id: "eliminar",    title: "Eliminar ➖" }
          ]);
        }
      }
      return res.sendStatus(200);
    }

    if (currentOrder.tipoEntrega === "domicilio" && currentOrder.items.length > 0) {
      if (tieneUltimaDir) {
        updateOrderStep(phone, "esperando_confirmacion_direccion");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppButtons(phone,
          `Perfecto 👍\n\n¿Deseas usar tu dirección habitual?\n\n📍 ${customer.last_address}`,
          [{ id: "a", title: "Sí, esa misma ✅" }, { id: "b", title: "No, cambiarla 📍" }]
        );
      } else {
        updateOrderStep(phone, "esperando_direccion");
        currentOrder = getOrder(phone)!;
        await sendWhatsAppMessage(phone, "Perfecto 👍\n\nEnvíame tu ubicación 📍 o escríbeme tu dirección de domicilio.");
      }
      return res.sendStatus(200);
    }

    if (currentOrder.tipoEntrega === "recoger" && currentOrder.items.length > 0) {
      updateOrderStep(phone, "esperando_confirmacion");
      currentOrder = getOrder(phone)!;
      const orderRec = getOrder(phone)!;
      const totalsRec = calculateTotal(orderRec);
      const resumenRec = orderRec.items.map((item: any) => formatLineaItem(item)).join("\n");
      await sendWhatsAppButtons(phone,
        "Perfecto 👌\n\nTu pedido es:\n" + resumenRec +
        buildResumenFooter(orderRec, totalsRec, orderRec.domicilioTexto) +
        "\n\n📝 Si deseas hacer una observación escríbela ahora, o elige una opción:",
        [
          { id: "confirmar", title: "Confirmar" },
          { id: "agregar_mas", title: "Agregar mas" },
          { id: "eliminar", title: "Eliminar" }
        ]
      );
      return res.sendStatus(200);
    }

    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;
    replyMessage =
      "Perfecto 👍\n\nPuedes ver nuestro menú aquí:\nhttps://menu.tecmenu.com\n\n" +
      "🎉 Si tu pedido supera los $100.000 el domicilio es *gratis*.\n\n" +
      "Si necesitas contactarnos:\n📞 606 345 0257\n\n" +
      "Si ya sabes qué ordenar ¡te puedo tomar el pedido por acá! Escríbeme qué deseas 😊";

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
    return prod?.tipo === "jugo" || prod?.id === "vegetariana" || prod?.id === "malteada" || prod?.id === "limonada" || prod?.id === "vegetales_mixta" || prod?.id === "ranchera_mixta" || prod?.id === "desgranada_mixta";
  });

  if (itemNeedingVariant) {
    // Separar items: los que NO necesitan variante se agregan ya; los que SÍ van a la cola
    const needsVariant = (item: any) => {
      if (item.variante) return false;
      const p = allMenuProducts.find((mp: any) => mp.id === item.productoId);
      return p?.tipo === "jugo" || ["vegetariana","malteada","limonada","vegetales_mixta","ranchera_mixta","desgranada_mixta"].includes(p?.id);
    };
    const itemsDirectos = parsedItems.filter((i: any) => !needsVariant(i));
    const itemsConVariante = parsedItems.filter((i: any) => needsVariant(i));

    if (itemsDirectos.length > 0) {
      createOrUpdateOrder(phone, itemsDirectos);
    }
    // Guardar cola con productoId + cantidad de cada uno
    currentOrder.itemsPendientes = itemsConVariante.map((i: any) => ({ productoId: i.productoId, cantidad: i.cantidad || 1 }));

    const prod = allMenuProducts.find((p: any) => p.id === itemNeedingVariant.productoId)!;
    currentOrder.pendingProduct = { id: prod.id, nombre: prod.nombre, precio: prod.precio };
    updateOrderStep(phone, "esperando_variante_producto");
    currentOrder = getOrder(phone)!;
    const botonesVariantes = prod.variantes.slice(0, 3).map((v: any) => ({
      id: `variante_${v.id}`,
      title: `${v.nombre} $${v.precio.toLocaleString("es-CO")}`
    }));
    let preguntaVariante: string;
    if (prod.id === "vegetariana") {
      preguntaVariante = `¿Qué salsa deseas para tu ${prod.nombre}?\n\n⚠️ La salsa bechamel contiene caldo de pollo.`;
    } else if (prod.id === "malteada") {
      preguntaVariante = `¿Qué sabor de malteada deseas?`;
    } else if (prod.id === "limonada") {
      preguntaVariante = `¿Qué limonada deseas?`;
    } else {
      preguntaVariante = `¿Cómo deseas tu ${prod.nombre}?`;
    }
    await sendWhatsAppButtons(phone, preguntaVariante, botonesVariantes);
    return res.sendStatus(200);
  }

  // Si el último ítem del pedido es "gaseosa" (genérico) y el nuevo es una gaseosa específica → reemplazar
  const specificSodasAP = new Set(["coca_cola", "sprite", "manzana", "agua_tonica"]);
  const lastExistingAP = currentOrder.items[currentOrder.items.length - 1];
  if (
    lastExistingAP?.producto?.toLowerCase() === "gaseosa" &&
    parsedItems.length === 1 &&
    specificSodasAP.has(parsedItems[0].productoId)
  ) {
    currentOrder.items[currentOrder.items.length - 1] = {
      ...parsedItems[0],
      cantidad: lastExistingAP.cantidad
    };
  } else {
    createOrUpdateOrder(phone, parsedItems);
  }
  currentOrder = getOrder(phone)!;

  // Si el mensaje también pide helado/bolas → agregarlo como extra del último ítem
  if (lower.includes("helado") || /\bbolas?\b/.test(lower)) {
    const ultimoHelado = currentOrder.items[currentOrder.items.length - 1];
    if (ultimoHelado) {
      const dosBolasH = lower.includes("dos bola") || lower.includes("2 bola");
      const heladoNom = dosBolasH ? "Helado 2 bolas" : "Helado 1 bola";
      const heladoPre = dosBolasH ? 8000 : 5500;
      ultimoHelado.extras = ultimoHelado.extras || [];
      if (!ultimoHelado.extras.find((e: any) => e.nombre === heladoNom)) {
        ultimoHelado.extras.push({ nombre: heladoNom, precio: heladoPre, cantidad: 1 });
      }
    }
  }

  // Preguntas post-producto
  const lastItem = parsedItems[parsedItems.length - 1];
  const DULCES_IDS = new Set(["nutella_crepe", "chocolate_crepe", "arequipe_crepe"]);
  if (lastItem?.productoId === "mexicana" || lastItem?.producto?.toLowerCase().includes("mexican")) {
    updateOrderStep(phone, "esperando_jalapenos");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      `¿Deseas tu ${lastItem.producto} con jalapeños o sin jalapeños?`,
      [{ id: "con_jalapenos", title: "Con jalapeños 🌶️" }, { id: "sin_jalapenos", title: "Sin jalapeños" }]
    );
    return res.sendStatus(200);
  }
  if (DULCES_IDS.has(lastItem?.productoId)) {
    updateOrderStep(phone, "esperando_queso_dulce");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      `¿Deseas tu ${lastItem.producto} con queso o sin queso? 🧀`,
      [{ id: "con_queso_dulce", title: "Con queso 🧀" }, { id: "sin_queso_dulce", title: "Sin queso" }]
    );
    return res.sendStatus(200);
  }
  const order = getOrder(phone)!;
  order.armandoFallbacks = 0;
  updateOrderStep(phone, "post_agregar_producto");
  currentOrder = getOrder(phone)!;

  const resumen = order.items.map((item: any) => formatLineaItem(item, true)).join("\n");

 await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nEstoy registrando:\n\n" +
  resumen +
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
  const resumenJal = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
  await sendWhatsAppButtons(phone,
    "Perfecto 👌\n\nEstoy registrando:\n\n" + resumenJal + "\n\n📝 Si deseas una observación escríbela, o elige:",
    [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
  );
  return res.sendStatus(200);

} else if (currentOrder?.step === "esperando_queso_dulce") {
  const withQueso = lower === "con_queso_dulce" || lower.includes("con queso") || lower === "con";
  const orderQD = getOrder(phone)!;
  const lastItemQD = orderQD.items[orderQD.items.length - 1];
  if (lastItemQD) {
    // Eliminar cualquier extra de queso que el parser haya agregado (no tiene costo en crepes dulces)
    lastItemQD.extras = (lastItemQD.extras || []).filter(
      (e: any) => !e.nombre?.toLowerCase().includes("queso")
    );
    const obsActual = lastItemQD.observaciones ? lastItemQD.observaciones + ", " : "";
    lastItemQD.observaciones = withQueso ? obsActual + "con queso" : obsActual + "sin queso";
  }
  updateOrderStep(phone, "post_agregar_producto");
  currentOrder = getOrder(phone)!;
  const resumenQD = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
  await sendWhatsAppButtons(phone,
    "Perfecto 👌\n\nEstoy registrando:\n\n" + resumenQD + "\n\n📝 Si deseas una observación escríbela, o elige:",
    [{ id: "confirmar", title: "✅ Confirmar" }, { id: "eliminar", title: "🗑️ Quitar" }, { id: "4", title: "📝 Observación" }]
  );
  return res.sendStatus(200);

} else if (currentOrder?.step === "esperando_nombre") {
  const nombreRecibido = text.trim();
  const INVALIDOS_NOMBRE = new Set([
    "confirmar", "agregar_mas", "agregar", "eliminar", "recoger",
    "domicilio", "nequi", "efectivo", "bancolombia", "si", "sí", "no",
    "a", "b", "1", "2", "3", "4", "5", "ok", "dale", "listo",
    "factura_si", "factura_no", "pedir_algo_nuevo", "hablar_asesor",
    "con_queso_dulce", "sin_queso_dulce", "con_jalapenos", "sin_jalapenos"
  ]);
  if (INVALIDOS_NOMBRE.has(nombreRecibido.toLowerCase()) || nombreRecibido.length < 2) {
    await sendWhatsAppMessage(phone, "Por favor dime tu nombre 😊 ¿Cómo te llamas?");
    return res.sendStatus(200);
  }
  updateOrderName(phone, nombreRecibido);
  currentOrder = getOrder(phone)!;
  await upsertCustomer({ phone, name: nombreRecibido }).catch(err =>
    console.error("❌ Error guardando nombre en Supabase:", err)
  );

  if (!currentOrder.tipoEntrega) {
    updateOrderStep(phone, "esperando_tipo_entrega");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "¿Cómo deseas recibir tu pedido?",
      [
        { id: "domicilio", title: "Domicilio 🛵" },
        { id: "recoger",   title: "Recoger en tienda 🏪" }
      ]
    );
    return res.sendStatus(200);
  } else if (currentOrder.tipoEntrega === "domicilio") {
    updateOrderStep(phone, "esperando_direccion");
    currentOrder = getOrder(phone)!;
    replyMessage = "Perfecto 👍\n\nEnvíame tu ubicación 📍 para mayor exactitud, o escríbeme tu dirección.";
  } else {
    updateOrderStep(phone, "esperando_confirmacion");
    currentOrder = getOrder(phone)!;
    const order = getOrder(phone)!;
    const totals = calculateTotal(order);
    const resumen = order.items.map((item: any) => formatLineaItem(item)).join("\n");
    await sendWhatsAppButtons(phone,
      "Perfecto 👌\n\nTu pedido es:\n" +
      resumen +
      buildResumenFooter(order, totals, order.domicilioTexto) +
      "\n\n📝 Si deseas una observación escríbela, o elige:",
      [
        { id: "confirmar", title: "Confirmar" },
        { id: "agregar_mas", title: "Agregar mas" },
        { id: "eliminar", title: "Eliminar" }
      ]
    );
    return res.sendStatus(200);
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
    // Manejar botones de cancelar domicilio
    if (lower === "recoger_en_vez") {
      updateOrderDeliveryType(phone, "recoger");
      currentOrder = getOrder(phone)!;
      currentOrder.valorDomicilio = 0;
      updateOrderStep(phone, "esperando_sucursal");
      currentOrder = getOrder(phone)!;
      await sendWhatsAppButtons(phone, "¿En cuál sucursal recoges?", [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]);
      return res.sendStatus(200);
    }
    if (lower === "cancelar_pedido_dir") {
      clearOrder(phone);
      await sendWhatsAppMessage(phone, "Tu pedido ha sido cancelado 😊 ¡Cuando quieras volver a pedir, estamos aquí!");
      return res.sendStatus(200);
    }

    // Detectar intención de cancelar domicilio
    const esCancelarDomicilio =
      lower.includes("cancel") ||
      lower.includes("no quiero") ||
      lower.includes("muy caro") ||
      lower === "caro" ||
      lower.includes("no lo quiero") ||
      (lower.includes("cambiar") && lower.includes("tienda"));

    if (esCancelarDomicilio) {
      await sendWhatsAppButtons(phone,
        "Entendido 😊 ¿Deseas recoger en tienda en su lugar?",
        [
          { id: "recoger_en_vez", title: "🏪 Recoger en tienda" },
          { id: "cancelar_pedido_dir", title: "❌ Cancelar pedido" }
        ]
      );
      return res.sendStatus(200);
    }

    // Validar que el texto parece una dirección real
    const PALABRAS_INVALIDAS_DIR = new Set(["hola", "si", "sí", "ok", "espera", "espérame", "esperame", "bueno", "bien", "ya", "dale", "listo", "claro", "no", "momento", "ahorita", "ahora", "gracias", "ok gracias", "muchas gracias", "perfecto", "entendido"]);
    // Quitar cortesías y la palabra "domicilio" para no confundir el geocoding
    const direccionLimpia = text
      .replace(/\bbuen[oa]s?\s*(noches?|tardes?|d[ií]as?)\b/gi, " ")
      .replace(/\b(buen[oa]s|hola|gracias|por\s*favor|porfa(?:vor)?)\b/gi, " ")
      .replace(/\bun[ao]?\s+domicilio\s+(para|a|en|hacia|hasta)\b/gi, " ")
      .replace(/\bdomicilio\b/gi, " ")
      .replace(/^[\s.,:;¡!¿?\-]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    const direccionFinal = direccionLimpia.length >= 5 ? direccionLimpia : text.trim();
    const textoDirLimpio = direccionFinal;
    const tieneDigito = /\d/.test(textoDirLimpio);
    const tieneKeywordDir = /\b(calle|carrera|carr|cll|cra|cr|av\b|avenida|diagonal|transversal|circular|autopista|variante|barrio|conjunto|urbanizacion|urbanización|manzana|km|kilómetro|kilómetros|#|nro|no\.)\b/i.test(textoDirLimpio);
    const esDirInvalida = textoDirLimpio.length < 5 || PALABRAS_INVALIDAS_DIR.has(textoDirLimpio.toLowerCase()) || (!tieneDigito && !tieneKeywordDir);
    if (esDirInvalida) {
      await sendWhatsAppMessage(phone, "No encontré una dirección válida 📍 Por favor escríbela así:\n\nCalle 12 #33-10, barrio Los Álamos");
      return res.sendStatus(200);
    }
    updateOrderAddress(phone, direccionFinal);
    // La dirección escrita tiene prioridad sobre coords GPS anteriores
    const orderTxt = getOrder(phone);
    if (orderTxt) orderTxt.locationCoords = undefined;
  }

  const order = getOrder(phone)!;

  // Limpiar valores stale antes de recalcular
  order.valorDomicilio = undefined;
  order.distanciaKm = undefined;
  order.domicilioTexto = undefined;

  const isGpsPin = !!order.locationCoords;
  let valorDomicilio = 4500;
  let descripcionDomicilio = "";
  try {
    const addressToCalc = order.locationCoords
      ? `${order.locationCoords.latitude},${order.locationCoords.longitude}`
      : (order.direccion || text);
    const calculo = await calcularDomicilio(addressToCalc, order.sucursal || "la_villa", calculateTotal(order).subtotal);
    valorDomicilio = calculo.valorDomicilio;
    descripcionDomicilio = calculo.descripcion;
    order.valorDomicilio = valorDomicilio;
    order.distanciaKm = calculo.distanciaKm;
    order.domicilioTexto = calculo.descripcion;
  } catch (e) {
    console.log("Error calculando domicilio:", e);
  }

  if (isGpsPin) {
    // Guardar snapshot GPS para comparar si el cliente cambia a dirección texto
    order.gpsDistanciaKm = order.distanciaKm || 0;
    order.gpsSnapshot = {
      direccion: order.direccion || "",
      coords: order.locationCoords!,
      valorDomicilio: order.valorDomicilio || 4500,
      domicilioTexto: order.domicilioTexto || "",
      distanciaKm: order.distanciaKm || 0
    };
  } else if (order.gpsDistanciaKm && order.gpsDistanciaKm > 0 && (order.distanciaKm || 0) > order.gpsDistanciaKm * 2) {
    // Dirección texto resulta más del doble de lejos que el pin GPS → advertir
    updateOrderStep(phone, "esperando_confirmacion_direccion");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      `La dirección que ingresaste queda a ${order.distanciaKm}km 📍\n\n` +
      `_Tu ubicación GPS inicial era de ${order.gpsDistanciaKm}km._\n\n` +
      `¿Es correcta esta dirección o prefieres usar tu ubicación GPS?`,
      [
        { id: "confirmar_dir_texto", title: "✏️ La dirección es correcta" },
        { id: "usar_gps_dir",        title: "📍 Usar mi GPS" }
      ]
    );
    return res.sendStatus(200);
  }

  updateOrderStep(phone, "esperando_confirmacion_direccion");
  currentOrder = getOrder(phone)!;

  const distanciaGrande = (order.distanciaKm || 0) > 8;
  const notaGPS = (distanciaGrande && !isGpsPin)
    ? `\n\n⚠️ _La distancia calculada es de ${order.distanciaKm}km. Si tu barrio está más cerca, compártenos tu ubicación GPS 📍 para mayor precisión._`
    : "";

  await sendWhatsAppButtons(phone,
    `¿Es correcta esta dirección? 📍\n\n*${order.direccion}*` +
    (descripcionDomicilio ? `\n\n${descripcionDomicilio}` : "") +
    `\n💵 Domicilio: $${valorDomicilio.toLocaleString("es-CO")}` +
    notaGPS,
    [
      { id: "a", title: "Confirmar ✅" },
      { id: "b", title: "Corregir ✏️" }
    ]
  );
  return res.sendStatus(200);
} else if (currentOrder?.step === "esperando_confirmacion") {
  const CONFIRMAR_EC = new Set(["confirmar", "a", "1", "confirmar_dir_texto"]);
  if (esBoton && CONFIRMAR_EC.has(lower)) {
    currentOrder.cartFreeTextAttempts = 0;
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
      if (tieneUltimaDir) {
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

  } else if (esBoton && (lower === "eliminar" || lower === "b")) {
    currentOrder.cartFreeTextAttempts = 0;
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

  } else if (esBoton && lower === "agregar_mas") {
    currentOrder.cartFreeTextAttempts = 0;
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "¿Qué deseas agregar?\n\n" +
      "Puedes escribir otra crepe, bebida, topping o hacer una observación.";

  } else if (esBoton && (lower === "d" || lower === "4")) {
    currentOrder.cartFreeTextAttempts = 0;
    updateOrderStep(phone, "esperando_observacion_general");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "Escríbeme la observación para tu pedido 😊";

  } else {
    // Pregunta por el total del pedido → mostrarlo
    const esPreguntaTotalEC =
      lower.includes("cuanto seria") || lower.includes("cuánto sería") ||
      lower.includes("cuanto es") || lower.includes("cuánto es") ||
      lower.includes("cuanto va") || lower.includes("cuánto va") ||
      lower.includes("cuanto queda") || lower.includes("cuánto queda") ||
      lower.includes("cuanto sale") || lower.includes("cuánto sale") ||
      lower.includes("cuanto cuesta") || lower.includes("cuánto cuesta") ||
      lower.includes("valor total") || lower.includes("total") ||
      lower === "cuanto" || lower === "cuánto";
    if (esPreguntaTotalEC) {
      const totalsEC2 = calculateTotal(currentOrder);
      const resumenEC2 = currentOrder.items.map((item: any) => formatLineaItem(item)).join("\n");
      await sendWhatsAppButtons(phone,
        "Tu pedido es:\n" + resumenEC2 +
        buildResumenFooter(currentOrder, totalsEC2, currentOrder.domicilioTexto) +
        "\n\n¿Qué deseas hacer?",
        [
          { id: "confirmar",   title: "✅ Confirmar" },
          { id: "agregar_mas", title: "➕ Agregar" },
          { id: "eliminar",    title: "🗑️ Quitar" }
        ]
      );
      return res.sendStatus(200);
    }
    // El cliente indica que el pedido está mal → ofrecer corregir
    const esPedidoMalEC =
      lower.includes("esta mal") || lower.includes("está mal") ||
      lower.includes("mal el pedido") || lower.includes("pedido mal") ||
      lower.includes("incorrecto") || lower.includes("equivocado") ||
      lower.includes("no es asi") || lower.includes("no es así") ||
      lower.includes("no es eso") || lower.includes("esta malo");
    if (esPedidoMalEC) {
      await sendWhatsAppButtons(phone,
        "¡Lo corregimos! 😊 ¿Qué deseas hacer con tu pedido?",
        [
          { id: "eliminar",    title: "🗑️ Quitar producto" },
          { id: "agregar_mas", title: "➕ Agregar producto" },
          { id: "4",           title: "📝 Observación" }
        ]
      );
      return res.sendStatus(200);
    }
    currentOrder.cartFreeTextAttempts = (currentOrder.cartFreeTextAttempts || 0) + 1;
    if (currentOrder.cartFreeTextAttempts >= 3) {
      currentOrder.cartFreeTextAttempts = 0;
      updateOrderStep(phone, "esperando_asesor");
      currentOrder = getOrder(phone)!;
      await sendWhatsAppMessage(phone, "Voy a conectarte con un asesor que puede ayudarte mejor 😊");
      sendWhatsAppMessage("573151913928", `💬 Cliente necesita ayuda con carrito\n👤 ${currentOrder.nombre || phone}\n📞 ${phone}`).catch(() => {});
    } else {
      await sendWhatsAppButtons(phone, "¿Qué deseas hacer? 😊", [
        { id: "agregar_mas", title: "➕ Agregar" },
        { id: "eliminar",    title: "🗑️ Quitar" },
        { id: "4",           title: "📝 Observación" }
      ]);
    }
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

      const resumen = order.items.map((item: any) => formatLineaItem(item)).join("\n");
      updateOrderStep(phone, "esperando_confirmacion");
      currentOrder = getOrder(phone)!;

    await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido actualizado es:\n" +
  resumen +
  buildResumenFooter(order, totals, order.domicilioTexto) +
  "\n\n¿Qué deseas hacer?",
 [
    { id: "confirmar",   title: "✅ Confirmar" },
    { id: "agregar_mas", title: "➕ Agregar" },
    { id: "4",           title: "📝 Observación" }
  ]
);
return res.sendStatus(200);
    }
  } else if (!Number.isNaN(Number(lower)) && Number(lower) < 1) {
    const resumen = order.items
      .map((item: any, i: number) => `* ${i + 1}. ${item.producto}${item.variante ? " - " + item.variante : ""}`)
      .join("\n");
    replyMessage =
      "Los números válidos empiezan en 1 😊\n\n" +
      "Respóndeme con el número del producto a retirar:\n\n" +
      resumen;
  } else {
    const lowerInput = lower.trim();

    // ¿Coincide con el nombre de un extra de algún producto?
    const matchExtra = order.items.find((item: any) =>
      (item.extras || []).some((e: any) => e.nombre.toLowerCase().includes(lowerInput))
    );
    if (matchExtra) {
      const resumen = order.items
        .map((item: any, i: number) => `* ${i + 1}. ${item.producto}${item.variante ? " - " + item.variante : ""}`)
        .join("\n");
      replyMessage =
        `Entiendo 😊 Solo puedo retirar productos completos, no extras individuales.\n\n` +
        `Si deseas quitar ese extra, retira el producto y vuélvelo a agregar sin él.\n\n` +
        `¿Cuál producto deseas eliminar?\n\n` + resumen;
    } else {
      // ¿Coincide con el nombre de un producto?
      const matchIdx = order.items.findIndex((item: any) =>
        item.producto.toLowerCase().includes(lowerInput) ||
        (item.variante || "").toLowerCase().includes(lowerInput)
      );
      if (matchIdx !== -1) {
        order.items.splice(matchIdx, 1);
        currentOrder = getOrder(phone)!;

        if (!order.items || order.items.length === 0) {
          updateOrderStep(phone, "armando_pedido");
          currentOrder = getOrder(phone)!;
          if (customer?.name) updateOrderName(phone, customer.name);
          replyMessage =
            "Listo 👍 Ya retiré ese producto.\n\n" +
            "Tu pedido quedó vacío.\n\n" +
            "¿Qué deseas pedir?";
        } else {
          const totals = calculateTotal(order);
          const resumen = order.items.map((item: any) => formatLineaItem(item)).join("\n");
          updateOrderStep(phone, "esperando_confirmacion");
          currentOrder = getOrder(phone)!;
          await sendWhatsAppButtons(phone,
            "Perfecto 👌\n\nTu pedido actualizado es:\n" +
            resumen +
            buildResumenFooter(order, totals, order.domicilioTexto) +
            "\n\n¿Qué deseas hacer?",
            [
              { id: "confirmar",   title: "✅ Confirmar" },
              { id: "agregar_mas", title: "➕ Agregar" },
              { id: "4",           title: "📝 Observación" }
            ]
          );
          return res.sendStatus(200);
        }
      } else {
        const resumen = order.items
          .map((item: any, i: number) => `* ${i + 1}. ${item.producto}${item.variante ? " - " + item.variante : ""}`)
          .join("\n");
        replyMessage =
          "Por favor respóndeme con el número del producto que deseas retirar:\n\n" +
          resumen;
      }
    }
  }

} else if (currentOrder?.step === "esperando_observacion_general") {

  // Si el cliente envió un ID de botón en vez de texto, volver al menú de carrito
  const esBotoneId = /^[1-5d]$/.test(lower) || ["confirmar","agregar_mas","eliminar","agregar"].includes(lower);
  if (esBotoneId) {
    updateOrderStep(phone, "post_agregar_producto");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone, "¿Qué deseas hacer con tu pedido? 😊", [
      { id: "agregar_mas", title: "Agregar más ➕" },
      { id: "eliminar",    title: "Quitar ➖" },
      { id: "4",           title: "Observación 📝" }
    ]);
    return res.sendStatus(200);
  }

  const texto = text.toLowerCase();

  // 👇 AQUÍ VA LA LÓGICA DE MISMA DIRECCIÓN
  if (
    texto.includes("misma direccion") ||
    texto.includes("misma dirección") ||
    texto === "la misma" ||
    texto === "igual"
  ) {
    
   if (tieneUltimaDir) {
  updateOrderAddress(phone, customer.last_address);
}
  }

  const esPreguntaObs = text.includes("?") ||
    /^(ya|cuándo|cuando|está|esta|es que|me puedes|puedes)\b/i.test(text.trim());
  if (esPreguntaObs) {
    await sendWhatsAppMessage(phone, "Tu pedido está en proceso ✅ ¿Necesitas algo más?");
    return res.sendStatus(200);
  }

  if (esObservacionDireccion(text)) {
    updateOrderDireccionNotes(phone, text);
  } else {
    updateOrderGeneralNotes(phone, text);
  }
  updateOrderStep(phone, "esperando_confirmacion");
  currentOrder = getOrder(phone)!;

await sendWhatsAppButtons(phone,
  `Anotado ✅ "${text}"\n\n¿Qué deseas hacer?`,
  [
    { id: "confirmar",   title: "✅ Confirmar" },
    { id: "agregar_mas", title: "➕ Agregar" },
    { id: "eliminar",    title: "🗑️ Quitar" }
  ]
);
return res.sendStatus(200);
    } else if (currentOrder?.step === "post_agregar_producto") {

  // Ver menú en medio del pedido
  if (lower === "2" || lower.includes("menu") || lower.includes("menú") || lower.includes("carta") || lower === "ver menu") {
    await sendWhatsAppMessage(phone,
      "Aquí tienes el menú completo 📋\n\nhttps://menu.tecmenu.com\n\nCuando estés listo, elige una opción 😊"
    );
    return res.sendStatus(200);
  }

  const CONFIRMAR_KEYWORDS = new Set(["confirmar", "a", "1"]);
  if (esBoton && CONFIRMAR_KEYWORDS.has(lower)) {
    currentOrder.cartFreeTextAttempts = 0;
    // Upselling al confirmar — una sola vez, solo si aplica. Omitir pedidos de carta digital.
    if (!currentOrder.vieneDeCarta && !currentOrder.upsellingToppingsMostrado) {
      currentOrder.upsellingToppingsMostrado = true;
      const bebidasCatUps = (menu.categorias as any[]).find((c: any) => c.id === "bebidas");
      const bebidasIdsUps: string[] = bebidasCatUps ? (bebidasCatUps.productos as any[]).map((p: any) => p.id) : [];
      const hasBebida = currentOrder.items.some((i: any) => bebidasIdsUps.includes(i.productoId));
      if (!hasBebida) {
        await sendWhatsAppButtons(phone,
          "¿Te gustaría agregar una bebida? 🥤 Tenemos jugos, limonadas y malteadas.",
          [
            { id: "agregar_mas", title: "Sí, agregar ➕" },
            { id: "confirmar", title: "No, confirmar así ✅" }
          ]
        );
        return res.sendStatus(200);
      }
      const allProdsConfUps = (menu.categorias as any[]).reduce((acc: any[], c: any) => acc.concat(c.productos), []);
      const tieneSaladaSinTocineta = currentOrder.items.some((item: any) => {
        const prod = allProdsConfUps.find((p: any) => p.id === item.productoId);
        const ings: string[] = prod?.ingredientes || [];
        const esSalada = prod && !["bebidas", "dulces", "extras"].includes(
          (menu.categorias as any[]).find((c: any) => (c.productos as any[]).some((p: any) => p.id === item.productoId))?.id || ""
        );
        return esSalada && !ings.some((i: string) => i.toLowerCase().includes("tocineta")) &&
          !(item.extras || []).some((e: any) => e.id === "tocineta" || e.id === "extra_tocineta");
      });
      if (tieneSaladaSinTocineta) {
        await sendWhatsAppButtons(phone,
          "¿Le agregas tocineta a tu crepe por solo $5.500? 🥓",
          [
            { id: "agregar_mas", title: "Sí, agregar ➕" },
            { id: "confirmar", title: "No, confirmar así ✅" }
          ]
        );
        return res.sendStatus(200);
      }
    }

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

    if (!currentOrder.tipoEntrega) {
      updateOrderStep(phone, "esperando_tipo_entrega");
      await sendWhatsAppButtons(phone,
        "¿Cómo deseas recibir tu pedido?",
        [
          { id: "domicilio", title: "Domicilio 🛵" },
          { id: "recoger",   title: "Recoger en tienda 🏪" }
        ]
      );
      return res.sendStatus(200);
    }

   if (currentOrder.tipoEntrega === "domicilio" && !currentOrder.direccion) {
  if (tieneUltimaDir) {
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

    const resumen = order.items.map((item: any) => formatLineaItem(item)).join("\n");

   await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido es:\n" +
  resumen +
  buildResumenFooter(order, totals, order.domicilioTexto) +
  "\n\n¿Qué deseas hacer?",
 [
    { id: "confirmar",   title: "✅ Confirmar" },
    { id: "agregar_mas", title: "➕ Agregar" },
    { id: "eliminar",    title: "🗑️ Quitar" }
  ]
);
return res.sendStatus(200);
  } else if (esBoton && lower === "agregar_mas") {
    currentOrder.cartFreeTextAttempts = 0;
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "¿Qué deseas agregar?\n\n" +
      "Recuerda: un producto por mensaje 😊";

  } else if (esBoton && lower === "eliminar") {
    currentOrder.cartFreeTextAttempts = 0;
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

  } else if (esBoton && lower === "4") {
    currentOrder.cartFreeTextAttempts = 0;
    updateOrderStep(phone, "esperando_observacion_general");
    currentOrder = getOrder(phone)!;

    replyMessage =
      "Perfecto 👌\n\n" +
      "Escríbeme la observación para tu pedido 😊";

  } else {
  // Pregunta por el total del pedido → mostrarlo
  const esPreguntaTotalPAP =
    lower.includes("cuanto seria") || lower.includes("cuánto sería") ||
    lower.includes("cuanto es") || lower.includes("cuánto es") ||
    lower.includes("cuanto va") || lower.includes("cuánto va") ||
    lower.includes("cuanto queda") || lower.includes("cuánto queda") ||
    lower.includes("cuanto sale") || lower.includes("cuánto sale") ||
    lower.includes("cuanto cuesta") || lower.includes("cuánto cuesta") ||
    lower.includes("valor total") || lower.includes("total") ||
    lower.includes("la cuenta") || lower.includes("cuenta por favor") ||
    lower.includes("me cobras") || lower.includes("cuanto le debo") || lower.includes("cuánto le debo") ||
    lower === "cuanto" || lower === "cuánto" || lower === "cuenta";
  if (esPreguntaTotalPAP) {
    const totalsPAP = calculateTotal(currentOrder);
    const resumenPAP = currentOrder.items.map((item: any) => formatLineaItem(item, true)).join("\n");
    await sendWhatsAppButtons(phone,
      "Tu pedido va así 😊\n\n" + resumenPAP +
      `\n\n💵 Subtotal: $${totalsPAP.subtotal.toLocaleString("es-CO")}` +
      "\n\n¿Qué deseas hacer?",
      [
        { id: "confirmar",   title: "✅ Confirmar" },
        { id: "agregar_mas", title: "➕ Agregar" },
        { id: "eliminar",    title: "🗑️ Quitar" }
      ]
    );
    return res.sendStatus(200);
  }
  // El cliente indica que el pedido está mal → ofrecer corregir
  const esPedidoMalPAP =
    lower.includes("esta mal") || lower.includes("está mal") ||
    lower.includes("mal el pedido") || lower.includes("pedido mal") ||
    lower.includes("incorrecto") || lower.includes("equivocado") ||
    lower.includes("no es asi") || lower.includes("no es así") ||
    lower.includes("no es eso") || lower.includes("esta malo");
  if (esPedidoMalPAP) {
    await sendWhatsAppButtons(phone,
      "¡Lo corregimos! 😊 ¿Qué deseas hacer con tu pedido?",
      [
        { id: "eliminar",    title: "🗑️ Quitar producto" },
        { id: "agregar_mas", title: "➕ Agregar producto" },
        { id: "4",           title: "📝 Observación" }
      ]
    );
    return res.sendStatus(200);
  }
  currentOrder.cartFreeTextAttempts = (currentOrder.cartFreeTextAttempts || 0) + 1;
  if (currentOrder.cartFreeTextAttempts >= 3) {
    currentOrder.cartFreeTextAttempts = 0;
    updateOrderStep(phone, "esperando_asesor");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppMessage(phone, "Voy a conectarte con un asesor que puede ayudarte mejor 😊");
    sendWhatsAppMessage("573151913928", `💬 Cliente necesita ayuda con carrito\n👤 ${currentOrder.nombre || phone}\n📞 ${phone}`).catch(() => {});
  } else {
    await sendWhatsAppButtons(phone, "¿Qué deseas hacer? 😊", [
      { id: "agregar_mas", title: "➕ Agregar" },
      { id: "eliminar",    title: "🗑️ Quitar" },
      { id: "4",           title: "📝 Observación" }
    ]);
  }
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
    { id: "bancolombia", title: "Bancolombia/Llave🏦" }
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
    { id: "bancolombia", title: "Bancolombia/Llave🏦" }
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

    const orderEf = getOrder(phone)!;
    const totalsEf = calculateTotal(orderEf);

    await upsertCustomer({ phone, name: orderEf.nombre, last_address: orderEf.direccion, last_order: orderEf.items, last_order_at: new Date().toISOString(), last_sucursal: orderEf.sucursal });
    savePedido({ numero_orden: orderEf.numeroOrden, phone, nombre: orderEf.nombre, direccion: orderEf.direccion, items: orderEf.items, subtotal: totalsEf.subtotal, domicilio: totalsEf.domicilio, total: totalsEf.total, forma_pago: "efectivo", sucursal: orderEf.sucursal, tipo_entrega: orderEf.tipoEntrega, canal: orderEf.canal, confirmed_at: orderEf.confirmedAt, estado: 'recibido', factura: orderEf.factura, email_factura: orderEf.emailFactura, viene_de_carta: orderEf.vieneDeCarta, observaciones_generales: orderEf.observacionesGenerales, asesor_intervenido: orderEf.asesorIntervenido }).catch(e => console.error("❌ savePedido:", e));
    if (orderEf.tipoEntrega === "domicilio") {
      const dirEf = (orderEf.direccion || "").trim();
      const INVALIDAS_DIR = new Set(["hola", "si", "sí", "ok", "espera", "bueno", "bien", "ya", "dale", "listo", "claro", "no"]);
      if (dirEf.length < 5 || INVALIDAS_DIR.has(dirEf.toLowerCase())) {
        sendWhatsAppMessage("573151913928", `⚠️ PEDIDO SIN DIRECCIÓN VÁLIDA\n👤 ${orderEf.nombre || "Sin nombre"}\n📞 ${phone}\nPor favor contactar al cliente.`).catch(e => console.error("❌ Alerta dirección:", e));
      }
    }
    try { await handleOperationalRouting(orderEf, totalsEf); } catch (e) { console.error(e); }

    if (orderEf.sucursal === "la_villa" && orderEf.locationCoords) {
      try {
        await sendWhatsAppLocation("573151913928", orderEf.locationCoords.latitude, orderEf.locationCoords.longitude, orderEf.nombre || "Cliente");
      } catch (e) { console.error("❌ Error enviando ubicación a domiciliarios:", e); }
    }

    console.log(`🖨️ PRINTER CHECK (efectivo): sucursal="${orderEf.sucursal}", url="${process.env.IMPRESORA_LA_VILLA_URL || "https://print.tecmenu.com/imprimir"}"`);
    if (orderEf.sucursal === "la_villa") {
      await fetch(`${process.env.IMPRESORA_LA_VILLA_URL || "https://print.tecmenu.com/imprimir"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: orderEf.nombre || customer?.name || "Cliente",
          telefono: orderEf.telefono,
          pedidoTexto: orderEf.items.map((i: any) => {
            const obs = i.observaciones ? ` (${i.observaciones})` : "";
            const extras = i.extras?.length > 0 ? " +" + i.extras.map((e: any) => e.nombre).join(", +") : "";
            return `${i.producto}${i.variante ? " - " + i.variante : ""}${extras}${obs} ×${i.cantidad}`;
          }),
          subtotal: totalsEf.subtotal,
          domicilio: totalsEf.domicilio,
          total: totalsEf.total,
          direccion: orderEf.direccion || "Recoger en tienda",
          pago: orderEf.formaPago || "No definido",
          tiempoEstimado: orderEf.tipoEntrega === "domicilio" ? "50 min" : "15 min",
          horaPedido: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }),
          sucursal: "La Villa"
        })
      }).then(async r => {
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          console.error(`❌ Impresora La Villa: HTTP ${r.status} → ${body}`);
        } else {
          console.log("🖨️ Impresora La Villa: OK");
        }
      }).catch(err => console.error("❌ Impresora La Villa (red):", err));
    }

    const resumenEf = orderEf.items.map((item: any) => formatLineaItem(item)).join("\n");

    const tiempoEf = orderEf.tipoEntrega === "domicilio" ? "50 min 🚚" : "15 min 🏪";
    if (!orderEf.nombre && customer?.name) updateOrderName(phone, customer.name);

    replyMessage =
      "🔥 Pedido confirmado\n\n" +
      "👤 Nombre: " + (orderEf.nombre || customer?.name || "Cliente") + "\n" +
      "📞 Tel: " + orderEf.telefono + "\n\n" +
      "🧾 Tu pedido:\n" + resumenEf + "\n\n" +
      "💰 Subtotal: $" + totalsEf.subtotal + "\n" +
      (orderEf.tipoEntrega === "domicilio" ? "🚚 Domicilio: $" + totalsEf.domicilio + "\n⚠️ _El costo del domicilio es calculado por Google Maps y puede estar sujeto a ajustes._\n" : "") +
      "💵 Total: $" + totalsEf.total + "\n" +
      (orderEf.observacionesGenerales?.trim() ? "📝 Observación: " + orderEf.observacionesGenerales.trim() + "\n" : "") +
      (orderEf.tipoEntrega === "domicilio" ? "📍 Dirección:\n" + (orderEf.direccion || "No aplica") : "🏪 Recoger en tienda") + "\n\n" +
      "💳 Pago: Efectivo\n" +
      (orderEf.factura ? "📄 Factura: " + orderEf.factura + (orderEf.emailFactura ? " | " + orderEf.emailFactura : "") + "\n" : "") +
      "⏱ Tiempo estimado: " + tiempoEf + "\n" +
      "🕐 Hora: " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }) + "\n\n" +
      "🏪 Sucursal: " + (orderEf.sucursal === "la_villa" ? "La Villa" : orderEf.sucursal === "circunvalar" ? "Av. Circunvalar" : "Por definir") + "\n" +
      "🙏 Gracias por tu pedido en LAS CREPES 🥞";

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
    { id: "bancolombia", title: "Bancolombia/Llave🏦" }
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
    const bancoLlave = orderBanco.sucursal === "circunvalar" ? "0040652828" : "@niet661";
    replyMessage =
      "Perfecto 👌\n\n" +
      `El total a pagar es: $${totalsBanco.total.toLocaleString("es-CO")}\n\n` +
      "Transferencia Bancolombia/Llave:\n" +
      "🏦 Cuenta de ahorros\n" +
      `💳 ${bancoNum}\n` +
      `🔑 Llave: ${bancoLlave}\n\n` +
      "Cuando realices el pago envíame el comprobante 📸";

  } else if (lower === "eliminar" || lower.includes("modificar") || lower.includes("cambiar pedido") || lower.includes("cambiar el pedido")) {
    const orderVolver = getOrder(phone)!;
    const totalsVolver = calculateTotal(orderVolver);
    const resumenVolver = orderVolver.items.map((item: any) => formatLineaItem(item)).join("\n");
    updateOrderStep(phone, "esperando_confirmacion");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "Perfecto 👌\n\nTu pedido es:\n" + resumenVolver +
      buildResumenFooter(orderVolver, totalsVolver, orderVolver.domicilioTexto) +
      "\n\n¿Qué deseas hacer?",
      [
        { id: "confirmar",   title: "✅ Confirmar" },
        { id: "agregar_mas", title: "➕ Agregar" },
        { id: "eliminar",    title: "➖ Quitar" },
        { id: "4",           title: "📝 Observación" }
      ]
    );
    return res.sendStatus(200);
  } else {
    const quiereAsesorPago =
      lower.includes("asesor") || lower.includes("comunicarme") ||
      lower.includes("hablar") || lower.includes("humano") || lower.includes("persona");
    if (quiereAsesorPago) {
      updateOrderStep(phone, "esperando_asesor");
      currentOrder = getOrder(phone)!;
      const nombreAsesorPago = currentOrder.nombre || customer?.name || phone;
      try {
        await sendWhatsAppMessage("573151913928",
          `💬 CLIENTE NECESITA ASESOR EN PAGO\n👤 ${nombreAsesorPago}\n📞 ${phone}\n💬 "${text}"`
        );
      } catch(e) {}
      await sendWhatsAppMessage(phone,
        "Con gusto te comunico con un asesor 😊\n\nEn breve te contactamos.\n\nO llámanos directamente:\n📞 La Villa: *606 341 3020*\n📞 Circunvalar: *606 345 0257*"
      );
      return res.sendStatus(200);
    }
    const totalsElse = calculateTotal(getOrder(phone)!);
    await sendWhatsAppButtons(phone,
      `El total de tu pedido es $${totalsElse.total.toLocaleString("es-CO")} 💰\n¿Cómo deseas pagar?`,
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia/Llave🏦" }
      ]
    );
    return res.sendStatus(200);
  }
} else if (currentOrder?.step === "esperando_factura") {
  const esAgregarMasFact = lower === "agregar_mas" || lower === "agregar más" || lower === "agregar mas" || lower === "agregar";
  if (esAgregarMasFact) {
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppMessage(phone, "Perfecto 😊 ¿Qué más deseas agregar?\n\nEscríbeme el producto:");
    return res.sendStatus(200);
  }

  const quiereFact = lower === "factura_si" || lower.includes("factura_si") ||
    lower.includes("sí, la necesito") || lower.includes("si, la necesito") ||
    lower.includes("necesito factura") || lower.includes("sí necesito");
  const noQuiereFact = lower === "factura_no" || lower.includes("factura_no") ||
    lower.includes("no, gracias") || lower.includes("no gracias") || lower === "no";

  if (quiereFact) {
    updateOrderStep(phone, "esperando_datos_factura");
    currentOrder = getOrder(phone)!;
    replyMessage = "Por favor envíame tu NIT o cédula y razón social para la factura.";
  } else {
    // factura_no o texto libre → guardar como observación y continuar al pago
    if (!noQuiereFact && !esBoton && text.trim().length > 1) {
      updateOrderGeneralNotes(phone, text.trim());
    }
    updateOrderStep(phone, "esperando_pago");
    currentOrder = getOrder(phone)!;
    const totalsParaPago = calculateTotal(getOrder(phone)!);
    await sendWhatsAppButtons(phone,
      `El total de tu pedido es $${totalsParaPago.total.toLocaleString("es-CO")} 💰\n¿Cómo deseas pagar?`,
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia/Llave🏦" }
      ]
    );
    return res.sendStatus(200);
  }

} else if (currentOrder?.step === "esperando_datos_factura") {
  const orderDf = getOrder(phone)!;
  orderDf.factura = text;
  updateOrderStep(phone, "esperando_email_factura");
  replyMessage = "Gracias 🧾 Ahora envíame tu correo electrónico para la factura.";

} else if (currentOrder?.step === "esperando_email_factura") {
  const orderEm = getOrder(phone)!;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(text.trim())) {
    replyMessage = "No reconocí ese correo 📧 Por favor escríbelo así:\n\nejemplo@correo.com";
  } else {
    orderEm.emailFactura = text.trim().toLowerCase();
    updateOrderStep(phone, "esperando_pago");
    currentOrder = getOrder(phone)!;
    const totalsEm = calculateTotal(orderEm);
    await sendWhatsAppButtons(phone,
      `El total de tu pedido es $${totalsEm.total.toLocaleString("es-CO")} 💰\n¿Cómo deseas pagar?`,
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia/Llave🏦" }
      ]
    );
    return res.sendStatus(200);
  }

} else if (currentOrder?.step === "esperando_comprobante") {

  console.log("🔍 DEBUG COMPROBANTE:", JSON.stringify({
    step: currentOrder?.step,
    type: messageData?.type,
    hasImage: !!messageData?.image,
    imageId: messageData?.image?.id,
    hasDocument: !!messageData?.document,
    sucursal: currentOrder?.sucursal,
    phone: phone
  }));

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
    savePedido({ numero_orden: order.numeroOrden, phone, nombre: order.nombre, direccion: order.direccion, items: order.items, subtotal: totals.subtotal, domicilio: totals.domicilio, total: totals.total, forma_pago: order.formaPago, sucursal: order.sucursal, tipo_entrega: order.tipoEntrega, canal: order.canal, confirmed_at: order.confirmedAt, estado: 'recibido', factura: order.factura, email_factura: order.emailFactura, viene_de_carta: order.vieneDeCarta, observaciones_generales: order.observacionesGenerales, asesor_intervenido: order.asesorIntervenido }).catch(e => console.error("❌ savePedido:", e));
    if (order.tipoEntrega === "domicilio") {
      const dirComp = (order.direccion || "").trim();
      const INVALIDAS_DIR_C = new Set(["hola", "si", "sí", "ok", "espera", "bueno", "bien", "ya", "dale", "listo", "claro", "no"]);
      if (dirComp.length < 5 || INVALIDAS_DIR_C.has(dirComp.toLowerCase())) {
        sendWhatsAppMessage("573151913928", `⚠️ PEDIDO SIN DIRECCIÓN VÁLIDA\n👤 ${order.nombre || "Sin nombre"}\n📞 ${phone}\nPor favor contactar al cliente.`).catch(e => console.error("❌ Alerta dirección:", e));
      }
    }

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
        return `* ${item.producto}${item.variante ? " - " + item.variante : ""}${obsTexto}${extrasTexto} ×${item.cantidad}`;
      }).join("\n") +
      `\n\n💰 Subtotal: $${totals.subtotal}` +
      (order.tipoEntrega === "domicilio" ? `\n🚚 Domicilio: $${totals.domicilio}` : "") +
      `\n💵 Total: $${totals.total}\n` +
      `💳 Pago: ${order.formaPago}\n` +
      `🏬 Sucursal: ${order.sucursal === "la_villa" ? "La Villa" : "Av. Circunvalar"}\n` +
      (order.tipoEntrega === "domicilio" && order.direccion ? `📍 Dirección: ${order.direccion}` : "🏪 Recoger en tienda") +
      (order.observacionesGenerales?.trim() ? `\n📝 Observación: ${order.observacionesGenerales.trim()}` : "");

    const DESTINOS_COMPROBANTE = order.sucursal === "circunvalar"
      ? ["573217233342", "573187105601"]
      : ["573151913928", "573207218267"];

    for (const destino of DESTINOS_COMPROBANTE) {
      try {
        await sendWhatsAppMessage(destino, resumenParaSucursal);
        await sendWhatsAppImageById(destino, imageId);
      } catch (e) { console.error(`❌ ERROR reenviando comprobante a ${destino}:`, e); }
    }

    console.log(`🖨️ PRINTER CHECK (comprobante): sucursal="${order.sucursal}", url="${process.env.IMPRESORA_LA_VILLA_URL || "https://print.tecmenu.com/imprimir"}"`);
    if (order.sucursal === "la_villa") {
      await fetch(`${process.env.IMPRESORA_LA_VILLA_URL || "https://print.tecmenu.com/imprimir"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: order.nombre || customer?.name || "Cliente",
          telefono: order.telefono,
          pedidoTexto: order.items.map((i: any) => {
            const obs = i.observaciones ? ` (${i.observaciones})` : "";
            const extras = i.extras?.length > 0 ? " +" + i.extras.map((e: any) => e.nombre).join(", +") : "";
            return `${i.producto}${i.variante ? " - " + i.variante : ""}${extras}${obs} ×${i.cantidad}`;
          }),
          subtotal: totals.subtotal,
          domicilio: totals.domicilio,
          total: totals.total,
          direccion: order.direccion || "Recoger en tienda",
          pago: order.formaPago || "No definido",
          tiempoEstimado: order.tipoEntrega === "domicilio" ? "50 min" : "15 min",
          observacion: order.observacionesGenerales || "",
          horaPedido: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }),
          sucursal: "La Villa"
        })
      }).then(async r => {
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          console.error(`❌ Impresora La Villa: HTTP ${r.status} → ${body}`);
        } else {
          console.log("🖨️ Impresora La Villa: OK");
        }
      }).catch(err => console.error("❌ Impresora La Villa (red):", err));
    }

    const resumenComprobante =
      "🔥 *Tu pedido fue confirmado*\n\n" +
      "🧾 Tu pedido:\n" +
      order.items.map((item: any) => formatLineaItem(item)).join("\n") +
      `\n\n💰 Subtotal: $${totals.subtotal.toLocaleString("es-CO")}` +
      (order.tipoEntrega === "domicilio" ? (totals.domicilio === 0 ? "\n🎉 Domicilio gratis (pedido ≥ $100.000)" : `\n🚚 Domicilio: $${totals.domicilio.toLocaleString("es-CO")}\n⚠️ _El costo del domicilio es calculado por Google Maps y puede estar sujeto a ajustes._`) : "") +
      `\n💵 Total: $${totals.total.toLocaleString("es-CO")}` +
      (order.observacionesGenerales?.trim() ? `\n📝 Observación: ${order.observacionesGenerales.trim()}` : "") +
      (order.direccion ? `\n📍 Dirección: ${order.direccion}` : "") +
      `\n💳 Pago: ${order.formaPago}`;

    await sendWhatsAppMessage(phone, resumenComprobante);
    replyMessage = "Gracias, comprobante recibido ✅ Tu pedido está en proceso 🔥";

  } else if (
    lower.includes("efectivo") || lower.includes("nequi") || lower.includes("daviplata") ||
    lower.includes("bancolombia") || lower.includes("cambiar pago") ||
    lower.includes("cambio de pago") || lower.includes("otro metodo") || lower.includes("otro método")
  ) {
    updateOrderStep(phone, "esperando_pago");
    await sendWhatsAppButtons(phone,
      "Claro 😊 ¿Cómo deseas pagar?",
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia/Llave🏦" }
      ]
    );
    return res.sendStatus(200);
  } else {
    replyMessage = "Por favor envía una foto del comprobante 📸";
  }

} else if (currentOrder?.step === "confirmado") {
  // Verificar si han pasado más de 2 horas desde la confirmación
  const confirmedAtMs = currentOrder.confirmedAt ? new Date(currentOrder.confirmedAt).getTime() : currentOrder.lastInteraction;
  const dosHorasMs = 2 * 60 * 60 * 1000;
  const pedidoVencido = (Date.now() - confirmedAtMs) > dosHorasMs;

  if (pedidoVencido) {
    // Más de 2 horas → limpiar y mostrar menú de bienvenida como cliente recurrente
    clearOrder(phone);
    if (tieneUltimoPedido) {
      await sendWhatsAppButtons(phone,
        MSG_BIENVENIDA_RECURRENTE(customer!.name?.trim() || undefined) + CREBOT_SUFFIX,
        [
          { id: "a", title: "Pedido anterior 🔄" },
          { id: "b", title: "Pedir algo nuevo 🥞" },
          { id: "3", title: "Otros 💬" }
        ]
      );
    } else {
      await sendWhatsAppButtons(phone,
        MSG_BIENVENIDA_NUEVO + CREBOT_SUFFIX,
        [
          { id: "1", title: "Hacer un pedido 🥞" },
          { id: "2", title: "Ver menu 📋" },
          { id: "3", title: "Otros 💬" }
        ]
      );
    }
    return res.sendStatus(200);
  }

  // Menos de 2 horas → pedido todavía en proceso

  // Quiere cancelar pedido ya confirmado
  if (
    lower === "cancelar" || lower === "cancela" ||
    lower.includes("cancelar pedido") ||
    lower.includes("ya no quiero") || lower.includes("ya no lo quiero") ||
    lower.includes("ya no necesito") || lower.includes("ya no lo necesito") ||
    lower.includes("quiero cancelar")
  ) {
    replyMessage = "Entendemos 😊 Para cancelar tu pedido por favor comunícate directamente al 📱 315 191 3928 ya que tu pedido está en preparación.";
    await sendWhatsAppMessage(phone, replyMessage);
    return res.sendStatus(200);
  }

  // Retomar flujo de pago si el cliente quiere pagar desde step confirmado
  const quierePagarConf = lower.includes("pagar") || lower.includes("quiero pagar") ||
    lower.includes("transferencia") || lower.includes("nequi") ||
    lower.includes("bancolombia") || lower.includes("efectivo");
  if (quierePagarConf && currentOrder.items.length > 0 && !currentOrder.formaPago) {
    updateOrderStep(phone, "esperando_pago");
    currentOrder = getOrder(phone)!;
    const totalsConf = calculateTotal(currentOrder);
    await sendWhatsAppButtons(phone,
      `El total de tu pedido es $${totalsConf.total.toLocaleString("es-CO")} 💰\n¿Cómo deseas pagar?`,
      [
        { id: "efectivo", title: "Efectivo 💵" },
        { id: "nequi", title: "Nequi/Daviplata 📱" },
        { id: "bancolombia", title: "Bancolombia/Llave🏦" }
      ]
    );
    return res.sendStatus(200);
  }
  if (
    lower.includes("como va") ||
    lower.includes("cómo va") ||
    lower.includes("cuanto falta") ||
    lower.includes("cuánto falta") ||
    lower.includes("demora") ||
    lower.includes("ya salio") ||
    lower.includes("ya salió") ||
    lower.includes("estado") ||
    lower.includes("tiempo de entrega") ||
    lower.includes("tiempo") ||
    lower.includes("cuánto tarda") ||
    lower.includes("cuanto tarda") ||
    lower.includes("cuándo llega") ||
    lower.includes("cuando llega")
  ) {
    if (currentOrder.tipoEntrega === "recoger") {
      replyMessage = "Tu pedido estará listo en aproximadamente 15-20 minutos 👨‍🍳 Te avisaremos cualquier novedad.";
    } else {
      replyMessage = "Nuestros domicilios tardan aproximadamente de 40 a 50 minutos 🚚\n\nSituaciones adversas como el tráfico o el clima podrían hacer que demore algo más. Te avisaremos si hay alguna novedad.";
    }
  } else if (
    lower.includes("gracias") ||
    lower.includes("ok") ||
    lower.includes("vale") ||
    lower.includes("bueno")
  ) {
    replyMessage =
      "Con gusto 😊 Tu pedido ya está en proceso. Te avisaremos cualquier novedad.";
  } else if (
    lower.includes("me avisas") || lower.includes("avísame") || lower.includes("avisame") ||
    lower.includes("avisa") || lower.includes("me notificas") ||
    lower.includes("listo") || lower.includes("de acuerdo") ||
    lower.includes("entendido") || lower.includes("perfecto") ||
    lower.includes("está bien") || lower.includes("esta bien")
  ) {
    replyMessage = "Claro 😊 Te avisaremos cuando tu pedido esté listo.";
  } else if (
    lower.includes("ya estoy llegando") || lower.includes("voy llegando") ||
    lower.includes("ya llegué") || lower.includes("ya llegue") ||
    lower.includes("estoy afuera") || lower.includes("estoy en la puerta") ||
    lower.includes("ya estoy ahí") || lower.includes("ya estoy ahi") ||
    lower.includes("voy para allá") || lower.includes("voy para alla")
  ) {
    if (currentOrder.tipoEntrega === "recoger") {
      replyMessage = "¡Te esperamos! 😊 Tu pedido estará listo en breve.";
    } else {
      return res.sendStatus(200);
    }
  } else if (lower === "nuevo_pedido_conf" || lower.includes("nuevo pedido") || lower.includes("otro pedido")) {
    clearOrder(phone);
    createOrUpdateOrder(phone, []);
    updateOrderStep(phone, "armando_pedido");
    currentOrder = getOrder(phone)!;
    if (customer?.name && !currentOrder.nombre) updateOrderName(phone, customer.name);
    replyMessage = "Perfecto 👌 ¿Qué deseas pedir?\n\nEscríbeme el producto:\n• 1 Hawaiana\n• 1 Ranchera\n• 1 París...";
  } else if (lower === "hablar_asesor_conf") {
    updateOrderStep(phone, "esperando_asesor");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppMessage(phone,
      "Con gusto te comunico con un asesor 😊\n\nEscríbeme tu consulta y se la hacemos llegar.\n\nO contáctanos directamente al 📱 *315 191 3928*"
    );
    return res.sendStatus(200);
  } else {
    // Consulta de tiempo de entrega — responder antes que la nota de dirección
    const esConsultaTiempoConf =
      lower.includes("demora") || lower.includes("demorar") ||
      lower.includes("cuanto") || lower.includes("cuánto") ||
      lower.includes("tarda") || lower.includes("tiempo") ||
      lower.includes("llega") || lower.includes("falta");
    if (esConsultaTiempoConf) {
      if (currentOrder.tipoEntrega === "recoger") {
        await sendWhatsAppMessage(phone, "Tu pedido estará listo en aproximadamente *15-20 minutos* 👨‍🍳 Te avisaremos cualquier novedad.");
      } else {
        await sendWhatsAppMessage(phone, "Nuestros domicilios tardan aproximadamente *40-50 minutos* 🚚\n\nTe avisaremos si hay alguna novedad.");
      }
      return res.sendStatus(200);
    }
    // Probable detalle de dirección no detectado por PALABRAS_DIRECCION (ej. sector, urbanización)
    if (currentOrder.direccion && text.trim().length > 2 && text.trim().length < 120 && !lower.includes("nuevo") && !lower.includes("asesor")) {
      updateOrderDireccionNotes(phone, text.trim());
      await sendWhatsAppMessage(phone, `Anotado ✅ "${text.trim()}" — se lo enviamos al repartidor 🛵`);
      return res.sendStatus(200);
    }
    currentOrder.cartFreeTextAttempts = (currentOrder.cartFreeTextAttempts || 0) + 1;
    if (currentOrder.cartFreeTextAttempts >= 3) {
      currentOrder.cartFreeTextAttempts = 0;
      updateOrderStep(phone, "esperando_asesor");
      currentOrder = getOrder(phone)!;
      const nombreConf = currentOrder.nombre || customer?.name || phone;
      try {
        await sendWhatsAppMessage("573151913928",
          `💬 CLIENTE EN PEDIDO CONFIRMADO NECESITA ATENCIÓN\n👤 ${nombreConf}\n📞 ${phone}\n💬 "${text}"`
        );
      } catch(e) {}
      await sendWhatsAppMessage(phone,
        "Voy a conectarte con un asesor que puede ayudarte mejor 😊\n\nO llámanos directamente:\n📞 *606 341 3020*"
      );
    } else {
      const nombreHola = currentOrder.nombre || customer?.name || "";
      await sendWhatsAppButtons(phone,
        `Hola de nuevo${nombreHola ? " " + nombreHola : ""} 😊 Tu pedido está en proceso 🔥\n\n¿Deseas hacer algo más?`,
        [
          { id: "nuevo_pedido_conf", title: "Nuevo pedido 🥞" },
          { id: "hablar_asesor_conf", title: "Hablar con asesor 💬" }
        ]
      );
    }
    return res.sendStatus(200);
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
        if (tieneUltimaDir) {
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
    

        const resumen = order.items.map((item: any) => formatLineaItem(item)).join("\n");
      await sendWhatsAppButtons(phone,
  "Perfecto 👌\n\nTu pedido es:\n" +
  resumen +
  buildResumenFooter(order, totals, order.domicilioTexto) +
  "\n\n¿Qué deseas hacer?",
 [
    { id: "confirmar",   title: "✅ Confirmar" },
    { id: "agregar_mas", title: "➕ Agregar" },
    { id: "eliminar",    title: "🗑️ Quitar" }
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
  if (lower === "usar_gps_dir") {
    // Restaurar datos del pin GPS original
    const order = getOrder(phone)!;
    const snap = order.gpsSnapshot;
    if (snap) {
      updateOrderAddress(phone, snap.direccion);
      order.locationCoords = snap.coords;
      order.valorDomicilio = snap.valorDomicilio;
      order.distanciaKm = snap.distanciaKm;
      order.domicilioTexto = snap.domicilioTexto;
    }
    currentOrder = getOrder(phone)!;
    const snapOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      `¿Es correcta esta dirección? 📍\n\n*${snapOrder.direccion}*` +
      (snapOrder.domicilioTexto ? `\n\n${snapOrder.domicilioTexto}` : "") +
      `\n💵 Domicilio: $${(snapOrder.valorDomicilio || 4500).toLocaleString("es-CO")}`,
      [{ id: "a", title: "Confirmar ✅" }, { id: "b", title: "Corregir ✏️" }]
    );
    return res.sendStatus(200);
  }

  if (lower === "a" || lower === "confirmar" || lower === "confirmar_dir_texto" || /\bsi\b/i.test(lower) || /\bsí\b/i.test(lower) || lower.includes("esa misma")) {
  const order = getOrder(phone)!;
  // Si la dirección ya está guardada (nueva dirección capturada), mantenerla.
  // Si no, usar la última dirección del cliente.
  if (!order.direccion && tieneUltimaDir) {
    updateOrderAddress(phone, customer!.last_address!);
  }
  let valorDomicilio = order.valorDomicilio || 4500;
  let descripcionDomicilio = order.domicilioTexto || "";
  if (!order.valorDomicilio) {
    try {
      const calculo = await calcularDomicilio(
        order.direccion || customer?.last_address || "",
        order.sucursal || "la_villa",
        calculateTotal(order).subtotal
      );
      valorDomicilio = calculo.valorDomicilio;
      descripcionDomicilio = calculo.descripcion;
      order.valorDomicilio = valorDomicilio;
      order.distanciaKm = calculo.distanciaKm;
      order.domicilioTexto = calculo.descripcion;
    } catch (e) {
      console.log("Error calculando domicilio:", e);
    }
  }

  updateOrderStep(phone, "esperando_confirmacion");
  currentOrder = getOrder(phone)!;

  const totals = calculateTotal(order, valorDomicilio);

    const resumen = order.items.map((item: any) => formatLineaItem(item)).join("\n");

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
  } else if (
    lower.includes("retirar") || lower.includes("paso a recoger") ||
    lower.includes("voy a recoger") || lower.includes("mejor recojo") ||
    lower.includes("mejor retiro") || lower.includes("prefiero recoger") ||
    lower.includes("prefiero retirar") || lower.includes("pasare a retirar") ||
    lower.includes("pasaré a retirar") || lower.includes("mejor paso")
  ) {
    updateOrderDeliveryType(phone, "recoger");
    currentOrder = getOrder(phone)!;
    currentOrder.direccion = undefined;
    currentOrder.valorDomicilio = 0;
    currentOrder.domicilioTexto = undefined;
    currentOrder.sucursal = undefined;
    updateOrderStep(phone, "esperando_sucursal");
    currentOrder = getOrder(phone)!;
    await sendWhatsAppButtons(phone,
      "Perfecto 👍 ¿En cuál sucursal recoges?",
      [
        { id: "a", title: "La Villa 🏪" },
        { id: "b", title: "Av. Circunvalar 🏪" }
      ]
    );
    return res.sendStatus(200);
  } else {
    const orderFB = getOrder(phone)!;
    if (orderFB.direccion) {
      await sendWhatsAppButtons(phone,
        `¿Es correcta esta dirección? 📍\n\n*${orderFB.direccion}*` +
        (orderFB.domicilioTexto ? `\n\n${orderFB.domicilioTexto}` : "") +
        (orderFB.valorDomicilio ? `\n💵 Domicilio: $${orderFB.valorDomicilio.toLocaleString("es-CO")}` : ""),
        [{ id: "a", title: "Confirmar ✅" }, { id: "b", title: "Corregir ✏️" }]
      );
    } else if (tieneUltimaDir) {
      await sendWhatsAppButtons(phone,
        `Perfecto 👍\n\n¿Deseas usar tu dirección habitual?\n\n📍 ${customer!.last_address}`,
        [{ id: "a", title: "Sí, esa misma ✅" }, { id: "b", title: "No, cambiarla 📍" }]
      );
    } else {
      updateOrderStep(phone, "esperando_direccion");
      currentOrder = getOrder(phone)!;
      replyMessage = "Envíame tu ubicación 📍 o escríbeme tu dirección de domicilio.";
    }
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
    MSG_BIENVENIDA_NUEVO,
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

  } catch (err) {
    console.error("❌ Error fatal en webhook:", err);
    if (_fromPhone && typeof _fromPhone === "string" && !_fromPhone.includes("@g.us") && _fromPhone !== "573151913928") {
      try {
        await sendWhatsAppMessage(_fromPhone, "Voy a conectarte con un asesor 😊");
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendWhatsAppMessage("573151913928", `⚠️ Error en bot\n📞 ${_fromPhone}\n❌ ${errMsg}`);
      } catch (e2) { console.error("❌ Error enviando escalación:", e2); }
    }
    return res.sendStatus(200);
  } finally {
    if (_fromPhone && !_fromPhone.includes("@g.us")) phoneProcessing.delete(_fromPhone);
  }
});
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  asl.getStore()?.logger.error(err);

  if (res.headersSent) return;

  res.status(500);
  res.json({ msg: 'Something went wrong' });
});

// 🕓 Job diario: aviso de bot activo a las 4:00 PM hora Colombia
cron.schedule("0 16 * * *", async () => {
  console.log("🕓 Ejecutando mensaje 4pm a sucursales...");
  const msg = "Envíame un mensaje para activar tus comprobantes";
  const destinatarios = ["573207218267", "573151913928", "573217233342"];
  for (const numero of destinatarios) {
    try {
      await sendWhatsAppMessage(numero, msg);
      console.log(`✅ Mensaje 4pm enviado a ${numero}`);
    } catch (e) {
      console.error(`❌ Error enviando mensaje 4pm a ${numero}:`, e);
    }
  }
}, { timezone: "America/Bogota" });
console.log("🕓 Cron registrado – job 4pm America/Bogota activo");

// ── Panel web de conversaciones ──────────────────────────────────────────────
app.get('/panel', (req, res) => {
  const key = req.query.key;
  if (key !== process.env.PANEL_KEY) {
    return res.status(401).send('Acceso denegado');
  }
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  res.sendFile(path.join(__dirname, '../public/panel.html'));
});

app.get('/carta', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  res.sendFile(path.join(__dirname, '../public/carta.html'));
});

app.get('/pedidos', (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  res.sendFile(path.join(__dirname, '../public/pedidos.html'));
});

app.get('/api/conversaciones', async (req, res) => {
  const key = req.query.key as string | undefined;
  if (!key || key !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: "Acceso no autorizado" });
  }
  const rows = await getConversaciones();
  res.json(rows);
});

app.get('/api/conversacion/:phone', async (req, res) => {
  const key = req.query.key as string | undefined;
  if (!key || key !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: "Acceso no autorizado" });
  }
  const rows = await getConversacion(req.params.phone);
  res.json(rows);
});

app.post('/api/enviar-mensaje', async (req, res) => {
  const { phone, mensaje, key } = req.body || {};
  if (!key || key !== process.env.PANEL_KEY) {
    return res.status(401).json({ ok: false, error: "Acceso no autorizado" });
  }
  if (!phone || !mensaje) {
    return res.status(400).json({ ok: false, error: "Faltan parámetros" });
  }
  try {
    await sendWhatsAppMessage(phone, mensaje);
    await saveMessage(phone, "asesor", mensaje);
    const sessionOrder = getOrder(phone);
    if (sessionOrder) {
      sessionOrder.asesorIntervenido = true;
      // Cambiar step a esperando_asesor para que el timer de inactividad se cancele
      // y el bot quede en silencio mientras el asesor maneja la conversación
      if (sessionOrder.step !== "confirmado") {
        updateOrderStep(phone, "esperando_asesor");
      }
    }
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("❌ Error enviando mensaje desde panel:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Error interno" });
  }
});

// ── Panel de operaciones ──────────────────────────────────────────────────────
app.get('/operaciones', (req, res) => {
  const key = req.query.key;
  if (key !== process.env.PANEL_KEY) {
    return res.status(401).send('Acceso denegado');
  }
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  res.sendFile(path.join(__dirname, '../public/operaciones.html'));
});

app.get('/api/pedidos', async (req, res) => {
  const key = req.query.key as string | undefined;
  if (!key || key !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: "Acceso no autorizado" });
  }
  const rows = await getPedidosUltimas24h();
  res.json(rows);
});

app.get('/api/pedidos/archivados', async (req, res) => {
  const key = req.query.key as string | undefined;
  if (!key || key !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: "Acceso no autorizado" });
  }
  const rows = await getPedidosArchivados();
  res.json(rows);
});

app.post('/api/pedidos/:id/estado', async (req, res) => {
  const key = req.headers['x-panel-key'] as string | undefined;
  if (!key || key !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: "Acceso no autorizado" });
  }
  const id = parseInt(req.params.id);
  const { estado } = req.body || {};
  const ESTADOS_VALIDOS = ['en_preparacion', 'en_camino', 'entregado'];
  if (!estado || isNaN(id) || !ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: "Parámetros inválidos" });
  }
  await updatePedidoEstado(id, estado);
  const pedido = await getPedidoById(id);
  if (pedido?.phone) {
    const nombre = pedido.nombre || "Cliente";
    const msgs: Record<string, string> = {
      en_preparacion: `🍳 ¡Hola ${nombre}! Tu pedido está en preparación. ¡Ya casi! 🥞`,
      en_camino:      `🛵 ¡Hola ${nombre}! Tu pedido está en camino 🛵\nPronto podrás disfrutar de tus deliciosas crepes 🥞`,
      entregado:      `✅ ¡Hola ${nombre}! Tu pedido fue entregado.\nGracias por tu orden 🥞 ¡Hasta pronto!`
    };
    sendWhatsAppMessage(pedido.phone, msgs[estado])
      .catch(e => console.error("❌ Notif estado:", e));
  }
  res.json({ ok: true, id, estado });
});

app.put('/api/pedidos/:id/estado', async (req, res) => {
  const key = (req.query.key || req.body?.key) as string | undefined;
  if (!key || key !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: "Acceso no autorizado" });
  }
  const id = parseInt(req.params.id);
  const { estado } = req.body || {};
  if (!estado || isNaN(id)) {
    return res.status(400).json({ error: "Faltan parámetros" });
  }
  await updatePedidoEstado(id, estado);

  const pedido = await getPedidoById(id);
  if (pedido?.phone) {
    const nombre2 = pedido.nombre || "Cliente";
    if (estado === "en_camino") {
      sendWhatsAppMessage(pedido.phone, `🛵 ¡Hola ${nombre2}! Tu pedido está en camino 🛵\nPronto podrás disfrutar de tus deliciosas crepes 🥞`).catch(e => console.error("❌ Notif en_camino:", e));
    } else if (estado === "entregado") {
      sendWhatsAppMessage(pedido.phone, `✅ ¡Hola ${nombre2}! Tu pedido fue entregado.\nGracias por tu orden 🥞 ¡Hasta pronto!`).catch(e => console.error("❌ Notif entregado:", e));
    }
  }

  res.json({ ok: true });
});
// ─────────────────────────────────────────────────────────────────────────────

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
