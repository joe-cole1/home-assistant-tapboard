export type TelemetryPrimary =
  | { readonly kind: "total_weight"; readonly value: number }
  | { readonly kind: "remaining_volume"; readonly value: number }
  | { readonly kind: "fill_percentage"; readonly value: number };
export interface EpochInterpretationSnapshot {
  readonly capacityMl: number;
  readonly tareG: number;
  readonly densityGPerMl: number;
}
export type InterpretationDiagnosticCode =
  "ok" | "below_tare" | "negative_volume" | "above_capacity";
export interface InterpretedTelemetry {
  readonly primary: TelemetryPrimary;
  readonly interpretedVolumeMl: number;
  readonly publicVolumeMl: number;
  readonly diagnosticCode: InterpretationDiagnosticCode;
}
export function interpretTelemetry(
  snapshot: EpochInterpretationSnapshot,
  primary: TelemetryPrimary,
): InterpretedTelemetry {
  const interpretedVolumeMl =
    primary.kind === "total_weight"
      ? (primary.value - snapshot.tareG) / snapshot.densityGPerMl
      : primary.kind === "remaining_volume"
        ? primary.value
        : (snapshot.capacityMl * primary.value) / 100;
  const diagnosticCode: InterpretationDiagnosticCode =
    primary.kind === "total_weight" && primary.value < snapshot.tareG
      ? "below_tare"
      : interpretedVolumeMl < 0
        ? "negative_volume"
        : interpretedVolumeMl > snapshot.capacityMl
          ? "above_capacity"
          : "ok";
  return {
    primary: { ...primary },
    interpretedVolumeMl,
    publicVolumeMl: Math.min(snapshot.capacityMl, Math.max(0, interpretedVolumeMl)),
    diagnosticCode,
  };
}
