export const DEFAULT_NOISE_THRESHOLD = 0.01;
const MIN_NOISE_THRESHOLD = 0.0005;
let episodeSequence = 0;

function episodeId() {
  // This is only an event identifier; authentication uses server-generated secrets.
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `noise-${random}-${++episodeSequence}`;
}

function bounded(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export class NoiseDetector {
  constructor({ threshold = DEFAULT_NOISE_THRESHOLD, quietMs = 5000, snapshotIntervalMs = 30000, minNoiseMs = 150 } = {}) {
    this.threshold = DEFAULT_NOISE_THRESHOLD;
    this.quietMs = 5000;
    this.snapshotIntervalMs = 30000;
    this.minNoiseMs = bounded(minNoiseMs, 150, 0, 10000);
    this.updateSettings({ threshold, quietMs, snapshotIntervalMs });
    this.candidateAt = null;
    this.candidateAfterQuiet = false;
    this.lastAboveAt = null;
    this.episode = null;
    this.lastEpisodeAt = -Infinity;
    this.lastEmitAt = -Infinity;
    this.lastPhotoAt = -Infinity;
    this.lastTime = -Infinity;
  }

  updateSettings(settings = {}) {
    const previousThreshold = this.threshold;
    this.threshold = bounded(settings.threshold, this.threshold, MIN_NOISE_THRESHOLD, 0.5);
    this.quietMs = bounded(settings.quietMs, this.quietMs, 1, 60000);
    this.snapshotIntervalMs = bounded(settings.snapshotIntervalMs, this.snapshotIntervalMs, 10000, 300000);
    if (this.threshold !== previousThreshold) this.candidateAt = null;
  }

  photoCaptured(now) {
    if (Number.isFinite(now)) this.lastPhotoAt = Math.max(now, this.lastTime, this.lastPhotoAt);
  }

  process(level, now) {
    if (!Number.isFinite(now)) return null;
    // Consumers use performance.now(); clamping also prevents a clock regression
    // from bypassing rate limits if another clock is supplied.
    now = Math.max(now, this.lastTime);
    this.lastTime = now;
    const afterQuiet = this.lastAboveAt !== null && now - this.lastAboveAt >= this.quietMs;
    if (afterQuiet) this.candidateAt = null;
    if (!Number.isFinite(level) || level < this.threshold) {
      this.candidateAt = null;
      return null;
    }
    this.lastAboveAt = now;
    if (this.candidateAt === null) {
      this.candidateAt = now;
      this.candidateAfterQuiet = afterQuiet;
    }
    if (now - this.candidateAt < this.minNoiseMs) return null;
    // Decide only when the burst qualifies: a late photo confirmation during
    // silence can extend the interval and keep this burst in the previous card.
    const intervalStartedAt = Math.max(this.lastEpisodeAt, this.lastPhotoAt);
    if (!this.episode || (this.candidateAfterQuiet && now - intervalStartedAt >= this.snapshotIntervalMs)) {
      this.episode = episodeId();
      this.lastEpisodeAt = now;
    }
    this.candidateAfterQuiet = false;
    if (now - this.lastEmitAt < 1000) return null;
    const takePhoto = now - this.lastPhotoAt >= this.snapshotIntervalMs;
    this.lastEmitAt = now;
    return { episodeId: this.episode, takePhoto };
  }
}
