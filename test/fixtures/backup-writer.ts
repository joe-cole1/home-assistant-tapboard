// Stands in for the running application: commits Physical Kegs until stdin closes.
import { setTimeout as delay } from "node:timers/promises";

import { createKegService } from "../../src/features/kegs/service.ts";
import { openDatabase } from "../../src/infrastructure/database/connection.ts";

const database = openDatabase(process.argv[2] ?? "");
const kegs = createKegService(database);
let writing = true;
process.stdin.on("end", () => (writing = false)).resume();
let written = 0;
while (writing) {
  kegs.createKeg({ kegNumber: 1_000 + written, capacityMl: 19_500 });
  written += 1;
  if (written === 10) process.stdout.write("ready\n");
  await delay(1);
}
database.close();
process.stdout.write(`${written}\n`);
