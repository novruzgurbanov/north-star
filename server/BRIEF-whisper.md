# Brief: local Whisper transcription endpoint

Add speech-to-text to the existing North Star backend so users can talk to the agent instead of typing. Whisper runs **locally in this Node server** via `@huggingface/transformers` (ONNX, CPU). No external API keys.

Work ONLY inside `C:\Users\nowru\Documents\assistant\hackathon\north-star\server`. Do not print or log `.env`. Do not change existing routes or their behaviour. There is no git repo; do not commit.

## Install

`npm i @huggingface/transformers` (network is available). Do not change other dependencies.

## New file `src/transcribe.ts`

- Lazily create one `pipeline('automatic-speech-recognition', MODEL)` and reuse it (cache the promise so concurrent requests share one load).
- `MODEL = process.env.WHISPER_MODEL || 'onnx-community/whisper-base'` (multilingual). If that model id fails to load, fall back to `'Xenova/whisper-base'`.
- Store downloaded models in `server/.cache/models` (set `env.cacheDir` from `@huggingface/transformers`, resolve relative to this file, not the cwd).
- Pick quantized weights that load on Windows CPU and are fast (for example `dtype: 'q8'`, or `{ encoder_model: 'fp32', decoder_model_merged: 'q8' }` if q8 encoder is not available). Verify it actually loads.
- `export async function warmUp()` loads the model (call it from `main()` in `index.ts` without awaiting; log `[whisper] ready in Xs` or the error, never crash).
- `export async function transcribe(pcm: Float32Array): Promise<{ text: string; ms: number }>`:
  - input is mono 16 kHz Float32 PCM.
  - call the pipeline with `chunk_length_s: 30, stride_length_s: 5`, `task: 'transcribe'`, and **no forced language** so Whisper auto-detects (users speak English, Russian, Turkmen, Japanese…).
  - trim the text; drop obvious Whisper silence hallucinations if the whole result is one of: `""`, `"[BLANK_AUDIO]"`, `"(silence)"`, `"you"`, `"Thank you."`, `"Thanks for watching!"`.

## New route in `src/index.ts`

`POST /api/transcribe`
- Body: raw bytes, `Content-Type: application/octet-stream`, Float32Array little-endian, 16 kHz mono. Use `express.raw({ type: 'application/octet-stream', limit: '12mb' })` **on this route only** (keep the global `express.json`).
- Reject empty bodies or a byte length not divisible by 4 with 400. Reject more than 120 s of audio (120 * 16000 samples) with 413.
- Copy the Buffer into a fresh, aligned `ArrayBuffer` before making the `Float32Array` (Buffer offsets may be unaligned).
- Return `{ text: string, ms: number, seconds: number }` (seconds = audio duration).
- Errors use the existing `{ error }` handler.

Also add `GET /api/transcribe/status` → `{ ready: boolean, model: string, error?: string }`.

Add `.cache` to `server/.gitignore`. Add `WHISPER_MODEL` to nothing else (env is optional).

## Acceptance checks (run them yourself)

1. `npx tsc --noEmit` passes.
2. Make a test clip with Windows text-to-speech, e.g. in PowerShell:
   `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile("$PWD\scripts\sample.wav"); $s.Speak("I want to run my first half marathon next spring."); $s.Dispose()`
3. Write `scripts/transcribe-test.ts`: read the WAV (parse the RIFF header yourself: PCM 16-bit, any sample rate, mono or stereo), downmix to mono, resample to 16 kHz (linear interpolation is fine), POST it as Float32 to `http://localhost:8787/api/transcribe`, print the JSON.
4. Start the server in the background (`npm start`; the API port is `API_PORT=8787` from `.env`), wait for `[whisper] ready`, run the test script, and confirm the text is close to the spoken sentence. Report the transcription time for the clip. Also confirm a 400 for an empty body. Then stop the server and make sure port 8787 is free.

When finished, write `DONE-whisper.md` here: what you built, the model and dtype that worked, load time, transcription time, and anything that did not work.
