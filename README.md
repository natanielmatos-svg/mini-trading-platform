# Mini Trading Platform + Analizador de Mercados de Predicción

Tres páginas sobre el mismo servidor Node/Express:

| Ruta | Qué es |
|---|---|
| `/index.html` | **Criptomonedas**: velas de Binance en vivo, precio consolidado entre mercados, tendencia multi-timeframe con EMAs, análisis de ruptura de la vela en curso y avisos de compra y venta con sonido |
| `/acciones.html` | **Acciones de EE. UU.**: lo mismo, con velas de Alpaca y consciente del horario del mercado |
| `/predicciones.html` | **Analizador de predicciones**: agrega Polymarket, Robinhood/Kalshi y Manifold y dice qué opción es la más probable de cada evento |

Las dos primeras **no son dos aplicaciones**: comparten el gráfico, el panel de
ruptura, el motor de señales, los avisos y la hoja de estilo. Una vela de Apple
tiene la misma forma que una de bitcoin, así que el análisis es literalmente el
mismo código (ver [Estructura](#estructura)).

## Arranque

```bash
npm install
npm start            # http://localhost:3000
npm run demo         # datos de ejemplo, sin salida a Internet (también el gráfico)
npm test             # 217 tests, sin red
npm run smoke        # valida las APIs reales (obligatorio antes de desplegar)
npm run static -- salida.html --demo   # instantánea estática autocontenida
```

Ningún script usa sintaxis de shell, así que funcionan igual en Linux, macOS y
Windows (PowerShell incluido). Hace falta Node 20 o superior: `node -v`.

### Una nota sobre la caché

El HTML **y el JavaScript** se sirven con `no-cache`, que no significa «no
guardes» sino «pregunta antes de usar»: con el ETag la respuesta habitual es
un 304 de unos pocos bytes. Es deliberado — cachear `app.js` una hora
significaba que tras desplegar un arreglo el navegador seguía ejecutando la
versión anterior, y eso ya pasó una vez.

### Cómo se prueba

```bash
npm test          # 217 tests, sin red, en unos cinco segundos
npm run smoke     # llama a las APIs de verdad — la única prueba que las valida
```

Los tests cubren tres capas, y conviene saber qué prueba cada una:

| Qué | Cómo | Qué garantiza |
|---|---|---|
| Indicadores, ruptura, señales | Series sintéticas con pivotes controlados | Que las reglas hacen lo que dicen |
| Rutas HTTP, caché, límites | El servidor en un puerto efímero, modo demo | Que la API se comporta |
| **Protocolo de Binance** | Un servidor local que imita su REST y su WebSocket (`test/binance.test.js`, `test/stream-binance.test.js`) | Que si Binance responde lo que documenta, se entiende; y que sus errores —400, 429, 503, formato cambiado, socket caído— no tumban nada |

En Node 20 se saltan los ocho tests del WebSocket: esa versión no trae
`WebSocket` global, el hub lo detecta y usa sondeo, y eso último sí se prueba.

Lo que ningún test puede garantizar es que Binance **siga** respondiendo lo que
documenta: son APIs públicas sin contrato de estabilidad. Para eso está
`npm run smoke`, que llama a las de verdad y sale con código 1 si alguna falla.
Córrelo antes del primer arranque y después de cada actualización.

## La plataforma de trading

Velas de Binance, EMAs sobre el gráfico, tendencia en cuatro timeframes y un
panel que responde a una sola pregunta: **¿esta vela va a romper, y hacia
dónde?**

### Precio en vivo y bloque de tiempo

El navegador no habla con Binance. Abre una conexión SSE a `/api/stream` y el
servidor mantiene **un solo WebSocket por símbolo y timeframe**, compartido
entre todos los clientes: cien pestañas abiertas siguen siendo una conexión
saliente. Si el WebSocket no levanta —Node antiguo, red que lo bloquea— tras
tres intentos se degrada a sondeo periódico sobre la caché y se avisa en la
interfaz; cinco minutos después se vuelve a intentar el WebSocket.

Son **dos flujos en una sola conexión**: `@kline_<intervalo>` para la vela y
`@aggTrade` para el precio. El de velas empuja cada uno o dos segundos —
suficiente para dibujar, insuficiente para que el número parezca vivo—, así
que el precio viene de las operaciones y llega en cuanto alguien opera. Cada
uno viaja en su propio evento SSE (`kline` y `price`): el navegador repinta un
número sin recalcular el gráfico.

BTCUSDT puede operar decenas de veces por segundo, y retransmitir cada
operación a cada cliente es tráfico que nadie puede leer, así que el servidor
las **agrupa a diez por segundo**. Lo que se descarta son los precios
intermedios, nunca el más reciente.

### Por qué el precio no tiembla

Al principio el titular se repintaba con cada tick y parecía agitadísimo
aunque el mercado estuviera parado. El problema no era la latencia sino la
**resolución**: con BTC a 85.763,2 el último dígito vale 0,1 $ —un 0,00012%—
y a eso lo mueve cualquier operación suelta. Peor, lo que llega por
`@aggTrade` es el precio de *cada operación ejecutada*, que rebota entre la
compra y la venta del libro aunque nadie mueva el precio.

Kalshi se ve quieto por lo contrario: cotiza de 0 a 100 ¢ con tick de 1 ¢, un
1% del rango. Sencillamente no puede enseñar ruido más fino. Nuestra pantalla
tenía ocho mil veces más resolución que la suya.

`src/precio-vivo.js` hace lo mismo a la escala que toca, con dos piezas:

- **El escalón** decide cuántos dígitos se enseñan: se redondea a entre el
  0,001% y el 0,01% del precio, que es el orden de la horquilla del libro.
- **La banda** decide cuándo se repinta: el número no se mueve hasta que el
  precio se aleja de lo que está puesto más de un 0,05%.

Las dos hacen falta, y eso salió de medirlo. Con sólo el escalón, un mercado
quieto seguía repintando 173 veces por minuto: el rebote entre compra y venta
es **más ancho que el escalón**, así que cruzaba la frontera de redondeo en
cada tick. Redondear no quita un rebote que salta por encima del redondeo; la
histéresis sí, porque mide contra lo que se está enseñando y no contra una
rejilla fija.

Medido sobre 600 ticks en un minuto (10/s):

| Régimen | Sin calmar | Sólo escalón | Con histéresis |
|---|---|---|---|
| Muy quieto (0,002%/s) | 600 | 158 | **1** |
| Quieto (0,01%/s) | 600 | 183 | **1** |
| Normal (0,04%/s) | 600 | 194 | **14** |
| Movido (0,2%/s) | 600 | 200 | **129** |

Se queda quieto cuando no pasa nada y sigue el precio cuando sí. Y hay un
tope de un repintado cada 250 ms, porque el destello de color necesita tiempo
para verse.

**Esto es sólo de pantalla.** La distancia al nivel de ruptura, el ATR y las
señales siguen con el precio crudo, tick a tick. Suavizar el número del que
depende una señal de compra sería mentir sobre lo cerca que está de romper.

### Precio consolidado de tres mercados

El titular no es el precio de un solo exchange: es la **mediana de Binance,
Kraken, Coinbase Advanced y Gemini**, y eliges cuáles entran marcando sus
casillas en el desglose. La elección se guarda entre sesiones y nunca puede
quedarse vacía: sin mercados no hay precio, así que la última casilla marcada
se bloquea. Con tres fuentes, una que se cuelgue con un
precio viejo o devuelva una barbaridad no puede arrastrar el número, cosa que
a una media le bastaría. Con dos, la mediana es la media; con uno, se dice que
es uno solo en vez de fingir consenso.

Se compara **el punto medio del libro** de cada casa, no su última operación.
La última operación de un mercado poco activo puede ser de hace minutos, y
compararla contra el libro vivo de otro no mide una diferencia de precio: mide
que uno lleva rato sin operar. El libro siempre es de ahora. Si una casa no
publica libro, se usa su última operación y **se dice en el desglose**.

Lo más útil del panel no es el número sino **el desglose**: cada mercado con
su par y su diferencia respecto al consolidado.

**Los precios en USDT se convierten a dólares.** Binance cotiza contra USDT y
las otras tres contra dólares, y eso no es un detalle: midiéndolo en real, las
tres en dólares coincidían dentro del 0,011% y Binance se iba sola un 0,044%.
Ese desvío es el precio del USDT, no el del bitcoin, y meterlo en la mediana
la contamina — sobre todo si lo que quieres es cuadrar con alguien que liquida
en dólares. Así que se mide el USDT/USD (Kraken, y Coinbase como respaldo) y
se convierte, enseñando el cambio usado y el precio original. Si no se puede
medir, no se inventa una paridad: se deja el precio como está y el desglose lo
dice. Un cambio fuera del rango 0,90–1,10 se descarta: eso no es una
cotización, es un error de lectura.

| | |
|---|---|
| Binance | `BTCUSDT`, API pública de datos |
| Kraken | `BTCUSD`, `/0/public/Ticker` — devuelve sus errores con un 200 y el fallo dentro del cuerpo, así que se comprueba |
| Coinbase Advanced | `BTC-USD`, endpoint público de mercado, sin clave |
| Gemini | `btcusd` (en minúsculas y sin separador), `/v1/pubticker` |
| CF Benchmarks | `BRTI` / `ETHUSD_RTI` — **un índice, no un mercado, y de pago**; no entra por defecto |

El selector se pinta siempre, aunque no llegue ningún precio: el catálogo se
pide aparte (`GET /api/venues`, que no sale a la red). Antes salía de la
respuesta de precios, así que un fallo ahí se llevaba por delante las
casillas — justo cuando quieres apagar la casa que falla. Y si no hay
consolidado, el panel se abre solo enseñando el error de cada mercado en vez
de quedarse diciendo «consolidando…».

Un mercado que no responda se marca como caído y el consolidado sigue con los
demás; uno cuyo precio lleve más de diez segundos parado se enseña, pero no
cuenta. Con un solo mercado se dice «sin comparación» en vez de «alineados»:
con uno no hay nada con lo que alinearse. `GET /api/price` devuelve todo eso y
acepta `venues=binance,kraken` para elegir; una lista vacía o con nombres que
no existen se ignora y se usan todos, porque un parámetro mal escrito no debe
dejarte sin precio.

#### CF Benchmarks: un índice, no un mercado

El BRTI agrega varios exchanges con una metodología publicada y regulada, así
que como referencia vale más que otra casa suelta. Pero eso mismo trae dos
consecuencias:

- **No tiene libro ni operaciones**: publica un valor, y por eso su fuente
  aparece como «índice» en vez de pasar por la regla del punto medio.
- **Si ya agrega a Coinbase y Kraken, meterlo en la misma mediana que ellos
  los cuenta dos veces.** Por eso viene desmarcado: hay que elegirlo a
  propósito. Si lo que quieres es seguir el índice, lo coherente es marcarlo
  a él y desmarcar los exchanges que agrega.

**Necesita clave licenciada.** Sondeando su API se ve por qué: `/api/v1/indices`
responde 200 sin clave pero con el catálogo **vacío**, y por eso `/api/v1/values`
rechaza cualquier identificador con «Unknown id» — no es que el id esté mal, es
que sin derechos no existe ninguno. A diferencia de los cuatro exchanges, esto
no se puede usar gratis. La clave va en `CFBENCHMARKS_API_KEY` y viaja como
`Authorization: Bearer`; sin ella el desglose dice exactamente eso en vez de
soltar un error opaco.

Sólo cubre los activos para los que publica índice en tiempo real (BTC y ETH);
pedirle otro dice que no lo cubre.

**Sobre Kalshi:** esto reduce el sesgo de mirar un solo exchange, pero
**no garantiza coincidir con Kalshi**, que liquida contra la fuente que
declara en las reglas de cada mercado. Si quieres cuadrar exactamente con un
mercado suyo, mira su regla de liquidación: si la fuente que nombra es una de
éstas, márcala sola; si es otra, se añade como un adaptador más en
`src/venues.js`.

El consolidado se consulta cada dos segundos. Entre consulta y consulta el
titular se mueve con el tick de Binance manteniendo la diferencia medida con
los otros dos, que cambia despacio; si esa diferencia se dispara por encima
del 0,5% —una consulta vieja, un par equivocado— se descarta y se enseña el
consolidado tal cual. El **análisis de ruptura sigue usando el precio de
Binance**, que es de donde salen las velas y los niveles: medir la distancia a
un nivel con el precio de otra casa haría que «faltan 0,87% hasta el nivel»
fuera sutilmente falso.

**El bloque de tiempo** es la tarjeta de arriba del panel: el precio en vivo
—que destella verde o rojo al moverse— y una cuenta atrás hasta que cierre la
vela en curso, con la barra vaciándose, en ámbar en el último cuarto y en rojo
en el último 10%. Si eliges 15m, el cronómetro baja de 15:00 a 00:00 y vuelve
a empezar con la vela siguiente.

El cronómetro sale del reloj del navegador anclado a la apertura que dio
Binance, no del análisis: antes lo tomaba del payload de `/api/breakout`, que
se refresca cada uno o dos minutos, y al cerrar una vela se quedaba clavado en
`00:00` hasta el siguiente refresco.

Las velas históricas vienen de `/api/klines`, que las cachea entre 5 y 60
segundos según el timeframe y agrupa las peticiones simultáneas en una sola
llamada saliente.

### El análisis corre sobre los mercados que elijas

Hasta hace poco el análisis salía **entero de Binance** —niveles, ATR y muestra
de excursiones— mientras el titular enseñaba la mediana de varios mercados. Eso
es mirar un precio y analizar otro: la distancia a un nivel, que es de lo que
depende una señal de compra, se medía en una escala distinta de la que se veía.

Ahora las velas del timeframe del gráfico se consolidan igual que el precio:
cada mercado da las suyas, se pasan todas a dólares y para cada instante se
toma la mediana de aperturas, máximos, mínimos y cierres.

No todos los mercados publican todos los intervalos:

| | 1m | 15m | 1h | 4h | 12h | 1d | 1w |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Binance | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Kraken | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ |
| Coinbase | ✓ | ✓ | ✓ | · | · | ✓ | · |
| Gemini | ✓ | ✓ | ✓ | · | · | ✓ | · |

El que no puede, no contribuye, y se dice cuál. Con menos de dos mercados no
hay mediana —sería un mercado disfrazado de consenso— así que se vuelve a
Binance y el estado lo explica: «Binance (sin consolidar: …)».

**¿Cambia algo consolidar?** Medido con los cuatro mercados en vivo, BTCUSDT
de 1h, 400 velas:

| | Sólo Binance | Consolidado | |
|---|---|---|---|
| ATR(14) | 539,46 | 534,52 | −0,92% |
| Nivel al alza | 86.361,2 | 86.353,1 | −0,01% |
| Volatilidad anual | 32,7% | 32,5% | −0,57% |
| **Probabilidad al alza** | **52,2%** | **55,1%** | **+5,6%** |

Las entradas apenas se mueven —los cuatro mercados están mucho más acoplados
de lo que parecía: la dispersión entre ellos es del 0,017%— pero **la salida sí
se mueve, casi tres puntos**.

El motivo es que la probabilidad no es una fórmula continua sino una
**frecuencia empírica**: se cuenta cuántas de las 385 velas anteriores
recorrieron lo que hace falta. Bajar el ATR un 0,9% baja el listón lo justo
para que unas cuantas velas más lo crucen. Con la muestra apretada alrededor
del umbral, un cambio pequeño en la entrada mueve la cuenta varios puntos.

Que quede dicho: primero supuse que sería cosmético, luego medí en laboratorio
−6,7% de ATR con un ruido que me inventé, y con mercados de verdad es −0,9%.
Las dos predicciones estaban mal. Lo que aguanta es lo medido, y `npm run
smoke` lo vuelve a medir cada vez.

### Motor de predicción

**Los horizontes van en tiempo, no en bloques del gráfico.** Antes eran
bloques del intervalo elegido, así que con el gráfico en 1h no había forma de
preguntar por los próximos cinco minutos —que es justo el plazo en el que
alguien está mirando la pantalla—. Ahora cada plazo se calcula con la serie que
le corresponde: de 1 minuto a 1 hora salen de velas de un minuto, y de ahí
hacia arriba del intervalo del gráfico. Predecir cinco minutos con velas de una
hora sería inventarse una resolución que los datos no tienen.

| plazo | serie | plazo | serie |
|---|---|---|---|
| 1 min | velas de 1m | 2 h | el gráfico |
| 5 min | velas de 1m | 4 h | el gráfico |
| 15 min | velas de 1m | 8 h | el gráfico |
| 30 min | velas de 1m | 12 h | el gráfico |
| 1 h | velas de 1m | 1 d | el gráfico |

**No predice un precio, y es una decisión, no una limitación.** A quince
minutos vista la mejor estimación puntual honesta de bitcoin es el precio de
ahora: en un mercado líquido la deriva a ese plazo es indistinguible del ruido,
y cualquier número que se aparte del precio actual con aire de seguridad está
inventado. Un motor que escupiera «86.412 dentro de 15 minutos» sería una
máquina de fabricar confianza falsa, y con dinero delante eso es peor que no
tener nada.

Lo que sí se estima, y es lo que de verdad se usa, es la **distribución**:

| dentro de | 50% de las veces | 90% de las veces | acierto |
|---|---|---|---|
| 1 h | 60.041 – 60.371 | 59.840 – 60.551 | 91% de 90% |
| 12 h | 59.596 – 61.050 | 58.976 – 61.807 | 83% de 90% |
| 1 d | 59.063 – 61.990 | 57.817 – 63.291 | 59% de 90% |

Tres piezas, cada una arreglando un defecto conocido de la anterior:

1. **Volatilidad condicional (EWMA).** La volatilidad se agrupa: tras un tramo
   movido viene otro movido. Una desviación típica de las últimas 30 velas pesa
   igual la de ayer que la de hace un mes; la EWMA reacciona.
2. **Colas empíricas, no campana de Gauss.** Los rendimientos de cripto tienen
   colas mucho más gordas que la normal. En vez de suponer la forma, se usa la
   observada.
3. **Horizonte con reversión a la media.** Escalar por raíz del tiempo daba
   bandas demasiado estrechas a plazos largos —medido: la banda del 90%
   contenía el 83,6% a doce velas—. Ahora la varianza de cada paso futuro se
   mezcla hacia la de largo plazo, que es la cuenta de un GARCH.

**La deriva se fija en cero a propósito**, y se protege en dos sitios: los
rendimientos estandarizados se centran en su mediana, y los cuantiles conformes
también. Sin lo segundo, un tramo de entrenamiento con tendencia metía esa
tendencia en la banda central por la puerta de atrás.

#### Dónde se ve

En el **gráfico**, como abanico a la derecha de la última vela: cada horizonte
pone su punto y la forma sale de los números calculados, no de una curva
supuesta. La parte oscura es el 50% de las veces; la clara, el 90%. La línea
central va discontinua porque **es el precio de ahora prolongado**, no una
predicción de dirección.

Y en una línea dentro del bloque de tiempo, que es la primera tarjeta y no hay
que bajar para verla: «en 1 h, la mitad de las veces entre 60.053 y 60.383 ·
acierta 91% de 90%».

El abanico tiene su propio margen para estirar la escala, y muy estrecho: la
banda del 90% a un día llega un 5% más arriba que cualquier vela, y dejarla
mandar aplastaba el histórico hasta que la rejilla se quedaba en una sola
línea. Lo que no cabe se recorta contra el borde, que además es la lectura
correcta.

#### La columna que hace esto comprobable

`src/calibracion.js` recorre el histórico prediciendo hacia delante —**sólo con
lo anterior a cada punto**— y cuenta cuántas veces el precio acabó dentro de la
banda anunciada. Un modelo que promete el 90% y cumple el 72% tiene las bandas
demasiado estrechas, y un stop colocado ahí saltaría constantemente.

Se mide con tres cosas: **cobertura** (¿el 90% es el 90%?), **PIT** (¿la
distribución entera encaja, no sólo dos puntos?) y **pérdida pinball** contra
una referencia trivial —paseo aleatorio con volatilidad constante y campana—.
Si el motor no le gana, el veredicto lo dice con esas palabras.

Medido sobre series sintéticas con volatilidad agrupada y saltos, cuatro
semillas distintas:

| horizonte | cobertura del 90% |
|---|---|
| 1 vela | 87–92% |
| 4 velas | 90–94% |
| 12 velas | 85–97% (inestable) |

A plazo corto está bien calibrado; a doce velas es inestable y el panel lo
enseña. Ésa es la diferencia entre un motor y un adorno: **publica su propio
boletín de notas**, y la interfaz enseña la nota al lado de cada banda.

### Volatilidad

`src/volatilidad.js` mide la volatilidad **realizada**: la desviación típica de
los rendimientos logarítmicos, escalada a un año, sobre las últimas 30 velas.

Un 40% anual no dice nada suelto, así que se compara con las 200 ventanas
anteriores **del mismo activo** y se etiqueta el régimen por cuartiles: por
debajo del 25%, calma; por encima del 75%, tensión.

Y una medida que no puede calcular quien mira un solo exchange: **la dispersión
entre mercados**, cuánto discrepan las casas sobre el mismo activo. Sube cuando
el mercado se tensiona y cuando alguna se queda descolgada.

> **No es un índice de volatilidad implícita.** El VIX y el índice de
> volatilidad de CF Benchmarks salen del precio de las opciones y dicen lo que
> el mercado paga **hoy** por cubrirse del mes que viene. Aquí no hay datos de
> opciones: esto mira al pasado. El aviso viaja con el número en la interfaz,
> porque confundirlos es fácil y caro.

### ¿Rompe esta vela? El método

La respuesta honesta a "¿va a romper?" no es un oráculo, es **una frecuencia
observada**. Tres pasos, todos comprobables a mano:

1. **Localizar el nivel.** No cualquier precio: los pivotes donde el mercado ya
   se dio la vuelta (una vela cuyo máximo supera al de las tres de cada lado),
   agrupados cuando están tan juntos que son el mismo nivel tocado varias veces.
   El número de toques es la fuerza del nivel. Si no hay pivote por delante
   —un activo en subida libre— se usa el extremo de las últimas 60 velas y se
   marca como tal.

2. **Medir la distancia en ATR, no en dólares.** "Faltan 300 $" no dice nada;
   "falta 0,4 ATR" dice que es un recorrido corriente para este activo y este
   timeframe.

3. **Contar cuántas velas anteriores hicieron ese recorrido.** De las ~385
   velas cargadas, ¿cuántas se movieron desde su apertura al menos lo que ahora
   falta? Ese porcentaje es la probabilidad que se muestra. No hay modelo
   escondido detrás: es una cuenta sobre el histórico que tienes delante.

**El ajuste por tiempo.** A una vela a la que le queda el 30% de su vida no se
le puede exigir el recorrido de una vela entera. Como la volatilidad de un
recorrido escala con la raíz del tiempo, la distancia pendiente se compara
contra la muestra dividida por `sqrt(fracción restante)`: a media vela el listón
sube un 41%, y en el último minuto se dispara. Por eso cuando queda poco se
muestra también **cuánto sería con una vela entera por delante**, que es la
pregunta útil en ese momento.

El navegador recalcula ese número con cada tick usando exactamente las mismas
dos funciones que el servidor (`requiredExcursion` y `shareAtLeast`) sobre la
muestra que vino en la respuesta, así que lo que se ve en vivo es lo que
devolvería `/api/breakout` si se le preguntara en ese instante.

### Lo que la probabilidad no incluye

El contexto va aparte, y a propósito: son las señales que explican si una
ruptura tendría continuidad, pero meterlas en el número sería inventarse una
ponderación.

| Señal | Qué dice |
|---|---|
| Compresión del ATR frente a su media de 50 | Los rangos estrechos preceden a los movimientos amplios |
| Posición dentro del rango de 50 velas | Pegado al techo es donde nacen las rupturas y las trampas |
| Volumen proyectado de la vela en curso | Sin volumen, una ruptura se recupera |
| EMA rápida contra lenta | Contra qué corriente iría la ruptura |
| RSI(14) | Agotamiento, no señal por sí solo |
| Forma de la vela (cuerpo y mechas) | Una mecha superior larga es alguien vendiendo cada intento |

Y la confirmación se separa del pronóstico: **un cierre** por encima del nivel
con volumen por encima de 1,3× la media. Un pico que toca el nivel y vuelve
dentro antes del cierre es un rechazo, no una ruptura.

### Cuándo comprar y cuándo vender

El panel de ruptura dice qué es probable; los avisos dicen **qué hacer**, y
suenan aunque estés en otra pestaña. Se encienden con el interruptor de la
tarjeta correspondiente, que pide permiso de notificaciones y desbloquea el
sonido. El botón *Probar* lanza una alerta de mentira para comprobar que
sonido y permisos funcionan antes de fiarte de ellos.

| Aviso | Cuándo salta | Sonido |
|---|---|---|
| **COMPRAR** | Una vela **cierra** por encima de la resistencia con al menos 1,3× el volumen medio | Dos notas ascendentes |
| **VENDER** | Stop, objetivo, ruptura falsa o señal contraria sobre lo comprado | Dos notas descendentes |
| **Señal de venta** | Una vela cierra por debajo del soporte sin que haya nada comprado | Dos notas descendentes |
| **Aviso previo** | La probabilidad de romper pasa del 70% y la vela sigue abierta. **Apagado por defecto** | Dos notas iguales |

La regla que lo gobierna todo es la misma que ya definía el análisis: **una
ruptura sólo cuenta si la vela cierra al otro lado del nivel y con volumen**.
Un pico que toca el nivel y vuelve dentro es un rechazo, y comprar ahí es la
forma más habitual de perder dinero con este tipo de sistema. Por eso el aviso
previo existe pero está separado de la compra, y dice explícitamente que
todavía no lo es.

Al confirmarse una compra se abre un **seguimiento en papel** con el precio de
compra, el stop —bajo el mínimo de la vela que rompió, más un margen de 0,1
ATR— y el objetivo: **el primer nivel por delante que esté al menos a 1,5 veces
el riesgo**, o el doble del riesgo si ninguno llega. Ese mínimo no es un
adorno: coger el nivel más cercano sin más daba, medido sobre histórico, un
89% de compras con ratio por debajo de 1:1 y una mediana de 0,52 —alguna de
0,02, que es arriesgar cincuenta para ganar uno—. Con eso se acierta dos de
cada tres veces y se pierde dinero igual, que es exactamente lo que salía. Ambos se dibujan en el gráfico, y el aviso dice literalmente
cuándo vender: *«vender si baja de 109,68 o al llegar a 125,65»*. El
seguimiento se cierra solo cuando llega ese momento:

- **Stop**: el precio cae por debajo del stop. Se vende para no seguir perdiendo.
- **Objetivo**: el precio alcanza el nivel fijado al comprar.
- **Ruptura falsa**: una vela posterior cierra de vuelta por debajo del nivel
  roto. Es la trampa clásica: se vende sin esperar al stop.
- **Señal contraria**: se confirma una ruptura bajista con la compra abierta.

#### Las dos operativas

En contado no se puede vender lo que no se tiene, así que una ruptura bajista
con la cartera vacía no es una operación. El desplegable *Operativa* decide qué
hacer con ella:

- **Contado: comprar y vender** (por defecto). La bajada no abre nada, pero
  tampoco se calla: avisa como señal de venta para quien ya tenga la moneda y
  de quedarse fuera para quien no.
- **Contado y corto**. Además sigue las bajadas: *vender en corto* para abrir y
  *recomprar* para cerrar, con el mismo stop y objetivo que en el otro sentido.

El aviso previo viene apagado a propósito. Medido sobre histórico real de
BTCUSDT en velas de 1h, salta unas **2-3 veces al día**: útil si quieres
vigilar la aproximación a un nivel, ruido si sólo quieres saber cuándo comprar
y cuándo vender. Se enciende con su casilla. Un mismo nivel avisa una vez por
aproximación y no una vez por vela — con el identificador atado a la vela eran
144 avisos en 320 velas, un popup con sonido cada dos horas.

Detalles que conviene saber:

- **No manda ninguna orden a ningún sitio.** Es un seguimiento en papel: no
  sabe cuánto dinero tienes ni habla con ningún bróker.
- **Los avisos son del par que tienes abierto.** No vigila las veintinueve
  criptos a la vez: eso serían veintinueve conexiones y otros tantos análisis.
- **Al abrir la página no suena nada.** La primera evaluación sólo toma nota:
  gritar por una señal que ocurrió mientras el navegador estaba cerrado es
  ruido. Esas señales aparecen en el historial marcadas como anteriores.
- **Una señal no se repite**, aunque se evalúe cien veces: cada una lleva un
  identificador derivado de la vela que la produjo.
- El seguimiento sobrevive a recargas (`localStorage`), y si el navegador no
  deja guardar —modo privado— todo sigue funcionando, sólo se olvida.

### Criptomonedas

El desplegable trae los pares contra USDT que alguien querría mirar, agrupados
por tipo, y una opción *Otro par…* para escribir cualquier otro. La lista vive
en `src/symbols.js`; cuando hay red se contrasta con Binance y los pares que
hayan dejado de cotizar no se ofrecen. Si Binance no responde, se sirve sin
verificar antes que dejar el desplegable vacío.

### Límites del método

- La muestra es **incondicional**: no sabe si la vela ya gastó su empuje. Una
  vela que lleva media hora subiendo y otra que lleva media hora parada reciben
  el mismo tratamiento.
- El ATR con el que se normaliza cada vela histórica es **el previo a esa vela**,
  nunca el posterior; si no, el cálculo miraría el futuro y saldrían números
  preciosos e inútiles.
- Los avisos de compra y venta heredan todos estos límites: son reglas
  mecánicas sobre el histórico, no una lectura del mercado. No tienen en cuenta
  noticias, ni el libro de órdenes, ni las comisiones, ni el deslizamiento, y
  decir "comprar" es describir lo que hace la regla, no aconsejarte a ti.
- Frecuencia histórica no es probabilidad futura. Es análisis de mercado, no una
  recomendación de inversión.

## Acciones (`/acciones.html`)

La misma página que la de criptomonedas, con tres diferencias que no son de
formato sino de cómo funciona la bolsa.

**Hace falta clave.** No existe el equivalente al endpoint público de Binance:
los datos de bolsa están licenciados. Con una cuenta gratuita de
[Alpaca](https://alpaca.markets/) se consigue tiempo real de IEX:

Lo más cómodo es un archivo `.env` junto a `package.json` —no se sube, está en
`.gitignore`— porque la sintaxis para exportar variables cambia con el shell y
se pierde al cerrar la ventana:

```
ALPACA_KEY_ID=TU_CLAVE
ALPACA_SECRET_KEY=TU_SECRETO
```

```bash
cp .env.example .env     # y rellenarlo
npm run alpaca           # comprueba la clave en dos segundos
npm start
```

`npm run alpaca` dice si la clave sirve, de qué cuenta es —papel o real— y si
el mercado está abierto. No imprime el secreto. Lo que ya esté en el entorno
manda sobre el `.env`, así que `PORT=3999 npm start` sigue funcionando.

**Fuera de sesión no se pregunta al libro.** Medido en vivo con la bolsa
cerrada, el feed gratuito de IEX devolvió para AAPL una horquilla del 10% y un
punto medio de 340,04 cuando la última vela había cerrado en 309,27: dos puntas
de sesiones distintas, no un precio. La resistencia estaba en 309,91, así que
colarlo habría hecho que el análisis cantara «nivel superado» y pudiera abrir
una compra sobre un número que no existió. Ahora una horquilla por encima del
2% se rechaza —ningún valor del catálogo cotiza así— y con el mercado cerrado
se usa directamente el cierre de la última vela de sesión.

**Se piden las barras más recientes.** Alpaca devuelve ascendente desde
`start`, así que cuando la ventana contiene más barras que el límite se queda
con las **más antiguas**. Con velas de una hora la ventana cabía entera y no se
notaba; con las de un minuto son unas 1.950 barras de sesión en el rango y sólo
caben 800, así que devolvía las de hace seis días. Se pide `sort: desc` y se
ordena en cliente pase lo que pase.

**Las barras de horario extendido se descartan** en los marcos intradía. Alpaca
las devuelve mezcladas y en el feed gratuito son finísimas: 55 de 205 barras de
una hora, medido en vivo. Un rango ancho con cuatro operaciones infla el ATR y
coloca pivotes donde no hubo mercado.

Sirven tanto las claves de la cuenta real como las de papel: no son
intercambiables —una clave de papel contra el host real devuelve un 403 tan
seco como no mandar credenciales— pero de la API de trading aquí sólo se usa el
reloj del mercado, que es el mismo para las dos, así que se prueban los dos
hosts y se recuerda el que responde. No hay que configurar cuál es.

Sin clave la página **funciona igual con velas de ejemplo** y lo dice en una
banda arriba, en vez de quedarse en blanco. IEX es un solo mercado con poca
cuota, así que su precio puede separarse unos céntimos del consolidado oficial;
la página lo advierte en vez de aparentar que es el precio de mercado.
`ALPACA_FEED=sip` da la cinta consolidada, que es de pago.

**El mercado cierra**, y eso cambia tres cosas:

- La cuenta atrás de la vela **se corta al cierre**: una vela de una hora
  abierta a las 15:30 no dura hasta las 16:30, y la etiqueta pasa a decir
  «cierra la sesión en».
- Con el mercado cerrado no hay vela en curso, así que la cuenta atrás pasa a
  ser **cuánto falta para abrir**, en hora de Nueva York y con el «NY» puesto.
- El panel de ruptura, cerrado el mercado, calcula las probabilidades sobre
  **una vela entera** —la que abrirá en la próxima sesión— y lo dice. Descontar
  el tiempo restante daría 0% en los dos lados: cierto e inútil.

El horario se le pregunta a Alpaca (`/v2/clock`) en vez de mantener un
calendario de festivos a mano, que es una fuente de errores silenciosos. En
modo de ejemplo se calcula con la sesión regular —días hábiles de 9:30 a 16:00
en Nueva York, con su horario de verano— y ahí sí puede colarse un festivo.

**No hay WebSocket.** El precio se pregunta cada cinco segundos con el mercado
abierto y cada minuto cuando está cerrado, porque no se va a mover. Las velas,
cada minuto y cada diez respectivamente.

El desplegable trae 34 valores agrupados —grandes tecnológicas,
semiconductores, banca, energía, salud y ETFs de índices— y sólo esos: un
ticker inventado gastaría una llamada a Alpaca para devolver un error críptico,
así que el servidor lo rechaza antes. La lista vive en `src/stocks.js`.

Los avisos guardan sus preferencias aparte de los de cripto: encender el sonido
en una página no lo enciende en la otra, y el seguimiento en papel de AAPL no
se mezcla con el de BTCUSDT.

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
   el último operado, que puede llevar horas parado. Kalshi cotiza en dólares por
   contrato (y antes en centavos: se aceptan ambos formatos) y Polymarket en
   dólares: todo se lleva a 0..1. Si una plataforma
   sólo publica la pata "Sí", la pata "No" se deriva por complemento.

2. **Quitar el vig.** Los precios "Sí" de un evento donde sólo puede ganar una
   opción suelen sumar más de 1: ese exceso es el margen del creador de mercado.
   Dividir por la suma devuelve probabilidades que suman 100%. El exceso se
   reporta como `overround` para que se vea de dónde salió.

3. **Emparejar eventos entre plataformas.** Nadie escribe la misma pregunta
   igual ("Presidential Election Winner 2028" vs "Who will win the 2028
   presidential election?"). Se comparan títulos y conjuntos de opciones con
   coeficiente de Dice sobre tokens normalizados (sin acentos, sin stopwords) y
   se exige que las fechas de cierre sean compatibles. Entre dos mercados Sí/No
   decide sólo el título: sus opciones son idénticas por construcción y esa
   señal no distingue nada. Y si ambos títulos citan años y no comparten
   ninguno, se descartan de plano: en un mercado de predicción el año es el
   contrato. Cada plataforma aporta
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
- Las opciones "Other" y equivalentes se muestran y cuentan para el reparto de
  probabilidad, pero nunca encabezan el veredicto: responder "lo más probable es
  Otro" no contesta la pregunta. Si ese cajón supera al favorito se avisa, porque
  entonces el mercado está apuntando a alguien fuera de la lista.
- Cada plataforma enumera candidatos distintos: donde una lista cincuenta
  nombres, otra lista cuarenta y un "Other". El universo de opciones lo fija la
  fuente más profunda del grupo, y las demás sólo afinan el precio de las que ya
  están; lo que sólo cotiza una plataforma secundaria se descarta. Sin esa regla
  la masa de probabilidad de cada cola se contaba dos veces y todos los
  porcentajes bajaban alrededor de un 30%.
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

Velas OHLCV cacheadas. Parámetros: `symbol`, `interval` (lista blanca de 15
timeframes), `limit` (tope: `KLINES_FETCH_LIMIT`), `format=raw` para el array
posicional de Binance de la versión anterior.

```jsonc
{
  "symbol": "BTCUSDT", "interval": "1h", "source": "binance",
  "fetchedAt": 1790000000000, "count": 300,
  "candles": [{ "openTime": 1789999200000, "open": 64010.1, "high": 64320.0,
                "low": 63980.2, "close": 64180.5, "volume": 812.4,
                "closeTime": 1790002799999, "closed": true }]
}
```

Ya no es un proxy transparente: cuántas velas se piden a Binance es una
constante del servidor, no el `limit` del cliente. Si el cliente fijara el
tamaño, cada valor sería una clave de caché distinta y bastaría recorrerlos para
multiplicar las llamadas salientes — el mismo razonamiento que en el analizador.

### `GET /api/breakout`

Análisis de ruptura de la vela en curso. Parámetros: `symbol`, `interval`,
`price` (precio en vivo del cliente, opcional).

```jsonc
{
  "ok": true, "price": 64180.5, "atr": 310.2, "atrPct": 0.483,
  "candle": { "openTime": 1790000000000, "closeTime": 1790003599999,
              "elapsed": 0.42, "remainingMs": 2088000, "remainingLabel": "34 min" },
  "up":   { "level": 64320, "touches": 3, "distancePct": 0.217, "distanceAtr": 0.45,
            "requiredAtr": 0.59, "probability": 0.283, "probabilityFullCandle": 0.372,
            "sampleSize": 385 },
  "down": { "level": 63900, "touches": 5, "probability": 0.41, "…": "…" },
  "bias": "baja",
  "context": [{ "key": "compresion", "label": "Volatilidad", "lean": "neutral", "text": "…" }],
  "explanation": ["Vela de 1h en curso: abrió en …", "Para romper al alza faltan …"],
  "trigger": { "up": { "text": "Ruptura alcista válida: cierre de 1h por encima de …" } },
  "sample": { "up": [0.4, 1.2, …], "down": […], "remainingFraction": 0.58 },
  "disclaimer": "Frecuencia histórica de recorridos, no una predicción …"
}
```

### `GET /api/price`

Precio consolidado y el detalle por mercado. Parámetro: `symbol`.

```jsonc
{
  "symbol": "BTCUSDT", "price": 86644.32, "method": "mediana", "used": 3,
  "spread": 29.9, "spreadPct": 0.0345, "agreement": "alineados",
  "venues": [
    { "id": "binance", "label": "Binance", "pair": "BTCUSDT", "quote": "USDT",
      "price": 86620.1, "diff": -24.22, "diffPct": -0.028, "usable": true, "ageMs": 0 },
    { "id": "kraken", "label": "Kraken", "pair": "BTCUSD", "quote": "USD", "price": 86650, "…": "…" },
    { "id": "coinbase", "label": "Coinbase", "pair": "BTC-USD", "quote": "USD", "price": 86644.32, "…": "…" }
  ]
}
```

### `GET /api/symbols`

Catálogo de criptomonedas para el desplegable, agrupado. `verified` dice si se
pudo contrastar con Binance.

```jsonc
{
  "verified": true, "count": 29,
  "groups": [{ "name": "Principales",
               "symbols": [{ "symbol": "BTCUSDT", "name": "Bitcoin", "available": true }] }]
}
```

### `GET /api/forecast`

`?symbol=BTCUSDT&interval=1h&bloques=4`. Sin `bloques` devuelve todos los
horizontes. Cada uno trae `bandas` (los cuantiles 5/10/25/50/75/90/95),
`sigmaPct`, y `calibracion` con la cobertura medida sobre el histórico. La
banda del 50% **es** el precio actual, a propósito. `/api/stocks/forecast` hace
lo mismo con acciones.

### `GET /api/klines/consolidadas`

`?symbol=BTCUSDT&interval=1h&venues=binance,kraken`. Las mismas velas que usa
el análisis: la mediana de los mercados pedidos. Devuelve `source`
(`consolidado` o `binance`) y `consolidado.venues`, que dice cuáles entraron y
por qué no entraron los demás.

### `GET /api/stocks/symbols`

Los valores del desplegable, agrupados, más `conClave` y `feed`: la interfaz
tiene que poder pintarlo sin clave, que es justo cuando hay que explicar qué
falta. No sale a la red.

### `GET /api/stocks/clock`

```json
{ "isOpen": false, "now": 1790049453221, "nextOpen": 1790083800000, "nextClose": null, "source": "alpaca" }
```

`source: "demo"` significa que se ha calculado con la sesión regular en vez de
preguntárselo a Alpaca, así que puede ignorar un festivo.

### `GET /api/stocks/candles`

`?symbol=AAPL&interval=1h&limit=300`. Misma forma que `/api/klines`. Los
intervalos son los de Alpaca: `1m` … `4h`, `1d`, `1w`. Un ticker que no esté en
el catálogo se sustituye por el de por defecto en vez de gastar una llamada.

### `GET /api/stocks/quote`

Punto medio del libro del valor, y de qué `feed` viene. Sin consolidar entre
mercados como en cripto: la cinta consolidada es un producto licenciado, así
que la respuesta dice de dónde sale el precio en vez de aparentar que es el
oficial.

### `GET /api/stocks/breakout`

El mismo análisis que `/api/breakout` —mismos campos, misma explicación, mismo
`disclaimer`— más `clock`, porque sin él la interfaz enseñaría una cuenta atrás
hacia el cierre de una vela que no se va a mover hasta el lunes. Si los datos
son de ejemplo, `aviso` dice por qué.

### `GET /api/stream`

Precio en vivo por SSE. Parámetros: `symbol`, `interval`. Emite tres eventos
—`kline` (la vela en curso), `price` (cada operación, agrupada a diez por
segundo) y `status` (estado del upstream)— más un comentario de latido cada
20 s para que ningún proxy corte la conexión.

```
event: kline
data: {"symbol":"BTCUSDT","interval":"1h","source":"ws","close":64180.5,"closed":false,…}

event: price
data: {"symbol":"BTCUSDT","interval":"1h","source":"ws","price":64181.2,"quantity":0.015,"at":1790000000000}
```

## Despliegue en un VPS

La app no guarda estado: es un proceso Node que consulta APIs públicas y cachea
en memoria. No hay base de datos ni volúmenes que respaldar, así que desplegar
es copiar el código y reiniciar el proceso.

### 1. Antes de exponer nada: comprobar las fuentes

```bash
npm ci
npm run smoke
```

Llama a las APIs reales —Binance y las tres plataformas de predicción— y
verifica que sus respuestas se siguen pudiendo parsear y analizar. Sale con código 1 si alguna falla, así que
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

La configuración de Nginx incluye un bloque específico para `/api/stream` con
el búfer desactivado: SSE es una respuesta que no termina nunca y un stream
bufferizado no llega jamás al navegador.

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
- **`streams` en `/healthz`** — cuántas salas de precio en vivo hay abiertas y
  con qué fuente. Un `source: "poll"` permanente significa que el WebSocket de
  Binance no levanta desde este servidor.

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
| `PREDICTIONS_FETCH_LIMIT` | `120` | Eventos pedidos a cada plataforma por ciclo |
| `KLINES_FETCH_LIMIT` | `500` | Velas pedidas a Binance por ciclo (y tope del `limit` del cliente) |
| `MAX_STREAMS_PER_IP` | `6` | Conexiones de precio en vivo simultáneas por IP |
| `BINANCE_API` / `BINANCE_WS` | APIs públicas | Para apuntar a un mirror o a un mock |
| `KRAKEN_API` / `COINBASE_API` / `GEMINI_API` | APIs públicas | Igual, para los otros mercados |
| `CFBENCHMARKS_API` | API pública | Endpoint del índice |
| `CFBENCHMARKS_API_KEY` | — | Sólo si tu acceso al índice la necesita |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` | — | Precios de bolsa de verdad. Sin ellas `/acciones.html` funciona con datos de ejemplo y lo dice |
| `ALPACA_SPREAD_MAX` | `0.02` | Horquilla máxima que se acepta como libro real |
| `ALPACA_FEED` | `iex` | `iex` es gratis y de un solo mercado; `sip` es la cinta consolidada, de pago |
| `ALPACA_DATA_API` | API de datos de Alpaca | Para apuntar a un mock |
| `ALPACA_API` | real y papel, en ese orden | Hosts de trading a probar, separados por comas. Sólo se usa para el reloj del mercado |
| `RATE_MAX` / `RATE_WINDOW_MS` | `120` / `60000` | Límite de peticiones por IP a `/api` |
| `TRUST_PROXY_HOPS` | `1` | Saltos de proxy de confianza para leer la IP real |

Ninguna clave es obligatoria para arrancar: cripto y predicciones usan sólo
endpoints públicos de lectura, y acciones cae a datos de ejemplo si falta la de
Alpaca, que es la única con clave porque los datos de bolsa están licenciados.
Las respuestas se cachean 30 s y las peticiones simultáneas a la misma clave se
agrupan en una sola llamada, para no chocar con los rate limits.

## Estructura

```
server.js              rutas HTTP
src/
  env.js               lee el .env, si lo hay, antes que nada
  indicators.js        EMA, ATR, RSI, pivotes, niveles — servidor Y navegador
  format.js            formato de precios y porcentajes — servidor Y navegador
  signals.js           compras y ventas — servidor Y navegador
  velas-mercados.js    velas de cada casa: Binance, Kraken, Coinbase, Gemini
  velas-consolidadas.js la mediana de esas velas, instante a instante
  volatilidad.js       volatilidad realizada y dispersión entre mercados
  forecast.js          distribución del precio: EWMA + colas empíricas + conforme
  calibracion.js       backtest walk-forward: ¿se cumplen las bandas que promete?
  panel-prediccion.js  el panel de bandas — las DOS páginas
  chart.js             el gráfico de velas — las DOS páginas
  precio-vivo.js       calma el titular sin tocar el precio del análisis
  panel-ruptura.js     el panel «¿Rompe esta vela?» — las DOS páginas
  avisos.js            sonido, ventana emergente y seguimiento — las DOS páginas
  tabla-mtf.js         la tabla de tendencia — las DOS páginas
  symbols.js           catálogo de criptomonedas del desplegable
  stocks.js            acciones: catálogo, sesión, reloj y modo de ejemplo
  alpaca.js            acciones: velas, precio y el reloj del mercado
  venues.js            un adaptador por mercado al contado: Binance, Kraken, Coinbase
  consolidated.js      mediana entre mercados y cuánto discrepan
  klines.js            velas: validación, caché por timeframe y modo demo
  breakout.js          niveles, distancia en ATR y frecuencia histórica
  stream.js            WebSocket compartido hacia Binance → SSE a los clientes
  api.js               orquestación: descarga + caché + análisis
  analyze.js           consenso, ranking, confianza, arbitraje
  match.js             agrupación de eventos y opciones equivalentes
  normalize.js         precios, probabilidades, devig, similitud de texto
  cache.js             caché TTL con single-flight y stale opcional
  http.js              fetch con timeout y reintentos
  providers/           un módulo por plataforma
public/
  estilo.css           hoja común de las dos páginas de mercado
  index.html           criptomonedas (maquetación)
  app.js               criptomonedas: datos, precio consolidado y SSE
  acciones.html        acciones (maquetación)
  acciones.js          acciones: datos, horario del mercado y precio
  predicciones.html    analizador de predicciones
data/demo/             datos de ejemplo (también usados por los tests)
scripts/alpaca.js        comprueba la clave de Alpaca y nada más
scripts/smoke.js         valida las APIs reales antes de desplegar
scripts/build-static.js  instantánea estática autocontenida para compartir
deploy/                  unidad systemd y configuración de Nginx
.github/workflows/ci.yml tests en cada push + APIs reales una vez al día
Dockerfile, docker-compose.yml
test/                  346 tests, sin red
```
