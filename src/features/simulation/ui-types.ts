import type { SessionMaterial } from "../auth/service.ts";

/** The deliberately small, credential-free view exposed to Simulator clients. */
export interface SimulationSensorView {
  readonly tapId: string;
  readonly tapNumber: number;
  readonly label: string;
  readonly remainingMl: number;
  readonly temperatureC: number;
  readonly online: boolean;
  readonly noiseEnabled: boolean;
  readonly pouring: boolean;
  readonly status: string;
  readonly error: string | null;
}

export interface SimulationStatus {
  readonly enabled: boolean;
  readonly revision: number;
  readonly changing: boolean;
  readonly sensors: readonly SimulationSensorView[];
}

export interface SimulationController {
  status(): SimulationStatus;
  setEnabled(enabled: boolean, sessionToken: string): Promise<SessionMaterial>;
  reset(sessionToken: string): Promise<SessionMaterial>;
  pour(tapId: string, ounces: number): void;
  setOnline(tapId: string, online: boolean): void;
  setNoise(tapId: string, enabled: boolean): void;
}
