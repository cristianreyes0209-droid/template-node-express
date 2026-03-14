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
