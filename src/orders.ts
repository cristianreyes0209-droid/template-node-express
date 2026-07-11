
export const DOMICILIO = 4500;

export type OrderExtra = {
  nombre: string;
  precio: number;
  cantidad: number;
};

export type OrderItem = {
  producto: string;
  variante?: string;
  cantidad: number;
  precio: number;
  observaciones?: string;
  extras?: OrderExtra[];
};

export type OrderStep =
  | "esperando_menu_principal"
  | "esperando_tipo_entrega_repetido"
  | "esperando_menu_nuevo"
  | "esperando_ayuda"
  | "esperando_sucursal"
  | "armando_pedido"
  | "post_agregar_producto"
  | "esperando_nombre"
  | "esperando_observacion_general"
  | "esperando_tipo_entrega"
  | "esperando_direccion"
  | "esperando_confirmacion_direccion"
  | "esperando_confirmacion"
  | "retirando_productos"
  | "esperando_pago"
  | "esperando_comprobante"
  | "esperando_aclaracion_producto"
  | "esperando_variante_producto"
  | "esperando_asesor"
  | "esperando_mensaje_fuera_horario"
  | "esperando_sucursal_holaclick"
  | "esperando_pago_holaclick"
  | "esperando_comprobante_holaclick"
  | "esperando_factura"
  | "esperando_datos_factura"
  | "esperando_email_factura"
  | "esperando_jalapenos"
  | "esperando_queso_dulce"
  | "esperando_sabor_cocacola"
  | "esperando_complemento_direccion"
  | "confirmado";

export type CustomerOrder = {
  telefono: string;
  nombre?: string;
  tipoEntrega?: string;
  direccion?: string;
  formaPago?: string;
  canal?: string;
  sucursal?: string;
  valorDomicilio?: number;
  items: OrderItem[];
  step: OrderStep;
  lastInteraction: number;
  observacionesGenerales?: string;
  observacionDireccion?: string;
  holaclick_order?: string;
  confirmedAt?: string;
  factura?: string;
  emailFactura?: string;
  testMode?: boolean;
  numeroOrden?: number;
  locationCoords?: { latitude: number; longitude: number };
  distanciaKm?: number;
  domicilioTexto?: string;
  pendingProduct?: { id: string; nombre: string; precio: number };
  pendingProductQuery?: { id: string; nombre: string; precio: number };
  itemsPendientes?: { productoId: string; cantidad: number }[];
  inactivityPending?: boolean;
  vieneDeCarta?: boolean;
  gpsDistanciaKm?: number;
  gpsSnapshot?: {
    direccion: string;
    coords: { latitude: number; longitude: number };
    valorDomicilio: number;
    domicilioTexto: string;
    distanciaKm: number;
  };
  cartFreeTextAttempts?: number;
  armandoFallbacks?: number;
  asesorIntervenido?: boolean;
  upsellingFrutasMostrado?: boolean;
  upsellingTocinetaMostrado?: boolean;
  upsellingToppingsMostrado?: boolean;
  aclaracionPendiente?: {
    opciones: {
      nombre: string;
      productoId: string;
    }[];
    cantidad?: number;
  };
};

const orders: Record<string, CustomerOrder> = {};

// Limpiar sesiones inactivas cada hora
setInterval(() => {
  const ahora = Date.now();
  const LIMITE_24H = 24 * 60 * 60 * 1000;
  const LIMITE_2H  =  2 * 60 * 60 * 1000;
  for (const phone of Object.keys(orders)) {
    const order = orders[phone];
    const inactividad = ahora - (order.lastInteraction || 0);
    if (order.step === "confirmado" && inactividad < LIMITE_2H) continue;
    if (inactividad > LIMITE_24H) {
      delete orders[phone];
      console.log(`🧹 Sesión limpiada: ${phone}`);
    }
  }
}, 60 * 60 * 1000);

export function calculateTotal(order: CustomerOrder, valorDomicilioOverride?: number) {
  let subtotal = 0;

  for (const item of order.items) {
    let itemTotal = item.precio || 0;

    if (item.extras && item.extras.length > 0) {
      for (const extra of item.extras) {
        itemTotal += extra.precio;
      }
    }

    subtotal += itemTotal * item.cantidad;
  }

  const domicilioBase = order.tipoEntrega === "domicilio"
    ? (valorDomicilioOverride ?? order.valorDomicilio ?? DOMICILIO)
    : 0;

  // Domicilio gratis cuando subtotal >= $100.000
  const domicilio = (subtotal >= 100000 && domicilioBase > 0) ? 0 : domicilioBase;

  const total = subtotal + domicilio;

  return { subtotal, domicilio, total };
}

export function setPendingClarification(
  phone: string,
  opciones: { nombre: string; productoId: string }[],
  cantidad?: number
) {
  if (orders[phone]) {
    orders[phone].aclaracionPendiente = { opciones, cantidad };
  }
}

export function getPendingClarification(phone: string) {
  return orders[phone]?.aclaracionPendiente?.opciones;
}

export function clearPendingClarification(phone: string) {
  if (orders[phone]) {
    delete orders[phone].aclaracionPendiente;
  }
}

export function getOrder(phone: string): CustomerOrder | undefined {
  return orders[phone];
}

export function getAllOrders(): (CustomerOrder & { phone: string })[] {
  return Object.entries(orders).map(([phone, o]) => ({ phone, ...o }));
}

export function createOrUpdateOrder(phone: string, items: OrderItem[]) {
  if (!orders[phone]) {
    orders[phone] = {
      telefono: phone,
      items: [],
      step: "esperando_menu_principal",
      lastInteraction: Date.now()
    };
  }

  for (const item of items) {
    const existing = orders[phone].items.find(
      (i) =>
        i.producto === item.producto &&
        (i.variante || "") === (item.variante || "") &&
        (i.observaciones || "") === (item.observaciones || "") &&
        JSON.stringify(i.extras || []) === JSON.stringify(item.extras || [])
    );

    if (existing) {
      existing.cantidad += item.cantidad;
    } else {
      orders[phone].items.push(item);
    }
  }

  return orders[phone];
}

export function updateOrderStep(phone: string, step: OrderStep) {
  if (orders[phone]) {
    orders[phone].step = step;
  }
}

export function updateOrderAddress(phone: string, direccion: string) {
  const order = getOrder(phone);
  if (!order) return;

  order.direccion = direccion;
}

export function updateOrderName(phone: string, nombre: string) {
  if (orders[phone]) {
    orders[phone].nombre = nombre;
  }
}

export function updateOrderDeliveryType(phone: string, tipoEntrega: string) {
  if (orders[phone]) {
    orders[phone].tipoEntrega = tipoEntrega;
  }
}

export function updateOrderPayment(phone: string, formaPago: string) {
  if (orders[phone]) {
    orders[phone].formaPago = formaPago;
  }
}

export function buildOrderJSON(order: CustomerOrder) {
  const now = new Date();
  const horaRecepcion = now.toISOString();

  const minutosEstimados = order.tipoEntrega === "domicilio" ? 50 : 15;

  const estimated = new Date(now.getTime() + minutosEstimados * 60000);
  const totals = calculateTotal(order);

  return {
    cliente: {
      nombre: order.nombre,
      telefono: order.telefono
    },
    pedido: {
      items: order.items,
      tipoEntrega: order.tipoEntrega,
      direccion: order.direccion,
      formaPago: order.formaPago,
      subtotal: totals.subtotal,
      domicilio: totals.domicilio,
      total: totals.total
    },
    tiempos: {
      horaRecepcion,
      horaEstimadaEntrega: estimated.toISOString()
    }
  };
}

export function clearOrder(phone: string) {
  delete orders[phone];
}
export function updateOrderGeneralNotes(phone: string, notes: string) {
  const order = orders[phone];
  if (!order) return;

  order.observacionesGenerales = notes;
}

export function updateOrderDireccionNotes(phone: string, notes: string) {
  const order = orders[phone];
  if (!order) return;

  order.observacionDireccion = notes;
}
