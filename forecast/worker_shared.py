"""Reuse the installed baseline and its model; experiments never load a second copy."""
import ast
import contextlib
import dataclasses
import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path

source = Path(__file__).with_name('worker.py')
tree = ast.parse(source.read_text(encoding='utf-8'))
# Keep baseline definitions verbatim, replacing only its stdin dispatcher.
tree.body = [node for node in tree.body if not isinstance(node, ast.For)]
scope = {'__file__': str(source), '__name__': 'baseline_worker'}
exec(compile(tree, str(source), 'exec'), scope)
implementation = hashlib.sha256(source.read_bytes() + Path(__file__).read_bytes()).hexdigest()

def experiment(request):
    import numpy as np
    import torch
    import timesfm
    values = np.asarray(request['values'], dtype=np.float64)
    horizon = request.get('horizon')
    contexts = request.get('contexts')
    if not isinstance(horizon, int) or not 1 <= horizon <= 15:
        raise ValueError('Horizonte experimental inválido')
    if not isinstance(contexts, list) or not contexts or len(set(contexts)) != len(contexts) or any(c not in (256, 512, 1024) or c > len(values) for c in contexts):
        raise ValueError('Contextos experimentales incompletos')
    if values.ndim != 1 or len(values) > 1024 or not np.isfinite(values).all() or (values <= 0).any():
        raise ValueError('Serie experimental inválida')
    if scope['model'] is None:
        if not scope['MODEL_DIR'].exists():
            raise RuntimeError('Modelo no disponible')
        torch.set_num_threads(min(4, scope['os'].cpu_count() or 1))
        scope['model'] = timesfm.TimesFM_2p5_200M_torch.from_pretrained(str(scope['MODEL_DIR']), torch_compile=False)
        scope['model'].compile(timesfm.ForecastConfig(max_context=512, max_horizon=32,
            normalize_inputs=True, use_continuous_quantile_head=True,
            force_flip_invariance=True, infer_is_positive=True, fix_quantile_crossing=True))
    model = scope['model']
    original = model.forecast_config
    try:
        model.compile(dataclasses.replace(original, max_context=max(contexts), max_horizon=32))
        point, quantiles = model.forecast(horizon=horizon, inputs=[values[-c:] for c in contexts])
        rows = []
        for i, context in enumerate(contexts):
            q = np.asarray(quantiles)[i, horizon-1, 1:10]
            if q.shape != (9,) or not np.isfinite(q).all() or (q <= 0).any() or (np.diff(q) < 0).any():
                raise ValueError('Cuantiles experimentales inválidos')
            rows.append({'context': context, 'estimatedClose': float(q[4]), 'quantiles': q.tolist()})
        return {'version': 'timesfm-minute-v1', 'modelId': scope['MODEL_ID'], 'implementation': implementation,
                'packageVersion': importlib.metadata.version('timesfm'), 'horizon': horizon,
                'candidates': rows, 'validationMode': 'prospective-only', 'liveEnabled': False}
    finally:
        model.compile(original)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            result = experiment(request) if request.get('mode') == 'experiment' else scope['predict'](request['values'])
        response = {'id': request['id'], 'result': result}
    except Exception as exc:
        response = {'id': request.get('id'), 'error': str(exc)}
    print(json.dumps(response, allow_nan=False), flush=True)
