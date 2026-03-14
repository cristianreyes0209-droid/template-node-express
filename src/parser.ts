import { menu } from "./menu";

export function parseOrder(text: string) {

  const lower = text.toLowerCase();

  const numbers: any = {
    "1":1,"2":2,"3":3,"4":4,"5":5,
    "un":1,"una":1,"uno":1,
    "dos":2,
    "tres":3,
    "cuatro":4,
    "cinco":5
  };

  const items:any = [];

  for (const product of menu.productos) {

    for (const alias of product.aliases) {

      if (lower.includes(alias)) {

        let qty = 1;

        for (const key in numbers) {

          if (lower.includes(key + " " + alias)) {
            qty = numbers[key];
          }

        }

        items.push({
          producto: product.nombre,
          cantidad: qty
        });

      }

    }

  }

  return items;

}
