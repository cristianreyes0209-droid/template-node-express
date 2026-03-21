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
  createOrUpdateOrder,
  getOrder,
  updateOrderName,
  updateOrderStep,
  updateOrderAddress,
  updateOrderDeliveryType,
    updateOrderPayment,
  calculateTotal
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
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }

  }

});
app.post('/whatsapp', async (req, res) => {

const message = req.body;

console.log("============== PAYLOAD ==============");
console.log(JSON.stringify(req.body, null, 2));
console.log("=====================================");

console.log("Mensaje recibido de WhatsApp:", message);
console.log(JSON.stringify(message, null, 2));

const messageData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

if (!messageData) {
  console.log("No hay mensaje de usuario");
  return res.sendStatus(200);
}

const phone = messageData.from;
const text = messageData.text?.body || "mensaje";
const currentOrder = getOrder(phone);

console.log("PHONE:", phone);
console.log("TEXT:", text);

if (!phone) {
  console.log("Evento sin telefono");
  return res.sendStatus(200);
}

let replyMessage = "";
const parsedItems = parseOrder(text);
const lower = text.toLowerCase();

// Timeout por inactividad
if (currentOrder) {
  const now = Date.now();
  const diff = now - (currentOrder.lastInteraction || 0);
  const THIRTY_MIN = 30 * 60 * 1000; // prueba; luego subes a 30 * 60 * 1000

  if (diff > THIRTY_MIN && currentOrder.step !== "confirmado") {
    currentOrder.items = [];
    currentOrder.nombre = undefined;
    currentOrder.tipoEntrega = undefined;
    currentOrder.direccion = undefined;
    currentOrder.formaPago = undefined;
    currentOrder.step = "esperando_nombre";
    currentOrder.lastInteraction = now;

    replyMessage =
      "¡Hola de nuevo! 😊\n\n" +
      "Parece que pasó un tiempo. Vamos a empezar de nuevo.\n\n" +
      "¿Cómo es tu nombre?";

    await fetch(
      "https://graph.facebook.com/v18.0/1066064689915977/messages",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: { body: replyMessage }
        })
      }
    );

    return res.sendStatus(200);
  }

  currentOrder.lastInteraction = now;
}

// PRIORIDAD 1: si el mensaje trae productos, se procesan primero
if (parsedItems.length > 0) {
  const order = createOrUpdateOrder(phone, parsedItems);
  updateOrderStep(phone, "armando_pedido");

  const resumen = order.items
    .map((item: any) => `• ${item.cantidad} ${item.producto}`)
    .join("\n");

  replyMessage =
    "Perfecto 👌\n\n" +
    "Estoy registrando:\n\n" +
    resumen +
    "\n\n¿Deseas agregar otra crepe, bebida o topping?";

if (currentOrder?.step === "esperando_nombre") {
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
    updateOrderStep(phone, "esperando_tipo_entrega");
    replyMessage = "Mucho gusto " + text + ".\n\n¿Tu pedido es para domicilio o recoger?";
  }
}

} else if (currentOrder?.step === "esperando_tipo_entrega") {
  if (lower.includes("domicilio")) {
    updateOrderDeliveryType(phone, "domicilio");
    updateOrderStep(phone, "esperando_direccion");

    const order = getOrder(phone)!;
    const totals = calculateTotal(order);

    const resumen = order.items
      .map((item: any) => "• " + item.cantidad + " " + item.producto)
      .join("\n");

    replyMessage =
      "Perfecto 👌\n\n" +
      "Tu pedido es:\n" +
      resumen +
      "\n\nSubtotal: $" + totals.subtotal +
      "\nDomicilio: por confirmar" +
      "\nTotal: $" + totals.total +
      "\n\n¿Me compartes tu dirección por favor?";
  } else if (lower.includes("recoger") || lower.includes("llevar")) {
    updateOrderDeliveryType(phone, "recoger");
    updateOrderStep(phone, "confirmado");

    replyMessage =
      "Perfecto 👌\n\nTu pedido estará listo para recoger. Te avisaremos cuando esté listo.";
  } else {
    replyMessage = "Por favor dime si tu pedido es para domicilio o para recoger.";
  }

} else if (currentOrder?.step === "esperando_direccion") {
  updateOrderAddress(phone, text);

  const order = getOrder(phone)!;
  const totals = calculateTotal(order);

  const resumen = order.items
    .map((item: any) => "• " + item.cantidad + " " + item.producto)
    .join("\n");

  updateOrderStep(phone, "esperando_confirmacion");

  replyMessage =
    "Perfecto 👌\n\n" +
    "Tu pedido es:\n" +
    resumen +
    "\n\nSubtotal: $" + totals.subtotal +
    "\nDomicilio: $" + totals.domicilio +
    "\nTotal: $" + totals.total +
    "\n📍 Dirección: " + order.direccion +
    "\n\n¿Confirmas tu pedido? (SI / NO)";

} else if (currentOrder?.step === "esperando_confirmacion") {
  if (lower.includes("si")) {
    updateOrderStep(phone, "esperando_pago");

    replyMessage =
      "Perfecto 👌\n\n¿Cómo deseas pagar?\n" +
      "• Efectivo\n" +
      "• Nequi\n" +
      "• Daviplata\n" +
      "• Bancolombia";
  } else if (lower.includes("no")) {
    updateOrderStep(phone, "armando_pedido");
    replyMessage = "Perfecto 👍 ¿Qué deseas cambiar?";
  } else {
    replyMessage = "Por favor responde SI o NO para confirmar tu pedido.";
  }

} else if (currentOrder?.step === "esperando_pago") {
  if (lower.includes("efectivo")) {
    updateOrderPayment(phone, "efectivo");
    updateOrderStep(phone, "confirmado");

    replyMessage =
      "🔥 Pedido confirmado\n\n" +
      "Pago: Efectivo\n" +
      "Tiempo estimado: 40-50 min 🚚";
  } else if (lower.includes("nequi")) {
    updateOrderPayment(phone, "nequi");
    updateOrderStep(phone, "esperando_comprobante");

    replyMessage =
      "Perfecto 👌\n\n" +
      "Pago por Nequi:\n" +
      "📱 3207218267\n\n" +
      "Cuando realices el pago, envíame el comprobante o escribe 'listo'.";
  } else if (lower.includes("daviplata")) {
    updateOrderPayment(phone, "daviplata");
    updateOrderStep(phone, "esperando_comprobante");

    replyMessage =
      "Perfecto 👌\n\n" +
      "Pago por Daviplata:\n" +
      "📱 3207218267\n\n" +
      "Cuando realices el pago, envíame el comprobante o escribe 'listo'.";
  } else if (lower.includes("bancolombia") || lower.includes("transferencia")) {
    updateOrderPayment(phone, "bancolombia");
    updateOrderStep(phone, "esperando_comprobante");

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
  if (lower.includes("listo") || lower.includes("ya")) {
    updateOrderStep(phone, "confirmado");

    replyMessage =
      "🔥 Pago recibido\n\n" +
      "Pedido confirmado\n" +
      "Tiempo estimado: 40-50 min 🚚";
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
      "Tu pedido ya fue confirmado ✅\n\n" +
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
      "Puedes decirme otra crepe, bebida o topping.";
  } else if (
    lower.includes("no") ||
    lower.includes("nada") ||
    lower.includes("listo") ||
    lower.includes("no mas") ||
    lower.includes("no más") ||
    lower.includes("eso es todo")
  ) {
    updateOrderStep(phone, "esperando_nombre");
    replyMessage =
      "Perfecto 👍\n\n" +
      "Antes de continuar, ¿cómo es tu nombre?";
  } else {
    replyMessage =
      "¿Deseas agregar algo más? 😊\n\n" +
      "Puedes escribir otra crepe, bebida o topping, o responder SI o NO.";
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

const response = await fetch(
  "https://graph.facebook.com/v18.0/1066064689915977/messages",
  {
    method: "POST",
    headers: {
      "Authorization": "Bearer EAAKig65Oi0EBRMcJ46rNY78RiBoZCpwCaJk91tvoiDdopw06H1IOgZBZAYPvhuEcELflYNgqNsWCZBX69izf8o2vPyrJzihMYZB7sJnayw5pZAG396NvM99ZCZAeAG2ZBwLaL9UIo6eRrmKZCsaGOZBdwHZCs0zz1MpZCXCKVfBCZAmzMcfV687NeVxMnK8DFJQzUZAZAiaZBZABW3TZBRdgxkj4Sx5uTSL48nZBvtSmoe93crzseHAh3ljAEdEsY8ZBbgs0jvhmHyzjQKfkZAiMi4cS4FTIUYdNq9NwZDZD",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: {
        body: replyMessage
      }
    })
  }
);

const data = await response.json();
console.log("RESPUESTA META:", data);
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
