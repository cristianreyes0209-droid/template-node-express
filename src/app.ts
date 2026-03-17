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
  updateOrderStep
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

if (currentOrder?.step === "esperando_nombre") {
  updateOrderName(phone, text);
  updateOrderStep(phone, "esperando_tipo_entrega");
  replyMessage = "Mucho gusto " + text + ".\n\n¿Tu pedido es para domicilio o recoger?";
} else if (currentOrder?.step === "esperando_tipo_entrega") {
  if (lower.includes("domicilio")) {
    updateOrderStep(phone, "esperando_direccion");
    replyMessage = "Perfecto.\n\n¿Me compartes tu dirección por favor?";
  } else if (lower.includes("recoger") || lower.includes("llevar")) {
    updateOrderStep(phone, "pedido_confirmado");
    replyMessage = "Perfecto.\n\nTu pedido estará listo para recoger. Te avisaremos cuando esté listo.";
  } else {
    replyMessage = "Por favor dime si tu pedido es para domicilio o para recoger.";
  }
} else if (lower.startsWith("ya") || lower.startsWith("listo")) {
  updateOrderStep(phone, "esperando_nombre");
  replyMessage = "Perfecto. ¿Cómo es tu nombre?";
} else if (lower.includes("hola")) {
  replyMessage =
    "Hola 👋 Qué alegría atenderte en Las Crepes de París 🥞\n\n" +
    "Por aquí puedes pedir para:\n" +
    "🚚 Domicilio\n" +
    "🛍️ Recoger\n\n" +
    "Nuestras crepes favoritas hoy son:\n" +
    "🔥 París\n" +
    "🌽 Desgranada mixta\n" +
    "🌶️ Mexicana\n" +
    "🍍 Hawaiana\n\n" +
    "También tenemos dulces deliciosas:\n" +
    "🍫 Nutella\n" +
    "🥭 Tropinutella\n" +
    "🍍 Tropical\n\n" +
    "Puedes escribir tu pedido así:\n" +
    "\"Quiero una mexicana y una nutella\"";
} else if (parsedItems.length > 0) {
  const order = createOrUpdateOrder(phone, parsedItems);

  const resumen = order.items
    .map((item: any) => `• ${item.cantidad} ${item.producto}`)
    .join("\n");

  replyMessage =
    "Perfecto 👌\n\n" +
    "Estoy registrando:\n\n" +
    resumen +
    "\n\n¿Deseas agregar otra crepe, bebida o topping?";
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
      "Authorization": "Bearer EAAKig65Oi0EBQ9WXeswuk9EfFJLfGgZCGZAILYH738mQsY22g69VM5dduEkr3rCINmuq3klvOR6WTXzxZBGEC7VhTi0DSDH1se1uaMZCOhU6fDUx5JXCKZCJr3POv4wEDZCrvDEILSsf21WSpePpeDixQ4ln8h7WUalLnOqkWZCThjWbnOvf5SRUOqyFi3BazK20Iyhx5mM8VwZBGs7e3Sdctn73lZAVL1ciqstf4snowp3TyelV68ZAIr2ZBhR0MuTnMftrffkXM5ZATZAz9yuS4iWuQfwZDZD",
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
    }
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
