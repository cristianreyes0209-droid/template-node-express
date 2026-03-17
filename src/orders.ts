export const PRICES: Record<string, number> = {
  Mexicana: 12000,
  Paris: 13000,
  Hawaiana: 12500,
  "Desgranada mixta": 14000,
  Nutella: 10000,
  Tropinutella: 11000,
  Tropical: 10500
};

export const DOMICILIO = 3000;
export function calculateTotal(order: CustomerOrder) {
  let subtotal = 0;

  for (const item of order.items) {
    const price = PRICES[item.producto] || 0;
    subtotal += price * item.cantidad;
  }

  const domicilio = order.tipoEntrega === "domicilio" ? DOMICILIO : 0;
  const total = subtotal + domicilio;

  return { subtotal, domicilio, total };
}
type OrderItem = {
  producto: string;
  cantidad: number;
};

type OrderStep =
  | "armando_pedido"
  | "esperando_nombre"
  | "esperando_tipo_entrega"
  | "esperando_direccion"
  | "esperando_pago"
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

export function updateOrderAddress(phone: string, direccion: string) {
  if (orders[phone]) {
    orders[phone].direccion = direccion;
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
