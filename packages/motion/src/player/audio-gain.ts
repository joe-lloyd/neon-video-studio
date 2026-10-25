/** HTMLMediaElement.volume stops at 1; Web Audio supplies genuine clip/track gain above unity. */
let context: AudioContext | null = null;
interface Route { source: MediaElementAudioSourceNode; gain: GainNode; connected: boolean }
const routes = new WeakMap<HTMLMediaElement, Route>();

export function resumePreviewAudio(): void {
  if (context?.state === 'suspended') void context.resume().catch(() => undefined);
}

export function setMediaGain(media: HTMLMediaElement, volume: number): void {
  let route = routes.get(media);
  if (!route && volume <= 1) { media.volume = Math.max(0, volume); return; }
  if (!route) {
    context ??= new AudioContext();
    route = { source: context.createMediaElementSource(media), gain: context.createGain(), connected: false };
    routes.set(media, route);
  }
  if (!route.connected) {
    route.source.connect(route.gain);
    route.gain.connect(context!.destination);
    route.connected = true;
  }
  media.volume = 1;
  route.gain.gain.cancelScheduledValues(context!.currentTime);
  if (volume <= 0) route.gain.gain.setValueAtTime(0, context!.currentTime);
  else route.gain.gain.setTargetAtTime(volume, context!.currentTime, 0.01);
  resumePreviewAudio();
}

export function releaseMediaGain(media: HTMLMediaElement): void {
  const route = routes.get(media);
  if (!route) return;
  route.source.disconnect();
  route.gain.disconnect();
  route.connected = false;
}
