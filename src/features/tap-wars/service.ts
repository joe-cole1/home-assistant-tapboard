import { randomUUID } from "node:crypto";
import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import {
  completedHistory,
  completeWar,
  currentWar,
  dismissPublishedWar,
  dismissPublishedWars,
  eligibleByAssignment,
  freezeWarVoteCount,
  getWar,
  incrementWarVote,
  insertStartedWar,
  listEligible,
  pauseActiveWar,
  publishedWar,
  resumePausedWar,
} from "./repository.ts";
import { requireSides, requireUuid } from "./validators.ts";
import type {
  EligibilityReason,
  PublicTitleResolver,
  TapWar,
  TapWarActorOptions,
  TapWarLifecyclePort,
  TapWarPercentages,
} from "./types.ts";

const mysteryTap = "Mystery Tap";
const conflict = (code: string, clientMessage: string) =>
  new ApplicationError({ category: "conflict", code, clientMessage });
const notFound = () =>
  new ApplicationError({
    category: "not_found",
    code: "tap_war.not_found",
    clientMessage: "Tap War was not found.",
  });
function timestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new TypeError("Invalid clock");
  return value.toISOString();
}
function pauseReason(war: TapWar): EligibilityReason | undefined {
  return (
    war.competitors.find((competitor) => !competitor.eligibility.eligible)?.eligibility.reason ??
    undefined
  );
}
export function tapWarPercentages(side1: number, side2: number): TapWarPercentages | null {
  if (!Number.isSafeInteger(side1) || !Number.isSafeInteger(side2) || side1 < 0 || side2 < 0)
    throw new RangeError("Vote counts must be nonnegative integers");
  const total = side1 + side2;
  if (total === 0) return null;
  const first = Math.round((side1 * 100) / total);
  return { side1: first, side2: 100 - first };
}
export interface TapWarServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly publicTitleResolver?: PublicTitleResolver;
}

export class TapWarService implements TapWarLifecyclePort {
  readonly #database: DatabaseExecutor;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #publicTitleResolver: PublicTitleResolver | undefined;
  constructor(database: DatabaseExecutor, options: TapWarServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#publicTitleResolver = options.publicTitleResolver;
  }
  listEligibleParticipants() {
    return listEligible(this.#database);
  }
  getCurrentUnfinished() {
    return currentWar(this.#database);
  }
  getCurrent() {
    return this.getCurrentUnfinished();
  }
  getPublishedResult() {
    return publishedWar(this.#database);
  }
  getPublished() {
    return this.getPublishedResult();
  }
  getVisible() {
    return this.getCurrentUnfinished() ?? this.getPublishedResult();
  }
  getById(id: unknown) {
    return getWar(this.#database, requireUuid(id, "id"));
  }
  listCompletedHistory() {
    return completedHistory(this.#database);
  }
  listHistory() {
    return this.listCompletedHistory();
  }
  #activity(
    database: DatabaseExecutor,
    warId: string,
    transition: string,
    at: string,
    options: TapWarActorOptions = {},
    system = false,
  ): void {
    const actorId = system ? undefined : options.actorId;
    const sessionId = system ? undefined : options.sessionId;
    appendActivity(
      database,
      {
        category: "domain",
        action: "transition",
        actorType: system ? "system" : (options.actorType ?? "admin"),
        ...(actorId === undefined ? {} : { actorId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        entityType: "tap_war",
        entityId: warId,
        details: { transition },
      },
      { now: () => new Date(at), idFactory: options.idFactory ?? this.#idFactory },
    );
  }
  #pause(
    database: DatabaseExecutor,
    war: TapWar,
    at: string,
    reason: EligibilityReason,
    options: TapWarActorOptions = {},
    system = true,
  ): boolean {
    const changed = pauseActiveWar(database, war.id, at, reason);
    if (changed) this.#activity(database, war.id, "paused", at, options, system);
    return changed;
  }
  start(input: unknown, options: TapWarActorOptions = {}): TapWar {
    const [firstId, secondId] = requireSides(input);
    const at = timestamp(options.now ?? this.#now);
    return this.#database.withTransaction(() => {
      if (currentWar(this.#database) !== undefined)
        throw conflict("tap_war.unfinished_exists", "Finish or resume the current Tap War first.");
      const first = eligibleByAssignment(this.#database, firstId),
        second = eligibleByAssignment(this.#database, secondId);
      if (!first || !second || first.tapId === second.tapId)
        throw conflict(
          "tap_war.ineligible_competitor",
          "Both competitors must be distinct currently eligible tap assignments.",
        );
      const previouslyPublished = publishedWar(this.#database);
      dismissPublishedWars(this.#database, at);
      if (previouslyPublished !== undefined)
        this.#activity(this.#database, previouslyPublished.id, "dismissed", at, options);
      const id = this.#idFactory();
      insertStartedWar(this.#database, { id, at, first, second });
      this.#activity(this.#database, id, "started", at, options);
      return getWar(this.#database, id)!;
    });
  }
  vote(warId: unknown, side: unknown): TapWar {
    const id = requireUuid(warId, "warId");
    if (side !== 1 && side !== 2) throw conflict("tap_war.invalid_side", "Choose a valid side.");
    let becameIneligible = false;
    const war = this.#database.withTransaction(() => {
      const current = currentWar(this.#database);
      if (!current || current.id !== id)
        throw conflict("tap_war.not_current", "This is not the current Tap War.");
      if (current.status !== "active")
        throw conflict("tap_war.not_active", "Voting is not active.");
      const reason = pauseReason(current);
      if (reason !== undefined) {
        this.#pause(this.#database, current, timestamp(this.#now), reason);
        becameIneligible = true;
        return current;
      }
      if (!incrementWarVote(this.#database, id, side))
        throw conflict("tap_war.invalid_side", "Choose a valid side.");
      return getWar(this.#database, id)!;
    });
    if (becameIneligible)
      throw conflict(
        "tap_war.ineligible",
        "Voting was paused because a competitor is no longer eligible.",
      );
    return war;
  }
  resume(id: unknown, options: TapWarActorOptions = {}): TapWar {
    const warId = requireUuid(id, "id");
    const at = timestamp(options.now ?? this.#now);
    return this.#database.withTransaction(() => {
      const war = getWar(this.#database, warId);
      if (!war) throw notFound();
      if (war.status !== "paused" || pauseReason(war) !== undefined)
        throw conflict("tap_war.cannot_resume", "The original competitors are not both eligible.");
      if (!resumePausedWar(this.#database, warId, at))
        throw conflict("tap_war.cannot_resume", "The original competitors are not both eligible.");
      this.#activity(this.#database, warId, "resumed", at, options);
      return getWar(this.#database, warId)!;
    });
  }
  stop(id: unknown, options: TapWarActorOptions = {}): TapWar {
    const warId = requireUuid(id, "id");
    const at = timestamp(options.now ?? this.#now);
    return this.#database.withTransaction(() => {
      const war = getWar(this.#database, warId);
      if (!war) throw notFound();
      if (war.status === "completed")
        throw conflict("tap_war.completed", "Completed Tap Wars cannot change.");
      const [first, second] = war.competitors;
      const result =
        first.voteCount === second.voteCount
          ? "tie"
          : first.voteCount > second.voteCount
            ? "side1"
            : "side2";
      const publicFirst = this.#title(first.tapId, first.assignmentId),
        publicSecond = this.#title(second.tapId, second.assignmentId);
      if (
        !freezeWarVoteCount(this.#database, warId, 1, first.voteCount) ||
        !freezeWarVoteCount(this.#database, warId, 2, second.voteCount)
      )
        throw new Error("Tap War final vote invariant violated");
      if (
        !completeWar(this.#database, {
          warId,
          at,
          result,
          publicTitleSide1: publicFirst,
          publicTitleSide2: publicSecond,
          adminTitleSide1: first.adminBeverageTitle,
          adminTitleSide2: second.adminBeverageTitle,
        })
      )
        throw new Error("Tap War completion invariant violated");
      this.#activity(this.#database, warId, "stopped", at, options);
      return getWar(this.#database, warId)!;
    });
  }
  dismissPublicResult(id: unknown, options: TapWarActorOptions = {}): TapWar {
    const warId = requireUuid(id, "id");
    const at = timestamp(options.now ?? this.#now);
    return this.#database.withTransaction(() => {
      const war = getWar(this.#database, warId);
      if (!war) throw notFound();
      if (war.status !== "completed" || war.publishedAt === null || war.dismissedAt !== null)
        throw conflict(
          "tap_war.not_published",
          "Only a published Tap War result can be dismissed.",
        );
      if (!dismissPublishedWar(this.#database, warId, at))
        throw conflict(
          "tap_war.not_published",
          "Only a published Tap War result can be dismissed.",
        );
      this.#activity(this.#database, warId, "dismissed", at, options);
      return getWar(this.#database, warId)!;
    });
  }
  reconcileEligibility(options: TapWarActorOptions = {}): TapWar | undefined {
    const at = timestamp(options.now ?? this.#now);
    return this.#database.withTransaction(() => {
      const war = currentWar(this.#database);
      if (!war || war.status !== "active") return war;
      const reason = pauseReason(war);
      if (reason !== undefined) this.#pause(this.#database, war, at, reason, options);
      return getWar(this.#database, war.id);
    });
  }
  pauseForAssignmentClose(database: DatabaseExecutor, assignmentId: string, at: string): void {
    this.#pauseFor(database, "assignment_id", assignmentId, at);
  }
  pauseForTapUnavailable(database: DatabaseExecutor, tapId: string, at: string): void {
    this.#pauseFor(database, "tap_id", tapId, at);
  }
  #pauseFor(
    database: DatabaseExecutor,
    column: "assignment_id" | "tap_id",
    value: string,
    at: string,
  ): void {
    const war = currentWar(database);
    if (
      !war ||
      war.status !== "active" ||
      !war.competitors.some((competitor) =>
        column === "assignment_id" ? competitor.assignmentId === value : competitor.tapId === value,
      )
    )
      return;
    const reason = column === "tap_id" ? "disabled" : "original_assignment_ended_or_replaced";
    this.#pause(database, war, at, reason);
  }
  #title(tapId: string, assignmentId: string): string {
    const resolved = this.#publicTitleResolver?.(tapId, assignmentId);
    return typeof resolved === "string" && resolved.trim().length > 0 ? resolved : mysteryTap;
  }
}
