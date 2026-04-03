import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.connect()
  .then(() => {
    console.log("✅ Conectado a PostgreSQL");
  })
  .catch((err) => {
    console.error("❌ Error conectando a PostgreSQL:", err);
  });
import { supabase } from "./supabase"; // o tu import real

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

export async function getCustomerByPhone(phone: string) {
  const normalizedPhone = normalizePhone(phone);

  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("phone", normalizedPhone)
    .maybeSingle();

  if (error) {
    console.error("ERROR getCustomerByPhone:", error);
    return null;
  }

  return data;
}

export async function upsertCustomer(customer: any) {
  const normalizedPhone = normalizePhone(customer.phone);

  const { error } = await supabase
    .from("customers")
    .upsert(
      {
        ...customer,
        phone: normalizedPhone
      },
      { onConflict: "phone" }
    );

  if (error) {
    console.error("ERROR upsertCustomer:", error);
  }
}

export async function getCustomerByPhone(phone: string) {
  try {
    const result = await pool.query(
      `SELECT * FROM clientes WHERE phone = $1 LIMIT 1`,
      [phone]
    );

    return result.rows[0] || null;
  } catch (error) {
    console.error("❌ Error buscando cliente:", error);
    return null;
  }
}

export async function upsertCustomer({
  phone,
  name,
  last_address,
  last_order,
  last_order_at
}: {
  phone: string;
  name?: string;
  last_address?: string;
  last_order?: any;
  last_order_at?: string;
}) {
  try {
    await pool.query(
      `
      INSERT INTO clientes (phone, name, last_address, last_order, last_order_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (phone)
      DO UPDATE SET
        name = EXCLUDED.name,
        last_address = EXCLUDED.last_address,
        last_order = EXCLUDED.last_order,
        last_order_at = EXCLUDED.last_order_at,
        updated_at = NOW()
      `,
      [
        phone,
        name || null,
        last_address || null,
        last_order ? JSON.stringify(last_order) : null,
        last_order_at || null
      ]
    );

    console.log("✅ Cliente guardado/actualizado:", phone);
  } catch (error) {
    console.error("❌ Error guardando cliente:", error);
  }
}
