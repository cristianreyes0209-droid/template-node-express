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
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id BIGSERIAL PRIMARY KEY,
        numero_orden INTEGER,
        phone TEXT NOT NULL,
        nombre TEXT,
        direccion TEXT,
        items JSONB,
        subtotal INTEGER,
        domicilio INTEGER,
        total INTEGER,
        forma_pago TEXT,
        sucursal TEXT,
        tipo_entrega TEXT,
        estado TEXT DEFAULT 'nuevo',
        canal TEXT,
        holaclick_order TEXT,
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(err => console.error("❌ Error creando tabla pedidos:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS items JSONB`)
      .catch(err => console.error("❌ Error agregando columna items:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo_entrega TEXT`)
      .catch(err => console.error("❌ Error agregando columna tipo_entrega:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS canal TEXT`)
      .catch(err => console.error("❌ Error agregando columna canal:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS holaclick_order TEXT`)
      .catch(err => console.error("❌ Error agregando columna holaclick_order:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`)
      .catch(err => console.error("❌ Error agregando columna confirmed_at:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS factura TEXT`)
      .catch(err => console.error("❌ Error agregando columna factura:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS email_factura TEXT`)
      .catch(err => console.error("❌ Error agregando columna email_factura:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS viene_de_carta BOOLEAN DEFAULT false`)
      .catch(err => console.error("❌ Error agregando columna viene_de_carta:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS observaciones_generales TEXT`)
      .catch(err => console.error("❌ Error agregando columna observaciones_generales:", err));
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS asesor_intervenido BOOLEAN DEFAULT false`)
      .catch(err => console.error("❌ Error agregando columna asesor_intervenido:", err));
    await client.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS descuento_acumulado INTEGER DEFAULT 0`)
      .catch(err => console.error("❌ Error agregando columna descuento_acumulado:", err));
    await client.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS descuento_recordatorio_at TIMESTAMPTZ`)
      .catch(err => console.error("❌ Error agregando columna descuento_recordatorio_at:", err));
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

export async function getConfig(key: string): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT value FROM config WHERE key = $1`, [key]);
    return r.rows[0]?.value ?? null;
  } catch (error) {
    console.error("❌ Error getConfig:", error);
    return null;
  }
}

export async function setConfig(key: string, value: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  } catch (error) {
    console.error("❌ Error setConfig:", error);
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

export async function saveMessage(phone: string, rol: "cliente" | "bot" | "asesor", mensaje: string) {
  console.log("💾 Intentando guardar:", phone, rol);
  try {
    await pool.query(
      `INSERT INTO conversaciones (phone, rol, mensaje) VALUES ($1, $2, $3)`,
      [normalizePhone(phone), rol, mensaje]
    );
    console.log("✅ Mensaje guardado correctamente");
  } catch (error) {
    console.error("❌ Error saveMessage:", JSON.stringify(error));
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

// Limpiar conversaciones antiguas de la BD cada hora (mantiene últimos 7 días)
setInterval(async () => {
  try {
    const result = await pool.query(
      `DELETE FROM conversaciones WHERE created_at < NOW() - INTERVAL '3 days'`
    );
    if ((result.rowCount ?? 0) > 0) {
      console.log(`🧹 BD: ${result.rowCount} mensajes antiguos eliminados`);
    }
  } catch (err) {
    console.error("❌ Error limpiando conversaciones antiguas:", err);
  }
}, 60 * 60 * 1000); // cada hora

export type PedidoData = {
  numero_orden?: number;
  phone: string;
  nombre?: string;
  direccion?: string;
  items?: any[];
  subtotal?: number;
  domicilio?: number;
  total?: number;
  forma_pago?: string;
  sucursal?: string;
  tipo_entrega?: string;
  canal?: string;
  holaclick_order?: string;
  confirmed_at?: string;
  estado?: string;
  factura?: string;
  email_factura?: string;
  viene_de_carta?: boolean;
  observaciones_generales?: string;
  asesor_intervenido?: boolean;
};

export async function savePedido(data: PedidoData): Promise<number | null> {
  try {
    const result = await pool.query(
      `INSERT INTO pedidos
        (numero_orden, phone, nombre, direccion, items, subtotal, domicilio, total,
         forma_pago, sucursal, tipo_entrega, canal, holaclick_order, confirmed_at, estado,
         factura, email_factura, viene_de_carta, observaciones_generales, asesor_intervenido)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        data.numero_orden || null,
        normalizePhone(data.phone),
        data.nombre || null,
        data.direccion || null,
        data.items ? JSON.stringify(data.items) : null,
        data.subtotal ?? null,
        data.domicilio ?? null,
        data.total ?? null,
        data.forma_pago || null,
        data.sucursal || null,
        data.tipo_entrega || null,
        data.canal || null,
        data.holaclick_order || null,
        data.confirmed_at || null,
        data.estado || 'recibido',
        data.factura || null,
        data.email_factura || null,
        data.viene_de_carta ?? false,
        data.observaciones_generales || null,
        data.asesor_intervenido ?? false,
      ]
    );
    console.log("✅ Pedido guardado id:", result.rows[0]?.id);
    return result.rows[0]?.id ?? null;
  } catch (error) {
    console.error("❌ Error savePedido:", error);
    return null;
  }
}

export async function updatePedidoEstado(id: number, estado: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE pedidos SET estado = $1, updated_at = NOW() WHERE id = $2`,
      [estado, id]
    );
  } catch (error) {
    console.error("❌ Error updatePedidoEstado:", error);
  }
}

// Editar un pedido (ítems, montos, entrega, pago, dirección, observación). Devuelve true si OK.
export async function updatePedido(id: number, f: {
  items?: any[]; subtotal?: number; domicilio?: number; total?: number;
  direccion?: string; forma_pago?: string; tipo_entrega?: string; sucursal?: string;
  observaciones_generales?: string;
}): Promise<boolean> {
  try {
    await pool.query(
      `UPDATE pedidos SET
         items = COALESCE($2::jsonb, items),
         subtotal = COALESCE($3, subtotal),
         domicilio = COALESCE($4, domicilio),
         total = COALESCE($5, total),
         direccion = COALESCE($6, direccion),
         forma_pago = COALESCE($7, forma_pago),
         tipo_entrega = COALESCE($8, tipo_entrega),
         sucursal = COALESCE($9, sucursal),
         observaciones_generales = COALESCE($10, observaciones_generales),
         updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        f.items ? JSON.stringify(f.items) : null,
        f.subtotal ?? null, f.domicilio ?? null, f.total ?? null,
        f.direccion ?? null, f.forma_pago ?? null, f.tipo_entrega ?? null,
        f.sucursal ?? null, f.observaciones_generales ?? null,
      ]
    );
    return true;
  } catch (error) {
    console.error("❌ Error updatePedido:", error);
    return false;
  }
}

// ── Programa de descuento acumulable ────────────────────────────────────────
export async function getDescuento(phone: string): Promise<number> {
  try {
    const r = await pool.query(`SELECT descuento_acumulado FROM clientes WHERE phone = $1 LIMIT 1`, [normalizePhone(phone)]);
    return r.rows[0]?.descuento_acumulado ?? 0;
  } catch (error) {
    console.error("❌ Error getDescuento:", error);
    return 0;
  }
}

export async function incrementarDescuento(phone: string): Promise<number> {
  try {
    const r = await pool.query(
      `INSERT INTO clientes (phone, descuento_acumulado) VALUES ($1, 1)
       ON CONFLICT (phone) DO UPDATE SET descuento_acumulado = LEAST(clientes.descuento_acumulado + 1, 30), updated_at = NOW()
       RETURNING descuento_acumulado`,
      [normalizePhone(phone)]
    );
    return r.rows[0]?.descuento_acumulado ?? 1;
  } catch (error) {
    console.error("❌ Error incrementarDescuento:", error);
    return 0;
  }
}

export async function resetDescuento(phone: string): Promise<void> {
  try {
    await pool.query(`UPDATE clientes SET descuento_acumulado = 0, updated_at = NOW() WHERE phone = $1`, [normalizePhone(phone)]);
  } catch (error) {
    console.error("❌ Error resetDescuento:", error);
  }
}

export async function getClientesParaRecordarDescuento() {
  try {
    const r = await pool.query(
      `SELECT phone, name, descuento_acumulado FROM clientes
       WHERE descuento_acumulado > 0
         AND (descuento_recordatorio_at IS NULL OR descuento_recordatorio_at < NOW() - INTERVAL '15 days')`
    );
    return r.rows;
  } catch (error) {
    console.error("❌ Error getClientesParaRecordarDescuento:", error);
    return [];
  }
}

export async function marcarRecordatorioDescuento(phone: string): Promise<void> {
  try {
    await pool.query(`UPDATE clientes SET descuento_recordatorio_at = NOW() WHERE phone = $1`, [normalizePhone(phone)]);
  } catch (error) {
    console.error("❌ Error marcarRecordatorioDescuento:", error);
  }
}

export async function getPedidosActivos() {
  try {
    const result = await pool.query(
      `SELECT * FROM pedidos WHERE estado NOT IN ('finalizado') ORDER BY created_at DESC`
    );
    return result.rows;
  } catch (error) {
    console.error("❌ Error getPedidosActivos:", error);
    return [];
  }
}

export async function getPedidoById(id: number) {
  try {
    const result = await pool.query(`SELECT * FROM pedidos WHERE id = $1 LIMIT 1`, [id]);
    return result.rows[0] || null;
  } catch (error) {
    console.error("❌ Error getPedidoById:", error);
    return null;
  }
}

// Último pedido del cliente (cualquier estado) en las últimas 12h.
export async function getUltimoPedidoByPhone(phone: string) {
  try {
    const result = await pool.query(
      `SELECT * FROM pedidos WHERE phone = $1 AND created_at >= NOW() - INTERVAL '12 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("❌ Error getUltimoPedidoByPhone:", error);
    return null;
  }
}

// Último pedido del cliente que TODAVÍA se puede cancelar (aún no despachado/entregado).
export async function getPedidoCancelableByPhone(phone: string) {
  try {
    const result = await pool.query(
      `SELECT * FROM pedidos
       WHERE phone = $1
         AND estado NOT IN ('en_camino', 'entregado', 'finalizado', 'cancelado')
         AND created_at >= NOW() - INTERVAL '12 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("❌ Error getPedidoCancelableByPhone:", error);
    return null;
  }
}

export async function getPedidosArchivados() {
  try {
    const result = await pool.query(
      `SELECT * FROM pedidos WHERE estado = 'finalizado' ORDER BY updated_at DESC LIMIT 100`
    );
    return result.rows;
  } catch (error) {
    console.error("❌ Error getPedidosArchivados:", error);
    return [];
  }
}

export async function getNextOrderNumberForDay(): Promise<number> {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int + 1 AS num FROM pedidos WHERE created_at::date = CURRENT_DATE`
    );
    return result.rows[0]?.num ?? 1;
  } catch (error) {
    console.error("❌ Error getNextOrderNumberForDay:", error);
    return 1;
  }
}

export async function getPedidosUltimas24h() {
  try {
    const result = await pool.query(
      `SELECT * FROM pedidos WHERE created_at >= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC`
    );
    return result.rows;
  } catch (error) {
    console.error("❌ Error getPedidosUltimas24h:", error);
    return [];
  }
}

export async function getPedidosPorFecha(fecha: string) {  // fecha = "YYYY-MM-DD" (Bogotá)
  try {
    const result = await pool.query(
      `SELECT * FROM pedidos
       WHERE created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Bogota'
         AND created_at <  (($1::date) + INTERVAL '1 day')::timestamp AT TIME ZONE 'America/Bogota'
       ORDER BY created_at DESC`,
      [fecha]
    );
    return result.rows;
  } catch (error) {
    console.error("❌ Error getPedidosPorFecha:", error);
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
