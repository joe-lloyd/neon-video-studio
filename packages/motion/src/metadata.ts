/** Size, rate and length of a composition — computed from its props before anything renders. */
export interface CompositionMetadata {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

/** May also echo (possibly adjusted) props back, which callers can ignore. */
export type CalculateMetadataFunction<P> = (args: { props: P }) => CompositionMetadata & { props?: P };
