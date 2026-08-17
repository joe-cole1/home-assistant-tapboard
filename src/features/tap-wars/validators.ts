import { ApplicationError } from "../../shared/errors.ts";

export function requireUuid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new ApplicationError({
      category: "validation",
      code: "validation.invalid_value",
      clientMessage: "The request contains an invalid value.",
      details: { field, reason: "must be a UUID" },
    });
  }
  return value.toLowerCase();
}

export function requireSides(input: unknown): readonly [string, string] {
  const values = Array.isArray(input)
    ? input
    : typeof input === "object" &&
        input !== null &&
        "competitor1AssignmentId" in input &&
        "competitor2AssignmentId" in input
      ? [
          (input as { competitor1AssignmentId: unknown }).competitor1AssignmentId,
          (input as { competitor2AssignmentId: unknown }).competitor2AssignmentId,
        ]
      : undefined;
  if (values === undefined || values.length !== 2) {
    throw new ApplicationError({
      category: "validation",
      code: "tap_war.invalid_competitors",
      clientMessage: "Choose exactly two competitors.",
    });
  }
  const first = requireUuid(values[0], "competitor1AssignmentId");
  const second = requireUuid(values[1], "competitor2AssignmentId");
  if (first === second) {
    throw new ApplicationError({
      category: "validation",
      code: "tap_war.duplicate_competitor",
      clientMessage: "Competitors must be distinct.",
    });
  }
  return [first, second];
}
