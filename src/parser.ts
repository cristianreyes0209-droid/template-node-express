import { menu } from "./menu";

type ParsedExtra = {
  id: string;
  nombre: string;
  precio: number;
  cantidad: number;
};

type ParsedItem = {
  productoId: string;
  producto: string;
  cantidad: number;
  precio: number;
  variante?: string;
  observaciones?: string;
  extras?: ParsedExtra[];
};

type ParseResult = {
  items: ParsedItem[];
  ambiguousChoice?: {
    opciones: {
      nombre: string;
      productoId: string;
    }[];
  };
};

const numbers: Record<string, number> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "un": 1,
  "una": 1,
  "uno": 1,
  "dos": 2,
  "tres": 3,
  "cuatro": 4,
  "cinco": 5
};
const STOP_WORDS: Set<string> = new Set([
  "un",
  "una",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "y",
  "con",
  "sin",
  "para",
  "por",
  "favor"
]);

function getMeaningfulTokens(text: string) {
  return normalizeText(text)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !STOP_WORDS.has(t));
}

function productMatchesGenericToken(product: any, token: string) {
  const searchable = [
    product.nombre,
    ...(product.aliases || [])
  ]
    .map((s) => normalizeText(s))
    .join(" ");

  const regex = new RegExp(`\\b${escapeRegex(token)}\\b`, "i");
  return regex.test(searchable);
}

function detectAmbiguousProduct(fragment: string, products: any[]) {
  const genericAmbiguity = detectGenericAmbiguity(fragment, products);

  if (genericAmbiguity) {
    return genericAmbiguity;
  }

  const bestMatches = findBestProductMatches(fragment, products);

  if (bestMatches.length <= 1) {
    return null;
  }

  return {
    opciones: bestMatches.map((p: any) => ({
      nombre: p.nombre,
      productoId: p.id
    }))
  };
}
function extractCantidad(fragment: string): number {
  const text = normalizeText(fragment);

  for (const key of Object.keys(numbers)) {
    const cleanKey = escapeRegex(key);
    const regex = new RegExp(`\\b${cleanKey}\\b`, "i");

    if (regex.test(text)) {
      return numbers[key];
    }
  }

  return 1;
}

export function normalizeText(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bcamaron\b/g, "camarones")
    .replace(/\bcamarone\b/g, "camarones")
    .replace(/\bcamorones\b/g, "camarones")
    .replace(/\bmediteranea\b/g, "mediterranea")
    .replace(/\bmedterranea\b/g, "mediterranea")
    .replace(/\bstroganof\b/g, "strogonoff")
    .replace(/\bstrogonof\b/g, "strogonoff")
    .replace(/\bpari\b/g, "paris")
    .replace(/\bpaqris\b/g, "paris")
    .replace(/\buna de camarones\b/g, "camarones")
    .replace(/\bde camarones\b/g, "camarones");
}

function splitIntoFragments(text: string) {
  // Primero separamos por coma
  const commaParts = text
    .split(/,/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const result: string[] = [];

  for (const part of commaParts) {
    // Si tiene "sin X y sin Y" no partir por "y"
    if (/sin\s+\w+.*\s+y\s+sin\s+\w+/i.test(part)) {
      result.push(...splitByInlineNumbers(part));
      continue;
    }

    // Partir por "y", "e", "más", "además", "también", "súmale", "agrégale"
    // PERO solo si lo que sigue NO es una observación ("sin ...", "poco ...", "bien ...")
    const separatorRegex = /\s+(?:y|e|mas|tambien|ademas|sumale|agregale)\s+/gi;
    const segments: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = separatorRegex.exec(part)) !== null) {
      const after = part.slice(match.index + match[0].length);
      // Si lo que viene después del separador empieza con una observación, no separar
      if (/^(sin|poco|bien|extra)\s+/i.test(after)) {
        continue;
      }
      segments.push(part.slice(lastIndex, match.index).trim());
      lastIndex = match.index + match[0].length;
    }
    segments.push(part.slice(lastIndex).trim());

    for (const seg of segments.filter(Boolean)) {
      result.push(...splitByInlineNumbers(seg));
    }
  }

  return result;
}

// 🆕 NUEVA FUNCIÓN: detecta "1 paris 2 hawaiana" y lo parte en ["1 paris", "2 hawaiana"]
function splitByInlineNumbers(text: string): string[] {
  // Busca patrones como: número/palabra + nombre de producto repetidos
  // Ejemplo: "1 paris 1 hawaiana" → ["1 paris", "1 hawaiana"]
  const parts = text
    .split(/(?=\b(?:\d+|dos|tres|cuatro|cinco|un|una|uno)\s+\w)/i)
    .map((p) => p.trim())
    .filter(Boolean);

  // Si solo hay 1 parte, no había nada que separar
  if (parts.length <= 1) {
    return [text];
  }

  // Verificar que cada parte tenga sentido (que no sea solo "1")
  const partsValidas = parts.filter((p) => p.split(/\s+/).length >= 2);

  if (partsValidas.length <= 1) {
    return [text];
  }

  return partsValidas;

}

function extractQuantity(fragment: string): { quantity: number; text: string } {
  const wordNums: Record<string, number> = {
    "un": 1, "una": 1, "uno": 1,
    "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5
  };

  // Try digit first
  const numMatch = fragment.match(/^(\d+)\s+(.+)$/i);
  if (numMatch) {
    return { quantity: Number(numMatch[1]) || 1, text: numMatch[2].trim() };
  }

  // Try word numbers at the start
  for (const [word, num] of Object.entries(wordNums)) {
    const regex = new RegExp(`^${escapeRegex(word)}\\s+(.+)$`, "i");
    const match = fragment.match(regex);
    if (match) {
      return { quantity: num, text: match[1].trim() };
    }
  }

  return { quantity: 1, text: fragment.trim() };
}
function similarity(a: string, b: string) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  const longerLength = longer.length;
  if (longerLength === 0) return 1;

  return (longerLength - editDistance(longer, shorter)) / longerLength;
}

function editDistance(a: string, b: string) {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractObservaciones(fragment: string): string | undefined {
  const text = fragment.toLowerCase();
  const observaciones: string[] = [];

  const sinRegex = /\bsin\s+(\w+(?:\s+\w+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = sinRegex.exec(text)) !== null) {
    observaciones.push(`sin ${m[1]}`);
  }

  const pocoMatch = text.match(/\bpoco\s+(\w+)/);
  if (pocoMatch) observaciones.push(`poco ${pocoMatch[1]}`);

  const bienMatch = text.match(/\bbien\s+(\w+)/);
  if (bienMatch) observaciones.push(`bien ${bienMatch[1]}`);

  return observaciones.length > 0 ? observaciones.join(", ") : undefined;
}

function buildAliasEntries(products: any[]) {
  return products
    .flatMap((product) =>
      (product.aliases || []).map((alias: string) => ({
        product,
        alias: normalizeText(alias)
      }))
    )
    .sort((a, b) => b.alias.length - a.alias.length);
}
function findBestProductMatches(fragment: string, products: any[]) {
  const text = normalizeText(fragment);
  const aliasEntries = buildAliasEntries(products);

  const matches: { product: any; alias: string }[] = [];

for (const entry of aliasEntries) {
  const cleanAlias = escapeRegex(entry.alias);
  const aliasRegex = new RegExp(`\\b${cleanAlias}\\b`, "i");

  if (
    aliasRegex.test(text) ||
    text.includes(entry.alias) ||
    entry.alias.includes(text) ||
    similarity(text, entry.alias) > 0.78
  ) {
    matches.push({
      product: entry.product,
      alias: entry.alias
    });
  }
}

  if (matches.length === 0) {
    return [];
  }

  const maxAliasLength = Math.max(...matches.map((m) => m.alias.length));

  const strongestMatches = matches.filter(
    (m) => m.alias.length === maxAliasLength
  );

  const uniqueProducts = strongestMatches.filter(
    (match, index, arr) =>
      arr.findIndex((m) => m.product.id === match.product.id) === index
  );

  return uniqueProducts.map((m) => m.product);
}
function detectGenericAmbiguity(fragment: string, products: any[]) {
  const tokens = getMeaningfulTokens(fragment);

  // SOLO palabras sueltas → comportamiento genérico
  if (tokens.length !== 1) {
    return null;
  }

  const token = tokens[0];

  const matches = products.filter((product: any) =>
    productMatchesGenericToken(product, token)
  );

  const uniqueMatches = matches.filter(
    (product: any, index: number, arr: any[]) =>
      arr.findIndex((p) => p.id === product.id) === index
  );

  if (uniqueMatches.length <= 1) {
    return null;
  }

  return {
    opciones: uniqueMatches.map((p: any) => ({
      nombre: p.nombre,
      productoId: p.id
    }))
  };
}
function findProductInFragment(fragment: string, products: any[]) {
  const bestMatches = findBestProductMatches(fragment, products);

  if (bestMatches.length === 1) {
    return bestMatches[0];
  }

  return null;
}

function findVariantInFragment(fragment: string, product: any) {
  if (!product.variantes || product.variantes.length === 0) {
    return null;
  }

  const text = normalizeText(fragment);
  const variantMatches: { variante: any; alias: string }[] = [];

  for (const variante of product.variantes) {
    for (const alias of variante.aliases || []) {
      const normalizedAlias = normalizeText(alias);
      const regex = new RegExp(`\\b${escapeRegex(normalizedAlias)}\\b`, "i");

      if (regex.test(text)) {
        variantMatches.push({
          variante,
          alias: normalizedAlias
        });
      }
    }
  }

  if (variantMatches.length === 0) {
    return null;
  }

  const maxAliasLength = Math.max(...variantMatches.map((m) => m.alias.length));
  const strongest = variantMatches.filter(
    (m) => m.alias.length === maxAliasLength
  );

  return strongest[0].variante;
}

function extractExtrasFromFragment(fragment: string, extrasProducts: any[], product?: any) {
  const text = normalizeText(fragment);
  const extrasFound: ParsedExtra[] = [];

  for (const extra of extrasProducts) {
    // Si el producto tiene extrasDisponibles definidos, respetar esa lista
    if (
      product?.extrasDisponibles &&
      product.extrasDisponibles.length > 0 &&
      !product.extrasDisponibles.includes(extra.id)
    ) {
      continue;
    }

    for (const alias of extra.aliases || []) {
      const normalizedAlias = normalizeText(alias);
      const regex = new RegExp(`\\b${escapeRegex(normalizedAlias)}\\b`, "i");

      const triggers = [
        `extra ${normalizedAlias}`,
        `con extra ${normalizedAlias}`,
        `mas ${normalizedAlias}`,
        `adicional ${normalizedAlias}`,
        `con ${normalizedAlias}`,
        `agregar ${normalizedAlias}`,
      ];
      // Detectar también "con X y Z" o "con X, Z" donde el alias aparece
      // después de "con" en cualquier posición dentro de la lista
      const conListRegex = /\bcon\s+(.+)/i;
      const conListMatch = text.match(conListRegex);
      const inConList = conListMatch
        ? new RegExp(`\\b${escapeRegex(normalizedAlias)}s?\\b`, "i").test(conListMatch[1])
        : false;

      const hasTrigger = inConList || triggers.some(t => text.includes(t) || text.includes(`${t}s`));

      // Match singular o plural del alias (ej: "fresa" / "fresas")
      const aliasRegex = new RegExp(`\\b${escapeRegex(normalizedAlias)}s?\\b`, "i");
      if (aliasRegex.test(text) && hasTrigger) {
        const existing = extrasFound.find((e) => e.id === extra.id);

        if (!existing) {
          extrasFound.push({
            id: extra.id,
            nombre: extra.nombre,
            precio: extra.precio,
            cantidad: 1
          });
        }
      }
    }
  }

  return extrasFound;
}

function sameExtras(a?: ParsedExtra[], b?: ParsedExtra[]) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function mergeParsedItems(items: ParsedItem[]) {
  const merged: ParsedItem[] = [];

  for (const item of items) {
    const existing = merged.find(
      (i) =>
        i.productoId === item.productoId &&
        (i.variante || "") === (item.variante || "") &&
        (i.observaciones || "") === (item.observaciones || "") &&
        sameExtras(i.extras, item.extras)
    );

    if (existing) {
      existing.cantidad += item.cantidad;
    } else {
      merged.push({ ...item });
    }
  }

  return merged;
}
export async function parseWithAI(text: string): Promise<ParseResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { items: [] };

  const allProducts = (menu.categorias as any[])
    .filter((c: any) => c.id !== "extras")
    .flatMap((c: any) => c.productos as any[]);

  const menuResumen = allProducts
    .map((p: any) =>
      `- ${p.nombre}${p.aliases?.length ? ` (también: ${(p.aliases as string[]).slice(0, 4).join(", ")})` : ""}`
    )
    .join("\n");

  const prompt =
    `Eres un parser de pedidos para Las Crepes de París, un restaurante en Pereira Colombia. Tu tarea es identificar productos del menú en el mensaje del cliente y retornar un JSON. Solo responde con JSON válido, sin texto adicional. El JSON debe tener este formato: {"items": [{"producto": string, "cantidad": number, "observaciones": string, "extras": []}], "observacionGeneral": string}\n\n` +
    `Menú disponible:\n${menuResumen}\n\n` +
    `Mensaje del cliente: "${text}"\n\n` +
    `Identifica los productos pedidos. Usa el nombre exacto del menú en el campo "producto".`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );

    if (!response.ok) {
      console.error("❌ parseWithAI HTTP error:", response.status);
      return { items: [] };
    }

    const data = await response.json() as any;
    const rawText: string = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { items: [] };

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.items || !Array.isArray(parsed.items)) return { items: [] };

    const mappedItems: ParsedItem[] = [];

    for (const aiItem of parsed.items) {
      const aiNorm = normalizeText(aiItem.producto || "");
      const matchedProduct = allProducts.find((p: any) => {
        const norm = normalizeText(p.nombre);
        return norm === aiNorm || norm.includes(aiNorm) || aiNorm.includes(norm);
      });

      if (!matchedProduct) continue;

      mappedItems.push({
        productoId: matchedProduct.id,
        producto: matchedProduct.nombre,
        cantidad: Math.max(1, Number(aiItem.cantidad) || 1),
        precio: matchedProduct.precio,
        variante: undefined,
        observaciones: aiItem.observaciones || undefined,
        extras: []
      });
    }

    console.log("✅ parseWithAI mapped items:", mappedItems.length);
    return { items: mergeParsedItems(mappedItems) };
  } catch (err) {
    console.error("❌ parseWithAI error:", err);
    return { items: [] };
  }
}

export function parseOrder(text: string): ParseResult {
  const lower = normalizeText(text);
 // Primero limpiar palabras de cortesía, luego dividir
const textoLimpio = lower
  .replace(/\bpor favor\b/g, " ")
  .replace(/\bpara pedir\b/g, " ")
  .replace(/\bquiero\b/g, " ")
  .replace(/\bme das\b/g, " ")
  .replace(/\bme regalas\b/g, " ")
  .replace(/\bdame\b/g, " ")
  .replace(/\benviame\b/g, " ")
  .replace(/\bagregame\b/g, " ")
  .replace(/\bagregarme\b/g, " ")
  .replace(/\bseria\b/g, " ")
  .replace(/\bsería\b/g, " ")
  .replace(/[.]/g, ",")
  .replace(/\s+/g, " ")
  .trim();

const fragments = splitIntoFragments(textoLimpio);

  const items: ParsedItem[] = [];

  const extrasCategory = menu.categorias.find((c) => c.id === "extras");
  const normalCategories = menu.categorias.filter((c) => c.id !== "extras");

  const mainProducts = normalCategories.flatMap(
    (categoria) => categoria.productos as any[]
  );
  const extraProducts = extrasCategory
    ? (extrasCategory.productos as any[])
    : [];

  // detectar ambigüedad por fragmento
// detectar ambigüedad por fragmento
  for (const fragment of fragments) {
    const ambiguity = detectAmbiguousProduct(fragment, mainProducts);

    if (ambiguity) {
      return {
        items: [],
        ambiguousChoice: ambiguity
      };
    }
  }

  // parsear cada fragmento
  // parsear cada fragmento
for (const fragment of fragments) {
  // Ignorar fragmentos que son solo observaciones (sin X, poco X, bien X)
  if (/^(sin|poco|bien)\s+/i.test(fragment.trim())) continue;

  const fragmentLimpio = fragment
    .replace(/^(\d+|una|uno|un|dos|tres|cuatro|cinco)\s+/i, "")
    .replace(/\bcrepe\b/g, "")
    .replace(/\bsin\s+\w+(?:\s+\w+)?\b/g, "")  // quitar "sin X" para buscar producto
    .replace(/\bpoco\s+\w+\b/g, "")
    .replace(/\bbien\s+\w+\b/g, "")
    .trim();

  const cantidad = extractCantidad(fragment);
  const product = findProductInFragment(fragmentLimpio, mainProducts);

  if (!product) {
    continue;
  }

  const variant = findVariantInFragment(fragment, product);
  const observaciones = extractObservaciones(fragment);
  const extras = extractExtrasFromFragment(fragment, extraProducts, product);

  items.push({
    productoId: product.id,
    producto: product.nombre,
    cantidad,
    precio: variant?.precio || product.precio,
    variante: variant?.nombre,
    observaciones,
    extras
  });
}
  return {
    items: mergeParsedItems(items)
  };
}
