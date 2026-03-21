import { menu } from "./menu";

export function parseOrder(text: string) {
  const lower = text.toLowerCase().trim();

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

  const items: any[] = [];

  // Aplanar productos + aliases y ordenar por alias más largo primero
  const aliasList = menu.productos
    .flatMap((product) =>
      product.aliases.map((alias) => ({
        product,
        alias
      }))
    )
    .sort((a, b) => b.alias.length - a.alias.length);

  const usedProducts = new Set<string>();

  for (const entry of aliasList) {
    const { product, alias } = entry;

    if (usedProducts.has(product.id)) continue;

    if (lower.includes(alias)) {
      let qty = 1;

      for (const key in numbers) {
        if (
          lower.includes(key + " " + alias) ||
          lower.includes(key + " de " + alias) ||
          lower.includes(alias + " " + key)
        ) {
          qty = numbers[key];
          break;
        }
      }

      items.push({
        producto: product.nombre,
        cantidad: qty,
        precio: product.precio
      });

      usedProducts.add(product.id);
    }
  }

  return items;
}
