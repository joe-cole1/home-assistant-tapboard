import type { DatabaseExecutor } from "../../../infrastructure/database/connection.ts";
import type { SecretsService } from "../../secrets/service.ts";
import { appendActivity } from "../../activity/operations.ts";
import {
  deleteCandidate,
  listBeverageLinks,
  listBrewfatherAccounts,
  listCandidates,
  readBrewfatherAccount,
  saveRecipeSnapshot,
  updateBeverageLinkState,
  upsertCandidate,
  upsertSourceProfile,
} from "../repository.ts";
import { BrewfatherAdapter } from "./adapter.ts";
import {
  sanitizeBatchSummary,
  sanitizeBatchToSourceProfile,
  sanitizeErrorMessage,
  sanitizeRecipeSnapshot,
} from "./sanitizer.ts";
import type { BrewfatherAccount } from "../types.ts";

export interface SyncResult {
  readonly accountId: string;
  readonly linkedSynced: number;
  readonly linkedErrors: number;
  readonly candidatesFound: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface SyncOptions {
  readonly accountId?: string;
  readonly now?: () => Date;
  readonly fetchFn?: typeof fetch;
  readonly origin?: string;
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
        error: "Brewfather API key is not configured or secret decryption is unavailable.",
      };
    }

    const adapter = this.#getOrCreateAdapter(account, apiKey, options);

    let linkedSynced = 0;
    let linkedErrors = 0;

    // 2. LINKED BATCHES PRIORITY: Synchronize all active linked beverages
    const allLinks = listBeverageLinks(database).filter((l) => l.accountId === account.id);

    for (const link of allLinks) {
      try {
        const batchData = await adapter.getBatch(link.sourceBatchId);
        if (batchData === null) {
          // Source batch not found / 404
          updateBeverageLinkState(
            database,
            link.beverageId,
            "stale",
            "Batch not found on Brewfather (404).",
            nowIso,
          );
          linkedErrors += 1;
          continue;
        }

        // Sanitize source profile outside transaction
        const sanitizedProfile = sanitizeBatchToSourceProfile(batchData);

        // Sanitize recipe snapshot outside transaction
        const recipeData = (batchData.recipe as Record<string, unknown> | undefined) ?? null;
        const sanitizedRecipe = recipeData !== null ? sanitizeRecipeSnapshot(recipeData) : null;

        // Synchronously persist coherent local state for this ONE linked beverage in a transaction
        database.withTransaction(() => {
          if (sanitizedProfile !== null) {
            upsertSourceProfile(database, {
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
            });
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
        });

        linkedSynced += 1;
      } catch (error: unknown) {
        const rawMessage = error instanceof Error ? error.message : "Sync error";
        const errorMessage = sanitizeErrorMessage(rawMessage, 255);
        updateBeverageLinkState(database, link.beverageId, "error", errorMessage, nowIso);
        linkedErrors += 1;
      }
    }

    // 3. CANDIDATE DISCOVERY: Fetch batches matching discovery status filter
    let candidatesFound = 0;
    let candidateError: string | undefined;
    try {
      const { batches, failures, complete } = await adapter.listBatchesByStatuses(
        account.discoveryStatuses,
      );
      if (failures.length > 0) {
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
        const existingCandidates = listCandidates(database, account.id);
        const linkedBatchIds = new Set(allLinks.map((l) => l.sourceBatchId));
        for (const candidate of existingCandidates) {
          if (
            !discoveredBatchIds.has(candidate.sourceBatchId) &&
            !linkedBatchIds.has(candidate.sourceBatchId)
          ) {
            deleteCandidate(database, account.id, candidate.sourceBatchId);
          }
        }
      }
    } catch (error: unknown) {
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
      ...(safeCandidateError !== undefined ? { error: safeCandidateError } : {}),
    };
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
      return { outcome: "not_applicable", message: "Beverage is not linked to Brewfather" };
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
      return { outcome: "failed", message: "Brewfather credentials unavailable" };
    }

    const adapter = this.#getOrCreateAdapter(account, apiKey, options);

    try {
      // Step 1: Pre-check batch status
      const batch = await adapter.getBatch(link.sourceBatchId);
      if (!batch) {
        return { outcome: "failed", message: "Batch not found on Brewfather" };
      }

      const status = typeof batch.status === "string" ? batch.status : "";
      if (status === "Completed" || status === "Archived") {
        return {
          outcome: "already_terminal",
          message: `Batch is already in terminal status: ${status}`,
        };
      }

      // Step 2: PATCH batch status -> "Completed"
      await adapter.updateBatchStatus(link.sourceBatchId, "Completed");
      return { outcome: "completed", message: "Batch status updated to Completed" };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Brewfather request failed";
      const safeMsg = sanitizeErrorMessage(msg, 255);
      return { outcome: "failed", message: safeMsg };
    }
  }
}
