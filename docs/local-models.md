# Local models (on the phone)

Talorys can run two small models on the Android phone with Google's LiteRT-LM
(`com.google.ai.edge.litertlm:litertlm-android:0.19.0`) and use them as entries in the model chain.

| Id | Model | File | Size | RAM | Prompt / output budget |
| --- | --- | --- | --- | --- | --- |
| `device:spark-x2.5-1.7b` | Spark-X2.5 1.7B (iFLYTEK, Apache 2.0, reasoning) | litert-community/Spark-X2.5-1.7B `Spark-X2.5-1.7B_int8.litertlm` @ `3e8a954e` | ~1.8 GB | 3 GB+ | 1024 / 3072 (4096-token KV cache; `<think>` stripped, thinking capped at 1536) |
| `device:gemma-4-e4b` | Gemma 4 E4B (Google, Apache 2.0) | litert-community/gemma-4-E4B-it-litert-lm `gemma-4-E4B-it.litertlm` @ `71064b01` | ~3.7 GB | 6 GB+ (blocked below) | 6000 / 2048 |

Files are pinned to a Hugging Face commit and verified by size and SHA-256 (`packages/shared/src/device.ts`).

## How it fits the chain

1. **Phone**: Settings → Local models. Download a model (resumable, optional Wi‑Fi only), run a test prompt,
   and switch on **Use in chain**. That appends `device:<id>` to the end of the chain; reorder it in
   Settings → Model chain (web or app). The existing order is never changed automatically.
2. **Bridge**: while the app is in the foreground, or in the background when "Keep connected" is on
   (via the keyboard's `CompanionService`), the phone holds a WebSocket to `/api/device/bridge`
   (Durable Object, hibernation API, native bearer token; bad token → close 4401). It reports which
   models are downloaded/loaded.
3. **Runner**: when the chain reaches a device entry, the agent sends the trimmed conversation over the
   bridge, text only (no tools), and streams tokens back. It skips to the next entry with a reason when the
   phone is offline (`device_offline`), the model is not downloaded (`not_downloaded`), "Use in chain" is
   off, or the first token takes longer than `device.firstTokenTimeoutS` (20 s). Overall cap:
   `device.overallTimeoutS` (240 s). Offline / not-downloaded entries are never put on cooldown.
4. **Status**: `/api/device/status`, `/api/ai/models`, `/api/ai/chain` and the chain editors show device
   entries ("Phone not connected", "Not downloaded").

## Offline fallback

When the mobile chat cannot reach the agent at all (network error, or the edge answering 502/504/52x
before the turn starts) and **Offline fallback** is on, the selected downloaded model answers on the phone.
The reply is marked "Answered on this phone (offline)". It has no tools, memory or internet.

## Engine

GPU backend first, CPU fallback. One model loaded at a time; unloaded after 10 idle minutes. Generation
is cancellable. Native library adds ~23 MB (arm64 only).

## Build notes

LiteRT-LM 0.19.0 needs Kotlin ≥ 2.3 tooling, so `app.json` sets `expo-build-properties.android.kotlinVersion`
to `2.3.21`. The Mobile APK workflow also runs `:talorys-local-llm:testDebugUnitTest`.

## Reusing the bridge

Bridge messages are generic (`type`, `id`, payload), so the planned computer-use commands
(`device_read_screen`, `device_act`) can ride the same connection.

## Known gaps

- Hebrew quality of both models is untested.
- Spark answers can take 1–2 minutes on a phone (reasoning).
- WebSocket through the Pages Function not yet tried on a real phone.
- Background connection costs battery.
