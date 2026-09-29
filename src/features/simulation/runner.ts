import { ApplicationError } from "../../shared/errors.ts";
import type { AdminTapView } from "../taps/types.ts";
import {
  mapExternalTelemetryPayloadToInternal,
  validateExternalTelemetryPayload,
} from "../telemetry/telemetry-validation.ts";
import {
  listSensors,
  readFillVolume,
  readSensor,
  setFillVolume,
  updateSensor,
} from "./repository.ts";
import type {
  SimulationDependencies,
  SimulationRunnerOptions,
  SimulationSensor,
  SimulationSensorStatus,
  SimulationSensorView,
} from "./types.ts";

export const SIMULATION_OUNCE_ML = 29.5735295625;
const SCHEDULER_MS = 100;
const IDLE_SAMPLE_MS = 500;
const FLOW_TAIL_MS = 600;
const JITTER = [0, 1, 0, -1, 0, -0.5, 0, 0.5] as const;

interface PourPlan {
  readonly assignmentId: string;
  readonly epochId: string;
  readonly remainingToPourMl: number;
  readonly rateMlPerSecond: number;
  readonly lastFlowAtMs: number;
  readonly flowEndedAtMs: number | null;
}

function conflict(code: string, clientMessage: string): ApplicationError {
  return new ApplicationError({ category: "conflict", code: `simulation.${code}`, clientMessage });
}

/**
 * A source emulator, not a detector: all samples cross the external payload validator,
 * current-key authentication and ordinary ingestion service before physical state advances.
 */
export class SimulationRunner {
  readonly #dependencies: SimulationDependencies;
  readonly #clock: () => Date;
  readonly #autoSchedule: boolean;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onSampleCommitted: ((tapId: string) => void) | undefined;
  readonly #tokens = new Map<string, string>();
  readonly #plans = new Map<string, PourPlan>();
  readonly #nextSampleAt = new Map<string, number>();
  readonly #errors = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #ticking = false;

  constructor(dependencies: SimulationDependencies, options: SimulationRunnerOptions = {}) {
    this.#dependencies = dependencies;
    this.#clock = options.clock ?? (() => new Date());
    this.#autoSchedule = options.autoSchedule ?? true;
    this.#onError = options.onError;
    this.#onSampleCommitted = options.onSampleCommitted;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    const { database, telemetryService } = this.#dependencies;
    this.#currentTime();
    this.#errors.clear();
    const sources = new Map(telemetryService.listSources().map((source) => [source.id, source]));
    for (const sensor of listSensors(database)) {
      try {
        const source = sources.get(sensor.sourceId);
        if (
          source === undefined ||
          source.disabledAt !== null ||
          source.currentMachineKey.revokedAt !== null
        ) {
          throw conflict(
            "source_unavailable",
            "The simulation telemetry source is disabled or its key is revoked.",
          );
        }
        if (!this.#tokens.has(source.id)) {
          const rotated = telemetryService.rotateSourceKey(source.id, {}, { actorType: "system" });
          this.#tokens.set(source.id, rotated.replacementToken);
        }
        // Watermarks survive restart. Never synthesize a future timestamp to bypass one.
        const previous = telemetryService
          .getTapLatestHardwareStatus(sensor.tapId)
          .find((status) => status.sourceId === sensor.sourceId);
        if (previous !== undefined)
          this.#nextSampleAt.set(sensor.tapId, Date.parse(previous.latestMeasuredAt) + 1);
      } catch (error) {
        this.#failSensor(sensor.tapId, error);
      }
    }
    this.#running = true;
    if (this.#autoSchedule) {
      // One timer, no per-tap timers and no unbounded historical catch-up after a stall.
      this.#timer = setInterval(() => this.tick(), SCHEDULER_MS);
      this.#timer.unref();
    }
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#running = false;
    this.#tokens.clear();
    this.#plans.clear();
    this.#nextSampleAt.clear();
    this.#errors.clear();
  }

  listSensors(): readonly SimulationSensorView[] {
    const { database, tapService, detectorService } = this.#dependencies;
    const taps = new Map(tapService.listTaps().map((tap) => [tap.id, tap]));
    return listSensors(database)
      .flatMap((sensor) => {
        const tap = taps.get(sensor.tapId);
        if (tap === undefined) return [];
        const diagnostics =
          tap.activeAssignment === null ? null : detectorService.diagnostics(tap.id);
        const pendingPlan = this.#plans.get(sensor.tapId);
        const plan =
          pendingPlan?.assignmentId === tap.activeAssignment?.id &&
          pendingPlan?.epochId === diagnostics?.epoch?.id
            ? pendingPlan
            : undefined;
        const remainingMl = this.#physicalVolume(tap, sensor);
        const error = this.#errors.get(sensor.tapId) ?? null;
        let status: SimulationSensorStatus;
        if (!this.#running) status = "stopped";
        else if (!sensor.online) status = "offline";
        else if (tap.isRetired) status = "unavailable";
        else if (error !== null) status = "error";
        else if (tap.activeAssignment === null) status = "unassigned";
        else if (plan !== undefined && plan.remainingToPourMl > 0) status = "pouring";
        else if (plan !== undefined) status = "settling";
        else if (remainingMl < SIMULATION_OUNCE_ML) status = "empty";
        else if (diagnostics?.detector?.phase === "ready") status = "ready";
        else status = "settling";
        return [
          {
            ...sensor,
            remainingMl,
            tapNumber: tap.tapNumber,
            label: tap.name ?? `Tap ${tap.tapNumber}`,
            beverageName: tap.activeAssignment?.beverageName ?? null,
            status,
            error,
            pouring: plan !== undefined && plan.remainingToPourMl > 0,
          },
        ];
      })
      .sort((left, right) => left.tapNumber - right.tapNumber);
  }

  pour(tapId: string, ounces: number): SimulationSensorView {
    if (typeof ounces !== "number" || !Number.isFinite(ounces) || ounces < 1 || ounces > 32) {
      throw new ApplicationError({
        category: "validation",
        code: "simulation.pour_size",
        clientMessage: "Choose a pour between 1 and 32 US fluid ounces.",
      });
    }
    this.#requireSensor(tapId);
    const view = this.listSensors().find((item) => item.tapId === tapId)!;
    if (view.status !== "ready")
      throw conflict(
        "sensor_not_ready",
        view.error ?? "Wait until this online sensor is ready before pouring.",
      );
    const requestedMl = ounces * SIMULATION_OUNCE_ML;
    if (requestedMl > view.remainingMl)
      throw conflict(
        "insufficient_volume",
        "This simulated keg does not have enough beer for that pour.",
      );
    const diagnostics = this.#dependencies.detectorService.diagnostics(tapId);
    if (diagnostics.epoch === null) throw conflict("unassigned", "Assign a fill before pouring.");
    const now = this.#currentTime().getTime();
    this.#plans.set(tapId, {
      assignmentId: diagnostics.epoch.assignmentId,
      epochId: diagnostics.epoch.id,
      remainingToPourMl: requestedMl,
      // Standard pours flow at 2 oz/sec. Large custom servings use a faster realistic
      // pour so flow plus the real quiet period stays inside the default hard timeout.
      rateMlPerSecond: Math.max(2, ounces / 8) * SIMULATION_OUNCE_ML,
      lastFlowAtMs: now,
      flowEndedAtMs: null,
    });
    this.#nextSampleAt.set(tapId, now + SCHEDULER_MS);
    return this.listSensors().find((item) => item.tapId === tapId)!;
  }

  setOnline(tapId: string, online: boolean): SimulationSensor {
    if (typeof online !== "boolean") throw new TypeError("Simulation online must be boolean");
    const sensor = this.#requireSensor(tapId);
    updateSensor(this.#dependencies.database, { ...sensor, online });
    this.#plans.delete(tapId);
    this.#nextSampleAt.delete(tapId);
    if (online) this.#errors.delete(tapId);
    return { ...sensor, online };
  }

  setNoise(tapId: string, noiseEnabled: boolean): SimulationSensor {
    if (typeof noiseEnabled !== "boolean") throw new TypeError("Simulation noise must be boolean");
    const sensor = this.#requireSensor(tapId);
    updateSensor(this.#dependencies.database, { ...sensor, noiseEnabled });
    return { ...sensor, noiseEnabled };
  }

  setTemperature(tapId: string, temperatureC: number): SimulationSensor {
    if (!Number.isFinite(temperatureC) || temperatureC < -20 || temperatureC > 80) {
      throw new ApplicationError({
        category: "validation",
        code: "simulation.temperature",
        clientMessage: "Choose a temperature between -20 and 80 Celsius.",
      });
    }
    const sensor = this.#requireSensor(tapId);
    updateSensor(this.#dependencies.database, { ...sensor, temperatureC });
    return { ...sensor, temperatureC };
  }

  /** Advance once at the injected current time; returns the number of accepted samples. */
  tick(): number {
    if (!this.#running || this.#ticking) return 0;
    const { database, tapService, detectorService } = this.#dependencies;
    if (!database.isOpen) {
      this.stop();
      return 0;
    }
    this.#ticking = true;
    let accepted = 0;
    try {
      const now = this.#currentTime();
      const at = now.getTime();
      const sensors = listSensors(database);
      const present = new Set(sensors.map((sensor) => sensor.tapId));
      for (const map of [this.#plans, this.#nextSampleAt, this.#errors]) {
        for (const tapId of map.keys()) if (!present.has(tapId)) map.delete(tapId);
      }
      const taps = new Map(tapService.listTaps().map((tap) => [tap.id, tap]));
      for (const sensor of sensors) {
        const tap = taps.get(sensor.tapId);
        if (tap === undefined || tap.isRetired || tap.activeAssignment === null || !sensor.online) {
          this.#plans.delete(sensor.tapId);
          this.#nextSampleAt.delete(sensor.tapId);
          continue;
        }
        const diagnostics = detectorService.diagnostics(tap.id);
        let plan = this.#plans.get(tap.id);
        if (
          plan !== undefined &&
          (plan.assignmentId !== tap.activeAssignment.id || plan.epochId !== diagnostics.epoch?.id)
        ) {
          this.#plans.delete(tap.id);
          plan = undefined;
        }
        if (this.#errors.has(tap.id) || at < (this.#nextSampleAt.get(tap.id) ?? 0)) continue;
        try {
          const nextPlan = this.#ingest(sensor, tap, plan, now);
          accepted += 1;
          const fast =
            nextPlan !== undefined &&
            (nextPlan.remainingToPourMl > 0 ||
              (nextPlan.flowEndedAtMs !== null && at - nextPlan.flowEndedAtMs < FLOW_TAIL_MS));
          this.#nextSampleAt.set(tap.id, at + (fast ? SCHEDULER_MS : IDLE_SAMPLE_MS));
          if (nextPlan !== undefined) {
            const phase = detectorService.diagnostics(tap.id).detector?.phase;
            if (!fast && nextPlan.remainingToPourMl === 0 && phase === "ready")
              this.#plans.delete(tap.id);
            else this.#plans.set(tap.id, nextPlan);
          } else this.#plans.delete(tap.id);
          try {
            this.#onSampleCommitted?.(tap.id);
          } catch (error) {
            this.#onError?.(error);
          }
        } catch (error) {
          this.#failSensor(tap.id, error);
        }
      }
      detectorService.processDue(now);
    } catch (error) {
      this.#onError?.(error);
    } finally {
      this.#ticking = false;
    }
    return accepted;
  }

  #ingest(
    sensor: SimulationSensor,
    tap: AdminTapView,
    plan: PourPlan | undefined,
    now: Date,
  ): PourPlan | undefined {
    const { database, telemetryService, tapService, detectorService } = this.#dependencies;
    return database.withTransaction(() => {
      // Resolve assignment and its physical volume under the same write lock as ingestion.
      // A moved or replaced Fill cannot inherit the destination sensor's last delivered value.
      const currentTap = tapService.getTap(tap.id);
      const currentSensor = this.#requireSensor(sensor.tapId);
      const assignment = currentTap.activeAssignment;
      const epoch = detectorService.diagnostics(currentTap.id).epoch;
      if (!currentSensor.online || currentTap.isRetired || assignment === null || epoch === null)
        throw conflict(
          "unassigned",
          "Assign a fill to an online sensor before submitting simulation samples.",
        );
      const currentPlan =
        plan?.assignmentId === assignment.id && plan?.epochId === epoch.id ? plan : undefined;
      const at = now.getTime();
      let nextPlan = currentPlan;
      let remainingMl = this.#physicalVolume(currentTap, currentSensor);
      if (currentPlan !== undefined && currentPlan.remainingToPourMl > 0) {
        const elapsedSeconds =
          Math.max(0, Math.min(IDLE_SAMPLE_MS, at - currentPlan.lastFlowAtMs)) / 1000;
        const loss = Math.min(
          currentPlan.remainingToPourMl,
          remainingMl,
          currentPlan.rateMlPerSecond * elapsedSeconds,
        );
        remainingMl = Math.max(0, remainingMl - loss);
        const remainingToPourMl = Math.max(0, currentPlan.remainingToPourMl - loss);
        const finished = remainingToPourMl < 1e-8;
        nextPlan = {
          ...currentPlan,
          remainingToPourMl: finished ? 0 : remainingToPourMl,
          lastFlowAtMs: at,
          flowEndedAtMs: finished ? at : null,
        };
      }
      const sequence = currentSensor.sequence + 1;
      const jitter = JITTER[sequence % JITTER.length]! * (currentSensor.noiseEnabled ? 2 : 0.2);
      const jitteredVolume = Math.max(0, remainingMl + jitter);
      // Noise must not make an actually full Fill look overfilled. A real physical
      // excess after a capacity edit remains unbounded for ordinary detector diagnostics.
      const measuredVolume =
        remainingMl <= epoch.snapshots.capacityMl
          ? Math.min(epoch.snapshots.capacityMl, jitteredVolume)
          : jitteredVolume;
      const payload = validateExternalTelemetryPayload({
        client_sample_id: `simulation:${currentSensor.tapId}:${sequence}`,
        measured_at: now.toISOString(),
        measurement: {
          kind: "total_weight",
          value: epoch.snapshots.tareG + measuredVolume * epoch.snapshots.densityGPerMl,
          unit: "g",
        },
        temperature: { value: currentSensor.temperatureC, unit: "c" },
      });
      const token = this.#tokens.get(currentSensor.sourceId);
      const source =
        token === undefined ? undefined : telemetryService.authenticateSourceToken(token);
      if (source === undefined || source.id !== currentSensor.sourceId)
        throw conflict(
          "source_key_unavailable",
          "The simulation sensor key was rotated or revoked. Review its telemetry source.",
        );
      const result = telemetryService.ingestSingle(
        source,
        currentTap.tapNumber,
        mapExternalTelemetryPayloadToInternal(payload),
      );
      if (result.outcome !== "accepted" || result.duplicate)
        throw conflict(
          "ingest_rejected",
          `The simulation sensor sample was rejected (${result.code}).`,
        );
      // A failed detector/health hook or physical-state write rolls back the accepted
      // measurement, receipt, sequence and volume together. Plans change only on return.
      setFillVolume(database, assignment.fillId, remainingMl);
      updateSensor(database, { ...currentSensor, remainingMl, sequence });
      return nextPlan;
    });
  }

  #physicalVolume(tap: AdminTapView, sensor: SimulationSensor): number {
    const assignment = tap.activeAssignment;
    if (assignment === null) return sensor.remainingMl;
    return (
      readFillVolume(this.#dependencies.database, assignment.fillId) ??
      this.#dependencies.kegService.getKeg(assignment.kegId).keg.capacityMl
    );
  }

  #requireSensor(tapId: string): SimulationSensor {
    const sensor = readSensor(this.#dependencies.database, tapId);
    if (sensor === undefined)
      throw new ApplicationError({
        category: "not_found",
        code: "simulation.sensor_not_found",
        clientMessage: "Simulation sensor was not found.",
      });
    return sensor;
  }

  #currentTime(): Date {
    const now = this.#clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new TypeError("Simulation clock must return a valid Date");
    return now;
  }

  #failSensor(tapId: string, error: unknown): void {
    this.#plans.delete(tapId);
    this.#errors.set(
      tapId,
      error instanceof ApplicationError
        ? error.clientMessage
        : "The simulation sensor could not submit a sample.",
    );
    this.#onError?.(error);
  }
}
