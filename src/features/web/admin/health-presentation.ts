import { type HealthCheckId } from "../../health/types.ts";

export interface AdminConfigFieldPresentation {
  readonly label: string;
  readonly help: string;
  readonly unit?: string;
}

export const HEALTH_SECTION_PRESENTATION: Record<
  HealthCheckId,
  {
    readonly title: string;
    readonly description: string;
    readonly fields: Record<string, AdminConfigFieldPresentation>;
  }
> = {
  low_keg: {
    title: "Low keg level",
    description: "Warn when the estimated remaining volume falls below these thresholds.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate low-level thresholds for this Tap.",
      },
      thresholdPercent: {
        label: "Warning threshold (%)",
        help: "Warn when the remaining fill percentage is at or below this value.",
        unit: "%",
      },
      criticalPercent: {
        label: "Critical threshold (%)",
        help: "Mark the Tap critical when the remaining fill percentage is at or below this value.",
        unit: "%",
      },
      fixedThresholdMl: {
        label: "Fixed volume threshold (mL)",
        help: "Optional fixed-volume floor; zero keeps the percentage threshold as the floor.",
        unit: "mL",
      },
      settlingMs: {
        label: "Threshold settling time (ms)",
        help: "How long the reading must remain below a threshold before it is reported.",
        unit: "ms",
      },
    },
  },
  scale_availability: {
    title: "Scale availability",
    description: "Flag when the authoritative scale has not sent a fresh measurement.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate freshness of the authoritative scale measurement.",
      },
      degradedAfterMs: {
        label: "Degraded after (ms)",
        help: "Mark the scale degraded after this much time without a fresh measurement.",
        unit: "ms",
      },
      activeAfterMs: {
        label: "Unavailable after (ms)",
        help: "Mark the scale unavailable after this much time without a fresh measurement.",
        unit: "ms",
      },
    },
  },
  suspected_leak: {
    title: "Suspected leak",
    description: "Look for unexplained volume loss outside the grace period around a pour.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate unexplained volume loss for this Tap.",
      },
      lossThresholdMl: {
        label: "Loss threshold (mL)",
        help: "Minimum unexplained loss that can become a leak signal.",
        unit: "mL",
      },
      windowMs: {
        label: "Observation window (ms)",
        help: "Time window in which unexplained loss is accumulated.",
        unit: "ms",
      },
      pourGraceMs: {
        label: "Pour grace period (ms)",
        help: "Ignore expected movement for this long after a pour.",
        unit: "ms",
      },
      settlingMs: {
        label: "Baseline settling time (ms)",
        help: "Wait this long for a stable baseline before evaluating loss.",
        unit: "ms",
      },
      resetMovementMl: {
        label: "Baseline reset movement (mL)",
        help: "Movement at or above this amount resets the leak baseline.",
        unit: "mL",
      },
      maxSamples: {
        label: "Maximum samples (count)",
        help: "Maximum number of leak samples retained in the evaluation window.",
        unit: "samples",
      },
    },
  },
  serving_temperature: {
    title: "Serving temperature",
    description: "Check whether the latest serving temperature stays within the configured bands.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate serving temperature for this Tap.",
      },
      normalMinC: {
        label: "Normal minimum (°C)",
        help: "Lower edge of the normal serving-temperature range.",
        unit: "°C",
      },
      normalMaxC: {
        label: "Normal maximum (°C)",
        help: "Upper edge of the normal serving-temperature range.",
        unit: "°C",
      },
      criticalMinC: {
        label: "Critical minimum (°C)",
        help: "Temperature at or below which the reading is critical.",
        unit: "°C",
      },
      criticalMaxC: {
        label: "Critical maximum (°C)",
        help: "Temperature at or above which the reading is critical.",
        unit: "°C",
      },
      durationMs: {
        label: "Out-of-range duration (ms)",
        help: "How long temperature must remain outside the normal range before reporting.",
        unit: "ms",
      },
    },
  },
  line_cleaning_due: {
    title: "Line cleaning",
    description:
      "Track when the Tap line should be cleaned and when the due state becomes critical.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate line-cleaning age for this Tap.",
      },
      intervalDays: {
        label: "Cleaning interval (days)",
        help: "Number of days between expected line cleanings.",
        unit: "days",
      },
      criticalGraceDays: {
        label: "Critical grace period (days)",
        help: "Additional days after the due date before cleaning becomes critical.",
        unit: "days",
      },
    },
  },
};
