import assert from "node:assert/strict";
import test from "node:test";

import {
  Router,
  type NotFoundHandler,
  type RouteHandler,
} from "../src/infrastructure/http/router.ts";
import { createLogger } from "../src/shared/logging.ts";
import { registerWebRoutes, type WebRouteDependencies } from "../src/features/web/routes.ts";

type RegistrationEvent = readonly ["NOT_FOUND"] | readonly [string, string];

class RecordingRouter extends Router {
  readonly registrations: RegistrationEvent[] = [];

  override register(method: string, path: string, handler: RouteHandler): void {
    super.register(method, path, handler);
    this.registrations.push([method, path]);
  }

  override setNotFoundHandler(handler: NotFoundHandler | undefined): void {
    super.setNotFoundHandler(handler);
    this.registrations.push(["NOT_FOUND"]);
  }
}

// Fixed pre-extraction HTTP contract captured from the #114 baseline.
const EXPECTED_REGISTRATIONS: readonly RegistrationEvent[] = [
  ["NOT_FOUND"],
  ["GET", "/"],
  ["GET", "/taps/:tapId/story"],
  ["GET", "/api/public/dashboard"],
  ["GET", "/api/public/dashboard/header"],
  ["GET", "/api/public/dashboard/display"],
  ["GET", "/api/public/dashboard/on-deck"],
  ["GET", "/api/public/tap-wars"],
  ["POST", "/api/public/tap-wars/:warId/votes"],
  ["GET", "/api/public/dashboard/taps/:tapId"],
  ["GET", "/api/public/taps/:tapId/story"],
  ["GET", "/api/public/events"],
  ["GET", "/admin"],
  ["GET", "/admin/login"],
  ["POST", "/admin/login"],
  ["POST", "/admin/logout"],
  ["GET", "/admin/overview"],
  ["GET", "/admin/jump"],
  ["GET", "/admin/integrations"],
  ["GET", "/admin/integrations/outbound"],
  ["GET", "/admin/integrations/outbound/new"],
  ["GET", "/admin/integrations/outbound/:id"],
  ["GET", "/admin/integrations/brewfather"],
  ["GET", "/admin/integrations/telemetry"],
  ["GET", "/admin/integrations/telemetry-sources/:id"],
  ["GET", "/admin/beverages"],
  ["GET", "/admin/beverages/new"],
  ["GET", "/admin/beverages/:id"],
  ["GET", "/admin/keg-room"],
  ["GET", "/admin/keg-room/kegs"],
  ["GET", "/admin/keg-room/kegs/new"],
  ["GET", "/admin/keg-room/kegs/:id"],
  ["GET", "/admin/keg-room/fills/new"],
  ["GET", "/admin/keg-room/fills/:id"],
  ["GET", "/admin/keg-room/fill"],
  ["GET", "/admin/keg-room/fill/:id"],
  ["GET", "/admin/fills"],
  ["GET", "/admin/kegs"],
  ["GET", "/admin/kegs/:id"],
  ["GET", "/admin/fills/:id"],
  ["GET", "/admin/taps"],
  ["GET", "/admin/taps/new"],
  ["GET", "/admin/taps/:id"],
  ["GET", "/admin/tap-wars"],
  ["GET", "/admin/display"],
  ["GET", "/admin/display/shared"],
  ["GET", "/admin/display/this-display"],
  ["GET", "/admin/system"],
  ["GET", "/api/admin/events"],
  ["GET", "/api/admin/tap-wars"],
  ["POST", "/admin/system/calculation"],
  ["POST", "/admin/system/retention"],
  ["POST", "/admin/system/session-policy"],
  ["POST", "/admin/system/sessions/:id/revoke"],
  ["POST", "/admin/system/pin"],
  ["POST", "/admin/integrations/outbound/create"],
  ["POST", "/admin/integrations/outbound/:id/edit"],
  ["POST", "/admin/integrations/outbound/:id/enable"],
  ["POST", "/admin/integrations/outbound/:id/disable"],
  ["POST", "/admin/integrations/outbound/:id/required"],
  ["POST", "/admin/integrations/outbound/:id/token"],
  ["POST", "/admin/integrations/outbound/:id/token/remove"],
  ["POST", "/admin/integrations/outbound/:id/header-secret"],
  ["POST", "/admin/integrations/outbound/:id/header-secret/remove"],
  ["POST", "/admin/integrations/outbound/:id/retire"],
  ["POST", "/admin/integrations/outbound/:id/deliveries/:deliveryId/retry"],
  ["POST", "/admin/integrations/outbound/:id/deliveries/:deliveryId/dismiss"],
  ["POST", "/admin/display/shared"],
  ["POST", "/admin/display/tap-card"],
  ["POST", "/admin/beverages/:id/presentation"],
  ["POST", "/admin/beverages/create"],
  ["POST", "/admin/beverages/:id/create-fill"],
  ["POST", "/admin/beverages/:id/update"],
  ["POST", "/admin/beverages/:id/delete"],
  ["POST", "/admin/beverages/:id/sensory"],
  ["POST", "/admin/beverages/:id/recipe"],
  ["POST", "/admin/beverages/:id/unlink"],
  ["POST", "/admin/beverages/brewfather/link"],
  ["POST", "/admin/kegs/create"],
  ["POST", "/admin/kegs/:id/update"],
  ["POST", "/admin/kegs/:id/maintenance"],
  ["POST", "/admin/kegs/:id/delete"],
  ["POST", "/admin/fills/create"],
  ["POST", "/admin/fills/reorder-on-deck"],
  ["POST", "/admin/fills/:id/on-deck"],
  ["POST", "/admin/fills/:id/remove-on-deck"],
  ["POST", "/admin/fills/:id/move"],
  ["POST", "/admin/fills/:id/kick"],
  ["POST", "/admin/fills/:id/featured"],
  ["POST", "/admin/fills/:id/delete"],
  ["POST", "/admin/taps/create"],
  ["POST", "/admin/taps/:id/update"],
  ["POST", "/admin/taps/:id/assign"],
  ["POST", "/admin/taps/:id/mystery"],
  ["POST", "/admin/taps/:id/display"],
  ["POST", "/admin/taps/:id/unassign"],
  ["POST", "/admin/taps/:id/move"],
  ["POST", "/admin/taps/:id/authority"],
  ["POST", "/admin/taps/:id/detector-config"],
  ["POST", "/admin/taps/:id/health-config"],
  ["POST", "/admin/taps/:id/rebaseline"],
  ["POST", "/admin/taps/:id/maintenance"],
  ["POST", "/admin/taps/:id/retire"],
  ["POST", "/admin/taps/:id/delete"],
  ["POST", "/admin/integrations/brewfather"],
  ["POST", "/admin/integrations/brewfather/sync"],
  ["POST", "/admin/integrations/brewfather/remove-key"],
  ["POST", "/admin/integrations/telemetry-sources/create"],
  ["POST", "/admin/integrations/telemetry-sources/:id/rotate"],
  ["POST", "/admin/integrations/telemetry-sources/:id/disable"],
  ["POST", "/admin/tap-wars/start"],
  ["POST", "/admin/tap-wars/:id/resume"],
  ["POST", "/admin/tap-wars/:id/stop"],
  ["POST", "/admin/tap-wars/:id/dismiss"],
];

void test("Web composition preserves the complete ordered route and not-found contract", () => {
  const router = new RecordingRouter(createLogger({ sink: () => undefined }));
  registerWebRoutes({ router } as unknown as WebRouteDependencies);
  assert.deepEqual(router.registrations, EXPECTED_REGISTRATIONS);
});
