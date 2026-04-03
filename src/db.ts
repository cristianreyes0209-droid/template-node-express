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

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

export async function getCustomerByPhone(phone: string) {
  try {
    const normalizedPhone = normalizePhone(phone);

    const result = await pool.query(
      `SELECT * FROM clientes WHERE phone = $1 LIMIT 1`,
      [normalizedPhone]
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
    const normalizedPhone = normalizePhone(phone);

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
        normalizedPhone,
        name || null,
        last_address || null,
        last_order ? JSON.stringify(last_order) : null,
        last_order_at || null
      ]
    );

    console.log("✅ Cliente guardado/actualizado:", normalizedPhone);
  } catch (error) {
    console.error("❌ Error guardando cliente:", error);
  }
}
