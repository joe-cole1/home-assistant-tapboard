import { sendJson } from "../../../infrastructure/http/error-mapper.ts";
import { tapWarPercentages } from "../../tap-wars/service.ts";
import type { EligibilityReason, TapWar } from "../../tap-wars/types.ts";
import { registerAdminGet, registerAdminAction } from "./http.ts";
import { renderAdmin } from "./layout.ts";
import { adminContext, actor } from "./context.ts";
import type {
  RegisterTapWarsPagesDependencies,
  RegisterAdminTapWarsApiDependencies,
  RegisterTapWarsMutationsDependencies,
  AdminTapWarsPageDataDependencies,
} from "../contracts.ts";

export function registerTapWarsPages(dependencies: RegisterTapWarsPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/tap-wars", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/tap-wars",
      "Tap Wars",
      "/admin/tap-wars",
      {
        tapWars: adminTapWarsPageData(dependencies),
      },
    );
  });
}

export function registerAdminTapWarsApi(dependencies: RegisterAdminTapWarsApiDependencies): void {
  dependencies.router.get("/api/admin/tap-wars", (request, response) => {
    if (adminContext(request, dependencies.authService) === undefined) {
      sendJson(response, 401, {
        error: { code: "auth.unauthorized", message: "Authentication is required." },
      });
      return;
    }
    sendJson(response, 200, { ...adminTapWarsPageData(dependencies) });
  });
}

export function registerTapWarsMutations(dependencies: RegisterTapWarsMutationsDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/start",
    "/admin/tap-wars",
    (form, context) => {
      dependencies.tapWarsService.start(
        {
          competitor1AssignmentId: form.competitor1AssignmentId,
          competitor2AssignmentId: form.competitor2AssignmentId,
        },
        actor(context),
      );
    },
    "Tap War started.",
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/resume",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.resume(params.id!, actor(context));
    },
    "Tap War resumed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/stop",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.stop(params.id!, actor(context));
    },
    "Tap War completed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/dismiss",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.dismissPublicResult(params.id!, actor(context));
    },
    "Tap War result dismissed.",
  );
}

export function tapWarUnavailabilityLabel(reason: EligibilityReason | null): string | null {
  switch (reason) {
    case "disabled":
      return "This Tap is disabled.";
    case "retired":
      return "This Tap has been retired.";
    case "original_assignment_ended_or_replaced":
      return "The original Tap assignment ended or changed.";
    case "fill_ended_or_missing":
      return "The original filled keg ended or is unavailable.";
    case null:
      return null;
  }
}

export function adminTapWarView(war: TapWar | undefined): Readonly<Record<string, unknown>> | null {
  if (war === undefined) return null;
  const [first, second] = war.competitors;
  const firstVotes = war.status === "completed" ? (first.finalVoteCount ?? 0) : first.voteCount;
  const secondVotes = war.status === "completed" ? (second.finalVoteCount ?? 0) : second.voteCount;
  const percentages = tapWarPercentages(firstVotes, secondVotes);
  const totalVotes = firstVotes + secondVotes;
  const leaderSide =
    firstVotes === secondVotes ? null : firstVotes > secondVotes ? (1 as const) : (2 as const);
  return {
    id: war.id,
    status: war.status,
    result: war.result,
    startedAt: war.startedAt,
    pausedAt: war.pausedAt,
    completedAt: war.completedAt,
    publishedAt: war.publishedAt,
    dismissedAt: war.dismissedAt,
    totalVotes,
    leaderSide: war.status === "completed" ? null : leaderSide,
    isTie:
      war.status === "completed" ? war.result === "tie" : totalVotes > 0 && leaderSide === null,
    completionPublicTitleSide1: war.completionPublicTitleSide1,
    completionPublicTitleSide2: war.completionPublicTitleSide2,
    competitors: war.competitors.map((competitor) => ({
      side: competitor.side,
      assignmentId: competitor.assignmentId,
      tapId: competitor.tapId,
      tapNumber: competitor.tapNumber,
      adminBeverageTitle: competitor.adminBeverageTitle,
      voteCount:
        war.status === "completed" ? (competitor.finalVoteCount ?? 0) : competitor.voteCount,
      percentage:
        competitor.side === 1 ? (percentages?.side1 ?? null) : (percentages?.side2 ?? null),
      eligible: competitor.eligibility.eligible,
      unavailableReason: tapWarUnavailabilityLabel(competitor.eligibility.reason),
    })),
  };
}

export function adminTapWarsPageData(
  dependencies: AdminTapWarsPageDataDependencies,
): Readonly<Record<string, unknown>> {
  const rawCurrent = dependencies.tapWarsService.getCurrentUnfinished();
  return {
    current: adminTapWarView(rawCurrent),
    published: adminTapWarView(dependencies.tapWarsService.getPublishedResult()),
    publicVisible: dependencies.publicTapWarsService.getVisible(),
    history: dependencies.tapWarsService
      .listCompletedHistory()
      .map((completed) => adminTapWarView(completed)!),
    eligible: dependencies.tapWarsService.listEligibleParticipants().map((participant) => ({
      assignmentId: participant.assignmentId,
      tapId: participant.tapId,
      tapNumber: participant.tapNumber,
      preview: dependencies.publicTapWarsService.previewEligible(participant.assignmentId),
    })),
    canResume:
      rawCurrent?.status === "paused" &&
      rawCurrent.competitors.every((side) => side.eligibility.eligible),
  };
}
