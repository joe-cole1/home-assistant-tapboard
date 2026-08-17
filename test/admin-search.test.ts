import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAdminJumpQuery,
  searchAdminDestinations,
} from "../src/features/web/admin-search.ts";

const emptyPage = { items: [], total: 0, page: 1, pageSize: 25, pageCount: 1, query: "" };

function services(overrides: Record<string, unknown> = {}) {
  return {
    taps: { listAdminPage: () => emptyPage },
    beverages: { listBeveragePage: () => emptyPage },
    fills: { listAdminPage: () => ({ ...emptyPage, state: "active", sort: "name" }) },
    kegs: { listAdminPage: () => ({ ...emptyPage, status: "all", sort: "number" }) },
    telemetry: { searchAdminSources: () => [] },
    ...overrides,
  } as never;
}

void test("Admin Jump bounds Unicode query text by UTF-8 bytes", () => {
  const result = normalizeAdminJumpQuery(`${"é".repeat(100)}  `);
  assert.equal(Buffer.byteLength(result, "utf8"), 80);
  assert.equal(normalizeAdminJumpQuery(null), "");
});

void test("Admin Jump ranks fixed destinations, deduplicates links, and caps results", () => {
  const result = searchAdminDestinations({
    query: "tap",
    destinations: [
      { label: "Taps", href: "/admin/taps", mark: "T" },
      { label: "Taps", href: "/admin/taps", mark: "T" },
    ],
    services: services({
      taps: {
        listAdminPage: () => ({
          ...emptyPage,
          items: Array.from({ length: 25 }, (_, index) => ({
            id: `tap-${index}`,
            tapNumber: index + 1,
            name: `Tap ${index + 1}`,
            enabled: true,
            isRetired: false,
            firstUsedAt: null,
            retiredAt: null,
            assignment: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
          total: 25,
          pageCount: 1,
          query: "tap",
          state: "all",
        }),
      },
    }),
  });

  assert.equal(result.query, "tap");
  assert.equal(result.results.length, 20);
  assert.equal(new Set(result.results.map((item) => item.href)).size, 20);
  assert.equal(result.results[0]?.href, "/admin/taps");
});

void test("Admin Jump keeps wildcard search literal and never includes source secrets", () => {
  let receivedQuery = "";
  const result = searchAdminDestinations({
    query: "%_",
    destinations: [],
    services: services({
      telemetry: {
        searchAdminSources: (query: string) => {
          receivedQuery = query;
          return [
            {
              id: "internal-source-id",
              name: "Source <West>",
              disabledAt: null,
            },
          ];
        },
      },
    }),
  });

  assert.equal(receivedQuery, "%_");
  assert.equal(result.results.length, 1);
  assert.match(result.results[0]?.href ?? "", /\/admin\/integrations\/telemetry-sources\//u);
  assert.doesNotMatch(JSON.stringify(result), /machineKey|rawSource|payloadDigest/u);
});

void test("Admin Jump tie ordering is locale-independent for accented labels", () => {
  const result = searchAdminDestinations({
    query: "caf",
    destinations: [
      { label: "Café", href: "/admin/cafe-1", mark: "C" },
      { label: "cafe", href: "/admin/cafe-2", mark: "C" },
      { label: "CAFÉ", href: "/admin/cafe-3", mark: "C" },
    ],
    services: services(),
  });

  assert.deepEqual(
    result.results.map((item) => item.label),
    ["cafe", "CAFÉ", "Café"],
  );
});
