import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import {
  deleteActivityBefore,
  insertActivity,
  listActivity,
  readActivityRetention,
  updateActivityRetention,
} from "./repository.ts";
import type {
  ActivityClockOptions,
  ActivityInput,
  ActivityListOptions,
  ActivityRecord,
  ActivityRetention,
} from "./types.ts";
import { normalizeActivityInput } from "./activity-validation.ts";

const DEFAULT_PRUNE_BATCH = 1_000;
const MAX_PRUNE_BATCH = 1_000;

function retentionTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Invalid activity clock");
  }
  return value.toISOString();
}

/** Append an activity record without taking transaction ownership. */
export function appendActivity(
  database: DatabaseExecutor,
  input: ActivityInput,
  options: ActivityClockOptions = {},
): ActivityRecord {
  const record = normalizeActivityInput(input, options);
  insertActivity(database, record);
  const { detailsJson: _detailsJson, ...publicRecord } = record;
  return publicRecord;
}

export function readActivities(
  database: DatabaseExecutor,
  options: ActivityListOptions = {},
): ActivityRecord[] {
  return listActivity(database, options);
}

export const listActivities = readActivities;
export const recordActivity = appendActivity;

export function setActivityRetention(
  database: DatabaseExecutor,
  retentionDays: number,
  options: ActivityClockOptions = {},
): ActivityRetention {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new RangeError("Activity retention must be between 1 and 3650 days");
  }
  const now = options.now ?? (() => new Date());
  return updateActivityRetention(database, retentionDays, retentionTimestamp(now));
}

export const getActivityRetention = readActivityRetention;

export interface ActivityPruneOptions extends ActivityClockOptions {
  readonly batchSize?: number;
}

/** Delete only old Activity rows; domain history and deletion audit are never touched. */
export function pruneActivity(
  database: DatabaseExecutor,
  options: ActivityPruneOptions = {},
): number {
  const batchSize = options.batchSize ?? DEFAULT_PRUNE_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_PRUNE_BATCH) {
    throw new RangeError("Activity prune batch size must be between 1 and 1000");
  }
  const retention = readActivityRetention(database);
  const now = options.now ?? (() => new Date());
  const current = now();
  if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
    throw new TypeError("Invalid activity clock");
  }
  const cutoff = new Date(current.getTime() - retention.retentionDays * 86_400_000).toISOString();
  return deleteActivityBefore(database, cutoff, batchSize);
}

export interface ActivityService {
  readonly append: (input: ActivityInput, options?: ActivityClockOptions) => ActivityRecord;
  readonly list: (options?: ActivityListOptions) => ActivityRecord[];
  readonly getRetention: () => ActivityRetention;
  readonly setRetention: (days: number, options?: ActivityClockOptions) => ActivityRetention;
  readonly prune: (options?: ActivityPruneOptions) => number;
}

export function createActivityService(database: DatabaseExecutor): ActivityService {
  return {
    append: (input, options) => appendActivity(database, input, options),
    list: (options) => readActivities(database, options),
    getRetention: () => readActivityRetention(database),
    setRetention: (days, options) => setActivityRetention(database, days, options),
    prune: (options) => pruneActivity(database, options),
  };
}
