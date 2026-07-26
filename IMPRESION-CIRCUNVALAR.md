# Impresión de comandas en Circunvalar

Circunvalar imprime **desde el navegador del panel** (no usa la impresora automática por URL de La Villa).
Hay dos modos: **manual** (un clic por pedido) y **automático** (sin diálogo, con Chrome en modo kiosco).

---

## Modo manual (funciona en cualquier equipo, sin configurar nada)

1. Abre el panel: `https://TU-PANEL.onrender.com/dashboard?key=Crepes0209`
2. Haz clic en un pedido para ver el detalle.
3. Toca **"🖨️ Imprimir (local)"** → sale el diálogo de impresión del navegador → **Imprimir**.

> Para ver la comanda sin gastar papel, en el diálogo elige **"Guardar como PDF"**.

El botón **"🖨️ Auto Circ."** (arriba en el header) hace que, cuando entre un pedido **nuevo de Circunvalar**,
se abra la impresión automáticamente (junto con la alerta sonora). Viene **activado** por defecto y se recuerda por equipo.

---

## Modo automático sin diálogo (Chrome kiosk – recomendado para el PC de Circunvalar)

Con esto, cada pedido nuevo de Circunvalar **se imprime solo**, sin diálogo.

### 1. Impresora de tirilla como predeterminada
`--kiosk-printing` imprime siempre a la impresora **predeterminada** de Windows.
- *Configuración → Bluetooth y dispositivos → Impresoras y escáneres.*
- Abre tu impresora térmica → **"Establecer como predeterminada"**.
- Desactiva *"Permitir que Windows administre mi impresora predeterminada"* (si no, Windows la cambia sola).

### 2. Tamaño de papel (una sola vez)
En las propiedades de la impresora, fija el ancho del rollo (ej. **80mm** o **58mm**) y márgenes mínimos.
La comanda ya está diseñada angosta (~76mm).

### 3. Acceso directo de Chrome con modo kiosco de impresión
- Clic derecho en el escritorio → **Nuevo → Acceso directo**.
- Pega esto (ajusta la ruta de Chrome y **tu URL del panel con la key**):

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --new-window "https://TU-PANEL.onrender.com/dashboard?key=Crepes0209"
```

- Nómbralo, por ejemplo, **"Panel Crepes – Impresión"**.

### 4. Usarlo
- **Cierra todas las ventanas de Chrome** primero (el flag solo aplica si Chrome arranca desde este acceso directo).
- Abre el acceso directo → se abre el panel.
- Deja esa pestaña **siempre abierta**.
- Verifica que **"🖨️ Auto Circ."** esté activado.

Listo: cuando entre un pedido de Circunvalar, suena la alerta **y** la comanda **se imprime sola**.

### Arrancar solo al prender el equipo (opcional)
`Win+R` → `shell:startup` → copia ahí el acceso directo. Así Chrome arranca en modo impresión al encender el PC.

---

## Verificación / problemas comunes

- **Prueba:** con el acceso directo abierto, entra al detalle de un pedido de Circunvalar y toca "🖨️ Imprimir (local)".
  Debe salir **directo** por la impresora (sin diálogo).
- **Si aparece el diálogo:** Chrome no arrancó con el flag → cierra **todo** Chrome y reabre desde el acceso directo.
- **Si no imprime nada:** revisa que la impresora térmica sea la **predeterminada** y esté encendida/con papel.
- **No suspender el PC ni cerrar la pestaña**, o dejará de imprimir hasta reabrir.
- El modo kiosco es **por equipo**: no afecta a La Villa ni a tu celular. En esos equipos puedes apagar "🖨️ Auto Circ." con el botón del header.

---

## Notas técnicas (para el equipo de desarrollo)

- La impresión local se arma 100% en el frontend: `imprimirLocal()` + `buildComandaHTML()` en
  [`public/dashboard-crebot.html`](public/dashboard-crebot.html) (usa `window.print()` sobre un iframe oculto).
- La auto-impresión de Circunvalar se dispara en `detectarAlertas()` para los pedidos nuevos con `sucursal === "circunvalar"`,
  respetando el toggle `lc_autoprint` (localStorage).
- La Villa sigue con su impresora automática por servidor (`IMPRESORA_LA_VILLA_URL || print.tecmenu.com/imprimir`)
  vía el endpoint `POST /api/pedidos/:id/imprimir`.
- Si más adelante se quiere impresión automática por servidor también en Circunvalar (sin navegador),
  el camino es un agente/impresora local con una `IMPRESORA_CIRCUNVALAR_URL` y rutear la impresión por sucursal.
