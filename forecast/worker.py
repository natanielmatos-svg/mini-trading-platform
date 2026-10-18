"""Local TimesFM 2.5 inference. stdout is exclusively the JSON-line protocol."""
import contextlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / 'data' / 'models' / 'timesfm-2.5'
os.environ.setdefault('HF_HOME', str(ROOT / 'data' / 'models' / 'cache'))
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
MODEL_ID = 'google/timesfm-2.5-200m-pytorch'

if '--prepare' in sys.argv:
    from huggingface_hub import snapshot_download
    snapshot_download(MODEL_ID, local_dir=str(MODEL_DIR))
    print('Modelo descargado en el proyecto.')
    sys.exit(0)

model = None

def predict(values):
    global model
    import numpy as np
    import torch
    import timesfm
    values = np.asarray(values, dtype=np.float64)
    if not 100 <= len(values) <= 1000 or not np.isfinite(values).all() or (values <= 0).any():
        raise ValueError('Se requieren entre 100 y 1000 cierres positivos y finitos.')
    if model is None:
        if not MODEL_DIR.exists():
            raise RuntimeError('Descarga pendiente: ejecutar forecast/worker.py --prepare.')
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(str(MODEL_DIR), torch_compile=False)
        model.compile(timesfm.ForecastConfig(max_context=512, max_horizon=32,
            normalize_inputs=True, use_continuous_quantile_head=True,
            force_flip_invariance=True, infer_is_positive=True, fix_quantile_crossing=True))
    # Cada origen histórico contiene exclusivamente observaciones anteriores a su objetivo.
    n = 24
    origins = list(range(len(values)-n, len(values)))
    contexts = [values[max(0,i-256):i] for i in origins] + [values[-256:]]
    point, quantiles = model.forecast(horizon=1, inputs=contexts)
    q = np.asarray(quantiles)[:,0,1:10]
    if q.shape != (n+1,9) or not np.isfinite(q).all() or (q <= 0).any():
        raise RuntimeError('El modelo devolvió cuantiles no válidos.')
    q = np.sort(q,axis=1)
    actual = values[origins]
    previous = values[np.asarray(origins)-1]
    median = q[:-1,4]
    errors = np.abs(median-actual)
    return {'model':'TimesFM 2.5 · 200M', 'modelId':MODEL_ID,
        'quantiles':q[-1].tolist(), 'estimatedClose':float(q[-1,4]),
        'validation':{'samples':n, 'mae':float(errors.mean()),
            'baselineMae':float(np.abs(previous-actual).mean()),
            'directionAccuracy':float((np.sign(median-previous)==np.sign(actual-previous)).mean()),
            'coverage80':float(((actual>=q[:-1,0]) & (actual<=q[:-1,8])).mean()),
            'method':'24 orígenes temporales; sin usar el cierre objetivo como entrada'},
        'basis':'Solo velas cerradas. No condicionado a movimientos dentro de la vela actual.'}

for line in sys.stdin:
    try:
        request = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            result = predict(request['values'])
        response = {'id':request['id'], 'result':result}
    except Exception as exc:
        response = {'id':request.get('id') if 'request' in locals() else None,
            'error':str(exc)}
    print(json.dumps(response, allow_nan=False), flush=True)
