'use strict';

// Adaptador al contrato interno del agente. Nunca ejecuta funciones del modelo.
function convertir(respuesta, { busqueda = false, nombres = [] } = {}) {
  if (respuesta.status !== 'completed' || !Array.isArray(respuesta.output) || !respuesta.output.length) {
    throw new Error('respuesta del agente incompleta');
  }
  const content = [];
  let busco = false;
  for (const item of respuesta.output) {
    if (item.type === 'web_search_call') {
      if (item.status !== 'completed') throw new Error('La búsqueda de contexto falló');
      busco = true;
    } else if (item.type === 'function_call') {
      if (!nombres.includes(item.name)) throw new Error('herramienta del agente no permitida');
      let input;
      try { input = JSON.parse(item.arguments); }
      catch { throw new Error('argumentos del agente inválidos'); }
      content.push({ type: 'tool_use', name: item.name, input });
    } else if (item.type === 'message') {
      if (item.status && item.status !== 'completed') throw new Error('respuesta del agente incompleta');
      for (const part of item.content || []) {
        if (part.type === 'refusal') throw new Error('el modelo declinó responder');
        if (part.type === 'output_text' && part.text?.trim()) content.push({ type: 'text', text: part.text });
      }
    } else if (item.type !== 'reasoning') {
      throw new Error('respuesta del agente no verificable');
    }
  }
  if (busqueda && !busco) throw new Error('El agente no verificó el contexto con búsqueda web');
  if (!content.length) throw new Error('respuesta del agente vacía');
  return { stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content };
}

function cliente({ fetchImpl = globalThis.fetch } = {}) {
  return { messages: { async create(req) {
    if (!process.env.OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY');
    const busqueda = req.tools.some(t => t.name === 'web_search');
    const funciones = req.tools.filter(t => t.input_schema);
    const body = {
      model: req.model,
      store: false,
      instructions: req.system + (busqueda ? '\nDebes buscar en la web antes de decidir. Verifica fechas y fuentes; si faltan datos actuales, veta por falta de contexto verificable.' : ''),
      input: req.messages,
      max_output_tokens: 4000,
      tools: funciones.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: true })),
    };
    if (busqueda) body.tools.unshift({ type: 'web_search', search_context_size: 'low' });
    if (req.output_config?.effort) body.reasoning = { effort: req.output_config.effort };
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    });
    // No propagar mensajes del proveedor que puedan contener credenciales.
    if (!response.ok) throw new Error('OpenAI: solicitud rechazada (HTTP ' + response.status + ')');
    let data;
    try { data = await response.json(); } catch { throw new Error('OpenAI: respuesta inválida'); }
    return convertir(data, { busqueda, nombres: funciones.map(t => t.name) });
  } } };
}

module.exports = { cliente, convertir };
