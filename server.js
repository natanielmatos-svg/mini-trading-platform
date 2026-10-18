// server.js
// Backend en Node + Express que:
// - Sirve el frontend desde ./public
// - Expone /api/klines   velas OHLCV cacheadas (proxy a Binance, evita CORS)
// - Expone /api/stream   precio en vivo por SSE, alimentado por un WebSocket
//                        compartido hacia Binance
// - Expone /api/breakout análisis de ruptura de la vela en curso
// - Expone /api/stocks/* lo mismo para acciones estadounidenses, vía Alpaca
// - Expone /api/predictions*: analizador de mercados de predicción que agrega
//   Polymarket, Robinhood/Kalshi y Manifold y dice qué opción es más probable

// Antes que nada: los módulos de abajo leen process.env al cargarse, así que
// un .env que llegue después no serviría de nada.
const env = require('./src/env');

const express = require('express');
const path = require('path');

const { getPredictions, getBestAnswer } = require('./src/api');
const { listProviders } = require('./src/providers');
const { getKlines, parseSymbol, parseInterval, parseLimit, INTERVALS } = require('./src/klines');
const { analyzeBreakout } = require('./src/breakout');
const { MarketStream, sseClient } = require('./src/stream');
const { verifySymbols, groups } = require('./src/symbols');
const { fetchAllPrices, listVenues, parseVenues } = require('./src/venues');
const { getVelasConsolidadas } = require('./src/velas-consolidadas');
const volatilidad = require('./src/volatilidad');
const forecast = require('./src/forecast');
const { predecirActivo } = require('./src/prediccion');
const { planDeHorizontes } = forecast;
const calibracion = require('./src/calibracion');

// Los cuantiles conformes son un paseo por todo el histórico prediciendo hacia
// delante: caro para hacerlo en cada petición, y sólo cambia cuando llegan
// velas nuevas. Se cachea por símbolo, intervalo y horizonte.
const stocks = require('./src/stocks');
const alpaca = require('./src/alpaca');
const { consolidate } = require('./src/consolidated');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();
const DEMO_ALWAYS = process.env.DEMO === '1';

// Detrás de Nginx, el cliente real viene en X-Forwarded-For; sin esto el
// limitador de peticiones vería una sola IP (la del proxy) para todo el mundo.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

// Cabeceras de seguridad en la propia app y no sólo en Nginx: así valen también
// cuando alguien arranca el proceso a pelo para probar.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Módulos que comparten servidor y navegador: los indicadores, el formato de
// números y el motor de señales. El navegador carga exactamente el mismo
// archivo que ejecuta el análisis, así que no puede haber dos versiones de la
// misma regla. `chart.js`, `panel-ruptura.js` y `avisos.js` no los usa el
// servidor, pero sí las dos páginas —cripto y acciones—, y viven aquí por el
// mismo motivo: un solo gráfico, un solo panel, un solo gestor de avisos, una
// sola tabla y un solo modo de calmar el precio en vivo.
// Lista blanca explícita y no `express.static('src')`: ahí dentro están
// también los proveedores y la orquestación.
const SHARED_MODULES = ['indicators.js', 'format.js', 'signals.js', 'chart.js', 'panel-ruptura.js', 'avisos.js', 'tabla-mtf.js', 'precio-vivo.js', 'forecast.js', 'panel-prediccion.js', 'panel-probabilidad.js', 'tarjetas.js'];

app.get('/lib/:file', (req, res) => {
  if (!SHARED_MODULES.includes(req.params.file)) {
    return res.status(404).json({ error: 'Ese módulo no se publica al navegador' });
  }
  res.type('application/javascript');
  // Mismo motivo que en la carpeta pública: esto es código.
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'src', req.params.file));
});

// Carpeta pública. El HTML y el JavaScript se revalidan siempre: son el
// código, y cachearlos una hora significa que tras desplegar el navegador
// sigue ejecutando la versión anterior hasta que a alguien se le ocurre forzar
// la recarga. Pasó: se arreglaba un fallo, se desplegaba, y el usuario seguía
// viéndolo. `no-cache` no es «no guardes», es «pregunta antes de usar»: con
// el ETag la respuesta habitual es un 304 de unos pocos bytes.
const publicDir = path.join(__dirname, 'public');
const CODIGO = /\.(html|js)$/;

app.use(
  express.static(publicDir, {
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (CODIGO.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// ---------------------------------------------------------------------------
// Límite de peticiones
// ---------------------------------------------------------------------------

// Ventana deslizante por IP, en memoria. No pretende frenar un ataque serio
// —para eso está el proxy de delante— sino evitar que un bucle descontrolado
// del navegador de alguien acabe agotando los rate limits de las APIs ajenas.
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000);
const RATE_MAX = Number(process.env.RATE_MAX || 120);
// Las conexiones SSE son largas y escasas: se limitan por número simultáneo,
// no por frecuencia, que es lo que de verdad consume recursos del servidor.
const MAX_STREAMS_PER_IP = Number(process.env.MAX_STREAMS_PER_IP || 6);

const hits = new Map();
const streamsByIp = new Map();

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, stamps] of hits) {
    const live = stamps.filter((t) => t > cutoff);
    if (live.length) hits.set(ip, live);
    else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

function rateLimit(req, res, next) {
  const bucket=require('./src/request-bucket').bucket(req.method,req.path);
  if(bucket==='stream')return next(); // Concurrent stream limit applies in its route.
  const ip = (req.ip || 'desconocida')+'|'+bucket;
  const now = Date.now();
  const stamps = (hits.get(ip) || []).filter((t) => t > now - RATE_WINDOW_MS);

  if (stamps.length >= RATE_MAX) {
    res.setHeader('Retry-After', Math.ceil(RATE_WINDOW_MS / 1000));
    return res.status(429).json({
      error: 'Demasiadas peticiones',
      details: `Máximo ${RATE_MAX} por ${RATE_WINDOW_MS / 1000} s. Espera un momento.`,
    });
  }

  stamps.push(now);
  hits.set(ip, stamps);
  next();
}

app.use('/api', rateLimit);

// ---------------------------------------------------------------------------
// Salud
// ---------------------------------------------------------------------------

const stream = new MarketStream({ demo: DEMO_ALWAYS });

// Comprobación de vida: no llama a ninguna API externa a propósito, para que
// una caída de Polymarket no haga que el supervisor reinicie el servicio.
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    version: require('./package.json').version,
    demo: DEMO_ALWAYS,
    streams: stream.stats(),
  });
});

// ---------------------------------------------------------------------------
// Mercado: velas, ruptura y precio en vivo
// ---------------------------------------------------------------------------

function marketParams(req) {
  return {
    symbol: parseSymbol(req.query.symbol),
    interval: parseInterval(req.query.interval),
    demo: DEMO_ALWAYS || req.query.demo === '1',
  };
}

function sendJson(res, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.json(payload);
}

function marketError(res, err, what) {
  console.error(`Error en ${what}:`, err.message);
  res.status(502).json({ error: `No se pudieron obtener los datos de mercado (${what})`, details: err.message });
}

// Velas OHLCV. A diferencia de la versión anterior esto ya no es un proxy
// transparente: la respuesta viene cacheada y normalizada. `format=raw`
// devuelve el array posicional de Binance para lo que aún espere aquel formato.
app.get('/api/klines', async (req, res) => {
  const { symbol, interval, demo } = marketParams(req);
  const limit = parseLimit(req.query.limit);

  try {
    const data = await getKlines({ symbol, interval, limit, demo });

    if (req.query.format === 'raw') {
      return sendJson(
        res,
        data.candles.map((c) => [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.closeTime])
      );
    }

    sendJson(res, { ...data, count: data.candles.length, intervals: INTERVALS });
  } catch (err) {
    marketError(res, err, '/api/klines');
  }
});

// Criptomonedas del desplegable. Cuando hay red se contrasta con Binance para
// no ofrecer un par que haya dejado de cotizar.
app.get('/api/symbols', async (req, res) => {
  const demo = DEMO_ALWAYS || req.query.demo === '1';
  const { symbols, verified, reason } = await verifySymbols({ demo });
  const disponibles = new Set(symbols.filter((s) => s.available !== false).map((s) => s.symbol));

  sendJson(res, {
    verified,
    reason,
    count: symbols.length,
    groups: groups().map((g) => ({
      name: g.name,
      symbols: g.symbols
        .map((s) => ({ ...s, available: !verified || disponibles.has(s.symbol) }))
        .filter((s) => s.available),
    })),
  });
});

// Catálogo de mercados. No sale a la red: la interfaz necesita poder pintar el
// selector aunque no haya precios, que es justo cuando hace falta cambiarlo.
app.get('/api/venues', (req, res) => {
  sendJson(res, { venues: listVenues() });
});

// Precio consolidado de los mercados al contado. Devuelve el número y, sobre
// todo, el detalle: cuánto se separa cada mercado. Esa diferencia es la razón
// de que este endpoint exista.
app.get('/api/price', async (req, res) => {
  const { symbol, demo } = marketParams(req);
  const venues = parseVenues(req.query.venues);

  try {
    const standardBtc = symbol==='BTCUSDT' && !demo && venues && [...venues].sort().join(',')===[...timingVenues].sort().join(',');
    const quotes = await (standardBtc ? timingPrices({symbol,venues}) : fetchAllPrices({ symbol, demo, venues }));
    sendJson(res, { symbol, requested: venues, ...consolidate(quotes), venuesSupported: listVenues() });
  } catch (err) {
    marketError(res, err, '/api/price');
  }
});

const timingCache = new (require('./src/cache').TtlCache)({ttlMs:1000,maxEntries:4});
const timingVenues = require('./src/price-timing').VENUES;
function timingPrices(options) {
  return timingCache.wrap('BTCUSDT',()=>fetchAllPrices({...options,symbol:'BTCUSDT',venues:timingVenues}));
}
const lagLabModule=require('./src/kalshi-lag-lab');
const lagLab=lagLabModule.create({dir:path.join(__dirname,'datos','diagnosticos','kalshi-lag')});
const priceTiming = require('./src/price-timing').createSampler({
  prices:timingPrices,
  reference:options=>require('./src/kalshi-reference').getReference(options),
  market:lagLabModule.createMarketReader(),
  onSample:row=>lagLab.observe(row),
  dir:path.join(__dirname,'datos','diagnosticos','timing'),
});
app.get('/api/price-timing', (req,res)=>sendJson(res,priceTiming.status()));
app.get('/api/kalshi-lag', (req,res)=>sendJson(res,{...lagLab.snapshot(),sampler:priceTiming.status()}));

app.get('/api/reference', async (req, res) => {
  const { symbol, demo } = marketParams(req);
  try { sendJson(res, await require('./src/kalshi-reference').getReference({ symbol, demo })); }
  catch (err) { marketError(res, err, '/api/reference'); }
});

app.get('/api/system-status', (req, res) => {
  sendJson(res, {
    demo: DEMO_ALWAYS,
    demoBot: require('./src/demo-bot-control').status(),
    control: {...require('./src/bot-control').read(),paused:require('./src/trading-settings').read().paused},
    bot: { ...require('./src/bot-runtime').read(), liveOrders: false },
    agent: { configured: Boolean(process.env[require('./src/agente').PROVEEDOR === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY']), provider: require('./src/agente').PROVEEDOR, role: 'Solo puede vetar operaciones', model: require('./src/agente').MODELO },
    reference: { configured: Boolean(process.env.KALSHI_API_KEY_ID && process.env.KALSHI_PRIVATE_KEY_PATH) },
  });
});


app.post('/api/bot-control', express.json({limit:'1kb'}), async(req,res)=>{
  const expected='http://'+req.get('host');let hostname='';try{hostname=new URL(expected).hostname;}catch{}
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['localhost','127.0.0.1','[::1]'].includes(hostname)||req.get('origin')!==expected||!req.is('application/json'))return res.status(403).json({error:'Solo se permite controlar desde esta app local'});
  if(DEMO_ALWAYS)return res.status(409).json({error:'Controles no disponibles en el servidor demo'});
  try{if(req.body?.scope==='demo-bot')return res.json({control:require('./src/demo-bot-control').command(req.body?.action),liveEnabled:false});const control=await require('./src/bot-control').command(req.body?.action);res.json({control,liveEnabled:false});}
  catch(e){res.status(409).json({error:e.message});}
});

app.get('/api/arbitrage', (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try { res.json(require('./src/arbitrage-scanner').snapshot()); }
  catch { res.status(503).json({error:'No se pudo verificar el escáner de arbitraje',liveEnabled:false}); }
});

app.get('/api/evidence', (req,res)=>{
  try { sendJson(res, { ...require('./src/evidencia').leerResumen(), bot: require('./src/bot-runtime').read() }); }
  catch { res.status(503).json({error:'No se pudo verificar el registro de evidencia'}); }
});

const proposalReview=require('./src/proposal-review').create();
const prepareSupervisedTicket=require('./src/supervised-ticket').create({proposals:proposalReview});
function proposalLocal(req,res,next){let host='';try{host=new URL('http://'+req.get('host')).hostname;}catch{}
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['localhost','127.0.0.1','[::1]'].includes(host))return res.status(403).json({error:'Solo disponible localmente'});
 res.setHeader('Cache-Control','no-store');next();}
app.get('/api/proposals',proposalLocal,(req,res)=>{try{res.json(proposalReview.snapshot());}catch{res.status(503).json({error:'No se pudo verificar el registro de propuestas',liveEnabled:false});}});
app.get('/api/proposals/:id/ticket',proposalLocal,async(req,res)=>{
 if(DEMO_ALWAYS)return res.status(409).json({error:'Ficha real no disponible en demo'});
 try{res.json(await prepareSupervisedTicket(req.params.id));}catch{res.status(409).json({error:'No se pudo preparar la ficha. Actualiza las propuestas y vuelve a intentarlo.'});}
});
app.get('/api/kalshi-threshold',async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(DEMO_ALWAYS)return res.json({ok:false,contracts:[],reason:'Umbral real no disponible en demo.'});
 try{res.json(await require('./src/kalshi-threshold').get({symbol:String(req.query.symbol||'BTCUSDT'),interval:String(req.query.interval||'15m')}));}
 catch{res.status(503).json({ok:false,contracts:[],reason:'No se pudo consultar el umbral oficial de Kalshi.'});}
});
app.post('/api/proposals/review',proposalLocal,express.json({limit:'2kb'}),(req,res)=>{
 if(DEMO_ALWAYS||req.get('origin')!=='http://'+req.get('host')||!req.is('application/json'))return res.status(403).json({error:'Revisión permitida solo desde la app local'});
 try{res.json({review:proposalReview.review(req.body?.id,req.body?.action),liveEnabled:false});}catch(e){res.status(409).json({error:e.message,liveEnabled:false});}
});

app.get('/api/kalshi-account',async(req,res)=>{
 let hostname='';try{hostname=new URL('http://'+req.get('host')).hostname;}catch{}
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['localhost','127.0.0.1','[::1]'].includes(hostname))return res.status(403).json({error:'Cuenta disponible solo localmente'});
 res.setHeader('Cache-Control','no-store');
 if(DEMO_ALWAYS)return res.status(409).json({error:'Cuenta real no disponible en demo'});
 try{res.json(await require('./src/kalshi-account').snapshot());}catch{res.status(503).json({error:'No se pudo consultar la cuenta. Revisa conexión y permisos de lectura.'});}
});

app.get('/api/production-readiness', async(req,res)=>{
  let hostname='';try{hostname=new URL('http://'+req.get('host')).hostname;}catch{}
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['localhost','127.0.0.1','[::1]'].includes(hostname))return res.status(403).json({error:'Consulta disponible solo localmente'});
  res.setHeader('Cache-Control','no-store');
  try{
    const service=require('./src/production-readiness');
    const account=DEMO_ALWAYS?{ok:false,reason:'Servidor demo'}:await service.account();
    res.json(service.assess({config:require('./src/trading-settings').read(),bot:require('./src/bot-runtime').read(),learning:learningService().snapshot(),account,demo:DEMO_ALWAYS}));
  }catch{res.status(503).json({ready:false,liveEnabled:false,error:'No se pudo comprobar la preparación; no asumir disponibilidad.'});}
});

app.get('/api/trading-settings', (req,res)=>{
  try { const settings=require('./src/trading-settings');const config=settings.read();sendJson(res,{config,liveEnabled:false,blockers:settings.blockers(config)}); }
  catch { res.status(503).json({error:'No se pudo leer la configuración'}); }
});
app.put('/api/trading-settings', (req,res,next)=>{
  const remote=req.socket.remoteAddress;
  const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote);
  const expected='http://'+req.get('host');
  let hostname='';try{hostname=new URL(expected).hostname;}catch{}
  if(!local||!['localhost','127.0.0.1','[::1]'].includes(hostname)||req.get('origin')!==expected||!req.is('application/json'))return res.status(403).json({error:'Solo se permite guardar desde esta app local'});
  next();
},express.json({limit:'4kb'}),(req,res)=>{
  try {const settings=require('./src/trading-settings');const config=settings.save(req.body);res.json({config,liveEnabled:false,blockers:settings.blockers(config)});}
  catch(e){res.status(400).json({error:e.message});}
});

let closeLearner;
function learningService(){
  if(!closeLearner)closeLearner=require('./src/close-learning').create({
    asyncPersistence:true,
    pilot:require('./src/btc15m-capture').create({backgroundReplay:true,book:(ticker,options)=>require('./src/kalshi-market-feed').obtener(ticker,options),brti:{reference:()=>require('./src/kalshi-reference').getReference({symbol:'BTCUSDT'}),fees:m=>require('./src/brti-prospective').feesFor(m)}}),
    minuteLab:require('./src/timesfm-minute-lab').create({getData:target=>velasDelAnalisis({...target,demo:false}),predict:require('./src/forecast-neural').predictExperiment}),
    getData:target=>velasDelAnalisis({...target,limit:400,demo:false,venues:null}),
    getReference:target=>require('./src/kalshi-reference').getReference(target),
    predict:data=>require('./src/forecast-neural').forecast(data),
  });
  return closeLearner;
}
const learningViewCache=new (require('./src/cache').TtlCache)({ttlMs:5000,maxEntries:1});
app.get('/api/learning', async (req,res)=>{
  res.set('Cache-Control','no-store');
  try{const snapshot=await learningViewCache.wrap('view',()=>({...learningService().snapshot(),viewGeneratedAt:Date.now()}));res.json({...snapshot,marketFeed:require('./src/kalshi-market-feed').status(),feePolicy:require('./src/kalshi-fee-policy').status()});}catch{res.status(503).json({error:'Aprendizaje no disponible'});}
});
app.get('/api/neural-forecast', async (req, res) => {
  const isStocks = req.query.market === 'stocks';
  const { symbol, interval, demo } = isStocks ? stockParams(req) : marketParams(req);
  try {
    let data; let clock = null;
    if (isStocks) {
      clock = await stocks.getClock({ demo });
      data = await stocks.getStockCandles({ symbol, interval, limit: 400, demo });
      if(clock?.isOpen&&!demo&&data.candles?.length){const sessions=require('./src/stock-neural-session');data.calendar=await require('./src/alpaca').fetchCalendar(sessions.dateNY(data.candles[0].openTime),sessions.dateNY(Date.now()));}
    } else {
      data = await velasDelAnalisis({ symbol, interval, limit: 400, demo, venues: parseVenues(req.query.venues) });
    }
    const result = await require('./src/forecast-neural').forecast({ ...data, symbol, interval, source: data.source || data.fuente }, { market: isStocks ? 'stocks' : 'crypto', clock });
    try { result.prospective = require('./src/neural-evidence').record(result, { ...data, symbol, interval }); }
    catch { result.evidenceWarning = 'No se pudo guardar la evaluación prospectiva.'; }
    if(!isStocks&&!demo){
      try{const learner=learningService();learner.watch({symbol,interval});learner.ingest({symbol,interval},data,null,result);result.learning=learner.snapshot();}
      catch{result.learningWarning='No se pudo registrar el aprendizaje del cierre.';}
    }
    sendJson(res, result);
  } catch (err) {
    sendJson(res, { ok: false, reason: err.message });
  }
});

// De dónde salen las velas del análisis.
//
// Por defecto, de la mediana de los mercados elegidos: si el titular enseña un
// precio consolidado y el análisis mide sobre Binance, la distancia al nivel
// —que es de lo que depende una señal de compra— está en otra escala que el
// precio que se está mirando.
//
// Si no hay consolidado utilizable se vuelve a Binance y se DICE cuál se usó,
// en vez de servir una serie coja o callarse el cambio.
async function velasDelAnalisis({ symbol, interval, demo, venues, limit = 400 }) {
  if (demo) {
    const { candles, source, fetchedAt } = await getKlines({ symbol, interval, limit, demo });
    return { candles, fuente: source, fetchedAt, consolidado: null };
  }

  const consolidado = await getVelasConsolidadas({ symbol, interval, limit, venues }).catch((err) => ({
    ok: false,
    candles: [],
    venues: [],
    usados: 0,
    motivo: err.message,
  }));

  if (consolidado.ok) {
    return {
      candles: consolidado.candles,
      fuente: 'consolidado',
      fetchedAt: Date.now(),
      consolidado: { usados: consolidado.usados, venues: consolidado.venues, stable: consolidado.stable, motivo: null },
    };
  }

  const { candles, source, fetchedAt } = await getKlines({ symbol, interval, limit, demo });
  return {
    candles,
    fuente: source,
    fetchedAt,
    consolidado: { usados: consolidado.usados, venues: consolidado.venues, stable: null, motivo: consolidado.motivo },
  };
}

// La volatilidad va como una señal más del contexto, que es donde la interfaz
// ya sabe pintar cosas así, y el detalle completo viaja aparte para quien
// quiera el número. Lo usan las dos páginas: una vela de Apple se mueve mucho
// o poco por las mismas razones que una de bitcoin.
function conVolatilidad(analysis, candles, interval) {
  const vol = volatilidad.medir(candles, interval);
  if (!vol.ok) return { ok: false, reason: vol.reason };
  if (!analysis.ok) return vol;

  analysis.context = [
    ...(analysis.context || []),
    {
      // "Volatilidad" a secas ya lo usa el factor del ATR contra su media, que
      // dice otra cosa: si la vela de AHORA se mueve más que las últimas 50.
      // Éste sitúa el régimen en el histórico largo. Dos nombres iguales en la
      // misma lista sólo confunden.
      label: 'Volatilidad anualizada',
      lean: 'neutral',
      text:
        `${(vol.anualizada * 100).toFixed(vol.anualizada < 0.1 ? 1 : 0)}% anual realizada, en ` +
        `${vol.regimen}${vol.percentil !== null ? ` (percentil ${Math.round(vol.percentil * 100)})` : ''}. ` +
        (vol.regimen === 'tensión'
          ? 'Con la volatilidad alta los niveles se rompen más, y también se devuelven más.'
          : vol.regimen === 'calma'
            ? 'Con la volatilidad baja hacen falta menos recorridos grandes, así que las rupturas son más raras.'
            : 'Ni calma ni tensión: el recorrido típico es el de siempre.'),
    },
  ];
  return vol;
}

// Análisis de ruptura de la vela en curso: niveles, distancia en ATR y la
// frecuencia histórica de recorridos equivalentes. El método está explicado en
// la cabecera de src/breakout.js y en el README.
app.get('/api/breakout', async (req, res) => {
  const { symbol, interval, demo } = marketParams(req);
  const livePrice = Number(req.query.price);
  const venues = parseVenues(req.query.venues);

  try {
    const { candles, fuente, fetchedAt, consolidado } = await velasDelAnalisis({ symbol, interval, demo, venues });
    const analysis = analyzeBreakout(candles, {
      interval,
      livePrice: Number.isFinite(livePrice) && livePrice > 0 ? livePrice : null,
    });

    const vol = conVolatilidad(analysis, candles, interval);
    sendJson(res, { symbol, interval, source: fuente, fetchedAt, consolidado, volatilidad: vol, ...analysis });
  } catch (err) {
    marketError(res, err, '/api/breakout');
  }
});

// Las mismas velas que usa el análisis, para el gráfico. Sin esto el gráfico
// pintaría Binance y el panel hablaría de niveles consolidados: dos escalas en
// la misma pantalla.
app.get('/api/klines/consolidadas', async (req, res) => {
  const { symbol, interval, demo } = marketParams(req);
  const limit = parseLimit(req.query.limit);
  const venues = parseVenues(req.query.venues);

  try {
    const { candles, fuente, fetchedAt, consolidado } = await velasDelAnalisis({ symbol, interval, demo, venues, limit });
    if(req.query.compact==='1')return sendJson(res,{symbol,interval,source:fuente,fetchedAt,count:candles.length,candles:candles.map(({openTime,closeTime,open,high,low,close,closed})=>({openTime,closeTime,open,high,low,close,closed}))});
    sendJson(res, { symbol, interval, source: fuente, fetchedAt, consolidado, count: candles.length, candles });
  } catch (err) {
    marketError(res, err, '/api/klines/consolidadas');
  }
});

// Precio en vivo por SSE. El servidor mantiene una sola conexión con Binance
// por símbolo+timeframe y la reparte; ver src/stream.js.
app.get('/api/stream', (req, res) => {
  const { symbol, interval } = marketParams(req);
  const ip = req.ip || 'desconocida';
  const open = streamsByIp.get(ip) || 0;

  if (open >= MAX_STREAMS_PER_IP) {
    return res.status(429).json({
      error: 'Demasiadas conexiones en vivo',
      details: `Máximo ${MAX_STREAMS_PER_IP} simultáneas por IP. Cierra alguna pestaña.`,
    });
  }

  streamsByIp.set(ip, open + 1);
  const client = sseClient(res);
  const unsubscribe = stream.subscribe(symbol, interval, client);

  client.send('status', { symbol, interval, state: 'conectado', message: `Suscrito a ${symbol} ${interval}` });

  client.onGone(() => {
    unsubscribe();
    const left = (streamsByIp.get(ip) || 1) - 1;
    if (left > 0) streamsByIp.set(ip, left);
    else streamsByIp.delete(ip);
  });
});

// ---------------------------------------------------------------------------
// Predicción
// ---------------------------------------------------------------------------
//
// No devuelve un precio: devuelve la DISTRIBUCIÓN. A quince minutos vista la
// mejor estimación puntual honesta es el precio de ahora, y cualquier número
// que se aparte de él con aire de seguridad está inventado. Lo que sí se puede
// estimar —y se puede comprobar— es dónde caerá el precio con cada
// probabilidad.
//
// Y viene con su propia nota: cada respuesta trae la calibración medida sobre
// el histórico, es decir, si las bandas que promete se cumplen de verdad. Un
// predictor que publica su propio boletín de notas.

app.get('/api/activity/stream', (req, res) => {
  const ip=req.ip, open=streamsByIp.get(ip)||0;
  if(open>=MAX_STREAMS_PER_IP)return res.status(429).json({error:'Demasiadas conexiones en vivo'});
  streamsByIp.set(ip,open+1);
  const events=require('./src/learning-events'),client=sseClient(res);
  const unsubscribe=events.subscribe(event=>{
    // Disconnect slow consumers instead of accumulating unbounded UI telemetry.
    if(res.writableLength>65536){client.close();return;}
    client.send('activity',event);
  });
  client.onGone(()=>{unsubscribe();const left=(streamsByIp.get(ip)||1)-1;if(left>0)streamsByIp.set(ip,left);else streamsByIp.delete(ip);});
  client.send('snapshot',events.snapshot());
});

app.get('/api/forecast', async (req, res) => {
  const { symbol, interval, demo } = marketParams(req);
  const venues = parseVenues(req.query.venues);
  const livePrice = Number(req.query.price);
  const nivel = Number(req.query.nivel) > 0 ? Number(req.query.nivel) : null;

  try {
    const plan = planDeHorizontes(interval);
    const necesarios = [...new Set(plan.map((h) => h.interval))];

    // Una serie por intervalo, no una por horizonte.
    const series = {};
    await Promise.all(necesarios.map(async (tf) => {
      const r = await velasDelAnalisis({ symbol, interval: tf, demo, venues });
      series[tf] = r;
    }));

    const base = series[interval] || series[necesarios[0]];
    const precio = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : base.candles.at(-1)?.close;

    const predicciones = [];
    for (const h of plan) {
      const s = series[h.interval];
      if (!s || !s.candles.length) continue;
      predicciones.push({
        bloques: h.bloques,
        ms: h.ms,
        desde: h.interval,
        ...(await predecirActivo({ candles: s.candles, interval: h.interval, precio, bloques: h.bloques, nivel })),
      });
    }

    sendJson(res, {
      symbol, interval, source: base.fuente, fetchedAt: base.fetchedAt,
      precio: precio || base.candles[base.candles.length - 1].close,
      horizontes: predicciones,
      aviso: forecast.AVISO,
    });
  } catch (err) {
    marketError(res, err, '/api/forecast');
  }
});

app.get('/api/stocks/forecast', async (req, res) => {
  const { symbol, interval, demo } = stockParams(req);
  const nivel = Number(req.query.nivel) > 0 ? Number(req.query.nivel) : null;

  try {
    const plan = planDeHorizontes(interval);
    const necesarios = [...new Set(plan.map((h) => h.interval))];

    const [series, clock] = await Promise.all([
      Promise.all(necesarios.map((tf) => stocks.getStockCandles({ symbol, interval: tf, limit: 400, demo })))
        .then((rs) => Object.fromEntries(rs.map((r, i) => [necesarios[i], r]))),
      stocks.getClock({ demo }).catch(() => null),
    ]);

    const { candles } = series[interval] || series[necesarios[0]];

    const predicciones = [];
    for (const h of plan) {
      const s = series[h.interval];
      if (!s || !s.candles.length) continue;
      predicciones.push({
        bloques: h.bloques,
        ms: h.ms,
        desde: h.interval,
        ...(await predecirActivo({ candles: s.candles, interval: h.interval, precio: null, bloques: h.bloques, nivel })),
      });
    }

    sendJson(res, {
      symbol, interval, clock,
      precio: candles.length ? candles[candles.length - 1].close : null,
      horizontes: predicciones,
      aviso: forecast.AVISO,
    });
  } catch (err) {
    marketError(res, err, '/api/stocks/forecast');
  }
});

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
//
// El análisis es el mismo —las velas de bolsa tienen la misma forma—, así que
// estas rutas no repiten la lógica: piden velas a src/stocks y se las pasan a
// analyzeBreakout, igual que /api/breakout.
//
// Lo que sí cambia es que la bolsa cierra, y por eso el reloj va en la
// respuesta de la ruptura: sin él la interfaz enseñaría una cuenta atrás hacia
// el cierre de una vela que no se va a mover hasta el lunes.

function stockParams(req) {
  return {
    symbol: stocks.parseTicker(req.query.symbol),
    interval: alpaca.parseInterval(req.query.interval),
    demo: DEMO_ALWAYS || req.query.demo === '1',
  };
}

// Tickers del desplegable. No sale a la red: es una lista fija, igual que la
// de criptos, y la interfaz tiene que poder pintarla sin clave.
app.get('/api/stocks/symbols', (req, res) => {
  sendJson(res, {
    conClave: alpaca.hayClave(),
    feed: alpaca.FEED,
    count: stocks.CATALOG.length,
    groups: stocks.stockGroups(),
    intervals: Object.keys(alpaca.TIMEFRAMES),
  });
});

// Reloj del mercado: abierto o cerrado, y cuándo cambia.
app.get('/api/stocks/clock', async (req, res) => {
  try {
    sendJson(res, await stocks.getClock({ demo: DEMO_ALWAYS || req.query.demo === '1' }));
  } catch (err) {
    marketError(res, err, '/api/stocks/clock');
  }
});

app.get('/api/stocks/candles', async (req, res) => {
  const { symbol, interval, demo } = stockParams(req);
  const limit = parseLimit(req.query.limit);

  try {
    const data = await stocks.getStockCandles({ symbol, interval, limit, demo });
    sendJson(res, { ...data, count: data.candles.length, intervals: Object.keys(alpaca.TIMEFRAMES) });
  } catch (err) {
    marketError(res, err, '/api/stocks/candles');
  }
});

// Precio ahora. Sin consolidar entre mercados como en cripto: aquí la cinta
// consolidada es un producto licenciado y el feed gratuito es de un solo
// mercado, así que la respuesta dice de cuál viene en vez de aparentar que es
// el precio oficial.
app.get('/api/stocks/quote', async (req, res) => {
  const { symbol, demo } = stockParams(req);

  try {
    sendJson(res, await stocks.getStockQuote({ symbol, demo }));
  } catch (err) {
    marketError(res, err, '/api/stocks/quote');
  }
});

app.get('/api/stocks/breakout', async (req, res) => {
  const { symbol, interval, demo } = stockParams(req);
  const livePrice = Number(req.query.price);

  try {
    const [{ candles, source, fetchedAt, aviso }, clock] = await Promise.all([
      stocks.getStockCandles({ symbol, interval, limit: 400, demo }),
      stocks.getClock({ demo }).catch(() => null),
    ]);

    const analysis = analyzeBreakout(candles, {
      interval,
      livePrice: Number.isFinite(livePrice) && livePrice > 0 ? livePrice : null,
      // Si el mercado está cerrado, la última vela ya cerró: el análisis lo
      // dice en vez de hablar de una vela en curso a la que "le queda nada".
      mercadoCerrado: Boolean(clock) && !clock.isOpen,
    });

    const vol = conVolatilidad(analysis, candles, interval);
    sendJson(res, { symbol, interval, source, fetchedAt, aviso: aviso || null, clock, volatilidad: vol, ...analysis });
  } catch (err) {
    marketError(res, err, '/api/stocks/breakout');
  }
});

// ---------------------------------------------------------------------------
// Analizador de mercados de predicción
// ---------------------------------------------------------------------------

// Cuántos eventos se piden a cada plataforma. Es una constante del servidor, no
// un parámetro de la petición: si el cliente pudiera elegirlo, cada valor sería
// una clave de caché distinta y bastaría recorrerlos para multiplicar por
// doscientas las llamadas a las APIs ajenas.
const FETCH_LIMIT = Math.min(Number(process.env.PREDICTIONS_FETCH_LIMIT || 120), 200);

function parseOptions(req) {
  const platforms = String(req.query.platforms || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const toInt = (value, fallback, max) => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return max ? Math.min(n, max) : n;
  };

  const threshold = Number(req.query.threshold);

  return {
    query: String(req.query.q || req.query.query || '').trim().slice(0, 120),
    platforms: platforms.length ? platforms : null,
    limit: toInt(req.query.limit, 25, 100),
    fetchLimit: FETCH_LIMIT,
    minLiquidity: Math.max(Number(req.query.minLiquidity) || 0, 0),
    threshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : 0.5,
    demo: DEMO_ALWAYS || req.query.demo === '1',
  };
}

function sendPredictionJson(res, payload) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json(payload);
}

function handleError(res, err) {
  console.error('Error en /api/predictions:', err);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(502).json({
    error: 'No se pudo completar el análisis de predicciones',
    details: err.message,
  });
}

// Lista de plataformas soportadas y su credibilidad asignada.
app.get('/api/predictions/sources', (req, res) => {
  sendPredictionJson(res, { providers: listProviders(), demo: DEMO_ALWAYS });
});

// Respuesta directa: la opción más probable del evento que mejor casa con ?q=
app.get('/api/predictions/best', async (req, res) => {
  try {
    sendPredictionJson(res, await getBestAnswer(parseOptions(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// Análisis completo: eventos agrupados entre plataformas con ranking de opciones.
app.get('/api/predictions', async (req, res) => {
  try {
    sendPredictionJson(res, await getPredictions(parseOptions(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Arranque y parada
// ---------------------------------------------------------------------------

// Sólo se escucha cuando el archivo se ejecuta directamente. Al requerirlo
// —los tests lo hacen— se obtiene la app sin puerto ni manejadores de señal,
// que es lo que permite levantarla en un puerto efímero y cerrarla.
function start(port = PORT) {
  const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
    const address = server.address();
    console.log(`Servidor escuchando en http://localhost:${address.port}`);
    console.log('Criptomonedas: /index.html');
    console.log('Acciones:      /acciones.html');
    console.log('Predicciones:  /predicciones.html');

    if (env.cargado) {
      console.log(`\nConfiguración leída de ${env.RUTA}`);
      if (env.arreglado) console.log(`(estaba en ${env.arreglado}; se ha leído igual, pero UTF-8 sin BOM da menos guerra)`);
    }
    else if (env.motivo && env.motivo !== 'no hay .env') console.log(`\nAviso: ${env.motivo}`);

    // Sin clave de Alpaca la página de acciones arranca igual, pero con datos
    // de ejemplo: mejor decirlo aquí que dejar que se descubra mirando un
    // gráfico que no es de nadie.
    if (!alpaca.hayClave()) {
      console.log('Sin clave de Alpaca: /acciones.html usará datos de ejemplo. `npm run alpaca` explica cómo ponerla.');
    }
    if (DEMO_ALWAYS) console.log('MODO DEMO activo: datos de ejemplo, no precios reales.');
    if (require.main === module && !DEMO_ALWAYS) { require('./src/arbitrage-scanner').start(); priceTiming.start(); }
    if (require.main === module && !DEMO_ALWAYS) { try { learningService().start(); } catch { console.error('No se pudo iniciar aprendizaje local'); } }
  });

  // systemd y Docker mandan SIGTERM al reiniciar: se deja terminar lo que hay
  // en vuelo en vez de cortar respuestas a medias. Las conexiones SSE son
  // eternas por definición, así que ésas se cierran a mano o el proceso no
  // saldría nunca.
  async function shutdown(signal) {
    console.log(`${signal} recibido, cerrando...`);
    stream.closeAll();
    require('./src/arbitrage-scanner').stop();
    try{await closeLearner?.stop();}catch{console.error('No se pudo finalizar el guardado de aprendizaje');}
    require('./src/kalshi-market-feed').close();
    priceTiming.stop();
    const neural = require.cache[require.resolve('./src/forecast-neural')];
    if (neural) neural.exports.stop();
    server.close(() => {
      console.log('Servidor cerrado.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Cierre forzado tras 10 s de espera.');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) start();

module.exports = app;
module.exports.start = start;
module.exports.stream = stream;
