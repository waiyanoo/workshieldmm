import { useFeatures } from "./useFeatures";

/**
 * Whether Tier B (conduct reports) is enabled in this environment.
 *
 * Kept as its own hook because most call sites care about this one flag only;
 * the fetch and the cache live in useFeatures now that there is more than one.
 */
export function useTierB(): boolean {
  return useFeatures().tierB;
}
