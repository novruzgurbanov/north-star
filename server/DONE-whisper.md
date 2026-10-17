# DONE — local Whisper transcription endpoint

Implements `BRIEF-whisper.md` exactly. All work is inside `server/`; no existing routes or dependencies changed; no `.env` contents printed; nothing committed.

## What was built

| File | Purpose |
|---|---|
| `src/transcribe.ts` | Lazy Whisper loader + `transcribe()`. One `pipeline('automatic-speech-recognition', …)` cached as a **promise** so concurrent requests share a single load. `env.cacheDir` resolved from the module's own path to `server/.cache/models` (cwd-independent). `warmUp()` never throws (logs `[whisper] ready in Xs` or the error); `getStatus()` backs the status route. `transcribe(pcm)` takes mono 16 kHz Float32, runs with `chunk_length_s: 30, stride_length_s: 5, task: 'transcribe'` and **no forced language** (auto-detect), trims, and returns `{ text, ms }` — emptying the result when the whole output matches a known silence hallucination (`""`, `[BLANK_AUDIO]`, `(silence)`, `you`, `Thank you.`, `Thanks for watching!`, case-insensitive) |
| `src/index.ts` | Two new routes only: `POST /api/transcribe` (route-scoped `express.raw({ type: 'application/octet-stream', limit: '12mb' })`; global `express.json` untouched; 400 empty / 400 not-multiple-of-4 / 413 >120 s; Buffer copied into a fresh zero-offset `ArrayBuffer` before the `Float32Array` view; replies `{ text, ms, seconds }`; failures flow through the existing `{ error }` handler) and `GET /api/transcribe/status` (`{ ready, model, error? }`). `main()` now calls `warmUp().catch(() => {})` without awaiting |
| `scripts/transcribe-test.ts` | Test client: parses a RIFF/WAVE file itself (PCM 16-bit, any sample rate, mono/stereo — handles odd-sized chunks), downmixes to mono, resamples to 16 kHz by linear interpolation, POSTs the samples as little-endian Float32 with `Content-Type: application/octet-stream`, prints the JSON. Run: `npx tsx scripts/transcribe-test.ts [clip.wav]` |
| `scripts/sample.wav` | TTS clip "I want to run my first half marathon next spring." (System.Speech, 22 050 Hz mono 16-bit) |
| `.gitignore` | added `.cache` |
| `package.json` | added `@huggingface/transformers@^4.3.1` (only dependency changed) |

## Model, dtype, and timings

- **Model that worked**: `onnx-community/whisper-base` (multilingual), **first choice — the `Xenova/whisper-base` fallback never triggered**.
- **Dtype that worked**: plain **`dtype: 'q8'`** → `onnx/encoder_model_quantized.onnx` + `onnx/decoder_model_merged_quantized.onnx` (in transformers.js v4, `q8` maps to the `_quantized` suffix; both files exist in the repo, verified before loading). The hybrid plan `{ encoder_model: 'fp32', decoder_model_merged: 'q8' }` is implemented as an automatic second attempt but was never needed.
- **Cache**: `server/.cache/models/onnx-community/whisper-base/`, 76 MB, gitignored.
- **Load time**: `[whisper] ready in 4.2s` on first boot (includes the ~76 MB download); **1.0 s** on a warm boot from the disk cache.
- **Transcription time**: **~1.0 s** (1038 ms cold call, 1027 ms warm) for the 3.67 s clip — ~0.28× realtime on CPU. A 120 s request transcribes in ~4.3 s (chunked path).
- **Accuracy**: exact — `"I want to run my first half marathon next spring."` on both runs.

## Acceptance checks (all run)

1. `npx tsc --noEmit` — passes (run again after adding the test script; `scripts/` is in the tsconfig include).
2. TTS clip created with the exact PowerShell snippet from the brief → `scripts/sample.wav` (RIFF/WAVE, PCM 16-bit, 22 050 Hz, mono).
3. `scripts/transcribe-test.ts` parses the header itself, downmixes, resamples to 16 kHz (58 701 samples / 3.67 s), POSTs, prints: `HTTP 200 {"text":"I want to run my first half marathon next spring.","ms":1038,"seconds":3.6688125}`.
4. Server started in background (`npm start`), log showed `[whisper] ready in 4.2s (model: onnx-community/whisper-base)`; test transcribed correctly; **empty body → 400**; server stopped, **port 8787 verified free** (and re-verified free after the second boot).

Extra (beyond the brief's list): `GET /api/transcribe/status` → `{"ready":true,"model":"onnx-community/whisper-base"}`; non-multiple-of-4 body → 400; JSON body to `/api/transcribe` → 400; 121 s body (multiple of 4) → 413 `{"error":"audio longer than 120 s"}`; exactly 120 s → 200 with `seconds: 120` (chunking exercised); `/api/health` unchanged (`{ok:true,neo4j:true,llm:true}`).

## Notes / things that did not work

- Nothing failed functionally. One clarification worth recording: the brief's hallucination filter drops a result only when the **whole** output matches one of the listed strings. Pure zero-silence padding produces repeated per-chunk artifacts like `"you you you you you you"`, which don't match and are therefore kept — exactly as specified. Real speech input is unaffected (the filter catches the listed trailing hallucinations on trimmed short clips).
- First 413 probe accidentally sent 7 680 001 bytes (not divisible by 4) and got the 400; retested with a proper multiple-of-4 body to confirm 413. Test-ordering artifact, not a bug.
- tsx keeps `npm start` in the foreground; the background shell "exits with code 1" when the tree is force-killed for cleanup — expected, not a crash.
