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
npm run smoke        # valida las APIs reales (obligatorio antes de desplegar)
npm run static -- salida.html --demo   # instantánea estática autocontenida
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
(umbral de emparejamiento, 0..1). Cuántos eventos se piden a cada plataforma no
es un parámetro de la petición — ver *Exposición pública* más abajo.

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

## Despliegue en un VPS

La app no guarda estado: es un proceso Node que consulta APIs públicas y cachea
en memoria. No hay base de datos ni volúmenes que respaldar, así que desplegar
es copiar el código y reiniciar el proceso.

### 1. Antes de exponer nada: comprobar las fuentes

```bash
npm ci
npm run smoke
```

Llama a las APIs reales de las tres plataformas y verifica que sus respuestas se
siguen pudiendo parsear y analizar. Sale con código 1 si alguna falla, así que
sirve como puerta en un script de despliegue. **Córrelo antes del primer
arranque y después de cada actualización**: las tres son APIs públicas sin
contrato de estabilidad y pueden cambiar un campo sin avisar.

Con `--tolerante` sólo falla si caen todas, que es el criterio razonable para un
reinicio automático — el agregador funciona con las fuentes que respondan.

### 2a. Con Docker (recomendado)

```bash
docker compose up -d --build
docker compose logs -f
curl localhost:3000/healthz
```

El contenedor sólo escucha en `127.0.0.1`: quien da la cara a Internet es Nginx.

### 2b. Sin Docker, con systemd

```bash
sudo useradd --system --home /opt/mini-trading-platform mtp
sudo git clone https://github.com/natanielmatos-svg/mini-trading-platform /opt/mini-trading-platform
cd /opt/mini-trading-platform && sudo npm ci --omit=dev
sudo chown -R mtp:mtp /opt/mini-trading-platform

sudo cp deploy/mini-trading-platform.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mini-trading-platform
sudo systemctl status mini-trading-platform
```

La unidad corre como usuario sin privilegios, con el directorio en sólo lectura
y `ProtectSystem=strict`. La app no escribe nada en disco, así que no le hace
falta más.

### 3. Nginx y TLS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mini-trading-platform
# edita el archivo y sustituye TU-DOMINIO.com
sudo ln -s /etc/nginx/sites-available/mini-trading-platform /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d TU-DOMINIO.com
```

### 4. Actualizar

```bash
cd /opt/mini-trading-platform
git pull && npm ci --omit=dev
npm run smoke                                  # valida antes de reiniciar
sudo systemctl restart mini-trading-platform   # o: docker compose up -d --build
```

El proceso cierra ordenadamente con SIGTERM: deja terminar las peticiones en
vuelo antes de salir, hasta 10 segundos.

### Qué vigilar

- **`GET /healthz`** — sonda de vida. No llama a ninguna API externa a
  propósito: si lo hiciera, una caída de Polymarket provocaría reinicios en
  cadena de un servicio que está perfectamente sano.
- **El campo `sources[]` de `/api/predictions`** — ahí se ve si una plataforma
  dejó de responder o cambió de formato, sin tumbar el resto del análisis. Es la
  señal que conviene alertar, no el healthcheck.
- **Logs** — `journalctl -u mini-trading-platform -f` o `docker compose logs -f`.

### Exposición pública

Al abrirlo a Internet hay dos cosas que el servidor ya controla:

- **Límite de peticiones por IP** (120 por minuto por defecto, `RATE_MAX` y
  `RATE_WINDOW_MS`). No frena un ataque serio — para eso está el proxy — pero
  evita que el bucle descontrolado del navegador de alguien agote los rate
  limits de las APIs ajenas, que son compartidos por todos tus usuarios.
- **Cuántos eventos se piden a cada plataforma** es una constante del servidor
  (`PREDICTIONS_FETCH_LIMIT`), no un parámetro de la petición. Si el cliente
  pudiera elegirlo, cada valor sería una clave de caché distinta y bastaría
  recorrerlos para multiplicar por doscientas las llamadas salientes.

La app no tiene autenticación ni la necesita: todo lo que sirve son datos
públicos de mercado, y no acepta ninguna escritura.

## Configuración

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `DEMO` | — | `DEMO=1` fuerza datos de ejemplo en todas las respuestas |
| `PREDICTIONS_TTL_MS` | `30000` | Caché de los datos de mercado |
| `POLYMARKET_API` / `KALSHI_API` / `MANIFOLD_API` | APIs públicas | Para apuntar a un mirror o a un mock |
| `PREDICTIONS_FETCH_LIMIT` | `80` | Eventos pedidos a cada plataforma por ciclo |
| `RATE_MAX` / `RATE_WINDOW_MS` | `120` / `60000` | Límite de peticiones por IP a `/api` |
| `TRUST_PROXY_HOPS` | `1` | Saltos de proxy de confianza para leer la IP real |

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
scripts/smoke.js         valida las APIs reales antes de desplegar
scripts/build-static.js  instantánea estática autocontenida para compartir
deploy/                  unidad systemd y configuración de Nginx
Dockerfile, docker-compose.yml
test/                  32 tests, sin red
```
