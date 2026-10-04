import assert from "node:assert/strict";
import test from "node:test";
import { recipeAmount, recipeMass, recipeNumber } from "../src/features/web/recipe-presentation.ts";

const amount = (value: number | null, unit: string | null, grams: number | null = null) => ({
  amount: value,
  unit,
  grams,
});

void test("fermentable masses convert to metric and pounds with fractional ounces", () => {
  assert.equal(recipeAmount(amount(5, "kg"), "metric", "fermentables"), "5 kg");
  assert.equal(recipeAmount(amount(5, "kg"), "us", "fermentables"), "11 lb 0.37 oz");
  assert.equal(recipeMass(453.59237, "us", "fermentables"), "1 lb 0 oz");
  assert.equal(recipeMass(453.59, "us", "fermentables"), "1 lb 0 oz");
  assert.equal(recipeMass(907.19, "us", "fermentables"), "2 lb 0 oz");
  assert.equal(recipeMass(500, "metric", "fermentables"), "500 g");
});

void test("hops use ounces in US mode while small misc doses retain metric units", () => {
  assert.equal(recipeAmount(amount(28.349523125, "g"), "us", "hops"), "1 oz");
  assert.equal(recipeMass(10, "metric", "hops"), "10 g");
  for (const system of ["metric", "us"] as const) {
    assert.equal(recipeAmount(amount(25, "mg"), system, "miscs"), "25 mg");
    assert.equal(recipeMass(3.5, system, "miscs"), "3.5 g");
  }
});

void test("zero is preserved and tiny positive quantities never become exact zero", () => {
  assert.equal(recipeMass(0, "us", "hops"), "0 oz");
  assert.equal(recipeMass(0, "us", "fermentables"), "0 lb 0 oz");
  assert.equal(recipeAmount(amount(0, "pkg"), "metric", "yeasts"), "0 pkg");
  assert.equal(recipeMass(0.0000001, "us", "hops"), "< 0.01 oz");
  assert.equal(recipeMass(0.0000001, "us", "fermentables"), "0 lb < 0.01 oz");
  assert.equal(recipeMass(0.0000001, "metric", "miscs"), "< 0.01 mg");
  assert.equal(recipeNumber(0.1 + 0.2), "0.3");
});

void test("packages, items, unknown and missing units remain truthful", () => {
  for (const system of ["metric", "us"] as const) {
    assert.equal(recipeAmount(amount(1.5, "pkg", 99), system, "yeasts"), "1.5 pkg");
    assert.equal(recipeAmount(amount(2, "items"), system, "miscs"), "2 items");
    assert.equal(recipeAmount(amount(3, "scoops", 99), system, "hops"), "3 scoops");
    for (const unit of ["constructor", "__proto__"]) {
      assert.equal(recipeAmount(amount(3, unit, 99), system, "hops"), `3 ${unit}`);
    }
    assert.equal(recipeAmount(amount(3, null, 99), system, "hops"), "3 (unit not recorded)");
  }
});

void test("malformed quantities are unavailable and precision is bounded", () => {
  for (const value of [NaN, Infinity, -Infinity, -1]) {
    assert.equal(recipeMass(value, "metric", "hops"), "—");
    assert.equal(recipeAmount(amount(value, "pkg"), "metric", "yeasts"), "—");
  }
  assert.equal(recipeAmount(amount(null, "g"), "metric", "hops"), "—");
  assert.equal(recipeAmount(amount(Number.MAX_VALUE, "kg"), "metric", "hops"), "—");
  assert.equal(recipeNumber(Infinity), "—");
  assert.equal(recipeNumber(1.23456789, 100), "1.234568");
  assert.equal(recipeNumber(1.234, -100), "1");
  assert.equal(recipeNumber(1.234, NaN), "1.23");
});
