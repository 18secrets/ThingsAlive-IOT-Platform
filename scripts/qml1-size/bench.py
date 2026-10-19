"""QML1-SIZE cold-start timings 7 to 9, inside the scheduler image (variant D).

Mounted at run time, not baked in, so the image measured is the image QML1 would ship.
Prints one JSON line. Synthetic input of the model's own context length: the point is
the runtime, not forecast quality (that is QEVAL1).
"""
import json
import os
import resource
import time

T0 = time.perf_counter()


def process_age_s():
    # Seconds since the kernel started this process, so interpreter start-up is counted.
    with open('/proc/self/stat') as f:
        start_ticks = int(f.read().rsplit(')', 1)[1].split()[19])
    with open('/proc/uptime') as f:
        uptime = float(f.read().split()[0])
    return uptime - start_ticks / os.sysconf('SC_CLK_TCK')


startup = process_age_s()
t = time.perf_counter()
import torch  # noqa: E402
from tsfm_public import TinyTimeMixerForPrediction  # noqa: E402
py_import = time.perf_counter() - t

t = time.perf_counter()
model = TinyTimeMixerForPrediction.from_pretrained(os.environ['TTM_MODEL_DIR'])
model.eval()
model_load = time.perf_counter() - t

ctx = model.config.context_length
torch.manual_seed(0)
with torch.no_grad():
    t = time.perf_counter()
    model(past_values=torch.randn(1, ctx, 1))
    one_series = time.perf_counter() - t

    batch = torch.randn(1000, ctx, 1)
    model(past_values=batch[:32])  # warm-up
    t = time.perf_counter()
    model(past_values=batch)
    thousand_series = time.perf_counter() - t

print(json.dumps({
    'startup_s': round(startup - (time.perf_counter() - T0), 4),
    'py_import_s': round(py_import, 4),
    'model_load_s': round(model_load, 4),
    'one_series_s': round(one_series, 4),
    'thousand_series_s': round(thousand_series, 4),
    'peak_rss_mb': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
    'context_length': ctx,
    'torch': torch.__version__,
    'threads': torch.get_num_threads(),
}))
