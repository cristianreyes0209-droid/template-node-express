

export const DOMICILIO = 5000;
export function calculateTotal(order: CustomerOrder) {
  let subtotal = 0;

  for (const item of order.items) {
    const price = item.precio || 0;
    subtotal += price * item.cantidad;
  }

const domicilio = order.tipoEntrega === "domicilio" ? 5000 : 0;
  const total = subtotal + domicilio;

  return { subtotal, domicilio, total };
}
type OrderItem = {
  producto: string;
  cantidad: number;
  precio: number;
  observaciones?: string;
};
type OrderStep =
  | "esperando_menu_principal"
  | "esperando_sucursal"
  | "armando_pedido"
  | "esperando_nombre"
  | "esperando_tipo_entrega"
  | "esperando_direccion"
  | "esperando_confirmacion"
  | "esperando_pago"
  | "esperando_comprobante"
  | "confirmado";

type CustomerOrder = {
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
};
const orders: Record<string, CustomerOrder> = {};
export type OrderItem = {
  producto: string;
  cantidad: number;
  observaciones?: string;
};

export type OrderStep =
  | "esperando_menu_principal"
  | "esperando_sucursal"
  | "armando_pedido"
  | "esperando_nombre"
  | "esperando_tipo_entrega"
  | "esperando_direccion"
  | "esperando_confirmacion"
  | "esperando_pago"
  | "esperando_comprobante"
  | "confirmado";

export type Order = {
  telefono: string;
  items: OrderItem[];
  step: OrderStep;
  lastInteraction: number;

  nombre?: string;
  tipoEntrega?: string;
  direccion?: string;
  formaPago?: string;
  canal?: string;
  sucursal?: string;
};

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
      (i) => i.producto === item.producto
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
  if (!orders[phone]) return;

  orders[phone].formaPago = formaPago;
}
export function buildOrderJSON(order: CustomerOrder) {
  const now = new Date();
  const horaRecepcion = now.toISOString();

  const estimated = new Date(now.getTime() + 40 * 60000);
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
