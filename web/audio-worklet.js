const TARGET_RATE = 16000;
const PACKET_SAMPLES = 1600;

class BarkOddPCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.generation = 0;
    this.nextId = 0;
    this.inFlight = null;
    this.ratio = sampleRate / TARGET_RATE;
    this.reset();
    this.port.onmessage = ({ data }) => {
      if (!data) return;
      if (Number.isSafeInteger(data.ack)) {
        if (data.ack !== this.inFlight) return;
        this.inFlight = null;
        const pending = this.pending;
        this.pending = null;
        if (this.enabled && pending?.generation === this.generation) this.send(pending);
        return;
      }
      if (typeof data.enabled !== 'boolean' || (data.enabled === this.enabled && data.generation === this.generation)) return;
      this.enabled = data.enabled === true;
      this.generation = data.generation;
      this.reset();
    };
  }

  reset() {
    this.samples = new Float32Array(PACKET_SAMPLES);
    this.count = 0;
    this.sum = 0;
    this.remaining = this.ratio;
    this.capturedAt = null;
    this.pending = null;
  }

  send(packet) {
    // Exactly one transferred packet can wait in the main thread's MessagePort.
    // While it is stalled, replace the local pending packet with newer audio.
    if (this.inFlight !== null) { this.pending = packet; return; }
    packet.id = ++this.nextId;
    this.inFlight = packet.id;
    this.port.postMessage(packet, [packet.samples.buffer]);
  }

  process(inputs, outputs) {
    // This node must run even without another connected destination, but the
    // host must never hear its own microphone.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!this.enabled || !channels?.length || !channels[0]?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample /= channels.length;
      // Integrate each input sample over the output sample interval. Keeping
      // fractional weights across render quanta avoids drift at rates such as
      // 44.1 kHz; averaging also attenuates frequencies above the new Nyquist.
      let available = 1;
      while (available > 1e-10) {
        if (this.capturedAt === null) this.capturedAt = currentTime + (i + 1 - available) / sampleRate;
        const weight = Math.min(available, this.remaining);
        this.sum += sample * weight;
        available -= weight; this.remaining -= weight;
        if (this.remaining < 1e-9) {
          this.samples[this.count++] = this.sum / this.ratio;
          this.sum = 0; this.remaining = this.ratio;
          if (this.count === PACKET_SAMPLES) {
            this.send({ samples: this.samples, generation: this.generation, capturedAt: this.capturedAt });
            this.samples = new Float32Array(PACKET_SAMPLES); this.count = 0;
            this.capturedAt = null;
          }
        }
      }
    }
    return true;
  }
}

registerProcessor('barkodd-pcm-capture', BarkOddPCMCapture);
