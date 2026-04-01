
export const DOMICILIO = 5000;

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
  | "esperando_menu_nuevo"
  | "esperando_sucursal"
  | "armando_pedido"
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
  | "confirmado";

export type CustomerOrder = {
  telefono: string;
  nombre?: string;
  tipoEntrega?: string;
  direccion?: string;
  formaPago?: string;
  canal?: string;
  sucursal?: string;
  items: OrderItem[];
  step: OrderStep;
  lastInteraction: number;
  observacionesGenerales?: string;
  aclaracionPendiente?: {
    opciones: {
      nombre: string;
      productoId: string;
    }[];
  };
};

const orders: Record<string, CustomerOrder> = {};

export function calculateTotal(order: CustomerOrder) {
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

  const domicilio = order.tipoEntrega === "domicilio" ? DOMICILIO : 0;
  const total = subtotal + domicilio;

  return { subtotal, domicilio, total };
}

export function setPendingClarification(
  phone: string,
  opciones: { nombre: string; productoId: string }[]
) {
  if (orders[phone]) {
    orders[phone].aclaracionPendiente = { opciones };
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
