import type { FillState } from "./types.ts";

export interface DeriveFillStateOptions {
  readonly endedAt: string | null | undefined;
  readonly hasActiveAssignment: boolean;
  readonly onDeckOrder: number | null | undefined;
}

/**
 * Pure derived Fill state resolver with unambiguous precedence:
 * Ended > On Tap > On Deck > Available
 */
export function deriveFillState(options: DeriveFillStateOptions): FillState {
  if (options.endedAt !== null && options.endedAt !== undefined) {
    return "ended";
  }
  if (options.hasActiveAssignment) {
    return "on_tap";
  }
  if (
    options.onDeckOrder !== null &&
    options.onDeckOrder !== undefined &&
    Number.isInteger(options.onDeckOrder) &&
    options.onDeckOrder >= 1
  ) {
    return "on_deck";
  }
  return "available";
}
