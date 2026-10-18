# Voice enhancement: current tools and proposed additions

Audited 2026-10-18 against the source and the running Jellybingus installation.

## Available today

- AI panel → Voice clean-up → Denoise: RNNoise neural noise suppression, FFmpeg spectral denoising, and optional DeepFilterNet integration. Automatic selection prefers DeepFilterNet, then RNNoise, then spectral denoising.
- Enhance voice: fixed 75 Hz high-pass, optional noise suppression, de-esser, compressor, and loudness normalization (the UI targets -16 LUFS). This combines neural denoising with conventional audio processing.
- Remove filler words (Whisper), trim dead air, and soften breaths. These edit speech content/pacing or volume rather than adding bass or changing voice tone.
- Denoise/enhance create a derived asset and retain the original. Selecting a clip updates that clip; asset-level targeting can update multiple clips in the source family.
- Jellybingus reports FFmpeg, RNNoise's model and Whisper ready. Its FFmpeg advertises all required denoise, bass/EQ, compression, de-essing, limiter and loudness filters. DeepFilterNet is not installed.

There is no exposed bass/warmth control, voice preset selection, or dedicated level-matched audio comparison. The existing enhancement chain has no bass boost or configurable tone EQ. These operations currently produce processed copies rather than a live editable audio effect stack.

## Proposed implementation

### 1. Extend the existing enhancement operation

Ship this first; bass and tone controls need no new AI model or external service.

- Presets: Natural (conservative cleanup), Warm (gentle bass boost), and Broadcast (stronger leveling/presence). Use the current enhancement as the compatibility default for existing CLI callers.
- Controls: noise reduction amount, warmth, clarity, compression amount, and output loudness. Put de-essing and rumble filtering in advanced settings.
- Warmth: FFmpeg bass/low-shelf EQ, initially centered around 120 Hz, adjustable from 0 to +6 dB. Start Warm at +2 dB and tune by listening to actual narration samples.
- Clarity: a restrained presence EQ with a neutral default. Keep voice pitch unchanged.
- Process in a documented order: rumble filtering → denoise → tone EQ → de-ess → compression → loudness/peak control. Keep normalization and peak control after any gain boost.
- Expose identical options through the AI job API and CLI (`ai enhance --preset warm --warmth 2`, proposed syntax). Validate ranges centrally.
- Make the chosen denoiser explicit. Reject explicitly requested unavailable engines instead of silently substituting a different one. Enhancement should honor the chosen engine too; today it uses RNNoise or spectral denoising even if DeepFilterNet is available.

### 2. Make the result easy to judge and reverse

- Preview the selected line/clip before applying, with level-matched Original / Processed switching and repeat playback. Audition without changing the edit.
- Apply to the selected clip by default. Offer an explicit action for selected clips or the VO track; retain every clip's timeline timing, trims and script links.
- Save processing settings and the source asset reference. Reprocessing starts from the original to avoid repeatedly denoising and encoding already processed audio.
- Allow reset and undo; preserve the original recording. Prefer a lossless intermediate for audio-only voice assets.
- During recording, keep all audition playback silent under the existing recording mute rule.

### 3. Improve optional denoising

- Add a supported installer/detector for DeepFilterNet where a compatible distribution is available, starting with Jellybingus/Windows. Verify binaries, invocation, output naming and model availability rather than assuming installation is enough.
- Show availability and the engine actually used. Only expose strength controls where they affect processing; the current DeepFilterNet path does not apply the requested strength.
- Compare RNNoise and DeepFilterNet on representative room noise, fan noise and keyboard sounds before choosing defaults. Evaluate speech artifacts as well as noise reduction.

## Acceptance checks

- Longer/shorter line recordings and their script timing remain unchanged by enhancement; no drift after rendering.
- Preview and exported audio use the same processing result/settings.
- Warmth changes frequency balance without shifting pitch; neutral settings retain neutral tone. Check output loudness/true peaks on actual generated audio.
- A/B preview is level matched, reset restores the original, and repeated changes do not stack processing.
- Existing noise suppression and CLI callers continue to work; missing requested engines produce a clear error.
- Test on Jellybingus with copies of current narration, without replacing the user's takes during evaluation.

## References

- Existing implementation: `packages/ai/src/enhance.ts`, `packages/ai/src/denoise.ts`, `apps/desktop/src/main/ai-manager.ts`, and `apps/desktop/src/renderer/components/AiPanel.tsx`.
- FFmpeg filters: https://ffmpeg.org/ffmpeg-filters.html (bass, equalizer, acompressor, deesser, alimiter, loudnorm).
- DeepFilterNet upstream: https://github.com/Rikorose/DeepFilterNet.
