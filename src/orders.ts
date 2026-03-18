

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
};

type OrderStep =
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
  items: OrderItem[];
  step: OrderStep;
};

const orders: Record<string, CustomerOrder> = {};

export function getOrder(phone: string): CustomerOrder | undefined {
  return orders[phone];
}

export function createOrUpdateOrder(phone: string, items: OrderItem[]) {
  if (!orders[phone]) {
    orders[phone] = {
      telefono: phone,
      items: [],
      step: "armando_pedido"
    };
  }

  orders[phone].items = [...orders[phone].items, ...items];
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

export function clearOrder(phone: string) {
  delete orders[phone];
}
