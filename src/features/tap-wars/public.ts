import type { PublicStoryService } from "../story/service.ts";
import type { TapService } from "../taps/service.ts";
import { tapWarPercentages, type TapWarService } from "./service.ts";
import type {
  EligibleParticipant,
  PublicTapWarEligiblePreview,
  PublicTapWarSideView,
  PublicTapWarView,
  TapWar,
} from "./types.ts";

const MYSTERY_TAP = "Mystery Tap";

/**
 * The only Tap Wars representation that may cross the public/Admin-page
 * boundary. Raw competitors remain inside the domain service.
 */
export class PublicTapWarsService {
  readonly #tapWars: TapWarService;
  readonly #tapService: TapService;
  readonly #storyService: PublicStoryService;

  constructor(dependencies: {
    readonly tapWarsService: TapWarService;
    readonly tapService: TapService;
    readonly storyService: PublicStoryService;
  }) {
    this.#tapWars = dependencies.tapWarsService;
    this.#tapService = dependencies.tapService;
    this.#storyService = dependencies.storyService;
  }

  getVisible(): PublicTapWarView | null {
    const war = this.#tapWars.getVisible();
    return war === undefined ? null : this.#project(war);
  }

  previewEligible(assignmentId: string): PublicTapWarEligiblePreview | null {
    const eligible = this.#tapWars
      .listEligibleParticipants()
      .find((participant) => participant.assignmentId === assignmentId);
    return eligible === undefined ? null : this.#eligiblePreview(eligible);
  }

  #eligiblePreview(eligible: EligibleParticipant): PublicTapWarEligiblePreview {
    return {
      tapId: eligible.tapId,
      tapNumber: eligible.tapNumber,
      title: this.#currentTitle(eligible.tapId, eligible.assignmentId),
    };
  }

  #project(war: TapWar): PublicTapWarView {
    const [first, second] = war.competitors;
    const firstVotes = war.status === "completed" ? (first.finalVoteCount ?? 0) : first.voteCount;
    const secondVotes =
      war.status === "completed" ? (second.finalVoteCount ?? 0) : second.voteCount;
    const totalVotes = firstVotes + secondVotes;
    const percentages = tapWarPercentages(firstVotes, secondVotes);
    const result = war.status === "completed" ? war.result : null;
    const winnerSide = result === "side1" ? 1 : result === "side2" ? 2 : null;
    const leaderSide =
      war.status === "completed" || firstVotes === secondVotes
        ? null
        : firstVotes > secondVotes
          ? 1
          : 2;
    const isTie =
      war.status === "completed" ? result === "tie" : totalVotes > 0 && leaderSide === null;
    return {
      id: war.id,
      status: war.status,
      startedAt: war.startedAt,
      completedAt: war.completedAt,
      side1: this.#side(first, firstVotes, percentages?.side1 ?? null),
      side2: this.#side(second, secondVotes, percentages?.side2 ?? null),
      totalVotes,
      result,
      winnerSide,
      leaderSide,
      isTie,
      canVote: war.status === "active" && first.eligibility.eligible && second.eligibility.eligible,
      votePath: `/api/public/tap-wars/${war.id}/votes`,
      statusLabel:
        totalVotes === 0
          ? "No votes yet"
          : war.status === "paused"
            ? "Voting paused"
            : war.status === "completed"
              ? result === "tie"
                ? "Final result: tie"
                : "Final result"
              : "Voting open",
    };
  }

  #side(
    competitor: TapWar["competitors"][number],
    voteCount: number,
    percentage: number | null,
  ): PublicTapWarSideView {
    return {
      side: competitor.side,
      tapId: competitor.tapId,
      tapNumber: competitor.tapNumber,
      title: this.#title(competitor),
      isCardParticipant:
        competitor.eligibility.eligible &&
        this.#isCurrentAssignment(competitor.tapId, competitor.assignmentId),
      voteCount,
      percentage,
      meterLabel:
        percentage === null
          ? "No votes yet"
          : `${percentage}% (${voteCount} ${voteCount === 1 ? "vote" : "votes"})`,
    };
  }

  #currentTitle(tapId: string, assignmentId: string): string {
    try {
      const tap = this.#tapService.getTap(tapId);
      if (!tap.enabled || tap.isRetired || tap.activeAssignment?.id !== assignmentId)
        return MYSTERY_TAP;
      const title = this.#storyService.getCard(tapId)?.title;
      return typeof title === "string" && title.trim().length > 0 ? title : MYSTERY_TAP;
    } catch {
      return MYSTERY_TAP;
    }
  }

  #title(competitor: TapWar["competitors"][number]): string {
    if (
      competitor.eligibility.eligible &&
      this.#isCurrentAssignment(competitor.tapId, competitor.assignmentId)
    )
      return this.#currentTitle(competitor.tapId, competitor.assignmentId);
    return typeof competitor.publicTitleFallback === "string" &&
      competitor.publicTitleFallback.trim().length > 0
      ? competitor.publicTitleFallback
      : MYSTERY_TAP;
  }

  #isCurrentAssignment(tapId: string, assignmentId: string): boolean {
    try {
      const tap = this.#tapService.getTap(tapId);
      return tap.enabled && !tap.isRetired && tap.activeAssignment?.id === assignmentId;
    } catch {
      return false;
    }
  }
}

export function createPublicTapWarsService(
  dependencies: ConstructorParameters<typeof PublicTapWarsService>[0],
) {
  return new PublicTapWarsService(dependencies);
}
