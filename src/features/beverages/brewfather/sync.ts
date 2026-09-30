import {
  assertSynchronousCompletion,
  type DatabaseExecutor,
} from "../../../infrastructure/database/connection.ts";
import type { SecretsService } from "../../secrets/service.ts";
import { appendActivity } from "../../activity/operations.ts";
import {
  deleteCandidate,
  listBeverageLinks,
  listBrewfatherAccounts,
  listCandidates,
  readBeverage,
  readBeverageLink,
  readBrewfatherAccount,
  readBeverageSettings,
  readPresentationOverrides,
  readSourceProfile,
  saveRecipeSnapshot,
  updateBeverageLinkState,
  upsertCandidate,
  upsertSourceProfile,
} from "../repository.ts";
import { resolveBeverageDensity } from "../density.ts";
import { resolveLinkedPresentation } from "../presentation.ts";
import { BrewfatherAdapter, BrewfatherError } from "./adapter.ts";
import {
  STATUS_SET,
  sanitizeBatchSummary,
  sanitizeBatchToSourceProfile,
  sanitizeErrorMessage,
  sanitizeRecipeSnapshot,
} from "./sanitizer.ts";
import type {
  BeverageDensityExtensionPort,
  BrewfatherAccount,
  BrewfatherBeverageLink,
  DensityResolution,
} from "../types.ts";

export interface SyncResult {
  readonly accountId: string;
  readonly linkedSynced: number;
  readonly linkedErrors: number;
  readonly candidatesFound: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly authenticationFailed?: boolean;
  /** True only when this run received a successful response from Brewfather. */
  readonly connectionVerified?: boolean;
}

function isAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof BrewfatherError &&
    (error.category === "auth" || error.category === "forbidden")
  );
}

/** Recheck within the persistence transaction after external I/O has completed. */
function isCurrentBeverageLink(
  database: DatabaseExecutor,
  expected: BrewfatherBeverageLink,
): boolean {
  const beverage = readBeverage(database, expected.beverageId);
  const current = readBeverageLink(database, expected.beverageId);
  return (
    beverage?.ownershipType === "brewfather" &&
    current?.accountId === expected.accountId &&
    current.sourceBatchId === expected.sourceBatchId &&
    current.createdAt === expected.createdAt
  );
}

export interface SyncOptions {
  readonly accountId?: string;
  readonly now?: () => Date;
  readonly fetchFn?: typeof fetch;
  readonly origin?: string;
  /** Internal Beverage-owned synchronous extension seam; not exposed by HTTP. */
  readonly densityExtensionPort?: BeverageDensityExtensionPort;
}

export class BrewfatherSyncCoordinator {
  #inFlightSync: Promise<readonly SyncResult[]> | null = null;
  readonly #fetchFn?: typeof fetch | undefined;
  readonly #origin?: string | undefined;
  readonly #adapters = new Map<
    string,
    {
      adapter: BrewfatherAdapter;
      userId: string;
      apiKey: string;
      origin?: string;
      fetchFn?: typeof fetch;
    }
  >();

  constructor(options: { readonly fetchFn?: typeof fetch; readonly origin?: string } = {}) {
    this.#fetchFn = options.fetchFn;
    this.#origin = options.origin;
  }

  #getOrCreateAdapter(
    account: BrewfatherAccount,
    apiKey: string,
    options: SyncOptions,
  ): BrewfatherAdapter {
    const origin = options.origin ?? this.#origin;
    const fetchFn = options.fetchFn ?? this.#fetchFn;
    const cached = this.#adapters.get(account.id);
    if (
      cached &&
      cached.userId === account.userId &&
      cached.apiKey === apiKey &&
      cached.origin === origin &&
      cached.fetchFn === fetchFn
    ) {
      return cached.adapter;
    }
    const adapter = new BrewfatherAdapter({
      userId: account.userId,
      apiKey,
      ...(origin !== undefined ? { origin } : {}),
      ...(fetchFn !== undefined ? { fetchFn } : {}),
    });
    this.#adapters.set(account.id, {
      adapter,
      userId: account.userId,
      apiKey,
      ...(origin !== undefined ? { origin } : {}),
      ...(fetchFn !== undefined ? { fetchFn } : {}),
    });
    return adapter;
  }

  /**
   * Triggers a Brewfather synchronization.
   * If a sync is already running in this process, coalesces and returns the existing in-flight promise.
   */
  async sync(
    database: DatabaseExecutor,
    secretsService: SecretsService,
    options: SyncOptions = {},
  ): Promise<readonly SyncResult[]> {
    if (this.#inFlightSync !== null) {
      return this.#inFlightSync;
    }

    this.#inFlightSync = this.#executeSync(database, secretsService, options).finally(() => {
      this.#inFlightSync = null;
    });

    return this.#inFlightSync;
  }

  async #executeSync(
    database: DatabaseExecutor,
    secretsService: SecretsService,
    options: SyncOptions,
  ): Promise<readonly SyncResult[]> {
    const nowIso = (options.now ?? (() => new Date()))().toISOString();

    const accounts = options.accountId
      ? ([readBrewfatherAccount(database, options.accountId)].filter(
          Boolean,
        ) as BrewfatherAccount[])
      : listBrewfatherAccounts(database).filter((a) => a.enabled);

    if (accounts.length === 0) {
      return [];
    }

    const results: SyncResult[] = [];

    for (const account of accounts) {
      const accountResult = await this.#syncAccount(
        database,
        secretsService,
        account,
        nowIso,
        options,
      );
      results.push(accountResult);
    }

    return results;
  }

  async #syncAccount(
    database: DatabaseExecutor,
    secretsService: SecretsService,
    account: BrewfatherAccount,
    nowIso: string,
    options: SyncOptions,
  ): Promise<SyncResult> {
    const start = Date.now();

    // 1. Get decrypted API key
    let apiKey: string;
    try {
      apiKey = secretsService.revealPrivileged("brewfather", account.id, "api_key");
    } catch {
      return {
        accountId: account.id,
        linkedSynced: 0,
        linkedErrors: 0,
        candidatesFound: 0,
        durationMs: Date.now() - start,
        connectionVerified: false,
        error: "Brewfather API key is not configured or secret decryption is unavailable.",
      };
    }

    const adapter = this.#getOrCreateAdapter(account, apiKey, options);

    let linkedSynced = 0;
    let linkedErrors = 0;
    let authenticationFailed = false;
    let connectionVerified = false;

    // 2. LINKED BATCHES PRIORITY: Synchronize all active linked beverages
    const allLinks = listBeverageLinks(database).filter((l) => l.accountId === account.id);

    for (const link of allLinks) {
      try {
        const batchData = await adapter.getBatch(link.sourceBatchId);
        if (batchData === null) {
          // Source batch not found / 404
          const applied = database.withTransaction(() => {
            if (!isCurrentBeverageLink(database, link)) return false;
            updateBeverageLinkState(
              database,
              link.beverageId,
              "stale",
              "Batch not found on Brewfather (404).",
              nowIso,
            );
            return true;
          });
          if (applied) linkedErrors += 1;
          continue;
        }
        connectionVerified = true;

        // Sanitize source profile outside transaction
        const sanitizedProfile = sanitizeBatchToSourceProfile(batchData);

        // Sanitize recipe snapshot outside transaction
        const recipeData = (batchData.recipe as Record<string, unknown> | undefined) ?? null;
        const sanitizedRecipe = recipeData !== null ? sanitizeRecipeSnapshot(recipeData) : null;

        // Synchronously persist coherent local state for this ONE linked beverage in a transaction
        const applied = database.withTransaction(() => {
          if (!isCurrentBeverageLink(database, link)) return false;
          const settings = readBeverageSettings(database);
          const previousSourceProfile = readSourceProfile(database, link.beverageId);
          const previousDensity = previousSourceProfile
            ? resolveBeverageDensity(
                resolveLinkedPresentation(
                  previousSourceProfile,
                  readPresentationOverrides(database, link.beverageId),
                ),
                settings.fallbackFg,
              )
            : undefined;
          if (sanitizedProfile !== null) {
            const nextSourceProfile = {
              beverageId: link.beverageId,
              name: sanitizedProfile.name,
              beverageType: sanitizedProfile.beverageType,
              style: sanitizedProfile.style,
              abv: sanitizedProfile.abv,
              ibu: sanitizedProfile.ibu,
              og: sanitizedProfile.og,
              fg: sanitizedProfile.fg,
              srm: sanitizedProfile.srm,
              displayColor: sanitizedProfile.displayColor,
              description: sanitizedProfile.description,
              rawSourceJson: sanitizedProfile.rawSourceJson,
              sourceFingerprint: sanitizedProfile.sourceFingerprint,
              updatedAt: nowIso,
            } as const;
            upsertSourceProfile(database, nextSourceProfile);
            if (previousDensity !== undefined) {
              const nextDensity = resolveBeverageDensity(
                resolveLinkedPresentation(
                  nextSourceProfile,
                  readPresentationOverrides(database, link.beverageId),
                ),
                settings.fallbackFg,
              );
              this.#notifyDensityChanged(
                database,
                options.densityExtensionPort,
                link.beverageId,
                previousDensity,
                nextDensity,
                nowIso,
              );
            }
          }

          if (sanitizedRecipe !== null) {
            saveRecipeSnapshot(database, {
              beverageId: link.beverageId,
              accountId: account.id,
              sourceBatchId: link.sourceBatchId,
              sourceRecipeId: sanitizedRecipe.sourceRecipeId,
              state: "linked_current",
              recipeJson: sanitizedRecipe.recipeJson,
              recipeFingerprint: sanitizedRecipe.recipeFingerprint,
              createdAt: nowIso,
            });
          }

          updateBeverageLinkState(database, link.beverageId, "synced", null, nowIso);
          return true;
        });

        if (applied) linkedSynced += 1;
      } catch (error: unknown) {
        // Authentication is account evidence even when the requested link became obsolete.
        authenticationFailed ||= isAuthenticationFailure(error);
        const rawMessage = error instanceof Error ? error.message : "Sync error";
        const errorMessage = sanitizeErrorMessage(rawMessage, 255);
        const applied = database.withTransaction(() => {
          if (!isCurrentBeverageLink(database, link)) return false;
          updateBeverageLinkState(database, link.beverageId, "error", errorMessage, nowIso);
          return true;
        });
        if (applied) linkedErrors += 1;
      }
    }

    // 3. CANDIDATE DISCOVERY: Fetch batches matching discovery status filter
    let candidatesFound = 0;
    let candidateError: string | undefined;
    try {
      const { batches, failures, complete } = await adapter.listBatchesByStatuses(
        account.discoveryStatuses,
      );
      connectionVerified ||= account.discoveryStatuses.length > 0 && failures.length === 0;
      if (failures.length > 0) {
        authenticationFailed ||= failures.some((failure) => isAuthenticationFailure(failure.error));
        candidateError = failures.map((f) => `${f.status}: ${f.error.message}`).join("; ");
      }
      for (const rawBatch of batches) {
        const summary = sanitizeBatchSummary(rawBatch);
        if (summary !== null) {
          upsertCandidate(database, {
            accountId: account.id,
            sourceBatchId: summary.batchId,
            batchName: summary.batchName,
            batchNumber: summary.batchNumber,
            status: summary.status,
            brewer: summary.brewer,
            recipeName: summary.recipeName,
            style: summary.style,
            brewDate: summary.brewDate,
            estimatedOg: summary.estimatedOg,
            estimatedFg: summary.estimatedFg,
            estimatedAbv: summary.estimatedAbv,
            estimatedIbu: summary.estimatedIbu,
            estimatedSrm: summary.estimatedSrm,
            rawSummaryJson: summary.rawSummaryJson,
            summaryFingerprint: summary.summaryFingerprint,
            syncedAt: nowIso,
          });
          candidatesFound += 1;
        }
      }

      // Candidate pruning may occur ONLY after known-complete discovery (no failures and complete === true)
      if (complete && failures.length === 0) {
        const discoveredBatchIds = new Set(
          batches
            .map((b) => (b as { _id?: string; id?: string })?._id ?? (b as { id?: string })?.id)
            .filter(Boolean),
        );
        database.withTransaction(() => {
          const existingCandidates = listCandidates(database, account.id);
          const linkedBatchIds = new Set(
            listBeverageLinks(database)
              .filter((link) => link.accountId === account.id)
              .map((link) => link.sourceBatchId),
          );
          for (const candidate of existingCandidates) {
            if (
              !discoveredBatchIds.has(candidate.sourceBatchId) &&
              !linkedBatchIds.has(candidate.sourceBatchId)
            ) {
              deleteCandidate(database, account.id, candidate.sourceBatchId);
            }
          }
        });
      }
    } catch (error: unknown) {
      authenticationFailed ||= isAuthenticationFailure(error);
      candidateError = error instanceof Error ? error.message : "Candidate discovery error";
    }

    const safeCandidateError = candidateError
      ? sanitizeErrorMessage(candidateError, 255)
      : undefined;

    appendActivity(database, {
      category: "admin",
      action: "configuration_changed",
      actorType: "system",
      entityType: "brewfather_account",
      entityId: account.id,
      details: {
        change: "synced",
        linked_synced: linkedSynced,
        linked_errors: linkedErrors,
        candidates_found: candidatesFound,
        ...(safeCandidateError ? { error: safeCandidateError } : {}),
      },
      occurredAt: nowIso,
    });

    return {
      accountId: account.id,
      linkedSynced,
      linkedErrors,
      candidatesFound,
      durationMs: Date.now() - start,
      connectionVerified,
      ...(safeCandidateError !== undefined ? { error: safeCandidateError } : {}),
      ...(authenticationFailed ? { authenticationFailed: true } : {}),
    };
  }

  #notifyDensityChanged(
    database: DatabaseExecutor,
    port: BeverageDensityExtensionPort | undefined,
    beverageId: string,
    previousDensity: DensityResolution,
    newDensity: DensityResolution,
    changedAt: string,
  ): void {
    if (previousDensity.densityGPerMl === newDensity.densityGPerMl) return;
    assertSynchronousCompletion(
      (port ?? { onEffectiveDensityChanged: () => undefined }).onEffectiveDensityChanged(database, {
        beverageId,
        previousDensity,
        newDensity,
        changedAt,
      }),
      "Beverage density extensions",
    );
  }

  async completeBatch(
    database: DatabaseExecutor,
    secretsService: SecretsService,
    beverageId: string,
    options: SyncOptions = {},
  ): Promise<{
    readonly outcome: "not_applicable" | "already_terminal" | "completed" | "failed";
    readonly message?: string;
  }> {
    const link = listBeverageLinks(database).find((l) => l.beverageId === beverageId);
    if (!link) {
      return {
        outcome: "not_applicable",
        message: "Beverage is not linked to Brewfather",
      };
    }

    const account = readBrewfatherAccount(database, link.accountId);
    if (!account || !account.enabled) {
      return {
        outcome: "not_applicable",
        message: "Brewfather account is not configured or disabled",
      };
    }

    let apiKey: string;
    try {
      apiKey = secretsService.revealPrivileged("brewfather", account.id, "api_key");
    } catch {
      return {
        outcome: "failed",
        message: "Brewfather credentials unavailable",
      };
    }

    const adapter = this.#getOrCreateAdapter(account, apiKey, options);

    try {
      // Step 1: Pre-check batch status
      const batch = await adapter.getBatch(link.sourceBatchId);
      if (!batch) {
        return { outcome: "failed", message: "Batch not found on Brewfather" };
      }

      const status = typeof batch.status === "string" ? batch.status : "";
      if (!STATUS_SET.has(status)) {
        return {
          outcome: "failed",
          message: "Batch status was not recognized",
        };
      }

      if (status === "Completed" || status === "Archived") {
        return {
          outcome: "already_terminal",
          message: `Batch is already in terminal status: ${status}`,
        };
      }

      // Step 2: PATCH batch status -> "Completed"
      await adapter.updateBatchStatus(link.sourceBatchId, "Completed");
      return {
        outcome: "completed",
        message: "Batch status updated to Completed",
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Brewfather request failed";
      const safeMsg = sanitizeErrorMessage(msg, 255);
      return { outcome: "failed", message: safeMsg };
    }
  }
}
