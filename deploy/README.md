# Motor logger services (Railway, Development)

Two services, both created 9 Nov 2026, neither part of the API image.

## motor-receiver
`motor_logger_http_server.py` (Flask), unchanged, under `receiver/motor/`: it derives its
project root as `Path(__file__).parents[2]`, so it has to sit two folders deep. `main.py`
is only the entry point Railpack runs.

- Loggers (SIM800L, plain HTTP): `http://switchyard.proxy.rlwy.net:52215/api/sensor-data/bulk`
  (Railway TCP proxy → port 8080). Give the firmware team the host name; the IP behind it can change.
- Dashboard and `/api/motor/recent`: https://motor-receiver-development.up.railway.app
- Writes `motor_sensor_records` / `motor_upload_log` into Development's database
  (`DB_*` are references to `Postgres--HgV`, the API's own database and user).
  `UPDATE_DEV_DB` / `UPDATE_QA_DB` are 0: it writes nowhere else.

Redeploy (from this folder):

    railway up . --path-as-root --project 19b6333d-9ce5-4934-aef0-0366f74f8e64 \
      --service motor-receiver --environment Development --ci

## motor-demo-simulator
`scripts/motor-logger-sim.ts`, compiled, in `--live` mode as `DEMO_MOTOR_01`: an hour of
history on start, then a batch run every five minutes, readings from the Crompton workbook's
physics (simulated, never measured). `DEMO_SCENARIO` picks the scenario (normal, overload,
low-voltage, high-voltage, dry-run, cycling); `DEMO_DEVICE_ID` the device.

Redeploy (from this folder, after compiling the simulator into it):

    npx tsc ../../scripts/motor-logger-sim.ts --target es2022 --module commonjs --outDir . --skipLibCheck --types node
    railway up . --path-as-root --no-gitignore --project 19b6333d-9ce5-4934-aef0-0366f74f8e64 \
      --service motor-demo-simulator --environment Development --ci

`--no-gitignore` is required: the compiled `motor-logger-sim.js` is git-ignored (it is a
build output), and `railway up` honours `.gitignore`, so without the flag the service is
deployed with no script and crashes on MODULE_NOT_FOUND. Check `ls` shows the `.js` first:
`npx tsc` run where no `node_modules` exists does not compile, it only prints advice.
