# Corrección del mercado — 2026-10-12

market-residual-midpoint-v1. Prueba exploratoria prospectiva, sin órdenes.

Motivo: el candidato anterior exageró ventajas frente al mercado; el filtro de precio no resolvió la diferencia entre probabilidad estimada y resultados. No se considera rentable ninguna variante existente.

Regla fijada antes de evaluar nuevos casos: cinco tramos iguales de probabilidad de mercado. Sobre los últimos 500 contratos comparables con resultado oficial conocido antes de la captura, sumar resultado SÍ menos probabilidad de mercado dentro del tramo actual y dividir entre n+50. Añadir esa corrección a la probabilidad actual de mercado, limitada a [0.001,0.999]. Mínimo 100 contratos totales y 30 del tramo. No se optimizan tramos ni penalización sobre la prueba futura.

Se mantienen las familias de fuentes, reglas y versiones de la captura BTC 15m a mitad del bloque. Cada artefacto guarda entrenamiento, tiempos de resultados, regla y corrección con SHA256. El entrenamiento histórico no cuenta como validación. La corrección aprende sesgo de mercado; no demuestra capacidad para anticipar movimientos ni utiliza información futura.

Evaluación: Brier candidato/mercado en exactamente los mismos contratos oficiales nuevos. Política económica existente, margen y tarifas conservados, neto teórico y estrés adicional de 0.02 USD por entrada. Abstención cuando faltan datos o margen suficiente. No se sustituye modelo activo ni se modifica la prueba de precios anterior. Sin promociones automáticas, dinero real o demo, ni reanudación de automatizaciones.

Visible en Progreso de la IA → Candidato · corrección del mercado. Siete pruebas pasan, incluyendo rechazo de etiquetas futuras, duplicados, ausencia de evaluación retrospectiva, tarifas desconocidas y captura existente.
