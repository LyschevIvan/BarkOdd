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

test('maximum sensitivity detects sustained quiet sound below the old threshold floor', () => {
  const detector = make({ threshold: 0.0005 });
  assert.equal(detector.process(0.002, 0), null);
  assert.equal(detector.process(0.002, 149), null);
  assert.ok(detector.process(0.002, 150), 'quiet sound must qualify after 150ms');
});

test('maximum sensitivity still ignores silence, sub-threshold sound and short clicks', () => {
  const detector = make({ threshold: 0.0005 });
  for (const [level, time] of [[0, 0], [0.0002, 200], [0.0002, 500], [0.002, 600], [0.002, 749], [0, 750]]) {
    assert.equal(detector.process(level, time), null);
  }
});

test('default sensitivity detects ordinary sound without requiring the old loud level', () => {
  const detector = new NoiseDetector();
  detector.process(0.02, 0);
  assert.ok(detector.process(0.02, 150));
});

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

test('a failed photo attempt retries on the next noise update and only a captured photo starts cooldown', () => {
  const detector = make({ snapshotIntervalMs: 10000 });
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  assert.equal(first.takePhoto, true);
  assert.equal(detector.process(0.2, 1149), null);
  assert.deepEqual(detector.process(0.2, 1150), { episodeId: first.episodeId, takePhoto: true });
  detector.photoCaptured(1150);
  const photoTimes = [];
  for (let time = 1200; time <= 11150; time += 50) {
    if (detector.process(0.2, time)?.takePhoto) photoTimes.push(time);
  }
  assert.deepEqual(photoTimes, [11150]);
});

test('continuous noise keeps one episode and updates once per second', () => {
  const detector = make();
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.photoCaptured(150);
  assert.equal(detector.process(0.2, 1149), null);
  assert.deepEqual(detector.process(0.2, 1150), { episodeId: first.episodeId, takePhoto: false });
  assert.equal(detector.process(0.2, 1151), null);
  assert.deepEqual(detector.process(0.2, 2150), { episodeId: first.episodeId, takePhoto: false });
});

test('a new burst inside five seconds belongs to the same episode', () => {
  const detector = make();
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.photoCaptured(150);
  detector.process(0, 200);
  assert.equal(detector.process(0.2, 4000), null);
  assert.deepEqual(detector.process(0.2, 4150), { episodeId: first.episodeId, takePhoto: false });
});

test('five seconds of silence keeps the same episode while its photo interval is pending', () => {
  const detector = make();
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.photoCaptured(150);
  detector.process(0, 200);
  detector.process(0, 5150);
  assert.equal(detector.process(0.2, 5200), null, 'a new burst must still qualify for 150ms');
  const next = detector.process(0.2, 5350);
  assert.equal(next.episodeId, first.episodeId);
  assert.equal(next.takePhoto, false);
  detector.process(0, 5400);
  assert.equal(detector.process(0.2, 30200), null);
  const later = detector.process(0.2, 30350);
  assert.notEqual(later.episodeId, first.episodeId);
  assert.equal(later.takePhoto, true);
});

test('photo-less bursts share an episode until its interval expires and keep requesting camera retries', () => {
  const detector = make({ snapshotIntervalMs: 10000 });
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.process(0, 200);
  detector.process(0.2, 5200);
  assert.deepEqual(detector.process(0.2, 5350), { episodeId: first.episodeId, takePhoto: true });
  detector.process(0, 5400);
  detector.process(0.2, 10400);
  const next = detector.process(0.2, 10550);
  assert.notEqual(next.episodeId, first.episodeId);
  assert.equal(next.takePhoto, true);
  detector.process(0, 10600);
  detector.process(0.2, 15700);
  assert.deepEqual(detector.process(0.2, 15850), { episodeId: next.episodeId, takePhoto: true });
});

test('a long silence leaves the local capture deadline unchanged for the next qualified burst', () => {
  const detector = make({ snapshotIntervalMs: 10000 });
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.photoCaptured(150);
  detector.process(0, 10150);
  detector.process(0.2, 11000);
  const next = detector.process(0.2, 11150);
  assert.notEqual(next.episodeId, first.episodeId);
  assert.equal(next.takePhoto, true);
});

for (const burstAt of [9999, 10000]) {
  test(`a new episode ${burstAt === 10000 ? 'starts at' : 'waits until'} the local capture interval boundary`, () => {
    const detector = make({ snapshotIntervalMs: 10000, minNoiseMs: 0 });
    const first = detector.process(0.2, 0);
    detector.photoCaptured(0);
    detector.process(0, 5100);
    const next = detector.process(0.2, burstAt);
    assert.equal(next.episodeId === first.episodeId, burstAt < 10000);
    assert.equal(next.takePhoto, burstAt === 10000);
  });
}

test('continuous noise starts the next card with a photo after the interval', () => {
  const detector = make();
  const events = [];
  for (let time = 0; time <= 31150; time += 50) {
    const event = detector.process(0.3, time);
    if (event) events.push({ ...event, time });
    if (event?.takePhoto) detector.photoCaptured(time);
  }
  assert.equal(events.length, 32);
  assert.equal(new Set(events.slice(0, 30).map(event => event.episodeId)).size, 1);
  assert.notEqual(events[30].episodeId, events[0].episodeId);
  assert.equal(events[31].episodeId, events[30].episodeId);
  assert.deepEqual(events.filter(event => event.takePhoto).map(event => event.time), [150, 30150]);
});

test('a burst that starts before the photo is due opens a new card when the interval elapses', () => {
  const detector = make({ snapshotIntervalMs: 10000 });
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.photoCaptured(150);
  detector.process(0, 200);
  detector.process(0.2, 9000);
  assert.deepEqual(detector.process(0.2, 9150), { episodeId: first.episodeId, takePhoto: false });
  assert.equal(detector.process(0.2, 10100), null);
  const next = detector.process(0.2, 10150);
  assert.notEqual(next.episodeId, first.episodeId);
  assert.equal(next.takePhoto, true);
});

test('short silences preserve the episode and cannot bypass the event throttle', () => {
  const detector = make({ quietMs: 200, minNoiseMs: 10 });
  detector.process(0.2, 0);
  const first = detector.process(0.2, 10);
  detector.photoCaptured(10);
  detector.process(0, 210);
  detector.process(0.2, 250);
  assert.equal(detector.process(0.2, 260), null);
  for (let time = 300; time < 1010; time += 50) assert.equal(detector.process(0.2, time), null);
  const second = detector.process(0.2, 1010);
  assert.equal(second.episodeId, first.episodeId);
  assert.equal(second.takePhoto, false);
});

test('the event throttle still applies when quiet and the photo interval permit a new episode', () => {
  const detector = make({ quietMs: 200, minNoiseMs: 0, snapshotIntervalMs: 10000 });
  const first = detector.process(0.2, 0);
  detector.photoCaptured(0);
  assert.equal(detector.process(0.2, 9800).episodeId, first.episodeId);
  detector.process(0, 10000);
  for (let time = 10010; time < 10800; time += 100) assert.equal(detector.process(0.2, time), null);
  const next = detector.process(0.2, 10800);
  assert.notEqual(next.episodeId, first.episodeId);
  assert.equal(next.takePhoto, true);
});

test('settings change sensitivity and photo interval without resetting history', () => {
  const detector = make();
  detector.process(0.2, 0);
  const first = detector.process(0.2, 150);
  detector.photoCaptured(150);
  detector.updateSettings({ threshold: 0.3, snapshotIntervalMs: 10000 });
  assert.equal(detector.process(0.2, 1200), null);
  assert.equal(detector.process(0.4, 1300), null);
  assert.deepEqual(detector.process(0.4, 1450), { episodeId: first.episodeId, takePhoto: false });
  const photoTimes = [];
  for (let time = 1500; time <= 11450; time += 50) {
    if (detector.process(0.4, time)?.takePhoto) {
      photoTimes.push(time);
      detector.photoCaptured(time);
    }
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

test('lengthening the interval keeps its start at the last successful capture', () => {
  const detector = make({ minNoiseMs: 0, snapshotIntervalMs: 10000 });
  const first = detector.process(0.2, 0);
  detector.photoCaptured(0);
  assert.equal(detector.process(0.2, 5000).takePhoto, false);
  detector.updateSettings({ snapshotIntervalMs: 30000 });
  assert.equal(detector.process(0.2, 29000).takePhoto, false);
  const next = detector.process(0.2, 30000);
  assert.equal(next.takePhoto, true);
  assert.notEqual(next.episodeId, first.episodeId);
});

console.log(`${passed} detector tests passed`);
