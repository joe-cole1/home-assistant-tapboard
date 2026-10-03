import { registerAdminNotFound } from "./admin/not-found.ts";
import { registerPublicRoutes } from "./public-routes.ts";
import { registerAuthenticationRoutes } from "./authentication-routes.ts";
import { registerOverviewPages, registerAdminEventRoutes } from "./admin/overview.ts";
import {
  registerIntegrationPages,
  registerOutboundMutations,
  registerIntegrationMutations,
} from "./admin/integrations.ts";
import { registerBeveragePages } from "./admin/beverages.ts";
import { registerKegRoomPages } from "./admin/keg-room.ts";
import { registerTapPages } from "./admin/taps.ts";
import {
  registerTapWarsPages,
  registerAdminTapWarsApi,
  registerTapWarsMutations,
} from "./admin/tap-wars.ts";
import { registerDisplayPages } from "./admin/display.ts";
import { registerSystemPages } from "./admin/system.ts";
import { registerSystemMutations } from "./admin/system.ts";
import { registerDisplayMutations } from "./admin/display.ts";
import { registerBeverageMutations } from "./admin/beverages.ts";
import { registerKegRoomMutations } from "./admin/keg-room.ts";
import { registerTapMutations } from "./admin/taps.ts";
import type { WebRouteDependencies } from "./contracts.ts";
export type { WebRouteDependencies } from "./contracts.ts";

export function registerWebRoutes(dependencies: WebRouteDependencies): void {
  registerAdminNotFound(dependencies);
  registerPublicRoutes(dependencies);
  registerAuthenticationRoutes(dependencies);
  // Preserve the original page and API registration pass.
  registerOverviewPages(dependencies);
  registerIntegrationPages(dependencies);
  registerBeveragePages(dependencies);
  registerKegRoomPages(dependencies);
  registerTapPages(dependencies);
  registerTapWarsPages(dependencies);
  registerDisplayPages(dependencies);
  registerSystemPages(dependencies);
  registerAdminEventRoutes(dependencies);
  registerAdminTapWarsApi(dependencies);
  // Preserve the original mutation pass, including interleaved integration routes.
  registerSystemMutations(dependencies);
  registerOutboundMutations(dependencies);
  registerDisplayMutations(dependencies);
  registerBeverageMutations(dependencies);
  registerKegRoomMutations(dependencies);
  registerTapMutations(dependencies);
  registerIntegrationMutations(dependencies);
  registerTapWarsMutations(dependencies);
}
