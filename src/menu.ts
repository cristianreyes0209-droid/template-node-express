export type MenuProduct = {
  id: string;
  nombre: string;
  precio: number;
  aliases: string[];
  tipo?: string;
  ingredientes?: string[];
  modificadoresComunes?: string[];
  extrasDisponibles?: string[];
  variantes?: {
    id: string;
    nombre: string;
    precio: number;
    aliases: string[];
  }[];
};
export const menu = {
  categorias: [
    {
      id: "extras",
      nombre: "Extras",
      productos: [
        {
          id: "extra_carne",
          nombre: "Carne desmechada",
          precio: 7500,
          tipo: "proteina",
          aliases: ["carne", "extra carne", "carne desmechada", "más carne", "mas carne"]
        },
        {
          id: "extra_pollo",
          nombre: "Pollo desmechado",
          precio: 7000,
          tipo: "proteina",
          aliases: ["pollo", "extra pollo", "más pollo", "mas pollo"]
        },
        {
          id: "tocineta",
          nombre: "Tocineta",
          precio: 5500,
          tipo: "proteina",
          aliases: ["tocineta", "extra tocineta"]
        },
        {
          id: "extra_pepperoni",
          nombre: "Pepperoni",
          precio: 5000,
          tipo: "proteina",
          aliases: ["pepperoni", "extra pepperoni"]
        },
        {
          id: "extra_salami",
          nombre: "Salami",
          precio: 5000,
          tipo: "proteina",
          aliases: ["salami", "extra salami"]
        },
        {
          id: "extra_jamon",
          nombre: "Jamón",
          precio: 5000,
          tipo: "proteina",
          aliases: ["jamon", "jamón", "extra jamon"]
        },
        {
          id: "extra_ranchera",
          nombre: "Salchicha ranchera",
          precio: 5500,
          tipo: "proteina",
          aliases: ["ranchera", "salchicha ranchera", "extra ranchera"]
        },
        {
          id: "extra_chile_con_carne",
          nombre: "Chile con carne",
          precio: 5500,
          tipo: "proteina",
          aliases: ["chile con carne", "extra chile", "frijol", "frijoles", "extra frijoles"]
        },
        {
          id: "extra_queso",
          nombre: "Queso doble crema",
          precio: 5000,
          tipo: "queso",
          aliases: ["queso", "extra queso", "doble crema"]
        },
        {
          id: "extra_queso_americano",
          nombre: "Queso americano",
          precio: 5000,
          tipo: "queso",
          aliases: ["americano", "queso americano"]
        },
        {
          id: "extra_queso_cuajada",
          nombre: "Queso cuajada",
          precio: 4500,
          tipo: "queso",
          aliases: ["cuajada", "queso cuajada"]
        },
        {
          id: "extra_parmesano",
          nombre: "Parmesano",
          precio: 5000,
          tipo: "queso",
          aliases: ["parmesano"]
        },
        {
          id: "extra_cheddar",
          nombre: "Salsa cheddar",
          precio: 5000,
          tipo: "queso",
          aliases: ["cheddar", "salsa cheddar"]
        },
        {
          id: "extra_champinones",
          nombre: "Champiñones",
          precio: 4500,
          tipo: "vegetal",
          aliases: ["champiñones", "champinones", "champiñon"]
        },
        {
          id: "extra_maiz",
          nombre: "Maíz tierno",
          precio: 3500,
          tipo: "vegetal",
          aliases: ["maiz", "maíz"]
        },
        {
          id: "pico_de_gallo",
          nombre: "Pico de gallo",
          precio: 2000,
          tipo: "vegetal",
          aliases: ["pico de gallo"]
        },
        {
          id: "jalapenos",
          nombre: "Jalapeños",
          precio: 2000,
          tipo: "vegetal",
          aliases: ["jalapeños", "jalapenos"]
        },
        {
          id: "extra_fresa",
          nombre: "Fresa",
          precio: 3000,
          tipo: "fruta",
          aliases: ["fresa"]
        },
        {
          id: "extra_banano",
          nombre: "Banano",
          precio: 2000,
          tipo: "fruta",
          aliases: ["banano", "bananos", "banana", "bananas"]
        },
        {
          id: "extra_durazno",
          nombre: "Durazno",
          precio: 3900,
          tipo: "fruta",
          aliases: ["durazno"]
        },
        {
          id: "extra_manzana",
          nombre: "Manzana",
          precio: 2500,
          tipo: "fruta",
          aliases: ["manzana"]
        },
        {
          id: "extra_pina",
          nombre: "Piña",
          precio: 2000,
          tipo: "fruta",
          aliases: ["piña", "pina"]
        },
        {
          id: "extra_nutella",
          nombre: "Nutella",
          precio: 6900,
          tipo: "dulce",
          aliases: ["nutella"]
        },
        {
          id: "extra_chocolate",
          nombre: "Chocolate",
          precio: 3500,
          tipo: "dulce",
          aliases: ["chocolate"]
        },
        {
          id: "extra_arequipe",
          nombre: "Arequipe",
          precio: 3000,
          tipo: "dulce",
          aliases: ["arequipe"]
        },
        {
          id: "extra_crema_mani",
          nombre: "Crema de maní",
          precio: 4500,
          tipo: "dulce",
          aliases: ["crema de mani", "crema de maní"]
        },
        {
          id: "helado_1_bola",
          nombre: "Helado 1 bola",
          precio: 5500,
          tipo: "helado",
          aliases: ["1 bola", "una bola", "bola de helado"]
        },
        {
          id: "helado_2_bolas",
          nombre: "Helado 2 bolas",
          precio: 8000,
          tipo: "helado",
          aliases: ["2 bolas", "dos bolas"]
        }
      ]
    },
    {
      id: "nuestras_favoritas",
      nombre: "Nuestras favoritas",
      productos: [
        {
          id: "crepe_de_paris",
          nombre: "Crepe de Paris",
          precio: 29500,
          ingredientes: [
            "Pollo desmechado",
            "Carne desmechada",
            "Champiñones",
            "Jamón premium",
            "Queso doble crema",
            "Salsa paris (bechamel)",
            "Maíz",
            "Salchicha ranchera"
          ],
          aliases: [
            "paris",
            "pari",
            "la paris",
            "una paris",
            "crepe paris",
            "crepa de paris",
            "crepe de pari",
            "crepe de paris"
          ],
          modificadoresComunes: [
            "sin queso",
            "sin carne",
            "con mas pollo",
            "sin champiñon",
            "sin champiñones",
            "sin salsa",
            "sin maiz",
            "sin maíz",
            "sin ranchera",
            "sin pollo",
            "sin jamon",
            "sin jamón",
            "cambiar carne por tocineta",
            "cambiar carne por mas pollo",
            "cambiar pollo por tocineta",
            "cambiar ranchera por tocineta"
          ],
          extrasDisponibles: [
            "extra_pollo",
            "extra_queso",
            "extra_ranchera",
            "extra_maiz",
              "extra_pepperoni",
            "extra_salami",
            "tocineta",
            "extra_champinones",
            "extra_jamon",
            "extra_pina",
            "jalapenos"
          ]
        },
        {
          id: "desgranada_mixta",
          nombre: "Desgranada mixta",
          precio: 27500,
          ingredientes: [
            "Res salteada",
            "Pollo salteado",
            "Maíz tierno",
            "Lechuga",
            "Tocineta",
            "Queso cuajada",
            "Queso doble crema",
            "Fosforitos",
            "Huevos de codorniz",
            "Salsa de ajo"
          ],
          variantes: [
            {
              id: "mixta",
              nombre: "Mixta",
              precio: 27500,
              aliases: ["mixta", "mixto", "mixtos", "pollo y carne", "carne y pollo", "mixta pollo y carne"]
            },
            {
              id: "solo_pollo",
              nombre: "Solo Pollo",
              precio: 27500,
              aliases: ["solo pollo", "con pollo", "de pollo"]
            },
            {
              id: "solo_carne",
              nombre: "Solo Carne",
              precio: 27500,
              aliases: ["solo carne", "con carne", "de carne"]
            }
          ],
          aliases: [
            "desgranada",
            "degranada",
            "desgranada mixta",
            "desgranado mixto",
            "desgranados mixtos",
            "desgranado",
            "desgranados"
          ],
          modificadoresComunes: [
            "solo pollo",
            "solo carne",
            "sin tocineta",
            "sin maiz",
            "sin maíz",
            "sin queso doble crema",
            "sin queso cuajada",
            "sin lechuga",
            "sin salsa",
            "sin fosforitos",
            "sin huevos",
            "sin quesos"
          ],
          extrasDisponibles: [
            "extra_pina",
            "pico_de_gallo",
              "extra_pepperoni",
            "extra_salami",
            "jalapenos",
            "extra_queso",
            "extra_queso_cuajada"
          ]
        },
   {
          id: "mexicana",
          nombre: "Mexicana",
          precio: 27900,
          ingredientes: [
            "Carne desmechada",
            "Frijol",
            "Chile con carne",
            "Pico de gallo",
            "Nachos",
            "Queso doble crema"
          ],
          aliases: [
            "mexicana",
            "crepe mexicana",
            "mejicana",
            "meicana"
          ],
          modificadoresComunes: [
            "sin jalapeños",
            "sin jalapenos",
            "con jalapeños",
            "con jalapenos",
            "sin queso",
            "sin pico de gallo",
            "sin chile con carne",
            "con pollo en lugar de carne"
          ],
          extrasDisponibles: [
            "extra_maiz",
            "extra_pepperoni",
            "extra_salami",
            "extra_pollo",
            "extra_carne",
            "extra_chile_con_carne",
            "extra_queso"
      ]
        }
      ]
    },
    {
  id: "clasicas",
  nombre: "Crepes Clásicas",
  productos: [
    {
      id: "especial",
      nombre: "Especial",
      precio: 26500,
      ingredientes: [
        "Pollo desmechado",
        "Carne desmechada",
        "Champiñones",
        "Jamón premium",
        "Queso doble crema",
        "Salsa paris (bechamel)"
      ],
      aliases: [
        "especial",
        "crepe especial"
      ],
      modificadoresComunes: [
        "sin pollo",
        "sin carne",
        "sin champiñones",
        "sin jamon",
        "sin jamón",
        "sin queso",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_pollo",
        "extra_carne",
        "extra_champinones",
        "extra_jamon",
        "extra_queso",
        "jalapenos"
      ]
    },
    {
      id: "vegetales_mixta",
      nombre: "Vegetales Mixta",
      precio: 24500,
      aliases: [
        "vegetales",
        "vegetal",
        "vegetales mixta",
        "crepe vegetales",
        "mixta vegetales"
      ],
      ingredientes: [
        "Carne desmechada y/o pollo desmechado",
        "Champiñones",
        "Pico de gallo",
        "Maíz",
        "Salsa paris (bechamel)"
      ],
      variantes: [
        {
          id: "mixta",
          nombre: "Mixta",
          precio: 24500,
          aliases: ["mixta", "pollo y carne", "carne y pollo", "mixta pollo y carne"]
        },
        {
          id: "solo_pollo",
          nombre: "Solo Pollo",
          precio: 21000,
          aliases: ["solo pollo", "con pollo", "de pollo"]
        },
        {
          id: "solo_carne",
          nombre: "Solo Carne",
          precio: 24500,
          aliases: ["solo carne", "con carne", "de carne"]
        }
      ],
      modificadoresComunes: [
        "sin champiñones",
        "sin pico de gallo",
        "sin maiz",
        "sin maíz",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_pollo",
        "extra_carne",
        "extra_queso",
        "extra_champinones",
        "extra_maiz",
        "jalapenos"
      ]
    },
    {
      id: "ranchera_mixta",
      nombre: "Ranchera Mixta",
      precio: 24500,
      aliases: [
        "ranchera mixta",
        "ranchera",
        "ranchera de carne",
        "ranchera carne",
        "ranchera con carne",
        "ranchera de pollo",
        "ranchera pollo",
        "ranchera con pollo",
        "crepe ranchera mixta"
      ],
      ingredientes: [
        "Carne desmechada y/o pollo desmechado",
        "Maíz",
        "Jamón premium",
        "Salsa paris (bechamel)",
        "Queso doble crema"
      ],
      variantes: [
        {
          id: "mixta",
          nombre: "Mixta",
          precio: 24500,
          aliases: ["mixta", "pollo y carne", "carne y pollo"]
        },
        {
          id: "solo_pollo",
          nombre: "Solo pollo",
          precio: 21000,
          aliases: ["solo pollo", "con pollo", "de pollo", "pollo"]
        },
        {
          id: "solo_carne",
          nombre: "Solo carne",
          precio: 24500,
          aliases: ["solo carne", "con carne", "de carne", "carne"]
        }
      ],
      modificadoresComunes: [
        "sin maiz",
        "sin maíz",
        "sin jamon",
        "sin jamón",
        "sin queso",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_pollo",
        "extra_carne",
        "extra_queso",
        "extra_maiz",
        "extra_jamon",
        "jalapenos"
      ]
    },
    {
      id: "bolognesa",
      nombre: "Bolognesa",
      precio: 26500,
      ingredientes: [
        "Albóndigas mixtas de res y cerdo",
        "Salsa boloñesa",
        "Queso parmesano",
        "Queso doble crema"
      ],
      aliases: [
        "bolognesa",
        "crepe bolognesa"
      ],
      modificadoresComunes: [
        "sin queso",
        "sin parmesano",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_parmesano",
        "extra_queso"
      ]
    },
    {
      id: "pollo_champinon",
      nombre: "Pollo Champiñón",
      precio: 16500,
      ingredientes: [
        "Pollo desmechado",
        "Champiñones",
        "Queso doble crema",
        "Salsa paris (bechamel)"
      ],
      aliases: [
        "pollo champiñon",
        "pollo champinon",
        "pollo champiñones",
        "pollo champinones",
        "pollo y champiñones",
        "pollo y champinones",
        "pollo con champiñones",
        "pollo con champinon",
        "pollo con champinones",
        "crepe pollo champiñon",
        "crepe de pollo y champiñones",
        "crepe pollo champiñones"
      ],
      modificadoresComunes: [
        "sin pollo",
        "sin champiñones",
        "sin queso",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_pollo",
        "extra_champinones",
        "extra_queso"
      ]
    },
    {
      id: "pollo_y_pina",
      nombre: "Pollo y Piña",
      precio: 15500,
      ingredientes: [
        "Pollo desmechado",
        "Piña calada",
        "Queso doble crema",
        "Salsa paris (bechamel)"
      ],
      aliases: [
        "pollo y piña",
        "pollo y pina",
        "pollo piña",
        "pollo pina",
        "piña pollo",
        "pina pollo",
        "crepe pollo y piña",
        "crepe pollo piña",
        "crepe piña pollo",
        "crepe pina pollo"
      ],
      modificadoresComunes: [
        "sin pollo",
        "sin piña",
        "sin pina",
        "sin queso",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_pollo",
        "extra_pina",
        "extra_queso"
      ]
    },
    {
      id: "pollo_y_carne",
      nombre: "Pollo y Carne",
      precio: 17000,
      ingredientes: [
        "Pollo desmechado",
        "Carne desmechada",
        "Queso doble crema",
        "Salsa paris (bechamel)"
      ],
      aliases: [
        "pollo y carne",
        "pollo carne",
        "carne pollo",
        "carne y pollo",
        "pollo con carne",
        "carne con pollo",
        "crepe pollo y carne",
        "crepe carne y pollo",
        "crepe pollo carne"
      ],
      modificadoresComunes: [
        "sin pollo",
        "sin carne",
        "sin queso",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_pollo",
        "extra_carne",
        "extra_queso"
      ]
    },
    {
      id: "pollo",
      nombre: "Pollo",
      precio: 14500,
      ingredientes: [
        "Pollo desmechado",
        "Queso doble crema",
        "Salsa paris (bechamel)"
      ],
      aliases: [
        "pollo",
        "crepe pollo"
      ],
      modificadoresComunes: [
        "sin pollo",
        "sin queso",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_pollo",
        "extra_queso"
      ]
    },
    {
      id: "carne",
      nombre: "Carne",
      precio: 17000,
      ingredientes: [
        "Carne desmechada",
        "Queso doble crema",
        "Salsa paris (bechamel)"
      ],
      aliases: [
        "carne",
        "crepe carne",
        "res",
        "de res",
        "crepe de res",
        "crepe res"
      ],
      modificadoresComunes: [
        "sin carne",
        "sin queso",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_carne",
        "extra_queso",
        "extra_pina"
      ]
    },
    {
      id: "hawaiana",
      nombre: "Hawaiana",
      precio: 14000,
      ingredientes: [
        "Jamón premium",
        "Piña calada",
        "Queso doble crema"
      ],
      aliases: [
        "hawaiana",
        "hawaina",
        "crepe hawaiana"
      ],
      modificadoresComunes: [
        "sin jamon",
        "sin jamón",
        "sin piña",
        "sin pina",
        "sin queso"
      ],
      extrasDisponibles: [
        "extra_jamon",
        "extra_pina",
        "extra_queso"
      ]
    },
    {
      id: "ranchera",
      nombre: "Ranchera",
      precio: 14500,
      ingredientes: [
        "Salchicha ranchera",
        "Maíz tierno",
        "Queso doble crema",
        "Salsa cheddar"
      ],
      aliases: [
        "ranchera",
        "crepe ranchera"
      ],
      modificadoresComunes: [
        "sin ranchera",
        "sin maiz",
        "sin maíz",
        "sin queso",
        "sin cheddar"
      ],
      extrasDisponibles: [
        "extra_ranchera",
        "extra_maiz",
        "extra_queso",
        "extra_cheddar"
     ]
        }
      ]
    },
    {
      id: "fast_food",
      nombre: "Fast Food",
      productos: [
    {
      id: "costillas_bbq",
      nombre: "Costillas BBQ",
      precio: 28500,
      ingredientes: [
        "Costillas de cerdo",
        "Salsa BBQ artesanal",
        "Maíz",
        "Lechuga",
        "Aguacate",
        "Tomate",
        "Queso doble crema"
      ],
      aliases: [
        "costillas bbq",
        "costillas",
        "crepe costillas bbq",
        "costilla bbq"
      ],
      modificadoresComunes: [
        "sin maiz",
        "sin maíz",
        "sin lechuga",
        "sin aguacate",
        "sin tomate",
        "sin queso",
        "sin queso doble crema",
        "sin salsa bbq",
        "sin bbq",
        "con mas carne",
        "con más carne"
      ],
      extrasDisponibles: [
        "extra_queso",
        "extra_maiz",
        "tocineta",
        "extra_champinones",
        "extra_jamon",
        "extra_pina",
        "jalapenos"
      ]
    },
    {
      id: "americana",
      nombre: "Americana",
      precio: 19900,
      ingredientes: [
        "Salchicha perro",
        "Queso cuajada",
        "Huevos de codorniz",
        "Trocitos de piña calada",
        "Fosforitos",
        "Queso doble crema"
      ],
      aliases: [
        "americana",
        "crepe americana"
      ],
      modificadoresComunes: [
        "sin salchicha",
        "sin queso",
        "sin queso cuajada",
        "sin queso doble crema",
        "sin huevos de codorniz",
        "sin huevos",
        "sin pina",
        "sin piña",
        "sin fosforitos",
        "con mas queso",
        "con más queso"
      ],
      extrasDisponibles: [
        "extra_queso",
        "extra_ranchera",
        "extra_maiz",
        "extra_champinones",
        "extra_jamon",
        "extra_pina",
        "jalapenos",
        "tocineta"
      ]
    },
    {
      id: "crepe_burguesa",
      nombre: "Crepe Burguesa",
      precio: 24500,
      ingredientes: [
        "180 grs. de lomo de res madurado",
        "Queso americano",
        "Queso doble crema",
        "Tocineta",
        "Cebolla salteada",
        "Tomate",
        "Lechuga"
      ],
      aliases: [
        "burguesa",
        "crepe burguesa",
        "hamburguesa crepe"
      ],
      modificadoresComunes: [
        "sin queso",
        "sin queso americano",
        "sin queso doble crema",
        "sin tocineta",
        "sin cebolla",
        "sin cebolla salteada",
        "sin tomate",
        "sin lechuga",
        "sin vegetales",
        "con mas carne",
        "con más carne"
      ],
      extrasDisponibles: [
        "extra_queso",
        "tocineta",
        "extra_champinones",
        "extra_jamon",
        "extra_pina",
        "jalapenos",
        "extra_pepperoni",
        "extra_salami"
      ]
    },
 {
      id: "italiana",
      nombre: "Italiana",
      precio: 23500,
      ingredientes: [
        "Pepperoni",
        "Salami",
        "Tomate",
        "Queso parmesano",
        "Salsa italiana"
      ],
      aliases: [
        "italiana",
        "crepe italiana"
      ],
      modificadoresComunes: [
        "sin pepperoni",
        "sin salami",
        "sin tomate",
        "sin queso",
        "sin queso parmesano",
        "sin parmesano",
        "sin salsa italiana",
        "sin salsa",
        "con mas pepperoni",
        "con más pepperoni",
        "con mas salami",
        "con más salami"
      ],
    extrasDisponibles: [
        "extra_pepperoni",
        "extra_salami",
        "extra_parmesano",
        "tocineta",
        "extra_champinones",
        "extra_jamon",
        "extra_pina",
        "jalapenos"
     ]
        }
      ]
    },
  {
      id: "gourmet",
      nombre: "Crepes Gourmet",
      productos: [
        {
          id: "strogonoff_pollo",
          nombre: "Strogonoff de pollo",
          precio: 29900,
          ingredientes: [
            "Pechuga de pollo",
            "Champiñones",
            "Salsa strogonoff",
            "Vino blanco",
            "Queso doble crema"
          ],
        aliases: [
  "strogonoff de pollo",
  "stroganoff de pollo",
  "stroganoff de pollo",
  "strogsanoff de pollo",
  "strogonoff pollo",
  "stroganoff pollo"
 ],
          modificadoresComunes: [
            "sin pollo",
            "sin champiñones",
            "sin queso",
            "sin salsa"
          ],
          extrasDisponibles: [
            "extra_pollo",
            "extra_champinones",
            "extra_queso"
          ]
        },
        {
          id: "strogonoff_carne",
          nombre: "Strogonoff de carne",
          precio: 34500,
          ingredientes: [
            "Lomo de res",
            "Champiñones",
            "Salsa strogonoff",
            "Vino blanco",
            "Queso doble crema"
          ],
          aliases: [
            "strogonoff de carne",
            "strogonoff carne",
            "strogonoff res",
            "carne strogonoff",
            "estrogonof de carne",
            "estrogonoff de carne",
            "stroganoff de carne",
            "stroganoff carne",
            "stroganoff res"
          ],
          modificadoresComunes: [
            "sin carne",
            "sin champiñones",
            "sin queso",
            "sin salsa"
          ],
          extrasDisponibles: [
            "extra_carne",
            "extra_champinones",
            "extra_queso"
          ]
        },
        {
          id: "crepe_mignon",
          nombre: "Crepe Mignon",
          precio: 36500,
          ingredientes: [
            "Lomo de res",
            "Tocineta",
            "Champiñones",
            "Salsa con vino tinto",
            "Queso doble crema"
          ],
          aliases: [
            "mignon",
            "crepe mignon"
          ],
          modificadoresComunes: [
            "sin carne",
            "sin tocineta",
            "sin champiñones",
            "sin queso",
            "sin salsa"
          ],
          extrasDisponibles: [
            "extra_carne",
            "tocineta",
            "extra_champinones",
            "extra_queso"
          ]
        },
        {
          id: "marinera",
          nombre: "Marinera",
          precio: 37500,
          ingredientes: [
            "Mariscos",
            "Salsa marinera",
            "Queso doble crema"
          ],
          aliases: [
            "marinera",
            "crepe marinera",
            "de marinera",
            "mariscos marinera"
          ],
          modificadoresComunes: [
            "sin queso",
            "sin salsa"
          ],
          extrasDisponibles: [
            "extra_queso",
            "extra_parmesano",
            "extra_champinones",
            "jalapenos"
          ]
        },
        {
id: "camarones_gourmet",
nombre: "Camarones Gourmet",
precio: 35500,
ingredientes: [
  "Camarones",
  "Salsa marinera",
  "Queso doble crema"
],
aliases: [
  "camaron gourmet",
  "camarones gourmet",
  "camarones marinera",
  "camarones en salsa",
  "crepe de camaron gourmet",
  "crepe de camarones gourmet",
  "de camaron gourmet",
  "de camarones gourmet",
  "de camarones marinera"
],
modificadoresComunes: [
  "sin queso",
  "sin salsa"
],
extrasDisponibles: [
  "extra_queso",
  "extra_parmesano",
  "extra_champinones",
  "jalapenos"
]
        }
      ]
    },
    {
      id: "del_mar",
      nombre: "Crepes del mar",
      productos: [
        {
id: "mediterranea_camarones",
nombre: "Mediterránea de camarones",
precio: 33500,
ingredientes: [
  "Camarones tigre",
  "Ajo",
  "Pimentón",
  "Finas hierbas",
  "Queso doble crema",
  "Queso parmesano"
],
aliases: [
  "mediterranea",
  "mediterranea de camaron",
  "mediterranea de camarones",
  "mediterranea camaron",
  "mediterranea camarones",
  "crepe mediterranea de camaron",
  "crepe mediterranea de camarones",
  "mediteranea de camaron",
  "mediteranea de camarones",
  "medterranea de camaron",
  "medterranea de camarones"
],
          modificadoresComunes: [
            "sin queso",
            "sin parmesano",
            "sin pimenton",
            "sin pimentón"
          ],
          extrasDisponibles: [
            "extra_queso",
            "extra_parmesano",
            "extra_champinones",
            "extra_jamon",
            "extra_pina",
            "jalapenos"
          ]
        },
        {
       id: "mediterranea_mariscos",
nombre: "Mediterránea de mariscos",
precio: 35500,
ingredientes: [
  "Mariscos",
  "Ajo",
  "Pimentón",
  "Finas hierbas",
  "Queso doble crema",
  "Queso parmesano"
],
aliases: [
  "mediterranea de mariscos",
  "mediterranea mariscos",
  "crepe mediterranea de mariscos",
  "mediteranea de mariscos",
  "medterranea de mariscos"
],
          modificadoresComunes: [
            "sin queso",
            "sin parmesano",
            "sin pimenton",
            "sin pimentón"
          ],
          extrasDisponibles: [
            "extra_queso",
            "extra_parmesano",
            "extra_champinones",
            "extra_jamon",
            "extra_pina",
            "jalapenos"
          ]
        },
        {
          id: "atun",
          nombre: "Atún",
          precio: 23500,
          ingredientes: [
            "Atún",
            "Mayo ajo",
            "Pico de gallo",
            "Lechuga",
            "Queso doble crema"
          ],
          aliases: [
            "atun",
            "atún",
            "crepe atun"
          ],
          modificadoresComunes: [
            "sin queso",
            "sin lechuga",
            "sin pico de gallo",
            "sin salsa"
          ],
          extrasDisponibles: [
            "extra_queso",
            "extra_maiz",
            "extra_champinones",
            "jalapenos"
          ]
        }
      ]
    },
    {
      id: "entradas",
      nombre: "Entradas",
      productos: [
        {
          id: "super_nachos",
          nombre: "Super Nachos",
          precio: 32500,
          aliases: ["super nachos", "supernachos", "supernacho", "nachos especiales"]
        },
        {
          id: "nachos_paris",
          nombre: "Nachos París",
          precio: 27000,
          aliases: ["nachos paris", "nachos de paris"]
        },
        {
          id: "nachos_cheddar",
          nombre: "Nachos con Cheddar",
          precio: 18000,
          ingredientes: ["Nachos", "Queso cheddar (incluido)"],
          notas: "El queso cheddar ya está incluido en el precio. No cobrar cheddar como extra.",
          aliases: ["nachos cheddar", "nachos con queso", "nachos con cheddar"]
        }
      ]
    },
    {
      id: "vegetarianas",
      nombre: "Vegetarianas",
      productos: [
        {
          id: "strogonoff_veggie",
          nombre: "Strogonoff Veggie",
          precio: 36500,
          ingredientes: [
            "Albóndigas de soya y huevo",
            "Champiñones",
            "Salsa strogonoff",
            "Vino blanco"
          ],
          aliases: ["strogonoff veggie", "veggie", "stroganoff veggie"]
        },
        {
          id: "vegetariana",
          nombre: "Vegetariana",
          precio: 13900,
          aliases: ["vegetariana", "crepe vegetariana"],
          variantes: [
            {
              id: "sin_salsa",
              nombre: "Sin salsa",
              precio: 13900,
              aliases: ["sin salsa"]
            },
            {
              id: "con_salsa_italiana",
              nombre: "Italiana",
              precio: 14500,
              aliases: ["con salsa italiana", "con italiana", "salsa italiana", "italiana"]
            },
            {
              id: "con_salsa_bechamel",
              nombre: "Bechamel",
              precio: 13900,
              aliases: ["con salsa bechamel", "con bechamel", "salsa bechamel", "bechamel"]
            }
          ]
        },
        {
          id: "burguessa_veggie",
          nombre: "Burguessa Veggie",
          precio: 25500,
          ingredientes: [
            "Proteína de soya y huevo",
            "Tomate",
            "Dos quesos",
            "Lechuga",
            "Cebolla salteada"
          ],
          aliases: ["burguessa veggie", "burgesa veggie", "veggie burger"]
        }
      ]
    },
    {
      id: "con_frutas",
      nombre: "Con Frutas",
      productos: [
        {
          id: "tropinutella",
          nombre: "Tropinutella",
          precio: 19900,
          ingredientes: [
            "Nutella",
            "Durazno",
            "Fresa",
            "Banano",
            "Manzana",
            "Queso cuajada",
            "Queso doble crema",
            "Crema de leche"
          ],
          aliases: ["tropinutella", "tropi nutella"]
        },
        {
          id: "tropical",
          nombre: "Tropical",
          precio: 16900,
          ingredientes: [
            "Durazno",
            "Fresa",
            "Banano",
            "Manzana",
            "Queso cuajada",
            "Queso doble crema",
            "Crema de leche"
          ],
          aliases: ["tropical", "crepe tropical"]
        },
        {
          id: "crepostre",
          nombre: "Crepostre",
          precio: 9500,
          ingredientes: ["Nutella", "Fresa", "Durazno"],
          aliases: ["crepostre", "cre postre"]
        }
      ]
    },
    {
      id: "dulces",
      nombre: "Dulces",
      productos: [
        {
          id: "nutella_crepe",
          nombre: "Nutella",
          precio: 11500,
          aliases: ["nutella", "crepe nutella", "de nutella"]
        },
        {
          id: "chocolate_crepe",
          nombre: "Chocolate",
          precio: 10500,
          aliases: ["chocolate", "crepe chocolate", "de chocolate"]
        },
        {
          id: "arequipe_crepe",
          nombre: "Arequipe",
          precio: 10500,
          aliases: ["arequipe", "crepe arequipe", "de arequipe"]
        },
        {
          id: "crepe_oblea",
          nombre: "Crepe Oblea",
          precio: 11900,
          ingredientes: [
            "Arequipe",
            "Queso cuajada",
            "Salsa de mora",
            "Crema de leche"
          ],
          aliases: ["oblea", "crepe oblea"]
        }
      ]
    },
    {
      id: "bebidas",
      nombre: "Bebidas",
      productos: [
        {
          id: "jugo_mora",
          nombre: "Jugo de Mora",
          precio: 9900,
          tipo: "jugo",
          aliases: ["mora", "jugo mora", "jugo de mora", "jugo", "jugo natural"],
          variantes: [
            { id: "agua", nombre: "En agua", precio: 9900, aliases: ["en agua", "agua"] },
            { id: "leche", nombre: "En leche", precio: 11500, aliases: ["en leche", "leche"] }
          ]
        },
        {
          id: "jugo_lulo",
          nombre: "Jugo de Lulo",
          precio: 9900,
          tipo: "jugo",
          aliases: ["lulo", "jugo lulo", "jugo de lulo", "jugo", "jugo natural"],
          variantes: [
            { id: "agua", nombre: "En agua", precio: 9900, aliases: ["en agua", "agua"] },
            { id: "leche", nombre: "En leche", precio: 11500, aliases: ["en leche", "leche"] }
          ]
        },
        {
          id: "jugo_guanabana",
          nombre: "Jugo de Guanábana",
          precio: 9900,
          tipo: "jugo",
          aliases: ["guanabana", "guanábana", "jugo guanabana", "jugo", "jugo natural"],
          variantes: [
            { id: "agua", nombre: "En agua", precio: 9900, aliases: ["en agua", "agua"] },
            { id: "leche", nombre: "En leche", precio: 11500, aliases: ["en leche", "leche"] }
          ]
        },
        {
          id: "jugo_maracuya",
          nombre: "Jugo de Maracuyá",
          precio: 9900,
          tipo: "jugo",
          aliases: ["maracuya", "maracuyá", "jugo maracuya", "jugo", "jugo natural"],
          variantes: [
            { id: "agua", nombre: "En agua", precio: 9900, aliases: ["en agua", "agua"] },
            { id: "leche", nombre: "En leche", precio: 11500, aliases: ["en leche", "leche"] }
          ]
        },
        {
          id: "jugo_fresa",
          nombre: "Jugo de Fresa",
          precio: 9900,
          tipo: "jugo",
          aliases: ["fresa", "jugo fresa", "jugo de fresa", "jugo", "jugo natural"],
          variantes: [
            { id: "agua", nombre: "En agua", precio: 9900, aliases: ["en agua", "agua"] },
            { id: "leche", nombre: "En leche", precio: 11500, aliases: ["en leche", "leche"] }
          ]
        },
        {
          id: "jugo_mango",
          nombre: "Jugo de Mango",
          precio: 9900,
          tipo: "jugo",
          aliases: ["mango", "jugo mango", "jugo de mango", "jugo", "jugo natural"],
          variantes: [
            { id: "agua", nombre: "En agua", precio: 9900, aliases: ["en agua", "agua"] },
            { id: "leche", nombre: "En leche", precio: 11500, aliases: ["en leche", "leche"] }
          ]
        },
        {
          id: "batido_frutas",
          nombre: "Batido de frutas",
          precio: 11500,
          aliases: ["batido", "batido de frutas"]
        },
        {
          id: "limonada",
          nombre: "Limonada",
          precio: 5000,
          aliases: ["limonada"],
          variantes: [
            { id: "natural", nombre: "Natural", precio: 5000, aliases: ["natural", "limonada natural", "limonada"] },
            { id: "coco", nombre: "De coco", precio: 10500, aliases: ["de coco", "coco", "limonada de coco", "limonada coco"] },
            { id: "cereza", nombre: "Cerezada", precio: 12500, aliases: ["de cereza", "cereza", "cerezada", "cerezadas", "limonada de cereza", "limonada cereza", "limonada cerezada", "limonada cerezadas"] }
          ]
        },
        {
          id: "malteada",
          nombre: "Malteada",
          precio: 17900,
          aliases: ["malteada"],
          variantes: [
            { id: "vainilla_brownie", nombre: "Brownie", precio: 17900, aliases: ["vainilla brownie", "brownie vainilla", "brownie", "vainilla brownie"] },
            { id: "vainilla", nombre: "Vainilla", precio: 17900, aliases: ["vainilla"] },
            { id: "fresa", nombre: "Fresa", precio: 17900, aliases: ["fresa"] }
          ]
        },
        {
          id: "agua",
          nombre: "Agua",
          precio: 3900,
          aliases: ["agua", "agua embotellada"]
        },
        {
          id: "coca_cola",
          nombre: "Coca Cola",
          precio: 5900,
          aliases: ["coca cola", "cocacola"]
        },
        {
          id: "gaseosa",
          nombre: "Gaseosa",
          precio: 5900,
          aliases: ["gaseosa"]
        },
        {
          id: "te_hatsu",
          nombre: "Te Hatsu",
          precio: 9900,
          aliases: ["te hatsu", "hatsu"]
        }
      ]
    },
    {
      id: "crepe_salada",
      nombre: "Crepe Salada",
      productos: [
        {
          id: "crepe_salada_clasica",
          nombre: "Crepe con masa clásica",
          precio: 11500,
          aliases: ["crepe salada", "arma tu crepe", "crepe clasica"],
          extrasDisponibles: [
            "extra_carne", "extra_pollo", "tocineta", "extra_pepperoni",
            "extra_salami", "extra_jamon", "extra_ranchera", "extra_chile_con_carne",
            "extra_queso", "extra_queso_americano", "extra_queso_cuajada",
            "extra_parmesano", "extra_cheddar", "extra_champinones", "extra_maiz",
            "pico_de_gallo", "jalapenos", "extra_fresa", "extra_banano",
            "extra_durazno", "extra_manzana", "extra_pina", "extra_nutella",
            "extra_chocolate", "extra_arequipe", "extra_crema_mani",
            "helado_1_bola", "helado_2_bolas"
          ]
        }
      ]
    }
  ]
};
