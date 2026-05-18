# Suite Académica v6 — Parche mapas conceptuales Novak

## Cambios aplicados a esta versión

Se ha añadido un segundo estilo de mapas conceptuales, conservando intacto el radial existente.

### Estilos disponibles

- **Radial** (por defecto, comportamiento sin cambios) — centro → ramas → subnodos.
- **Conceptual (Novak)** — mapa conceptual estilo CmapTools con:
  - 2-5 macroconceptos de nivel 0
  - frases de enlace verbales sobre las flechas ("exige conocer", "se aplica a", "en donde debe constatarse"…)
  - cross-links entre ramas distintas
  - pastilla de frase **compartida** cuando un mismo origen conecta con varios destinos por la misma relación
  - word-wrap automático a 2 líneas (no se trunca con "…" salvo palabra única gigante)

El selector aparece en el panel lateral de la pestaña *Mapas*, encima de la selección de tema.

### Archivos modificados

- **`server.js`** — endpoint `POST /api/map` ahora acepta `style: 'radial' | 'novak'`. Para `novak` envía un prompt distinto a Claude pidiendo `{title, concepts:[{id,text,level}], propositions:[{from,phrase,to}]}` con frases de enlace verbales reales, e incluye validación server-side (descarta proposiciones rotas o reflexivas).
- **`public/index.html`** — 4 cambios localizados:
  1. nuevo selector "Estilo" en el sidebar de mapas (`#sb-m`)
  2. `cfg.mapStyle = 'radial'` por defecto + función `setMapStyle()`
  3. `genMap()` envía el estilo al backend y enruta al render correcto
  4. nueva función `buildNovakSVG()` (≈110 líneas) con layout jerárquico top-down, agrupación por `(origen, frase)` y word-wrap multilínea
  5. `loadFromHistory` no requiere cambios: el SVG ya viene cacheado en la entrada del historial

### Aplicación

Reemplaza los archivos correspondientes en tu instalación y reinicia el servidor (`npm start`). En el panel *Mapas* verás el selector nuevo; el estilo "Radial" se comporta exactamente igual que antes.

### Nota sobre el historial

Las entradas de historial guardadas antes de este parche solo contienen mapas radiales y se siguen pudiendo recargar sin problema. Los nuevos mapas Novak se guardan con metadatos adicionales (`concepts`, `propositions`, `mapStyle: 'novak'`).
