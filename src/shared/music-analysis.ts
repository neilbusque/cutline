/** Source-time audio measurements. No raw PCM is retained in a project. */
export type MusicAnalysis = {
  version: 1;
  bpm?: number;
  confidence: number;
  beats: { time: number; strength: number }[];
  envelope: { step: number; values: number[] };
  duration: number;
};

export const MUSIC_ANALYSIS_MAX_SECONDS = 20 * 60;
export const MUSIC_ANALYSIS_SAMPLE_RATE = 11025;
const ENVELOPE_STEP = 0.05;
const round = (value: number, places = 4) =>
  Math.round(value * 10 ** places) / 10 ** places;
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = values.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Estimates a stable onset grid, not a musical meter or downbeat. Requiring both
 * interval agreement and a phase-consistent grid avoids inventing a BPM from
 * silence, isolated impacts, or an audio passage that changes tempo.
 */
function tempo(onsets: MusicAnalysis["beats"]) {
  if (onsets.length < 6 || onsets.at(-1)!.time - onsets[0].time < 2.5)
    return { confidence: 0 };
  const intervals = onsets
    .slice(1)
    .map((beat, i) => beat.time - onsets[i].time);
  const usable = intervals.filter(
    (interval) => interval >= 0.25 && interval <= 1.5,
  );
  if (usable.length < 5) return { confidence: 0 };

  // A small histogram keeps the work bounded even for a 20-minute source.
  const bins = new Float64Array(376);
  for (const interval of usable) bins[Math.round(interval / 0.004)]++;
  const candidates = Array.from(bins, (count, bin) => ({
    period: bin * 0.004,
    count: count + (bins[bin - 1] ?? 0) + (bins[bin + 1] ?? 0),
  }))
    .filter((candidate) => candidate.period >= 0.25 && candidate.count > 0)
    .sort((a, b) => b.count - a.count)
    .filter(
      (candidate, i, all) =>
        !all
          .slice(0, i)
          .some(
            (previous) => Math.abs(previous.period - candidate.period) < 0.025,
          ),
    )
    .slice(0, 6);
  let best: { bpm?: number; confidence: number } = { confidence: 0 };
  for (const candidate of candidates) {
    const neighbors = usable.filter(
      (interval) =>
        Math.abs(interval - candidate.period) <=
        Math.max(0.016, candidate.period * 0.045),
    );
    let period = median(neighbors);
    if (!period) continue;
    // Infer integer beat increments locally, then fit source times over the
    // whole passage. The median of quantized hops has a small systematic bias
    // that otherwise accumulates into seconds of phase drift on long audio.
    const indices = [0];
    for (const interval of intervals)
      indices.push(
        indices.at(-1)! + Math.max(1, Math.round(interval / period)),
      );
    let selected = onsets.map((_, i) => i);
    for (let pass = 0; pass < 2; pass++) {
      const meanIndex =
        selected.reduce((sum, i) => sum + indices[i], 0) / selected.length;
      const meanTime =
        selected.reduce((sum, i) => sum + onsets[i].time, 0) / selected.length;
      let covariance = 0,
        variance = 0;
      for (const i of selected) {
        covariance += (indices[i] - meanIndex) * (onsets[i].time - meanTime);
        variance += (indices[i] - meanIndex) ** 2;
      }
      const fitted = variance > 0 ? covariance / variance : period;
      if (Math.abs(fitted - candidate.period) > candidate.period * 0.1) break;
      period = fitted;
      const intercept = meanTime - period * meanIndex;
      const residuals = onsets.map((onset, i) =>
        Math.abs(onset.time - (intercept + period * indices[i])),
      );
      const limit = Math.max(0.02, median([...residuals]) * 3);
      selected = selected.filter((i) => residuals[i] <= limit);
      if (selected.length < 6) break;
    }
    const tolerance = Math.max(0.018, period * 0.055);
    const direct =
      intervals.filter((interval) => Math.abs(interval - period) <= tolerance)
        .length / intervals.length;
    const consistent =
      intervals.filter((interval) => {
        const multiple = Math.round(interval / period);
        return (
          multiple >= 1 &&
          multiple <= 4 &&
          Math.abs(interval - multiple * period) <= tolerance
        );
      }).length / intervals.length;
    let grid = 0;
    // Search a bounded set of phases, including later positions after a pickup.
    const anchors = Math.min(24, onsets.length);
    for (let i = 0; i < anchors; i++) {
      const anchor = onsets[Math.floor((i * onsets.length) / anchors)].time;
      let matches = 0;
      for (const onset of onsets) {
        const phase = (onset.time - anchor) / period;
        if (Math.abs(phase - Math.round(phase)) * period <= tolerance)
          matches++;
      }
      grid = Math.max(grid, matches / onsets.length);
    }
    const support = Math.min(1, (onsets.length - 3) / 8);
    const confidence = Math.min(
      1,
      (direct * 0.4 + consistent * 0.25 + grid * 0.35) * support,
    );
    if (confidence > best.confidence)
      best = {
        confidence,
        ...(direct >= 0.6 &&
        consistent >= 0.8 &&
        grid >= 0.8 &&
        confidence >= 0.72
          ? { bpm: round(60 / period, 2) }
          : {}),
      };
  }
  return { ...best, confidence: round(best.confidence, 3) };
}

/** Analyze mono PCM locally; non-finite samples are treated as silence. */
export function analyzePcm(
  samples: Float32Array,
  sampleRate: number,
): MusicAnalysis {
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000)
    throw Error("Audio sample rate must be between 1000 and 384000 Hz");
  const count = Math.min(
    samples.length,
    Math.floor(sampleRate * MUSIC_ANALYSIS_MAX_SECONDS),
  );
  const duration = count / sampleRate;
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const frames = Math.ceil(count / hop);
  const broad = new Float64Array(frames);
  const bass = new Float64Array(frames);
  const high = new Float64Array(frames);
  const envelopeSum = new Float64Array(Math.ceil(duration / ENVELOPE_STEP));
  const envelopeCount = new Uint32Array(envelopeSum.length);
  const lowAlpha = 1 - Math.exp((-2 * Math.PI * 180) / sampleRate);
  let low = 0;
  for (let start = 0, frame = 0; start < count; start += hop, frame++) {
    const end = Math.min(count, start + hop);
    let wideEnergy = 0,
      lowEnergy = 0,
      highEnergy = 0;
    for (let i = start; i < end; i++) {
      const sample = Number.isFinite(samples[i])
        ? Math.max(-1, Math.min(1, samples[i]))
        : 0;
      low += lowAlpha * (sample - low);
      const residual = sample - low;
      const energy = sample * sample;
      wideEnergy += energy;
      lowEnergy += low * low;
      highEnergy += residual * residual;
      const bin = Math.min(
        envelopeSum.length - 1,
        Math.floor(i / sampleRate / ENVELOPE_STEP),
      );
      envelopeSum[bin] += energy;
      envelopeCount[bin]++;
    }
    broad[frame] = Math.sqrt(wideEnergy / (end - start));
    bass[frame] = Math.sqrt(lowEnergy / (end - start));
    high[frame] = Math.sqrt(highEnergy / (end - start));
  }
  const envelope = Array.from(envelopeSum, (sum, i) =>
    Math.sqrt(sum / Math.max(1, envelopeCount[i])),
  );
  const envelopePeak = envelope.reduce((max, value) => Math.max(max, value), 0);
  const result: MusicAnalysis = {
    version: 1,
    confidence: 0,
    beats: [],
    envelope: {
      step: ENVELOPE_STEP,
      values: envelope.map((value) =>
        envelopePeak > 1e-7 ? round(value / envelopePeak) : 0,
      ),
    },
    duration,
  };
  if (envelopePeak <= 1e-7 || frames < 3) return result;

  const novelty = new Float64Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let wideBase = 0,
      lowBase = 0,
      highBase = 0;
    for (let lookback = 1; lookback <= 4; lookback++) {
      wideBase += broad[i - lookback] ?? 0;
      lowBase += bass[i - lookback] ?? 0;
      highBase += high[i - lookback] ?? 0;
    }
    novelty[i] =
      Math.max(0, broad[i] - wideBase / 4) * 0.4 +
      Math.max(0, bass[i] - lowBase / 4) * 0.45 +
      Math.max(0, high[i] - highBase / 4) * 0.15;
    peak = Math.max(peak, novelty[i]);
  }
  if (peak < 1e-7) return result;
  const radius = Math.max(1, Math.round((0.3 * sampleRate) / hop));
  const minDistance = 0.12;
  for (let i = 0; i < frames; i++) {
    const value = novelty[i];
    if (
      value < peak * 0.055 ||
      value < (novelty[i - 1] ?? 0) ||
      value <= (novelty[i + 1] ?? -1)
    )
      continue;
    if (value < (novelty[i - 2] ?? 0) || value < (novelty[i + 2] ?? 0))
      continue;
    const neighborhood = Array.from(
      novelty.slice(Math.max(0, i - radius), Math.min(frames, i + radius + 1)),
    );
    const localMedian = median(neighborhood);
    const deviation = median(
      neighborhood.map((sample) => Math.abs(sample - localMedian)),
    );
    if (value <= localMedian + 3 * deviation + peak * 0.012) continue;
    // Peaks can occur a hop after the attack, especially in the low band.
    let attack = i;
    while (attack > Math.max(0, i - 3) && novelty[attack - 1] >= value * 0.25)
      attack--;
    const onset = {
      time: round((attack * hop) / sampleRate),
      strength: round(Math.min(1, value / peak)),
    };
    const previous = result.beats.at(-1);
    if (previous && onset.time - previous.time < minDistance) {
      if (onset.strength > previous.strength)
        result.beats[result.beats.length - 1] = onset;
    } else result.beats.push(onset);
  }
  Object.assign(result, tempo(result.beats));
  return result;
}
