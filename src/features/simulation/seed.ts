import { ApplicationError } from "../../shared/errors.ts";
import { insertSensor, listSensors, readSettings, setFillVolume, setSeeded } from "./repository.ts";
import type { SimulationDependencies, SimulationSensor } from "./types.ts";

const SAMPLE_BEERS = [
  {
    name: "Golden Hour Pilsner",
    style: "German Pilsner",
    abv: 4.8,
    ibu: 32,
    srm: 3,
    fillGlass: "pilsner_flute",
    fraction: 0.93,
  },
  {
    name: "Cloudline IPA",
    style: "Hazy IPA",
    abv: 6.4,
    ibu: 45,
    srm: 5,
    fillGlass: "ipa_glass",
    fraction: 0.78,
  },
  {
    name: "Copper Trail Amber",
    style: "American Amber Ale",
    abv: 5.3,
    ibu: 30,
    srm: 14,
    fillGlass: "nonic_pint",
    fraction: 0.6,
  },
  {
    name: "Midnight Porter",
    style: "Robust Porter",
    abv: 5.8,
    ibu: 35,
    srm: 32,
    fillGlass: "stout_glass",
    fraction: 0.43,
  },
  {
    name: "Orchard Saison",
    style: "Saison",
    abv: 6.1,
    ibu: 25,
    srm: 5,
    fillGlass: "tulip_glass",
    fraction: 0.27,
  },
  {
    name: "Summer Wheat",
    style: "Hefeweizen",
    abv: 5.0,
    ibu: 12,
    srm: 4,
    fillGlass: "wheat_glass",
    fraction: 0.12,
  },
] as const;

/** Seed only a new, dedicated simulation database, through ordinary domain services. */
export function seedSimulation(dependencies: SimulationDependencies): readonly SimulationSensor[] {
  const { database, tapService, kegService, beverageService, fillService, telemetryService } =
    dependencies;
  return database.withTransaction(() => {
    if (readSettings(database).seeded) return listSensors(database);
    // A forgotten marker is never permission to mix examples into an existing installation.
    if (
      tapService.listTaps().length > 0 ||
      kegService.listKegs().length > 0 ||
      beverageService.listBeverages().length > 0 ||
      fillService.listFills().length > 0 ||
      telemetryService.listSources().length > 0 ||
      listSensors(database).length > 0
    ) {
      throw new ApplicationError({
        category: "conflict",
        code: "simulation.database_not_empty",
        clientMessage: "Simulation can only be initialized in an empty, separate database.",
      });
    }

    const actor = { actorType: "system" } as const;
    for (const [index, beer] of SAMPLE_BEERS.entries()) {
      const { fraction, ...profile } = beer;
      const tapNumber = index + 1;
      const tap = tapService.createTap({ tapNumber, name: `Sample Tap ${tapNumber}` }, actor);
      const beverage = beverageService.createCustomBeverage(
        {
          ...profile,
          beverageType: "beer",
          fg: 1.012,
          description: "Fictional sample beer for the built-in Simulation workspace.",
        },
        actor,
      );
      const keg = kegService.createKeg(
        {
          kegNumber: tapNumber,
          label: `Sample Keg ${tapNumber}`,
          capacityMl: 19_000,
          currentTareG: 4_200,
        },
        actor,
      );
      const fill = fillService.createFill(
        { beverageId: beverage.beverage.id, kegId: keg.id },
        actor,
      );
      setFillVolume(database, fill.id, keg.capacityMl * fraction);
      // Initial plaintext is deliberately discarded. Each runner lifecycle rotates it in memory.
      const { source } = telemetryService.createSource(
        { name: `Simulation sensor ${tapNumber}` },
        actor,
      );
      telemetryService.setTapAuthority(tap.id, { sourceId: source.id }, actor);
      tapService.assignFill(tap.id, { fillId: fill.id }, actor);
      insertSensor(database, {
        tapId: tap.id,
        sourceId: source.id,
        remainingMl: keg.capacityMl * fraction,
        temperatureC: 4 + index * 0.2,
        online: true,
        noiseEnabled: false,
        sequence: 0,
      });
    }

    const onDeckBeer = beverageService.createCustomBeverage(
      {
        name: "Harvest Märzen",
        beverageType: "beer",
        style: "Märzen",
        abv: 5.7,
        ibu: 24,
        srm: 12,
        fg: 1.013,
        fillGlass: "mug",
        description: "Fictional sample beer waiting On Deck in Simulation.",
      },
      actor,
    );
    const onDeckKeg = kegService.createKeg(
      { kegNumber: 7, label: "Sample On Deck Keg", capacityMl: 19_000, currentTareG: 4_200 },
      actor,
    );
    const onDeckFill = fillService.createFill(
      { beverageId: onDeckBeer.beverage.id, kegId: onDeckKeg.id },
      actor,
    );
    setFillVolume(database, onDeckFill.id, onDeckKeg.capacityMl);
    fillService.markOnDeck(onDeckFill.id, actor);
    setSeeded(database);
    return listSensors(database);
  });
}
