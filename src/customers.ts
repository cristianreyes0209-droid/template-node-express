import { pool } from "./db";

export async function getCustomerByPhone(phone: string) {
  const result = await pool.query(
    "select * from clientes where phone = $1 limit 1",
    [phone]
  );

  return result.rows[0] || null;
}

export async function upsertCustomer(data: {
  phone: string;
  name?: string;
  last_address?: string;
  last_order?: any;
  last_order_at?: string;
}) {
  const result = await pool.query(
    `
    insert into clientes (phone, name, last_address, last_order, last_order_at, updated_at)
    values ($1, $2, $3, $4, $5, now())
    on conflict (phone)
    do update set
      name = coalesce(excluded.name, clientes.name),
      last_address = coalesce(excluded.last_address, clientes.last_address),
      last_order = coalesce(excluded.last_order, clientes.last_order),
      last_order_at = coalesce(excluded.last_order_at, clientes.last_order_at),
      updated_at = now()
    returning *
    `,
    [
      data.phone,
      data.name || null,
      data.last_address || null,
      data.last_order ? JSON.stringify(data.last_order) : null,
      data.last_order_at || null
    ]
  );

  return result.rows[0];
}
