/**
 * Whisper endpoint test: parses a WAV file (RIFF header, PCM 16-bit, any
 * sample rate, mono or stereo), downmixes to mono, resamples to 16 kHz with
 * linear interpolation, POSTs the samples as raw little-endian Float32 to
 * POST /api/transcribe, and prints the JSON response.
 *
 * Run: npx tsx scripts/transcribe-test.ts [path/to/clip.wav]
 * (defaults to scripts/sample.wav)
 */

const BASE = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:8887';
const TARGET_RATE = 16000;

type ParsedWav = { channels: number; sampleRate: number; samples: Float32Array };

function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;

  // Walk the chunk list: every chunk is <4-byte id><u32 LE size><payload>,
  // padded to an even length.
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body); // 1 = PCM, 0xfffe = extensible PCM
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    offset = body + size + (size % 2);
  }

  if (format !== 1 && format !== 0xfffe) throw new Error(`unsupported WAV format ${format} (want PCM)`);
  if (!data || data.length === 0) throw new Error('no data chunk found');
  if (bitsPerSample !== 16) throw new Error(`unsupported bit depth ${bitsPerSample} (want 16-bit)`);
  if (channels < 1) throw new Error('invalid channel count');

  // 16-bit little-endian samples, downmixed to mono, scaled to [-1, 1].
  const frames = Math.floor(data.length / (2 * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    mono[i] = sum / channels / 32768;
  }
  return { channels, sampleRate, samples: mono };
}

function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input;
  const outLength = Math.floor((input.length * TARGET_RATE) / fromRate);
  const out = new Float32Array(outLength);
  const step = fromRate / TARGET_RATE;
  for (let j = 0; j < outLength; j++) {
    const pos = j * step;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = i < input.length ? input[i] : 0;
    const b = i + 1 < input.length ? input[i + 1] : a;
    out[j] = a + (b - a) * frac; // linear interpolation
  }
  return out;
}

async function main(): Promise<void> {
  const wavPath = process.argv[2] ?? 'scripts/sample.wav';
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(wavPath);

  const { channels, sampleRate, samples } = parseWav(buf);
  const pcm = resampleTo16k(samples, sampleRate);
  console.log(
    `wav: ${wavPath} -> ${channels}ch, ${sampleRate} Hz, ${samples.length} frames -> mono 16 kHz, ${pcm.length} samples (${(pcm.length / TARGET_RATE).toFixed(2)} s)`
  );

  // Fresh, aligned ArrayBuffer -> little-endian Float32 bytes.
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const res = await fetch(`${BASE}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // keep raw text
  }
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  if (res.status !== 200) process.exitCode = 1;
}

void main();
