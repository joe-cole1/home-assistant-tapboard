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
  readCurrentRecipeSnapshot,
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
  sanitizeRecipeSnapshot,
} from "./sanitizer.ts";
import type {
  BeverageDensityExtensionPort,
  BrewfatherAccount,
  BrewfatherBeverageLink,
  DensityResolution,
} from "../types.ts";

import { describeBrewfatherFailure, type BrewfatherFailure } from "./diagnostics.ts";

export interface SyncResult {
  readonly failures?: readonly BrewfatherFailure[];
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
  expectedAccount?: BrewfatherAccount,
): boolean {
  const beverage = readBeverage(database, expected.beverageId);
  const current = readBeverageLink(database, expected.beverageId);
  const account = expectedAccount ? readBrewfatherAccount(database, expected.accountId) : undefined;
  return (
    (!expectedAccount ||
      (account?.enabled === true &&
        account.userId === expectedAccount.userId &&
        account.updatedAt === expectedAccount.updatedAt)) &&
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
  #disposed = false;
  readonly #activeAdapters = new Map<BrewfatherAdapter, number>();
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

  /** Cancel cached and in-flight adapters before their owning database is closed. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const { adapter } of this.#adapters.values()) adapter.dispose();
    for (const adapter of this.#activeAdapters.keys()) adapter.dispose();
    this.#adapters.clear();
    this.#activeAdapters.clear();
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new BrewfatherError("disposed", "Brewfather integration is shut down.");
    }
  }

  #retainAdapter(adapter: BrewfatherAdapter): void {
    this.#activeAdapters.set(adapter, (this.#activeAdapters.get(adapter) ?? 0) + 1);
  }

  #releaseAdapter(accountId: string, adapter: BrewfatherAdapter): void {
    const remaining = (this.#activeAdapters.get(adapter) ?? 1) - 1;
    if (remaining > 0) this.#activeAdapters.set(adapter, remaining);
    else {
      this.#activeAdapters.delete(adapter);
      if (this.#adapters.get(accountId)?.adapter !== adapter) adapter.dispose();
    }
  }

  #getOrCreateAdapter(
    account: BrewfatherAccount,
    apiKey: string,
    options: SyncOptions,
  ): BrewfatherAdapter {
    this.#assertActive();
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
    if (cached && !this.#activeAdapters.has(cached.adapter)) cached.adapter.dispose();
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
    this.#assertActive();
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
    this.#assertActive();
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
      this.#assertActive();
      const accountResult = await this.#syncAccount(
        database,
        secretsService,
        account,
        nowIso,
        options,
      );
      this.#assertActive();
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
    this.#assertActive();
    const start = Date.now();

    // 1. Get decrypted API key
    let apiKey: string;
    try {
      apiKey = secretsService.revealPrivileged("brewfather", account.id, "api_key");
    } catch (error: unknown) {
      const failure = describeBrewfatherFailure(error);
      return {
        failures: [failure],
        accountId: account.id,
        linkedSynced: 0,
        linkedErrors: 0,
        candidatesFound: 0,
        durationMs: Date.now() - start,
        connectionVerified: false,
        error: failure.message,
      };
    }

    const adapter = this.#getOrCreateAdapter(account, apiKey, options);
    this.#retainAdapter(adapter);
    try {
      return await this.#syncAccountWithAdapter(
        database,
        account,
        nowIso,
        options,
        adapter,
        start,
        apiKey,
        secretsService,
      );
    } finally {
      this.#releaseAdapter(account.id, adapter);
    }
  }

  async #syncAccountWithAdapter(
    database: DatabaseExecutor,
    account: BrewfatherAccount,
    nowIso: string,
    options: SyncOptions,
    adapter: BrewfatherAdapter,
    start: number,
    apiKey: string,
    secretsService: SecretsService,
  ): Promise<SyncResult> {
    const safeFailures: BrewfatherFailure[] = [];
    const captureFailure = (error: unknown): BrewfatherFailure => {
      const failure = describeBrewfatherFailure(error);
      if (
        safeFailures.length < 12 &&
        !safeFailures.some(
          (entry) => entry.code === failure.code && entry.providerStatus === failure.providerStatus,
        )
      )
        safeFailures.push(failure);
      return failure;
    };
    let linkedSynced = 0;
    let linkedErrors = 0;
    let authenticationFailed = false;
    let connectionVerified = false;

    const currentAccount = (): boolean => {
      const current = readBrewfatherAccount(database, account.id);
      if (
        !current?.enabled ||
        current.userId !== account.userId ||
        current.updatedAt !== account.updatedAt
      )
        return false;
      try {
        return secretsService.revealPrivileged("brewfather", account.id, "api_key") === apiKey;
      } catch {
        return false;
      }
    };
    const currentLink = (link: BrewfatherBeverageLink): boolean =>
      isCurrentBeverageLink(database, link, account) && currentAccount();

    // 2. LINKED BATCHES PRIORITY: Synchronize all active linked beverages
    const needsEnrichment = (link: BrewfatherBeverageLink): boolean => {
      const snapshot = readCurrentRecipeSnapshot(database, link.beverageId);
      if (!snapshot) return true;
      try {
        return (
          (JSON.parse(snapshot.recipeJson) as { snapshotSchemaVersion?: unknown })
            .snapshotSchemaVersion !== 2
        );
      } catch {
        return true;
      }
    };
    const allLinks = listBeverageLinks(database)
      .filter((l) => l.accountId === account.id)
      .sort((a, b) => Number(needsEnrichment(b)) - Number(needsEnrichment(a)));

    for (const link of allLinks) {
      this.#assertActive();
      try {
        const batchData = await adapter.getBatch(link.sourceBatchId);
        this.#assertActive();
        if (batchData === null) {
          // Source batch not found / 404
          const applied = database.withTransaction(() => {
            if (!currentLink(link)) return false;
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
        const sanitizedRecipe =
          recipeData !== null ? sanitizeRecipeSnapshot(recipeData, batchData) : null;

        if (recipeData !== null && sanitizedRecipe === null) {
          throw new BrewfatherError(
            "invalid_response",
            "Brewfather recipe snapshot could not be safely normalized within its size limit.",
          );
        }

        // Synchronously persist coherent local state for this ONE linked beverage in a transaction
        const applied = database.withTransaction(() => {
          if (!currentLink(link)) return false;
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
              this.#assertActive();
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
        this.#assertActive();
        // Authentication is account evidence even when the requested link became obsolete.
        authenticationFailed ||= isAuthenticationFailure(error);
        const errorMessage = captureFailure(error).message;
        const applied = database.withTransaction(() => {
          if (!currentLink(link)) return false;
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
      this.#assertActive();
      if (!currentAccount())
        return {
          accountId: account.id,
          linkedSynced,
          linkedErrors,
          candidatesFound: 0,
          durationMs: Date.now() - start,
          connectionVerified,
        };
      connectionVerified ||= account.discoveryStatuses.length > 0 && failures.length === 0;
      if (failures.length > 0) {
        authenticationFailed ||= failures.some((failure) => isAuthenticationFailure(failure.error));
        candidateError = failures
          .map((failure) => captureFailure(failure.error).message)
          .filter((message, index, messages) => messages.indexOf(message) === index)
          .join("; ");
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
      this.#assertActive();
      authenticationFailed ||= isAuthenticationFailure(error);
      candidateError = captureFailure(error).message;
    }

    const safeCandidateError = candidateError?.slice(0, 255);

    this.#assertActive();
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
      failures: safeFailures,
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
    if (this.#disposed) {
      return { outcome: "failed", message: "Brewfather integration is shut down." };
    }
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
    } catch (error: unknown) {
      return {
        outcome: "failed",
        message: describeBrewfatherFailure(error, "complete").message,
      };
    }

    const adapter = this.#getOrCreateAdapter(account, apiKey, options);
    this.#retainAdapter(adapter);

    try {
      // Step 1: Pre-check batch status
      const batch = await adapter.getBatch(link.sourceBatchId);
      this.#assertActive();
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
      this.#assertActive();
      return {
        outcome: "completed",
        message: "Batch status updated to Completed",
      };
    } catch (error: unknown) {
      return { outcome: "failed", message: describeBrewfatherFailure(error, "complete").message };
    } finally {
      this.#releaseAdapter(account.id, adapter);
    }
  }
}
