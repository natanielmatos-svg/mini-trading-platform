# Escáner local de arbitraje

## Funcionamiento

Se inicia con el servidor local en modo no-demo y repite una ronda 60 segundos después de finalizar la anterior. No depende del navegador ni del agente de IA. No envía órdenes, no firma operaciones, no transfiere fondos ni requiere credenciales de Polymarket. Solo el libro de Kalshi usa la credencial existente para peticiones GET.

La pestaña Arbitraje, en cripto y acciones, y GET `/api/arbitrage` muestran cobertura, descartes, reglas originales, proyecciones y simulaciones. La lectura pública no acredita permiso para operar. El proveedor predeterminado es Polymarket US, correspondiente a la cuenta indicada por el usuario en Nueva York. Su catálogo y libros públicos no requieren claves. La elegibilidad y los permisos de la cuenta siguen pendientes; no se deducen del bloqueo de Polymarket internacional. El adaptador internacional permanece disponible por separado y nunca se evita su bloqueo.

## Cobertura y equivalencia

Catálogo parcial: hasta 1000 contratos Kalshi con cierre en siete días y hasta 300 mercados Polymarket US con cierre en siete días; solo binarios activos con dos tokens válidos y fecha futura. En cada ronda se revisan ocho contratos Polymarket rotatorios y hasta seis coincidencias entre plataformas, en ambas direcciones. El catálogo se renueva cada diez minutos. No se afirma cubrir todas las oportunidades.

Un SÍ y un NO del mismo contrato Polymarket se reconocen como complementarios por condición y tokens. Las etiquetas originales se conservan (también cuando son nombres de equipos). La similitud de títulos entre plataformas solo genera candidatos, nunca autoriza calcular un pago cubierto.

Para parejas entre plataformas, el motor exige certificados locales en `datos/arbitraje/equivalencias.json`: identificadores a/b, hashes actuales, revisión atribuida, caducidad y semántica idéntica documentada de evento, instante observado, fuente de referencia, predicado, cancelación, disputas y pago. No se creó ningún certificado sin verificar las reglas. USD y pUSD se consideran monedas distintas y bloquean la pareja: no existe aún conversión validada. Las tarifas específicas de Kalshi también permanecen desconocidas en este escáner hasta implementar su validación completa, incluidos overrides por evento. Estos bloqueos son visibles; no se suplen por suposiciones favorables.

## Cálculo y ejecución simulada

- Solo asks ejecutables y profundidad; nunca last price ni midpoint.
- Libros de hasta diez segundos, separados como máximo tres segundos, con validación de token/condición/resultado. US no publica timestamp del snapshot: se registra el inicio de la petición, no la antigüedad garantizada de la cotización en origen. Por tanto esta medición solo sirve para observación.
- Barrido ordenado por precio, hasta 25% de profundidad y 100 pares, respetando presupuesto y mínimos. Para el adaptador internacional se exige el mínimo tanto en acciones como en importe para mantener compatibilidad conservadora entre versiones.
- Comisión US obtenida de `feeCoefficient`, con fórmula C × tarifa × p × (1-p). Se redondea conservadoramente hacia arriba al centavo; US publica redondeo bancario, por lo que esta aproximación puede descartar márgenes pequeños. Se respeta `minimumTradeQty`. El adaptador internacional usa `feesEnabled` y `feeSchedule`. Una tarifa desconocida bloquea la proyección.
- Reserva operativa supuesta de 0,02 unidades nativas por operación simulada. No representa costes operativos completos medidos ni convierte pUSD en dólares.
- Segunda lectura tras al menos un segundo y el retraso declarado por el mercado (máximo diez segundos). Simulación limitada al precio inicial; registra compras parciales, cantidad cubierta, excedentes vendidos a bids y exposición residual valorada a cero en el escenario adverso.
- Prueba de estrés adicional: desaparecen todos los asks de la segunda compra. Puede dar pérdidas y se muestra como tal. No se simula prioridad de cola, competencia ni liquidez oculta.

`qualified` significa margen proyectado positivo dentro de estos supuestos. No implica que la operación haya ocurrido, que el capital esté a salvo o que exista beneficio realizable. Las proyecciones nunca se suman al saldo ni a ganancias realizadas.

## Capital y registros

El escáner informa capital protegido igual al capital configurado y presupuesto real cero. Solo usa ese importe como presupuesto de laboratorio en moneda nativa; no utiliza ganancias ficticias para financiar entradas. Esta separación es informativa mientras no existe ejecutor real; no equivale a retirar fondos de una cuenta externa.

Se guardan `datos/arbitraje/latest.json` y registros JSONL diarios. Los casos con margen positivo incluyen libros iniciales y posteriores para revisión. Un reinicio muestra antigüedad y nunca considera reciente un escaneo de más de dos minutos. Los archivos están excluidos de Git mediante `datos/`.

## Referencias verificadas

- https://docs.polymarket.us/api-reference/introduction
- https://docs.polymarket.us/api-reference/markets/get-markets
- https://docs.polymarket.us/api-reference/markets/get-market-book
- https://docs.polymarket.us/fees

- https://docs.polymarket.com/market-data/prices-order-books
- https://docs.polymarket.com/market-data/market-details
- https://docs.polymarket.com/trading/fees
- https://docs.polymarket.com/api-reference/geoblock
- https://docs.kalshi.com/api-reference/market/get-market-orderbook

Antes de operaciones reales siguen pendientes: elegibilidad de cuenta, equivalencias verificadas, costes completos y conversión, saldo separado por plataforma, pruebas prospectivas, reconciliación de órdenes y recuperación de coberturas incompletas. Ninguna prueba de software acredita rentabilidad.
