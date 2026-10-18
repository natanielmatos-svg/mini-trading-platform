'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { convertir, cliente } = require('../src/agente-openai');
const message = { type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Sin objeciones.' }] };
const search = { type: 'web_search_call', status: 'completed' };
const response = output => ({ status: 'completed', output });

test('una respuesta vacía, truncada o rechazada nunca libera al bot', () => {
  for (const r of [{ status: 'incomplete', output: [message] }, response([]), response([{ type: 'reasoning' }]), response([{ type: 'message', content: [{ type: 'refusal' }] }])]) {
    assert.throws(() => convertir(r));
  }
});
test('contexto actual exige una búsqueda terminada', () => {
  assert.throws(() => convertir(response([message]), { busqueda: true }), /búsqueda/);
  assert.throws(() => convertir(response([{ ...search, status: 'failed' }, message]), { busqueda: true }), /falló/);
  assert.equal(convertir(response([search, message]), { busqueda: true }).stop_reason, 'end_turn');
});
test('rechaza herramientas ajenas y argumentos malformados', () => {
  assert.throws(() => convertir(response([{ type: 'function_call', name: 'comprar', arguments: '{}' }]), { nombres: ['vetar'] }), /permitida/);
  assert.throws(() => convertir(response([{ type: 'function_call', name: 'vetar', arguments: '{' }]), { nombres: ['vetar'] }), /inválidos/);
  const veto = { motivo: 'evento', alcance: 'todo', objetivo: '', minutos: 30 };
  const r = convertir(response([{ type: 'function_call', name: 'vetar', arguments: JSON.stringify(veto) }]), { nombres: ['vetar'] });
  assert.deepEqual(r.content[0].input, veto);
});
test('los errores HTTP no exponen la respuesta del proveedor', async () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'dummy-test';
  try {
    const c = cliente({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ secret: 'sensitive' }) }) });
    await assert.rejects(c.messages.create({ tools: [], messages: [] }), e => e.message === 'OpenAI: solicitud rechazada (HTTP 401)');
  } finally { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; }
});
