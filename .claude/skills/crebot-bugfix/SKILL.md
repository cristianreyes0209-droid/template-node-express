---
name: crebot-bugfix
description: >
  Revisar conversaciones reales de WhatsApp del bot de Las Crepes (CreBot),
  compilar un backlog de bugs y arreglarlos en UN SOLO commit. Úsala cuando el
  usuario pegue chats del bot, reporte que "se perdió la observación / la
  dirección / el pedido", que un producto no se reconoció, que hubo un
  sobrecobro, o que el flujo se atascó. También cubre optimizar la carta
  digital (menu.tecmenu.com) y el flujo de deploy.
---

# CreBot — Revisión de chats y arreglo de bugs

Bot de WhatsApp en producción para **Las Crepes de París** (Pereira). Recibe
mensajes, interpreta pedidos en lenguaje natural y gestiona toda la compra.

## Reglas de oro (no romper)

1. **UN SOLO commit al final.** Cada `git push` a `main` redeploya en Render y
   **borra las sesiones activas en memoria** (pedidos a medio armar viven en
   `orders.ts`). Junta todos los arreglos y haz un único commit + push, en
   horario de baja demanda. No commitees cambios doc-only por separado.
2. **Reproduce antes de arreglar.** Todo bug de parseo se replica con un script
   `ts-node` que llama `parseOrder(...)` ANTES y DESPUÉS del fix (ver receta).
3. **`npx tsc --noEmit` limpio** antes de cada commit.
4. **No cambiar precios de `menu.ts`** sin confirmar con el usuario.
5. **Prefiere bajo sobrecobro que sobrecobro.** Ante duda, no agregues extras
   pagos (mejor perder un extra que cobrar de más).
6. **Flujo de trabajo:** el usuario pega varios chats → tú los revisas y anotas
   el backlog (sin implementar) → cuando diga "va"/"ya" implementas TODO junto.
   Marca cada bug como 🔴 (crítico: sobrecobro/dato perdido) o normal.

## Mapa del código

| Archivo | Qué tiene |
|---|---|
| `src/app.ts` (~6500 l) | NÚCLEO: webhook, máquina de estados por `step`, envío de mensajes. **Revisar con cuidado.** |
| `src/parser.ts` (~1100 l) | `parseOrder`, `normalizeText`, `extractObservaciones`, `extractExtrasFromFragment`, `classifyWithAI` (Gemini), `consultarCrepesPorIngrediente`. |
| `src/menu.ts` | Productos, precios, **aliases**, extras, variantes. Al agregar productos, agregar aliases. |
| `src/orders.ts` | Estado en memoria por teléfono (`CustomerOrder`, `createOrUpdateOrder`, `updateOrderGeneralNotes`, `calculateTotal`). Se pierde al reiniciar. |
| `src/db.ts` | PostgreSQL: clientes, pedidos, descuentos, `config` (getConfig/setConfig). |

**Stack:** Node + TS + Express + WhatsApp Cloud API + PostgreSQL + Gemini + Render.
**Gemini:** modelo `gemini-flash-latest` (los `gemini-2.x-flash` dan 404 para esta key). Constante `GEMINI_MODEL` en `parser.ts`.

## Flujo del pedido (steps clave)
`esperando_menu_principal → esperando_tipo_entrega → esperando_sucursal →
armando_pedido → post_agregar_producto → esperando_confirmacion →
esperando_nombre → esperando_direccion → esperando_confirmacion_direccion →
esperando_pago → esperando_comprobante → confirmado`

## Patrones de bug ya vistos (dónde mirar)

### Parser (`parser.ts` / `menu.ts`)
- **"solo con X" / "solo X"** = el cliente quiere ÚNICAMENTE X → es **observación**
  ("solo X"), NUNCA agregar extras. `extractExtrasFromFragment` retorna `[]` si hay
  `\bsolo\b`; `extractObservaciones` captura "solo X".
- **Queso genérico vs específico:** "con queso cuajada" NO debe agregar también
  "queso doble crema". El alias `queso` se salta si hay `queso (cuajada|americano|parmesano...)`.
- **"si X" = typo de "sin X"** (falta la n) solo si X es ingrediente removible
  (whitelist en `extractObservaciones`). No tocar "sí" confirmación.
- **Combos con "con"** ("pollo con piña" → *Pollo y Piña*): agregar aliases con
  "con" al producto combo en `menu.ts` (ej. `pollo_y_pina`, `pollo_y_carne`).
- **Typos de producto:** agregar reemplazos en `normalizeText` (ej. `creppes→crepe`,
  `attun→atun`, junto a los ya existentes).
- **Consulta "¿qué crepes/opciones con X tienen?"** → `consultarCrepesPorIngrediente`
  (determinístico, no depende de Gemini). Se responde temprano en `app.ts` antes del parseo.

### Flujo (`app.ts` / `orders.ts`)
- **Handlers globales secuestran pasos de captura.** Los bloques globales de
  pago (`esPreguntaPago`, ~L1820) y factura corren ANTES de los handlers por
  `step`. Si el cliente escribe "...para pagar por transferencia" mientras da la
  dirección, no debe mostrarse el menú de pago. Gate: `enStepCapturaDatos`
  (`esperando_direccion`/`esperando_nombre`/`esperando_confirmacion_direccion`).
- **Nombre = dirección:** en `esperando_nombre` (~L4388) rechazar texto que parezca
  dirección (manzana/casa/piso/calle/cra + dígitos).
- **Dirección pedida dos veces / sobrescrita:** tras el nombre, si ya hay
  dirección de domicilio NO volver a pedirla (~L4433). En
  `esperando_confirmacion_direccion` (~L6163) el texto libre = **complemento** de
  dirección (apto/casa/torre), agrégalo, no lo ignores.
- **Observaciones se pierden:** `updateOrderGeneralNotes` (orders.ts) **acumula**
  (no sobrescribe) con dedup.
- **Carta digital** ("🥞 PEDIDO - LAS CREPES", `app.ts` ~L2363): ya preserva
  `tipoEntrega`/`sucursal` previos al pegar el pedido (L2366-2374).
- **Notas de voz:** se transcriben con Gemini y, en pasos de carrito, el
  `editarCarritoPorVoz`/`aplicarClasificacionIA` permite corregir
  (eliminar/reemplazar/extra) hablando.

### Pendientes conocidos (difíciles)
- Distribuir modificadores "ambos"/"uno de ellos" a ítems específicos (obs por-ítem).
- Texto libre en el paso de factura.

## Receta de verificación (parser)
```bash
cd <repo>
cat > _t.ts <<'EOF'
import { parseOrder } from "./src/parser";
const P = (t:string)=>JSON.stringify(parseOrder(t).items.map(i=>({p:i.producto,c:i.cantidad,obs:i.observaciones,ex:(i.extras||[]).map((e:any)=>e.nombre)})));
console.log(P("<caso del chat>"));
EOF
npx ts-node _t.ts; rm -f _t.ts
```
Incluir siempre casos de **regresión** (pedidos que YA funcionaban) para no romperlos.

## Deploy
- **Bot:** `git push origin main` → Render redeploya solo (~1-2 min, reinicia sesiones).
- **Carta digital `menu.tecmenu.com`:** es un proyecto **Cloudflare Pages**
  llamado **`tecmenu-carta`** (Direct Upload, sin git). `grill.tecmenu.com` es
  otro (Worker `purple-shadow`). `public/carta.html` del repo es copia idéntica.
  Para publicar: subir la carpeta (index.html + uploads/) al proyecto de Pages.

### Optimización de la carta (LCP)
- La carta cargaba lenta por **Babel Standalone + React dev** (transpila JSX en
  el navegador) y **fotos de 10-19 MB**. Fix: precompilar el JSX con `tsc`
  (`--jsx react`, sin Babel), usar `react.production.min.js`, y optimizar
  `public/uploads` con **sharp** (máx 1000px, JPEG q78) → ~100 KB c/u.
- El LCP en Cloudflare Web Analytics tiene **rezago** (ventana "Last 24h"); no
  juzgar el efecto de un deploy hasta que pase el tiempo. Un **splash de ~4s**
  puede empujar el LCP a "Poor" en visitantes nuevos (pendiente de acortar).

## Cómo ejecutar esta skill
1. Por cada chat que pegue el usuario: identifica el/los bug(s), repró­dulos con
   `parseOrder` cuando sea de parseo, y anótalos en un backlog (marca 🔴 críticos).
   Di qué archivos/handlers están involucrados. NO implementes aún.
2. Cuando el usuario diga "va"/"ya": implementa TODOS los fixes, verifica cada
   uno + regresiones, `npx tsc --noEmit`, y haz **un solo** `git commit` + `push`
   con un mensaje que liste los bugs (Bn: descripción).
3. Si el bug es de la carta digital, entrega el `carta.html`/carpeta optimizada
   para subir a Cloudflare Pages `tecmenu-carta` (no va por Render).
