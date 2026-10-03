import { displayStylesheetHref } from "../../display/palette.ts";
import type { PublicTapCardMetricSettings } from "../../story/service.ts";
import { safeDisplayResource, safeTapCardResource } from "../presenters/display.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  requiredAutosaveField,
  validationFieldsFor,
} from "./http.ts";
import { renderAdmin } from "./layout.ts";
import { previewSampleCard } from "./tap-presentation.ts";
import { actor } from "./context.ts";
import type {
  RegisterDisplayPagesDependencies,
  RegisterDisplayMutationsDependencies,
} from "../contracts.ts";

export function registerDisplayPages(dependencies: RegisterDisplayPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/display", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display",
      "Display",
      "/admin/display",
      {
        sharedDisplay,
      },
    );
  });
  registerAdminGet(dependencies, "/admin/display/shared", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    const tapCardSettings =
      typeof dependencies.displayService.getTapCardSettings === "function"
        ? dependencies.displayService.getTapCardSettings()
        : undefined;
    const previewSettings: PublicTapCardMetricSettings = tapCardSettings ?? {
      showAbv: true,
      showIbu: true,
      showOg: true,
      showFg: true,
      showSrm: false,
    };
    const previewTap = previewSampleCard(previewSettings);
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display-shared",
      "Shared defaults",
      "/admin/display/shared",
      {
        sharedDisplay,
        tapCardSettings,
        previewTap,
        previewMetricCatalog: {
          abv: "5.0%",
          ibu: "42",
          og: "1.054",
          fg: "1.012",
          srm: "4.0",
        },
        displayStylesheetHref: displayStylesheetHref(
          sharedDisplay.theme,
          sharedDisplay.accent,
          "all",
        ),
        includeDashboardStyles: true,
      },
    );
  });
  registerAdminGet(dependencies, "/admin/display/this-display", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display-this-display",
      "This display",
      "/admin/display/this-display",
      {
        displayStylesheetHref: displayStylesheetHref(
          sharedDisplay.theme,
          sharedDisplay.accent,
          sharedDisplay.font,
        ),
      },
    );
  });
}

export function registerDisplayMutations(dependencies: RegisterDisplayMutationsDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/display/shared",
    "/admin/display/shared",
    (form, context) => {
      dependencies.displayService.updateSettings(
        {
          expectedRevision: Number(form.expectedRevision),
          tapboardName: form.tapboardName,
          theme: form.theme,
          font: form.font,
          accent: form.accent,
          unitSystem: form.unitSystem,
          showServingTemperature: form.showServingTemperature === "true",
          layoutMode: form.layoutMode,
        },
        actor(context),
      );
    },
    "Shared display defaults saved.",
    {},
    {
      handle: (body, context) => {
        const fields = autosaveFieldStrings(body, [
          "expectedRevision",
          "tapboardName",
          "theme",
          "font",
          "accent",
          "unitSystem",
          "showServingTemperature",
          "layoutMode",
        ]);
        const updated = dependencies.displayService.updateSettings(
          {
            expectedRevision: Number(requiredAutosaveField(fields, "expectedRevision")),
            tapboardName: fields.tapboardName,
            theme: fields.theme,
            font: fields.font,
            accent: fields.accent,
            unitSystem: fields.unitSystem,
            showServingTemperature: fields.showServingTemperature === "true",
            layoutMode: fields.layoutMode,
          },
          actor(context),
        );
        return {
          resource: safeDisplayResource(updated),
          revision: updated.revision,
        };
      },
      current: () => {
        const current = dependencies.displayService.getSettings();
        return { current, revision: current.revision };
      },
      validationFields: validationFieldsFor([
        "expectedRevision",
        "tapboardName",
        "theme",
        "font",
        "accent",
        "unitSystem",
        "showServingTemperature",
        "layoutMode",
      ]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/display/tap-card",
    "/admin/display/shared",
    (form, context) => {
      dependencies.displayService.updateTapCardSettings(
        {
          expectedRevision: Number(form.expectedRevision),
          showAbv: form.showAbv === "true",
          showIbu: form.showIbu === "true",
          showOg: form.showOg === "true",
          showFg: form.showFg === "true",
          showSrm: form.showSrm === "true",
          remainingMode: form.remainingMode,
        },
        actor(context),
      );
    },
    "Shared Tap-card settings saved.",
    {},
    {
      handle: (body, context) => {
        const fields = autosaveFieldStrings(body, [
          "expectedRevision",
          "showAbv",
          "showIbu",
          "showOg",
          "showFg",
          "showSrm",
          "remainingMode",
        ]);
        const updated = dependencies.displayService.updateTapCardSettings(
          {
            expectedRevision: Number(requiredAutosaveField(fields, "expectedRevision")),
            showAbv: fields.showAbv === "true",
            showIbu: fields.showIbu === "true",
            showOg: fields.showOg === "true",
            showFg: fields.showFg === "true",
            showSrm: fields.showSrm === "true",
            remainingMode: fields.remainingMode,
          },
          actor(context),
        );
        return {
          resource: safeTapCardResource(updated),
          revision: updated.revision,
        };
      },
      current: () => {
        const current = dependencies.displayService.getTapCardSettings();
        return { current, revision: current.revision };
      },
      validationFields: validationFieldsFor([
        "expectedRevision",
        "showAbv",
        "showIbu",
        "showOg",
        "showFg",
        "showSrm",
        "remainingMode",
      ]),
    },
  );
}
