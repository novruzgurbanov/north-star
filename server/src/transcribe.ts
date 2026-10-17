/**
 * Local Whisper speech-to-text via @huggingface/transformers (ONNX, CPU).
 * No external API keys — models download once into server/.cache/models and
 * are reused from disk afterwards.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

// Cache downloads relative to this file, not the cwd, so `npm start` works
// from anywhere: <server>/.cache/models
const HERE = path.dirname(fileURLToPath(import.meta.url));
env.cacheDir = path.resolve(HERE, '..', '.cache', 'models');

const MODEL = process.env.WHISPER_MODEL || 'onnx-community/whisper-base'; // multilingual
const FALLBACK_MODEL = 'Xenova/whisper-base';

// Quantized weights that load on Windows CPU. `q8` selects the *_quantized.onnx
// files; if a quantized encoder is not available, keep the fp32 encoder (more
// accurate anyway) and only quantize the decoder.
type DtypePlan = 'q8' | { encoder_model: 'fp32'; decoder_model_merged: 'q8' };
const DTYPE_PLANS: DtypePlan[] = ['q8', { encoder_model: 'fp32', decoder_model_merged: 'q8' }];

type Loaded = { asr: AutomaticSpeechRecognitionPipeline; model: string };

// Cached promise so concurrent requests share a single model load.
let loadPromise: Promise<Loaded> | null = null;
let activeModel = MODEL;
let loadError: string | null = null;
let ready = false;

async function tryLoad(modelId: string): Promise<Loaded> {
  let lastError: unknown;
  for (const dtype of DTYPE_PLANS) {
    try {
      const asr = await pipeline('automatic-speech-recognition', modelId, { dtype });
      return { asr, model: modelId };
    } catch (err) {
      lastError = err;
      console.warn(
        `[whisper] ${modelId} failed to load with dtype ${JSON.stringify(dtype)}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  throw lastError;
}

function load(): Promise<Loaded> {
  if (!loadPromise) {
    loadPromise = (async () => {
      let loaded: Loaded;
      try {
        loaded = await tryLoad(MODEL);
      } catch (err) {
        if (MODEL === FALLBACK_MODEL) throw err;
        console.warn(`[whisper] falling back to ${FALLBACK_MODEL}`);
        loaded = await tryLoad(FALLBACK_MODEL);
      }
      activeModel = loaded.model;
      ready = true;
      loadError = null;
      return loaded;
    })();
    loadPromise.catch((err) => {
      // Remember why it failed (for /api/transcribe/status) and allow a later
      // retry — e.g. a transient network hiccup during warm-up.
      loadError = err instanceof Error ? err.message : String(err);
      loadPromise = null;
    });
  }
  return loadPromise;
}

/** Pre-load the model at boot. Never throws — logs instead, so startup can't crash. */
export async function warmUp(): Promise<void> {
  const started = Date.now();
  try {
    const { model } = await load();
    console.log(`[whisper] ready in ${((Date.now() - started) / 1000).toFixed(1)}s (model: ${model})`);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    console.error('[whisper] failed to load:', loadError);
  }
}

/** Current loader state for GET /api/transcribe/status. */
export function getStatus(): { ready: boolean; model: string; error?: string } {
  const status: { ready: boolean; model: string; error?: string } = { ready, model: activeModel };
  if (loadError) status.error = loadError;
  return status;
}

// Whisper's whole-output hallucinations on silence — dropped when the entire
// result matches one of these (case-insensitive).
const SILENCE_OUTPUTS = new Set([
  '',
  '[blank_audio]',
  '(silence)',
  'you',
  'thank you.',
  'thanks for watching!',
]);

/**
 * Transcribe mono 16 kHz Float32 PCM.
 * No forced language — Whisper auto-detects (users speak English, Russian,
 * Turkmen, Japanese…). Chunking handles clips longer than 30 s.
 */
export async function transcribe(pcm: Float32Array): Promise<{ text: string; ms: number }> {
  const { asr } = await load();
  const t0 = performance.now();
  const output = await asr(pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    task: 'transcribe',
  });
  const ms = Math.round(performance.now() - t0);
  const raw = Array.isArray(output) ? (output[0]?.text ?? '') : (output?.text ?? '');
  const text = raw.trim();
  return { text: SILENCE_OUTPUTS.has(text.toLowerCase()) ? '' : text, ms };
}
