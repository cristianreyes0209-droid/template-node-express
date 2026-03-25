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
const STOP_WORDS = new Set([
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

function detectGenericAmbiguity(fragment: string, products: any[]) {
  const tokens = getMeaningfulTokens(fragment);

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
function extractCantidad(fragment: string) {
  for (const key of Object.keys(numbers)) {
    const cleanKey = escapeRegex(key);
    const regex = new RegExp(`\\b${cleanKey}\\b`, "i");

    if (regex.test(fragment)) {
      return numbers[key];
    }
  }

  return 1;
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/,/g, " , ")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .replace("hawaina", "hawaiana")
    .replace("hawainas", "hawaianas")
    .replace("nutela", "nutella")
    .replace("nutelas", "nutellas")
    .replace("degranada", "desgranada")
    .replace("champinon", "champiñon")
    .replace("champinones", "champiñones")
    .replace("pina", "piña")
    .replace("mediteranea", "mediterranea")
    .replace("medterranea", "mediterranea")
    .replace("estrogonof", "strogonoff")
    .replace("estrogonoff", "strogonoff")
    .replace("strogonof", "strogonoff");
}
function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractObservaciones(fragment: string) {
  const observaciones: string[] = [];

  const reglas = [
    "sin queso",
    "sin crema",
    "sin cebolla",
    "sin tomate",
    "sin lechuga",
    "sin champiñones",
    "sin champinones",
    "sin champiñon",
    "sin champinon",
    "sin maiz",
    "sin maíz",
    "sin piña",
    "sin pina",
    "sin salsa",
    "sin jalapeños",
    "sin jalapenos",
    "sin chile",
    "sin frijol",
    "sin parmesano"
  ];

  for (const regla of reglas) {
    if (fragment.includes(regla)) {
      observaciones.push(regla);
    }
  }

  return observaciones.length > 0 ? observaciones.join(", ") : undefined;
}
function splitIntoFragments(text: string) {
  const commaParts = text
    .split(/,/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const result: string[] = [];

  for (const part of commaParts) {
    if (/sin\s+\w+.*\s+y\s+sin\s+\w+/i.test(part)) {
      result.push(part);
      continue;
    }

    const yParts = part
      .split(/\s+y\s+/i)
      .map((p) => p.trim())
      .filter(Boolean);

    if (yParts.length === 1) {
      result.push(part);
      continue;
    }

    for (const yPart of yParts) {
      result.push(yPart);
    }
  }

  return result;
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

    if (aliasRegex.test(text)) {
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

function extractExtrasFromFragment(fragment: string, extrasProducts: any[]) {
  const text = normalizeText(fragment);
  const extrasFound: ParsedExtra[] = [];

  for (const extra of extrasProducts) {
    for (const alias of extra.aliases || []) {
      const normalizedAlias = normalizeText(alias);
      const regex = new RegExp(`\\b${escapeRegex(normalizedAlias)}\\b`, "i");

      const hasTrigger =
        text.includes(`extra ${normalizedAlias}`) ||
        text.includes(`con extra ${normalizedAlias}`) ||
        text.includes(`mas ${normalizedAlias}`) ||
        text.includes(`más ${normalizedAlias}`) ||
        text.includes(`adicional ${normalizedAlias}`);

      if (regex.test(text) && hasTrigger) {
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
export function parseOrder(text: string): ParseResult {
  const lower = normalizeText(text);
  const fragments = splitIntoFragments(lower);

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
  for (const fragment of fragments) {
    const cantidad = extractCantidad(fragment);
    const product = findProductInFragment(fragment, mainProducts);

    if (!product) {
      continue;
    }

    const variant = findVariantInFragment(fragment, product);
    const observaciones = extractObservaciones(fragment);
    const extras = extractExtrasFromFragment(fragment, extraProducts);

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
