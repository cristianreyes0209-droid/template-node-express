import { menu } from "./menu";

type ParsedExtra = {
  nombre: string;
  precio: number;
  cantidad: number;
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

type ParsedItem = {
  producto: string;
  variante?: string;
  cantidad: number;
  precio: number;
  observaciones?: string;
  extras?: ParsedExtra[];
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

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+ni\s+/g, " y sin ")
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
    .replace("pina", "piña");
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    "sin frijol",
    "sin frijoles",
    "sin chile",
    "sin chile con carne",
    "sin pico de gallo",
    "sin jalapeños",
    "sin jalapenos",
    "sin nachos",
    "sin huevo",
    "sin huevos",
    "sin tocineta",
    "sin jamon",
    "sin jamón"
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

function buildAliasList(products: any[]) {
  return products
    .flatMap((product) =>
      product.aliases.map((alias: string) => ({
        product,
        alias: normalizeText(alias)
      }))
    )
    .sort((a, b) => b.alias.length - a.alias.length);
}
function detectAmbiguousProduct(fragment: string, products: any[]) {
  const text = normalizeText(fragment);

  const mentionsCamarones =
    /\bcamarones\b|\bcamaron\b|\bcamarón\b/.test(text);

  if (!mentionsCamarones) {
    return null;
  }

  const mentionsMediterranea =
    text.includes("mediterranea") || text.includes("al ajillo");

  const mentionsMarinera =
    text.includes("marinera") || text.includes("salsa marinera");

  if (mentionsMediterranea || mentionsMarinera) {
    return null;
  }

  const mediterranea = products.find(
    (p: any) => p.id === "mediterranea_camarones"
  );
  const gourmet = products.find(
    (p: any) => p.id === "camarones_gourmet" || p.id === "camarones"
  );

  if (!mediterranea || !gourmet) {
    return null;
  }

  return {
    opciones: [
      {
        nombre: mediterranea.nombre,
        productoId: mediterranea.id
      },
      {
        nombre: gourmet.nombre,
        productoId: gourmet.id
      }
    ]
  };
}

function findProductInFragment(fragment: string, aliasList: any[]) {
  for (const entry of aliasList) {
    const { product, alias } = entry;
    const cleanAlias = escapeRegex(alias);
    const aliasRegex = new RegExp(`\\b${cleanAlias}\\b`, "i");

    if (aliasRegex.test(fragment)) {
      return product;
    }
  }

  return null;
}
function findVariantInFragment(fragment: string, product: any) {
  if (!product.variantes || product.variantes.length === 0) {
    return null;
  }

  // 1. detectar alias explícitos
  for (const variante of product.variantes) {
    for (const alias of variante.aliases) {
      const cleanAlias = escapeRegex(normalizeText(alias));
      const aliasRegex = new RegExp(`\\b${cleanAlias}\\b`, "i");

      if (aliasRegex.test(fragment)) {
        return variante;
      }
    }
  }

  // 2. lógica inteligente (clave)
  const hasPollo = fragment.includes("pollo");
  const hasCarne = fragment.includes("carne");

  if (hasPollo && !hasCarne) {
    return product.variantes.find((v: any) => v.id === "solo_pollo");
  }

  if (hasCarne && !hasPollo) {
    return product.variantes.find((v: any) => v.id === "solo_carne");
  }

  // 3. default = mixta
  return product.variantes.find((v: any) => v.id === "mixta");
}
function extractExtrasFromFragment(fragment: string, extrasAliasList: any[]) {
  const extrasFound: any[] = [];

  for (const entry of extrasAliasList) {
    const { product, alias } = entry;

    const cleanAlias = escapeRegex(alias);
    const aliasRegex = new RegExp(`\\b${cleanAlias}\\b`, "i");

    const hasTrigger =
      fragment.includes("extra") ||
      fragment.includes("mas") ||
      fragment.includes("más") ||
      fragment.includes("con");

    if (aliasRegex.test(fragment) && hasTrigger) {
      const alreadyAdded = extrasFound.find((e) => e.id === product.id);
      if (!alreadyAdded) {
        extrasFound.push(product);
      }
    }
  }

  return extrasFound;
}

function sameExtras(a?: ParsedExtra[], b?: ParsedExtra[]) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

export function parseOrder(text: string): ParseResult {
  const lower = normalizeText(text);
  const fragments = splitIntoFragments(lower);

  const items: ParsedItem[] = [];

  const extrasCategory = menu.categorias.find((c) => c.id === "extras");
  const normalCategories = menu.categorias.filter((c) => c.id !== "extras");

  const mainProducts = normalCategories.flatMap((categoria) => categoria.productos as any[]);
  const extraProducts = extrasCategory ? (extrasCategory.productos as any[]) : [];
  const ambiguity = detectAmbiguousProduct(lower, mainProducts);

if (ambiguity) {
  return {
    items: [],
    ambiguousChoice: ambiguity
  };
}

  const mainAliasList = buildAliasList(mainProducts);
  const extrasAliasList = buildAliasList(extraProducts);

  for (const fragment of fragments) {
    const cantidad = extractCantidad(fragment);
    const observaciones = extractObservaciones(fragment);

   const mainProduct = findProductInFragment(fragment, mainAliasList);
const extras = extractExtrasFromFragment(fragment, extrasAliasList);
const variante = mainProduct ? findVariantInFragment(fragment, mainProduct) : null;

    const parsedExtras: ParsedExtra[] = extras.map((extra) => ({
      nombre: extra.nombre,
      precio: extra.precio,
      cantidad: 1
    }));

    if (mainProduct) {
     const existing = items.find(
  (i) =>
    i.producto === mainProduct.nombre &&
    (i.variante || "") === (variante ? variante.nombre : "") &&
    (i.observaciones || "") === (observaciones || "") &&
    sameExtras(i.extras, parsedExtras)
);

      if (existing) {
        existing.cantidad += cantidad;
      } else {
       items.push({
  producto: mainProduct.nombre,
  variante: variante ? variante.nombre : undefined,
  cantidad,
  precio: variante ? variante.precio : mainProduct.precio,
  observaciones,
  extras: parsedExtras.length > 0 ? parsedExtras : undefined
});
      }
    } else if (parsedExtras.length > 0) {
      for (const extra of parsedExtras) {
        const existingExtra = items.find(
          (i) =>
            i.producto === extra.nombre &&
            !i.observaciones &&
            !i.extras
        );

        if (existingExtra) {
          existingExtra.cantidad += extra.cantidad;
        } else {
          items.push({
            producto: extra.nombre,
            cantidad: extra.cantidad,
            precio: extra.precio
          });
        }
      }
    }
  }

  return { items };
}
