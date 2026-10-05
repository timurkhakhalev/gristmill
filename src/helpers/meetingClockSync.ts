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
  helperFrame: number;
}

export interface MeetingClockMapping {
  generation: string;
  rate: number;
  offsetNs: number;
  uncertaintyNs: number;
  sampledAtSourceNs: string;
  sourceStartNs: string;
  sourceEndNs: string;
  helperStartNs: string;
  helperEndNs: string;
  helperEstimateNs: string;
  helperMinimumNs: string;
  helperMaximumNs: string;
  sampleCount: number;
}

interface AcceptedSample {
  sourceStartNs: bigint;
  sourceEndNs: bigint;
  sourceMidpointNs: bigint;
  helperReceiveNs: bigint;
  helperSendNs: bigint;
  helperMidpointNs: bigint;
  helperFrame: number;
}

interface Point {
  a: number;
  b: number;
}

interface Model {
  polygon: Point[];
  sourceOriginNs: bigint;
  helperOriginNs: bigint;
  sourceStartNs: bigint;
  sourceEndNs: bigint;
  helperStartNs: bigint;
  helperEndNs: bigint;
  latestSourceEndNs: bigint;
}

const MAX_PENDING_PROBES = 8;

const MAX_SAMPLES = 8;

const MAX_MAPPING_AGE_NS = 5_000_000_000n;

const MIN_SAMPLE_SPAN_NS = 250_000_000n;

const MIN_RATE = 0.999;

const MAX_RATE = 1.001;

const GEOMETRY_EPSILON = 1e-9;

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const parseNs = (value: string): bigint | null => {
  if (!/^\d{1,20}$/.test(value)) return null;

  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

/** Clock model from bounded nonce round trips; raw capture does not depend on it. */
export class MeetingClockSync {
  private readonly pending = new Map<string, string>();
  private generation: string | null = null;
  private samples: AcceptedSample[] = [];

  reset(generation: string): void {
    if (!generation) throw new Error("Clock generation is required");
    this.pending.clear();
    this.samples = [];
    this.generation = generation;
  }

  createProbe(
    sourceSendNs: string,
    nonce: string = globalThis.crypto.randomUUID()
  ): { nonce: string; sourceSendNs: string } {
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

    if (
      sent === undefined ||
      reply.type !== "probe" ||
      reply.helperGeneration !== this.generation ||
      !Number.isSafeInteger(reply.helperFrame) ||
      reply.helperFrame < 0
    )
      return null;
    const sourceStartNs = parseNs(sent);
    const sourceEndNs = parseNs(sourceReceiveNs);
    const helperReceiveNs = parseNs(reply.helperReceiveNs);
    const helperSendNs = parseNs(reply.helperSendNs);

    if (
      sourceStartNs === null ||
      sourceEndNs === null ||
      helperReceiveNs === null ||
      helperSendNs === null ||
      sourceEndNs < sourceStartNs ||
      helperSendNs < helperReceiveNs
    )
      return null;

    const sample: AcceptedSample = {
      sourceStartNs,
      sourceEndNs,
      sourceMidpointNs: (sourceStartNs + sourceEndNs) / 2n,
      helperReceiveNs,
      helperSendNs,
      helperMidpointNs: (helperReceiveNs + helperSendNs) / 2n,
      helperFrame: reply.helperFrame,
    };

    const previousLatest = this.samples.reduce(
      (latest, accepted) => (accepted.sourceEndNs > latest ? accepted.sourceEndNs : latest),
      0n
    );

    const previousEarliest = this.samples.reduce(
      (earliest, accepted) =>
        accepted.sourceStartNs < earliest ? accepted.sourceStartNs : earliest,
      this.samples[0]?.sourceStartNs ?? 0n
    );

    const overlaps =
      sample.sourceStartNs <= previousLatest && sample.sourceEndNs >= previousEarliest;

    const continuous =
      this.samples.length > 0 &&
      (overlaps ||
        (sample.sourceStartNs >= previousLatest &&
          sample.sourceStartNs - previousLatest <= MAX_MAPPING_AGE_NS) ||
        (sample.sourceEndNs <= previousEarliest &&
          previousEarliest - sample.sourceEndNs <= MAX_MAPPING_AGE_NS));

    const proposed = [...(continuous ? this.samples : []), sample].sort((left, right) =>
      left.sourceMidpointNs < right.sourceMidpointNs
        ? -1
        : left.sourceMidpointNs > right.sourceMidpointNs
          ? 1
          : 0
    );

    if (!buildModel(proposed, false)) return null;
    const candidate = proposed.slice(-MAX_SAMPLES);
    this.samples = candidate;

    return this.mappingAt(sourceEndNs.toString(), sourceEndNs.toString());
  }

  mappingAt(sourceNs: string, freshnessSourceNs: string): MeetingClockMapping | null {
    const requested = parseNs(sourceNs);
    const freshness = parseNs(freshnessSourceNs);

    if (requested === null || freshness === null || !this.generation) return null;
    const model = buildModel(this.samples);

    if (
      !model ||
      freshness < model.latestSourceEndNs ||
      freshness - model.latestSourceEndNs > MAX_MAPPING_AGE_NS
    )
      return null;

    const continuation =
      requested < model.sourceStartNs
        ? model.sourceStartNs - requested
        : requested > model.sourceEndNs
          ? requested - model.sourceEndNs
          : 0n;

    if (continuation > MAX_MAPPING_AGE_NS) return null;

    const sourceDelta = Number(requested - model.sourceOriginNs);
    const rates = model.polygon.map(({ a }) => a);
    const rate = (Math.min(...rates) + Math.max(...rates)) / 2;
    const intercepts = verticalBounds(model.polygon, rate);

    if (!intercepts) return null;
    const intercept = (intercepts.minimum + intercepts.maximum) / 2;
    const estimateDelta = rate * sourceDelta + intercept;
    const extrema = model.polygon.map(({ a, b }) => a * sourceDelta + b);
    const minimumDelta = Math.min(...extrema);
    const maximumDelta = Math.max(...extrema);

    const uncertainty = Math.ceil(
      Math.max(estimateDelta - minimumDelta, maximumDelta - estimateDelta)
    );

    const helperEstimateNs = model.helperOriginNs + BigInt(Math.round(estimateDelta));
    const helperMinimumNs = model.helperOriginNs + BigInt(Math.floor(minimumDelta));
    const helperMaximumNs = model.helperOriginNs + BigInt(Math.ceil(maximumDelta));
    const offset = helperEstimateNs - requested;
    const offsetNs = Number(offset);

    if (!Number.isFinite(offsetNs) || !Number.isSafeInteger(uncertainty) || uncertainty < 0)
      return null;

    const last = [...this.samples]
      .sort((left, right) =>
        left.sourceEndNs < right.sourceEndNs ? -1 : left.sourceEndNs > right.sourceEndNs ? 1 : 0
      )
      .at(-1);

    if (!last) return null;

    return {
      generation: this.generation,
      rate,
      offsetNs,
      uncertaintyNs: uncertainty,
      sampledAtSourceNs: last.sourceMidpointNs.toString(),
      sourceStartNs: model.sourceStartNs.toString(),
      sourceEndNs: model.sourceEndNs.toString(),
      helperStartNs: model.helperStartNs.toString(),
      helperEndNs: model.helperEndNs.toString(),
      helperEstimateNs: helperEstimateNs.toString(),
      helperMinimumNs: helperMinimumNs.toString(),
      helperMaximumNs: helperMaximumNs.toString(),
      sampleCount: this.samples.length,
    };
  }

  helperNsAt(sourceNs: string, freshnessSourceNs: string): string | null {
    return this.mappingAt(sourceNs, freshnessSourceNs)?.helperEstimateNs ?? null;
  }

  frameMappingAt(
    sourceNs: string,
    originHelperNs: string,
    sampleRate: number,
    freshnessSourceNs: string
  ): {
    frame: number;
    uncertaintyFrames: number;
    mapping: MeetingClockMapping;
  } | null {
    const mapping = this.mappingAt(sourceNs, freshnessSourceNs);
    const origin = parseNs(originHelperNs);

    if (!mapping || origin === null || !Number.isSafeInteger(sampleRate) || sampleRate <= 0)
      return null;

    const frame = Math.round(
      (Number(BigInt(mapping.helperEstimateNs) - origin) * sampleRate) / 1e9
    );

    const uncertaintyFrames = Math.ceil((mapping.uncertaintyNs * sampleRate) / 1e9);

    return Number.isSafeInteger(frame) && frame >= 0 ? { frame, uncertaintyFrames, mapping } : null;
  }

  frameAt(
    sourceNs: string,
    originHelperNs: string,
    sampleRate: number,
    originFrame: number,
    freshnessSourceNs: string
  ): number | null {
    const position = this.frameMappingAt(sourceNs, originHelperNs, sampleRate, freshnessSourceNs);

    return position && Number.isSafeInteger(originFrame) && originFrame >= 0
      ? originFrame + position.frame
      : null;
  }
}

function buildModel(samples: AcceptedSample[], requireSpan = true): Model | null {
  if (!samples.length || (requireSpan && samples.length < 2)) return null;

  const ordered = [...samples].sort((left, right) =>
    left.sourceMidpointNs < right.sourceMidpointNs
      ? -1
      : left.sourceMidpointNs > right.sourceMidpointNs
        ? 1
        : 0
  );

  if (
    requireSpan &&
    ordered[ordered.length - 1].sourceMidpointNs - ordered[0].sourceMidpointNs < MIN_SAMPLE_SPAN_NS
  )
    return null;
  const sourceOriginNs = ordered[0].sourceStartNs;
  const helperOriginNs = ordered[0].helperReceiveNs;

  const constraints = ordered.map((sample) => ({
    sourceStart: Number(sample.sourceStartNs - sourceOriginNs),
    sourceEnd: Number(sample.sourceEndNs - sourceOriginNs),
    helperReceive: Number(sample.helperReceiveNs - helperOriginNs),
    helperSend: Number(sample.helperSendNs - helperOriginNs),
  }));

  if (constraints.some((sample) => !Object.values(sample).every(Number.isSafeInteger))) return null;

  const lowers = constraints.flatMap(({ sourceEnd, helperSend }) => [
    helperSend - MAX_RATE * sourceEnd,
    helperSend - MIN_RATE * sourceEnd,
  ]);

  const uppers = constraints.flatMap(({ sourceStart, helperReceive }) => [
    helperReceive - MAX_RATE * sourceStart,
    helperReceive - MIN_RATE * sourceStart,
  ]);

  const minB = Math.min(...lowers) - 1;
  const maxB = Math.max(...uppers) + 1;

  let polygon: Point[] = [
    { a: MIN_RATE, b: minB },
    { a: MAX_RATE, b: minB },
    { a: MAX_RATE, b: maxB },
    { a: MIN_RATE, b: maxB },
  ];

  for (const sample of constraints) {
    polygon = clip(polygon, (point) => sample.helperSend - point.a * sample.sourceEnd - point.b);
    polygon = clip(
      polygon,
      (point) => point.b - sample.helperReceive + point.a * sample.sourceStart
    );

    if (!polygon.length) return null;
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  return {
    polygon,
    sourceOriginNs,
    helperOriginNs,
    sourceStartNs: first.sourceStartNs,
    sourceEndNs: last.sourceEndNs,
    helperStartNs: first.helperReceiveNs,
    helperEndNs: last.helperSendNs,
    latestSourceEndNs: ordered.reduce(
      (latest, sample) => (sample.sourceEndNs > latest ? sample.sourceEndNs : latest),
      0n
    ),
  };
}

function clip(polygon: Point[], evaluate: (point: Point) => number): Point[] {
  if (!polygon.length) return [];
  const result: Point[] = [];
  let previous = polygon[polygon.length - 1];
  let previousValue = evaluate(previous);

  for (const current of polygon) {
    const currentValue = evaluate(current);
    const previousInside = previousValue <= GEOMETRY_EPSILON;
    const currentInside = currentValue <= GEOMETRY_EPSILON;

    if (previousInside !== currentInside) {
      const fraction = previousValue / (previousValue - currentValue);
      result.push({
        a: previous.a + fraction * (current.a - previous.a),
        b: previous.b + fraction * (current.b - previous.b),
      });
    }

    if (currentInside) result.push(current);
    previous = current;
    previousValue = currentValue;
  }

  return result;
}

function verticalBounds(
  polygon: Point[],
  rate: number
): { minimum: number; maximum: number } | null {
  const intercepts: number[] = [];

  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];

    if (Math.abs(current.a - rate) <= GEOMETRY_EPSILON) intercepts.push(current.b);

    if ((current.a < rate && next.a > rate) || (current.a > rate && next.a < rate)) {
      const fraction = (rate - current.a) / (next.a - current.a);
      intercepts.push(current.b + fraction * (next.b - current.b));
    }
  }

  if (!intercepts.length) return null;

  return { minimum: Math.min(...intercepts), maximum: Math.max(...intercepts) };
}
