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
    let replyMessage = "";
const parsedItems = parseOrder(text);
const lower = text.toLowerCase();
     if (currentOrder?.step === "esperando_nombre") {
   
  updateOrderName(phone, text);
  updateOrderStep(phone, "esperando_tipo_entrega");

replyMessage = `Mucho gusto ${text} 😊
¿Tu pedido es para domicilio 🚚 o recoger 🛍?`;

  await fetch("https://graph.facebook.com/v18.0/1066064689915977/messages", {
    method: "POST",
    headers: {
      "Authorization": "Bearer EAAKig65Oi0EBQwzWgyG6e6J3ti872x2flj0fVAXJJxl6k1Tj5euepZAtAZAapfHOR8HC2xfAvte0z6fJMscDY5BsNmlveXpBQak40V4KI97bYIXWXZCqRoRo0VZBLWqPwQNoqaA3JSvPSkxX6cpi1q3E8LRbP63ETEIdHxAOuvk3zcdLVCJ49dXDATarc4X3Yfmp3ajetKZB4ANbZBZCzx1hc8ZClbZBrEqZCsJwAliVGQPsnB91IcBOT8vJkncrZAitnBdoZBZCdAwCRQpgV6FIl0Vh28AZDZD",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      text: { body: replyMessage }
    })
  });

  return res.sendStatus(200);
}

if (lower.startsWith("ya") || lower.startsWith("listo")) {
    updateOrderStep(phone, "esperando_nombre");
  replyMessage = "Perfecto 👍 ¿Cómo es tu nombre?";
    updateOrderStep(phone, "esperando_nombre");

  await fetch(`https://graph.facebook.com/v18.0/1066064689915977/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer EAAKig65Oi0EBQwzWgyG6e6J3ti872x2flj0fVAXJJxl6k1Tj5euepZAtAZAapfHOR8HC2xfAvte0z6fJMscDY5BsNmlveXpBQak40V4KI97bYIXWXZCqRoRo0VZBLWqPwQNoqaA3JSvPSkxX6cpi1q3E8LRbP63ETEIdHxAOuvk3zcdLVCJ49dXDATarc4X3Yfmp3ajetKZB4ANbZBZCzx1hc8ZClbZBrEqZCsJwAliVGQPsnB91IcBOT8vJkncrZAitnBdoZBZCdAwCRQpgV6FIl0Vh28AZDZD ",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      text: { body: replyMessage }
    })
  });

  return res.sendStatus(200);
}

if (!replyMessage && parsedItems.length > 0) {
  const order = createOrUpdateOrder(phone, parsedItems);

  const resumen = order.items
    .map((item: any) => `• ${item.cantidad} ${item.producto}`)
    .join("\n");

  replyMessage = `Perfecto 👌

Estoy registrando:

${resumen}

¿Deseas agregar otra crepe, bebida o topping?`;
}



if (text.toLowerCase().includes("hola")) {
  replyMessage = `Hola 👋 Qué alegría atenderte en Las Crepes de París 🥞

Por aquí puedes pedir para:
🚚 Domicilio
🛍️ Recoger

Nuestras crepes favoritas hoy son:

🔥 París
🌽 Desgranada mixta
🌶 Mexicana
🍍 Hawaiana

También tenemos dulces deliciosas:
🍫 Nutella
🥭 Tropinutella
🍍 Tropical

Puedes escribir tu pedido así:
"Quiero una mexicana y una nutella"`;
} else if (parsedItems.length > 0) {
  const resumen = parsedItems
    .map((item: any) => `• ${item.cantidad} ${item.producto}`)
    .join("\n");

  replyMessage = `Perfecto 👌

Estoy registrando:

${resumen}

¿Deseas agregar otra crepe, bebida o topping?`;
} else {
  replyMessage = `Con gusto te ayudo 😊

Puedes pedirme una crepe así:
• 1 París
• 2 Hawaianas
• 1 Nutella y 1 Tropical

También puedo ayudarte con domicilio o recoger.`;
}

// 1) Si no hay teléfono, terminar aquí
if (!phone) {
  console.log("Evento sin telefono");
  return res.sendStatus(200);
}

// 2) Responder rápido al webhook
res.sendStatus(200);

// 3) Enviar el mensaje
console.log("ENVIANDO MENSAJE A:", phone);

try {
const response = await fetch(
"https://graph.facebook.com/v18.0/1066064689915977/messages",
{
method: "POST",
headers: {
  "Authorization": "Bearer EAAKig65Oi0EBQwzWgyG6e6J3ti872x2flj0fVAXJJxl6k1Tj5euepZAtAZAapfHOR8HC2xfAvte0z6fJMscDY5BsNmlveXpBQak40V4KI97bYIXWXZCqRoRo0VZBLWqPwQNoqaA3JSvPSkxX6cpi1q3E8LRbP63ETEIdHxAOuvk3zcdLVCJ49dXDATarc4X3Yfmp3ajetKZB4ANbZBZCzx1hc8ZClbZBrEqZCsJwAliVGQPsnB91IcBOT8vJkncrZAitnBdoZBZCdAwCRQpgV6FIl0Vh28AZDZD",
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
    } catch (error) {
  console.log("ERROR EN FETCH:", error);
}

});
    app.get('/abort-signal-propagation', async (req, res) => {
        for (let i = 0; i < 10; i++) {
            // simulate some work
            await new Promise((r) => setTimeout(r, 25));

            if (req.abortSignal.aborted) throw new Error('aborted');
        }

        const usersRes = await fetch(
            'https://jsonplaceholder.typicode.com/users',
            {
                signal: req.abortSignal,
            }
        );
        if (usersRes.status !== 200) {
            throw new Error(
                `unexpected non-200 status code ${usersRes.status}`
            );
        }
        const users = await usersRes.json();
        res.json(users);
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
