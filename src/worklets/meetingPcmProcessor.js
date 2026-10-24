
const BUFFER_SIZE = __MEETING_AUDIO_BUFFER_SIZE__;
const SAMPLE_RATE = 24000;
const MAX_PENDING_FRAMES = __MAX_UNACKNOWLEDGED_CAPTURE_FRAMES__;
const MAX_ACK_AGE_FRAMES = SAMPLE_RATE * __MAX_CAPTURE_ACK_AGE_MS__ / 1000;
class MeetingPCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._sequence = 0;
    this._sampleOffset = 0;
    this._bufferStartFrame = null;
    this._gateClosed = options.processorOptions?.gateClosed === true;
    this._epochIndex = options.processorOptions?.epochIndex ?? 0;
    this._sourceGeneration = options.processorOptions?.sourceGeneration ?? 1;
    this._inputSeen = false;
    this._startup = !this._gateClosed;
    this._nextRenderFrame = null;
    this._pendingFrames = 0;
    this._unacked = new Map();
    this._stopped = false;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "ack") {
        const key = message.epochIndex + ":" + message.sequence;
        const pending = this._unacked.get(key);
        if (pending) {
          this._pendingFrames -= pending.frames;
          this._unacked.delete(key);
        }
      } else if (message?.type === "flush") {
        if (this._stopped) return;
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this._offset = 0;
          if (!this._send(partial)) return;
        }
        this._stopped = true;
        this.port.postMessage({ type: "flush-complete", lastSequence: this._sequence - 1, boundaryRenderFrame: currentFrame });
      } else if (message?.type === "set-gate") {
        if (this._stopped) return;
        this._startup = false;
        if (message.effectiveMuted && !this._gateClosed && this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this._offset = 0;
          if (!this._send(partial)) return;
        }
        const wasClosed = this._gateClosed;
        this._gateClosed = message.effectiveMuted === true;
        if (wasClosed && !this._gateClosed) {
          this._epochIndex = message.epochIndex;
          this._sourceGeneration = message.sourceGeneration;
          this._sequence = 0;
          this._sampleOffset = 0;
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
          this._bufferStartFrame = null;
          this._nextRenderFrame = null;
        }
        this.port.postMessage({
          type: "gate-ack",
          commandId: message.commandId,
          sourceGeneration: this._sourceGeneration,
          effectiveMuted: this._gateClosed,
          boundaryRenderFrame: currentFrame,
          lastSequence: this._sequence - 1,
        });
      }
    };
  }
  _fail(code) {
    if (this._stopped) return;
    this._stopped = true;
    this.port.postMessage({ type: "error", code });
  }
  _send(buffer) {
    if (this._pendingFrames + buffer.length > MAX_PENDING_FRAMES) {
      this._fail("capture-queue-overflow");
      return false;
    }
    this._startup = false;
    const sequence = this._sequence++;
    const frames = buffer.length;
    const renderStartFrame = this._bufferStartFrame;
    if (!Number.isSafeInteger(renderStartFrame)) {
      this._fail("capture-frame-anchor-missing");
      return false;
    }
    this._unacked.set(this._epochIndex + ":" + sequence, { frames, frame: currentFrame });
    this._pendingFrames += frames;
    const sampleOffset = this._sampleOffset;
    this._sampleOffset += frames;
    this.port.postMessage({
      type: "chunk", buffer: buffer.buffer, sequence, sampleOffset,
      renderStartFrame, epochIndex: this._epochIndex, sourceGeneration: this._sourceGeneration,
    }, [buffer.buffer]);
    this._bufferStartFrame = null;
    return true;
  }
  process(inputs, outputs) {
    if (this._stopped) return false;
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    const firstPending = this._unacked.keys().next().value;
    if (firstPending !== undefined && currentFrame - this._unacked.get(firstPending).frame >= MAX_ACK_AGE_FRAMES) {
      this._fail("capture-ack-timeout");
      return false;
    }
    const input = inputs[0]?.[0];
    if (this._gateClosed) return true;
    if (!input) {
      if (this._inputSeen) this._fail("mic-input-gap");
      return !this._stopped;
    }
    this._inputSeen = true;
    if (!this._gateClosed && this._nextRenderFrame !== null && currentFrame !== this._nextRenderFrame) {
      if (currentFrame < this._nextRenderFrame) {
        this._fail("capture-render-clock-reset");
        return false;
      }
      // A fresh graph can settle its render clock after the first quanta. Those
      // unsent frames are shorter than one calibration span and can never be
      // aligned, so the first epoch starts again after the gap.
      if (this._startup && this._sequence === 0) {
        this._offset = 0;
        this._bufferStartFrame = null;
      } else {
        // A render-clock gap is a new epoch, never contiguous PCM with a false anchor.
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this._offset = 0;
          if (!this._send(partial)) return false;
        }
        this._epochIndex++;
        this._sequence = 0;
        this._sampleOffset = 0;
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._bufferStartFrame = null;
        this.port.postMessage({ type: "source-gap", epochIndex: this._epochIndex });
      }
    }
    this._nextRenderFrame = currentFrame + input.length;
    if (this._pendingFrames + this._offset + input.length > MAX_PENDING_FRAMES) {
      this._fail("capture-queue-overflow");
      return false;
    }
    for (let i = 0; i < input.length; i++) {
      if (output) output[i] = input[i];
      if (this._offset === 0) this._bufferStartFrame = currentFrame + i;
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        const full = this._buffer;
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
        if (!this._send(full)) return false;
      }
    }
    return true;
  }
}
registerProcessor("meeting-pcm-processor", MeetingPCMProcessor);
