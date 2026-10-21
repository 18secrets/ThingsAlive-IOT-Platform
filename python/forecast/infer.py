"""The forecast worker (task QML1): series in on stdin, forecasts out on stdout.

A pure function in a process. It never touches a database or the network
(HF_HUB_OFFLINE=1; the weights are baked into the image at a pinned revision), and it
never sees a tenant, an IMEI or a machine name: the series ids are opaque, and Node maps
them back. One process per pass, so the model's memory goes back to the OS when the pass
ends (D40 section 2).

Contract: docs/ai/contracts/forecast/forecast-request.v1.schema.json and
forecast-response.v1.schema.json. Anything it cannot answer honestly goes in `refused`;
a NaN or an infinity is never returned. On a request it will not serve at all (another
model, other lengths) it writes one line to stderr and exits 2, and Node fails the pass.
"""
import hashlib
import json
import math
import os
import sys
import time

BATCH = 1000


def refuse_all(message):
    sys.stderr.write(message + '\n')
    sys.exit(2)


def weights_sha256(model_dir):
    digest = hashlib.sha256()
    with open(os.path.join(model_dir, 'model.safetensors'), 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    request = json.load(sys.stdin)
    if request.get('contract') != 'forecast-request.v1':
        refuse_all('not a forecast-request.v1')
    key = os.environ.get('TTM_MODEL_NAME', 'granite-timeseries-ttm-r2')
    revision = os.environ['TTM_REVISION']
    model_dir = os.environ['TTM_MODEL_DIR']
    asked = request['model']
    # The model asked for must be the model baked in: a forecast from different weights
    # would carry provenance that is not true.
    if asked.get('key') != key or asked.get('revision') != revision:
        refuse_all(f"asked for {asked.get('key')}@{asked.get('revision')}, this image holds {key}@{revision}")

    started = time.perf_counter()
    import torch  # noqa: E402  (imported late: start-up cost belongs to the load timing)
    from tsfm_public import TinyTimeMixerForPrediction  # noqa: E402

    model = TinyTimeMixerForPrediction.from_pretrained(model_dir)
    model.eval()
    sha = weights_sha256(model_dir)
    context_length = model.config.context_length
    prediction_length = model.config.prediction_length
    if request['contextLength'] != context_length or request['predictionLength'] != prediction_length:
        refuse_all(f'asked for {request["contextLength"]}/{request["predictionLength"]}, '
                   f'the model is {context_length}/{prediction_length}')
    load_seconds = time.perf_counter() - started

    series, refused = [], []
    usable = []
    for s in request['series']:
        values = s.get('values')
        if not isinstance(values, list) or len(values) != context_length \
                or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
            refused.append({'id': s.get('id'), 'reason': 'context is not the model length of finite numbers'})
        else:
            usable.append(s)

    started = time.perf_counter()
    with torch.no_grad():
        for i in range(0, len(usable), BATCH):
            chunk = usable[i:i + BATCH]
            x = torch.tensor([s['values'] for s in chunk], dtype=torch.float32).unsqueeze(-1)
            out = model(past_values=x).prediction_outputs[..., 0]
            for s, row in zip(chunk, out.tolist()):
                if all(math.isfinite(v) for v in row):
                    series.append({'id': s['id'], 'values': row})
                else:
                    refused.append({'id': s['id'], 'reason': 'model produced a non-finite value'})
    infer_seconds = time.perf_counter() - started

    json.dump({
        'contract': 'forecast-response.v1',
        'model': {'key': key, 'revision': revision, 'weightsSha256': sha},
        'series': series,
        'refused': refused,
        'timing': {'loadSeconds': round(load_seconds, 4), 'inferSeconds': round(infer_seconds, 4)},
    }, sys.stdout)


if __name__ == '__main__':
    main()
