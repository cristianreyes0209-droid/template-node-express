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
          aliases: ["chile con carne", "extra chile"]
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
          aliases: ["banano"]
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
          aliases: [
            "desgranada",
            "degranada",
            "desgranada mixta"
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
          aliases: ["mixta", "pollo y carne", "carne y pollo"]
        },
        {
          id: "solo_pollo",
          nombre: "Solo pollo",
          precio: 21000,
          aliases: ["solo pollo", "con pollo", "de pollo"]
        },
        {
          id: "solo_carne",
          nombre: "Solo carne",
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
          aliases: ["solo pollo", "con pollo", "de pollo"]
        },
        {
          id: "solo_carne",
          nombre: "Solo carne",
          precio: 24500,
          aliases: ["solo carne", "con carne", "de carne"]
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
        "crepe pollo champiñon"
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
  id: "vegetales_mixta",
  nombre: "Vegetales Mixta",
  precio: 24500,
  aliases: [
    "vegetales",
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
      aliases: ["mixta", "pollo y carne", "carne y pollo"]
    },
    {
      id: "solo_pollo",
      nombre: "Solo pollo",
      precio: 21000,
      aliases: ["solo pollo", "con pollo", "de pollo"]
    },
    {
      id: "solo_carne",
      nombre: "Solo carne",
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
      aliases: ["solo pollo", "con pollo", "de pollo"]
    },
    {
      id: "solo_carne",
      nombre: "Solo carne",
      precio: 24500,
      aliases: ["solo carne", "con carne", "de carne"]
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
        "crepe pollo y piña"
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
        "crepe pollo y carne"
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
        "crepe carne"
      ],
      modificadoresComunes: [
        "sin carne",
        "sin queso",
        "sin salsa"
      ],
      extrasDisponibles: [
        "extra_carne",
        "extra_queso"
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
            "strogonoff pollo",
            "pollo strogonoff",
            "estrogonof de pollo",
            "estrogonoff de pollo"
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
            "carne strogonoff",
            "estrogonof de carne",
            "estrogonoff de carne"
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
nombre: "Camarones",
precio: 35500,
ingredientes: [
  "Camarones",
  "Salsa marinera",
  "Queso doble crema"
],
aliases: [
  "camaron",
  "camarones",
  "camaron gourmet",
  "camarones gourmet",
  "camarones marinera",
  "crepe de camaron",
  "crepe de camarones",
  "crepe de camarones gourmet",
  "de camaron",
  "de camarones",
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
    }
  ]
};
