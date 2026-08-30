import { menu } from "./menu";

// Modelo Gemini (sobrescribible por env si Google descontinúa/restringe uno).
// Se usa el alias "gemini-flash-latest": apunta siempre al flash vigente, es multimodal
// (soporta audio para transcripción) y está disponible también para cuentas nuevas
// (las versiones fijas como gemini-2.0/2.5-flash dan 404 "no longer available to new users").
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

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
  upselling?: string;
  productoQuery?: string;
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
  "unos",
  "unas",
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
  "favor",
  "otra",
  "otro",
  "otras",
  "otros"
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
    .replace(/\bstroganoff\b/g, "strogonoff")
    .replace(/\bstroganof\b/g, "strogonoff")
    .replace(/\bstrogonof\b/g, "strogonoff")
    .replace(/\bpari\b/g, "paris")
    .replace(/\bpaqris\b/g, "paris")
    .replace(/\buna de camarones\b/g, "camarones")
    .replace(/\bde camarones\b/g, "camarones")
    // Typos comunes de productos
    .replace(/\bcreps\b/g, "crepe")
    .replace(/\bcreeps\b/g, "crepe")
    .replace(/\bcrees\b/g, "crepe")
    .replace(/\bchepes?\b/g, "crepe")
    .replace(/\bcrepes\b/g, "crepe")
    .replace(/\bcreppes?\b/g, "crepe")
    .replace(/\bcrep\b/g, "crepe")
    .replace(/\battun\b/g, "atun")
    .replace(/\branquera\b/g, "ranchera")
    .replace(/\brancheras\b/g, "ranchera")
    .replace(/\branchero\b/g, "ranchera")
    .replace(/\bhawaina\b/g, "hawaiana")
    .replace(/\bhawaina\b/g, "hawaiana")
    .replace(/\bhawainana\b/g, "hawaiana")
    .replace(/\bhawaina\b/g, "hawaiana")
    .replace(/\bhawayana\b/g, "hawaiana")
    .replace(/\bmexicana\b/g, "mexicana")
    .replace(/\bmejicana\b/g, "mexicana")
    .replace(/\bdesgranado\b/g, "desgranada")
    .replace(/\bmariscos\b/g, "mariscos")
    .replace(/\bnutela\b/g, "nutella")
    .replace(/\barequipe\b/g, "arequipe")
    .replace(/\barrequipe\b/g, "arequipe")
    .replace(/\btropinutela\b/g, "tropinutella")
    .replace(/\bburguesias?\b/g, "burguesa")
    .replace(/\bburgesias?\b/g, "burguesa")
    .replace(/\bburgesa\b/g, "burguesa")
    .replace(/\bhamburguesa\b/g, "burguesa");
}

function splitIntoFragments(text: string) {
  // Primero separamos por coma
  const commaParts = text
    .split(/,/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const result: string[] = [];

  // Productos principales (para proteger frases con "y"/"e" al partir)
  const allMainProdsForSplit = (menu.categorias as any[])
    .filter((c: any) => c.id !== "extras")
    .flatMap((c: any) => c.productos as any[]);
  // Frases de producto que contienen conector " y "/" e " (ej. "pollo y pina", "pollo y carne")
  // → se protegen para que el split por "y" no las parta cuando están dentro de una frase larga.
  const connectorPhrases: string[] = Array.from(new Set(
    allMainProdsForSplit
      .flatMap((p: any) => [p.nombre, ...((p.aliases as string[]) || [])])
      .map((s: string) => normalizeText(s))
      .filter((s: string) => / (?:y|e) /.test(s))
  )).sort((a, b) => b.length - a.length);

  for (const part of commaParts) {
    // Si tiene "sin X y sin Y" no partir por "y"
    if (/sin\s+\w+.*\s+y\s+sin\s+\w+/i.test(part)) {
      result.push(...splitByInlineNumbers(part));
      continue;
    }

    // Si la parte completa es un alias de producto conocido, no partir por "y"
    // (ej: "pollo y champiñones" no debe dividirse en ["pollo", "champiñones"])
    {
      const partNorm = normalizeText(part);
      const partNormSinCantidad = partNorm.replace(/^\d+\s+|^(?:un|una|uno|dos|tres|cuatro|cinco)\s+/i, "").trim();
      // También probar sin prefijo "crepe de " / "crepe " para capturar "una crepe de pollo y carne"
      const partNormSinCrepe = partNormSinCantidad.replace(/^crepe\s+de\s+|^crepe\s+/i, "").trim();
      const isKnownProductPhrase = allMainProdsForSplit.some((p: any) =>
        normalizeText(p.nombre) === partNorm ||
        normalizeText(p.nombre) === partNormSinCantidad ||
        normalizeText(p.nombre) === partNormSinCrepe ||
        (p.aliases || []).some((a: string) =>
          normalizeText(a) === partNorm ||
          normalizeText(a) === partNormSinCantidad ||
          normalizeText(a) === partNormSinCrepe
        )
      );
      if (isKnownProductPhrase) {
        result.push(...splitByInlineNumbers(part));
        continue;
      }
    }

    // Proteger frases de producto con conector "y"/"e" (ej. "pollo y pina") dentro de una
    // parte larga: enmascarar el conector con un centinela para que el split por "y" no las parta.
    let partProteg = part;
    for (const ph of connectorPhrases) {
      if (partProteg.includes(ph)) {
        partProteg = partProteg.split(ph).join(ph.replace(/ (y|e) /g, "$1"));
      }
    }

    // Partir por "y", "e", "más", "además", "también", "súmale", "agrégale"
    // PERO solo si lo que sigue NO es una observación ("sin ...", "poco ...", "bien ...")
    const separatorRegex = /\s+(?:y|e|mas|tambien|ademas|sumale|agregale)\s+/gi;
    const segments: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = separatorRegex.exec(partProteg)) !== null) {
      const before = partProteg.slice(lastIndex, match.index);
      const after = partProteg.slice(match.index + match[0].length);
      // Si lo que viene después del separador empieza con una observación, no separar
      if (/^(sin|poco|bien|extra)\s+/i.test(after)) {
        continue;
      }
      // Si estamos dentro de una cláusula de extras "con X y Z", no partir
      // (a menos que lo que sigue sea una cantidad nueva como "2 hawaiana")
      if (/\bcon\s+\w/i.test(before) && !/^(\d+|un|una|dos|tres|cuatro|cinco)\s+/i.test(after)) {
        continue;
      }
      segments.push(before.trim());
      lastIndex = match.index + match[0].length;
    }
    segments.push(partProteg.slice(lastIndex).trim());

    for (const seg of segments.filter(Boolean)) {
      // Restaurar el centinela del conector protegido
      const segRestaurado = seg.replace(/(y|e)/g, " $1 ");
      result.push(...splitByInlineNumbers(segRestaurado));
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

export function extractObservaciones(fragment: string): string | undefined {
  const text = fragment.toLowerCase();
  const observaciones: string[] = [];

  // Captura "sin X" o "sin X Y" pero NO incluye conectores ("con","y","de","o") ni disparadores
  // de adición ("adicional","extra","mas"...) como parte de la observación (ej. "sin champiñones adicional de piña").
  // Nota: [\wáéíóúüñ] incluye ñ/acentos, que \w de JS excluye (evita truncar "champiñones" → "champi")
  const STOP2 = /^(con|y|e|de|o|u|adicional|adicion|adición|extra|mas|más|agregar|añadir|añade|anadir)$/i;
  const sinRegex = /\bsin\s+([\wáéíóúüñ]+)(?:\s+([\wáéíóúüñ]+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = sinRegex.exec(text)) !== null) {
    let obs = m[1];
    if (m[2] && !STOP2.test(m[2])) obs += ` ${m[2]}`;
    observaciones.push(`sin ${obs.trim()}`);
  }

  // "si <ingrediente>" = typo de "sin <ingrediente>" (le falta la "n"). Solo se toma como negación
  // cuando la palabra siguiente es un ingrediente removible conocido — así "sí" (confirmación) no
  // genera falsos positivos ("si quiero", "si gracias", "si" solo → nada).
  const INGREDIENTES_REMOVIBLES = new Set([
    "salsa","salsas","cebolla","cebollas","queso","quesos","tomate","tomates","lechuga",
    "champinon","champinones","jalapeno","jalapenos","pollo","carne","huevo","huevos",
    "maiz","pina","tocineta","jamon","azucar","sal","picante","mayonesa","mostaza","aji",
    "arequipe","nutella","crema","aderezo","pepinillo","pepinillos","pepperoni","salami","ranchera"
  ]);
  const stripAcentos = (w: string) => w.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const siRegex = /\bsi\s+([\wáéíóúüñ]+)(?:\s+([\wáéíóúüñ]+))?/gi;
  while ((m = siRegex.exec(text)) !== null) {
    if (!INGREDIENTES_REMOVIBLES.has(stripAcentos(m[1]))) continue;
    let obs = m[1];
    if (m[2] && !STOP2.test(m[2])) obs += ` ${m[2]}`;
    const negacion = `sin ${obs.trim()}`;
    if (!observaciones.includes(negacion)) observaciones.push(negacion);
  }

  const pocoMatch = text.match(/\bpoco\s+([\wáéíóúüñ]+)/i);
  if (pocoMatch) observaciones.push(`poco ${pocoMatch[1]}`);

  const bienMatch = text.match(/\bbien\s+([\wáéíóúüñ]+)/i);
  if (bienMatch) observaciones.push(`bien ${bienMatch[1]}`);

  // "solo X" / "solo con X" = el cliente quiere ÚNICAMENTE X → es una observación (NO agregar extras;
  // eso lo evita extractExtrasFromFragment). Ej: "desgranada solo con queso cuajada" → "solo queso cuajada".
  const soloMatch = text.match(/\bsolo\s+(?:con\s+)?(.+)$/i);
  if (soloMatch) {
    const resto = soloMatch[1].replace(/\b(por\s*favor|porfa|gracias)\b.*$/i, "").trim();
    if (resto && resto.length <= 40) observaciones.push(`solo ${resto}`);
  }

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
  // Palabras comunes (para, con, sin, por, del…) NO deben matchear productos por typo/similitud
  // (ej. "para" ≈ "paris" → registraba una Crepe de Paris fantasma)
  const esStopWord = STOP_WORDS.has(text);

  const matches: { product: any; alias: string; score: number }[] = [];

  for (const entry of aliasEntries) {
    const cleanAlias = escapeRegex(entry.alias);
    const aliasRegex = new RegExp(`\\b${cleanAlias}\\b`, "i");

    let score = 0;
    if (entry.alias === text) {
      score = 3; // coincidencia exacta con el alias
    } else if (aliasRegex.test(text) || (entry.alias.length >= 4 && text.includes(entry.alias))) {
      score = 2; // alias completo encontrado en el texto (subcadena solo para alias de ≥4 chars)
    } else if (entry.alias.includes(text) && text.length >= 4 && text.length >= entry.alias.length * 0.6) {
      score = 1; // texto es parte significativa del alias
    } else if (!esStopWord && similarity(text, entry.alias) > 0.78) {
      score = 1; // similitud difusa
    } else if (
      !esStopWord &&
      text.length >= 4 &&
      entry.alias.length >= 4 &&
      editDistance(text, entry.alias) <= (text.length >= 6 ? 2 : 1)
    ) {
      score = 1; // Levenshtein (≤2 palabras largas, ≤1 cortas: evita "otra"↔"mora")
    }

    if (score > 0) {
      matches.push({ product: entry.product, alias: entry.alias, score });
    }
  }

  if (matches.length === 0) {
    return [];
  }

  const maxScore = Math.max(...matches.map((m) => m.score));
  const bestMatches = matches.filter((m) => m.score === maxScore);

  const maxAliasLength = Math.max(...bestMatches.map((m) => m.alias.length));
  const strongestMatches = bestMatches.filter((m) => m.alias.length === maxAliasLength);

  return strongestMatches
    .filter((match, index, arr) => arr.findIndex((m) => m.product.id === match.product.id) === index)
    .map((m) => m.product);
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

  // Si un producto tiene el token como alias exacto, no es ambiguo — se resuelve solo
  const exactAliasMatch = uniqueMatches.find((p: any) =>
    (p.aliases || []).some((alias: string) => normalizeText(alias) === token) ||
    normalizeText(p.nombre) === token
  );
  if (exactAliasMatch) return null;

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

export function extractExtrasFromFragment(fragment: string, extrasProducts: any[], product?: any) {
  const text = normalizeText(fragment);
  const extrasFound: ParsedExtra[] = [];

  // "solo con X" / "solo X" = el cliente quiere ÚNICAMENTE X (restricción, no adición). No cobrar extras
  // (se registra como observación "solo X" vía extractObservaciones). Evita sobrecobros.
  if (/\bsolo\b/.test(text)) return [];

  // Si se nombra un queso ESPECÍFICO ("queso cuajada/americano/parmesano"), no agregar también el
  // "queso" genérico (doble crema). Evita meter dos quesos por "con queso cuajada".
  const quesoEspecifico = /\bqueso\s+(cuajada|americano|parmesano|mozarella|mozzarella)\b/.test(text);

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
      // No agregar el "queso" genérico (doble crema) si se nombró un queso específico
      if (normalizedAlias === "queso" && quesoEspecifico) continue;
      const regex = new RegExp(`\\b${escapeRegex(normalizedAlias)}\\b`, "i");

      const triggers = [
        `extra ${normalizedAlias}`,
        `con extra ${normalizedAlias}`,
        `mas ${normalizedAlias}`,
        `adicional ${normalizedAlias}`,
        `adicional de ${normalizedAlias}`,
        `adicion ${normalizedAlias}`,
        `adicion de ${normalizedAlias}`,
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
      const exactPresent = aliasRegex.test(text);

      // Fallback difuso: tolera 1 typo dentro de la lista "con X y Z" (ej "durazo" → "durazno").
      // Guardas: alias ≥5 y token ≥4 → en la práctica solo 1 error de tipeo, evita falsos positivos.
      let fuzzyInConList = false;
      if (!exactPresent && conListMatch && normalizedAlias.length >= 5) {
        const tokens = conListMatch[1].split(/[^a-z0-9ñ]+/i).filter(t => t.length >= 4);
        fuzzyInConList = tokens.some(t => similarity(t, normalizedAlias) >= 0.8);
      }

      if ((exactPresent && hasTrigger) || fuzzyInConList) {
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

// Detecta pago mixto/declarado en texto libre: montos asociados a método (nequi/daviplata/
// bancolombia/transferencia) y/o efectivo. Ej: "80,000 Nequi\n4,900 efectivo".
// Normaliza montos colombianos ("80.000"/"80,000" → 80000). Devuelve null si no hay señal clara.
export function parsePagoMixto(text: string): { metodo?: "nequi" | "bancolombia"; transferencia?: number; efectivo?: number } | null {
  const t = (text || "").toLowerCase();
  // Montos colombianos hasta ~$2.000.000. Números mayores (ej: un celular Nequi "3207218267")
  // NO son montos → se ignoran para no contaminar el pago.
  const parseMonto = (s: string): number => {
    const n = parseInt(s.replace(/[.,\s]/g, ""), 10) || 0;
    return n > 2000000 ? 0 : n;
  };
  // Número más cercano a una palabra clave (antes —con conector opcional "por/de/en"— o después).
  const montoCerca = (kw: RegExp): number => {
    const m = t.match(new RegExp(`(\\d[\\d.,]*)\\s*(?:pesos|cop|\\$)?\\s*(?:por|de|en)?\\s*(?:${kw.source})|(?:${kw.source})\\s*(?:por|de|:)?\\s*\\$?\\s*(\\d[\\d.,]*)`, "i"));
    if (!m) return 0;
    return parseMonto(m[1] || m[2] || "");
  };
  const efectivo = montoCerca(/efectivo/);
  const esBanco = /\b(bancolombia|transferencia|llave)\b/.test(t);
  const esNequi = /\b(nequi|daviplata)\b/.test(t);
  let transferencia = 0;
  let metodo: "nequi" | "bancolombia" | undefined;
  if (esNequi) { transferencia = montoCerca(/nequi|daviplata/); metodo = "nequi"; }
  else if (esBanco) { transferencia = montoCerca(/bancolombia|transferencia|llave/); metodo = "bancolombia"; }
  if (!metodo && !efectivo) return null;
  const out: { metodo?: "nequi" | "bancolombia"; transferencia?: number; efectivo?: number } = {};
  if (metodo) out.metodo = metodo;
  if (transferencia > 0) out.transferencia = transferencia;
  if (efectivo > 0) out.efectivo = efectivo;
  return out;
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
export function isQuestion(text: string): boolean {
  if (text.includes("?")) return true;
  const norm = normalizeText(text);
  if (/^(que|que|como|cual|cuanto|cuanta|tiene|trae|incluye|lleva|hay)\b/.test(norm)) return true;
  // Consultas de opciones / ingredientes / recomendaciones → no son pedidos
  if (/\b(opciones|opcion|ingredientes|cuales|recomiendame|recomienda|recomiendas)\b/.test(norm)) return true;
  return false;
}

// Responde de forma DETERMINÍSTICA a "¿qué crepes/opciones con/de X tienen?" listando las crepes
// que contienen ese ingrediente/proteína (sin depender de Gemini). Devuelve el texto o null.
export function consultarCrepesPorIngrediente(text: string): string | null {
  const norm = normalizeText(text);
  // Debe ser una CONSULTA de opciones, no un pedido concreto ("una crepe de pollo")
  const senalConsulta =
    /\bopcion(es)?\b/.test(norm) ||
    /\bcuales\b/.test(norm) ||
    (/\bque\b/.test(norm) && /\b(tienen|tiene|hay|manejan|ofrecen)\b/.test(norm));
  if (!senalConsulta) return null;

  const GRUPOS: { kw: string[]; etiqueta: string }[] = [
    { kw: ["pollo"], etiqueta: "pollo" },
    { kw: ["carne", "res"], etiqueta: "carne" },
    { kw: ["champinon", "champinones", "hongos"], etiqueta: "champiñón" },
    { kw: ["camarones", "mariscos", "pescado"], etiqueta: "mariscos" },
    { kw: ["tocineta"], etiqueta: "tocineta" },
    { kw: ["pepperoni"], etiqueta: "pepperoni" },
    { kw: ["jamon"], etiqueta: "jamón" },
    { kw: ["ranchera", "salchicha"], etiqueta: "salchicha ranchera" },
    { kw: ["vegetarian", "vegetal", "vegetales", "verdura", "verduras"], etiqueta: "vegetarianas" },
    { kw: ["pina"], etiqueta: "piña" },
  ];
  const grupo = GRUPOS.find(g => g.kw.some(k => new RegExp(`\\b${k}`).test(norm)));
  if (!grupo) return null;

  const cats = (menu.categorias as any[]).filter(
    (c: any) => !["extras", "bebidas", "dulces", "con_frutas", "entradas"].includes(c.id)
  );
  const productos = cats.flatMap((c: any) => (c.productos as any[]) || []);
  const matches = productos.filter((p: any) => {
    const blob = normalizeText([p.nombre, ...(p.aliases || []), ...(p.ingredientes || [])].join(" "));
    return grupo.kw.some(k => blob.includes(k));
  });
  if (matches.length === 0) return null;

  const lista = matches
    .map((p: any) => `• ${p.nombre} — $${(p.precio || 0).toLocaleString("es-CO")}`)
    .join("\n");
  return `Estas son nuestras crepes con ${grupo.etiqueta} 😊\n\n${lista}\n\n¿Cuál te provoca? Escríbeme el nombre y te la registro 🥞`;
}

export function isAmbiguousText(text: string): boolean {
  const norm = normalizeText(text);
  const allProducts = (menu.categorias as any[])
    .filter((c: any) => c.id !== "extras")
    .flatMap((c: any) => c.productos as any[]);

  const allAliases = allProducts.flatMap((p: any) =>
    ([p.nombre, ...(p.aliases || [])] as string[]).map(normalizeText)
  );

  const words = norm.split(/\s+/).filter(w => w.length > 2);
  const recognized = words.filter(w =>
    allAliases.some(alias => alias.includes(w) || w.includes(alias))
  );

  return recognized.length < 3;
}

export type AIClassification =
  | { intent: "producto"; items: ParsedItem[]; upselling?: string }
  | { intent: "observacion"; texto: string; productoIndex?: number }
  | { intent: "pregunta"; respuesta: string }
  | { intent: "extra"; nombre: string; precio: number; productoIndex?: number }
  | { intent: "eliminar"; index: number; nombre?: string }
  | { intent: "reemplazar"; index: number; nombre?: string; items: ParsedItem[] }
  | { intent: "ambiguo"; opciones: { nombre: string; productoId: string }[] };

export async function classifyWithAI(
  text: string,
  currentItems: { producto: string; precio: number; variante?: string }[],
  step: string
): Promise<AIClassification | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const allProducts = (menu.categorias as any[])
    .filter((c: any) => c.id !== "extras")
    .flatMap((c: any) => c.productos as any[]);

  const extrasProducts = (menu.categorias.find((c: any) => c.id === "extras") as any)?.productos || [];

  const menuResumen = allProducts
    .map((p: any) =>
      `- id:${p.id} | ${p.nombre} $${p.precio}${p.ingredientes?.length ? ` | lleva: ${(p.ingredientes as string[]).join(", ")}` : ""}${p.aliases?.length ? ` (aliases: ${(p.aliases as string[]).slice(0, 3).join(", ")})` : ""}${p.variantes ? ` [variantes: ${(p.variantes as any[]).map((v: any) => `${v.nombre} $${v.precio}`).join(" / ")}]` : ""}`
    )
    .join("\n");

  const extrasResumen = extrasProducts
    .map((e: any) => `- ${e.nombre} $${e.precio} (id:${e.id}${e.tipo ? `, tipo:${e.tipo}` : ""})`)
    .join("\n");

  const pedidoActual = currentItems.length > 0
    ? currentItems.map((i, idx) => `${idx + 1}. ${i.producto}${i.variante ? " - " + i.variante : ""} $${i.precio}`).join("\n")
    : "(vacío)";

  const prompt =
    `Eres el asistente de pedidos y EXPERTO DEL MENÚ de Las Crepes de París, Pereira Colombia. Step actual: "${step}".\n` +
    `Conoces los ingredientes de cada crepe y puedes recomendar, describir qué lleva un producto y resolver dudas del menú.\n\n` +
    `PEDIDO ACTUAL DEL CLIENTE:\n${pedidoActual}\n\n` +
    `MENÚ PRINCIPAL (con ingredientes):\n${menuResumen}\n\n` +
    `EXTRAS/TOPPINGS DISPONIBLES (con su tipo/categoría):\n${extrasResumen}\n\n` +
    `MENSAJE DEL CLIENTE: "${text}"\n\n` +
    `Analiza el mensaje y responde SOLO con JSON válido, sin texto extra. El JSON debe tener este formato:\n` +
    `{\n` +
    `  "intent": "producto" | "observacion" | "pregunta" | "extra" | "eliminar" | "reemplazar" | "ambiguo",\n` +
    `  "items": [{"productoId": string, "producto": string, "cantidad": number, "precio": number, "observaciones": string, "extras": []}],\n` +
    `  "observacion": string,\n` +
    `  "productoIndex": number,\n` +
    `  "eliminarIndex": number,\n` +
    `  "respuesta": string,\n` +
    `  "extraNombre": string,\n` +
    `  "extraPrecio": number,\n` +
    `  "opciones": [{"nombre": string, "productoId": string}]\n` +
    `}\n\n` +
    `REGLAS:\n` +
    `- Los índices ("productoIndex", "eliminarIndex") son 0-based y se refieren a la lista PEDIDO ACTUAL DEL CLIENTE de arriba (el ítem 1 es index 0).\n` +
    `- intent "producto": el cliente pide algo del menú. Llena "items" con los productos identificados usando el id exacto del menú.\n` +
    `- intent "observacion": el cliente hace una modificación (sin X, poco X, bien X, "solo X") a un producto ya en el pedido. Llena "observacion" y "productoIndex" (-1 si aplica a todos).\n` +
    `- CAMBIO DE INGREDIENTE (swap): si el cliente pide cambiar un ingrediente de SU crepe por otro del MISMO tipo/categoría (proteína↔proteína como jamón→pollo→carne→tocineta; queso↔queso como doble crema→cuajada→americano; salsa↔salsa) → usa intent "observacion" con "observacion":"cambiar X por Y" y el "productoIndex" del ítem. Es SIN COSTO. Solo permite el cambio si el ingrediente que sale realmente está en ese producto y el que entra es del mismo tipo (mira la lista de ingredientes y el tipo de los extras).\n` +
    `- Si el cliente pide cambiar por un ingrediente de OTRA categoría (ej. cambiar queso por nutella) o AGREGAR algo extra, NO lo registres como swap gratis: usa intent "extra" (ofrécelo como topping pago) o intent "pregunta" explicando amablemente que ese cambio no aplica pero puede agregarlo como adicional.\n` +
    `- intent "pregunta": el cliente pregunta o pide una recomendación/descripción ("qué lleva la ranchera", "cuál me recomiendas", "tienen algo sin cebolla"). Llena "respuesta" con una respuesta corta, cálida y EXACTA según los ingredientes del menú de arriba.\n` +
    `- intent "extra": el cliente pide un extra/topping (tocineta, champiñones, maíz, fresa...). Llena "extraNombre", "extraPrecio" y "productoIndex" (el ítem del pedido al que va el topping; si no es claro, la última crepe, NUNCA una bebida).\n` +
    `- intent "eliminar": el cliente quiere QUITAR un producto ya en el pedido ("quítame el agua", "el jugo no", "borra la coca cola", "ya no quiero X"). Llena "eliminarIndex" con el índice del ítem a quitar.\n` +
    `- intent "reemplazar": el cliente quiere CAMBIAR un producto por otro ("agua no, mejor un jugo", "cambia la coca por limonada", "en vez de X quiero Y"). Llena "eliminarIndex" (el que sale) e "items" (el/los que entran, con id del menú).\n` +
    `- intent "ambiguo": el mensaje coincide con varios productos. Llena "opciones" con los candidatos.\n` +
    `- Si el texto parece un pedido de comida o bebida pero el producto NO está en el menú, usa intent "pregunta" y en "respuesta" escribe: "Lo sentimos, en este momento no tenemos [nombre del producto] 😊 ¿Deseas agregar algo más?"\n` +
    `- Si el texto no es reconocible como nada, usa intent "ambiguo" con opciones vacías.`;

  try {
    console.log(`🤖 LLAMANDO GEMINI (classifyWithAI) con texto: "${text}"`);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
        })
      }
    );

    if (!response.ok) {
      if (response.status === 429) {
        console.warn("⚠️ Gemini 429 (classifyWithAI): cuota agotada, continuando con parser de reglas");
      } else {
        console.error(`❌ ERROR GEMINI (classifyWithAI) HTTP ${response.status}:`, await response.text());
      }
      return null;
    }

    const data = await response.json() as any;
    const rawText: string = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log(`🤖 RESPUESTA GEMINI (classifyWithAI): ${rawText.slice(0, 300)}`);
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const intent = parsed.intent;

    if (intent === "producto") {
      const mappedItems: ParsedItem[] = [];
      for (const aiItem of (parsed.items || [])) {
        const aiNorm = normalizeText(aiItem.producto || "");
        const matched = allProducts.find((p: any) => {
          if (aiItem.productoId && p.id === aiItem.productoId) return true;
          const norm = normalizeText(p.nombre);
          return norm === aiNorm || norm.includes(aiNorm) || aiNorm.includes(norm);
        });
        if (!matched) continue;
        mappedItems.push({
          productoId: matched.id,
          producto: matched.nombre,
          cantidad: Math.max(1, Number(aiItem.cantidad) || 1),
          precio: Number(aiItem.precio) || matched.precio,
          variante: undefined,
          observaciones: aiItem.observaciones || undefined,
          extras: []
        });
      }
      if (mappedItems.length === 0) return null;
      const upselling = typeof parsed.upselling === "string" ? parsed.upselling.trim() : "";
      console.log("✅ classifyWithAI → producto:", mappedItems.map(i => i.producto).join(", "));
      return { intent: "producto", items: mergeParsedItems(mappedItems), upselling: upselling || undefined };
    }

    if (intent === "observacion") {
      const obs = typeof parsed.observacion === "string" ? parsed.observacion.trim() : "";
      if (!obs) return null;
      console.log("✅ classifyWithAI → observacion:", obs);
      return { intent: "observacion", texto: obs, productoIndex: typeof parsed.productoIndex === "number" ? parsed.productoIndex : -1 };
    }

    if (intent === "pregunta") {
      const respuesta = typeof parsed.respuesta === "string" ? parsed.respuesta.trim() : "";
      if (!respuesta) return null;
      console.log("✅ classifyWithAI → pregunta");
      return { intent: "pregunta", respuesta };
    }

    if (intent === "extra") {
      const nombre = typeof parsed.extraNombre === "string" ? parsed.extraNombre.trim() : "";
      const precio = Number(parsed.extraPrecio) || 0;
      if (!nombre) return null;
      const productoIndex = typeof parsed.productoIndex === "number" ? parsed.productoIndex : undefined;
      console.log("✅ classifyWithAI → extra:", nombre, "→ index", productoIndex);
      return { intent: "extra", nombre, precio, productoIndex };
    }

    if (intent === "eliminar") {
      const index = typeof parsed.eliminarIndex === "number" ? parsed.eliminarIndex : -1;
      const nombre = typeof parsed.observacion === "string" ? parsed.observacion.trim() : undefined;
      console.log("✅ classifyWithAI → eliminar index:", index);
      return { intent: "eliminar", index, nombre };
    }

    if (intent === "reemplazar") {
      const index = typeof parsed.eliminarIndex === "number" ? parsed.eliminarIndex : -1;
      const mappedItems: ParsedItem[] = [];
      for (const aiItem of (parsed.items || [])) {
        const aiNorm = normalizeText(aiItem.producto || "");
        const matched = allProducts.find((p: any) => {
          if (aiItem.productoId && p.id === aiItem.productoId) return true;
          const norm = normalizeText(p.nombre);
          return norm === aiNorm || norm.includes(aiNorm) || aiNorm.includes(norm);
        });
        if (!matched) continue;
        mappedItems.push({
          productoId: matched.id,
          producto: matched.nombre,
          cantidad: Math.max(1, Number(aiItem.cantidad) || 1),
          precio: Number(aiItem.precio) || matched.precio,
          variante: undefined,
          observaciones: aiItem.observaciones || undefined,
          extras: []
        });
      }
      if (mappedItems.length === 0) return null;
      console.log("✅ classifyWithAI → reemplazar index:", index, "por:", mappedItems.map(i => i.producto).join(", "));
      return { intent: "reemplazar", index, items: mergeParsedItems(mappedItems) };
    }

    if (intent === "ambiguo") {
      const opciones = Array.isArray(parsed.opciones) ? parsed.opciones : [];
      console.log("✅ classifyWithAI → ambiguo:", opciones.length, "opciones");
      return { intent: "ambiguo", opciones };
    }

    return null;
  } catch (err) {
    console.error(`❌ ERROR GEMINI (classifyWithAI):`, err);
    return null;
  }
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
    `Eres un asistente de pedidos para Las Crepes de París, Pereira Colombia. Tu trabajo tiene DOS partes:\n\n` +
    `PARTE 1 - PARSEAR EL PEDIDO:\n` +
    `Identifica productos del menú en el mensaje del cliente aunque estén mal escritos. Retorna JSON con este formato exacto:\n` +
    `{\n  "items": [{\n    "producto": string,\n    "productoId": string,\n    "cantidad": number,\n    "precio": number,\n    "observaciones": string,\n    "extras": [{"nombre": string, "precio": number}]\n  }],\n  "observacionGeneral": string\n}\n\n` +
    `REGLAS:\n` +
    `- Detecta observaciones como 'sin cebolla', 'bien tostada', 'poco queso'\n` +
    `- No inventes productos que no estén en el menú\n` +
    `- Si no reconoces el producto retorna items vacío\n` +
    `- Solo responde con JSON válido, sin texto adicional\n\n` +
    `Menú disponible:\n${menuResumen}\n\n` +
    `Mensaje del cliente: "${text}"`;

  try {
    console.log(`🤖 LLAMANDO GEMINI (parseWithAI) con texto: "${text}"`);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
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
      if (response.status === 429) {
        console.warn("⚠️ Gemini 429 (parseWithAI): cuota agotada, continuando con parser de reglas");
      } else {
        console.error(`❌ ERROR GEMINI (parseWithAI) HTTP ${response.status}:`, await response.text());
      }
      return { items: [] };
    }

    const data = await response.json() as any;
    const rawText: string = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log(`🤖 RESPUESTA GEMINI (parseWithAI): ${rawText.slice(0, 300)}`);

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

    const upselling: string = typeof parsed.upselling === "string" ? parsed.upselling.trim() : "";
    console.log("✅ parseWithAI mapped items:", mappedItems.length, "upselling:", upselling || "(none)");
    return { items: mergeParsedItems(mappedItems), upselling: upselling || undefined };
  } catch (err) {
    console.error(`❌ ERROR GEMINI (parseWithAI):`, err);
    return { items: [] };
  }
}

export function parseOrder(text: string): ParseResult {
  // "+" como separador de adición (ej. "Nutella + fresa + queso") → tratarlo como "con"
  text = text.replace(/\+/g, " con ");
  const lower = normalizeText(text);

  // Detectar preguntas sobre ingredientes: "qué tiene/lleva/trae/incluye X", "ingredientes de X"
  // También: "quiero saber qué tiene X", "me dices qué lleva X", etc.
  const ingredientVerbs = "(?:tiene|lleva|trae|contiene|incluye|trae)";
  const prefixOptional = "(?:(?:quiero saber|me (?:puedes?|puede) decir|dime|digame|sabeme decir)\\s+)?";
  const queVerb = new RegExp(
    `^${prefixOptional}(?:que|cual es la receta de)\\s+${ingredientVerbs}\\s+(?:la\\s+|el\\s+|una?\\s+)?(.+?)[\\?]?$`
  );
  const ingredientesPrefix = /^(?:ingredientes?)\s+(?:de\s+)?(?:la\s+|el\s+|una?\s+)?(.+?)[\?]?$/;
  const sufixPattern = /^(?:la\s+|el\s+)?(.+?)\s+que\s+(?:tiene|lleva|trae|contiene|incluye)[\?]?$/;
  const queryMatch = queVerb.exec(lower) || ingredientesPrefix.exec(lower) || sufixPattern.exec(lower);
  if (queryMatch) {
    const allProducts = (menu.categorias as any[]).reduce((acc: any[], c: any) => acc.concat(c.productos), []);
    const queryTerm = queryMatch[1].trim();
    const matches = findBestProductMatches(queryTerm, allProducts);
    if (matches.length > 0) {
      return { items: [], productoQuery: matches[0].id };
    }
  }

 // Primero limpiar palabras de cortesía, luego dividir
// Saltos de línea → separador de ítems (sobrevive a normalizeText como token, luego pasa a coma)
const textoConSeparadores = normalizeText(text.replace(/[\r\n]+/g, " xsplitx "));
const textoLimpio = textoConSeparadores
  .replace(/\bhola+\b/g, " ")
  .replace(/\bholi(?:s|is)?\b/g, " ")
  .replace(/\bbuen[oa]s?(?:\s+(?:dias|tardes|noches))?\b/g, " ")
  .replace(/\bbuen\s+dia\b/g, " ")
  .replace(/\bque\s+tal\b/g, " ")
  .replace(/\bsaludos\b/g, " ")
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
  .replace(/\bxsplitx\b/g, ",")
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

  // Parsear fragmentos: si uno es ambiguo, guardarlo y saltar; agregar los demás al carrito
  let firstAmbiguity: ReturnType<typeof detectAmbiguousProduct> | null = null;

// Helper de limpieza de fragmento para buscar el producto
const limpiarFrag = (s: string) => s
  .replace(/^(\d+|una|unas|uno|unos|un|dos|tres|cuatro|cinco)\s+/i, "")
  .replace(/\bcrepe\s+de\b/g, "")   // "crepe de X" → "X"
  .replace(/\bcrepe\b/g, "")
  .replace(/\bun\s+/g, "")          // artículos
  .replace(/\buna\s+/g, "")
  .replace(/\bel\s+/g, "")
  .replace(/\bla\s+/g, "")
  .replace(/\blos\s+/g, "")
  .replace(/\blas\s+/g, "")
  .replace(/\bsin\s+\w+(?:\s+\w+)?\b/g, "")  // quitar "sin X" para buscar producto
  .replace(/\bpoco\s+\w+\b/g, "")
  .replace(/\bbien\s+\w+\b/g, "")
  .replace(/\s+/g, " ")
  .trim();

for (const fragment of fragments) {
  // Ignorar fragmentos que son solo observaciones (sin X, poco X, bien X)
  if (/^(sin|poco|bien)\s+/i.test(fragment.trim())) continue;

  // Quitar las adiciones ("adicion de X", "adicional X") para el match de PRODUCTO;
  // se extraen aparte como extras desde el fragmento crudo.
  const fragmentSinAdic = fragment
    .replace(/\badicion(?:al)?\s+(?:de\s+)?[a-záéíóúñ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const ambiguity = detectAmbiguousProduct(fragmentSinAdic, mainProducts);
  if (ambiguity) {
    if (!firstAmbiguity) firstAmbiguity = ambiguity;
    continue; // saltar este fragmento, parsear los demás
  }

  const fragmentLimpio = limpiarFrag(fragmentSinAdic);       // para buscar producto (sin adiciones)
  const fragmentLimpioConAdic = limpiarFrag(fragment);       // conserva adiciones, para isExactProductAlias

  const cantidad = extractCantidad(fragment);
  let product = findProductInFragment(fragmentLimpio, mainProducts);

  // "X con <sabor>" donde X es un crepe: el sabor es un topping, no un jugo.
  // Si el match cayó en un jugo pero antes de "con" hay un crepe, preferir el crepe.
  if (product && (product as any).tipo === "jugo") {
    const conIdx = fragmentLimpio.search(/\bcon\b/);
    if (conIdx > 0) {
      const antesDeCon = fragmentLimpio.slice(0, conIdx).trim();
      const prodAntes = antesDeCon ? findProductInFragment(antesDeCon, mainProducts) : null;
      if (prodAntes && (prodAntes as any).tipo !== "jugo") product = prodAntes;
    }
  }

  if (!product) {
    // El fragmento puede ser ambiguo tras limpiar (ej. "1 crepe ranchera" → "ranchera" = Ranchera / Ranchera Mixta).
    // Surfacearlo como aclaración en vez de descartarlo en silencio.
    if (!firstAmbiguity) {
      const ambiguoLimpio = detectAmbiguousProduct(fragmentLimpio, mainProducts);
      if (ambiguoLimpio) firstAmbiguity = ambiguoLimpio;
    }
    continue;
  }

  const variant = findVariantInFragment(fragmentSinAdic, product);
  const observaciones = extractObservaciones(fragment);
  // Si el fragmento completo (con adiciones) es un alias del producto, no extraer extras
  // (evita que "pollo con champiñones" agregue champiñones como extra)
  const fragmentNorm = normalizeText(fragmentLimpioConAdic);
  const isExactProductAlias =
    normalizeText(product.nombre) === fragmentNorm ||
    (product.aliases || []).some((a: string) => normalizeText(a) === fragmentNorm);
  const extras = isExactProductAlias ? [] : extractExtrasFromFragment(fragment, extraProducts, product);

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
  // Si hubo ambigüedad, retornar con los ítems no-ambiguos ya recolectados
  if (firstAmbiguity) {
    return { items: mergeParsedItems(items), ambiguousChoice: firstAmbiguity };
  }

  // Upselling básico: si no hay bebida en el pedido, sugerir una
  let upselling: string | undefined;
  if (items.length > 0) {
    const bebidasCat = (menu.categorias as any[]).find((c: any) => c.id === "bebidas");
    const bebidasIds: string[] = bebidasCat ? (bebidasCat.productos as any[]).map((p: any) => p.id) : [];
    const hasBebida = items.some(i => bebidasIds.includes(i.productoId));
    if (!hasBebida) {
      upselling = "¿Deseas agregar una bebida? Tenemos jugos, limonadas y malteadas 🥤";
    }
  }

  return {
    items: mergeParsedItems(items),
    upselling
  };
}
