# Denoise, Enhance voice, and volume

This describes the implemented pipeline, rather than the proposed configurable voice presets.

## Denoise

Denoise makes a processed copy intended to reduce unwanted noise while retaining speech. It does not remove filler words, cut silences, retime lines, boost bass, or change voice pitch. How much noise is removed depends on the recording and engine; competing speech and room reverberation are not guaranteed to disappear. Strong processing can produce audible artifacts.

The standalone Denoise button defaults to automatic engine selection and strength 0.7:

- DeepFilterNet, if installed: runs the external speech-enhancement engine on 48 kHz mono audio, then encodes/remuxes its result. The current integration does not apply the strength setting.
- Otherwise RNNoise, if its model is installed: resamples to 48 kHz and uses FFmpeg's neural `arnndn` filter. Default mix is 0.7: 70% processed signal, 30% original. This is a blend, not a promise that 70% of noise disappears.
- Otherwise FFmpeg's spectral `afftdn` filter: estimates and reduces noise by frequency, with automatic noise-floor tracking. At default strength the configured reduction is 23 dB and noise-floor estimate is -38 dB; these are filter settings rather than measured guarantees.

Jellybingus was checked on 2026-10-18: RNNoise and FFmpeg are installed; DeepFilterNet is not. Automatic denoising therefore uses RNNoise there. The separate Denoise engine dropdown controls this operation.

## Enhance voice

Enhance voice runs the following fixed chain in order. The UI defaults are denoise enabled, strength 0.5, and target loudness -16 LUFS.

1. **Rumble filtering:** `highpass=f=75` attenuates frequencies below roughly 75 Hz, reducing low rumble and handling noise. This does not add bass.
2. **Noise suppression:** when RNNoise's model exists, resample to 48 kHz and use `arnndn` with mix 0.55 at the default enhancement strength. Otherwise use `afftdn` with reduction 11 dB, noise-floor estimate -32 dB, and noise-floor tracking. Enhancement currently chooses between these two; it does not use DeepFilterNet or follow the standalone Denoise dropdown. The CLI/API can disable this stage.
3. **De-essing:** `deesser=i=0.4` reduces excessive high-frequency sibilance, such as harsh “s” sounds.
4. **Compression:** threshold -18 dB, ratio 3:1, attack 5 ms, release 120 ms. This reduces level differences between louder and quieter speech. Makeup gain is a multiplier of 2 (roughly +6 dB), before the final loudness stage.
5. **Loudness normalization:** `loudnorm=I=-16:TP=-1.5:LRA=11` targets -16 LUFS integrated loudness, a -1.5 dB true-peak ceiling, and an 11 LU loudness range. It currently runs in one pass. These are processing targets, not a final-mix guarantee after subsequent clip/track gains or overlapping clips.

The result is intended to sound cleaner and more even. It does not synthesize a different voice, shift pitch, add bass EQ, remove filler words, or trim pauses. The “Remove um/uh/like” and “Clean up voice” buttons are separate editing operations.

## How processing affects the edit

Denoise and Enhance voice process the underlying source file, create a derived asset, and switch selected clips to that result. Original recordings stay in Media. Video is copied without re-encoding; processed audio is currently AAC at 192 kb/s. Multiple selected clips sharing a source reuse one processed copy. Unselected clips retain their sources. Timeline positions, trims, durations, and script links are preserved.

Loudness is measured over the source being processed, which can include audio outside an individual trimmed clip. It is not a master loudness pass across the complete edited video. Enhance already includes noise suppression, so running Denoise first is not required and would apply noise processing twice unless enhancement's denoise stage is disabled.

## Track and clip volume

The slider beneath VO/A1/V1 changes the track multiplier from 0% to 200%; double-click resets it to 100%. Individual clip gains remain independent. A 70% clip on a 125% track has an effective gain of 87.5%, before fades or volume automation. Mute still overrides the track. Existing projects without a track gain use 100%, and new clips inherit the track multiplier through playback/export.

Preview and export both apply track gain. The preview uses Web Audio when gain above 100% is required; recording mute also silences that path.

```sh
neon-cli tracks update VO --volume 1.25
neon-cli ai enhance <clip> --lufs=-16 --no-denoise
```

## Cancelling an AI job

The X button aborts the current engine process tree, stops the remaining processing stages, and marks the job Cancelled after process cleanup. A cancelled filler analysis cannot subsequently cut the edit. Queued jobs can be removed before they start. Cancellation does not undo edits already applied by earlier completed stages or sources; use history/undo for those.

Sources: `packages/ai/src/denoise.ts`, `packages/ai/src/enhance.ts`, and the [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html).
