# Mini Trading Platform + Analizador de Mercados de Predicción

Dos aplicaciones sobre el mismo servidor Node/Express:

| Ruta | Qué es |
|---|---|
| `/index.html` | Plataforma de trading: velas de Binance y tendencia multi-timeframe con EMAs |
| `/predicciones.html` | **Analizador de predicciones**: agrega Polymarket, Robinhood/Kalshi y Manifold y dice qué opción es la más probable de cada evento |

## Arranque

```bash
npm install
npm start            # http://localhost:3000
npm run demo         # datos de ejemplo, sin salida a Internet
npm test             # 32 tests, sin red
```

## Qué hace el analizador

Para cada evento (unas elecciones, una decisión de la Fed, un partido) descarga
lo que cotiza cada plataforma, empareja los mercados equivalentes aunque estén
redactados distinto, y devuelve **una sola respuesta**: qué opción es la más
probable, con qué probabilidad y con cuánta confianza.

### Plataformas

| Fuente | API | Credibilidad |
|---|---|---|
| Polymarket | Gamma API (`gamma-api.polymarket.com`) | 1.0 |
| Robinhood / Kalshi | Kalshi Trade API v2 | 1.0 |
| Manifold | API v0 | 0.35 |

Los contratos de evento de **Robinhood** se listan en la bolsa **Kalshi**:
Robinhood es el bróker, pero el libro de órdenes y el precio son los de Kalshi.
Por eso una sola fuente cubre ambas plataformas. Manifold usa dinero de juego,
así que su cotización cuenta como tercera opinión pero pesa mucho menos.

Añadir una plataforma es escribir un módulo en `src/providers/` que exporte
`meta` y `fetchEvents()` devolviendo eventos en la forma canónica descrita en
`src/providers/base.js`, y registrarlo en `src/providers/index.js`.

### El método, paso a paso

1. **Precio → probabilidad.** Se usa el punto medio del libro `(bid+ask)/2`, no
   el último operado, que puede llevar horas parado. Kalshi cotiza en centavos y
   Polymarket en dólares por contrato: todo se lleva a 0..1. Si una plataforma
   sólo publica la pata "Sí", la pata "No" se deriva por complemento.

2. **Quitar el vig.** Los precios "Sí" de un evento donde sólo puede ganar una
   opción suelen sumar más de 1: ese exceso es el margen del creador de mercado.
   Dividir por la suma devuelve probabilidades que suman 100%. El exceso se
   reporta como `overround` para que se vea de dónde salió.

3. **Emparejar eventos entre plataformas.** Nadie escribe la misma pregunta
   igual ("Presidential Election Winner 2028" vs "Who will win the 2028
   presidential election?"). Se comparan títulos y conjuntos de opciones con
   coeficiente de Dice sobre tokens normalizados (sin acentos, sin stopwords) y
   se exige que las fechas de cierre sean compatibles. Cada plataforma aporta
   como mucho un mercado por grupo.

4. **Consenso ponderado en espacio logit.** La media se calcula sobre
   `log(p/(1-p))`, no sobre `p`: la media aritmética distorsiona los extremos
   (entre 1% y 10% la diferencia real es de casi 10x, no de 9 puntos). El peso
   de cada plataforma es:

   ```
   peso = credibilidad × (0.5 + log(1 + liquidez + 0.25·volumen)) × 1/(1 + 10·spread)
   ```

   Un mercado profundo y con spread estrecho manda sobre uno fino y ancho.

5. **Ranking y veredicto.** Las probabilidades del consenso se vuelven a
   normalizar si el evento es excluyente, se ordenan de mayor a menor y la
   primera es la respuesta. Se acompaña de:
   - **margen** sobre la segunda opción (si es < 5 pts, se avisa de que el
     favorito no es fiable),
   - **confianza** (0..1) a partir de profundidad, número de plataformas y
     acuerdo entre ellas,
   - **divergencia**: cuánto discrepan las plataformas en la opción ganadora,
   - **mejor precio de compra** y el *edge* frente al consenso,
   - **arbitraje**: si comprar todas las opciones del evento cuesta menos de
     100¢ y una de ellas paga 100¢ seguro.

### Límites conocidos

- El emparejamiento por similitud de texto es heurístico: eventos parecidos pero
  con reglas de resolución distintas ("cerrar por encima de X **el 31 de dic**"
  vs "**en algún momento** de diciembre") pueden agruparse por error. Por eso
  cada evento expone sus fuentes con enlace, para verificar la letra pequeña.
- El *edge* y el arbitraje se calculan sobre el mejor precio publicado, sin
  contar comisiones ni el tamaño disponible a ese precio.
- Manifold usa dinero de juego: informa, pero no debe mover una decisión.
- Es análisis de mercado, no una recomendación de inversión.

## API

Todas las rutas aceptan `?demo=1` para responder con datos de ejemplo.

### `GET /api/predictions`

Análisis completo. Parámetros: `q` (búsqueda), `platforms`
(`polymarket,robinhood_kalshi,manifold`), `limit`, `minLiquidity`, `threshold`
(umbral de emparejamiento, 0..1), `fetchLimit`.

```jsonc
{
  "generatedAt": "2026-08-13T05:20:00.000Z",
  "sources": [{ "platform": "polymarket", "ok": true, "events": 60, "elapsedMs": 412 }],
  "counts": { "rawEvents": 180, "analyzedEvents": 25, "crossPlatformEvents": 9 },
  "events": [{
    "title": "Presidential Election Winner 2028",
    "mostLikely": { "label": "Gavin Newsom", "probability": 0.434, "margin": 0.055 },
    "options": [{ "label": "Gavin Newsom", "probability": 0.434, "platformCount": 3,
                  "range": { "min": 0.424, "max": 0.46 }, "divergence": 0.036,
                  "bestPrice": { "platformLabel": "Robinhood / Kalshi", "ask": 0.45, "edge": -0.016 },
                  "platforms": [/* cotización de cada plataforma */] }],
    "confidence": 0.83,
    "verdict": { "text": "\"Gavin Newsom\" es la opción más probable con 43.4% …", "confidenceLabel": "alta" },
    "flags": [], "arbitrage": null, "sources": [/* enlaces a cada mercado */]
  }]
}
```

### `GET /api/predictions/best?q=...`

Respuesta directa: sólo el evento que mejor casa con la búsqueda y su opción
ganadora. Pensado para consumir desde otra app o desde `curl`.

### `GET /api/predictions/sources`

Plataformas soportadas y su credibilidad asignada.

### `GET /api/klines`

Proxy a Binance para el gráfico de trading (sin cambios).

## Configuración

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `DEMO` | — | `DEMO=1` fuerza datos de ejemplo en todas las respuestas |
| `PREDICTIONS_TTL_MS` | `30000` | Caché de los datos de mercado |
| `POLYMARKET_API` / `KALSHI_API` / `MANIFOLD_API` | APIs públicas | Para apuntar a un mirror o a un mock |

Ninguna API necesita clave: se usan sólo endpoints públicos de lectura. Las
respuestas se cachean 30 s y las peticiones simultáneas a la misma clave se
agrupan en una sola llamada, para no chocar con los rate limits.

## Estructura

```
server.js              rutas HTTP
src/
  api.js               orquestación: descarga + caché + análisis
  analyze.js           consenso, ranking, confianza, arbitraje
  match.js             agrupación de eventos y opciones equivalentes
  normalize.js         precios, probabilidades, devig, similitud de texto
  cache.js             caché TTL con single-flight
  http.js              fetch con timeout y reintentos
  providers/           un módulo por plataforma
public/
  index.html           plataforma de trading
  predicciones.html    analizador de predicciones
data/demo/             datos de ejemplo (también usados por los tests)
test/                  32 tests, sin red
```
