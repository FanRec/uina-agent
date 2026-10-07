import { spawn as spawnProcess } from "node:child_process";
import { trackChildProcess, untrackChildProcess } from "../../../src/extensions/world-framework/child-process-registry.js";

const SAMPLE_RATE = 22050;
const FRAME_SIZE = 2048;
const HOP_SIZE = 1024;
const BAND_COUNT = 32;
const MAX_BUFFERED_SAMPLES = FRAME_SIZE * 8;
const SILENT_BANDS = Array.from({ length: BAND_COUNT }, () => 0);

export interface SpectrumFrame { source: "audio"; bands: number[]; energy: number; beat: number; }

interface SpectrumChild {
  readonly pid?: number;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  once(event: "exit" | "error", listener: () => void): unknown;
  kill(): boolean;
}

export interface SpectrumCaptureOptions {
  ffmpegPath?: string;
  spawn?: (ffmpegPath: string, args: readonly string[]) => SpectrumChild;
  staleAfterMs?: number;
}

export function parseSpectrumLine(line: string): SpectrumFrame | null {
  try {
    const value = JSON.parse(line) as { bands?: unknown; energy?: unknown; beat?: unknown };
    if (!Array.isArray(value.bands) || value.bands.length === 0 || value.bands.some(item => typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1)) return null;
    if (typeof value.energy !== "number" || !Number.isFinite(value.energy) || value.energy < 0 || value.energy > 1) return null;
    if (typeof value.beat !== "number" || !Number.isFinite(value.beat) || value.beat < 0 || value.beat > 1) return null;
    return { source: "audio", bands: value.bands, energy: value.energy, beat: value.beat };
  } catch { return null; }
}

export function parsePcmFrame(samples: readonly number[]): SpectrumFrame | null {
  if (samples.length < FRAME_SIZE) return null;
  const frame = samples.slice(0, FRAME_SIZE);
  const windowed = new Float64Array(FRAME_SIZE);
  for (let index = 0; index < FRAME_SIZE; index += 1) windowed[index] = frame[index]! * hann(index, FRAME_SIZE);
  const magnitudes = fftMagnitudes(windowed);
  const bands = Array.from({ length: BAND_COUNT }, (_, index) => {
    const lowFreq = 35 * Math.pow(12000 / 35, index / BAND_COUNT);
    const highFreq = 35 * Math.pow(12000 / 35, (index + 1) / BAND_COUNT);
    const lowBin = Math.max(1, Math.floor((lowFreq / SAMPLE_RATE) * frame.length));
    const highBin = Math.max(lowBin, Math.ceil((highFreq / SAMPLE_RATE) * frame.length));
    let total = 0;
    let count = 0;
    for (let bin = lowBin; bin <= highBin; bin += 1) {
      total += magnitudes[bin] ?? 0;
      count += 1;
    }
    return clamp01(Math.log1p((total / Math.max(1, count)) * 18) / Math.log1p(18));
  });
  const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
  const energy = clamp01(Math.log1p(rms * 12) / Math.log1p(12));
  const bass = bands.slice(0, 6).reduce((sum, value) => sum + value, 0) / 6;
  return { source: "audio", bands, energy, beat: clamp01(bass) };
}

export class SpectrumCapture {
  private readonly ffmpegPath: string;
  private readonly spawn: (ffmpegPath: string, args: readonly string[]) => SpectrumChild;
  private readonly staleAfterMs: number;
  private child: SpectrumChild | null = null;
  private samples: number[] = [];
  private remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private frame: SpectrumFrame | null = null;
  private receivedAt = 0;
  private generation = 0;

  constructor(options: SpectrumCaptureOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
    this.spawn = options.spawn ?? ((path, args) => spawnProcess(path, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }) as SpectrumChild);
    this.staleAfterMs = options.staleAfterMs ?? 1500;
  }

  start(url: string, positionMs = 0): void {
    if (!url || url.startsWith("simulated://")) { void this.stop(); return; }
    const generation = ++this.generation;
    void this.stopCurrent().then(() => {
      if (generation !== this.generation) return;
      const args = ["-hide_banner", "-loglevel", "error", "-re", "-ss", String(Math.max(0, positionMs) / 1000), "-i", url, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"];
      try {
        const child = this.spawn(this.ffmpegPath, args);
        this.child = child;
        if (typeof child.pid === "number") trackChildProcess(child.pid);
        child.stdout?.on("data", chunk => { if (this.generation === generation && this.child === child) this.acceptPcm(Buffer.from(chunk)); });
        const stopped = () => {
          if (typeof child.pid === "number") untrackChildProcess(child.pid);
          if (this.child === child) this.child = null;
        };
        child.once("exit", stopped);
        child.once("error", stopped);
      } catch {
        this.child = null;
      }
    });
  }

  latest(playing: boolean): SpectrumFrame | { source: "silent"; bands: number[]; energy: 0; beat: 0 } {
    if (!playing || !this.frame || Date.now() - this.receivedAt > this.staleAfterMs) return { source: "silent", bands: [...SILENT_BANDS], energy: 0, beat: 0 };
    return { source: "audio", bands: [...this.frame.bands], energy: this.frame.energy, beat: this.frame.beat };
  }

  acceptLine(line: string): void {
    const frame = parseSpectrumLine(line.trim());
    if (frame) { this.frame = frame; this.receivedAt = Date.now(); }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    await this.stopCurrent();
  }

  private async stopCurrent(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.frame = null;
    this.samples = [];
    this.remainder = Buffer.alloc(0);
    this.receivedAt = 0;
    if (child) child.kill();
  }

  private acceptPcm(chunk: Buffer): void {
    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const usable = data.length - (data.length % 4);
    this.remainder = usable < data.length ? data.subarray(usable) : Buffer.alloc(0);
    for (let offset = 0; offset < usable; offset += 4) this.samples.push(data.readFloatLE(offset));
    if (this.samples.length > MAX_BUFFERED_SAMPLES) this.samples.splice(0, this.samples.length - MAX_BUFFERED_SAMPLES);
    while (this.samples.length >= FRAME_SIZE) {
      const frame = parsePcmFrame(this.samples);
      if (frame) { this.frame = frame; this.receivedAt = Date.now(); }
      this.samples.splice(0, HOP_SIZE);
    }
  }
}

function fftMagnitudes(input: Float64Array): Float64Array {
  const real = new Float64Array(input);
  const imaginary = new Float64Array(input.length);
  for (let target = 0, source = 0; target < input.length; target += 1) {
    if (target < source) { const value = real[target]!; real[target] = real[source]!; real[source] = value; }
    let bit = input.length >> 1;
    while (source & bit) { source ^= bit; bit >>= 1; }
    source ^= bit;
  }
  for (let length = 2; length <= input.length; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < input.length; start += length) {
      let currentReal = 1;
      let currentImaginary = 0;
      const half = length >> 1;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd]! * currentReal - imaginary[odd]! * currentImaginary;
        const oddImaginary = real[odd]! * currentImaginary + imaginary[odd]! * currentReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
        const nextReal = currentReal * stepReal - currentImaginary * stepImaginary;
        currentImaginary = currentReal * stepImaginary + currentImaginary * stepReal;
        currentReal = nextReal;
      }
    }
  }
  return Float64Array.from(real, (value, index) => Math.sqrt(value * value + imaginary[index]! * imaginary[index]!) / input.length);
}

function hann(index: number, length: number): number { return 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1))); }
function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
