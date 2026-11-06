import { strict as assert } from 'assert';

let NoiseDetector;
try {
  ({ NoiseDetector } = await import('../web/noise.js'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
assert.equal(typeof NoiseDetector, 'function', 'NoiseDetector must implement noise qualification and episode grouping');

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
const make = (settings = {}) => new NoiseDetector({ threshold: 0.06, quietMs: 5000, snapshotIntervalMs: 30000, ...settings });

test('short transients and silence do not create events', () => {
  const detector = make();
  for (const [level, time] of [[0, 0], [0.4, 10], [0.4, 159], [0, 160], [0.4, 200], [0, 340], [0, 6000]]) {
    assert.equal(detector.process(level, time), null);
  }
});

test('150ms sustained sound creates one episode and requests its first photo', () => {
  const detector = make();
  assert.equal(detector.process(0.06, 0), null);
  assert.equal(detector.process(0.06, 149), null);
  const event = detector.process(0.06, 150);
  assert.equal(typeof event.episodeId, 'string');
  assert.ok(event.episodeId.length > 0);
  assert.equal(event.takePhoto, true);
  assert.equal(detector.process(0.08, 151), null);
});

test('continuous noise keeps one episode and updates once per second', () => {
  const detector = make();
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  assert.equal(detector.process(0.2, 1149), null);
  assert.deepEqual(detector.process(0.2, 1150), { episodeId: first.episodeId, takePhoto: false });
  assert.equal(detector.process(0.2, 1151), null);
  assert.deepEqual(detector.process(0.2, 2150), { episodeId: first.episodeId, takePhoto: false });
});

test('a new burst inside five seconds belongs to the same episode', () => {
  const detector = make();
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.process(0, 200);
  assert.equal(detector.process(0.2, 4000), null);
  assert.deepEqual(detector.process(0.2, 4150), { episodeId: first.episodeId, takePhoto: false });
});

test('five seconds of silence starts a new episode without bypassing photo cooldown', () => {
  const detector = make();
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.process(0, 200);
  detector.process(0, 5150);
  detector.process(0.2, 5200);
  const next = detector.process(0.2, 5350);
  assert.notEqual(next.episodeId, first.episodeId);
  assert.equal(next.takePhoto, false);
});

test('photo cooldown allows a later photo during continuous noise without losing updates', () => {
  const detector = make();
  const events = [];
  for (let time = 0; time <= 31150; time += 50) {
    const event = detector.process(0.3, time);
    if (event) events.push({ ...event, time });
  }
  assert.equal(events.length, 32);
  assert.equal(new Set(events.map(event => event.episodeId)).size, 1);
  assert.deepEqual(events.filter(event => event.takePhoto).map(event => event.time), [150, 30150]);
});

test('the event throttle applies across episode boundaries', () => {
  const detector = make({ quietMs: 200, minNoiseMs: 10 });
  detector.process(0.2, 0);
  const first = detector.process(0.2, 10);
  detector.process(0, 210);
  detector.process(0.2, 250);
  assert.equal(detector.process(0.2, 260), null);
  for (let time = 300; time < 1010; time += 50) assert.equal(detector.process(0.2, time), null);
  const second = detector.process(0.2, 1010);
  assert.notEqual(second.episodeId, first.episodeId);
  assert.equal(second.takePhoto, false);
});

test('settings change sensitivity and photo interval without resetting history', () => {
  const detector = make();
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.updateSettings({ threshold: 0.3, snapshotIntervalMs: 10000 });
  assert.equal(detector.process(0.2, 1200), null);
  assert.equal(detector.process(0.4, 1300), null);
  assert.deepEqual(detector.process(0.4, 1450), { episodeId: first.episodeId, takePhoto: false });
  const photoTimes = [];
  for (let time = 1500; time <= 11450; time += 50) {
    if (detector.process(0.4, time)?.takePhoto) photoTimes.push(time);
  }
  assert.deepEqual(photoTimes, [10450]);
});

test('invalid audio samples cannot create noise and IDs do not depend on the timestamp', () => {
  const first = make();
  const second = make();
  assert.equal(first.process(NaN, 0), null);
  assert.equal(first.process(Infinity, 100), null);
  assert.equal(first.process(-1, 200), null);
  first.process(0.3, 1000);
  second.process(0.3, 1000);
  assert.notEqual(first.process(0.3, 1150).episodeId, second.process(0.3, 1150).episodeId);
});

console.log(`${passed} detector tests passed`);
