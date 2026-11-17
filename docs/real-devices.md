# Connecting a real phone or wearable

The engine (`web/src/engine/engine.js`) does not know or care which device the data
comes from. Every device — simulated or real — talks to it through three calls:

```js
engine.setDeviceStatus('wrist', { connected: true, worn: true }); // on connect / on-body changes
engine.pushSample('wrist', [ax, ay, az], tSeconds);                // accelerometer, in g, at 20 Hz
engine.pushHeartRate(tSeconds, bpm);                               // optional, wearables only
```

So a real device needs only a small **adapter** that produces those calls. Whatever
rate a device gives (25 Hz band, 50 Hz watch, ~60 Hz browser), `BinResampler`
converts it to 20 Hz. Because the models only use orientation-invariant channels, it
doesn't matter how the watch is strapped on or how the phone sits in a pocket. That is
also why the different axis conventions of Android, iOS and band firmware don't matter.

| What the engine needs | Why |
|---|---|
| 3-axis accelerometer, ≥ 20 Hz, in g (or m/s² ÷ 9.81) | the only required signal: every phone and band has one |
| `worn` / off-body flag | to fall back to the phone when the wearable is taken off |
| heart rate (optional) | a supporting signal shown on the alert; never required |

## Phone (any)
Already live in the demo: `web/src/engine/livePhone.js` uses the W3C `DeviceMotion`
API, which works in Chrome on Android and Safari on iOS (HTTPS plus one permission tap on iOS).
A production app would use a native background service, because browsers stop
sensor events when the screen locks:
* **Android:** `SensorManager` `TYPE_ACCELEROMETER` with `maxReportLatencyUs` batching in a
  foreground service, and ONNX Runtime Mobile running the same `.onnx` files.
* **iOS:** `CMMotionManager` (or `CMSensorRecorder` for background), and the same models
  via ONNX Runtime iOS or converted to Core ML.

## Wear OS watch
* Accelerometer: `SensorManager` on the watch (`TYPE_ACCELEROMETER`, `SENSOR_DELAY_GAME`
  ≈ 50 Hz, batched).
* Heart rate and on-body: **Health Services** `MeasureClient` (`DataType.HEART_RATE_BPM`);
  `TYPE_LOW_LATENCY_OFFBODY_DETECT` sensor for worn / not worn.
* Recommended: run stages 1 and 2 **on the watch** (the models are ~100 KB), and send only
  events to the phone over the Wearable Data Layer (`MessageClient`). See
  `reports/battery.md`: streaming raw data over BLE costs more than the inference.

## Apple Watch
* Accelerometer: `CMMotionManager` (`deviceMotion`/`accelerometerData` up to 100 Hz)
  while an `HKWorkoutSession` keeps the app running, or `CMSensorRecorder` for
  continuous background logging.
* Heart rate: `HKLiveWorkoutBuilder`. On-wrist state is implied by heart-rate samples arriving.
* Phone link: `WatchConnectivity` (`WCSession.sendMessage`) for events.
* Note: Apple Watch's built-in Fall Detection is not exposed to third-party apps, but
  the falls it records are written to HealthKit as `numberOfTimesFallen`, which an app
  could read as an extra confirmation signal.

## Health Connect / HealthKit (as data sources)
These store **summaries** (steps, heart rate, sleep), not 20 Hz raw motion, so they
can't drive fall detection on their own. They are useful for heart-rate baselines and
for adding detected falls to the person's health record.

## Bluetooth fitness bands
* Heart rate: the standard **Heart Rate Service (0x180D)**, characteristic 0x2A37. Any
  compliant band works, including from the browser via Web Bluetooth (Chrome/Android).
* Raw motion: **not standardised**. Mi Band, Amazfit and others need their
  vendor SDK or a reverse-engineered GATT profile. A band that only exposes heart rate
  can still serve as a "worn + heart rate" source while the phone provides motion.

## Sketch: a Web Bluetooth heart-rate adapter (works with standard bands)
```js
const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
const ch = await (await (await dev.gatt.connect()).getPrimaryService('heart_rate'))
  .getCharacteristic('heart_rate_measurement');
ch.addEventListener('characteristicvaluechanged', (e) => {
  const v = e.target.value;
  const bpm = v.getUint8(0) & 1 ? v.getUint16(1, true) : v.getUint8(1);
  engine.pushHeartRate(performance.now() / 1000, bpm);
});
await ch.startNotifications();
dev.addEventListener('gattserverdisconnected', () => engine.setDeviceStatus('wrist', { connected: false }));
```
