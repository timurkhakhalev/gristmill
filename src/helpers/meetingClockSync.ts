export interface MeetingClockProbeReply {
  type: "probe";
  nonce: string;
  helperReceiveNs: string;
  helperSendNs: string;
  helperGeneration: string;
  helperFrame: number;
}

export interface MeetingClockSample {
  nonce: string;
  sourceSendNs: string;
  sourceReceiveNs: string;
  helperReceiveNs: string;
  helperSendNs: string;
  helperGeneration: string;
}

export interface MeetingClockMapping {
  generation: string;
  rate: number;
  offsetNs: number;
  uncertaintyNs: number;
  sampledAtSourceNs: string;
}

const MAX_PENDING_PROBES = 8;
const MAX_MAPPING_AGE_NS = 5_000_000_000n;
const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const parseNs = (value: string): bigint | null => {
  if (!/^\d{1,20}$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
};

/** Bounded renderer-to-helper clock calibration. Mapping never extrapolates beyond its samples. */
export class MeetingClockSync {
  private readonly pending = new Map<string, string>();
  private generation: string | null = null;
  private samples: Array<{ sourceStartNs: bigint; sourceEndNs: bigint; sourceNs: bigint; helperNs: bigint; uncertaintyNs: bigint }> = [];

  reset(generation: string): void {
    if (!generation) throw new Error("Clock generation is required");
    this.pending.clear();
    this.samples = [];
    this.generation = generation;
  }

  createProbe(sourceSendNs: string, nonce: string = globalThis.crypto.randomUUID()): { nonce: string; sourceSendNs: string } {
    if (parseNs(sourceSendNs) === null || !isUuid(nonce) || this.pending.has(nonce)) {
      throw new Error("Invalid clock probe");
    }
    if (this.pending.size >= MAX_PENDING_PROBES) {
      const oldest = this.pending.keys().next().value;
      if (oldest) this.pending.delete(oldest);
    }
    this.pending.set(nonce, sourceSendNs);
    return { nonce, sourceSendNs };
  }

  accept(reply: MeetingClockProbeReply, sourceReceiveNs: string): MeetingClockMapping | null {
    const sent = this.pending.get(reply.nonce);
    this.pending.delete(reply.nonce);
    if (sent === undefined || reply.type !== "probe" || reply.helperGeneration !== this.generation) return null;
    const sourceStart = parseNs(sent);
    const sourceEnd = parseNs(sourceReceiveNs);
    const helperStart = parseNs(reply.helperReceiveNs);
    const helperEnd = parseNs(reply.helperSendNs);
    if (sourceStart === null || sourceEnd === null || helperStart === null || helperEnd === null ||
        sourceEnd < sourceStart || helperEnd < helperStart) return null;

    const lowerOffset = helperEnd - sourceEnd;
    const upperOffset = helperStart - sourceStart;
    if (upperOffset < lowerOffset) return null;
    const sourceNs = (sourceStart + sourceEnd) / 2n;
    const helperNs = (helperStart + helperEnd) / 2n;
    const uncertaintyNs = (upperOffset - lowerOffset + 1n) / 2n;
    this.samples.push({ sourceStartNs: sourceStart, sourceEndNs: sourceEnd, sourceNs, helperNs, uncertaintyNs });
    this.samples.sort((left, right) => left.sourceNs < right.sourceNs ? -1 : left.sourceNs > right.sourceNs ? 1 : 0);
    if (this.samples.length > MAX_PENDING_PROBES) this.samples.shift();
    return this.mappingAt(sourceNs.toString(), sourceEnd.toString());
  }

  mappingAt(sourceNs: string, freshnessSourceNs: string): MeetingClockMapping | null {
    const requested = parseNs(sourceNs);
    if (requested === null || !this.generation || this.samples.length === 0) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const freshness = parseNs(freshnessSourceNs);
    if (freshness === null || freshness < last.sourceEndNs || freshness - last.sourceEndNs > MAX_MAPPING_AGE_NS ||
        requested < first.sourceStartNs || requested > last.sourceEndNs) return null;

    let rate = 1;
    if (this.samples.length > 1) {
      const sourceDelta = Number(last.sourceNs - first.sourceNs);
      const helperDelta = Number(last.helperNs - first.helperNs);
      if (sourceDelta <= 0 || helperDelta <= 0) return null;
      rate = helperDelta / sourceDelta;
      if (!Number.isFinite(rate) || rate <= 0) return null;
    }
    const helperAtRequested = last.helperNs + BigInt(Math.round(Number(requested - last.sourceNs) * rate));
    const anchor = this.samples[0];
    const uncertainty = this.samples.reduce((max, sample) => {
      const predictedHelperNs = anchor.helperNs + BigInt(Math.round(Number(sample.sourceNs - anchor.sourceNs) * rate));
      const residual = sample.helperNs >= predictedHelperNs
        ? sample.helperNs - predictedHelperNs
        : predictedHelperNs - sample.helperNs;
      const bound = sample.uncertaintyNs + residual;
      return bound > max ? bound : max;
    }, 0n);
    const offset = helperAtRequested - requested;
    const offsetNs = Number(offset);
    const uncertaintyNs = Number(uncertainty);
    if (!Number.isFinite(offsetNs) || !Number.isFinite(uncertaintyNs)) return null;
    return {
      generation: this.generation,
      rate,
      offsetNs,
      uncertaintyNs,
      sampledAtSourceNs: last.sourceNs.toString(),
    };
  }

  helperNsAt(sourceNs: string, freshnessSourceNs: string): string | null {
    const mapping = this.mappingAt(sourceNs, freshnessSourceNs);
    const source = parseNs(sourceNs);
    if (!mapping || source === null) return null;
    const helperNs = source + BigInt(Math.round(mapping.offsetNs));
    return helperNs >= 0n ? helperNs.toString() : null;
  }

  frameAt(
    sourceNs: string,
    originHelperNs: string,
    sampleRate: number,
    originFrame: number,
    freshnessSourceNs: string
  ): number | null {
    const helperNs = this.helperNsAt(sourceNs, freshnessSourceNs);
    const origin = parseNs(originHelperNs);
    if (helperNs === null || origin === null || !Number.isSafeInteger(sampleRate) || sampleRate <= 0 ||
        !Number.isSafeInteger(originFrame) || originFrame < 0) return null;
    const frame = originFrame + Number(BigInt(helperNs) - origin) * sampleRate / 1e9;
    return Number.isSafeInteger(Math.round(frame)) && frame >= 0 ? Math.round(frame) : null;
  }
}
