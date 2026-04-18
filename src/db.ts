import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.connect()
  .then(async (client) => {
    console.log("✅ Conectado a PostgreSQL");
    await client.query(`
      ALTER TABLE clientes ADD COLUMN IF NOT EXISTS test_mode boolean DEFAULT false
    `).catch(err => console.error("❌ Error agregando columna test_mode:", err));
    await client.query(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(err => console.error("❌ Error creando tabla config:", err));
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversaciones (
        id BIGSERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        rol TEXT NOT NULL,
        mensaje TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(err => console.error("❌ Error creando tabla conversaciones:", err));
    client.release();
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

export async function getNextOrderNumber(): Promise<number> {
  try {
    const result = await pool.query(`
      INSERT INTO config (key, value)
      VALUES ('ultimo_pedido', '1')
      ON CONFLICT (key) DO UPDATE
        SET value = (config.value::int + 1)::text,
            updated_at = NOW()
      RETURNING value::int AS num
    `);
    return result.rows[0]?.num ?? 1;
  } catch (error) {
    console.error("❌ Error obteniendo número de pedido:", error);
    return 0;
  }
}

export async function setTestMode(phone: string, value: boolean) {
  try {
    const normalizedPhone = normalizePhone(phone);
    await pool.query(
      `INSERT INTO clientes (phone, test_mode)
       VALUES ($1, $2)
       ON CONFLICT (phone)
       DO UPDATE SET test_mode = EXCLUDED.test_mode, updated_at = NOW()`,
      [normalizedPhone, value]
    );
    console.log(`✅ test_mode=${value} guardado para ${normalizedPhone}`);
  } catch (error) {
    console.error("❌ Error guardando test_mode:", error);
  }
}

export async function saveMessage(phone: string, rol: "cliente" | "bot", mensaje: string) {
  try {
    await pool.query(
      `INSERT INTO conversaciones (phone, rol, mensaje) VALUES ($1, $2, $3)`,
      [normalizePhone(phone), rol, mensaje]
    );
  } catch (error) {
    console.error("❌ Error guardando mensaje en conversaciones:", error);
  }
}

export async function getConversaciones() {
  try {
    const result = await pool.query(`
      SELECT phone,
        COUNT(*) AS total_mensajes,
        MAX(created_at) AS ultimo_mensaje
      FROM conversaciones
      GROUP BY phone
      ORDER BY ultimo_mensaje DESC
    `);
    return result.rows;
  } catch (error) {
    console.error("❌ Error obteniendo conversaciones:", error);
    return [];
  }
}

export async function getConversacion(phone: string) {
  try {
    const normalizedPhone = normalizePhone(phone);
    const result = await pool.query(
      `SELECT id, phone, rol, mensaje, created_at
       FROM conversaciones
       WHERE phone = $1
       ORDER BY created_at ASC`,
      [normalizedPhone]
    );
    return result.rows;
  } catch (error) {
    console.error("❌ Error obteniendo conversación:", error);
    return [];
  }
}

export async function upsertCustomer({
  phone,
  name,
  last_address,
  last_order,
  last_order_at,
  last_sucursal
}: {
  phone: string;
  name?: string;
  last_address?: string;
  last_order?: any;
  last_order_at?: string;
  last_sucursal?: string;
}) {
  try {
    const normalizedPhone = normalizePhone(phone);

   await pool.query(
      `
      INSERT INTO clientes (phone, name, last_address, last_order, last_order_at, last_sucursal)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      ON CONFLICT (phone)
      DO UPDATE SET
        name = EXCLUDED.name,
        last_address = EXCLUDED.last_address,
        last_order = EXCLUDED.last_order,
        last_order_at = EXCLUDED.last_order_at,
        last_sucursal = EXCLUDED.last_sucursal,
        updated_at = NOW()
      `,
      [
        normalizedPhone,
        name || null,
        last_address || null,
        last_order ? JSON.stringify(last_order) : null,
        last_order_at || null,
        last_sucursal || null
      ]
    );

    console.log("✅ Cliente guardado/actualizado:", normalizedPhone);
  } catch (error) {
    console.error("❌ Error guardando cliente:", error);
  }
}
