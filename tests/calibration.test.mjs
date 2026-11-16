import { strict as assert } from 'assert';

let calibration = {};
try {
  calibration = await import('../web/calibration.js');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

let passed = 0;
let failed = 0;
function test(name, run) {
  try {
    run();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n${error.stack}`);
  }
}

function sample(background, { startedAt = 0, step = 50 } = {}) {
  const session = new calibration.NoiseCalibration(startedAt);
  let result;
  for (let elapsed = 0; elapsed <= 5000; elapsed += step) {
    const level = typeof background === 'function' ? background(elapsed) : background;
    result = session.add(level, startedAt + elapsed);
  }
  return { session, result };
}

test('stable quiet background completes after five seconds with room above its noise floor', () => {
  assert.equal(typeof calibration.NoiseCalibration, 'function', 'NoiseCalibration must estimate the background');
  assert.deepEqual(sample(0.0012).result, { kind: 'complete', noiseFloor: 0.0012, threshold: 0.0024 });
});

test('progress uses the requested start and never completes before five seconds', () => {
  const session = new calibration.NoiseCalibration(5000);
  assert.deepEqual(session.add(0.01, 5500), { kind: 'calibrating', remainingMs: 4500, progress: 0.1 });
  for (let time = 5550; time <= 9950; time += 50) session.add(0.01, time);
  assert.deepEqual(session.add(0.01, 9999), { kind: 'calibrating', remainingMs: 1, progress: 4999 / 5000 });
  assert.equal(session.add(0.01, 10000).kind, 'complete');
  assert.equal(calibration.CALIBRATION_DURATION_MS, 5000);
});

test('the ninetieth percentile ignores isolated peaks', () => {
  const { result } = sample(time => time % 1000 === 0 ? 0.8 : 0.002);
  assert.deepEqual(result, { kind: 'complete', noiseFloor: 0.002, threshold: 0.004 });
});

test('the percentile includes a loud background when more than a tenth of samples are loud', () => {
  const session = new calibration.NoiseCalibration(0);
  let result;
  for (let i = 0; i < 200; i++) result = session.add(i < 179 ? 0.01 : 0.2, i * 5000 / 199);
  assert.deepEqual(result, { kind: 'complete', noiseFloor: 0.2, threshold: 0.4 });
});

test('very quiet real input keeps the supported minimum threshold', () => {
  assert.deepEqual(sample(0.0001).result, { kind: 'complete', noiseFloor: 0.0001, threshold: 0.0005 });
});

function assertError(result) {
  assert.equal(result.kind, 'error');
  assert.match(result.message, /[а-я]/i, 'calibration errors explain the problem in Russian');
}

test('digital silence is an error instead of a minimum-threshold calibration', () => {
  assertError(sample(0).result);
});

test('a near-silent stream with isolated nonzero samples is also rejected', () => {
  assertError(sample(time => time % 1000 === 0 ? 0.1 : 0).result);
});

test('background without enough headroom is rejected without clamping it into a success', () => {
  assertError(sample(0.250001).result);
  assert.deepEqual(sample(0.25).result, { kind: 'complete', noiseFloor: 0.25, threshold: 0.5 });
});

test('five seconds with fewer than 75 valid samples cannot complete', () => {
  assertError(sample(0.01, { step: 100 }).result);
  const session = new calibration.NoiseCalibration(0);
  let result;
  for (let i = 0; i < 74; i++) result = session.add(0.01, i * 5000 / 73);
  assertError(result);
});

test('exactly 75 valid samples can complete at the duration boundary', () => {
  const session = new calibration.NoiseCalibration(0);
  let result;
  for (let i = 0; i < 75; i++) result = session.add(0.01, i * 5000 / 74);
  assert.deepEqual(result, { kind: 'complete', noiseFloor: 0.01, threshold: 0.02 });
});

test('a sampling interruption longer than one second fails immediately', () => {
  const session = new calibration.NoiseCalibration(0);
  session.add(0.01, 0);
  assert.equal(session.add(0.01, 1000).kind, 'calibrating');
  assertError(session.add(0.01, 2001));
});

test('waiting too long for the first sample fails instead of shortening the observation', () => {
  assertError(new calibration.NoiseCalibration(100).add(0.01, 1101));
});

test('invalid RMS input fails instead of being converted to silence', () => {
  for (const level of [NaN, Infinity, -Infinity, -0.01, 1.001, undefined, null, '0.01']) {
    assertError(new calibration.NoiseCalibration(0).add(level, 0));
  }
});

test('invalid and non-increasing clocks fail without producing a threshold', () => {
  for (const startedAt of [NaN, Infinity, -1, undefined, null, '0']) {
    assertError(new calibration.NoiseCalibration(startedAt).add(0.01, 0));
  }
  for (const now of [NaN, Infinity, -1, undefined, null, '0']) {
    assertError(new calibration.NoiseCalibration(0).add(0.01, now));
  }
  const session = new calibration.NoiseCalibration(100);
  assertError(session.add(0.01, 99));
  for (const now of [100, 101]) {
    const duplicate = new calibration.NoiseCalibration(100);
    duplicate.add(0.01, 101);
    assertError(duplicate.add(0.01, now));
  }
});

test('success remains the same terminal result for all subsequent inputs', () => {
  const { session, result } = sample(0.01);
  assert.equal(session.add(0.5, 6000), result);
  assert.equal(session.add(NaN, NaN), result);
});

test('failure remains the same terminal result for all subsequent inputs', () => {
  const { session, result } = sample(0);
  assertError(result);
  assert.equal(session.add(0.01, 6000), result);
  assert.equal(session.add(NaN, NaN), result);
});

test('dense sampling still represents the early background without retaining an unbounded sample list', () => {
  const session = new calibration.NoiseCalibration(0);
  let result;
  for (let i = 0; i <= 20000; i++) result = session.add(i < 18000 ? 0.02 : 0.001, i / 4);
  assert.deepEqual(result, { kind: 'complete', noiseFloor: 0.02, threshold: 0.04 });
  assert.ok(session.samples.length < 20000 / 2, 'dense input must not retain every sample');
});

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, message || `${actual} should equal ${expected}`);
}

test('the fine-control scale allocates equal slider space to each threshold decade', () => {
  assert.equal(typeof calibration.thresholdToSlider, 'function', 'thresholdToSlider must map the logarithmic control');
  for (const [threshold, position] of [[0.0005, 0], [0.005, 100 / 3], [0.05, 200 / 3], [0.5, 100]]) {
    assertClose(calibration.thresholdToSlider(threshold), position);
  }
});

test('slider changes recover exact thresholds without rounding to presets or percentages', () => {
  assert.equal(typeof calibration.sliderToThreshold, 'function', 'sliderToThreshold must preserve fine corrections');
  for (const [position, threshold] of [[0, 0.0005], [100 / 3, 0.005], [200 / 3, 0.05], [100, 0.5]]) {
    assertClose(calibration.sliderToThreshold(position), threshold);
  }
  for (const threshold of [0.000571234, 0.007812345, 0.123456789]) {
    assertClose(calibration.sliderToThreshold(calibration.thresholdToSlider(threshold)), threshold);
  }
  assert.ok(calibration.sliderToThreshold(50.1) > calibration.sliderToThreshold(50));
  assert.ok(calibration.sliderToThreshold(50.1) < calibration.sliderToThreshold(51));
});

test('fine controls clamp out-of-range values and recover safely from invalid inputs', () => {
  for (const [threshold, position] of [[0, 0], [-1, 0], [1, 100], [NaN, 0], [undefined, 0]]) {
    assert.equal(calibration.thresholdToSlider(threshold), position);
  }
  for (const [position, threshold] of [[-1, 0.0005], [101, 0.5], [NaN, 0.0005], [undefined, 0.0005]]) {
    assert.equal(calibration.sliderToThreshold(position), threshold);
  }
});

test('the meter maps RMS levels onto a shared minus-80-to-zero-dBFS scale', () => {
  assert.equal(typeof calibration.levelPosition, 'function', 'levelPosition must share one meter scale for sound and threshold');
  for (const [level, position] of [[0, 0], [0.00001, 0], [0.0001, 0], [0.001, 25], [0.01, 50], [0.1, 75], [1, 100], [2, 100]]) {
    assertClose(calibration.levelPosition(level), position);
  }
  for (const level of [NaN, Infinity, -1, undefined]) assert.equal(calibration.levelPosition(level), 0);
});

test('percentage labels retain useful precision below one percent with a Russian decimal separator', () => {
  assert.equal(typeof calibration.formatLevel, 'function', 'formatLevel must show precise low microphone levels');
  for (const [level, label] of [[0, '0%'], [0.0005, '0,05%'], [0.001234, '0,123%'], [0.0078123, '0,781%'], [0.01, '1%'], [0.123456, '12,35%'], [1, '100%']]) {
    assert.equal(calibration.formatLevel(level), label);
  }
});

test('percentage labels distinguish extremely quiet real input and unavailable input from digital silence', () => {
  assert.equal(calibration.formatLevel(0.000001), '<0,001%');
  for (const level of [NaN, Infinity, -1, 1.001, undefined, null]) assert.equal(calibration.formatLevel(level), '—');
});

console.log(`${passed} calibration tests passed; ${failed} failed`);
if (failed) process.exitCode = 1;
