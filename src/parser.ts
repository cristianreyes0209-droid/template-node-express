import { menu } from "./menu";

type ParsedItem = {
  producto: string;
  cantidad: number;
  precio: number;
  observaciones?: string;
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

function extractCantidad(fragment: string) {
  for (const key of Object.keys(numbers)) {
    const cleanKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    "sin salsa"
  ];

  for (const regla of reglas) {
    if (fragment.includes(regla)) {
      observaciones.push(regla);
    }
  }

  return observaciones.length > 0 ? observaciones.join(", ") : undefined;
}

function splitIntoFragments(text: string) {
  return text
    .split(/\s+y\s+|,/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseOrder(text: string): ParsedItem[] {
  const lower = normalizeText(text);
  const fragments = splitIntoFragments(lower);

  const items: ParsedItem[] = [];

  const aliasList = menu.productos
    .flatMap((product) =>
      product.aliases.map((alias) => ({
        product,
        alias: normalizeText(alias)
      }))
    )
    .sort((a, b) => b.alias.length - a.alias.length);

  for (const fragment of fragments) {
    let found = false;

    for (const entry of aliasList) {
      const { product, alias } = entry;

      const cleanAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aliasRegex = new RegExp(`\\b${cleanAlias}\\b`, "i");

      if (aliasRegex.test(fragment)) {
        const cantidad = extractCantidad(fragment);
        const observaciones = extractObservaciones(fragment);

        const existing = items.find(
          (i) =>
            i.producto === product.nombre &&
            (i.observaciones || "") === (observaciones || "")
        );

        if (existing) {
          existing.cantidad += cantidad;
        } else {
          items.push({
            producto: product.nombre,
            cantidad,
            precio: product.precio,
            observaciones
          });
        }

        found = true;
        break;
      }
    }

    if (!found) {
      // Fragmento no reconocido; por ahora se ignora
    }
  }

  return items;
}
