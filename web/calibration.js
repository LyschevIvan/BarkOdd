export const CALIBRATION_DURATION_MS = 5000;
const MIN_THRESHOLD = 0.0005;
const MAX_THRESHOLD = 0.5;
const MIN_SAMPLES = 75;
const MAX_SAMPLE_GAP_MS = 1000;
const MAX_STORED_SAMPLES = 4096;
const THRESHOLD_RATIO = MAX_THRESHOLD / MIN_THRESHOLD;
const precisePercent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const regularPercent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function thresholdToSlider(threshold) {
  const bounded = Number.isFinite(threshold) ? clamp(threshold, MIN_THRESHOLD, MAX_THRESHOLD) : MIN_THRESHOLD;
  return 100 * Math.log(bounded / MIN_THRESHOLD) / Math.log(THRESHOLD_RATIO);
}

export function sliderToThreshold(value) {
  const bounded = Number.isFinite(value) ? clamp(value, 0, 100) : 0;
  return MIN_THRESHOLD * THRESHOLD_RATIO ** (bounded / 100);
}

export function levelPosition(level) {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return clamp((20 * Math.log10(level) + 80) / 80 * 100, 0, 100);
}

export function formatLevel(level) {
  if (!Number.isFinite(level) || level < 0 || level > 1) return '—';
  const percent = level * 100;
  if (percent > 0 && percent < 0.001) return '<0,001%';
  return `${(percent < 1 ? precisePercent : regularPercent).format(percent)}%`;
}

function calibrationError(message) {
  return { kind: 'error', message };
}

export class NoiseCalibration {
  constructor(startedAt) {
    this.startedAt = startedAt;
    this.samples = [];
    this.sampleCount = 0;
    this.sampleStride = 1;
    this.lastSampleAt = null;
    this.result = Number.isFinite(startedAt) && startedAt >= 0
      ? null
      : calibrationError('Не удалось определить время начала калибровки. Повторите замер.');
  }

  add(level, now) {
    if (this.result) return this.result;
    if (!Number.isFinite(level) || level < 0 || level > 1) {
      return this.result = calibrationError('Микрофон передал некорректный уровень звука. Проверьте его и повторите замер.');
    }
    if (!Number.isFinite(now) || now < this.startedAt || (this.lastSampleAt !== null && now <= this.lastSampleAt)) {
      return this.result = calibrationError('Время замера изменилось. Повторите калибровку.');
    }
    const previousAt = this.lastSampleAt === null ? this.startedAt : this.lastSampleAt;
    if (now - previousAt > MAX_SAMPLE_GAP_MS) {
      return this.result = calibrationError('Замер звука прервался. Оставьте вкладку открытой и повторите калибровку.');
    }
    this.lastSampleAt = now;
    const sampleIndex = this.sampleCount++;
    if (sampleIndex % this.sampleStride === 0) {
      // Normal animation-frame sampling fits in memory. For unusually dense input,
      // thin the whole history evenly instead of dropping its earliest samples.
      if (this.samples.length === MAX_STORED_SAMPLES) {
        this.samples = this.samples.filter((_, index) => index % 2 === 0);
        this.sampleStride *= 2;
      }
      if (sampleIndex % this.sampleStride === 0) this.samples.push(level);
    }
    const elapsed = now - this.startedAt;
    if (elapsed < CALIBRATION_DURATION_MS) {
      return { kind: 'calibrating', remainingMs: CALIBRATION_DURATION_MS - elapsed, progress: elapsed / CALIBRATION_DURATION_MS };
    }
    if (this.sampleCount < MIN_SAMPLES) {
      return this.result = calibrationError('Недостаточно замеров звука. Оставьте вкладку открытой и повторите калибровку.');
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.ceil(sorted.length * 0.9) - 1];
    if (noiseFloor === 0) {
      return this.result = calibrationError('Микрофон передаёт тишину. Проверьте микрофон и повторите калибровку при обычном фоне.');
    }
    if (noiseFloor * 2 > MAX_THRESHOLD) {
      return this.result = calibrationError('Фон слишком громкий для надёжного порога. Уменьшите фоновый шум и повторите замер.');
    }
    return this.result = { kind: 'complete', noiseFloor, threshold: Math.max(MIN_THRESHOLD, noiseFloor * 2) };
  }
}
