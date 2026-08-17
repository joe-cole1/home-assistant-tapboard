import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../src/shared/errors.ts";
import { PublicStoryService } from "../src/features/story/service.ts";
import type { PublicStoryServiceDependencies } from "../src/features/story/service.ts";
import type { AdminTapView, TapAssignmentMysteryConfig } from "../src/features/taps/types.ts";

const TAP_ID = "00000000-0000-4000-8000-000000000077";
const BEVERAGE_ID = "00000000-0000-4000-8000-000000000078";
const FILL_ID = "00000000-0000-4000-8000-000000000079";
const ASSIGNMENT_ID = "secret-assignment-id";
const SOURCE_ID = "secret-source-recipe-id";
const FINGERPRINT = "secret-recipe-fingerprint";

const defaultMystery: TapAssignmentMysteryConfig = {
  enabled: false,
  revealBeverageType: false,
  revealStyle: false,
  revealAbv: false,
  revealIbu: false,
  revealOg: false,
  revealFg: false,
  revealSrm: false,
  revealDescription: false,
  revealRecipe: false,
  revealSensory: false,
  revealHistory: false,
};

function mystery(overrides: Partial<TapAssignmentMysteryConfig>): TapAssignmentMysteryConfig {
  return { ...defaultMystery, ...overrides };
}

interface TapCardMetricSettings {
  readonly showAbv: boolean;
  readonly showIbu: boolean;
  readonly showOg: boolean;
  readonly showFg: boolean;
  readonly showSrm: boolean;
}

function fixture(
  options: {
    readonly tapCardMetricSettings?: TapCardMetricSettings;
    readonly displaySettingsFailure?: boolean;
  } = {},
) {
  let tap: AdminTapView = {
    id: TAP_ID,
    tapNumber: 7,
    name: "Secret Tap Name",
    enabled: true,
    isRetired: false,
    isOccupied: true,
    firstUsedAt: "2026-08-01T00:00:00.000Z",
    retiredAt: null,
    gasType: null,
    servingPressureKpa: null,
    lineLengthMm: null,
    lineDiameterMm: null,
    notes: null,
    activeAssignment: {
      id: ASSIGNMENT_ID,
      fillId: FILL_ID,
      beverageId: BEVERAGE_ID,
      beverageName: "Secret Beverage Name",
      beverageType: "beer",
      beverageStyle: "Secret Style",
      beverageAbv: 6.4,
      kegId: "secret-keg-id",
      kegNumber: 7,
      kegLabel: "Secret Keg",
      assignedAt: "2026-08-02T00:00:00.000Z",
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  let assignmentMystery = defaultMystery;
  let getRecipeSnapshotsCalls = 0;

  const customRecipe = {
    id: "secret-custom-recipe-id",
    beverageId: BEVERAGE_ID,
    notes: "Secret recipe notes",
    ingredients: [
      {
        id: "secret-custom-ingredient-id",
        recipeId: "secret-custom-recipe-id",
        sortOrder: 0,
        name: "Pale Malt",
        amount: 5,
        unit: "kg",
        note: null,
      },
    ],
    steps: [
      {
        id: "secret-custom-step-id",
        recipeId: "secret-custom-recipe-id",
        sortOrder: 0,
        name: "Mash",
        temperatureC: 67,
        timeMinutes: 60,
        note: null,
      },
    ],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  const sourceSnapshots = Array.from({ length: 6 }, (_, index) => ({
    id: `secret-snapshot-${index}`,
    beverageId: BEVERAGE_ID,
    accountId: "secret-account-id",
    sourceBatchId: "secret-source-batch-id",
    sourceRecipeId: SOURCE_ID,
    state: index === 0 ? "linked_current" : index === 1 ? "detached" : "superseded",
    version: 6 - index,
    recipeJson: JSON.stringify({
      id: SOURCE_ID,
      name: `Source recipe ${index}`,
      ingredients: [{ name: "Cascade", amount: 30, unit: "g" }],
      ibu: 42,
    }),
    recipeFingerprint: FINGERPRINT,
    createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
  }));

  const dependencies = {
    tapService: {
      listTaps: () => [tap],
      getTap: (id: unknown) => {
        if (id === TAP_ID) return tap;
        throw new ApplicationError({
          category: "validation",
          code: "tap.invalid_id",
          clientMessage: "Tap id is invalid.",
        });
      },
      getAssignmentMystery: () => assignmentMystery,
    },
    beverageService: {
      getBeverage: () => ({
        beverage: {
          id: BEVERAGE_ID,
          ownershipType: "custom",
          createdAt: "2026-08-01",
          updatedAt: "2026-08-02",
        },
        effectivePresentation: {
          name: "Secret Beverage Name",
          beverageType: "beer",
          style: "Secret Style",
          abv: 6.4,
          ibu: 42,
          og: 1.064,
          fg: 1.012,
          srm: 18,
          displayColor: null,
          description: "Secret Description",
          fillGlass: null,
          manualDensityOverride: null,
        },
        density: { source: "fg_derived", value: 1.01 },
        customRecipe,
        sensoryOverrides: {
          beverageId: BEVERAGE_ID,
          bitterness: 1.25,
          sweetness: null,
          body: null,
          roast: null,
          tartness: null,
          alcohol: null,
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      }),
      getRecipeSnapshots: () => {
        getRecipeSnapshotsCalls += 1;
        return sourceSnapshots;
      },
    },
    fillService: {
      getFill: () => ({
        id: FILL_ID,
        beverageId: BEVERAGE_ID,
        kegId: "secret-keg-id",
        beverageName: "Secret Beverage Name",
        beverageType: "beer",
        beverageStyle: "Secret Style",
        beverageAbv: 6.4,
        kegNumber: 7,
        kegLabel: "Secret Keg",
        fillDate: "2026-08-02",
        state: "on_tap",
        onDeckOrder: null,
        endedAt: null,
        endReason: null,
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    },
    detectorService: {
      diagnostics: () => ({
        tapId: TAP_ID,
        epoch: {
          id: "secret-epoch-id",
          sourceId: "secret-detector-source-id",
          fillId: FILL_ID,
          assignmentId: ASSIGNMENT_ID,
          kegId: "secret-keg-id",
          startedAt: "2026-08-02T00:00:00.000Z",
          configVersion: "secret-config-version",
          arbitrationGroupId: null,
          snapshots: {
            capacityMl: 19000,
            tareG: 4000,
            densityGPerMl: 1,
            densitySource: "fallback",
            normalizationVersion: 1,
            detectorConfig: { secret: "private config" },
          },
        },
        detector: { phase: "waiting_for_measurement", waitingForMeasurement: false },
        measurement: {
          id: "secret-measurement-id",
          measuredAt: "2026-08-03T00:00:00.000Z",
          canonical: { kind: "mass", value: 12000, temperatureC: 4.5 },
          interpretedVolumeMl: 12000,
          stabilizedVolumeMl: 12000,
          publicVolumeMl: 12000,
          diagnosticCode: null,
        },
      }),
    },
    forecastService: {
      getPublicForecastSummary: () => ({
        status: "available",
        reason: "sufficient_fill_history",
        days: {
          earliestDays: 2,
          medianDays: 4,
          latestDays: 8,
          p10Days: 2,
          p50Days: 4,
          p90Days: 8,
          earliestDepletionAt: "2026-08-04T00:00:00.000Z",
          medianDepletionAt: "2026-08-06T00:00:00.000Z",
          latestDepletionAt: "2026-08-10T00:00:00.000Z",
        },
        servingsRemaining: 33,
        servingSizeMl: 354.88,
        confidence: { level: "medium", status: "available", reason: "sufficient_fill_history" },
        method: null,
      }),
      getPourHistory: () => ({
        pours: [
          ...Array.from({ length: 55 }, (_, index) => ({
            pourId: `secret-pour-${index}`,
            fillId: FILL_ID,
            tapId: TAP_ID,
            assignmentId: ASSIGNMENT_ID,
            epochId: "secret-epoch-id",
            canonicalVolumeMl: 300 + index,
            startedAt: "2026-08-03T00:00:00.000Z",
            completedAt: "2026-08-03T00:01:00.000Z",
          })),
          {
            pourId: "foreign-pour",
            fillId: "foreign-fill-id",
            tapId: "foreign-tap-id",
            assignmentId: "foreign-assignment-id",
            epochId: "foreign-epoch-id",
            canonicalVolumeMl: 9999,
            startedAt: "2026-08-03T00:00:00.000Z",
            completedAt: "2026-08-03T00:01:00.000Z",
          },
        ],
        nextCursor: "secret-cursor",
      }),
    },
    healthService: {
      getAdminOverview: () => ({
        aggregate: { state: "healthy", severity: "none" },
      }),
    },
    ...(options.tapCardMetricSettings === undefined && options.displaySettingsFailure !== true
      ? {}
      : {
          displayService: {
            getEffectiveTapCardSettings: () => {
              if (options.displaySettingsFailure === true) throw new Error("display unavailable");
              return {
                tapId: TAP_ID,
                settings: {
                  ...options.tapCardMetricSettings!,
                  remainingMode: "percent",
                },
                override: null,
              };
            },
          },
        }),
  } as unknown as PublicStoryServiceDependencies;

  const service = new PublicStoryService(dependencies);
  return {
    service,
    setMystery: (value: TapAssignmentMysteryConfig) => {
      assignmentMystery = value;
    },
    setTap: (value: Partial<AdminTapView>) => {
      tap = { ...tap, ...value };
    },
    getRecipeSnapshotsCalls: () => getRecipeSnapshotsCalls,
  };
}

void test("public Story projection keeps normal fields and redacts internal IDs", () => {
  const { service, getRecipeSnapshotsCalls } = fixture();
  const card = service.getCard(TAP_ID);
  assert.ok(card);
  assert.equal(card.title, "Secret Beverage Name");
  assert.equal(card.tapName, "Secret Tap Name");
  assert.equal(card.beverageName, "Secret Beverage Name");
  assert.equal(card.abv, 6.4);
  assert.equal(card.storyPath, `/taps/${encodeURIComponent(TAP_ID)}/story`);
  assert.equal(card.graphicId, "pint_glass");
  assert.equal(card.graphic?.token, "vessel/pint-glass");
  assert.deepEqual(
    card.metrics.map((metric) => metric.key),
    ["abv", "ibu", "og", "fg"],
  );

  const story = service.getStory(TAP_ID);
  assert.ok(story);
  assert.equal(story.presentation.beverageName, "Secret Beverage Name");
  assert.equal(story.presentation.style, "Secret Style");
  assert.equal(story.currentFill.fillDate, "2026-08-02");
  assert.equal(story.currentFill.assignedAt, "2026-08-02T00:00:00.000Z");
  assert.equal(story.recipes?.custom?.kind, "custom");
  assert.equal(story.recipes?.sources.length, 5);
  assert.equal(story.history?.length, 50);
  assert.equal(getRecipeSnapshotsCalls(), 1);

  const serialized = JSON.stringify({ card, story });
  for (const forbidden of [
    ASSIGNMENT_ID,
    SOURCE_ID,
    FINGERPRINT,
    "secret-custom-recipe-id",
    "secret-detector-source-id",
    "secret-cursor",
    "foreign-fill-id",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

void test("Mystery defaults are safe across card, legacy, Story, and accessibility", () => {
  const { service, setMystery } = fixture();
  setMystery(mystery({ enabled: true }));

  const card = service.getCard(TAP_ID);
  assert.ok(card);
  assert.equal(card.title, "Mystery Tap");
  assert.equal(card.tapName, null);
  assert.equal(card.abv, null);
  assert.equal(card.beverageName, null);
  assert.deepEqual(card.metrics, []);
  assert.equal(card.fillId, null);
  assert.equal(card.accessibleLabel, "Tap 7, Mystery Tap");
  assert.equal(card.storyPath, `/taps/${encodeURIComponent(TAP_ID)}/story`);
  assert.equal(card.remainingVolumeMl, 12000);
  assert.equal(card.fillPercent, 63.2);

  const legacy = service.listLegacyTaps()[0];
  assert.ok(legacy);
  assert.equal(legacy.name, null);
  assert.deepEqual(legacy.activeFill, {
    fillId: null,
    beverageName: null,
    beverageType: null,
    beverageStyle: null,
    beverageAbv: null,
  });

  const story = service.getStory(TAP_ID);
  assert.ok(story);
  assert.equal(story.title, "Mystery Tap");
  assert.equal(story.accessibleLabel, "Tap 7, Mystery Tap");
  assert.equal(story.presentation.beverageName, null);
  assert.equal(story.presentation.beverageType, null);
  assert.equal(story.presentation.style, null);
  assert.equal(story.presentation.description, null);
  assert.equal(story.sensory, null);
  assert.equal(story.recipes, null);
  assert.equal(story.history, null);
  assert.equal(story.currentFill.fillDate, null);
  assert.equal(story.currentFill.assignedAt, null);
  const serialized = JSON.stringify({ card, legacy, story });
  for (const forbidden of [
    "Secret Tap Name",
    "Secret Beverage Name",
    "Secret Style",
    "Secret Description",
    ASSIGNMENT_ID,
    SOURCE_ID,
    FINGERPRINT,
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

void test("Tap metric preferences intersect with Mystery redaction and fail closed", () => {
  const configured = fixture({
    tapCardMetricSettings: {
      showAbv: false,
      showIbu: true,
      showOg: false,
      showFg: false,
      showSrm: false,
    },
  });
  assert.deepEqual(configured.service.getCard(TAP_ID)?.metrics, [
    { key: "ibu", label: "IBU", value: "42" },
  ]);

  configured.setMystery(mystery({ enabled: true }));
  assert.equal(configured.service.getCard(TAP_ID)?.abv, null);
  assert.deepEqual(configured.service.getCard(TAP_ID)?.metrics, []);
  configured.setMystery(mystery({ enabled: true, revealAbv: true }));
  assert.equal(configured.service.getCard(TAP_ID)?.abv, 6.4);
  configured.setMystery(mystery({ enabled: true, revealIbu: true }));
  assert.deepEqual(configured.service.getCard(TAP_ID)?.metrics, [
    { key: "ibu", label: "IBU", value: "42" },
  ]);

  const failed = fixture({ displaySettingsFailure: true });
  assert.deepEqual(failed.service.getCard(TAP_ID)?.metrics, []);
});

void test("each Mystery reveal controls only its allowlisted surface", () => {
  const { service, setMystery } = fixture();
  const cases: readonly [
    keyof Omit<TapAssignmentMysteryConfig, "enabled">,
    (story: NonNullable<ReturnType<PublicStoryService["getStory"]>>) => unknown,
  ][] = [
    ["revealBeverageType", (story) => story.presentation.beverageType],
    ["revealStyle", (story) => story.presentation.style],
    ["revealAbv", (story) => story.presentation.abv],
    ["revealIbu", (story) => story.presentation.ibu],
    ["revealOg", (story) => story.presentation.og],
    ["revealFg", (story) => story.presentation.fg],
    ["revealSrm", (story) => story.presentation.srm],
    ["revealDescription", (story) => story.presentation.description],
    ["revealRecipe", (story) => story.recipes],
    ["revealSensory", (story) => story.sensory],
    ["revealHistory", (story) => story.history],
  ];

  for (const [flag, read] of cases) {
    setMystery(mystery({ enabled: true, [flag]: true }));
    const story = service.getStory(TAP_ID);
    assert.ok(story);
    assert.notEqual(read(story), null, flag);
    for (const [otherFlag, otherRead] of cases) {
      if (otherFlag === flag) continue;
      assert.equal(otherRead(story), null, `${flag} leaked ${otherFlag}`);
    }
    assert.equal(story.presentation.beverageName, null);
    assert.equal(story.title, "Mystery Tap");
  }
});

void test("invalid, disabled, retired, and unassigned taps are safe", () => {
  const { service, setMystery, setTap } = fixture();
  assert.equal(service.getCard("not-a-uuid"), undefined);
  assert.equal(service.getStory("not-a-uuid"), undefined);

  setTap({ activeAssignment: null, isOccupied: false });
  setMystery(defaultMystery);
  const unassigned = service.getCard(TAP_ID);
  assert.ok(unassigned);
  assert.equal(unassigned.storyPath, null);
  assert.equal(unassigned.tapName, "Secret Tap Name");
  assert.equal(unassigned.abv, null);
  assert.equal(service.getStory(TAP_ID), undefined);

  setTap({ enabled: false });
  assert.equal(service.getCard(TAP_ID), undefined);
  setTap({ enabled: true, isRetired: true });
  assert.equal(service.getCard(TAP_ID), undefined);
});
