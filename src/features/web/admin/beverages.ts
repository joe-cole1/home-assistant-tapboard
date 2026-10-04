import type { IncomingMessage } from "node:http";
import type { BeverageService } from "../../beverages/service.ts";
import { BEVERAGE_TYPES, type UpdateCustomBeverageInput } from "../../beverages/types.ts";
import type { BeverageDetailResult } from "../../beverages/service.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  requiredAutosaveField,
  validationFieldsFor,
} from "./http.ts";
import { renderAdmin } from "./layout.ts";
import {
  adminBeverageListItem,
  adminBrewfatherCandidate,
  fillGlassOptions,
  adminBeverageDetailDto,
  sensoryOverridesFromForm,
  vesselFromForm,
  recipeFromForm,
} from "./beverage-presentation.ts";
import { presentationOverridesFromForm } from "./presentation-overrides.ts";
import { actor, requestUrl } from "./context.ts";
import { nullable, optionalNumber, invalidForm } from "./forms.ts";
import type {
  RegisterBeveragePagesDependencies,
  RegisterBeverageMutationsDependencies,
} from "../contracts.ts";

export function registerBeveragePages(dependencies: RegisterBeveragePagesDependencies): void {
  registerAdminGet(dependencies, "/admin/beverages", (request, response, context) => {
    const query = listQueryFromRequest(request);
    const index = dependencies.beverageService.listBeveragePage(query);
    const previousPage = index.page > 1 ? beveragePageHref(index.query, index.page - 1) : null;
    const nextPage =
      index.page < index.pageCount ? beveragePageHref(index.query, index.page + 1) : null;
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverages",
      "Beverages",
      "/admin/beverages",
      {
        beverages: index.items.map(adminBeverageListItem),
        brewfatherCandidates: dependencies.beverageService
          .listCandidates()
          .map(adminBrewfatherCandidate),
        query: index.query,
        pagination: {
          page: index.page,
          pageCount: index.pageCount,
          total: index.total,
          previousHref: previousPage,
          nextHref: nextPage,
        },
      },
    );
  });

  // Keep the static create path ahead of /:id so "new" can never be treated
  // as a beverage identifier by the small path router.
  registerAdminGet(dependencies, "/admin/beverages/new", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverage-new",
      "New Beverage",
      "/admin/beverages/new",
      { beverageTypes: BEVERAGE_TYPES, fillGlassOptions: fillGlassOptions() },
    );
  });

  registerAdminGet(dependencies, "/admin/beverages/:id", (request, response, context, params) => {
    const id = params.id ?? "";
    const detail = dependencies.beverageService.getBeverage(id);
    const serviceWithUsage = dependencies.beverageService as BeverageService & {
      readonly getBeverageUsage?: (beverageId: string) => {
        readonly current: number;
        readonly total: number;
      };
      readonly listCurrentFills?: (
        beverageId: string,
        limit?: number,
      ) => readonly Record<string, unknown>[];
    };
    const usage =
      typeof serviceWithUsage.getBeverageUsage === "function"
        ? serviceWithUsage.getBeverageUsage(id)
        : { current: 0, total: 0 };
    const currentFills =
      typeof serviceWithUsage.listCurrentFills === "function"
        ? serviceWithUsage.listCurrentFills(id, 25)
        : [];
    const impact = dependencies.beverageService.getDeletionImpact(id);
    const guidance =
      typeof dependencies.storyService?.getAdminBeverageGuidance === "function"
        ? dependencies.storyService.getAdminBeverageGuidance(id)
        : undefined;
    const availableKegs = dependencies.kegService
      .listKegs({ isActive: true })
      .filter(
        (keg) =>
          !dependencies.fillService
            .listFills({ kegId: keg.id })
            .some((fill) => fill.state !== "ended"),
      )
      .map((keg) => ({ id: keg.id, kegNumber: keg.kegNumber, label: keg.label }));
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverage-detail",
      detail.effectivePresentation.name,
      "/admin/beverages",
      {
        beverage: {
          ...adminBeverageDetailDto(detail, usage, impact.impacts, guidance),
          currentFills,
        },
        beverageTypes: BEVERAGE_TYPES,
        fillGlassOptions: fillGlassOptions(),
        availableKegs,
      },
    );
  });
}

export function registerBeverageMutations(
  dependencies: RegisterBeverageMutationsDependencies,
): void {
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/presentation",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      dependencies.beverageService.updatePresentationOverrides(
        params.id!,
        presentationOverridesFromForm(form),
        actor(context),
      );
    },
    "Brewfather presentation overrides saved.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, [
          "updatedAt",
          "nameMode",
          "name",
          "beverageTypeMode",
          "beverageType",
          "styleMode",
          "style",
          "abvMode",
          "abv",
          "ibuMode",
          "ibu",
          "ogMode",
          "og",
          "fgMode",
          "fg",
          "srmMode",
          "srm",
          "displayColorMode",
          "displayColor",
          "descriptionMode",
          "description",
          "fillGlassMode",
          "fillGlass",
        ]);
        const updated = dependencies.beverageService.autosavePresentationOverrides(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          presentationOverridesFromForm(fields),
          actor(context),
        );
        return {
          resource: safeBrewfatherResource(updated),
          revision: updated.beverage.updatedAt,
        };
      },
      current: (params) => {
        const detail = dependencies.beverageService.getBeverage(params.id!);
        return { current: safeBeverageCurrent(detail), revision: detail.beverage.updatedAt };
      },
      validationFields: validationFieldsFor([
        "updatedAt",
        "nameMode",
        "name",
        "beverageTypeMode",
        "beverageType",
        "styleMode",
        "style",
        "abvMode",
        "abv",
        "ibuMode",
        "ibu",
        "ogMode",
        "og",
        "fgMode",
        "fg",
        "srmMode",
        "srm",
        "displayColorMode",
        "displayColor",
        "descriptionMode",
        "description",
        "fillGlassMode",
        "fillGlass",
      ]),
    },
  );

  registerAdminAction(
    dependencies,
    "/admin/beverages/create",
    "/admin/beverages",
    (form, context) => {
      const sensoryOverrides = sensoryOverridesFromForm(form);
      const created = dependencies.beverageService.createCustomBeverage(
        {
          name: form.name,
          beverageType: form.beverageType || "beer",
          style: nullable(form.style),
          abv: optionalNumber(form.abv),
          ibu: optionalNumber(form.ibu),
          og: optionalNumber(form.og),
          fg: optionalNumber(form.fg),
          srm: optionalNumber(form.srm),
          displayColor: nullable(form.displayColor),
          description: nullable(form.description),
          fillGlass: vesselFromForm(form.fillGlass),
          manualDensityOverride: optionalNumber(form.manualDensityOverride),
          ...(form.recipeJson !== undefined ? { recipe: recipeFromForm(form) } : {}),
          ...(sensoryOverrides !== undefined ? { sensoryOverrides } : {}),
        },
        actor(context),
      );
      return `/admin/beverages/${created.beverage.id}`;
    },
    "Beverage created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/create-fill",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      dependencies.fillService.createFill(
        {
          beverageId: params.id!,
          kegId: form.kegId,
          ...(form.fillDate ? { fillDate: form.fillDate } : {}),
        },
        actor(context),
      );
    },
    "Fill created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/update",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      const sensoryOverrides = sensoryOverridesFromForm(form);
      dependencies.beverageService.updateCustomBeverage(
        params.id!,
        {
          name: form.name,
          beverageType: form.beverageType,
          style: nullable(form.style),
          abv: optionalNumber(form.abv),
          ibu: optionalNumber(form.ibu),
          og: optionalNumber(form.og),
          fg: optionalNumber(form.fg),
          srm: optionalNumber(form.srm),
          displayColor: nullable(form.displayColor),
          description: nullable(form.description),
          fillGlass: vesselFromForm(form.fillGlass),
          manualDensityOverride: optionalNumber(form.manualDensityOverride),
          ...(form.recipeJson !== undefined ? { recipe: recipeFromForm(form) } : {}),
          ...(sensoryOverrides !== undefined ? { sensoryOverrides } : {}),
        },
        actor(context),
      );
    },
    "Beverage updated.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, ["updatedAt", ...AUTOSAVE_BEVERAGE_FIELDS]);
        const updated = dependencies.beverageService.autosaveCustomPresentation(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          customBeverageAutosaveInput(fields),
          actor(context),
        );
        return {
          resource: safeCustomBeverageResource(updated),
          revision: updated.beverage.updatedAt,
        };
      },
      current: (params) => {
        const detail = dependencies.beverageService.getBeverage(params.id!);
        return { current: safeBeverageCurrent(detail), revision: detail.beverage.updatedAt };
      },
      validationFields: validationFieldsFor(["updatedAt", ...AUTOSAVE_BEVERAGE_FIELDS]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/delete",
    "/admin/beverages",
    (form, context, params) => {
      if (form.confirmationName === undefined || form.confirmationName.trim() === "") {
        invalidForm("Type the exact current beverage name to confirm permanent deletion.");
      }
      const reason = nullable(form.reason);
      dependencies.beverageService.deleteBeverage(
        params.id!,
        {
          confirmationName: form.confirmationName,
          ...(reason === undefined ? {} : { reason }),
        },
        actor(context),
      );
    },
    "Beverage deleted.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/sensory",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      const sensory = sensoryOverridesFromForm(form);
      dependencies.beverageService.updateSensoryOverrides(
        params.id!,
        sensory ?? {},
        actor(context),
      );
    },
    "Sensory guidance saved.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/recipe",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      dependencies.beverageService.updateCustomBeverage(
        params.id!,
        { recipe: recipeFromForm(form) },
        actor(context),
      );
    },
    "Custom recipe saved.",
    { maxFields: 3, maxBytes: 3_000_000 },
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/unlink",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (_form, context, params) => {
      dependencies.beverageService.unlinkBeverage(params.id!, actor(context));
    },
    "Beverage unlinked from Brewfather and retained as a Custom Beverage.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/brewfather/link",
    "/admin/beverages",
    (form, context) => {
      const linked = dependencies.beverageService.linkBrewfatherCandidate(
        { sourceBatchId: form.sourceBatchId },
        actor(context),
      );
      return `/admin/beverages/${linked.beverage.id}`;
    },
    "Brewfather batch linked.",
  );
}

export function listQueryFromRequest(request: IncomingMessage): {
  readonly q: string;
  readonly page: number;
} {
  const params = requestUrl(request).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 80);
  const parsedPage = Number(params.get("page") ?? "1");
  return {
    q,
    page:
      Number.isInteger(parsedPage) && Number.isFinite(parsedPage)
        ? Math.min(10_000, Math.max(1, parsedPage))
        : 1,
  };
}

export function beveragePageHref(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query.length > 0) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded.length === 0 ? "/admin/beverages" : `/admin/beverages?${encoded}`;
}

export const AUTOSAVE_BEVERAGE_FIELDS = [
  "name",
  "beverageType",
  "style",
  "abv",
  "ibu",
  "og",
  "fg",
  "srm",
  "displayColor",
  "description",
  "fillGlass",
] as const;

export function customBeverageAutosaveInput(
  body: Readonly<Record<string, unknown>>,
): UpdateCustomBeverageInput {
  const values = autosaveFieldStrings(body, AUTOSAVE_BEVERAGE_FIELDS);
  return {
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.beverageType === undefined
      ? {}
      : {
          beverageType: values.beverageType as NonNullable<
            UpdateCustomBeverageInput["beverageType"]
          >,
        }),
    ...(values.style === undefined ? {} : { style: nullable(values.style)! }),
    ...(values.abv === undefined ? {} : { abv: optionalNumber(values.abv) ?? null }),
    ...(values.ibu === undefined ? {} : { ibu: optionalNumber(values.ibu) ?? null }),
    ...(values.og === undefined ? {} : { og: optionalNumber(values.og) ?? null }),
    ...(values.fg === undefined ? {} : { fg: optionalNumber(values.fg) ?? null }),
    ...(values.srm === undefined ? {} : { srm: optionalNumber(values.srm) ?? null }),
    ...(values.displayColor === undefined ? {} : { displayColor: nullable(values.displayColor)! }),
    ...(values.description === undefined ? {} : { description: nullable(values.description)! }),
    ...(values.fillGlass === undefined ? {} : { fillGlass: vesselFromForm(values.fillGlass)! }),
  };
}

export function safeBeverageCurrent(
  detail: BeverageDetailResult,
): Readonly<Record<string, unknown>> {
  return {
    name: detail.effectivePresentation.name,
    beverageType: detail.effectivePresentation.beverageType,
    style: detail.effectivePresentation.style,
    abv: detail.effectivePresentation.abv,
    ibu: detail.effectivePresentation.ibu,
    og: detail.effectivePresentation.og,
    fg: detail.effectivePresentation.fg,
    srm: detail.effectivePresentation.srm,
    displayColor: detail.effectivePresentation.displayColor,
    description: detail.effectivePresentation.description,
    fillGlass: detail.effectivePresentation.fillGlass,
    updatedAt: detail.beverage.updatedAt,
  };
}

export function safeCustomBeverageResource(
  detail: BeverageDetailResult,
): Readonly<Record<string, unknown>> {
  return {
    name: detail.effectivePresentation.name,
    beverageType: detail.effectivePresentation.beverageType,
    style: detail.effectivePresentation.style ?? "",
    abv: detail.effectivePresentation.abv ?? "",
    ibu: detail.effectivePresentation.ibu ?? "",
    og: detail.effectivePresentation.og ?? "",
    fg: detail.effectivePresentation.fg ?? "",
    srm: detail.effectivePresentation.srm ?? "",
    displayColor: detail.effectivePresentation.displayColor ?? "",
    description: detail.effectivePresentation.description ?? "",
    fillGlass: detail.effectivePresentation.fillGlass ?? "",
  };
}

export function safeBrewfatherResource(
  detail: BeverageDetailResult,
): Readonly<Record<string, unknown>> {
  const overrides = detail.presentationOverrides;
  const effective = detail.effectivePresentation;
  const fields = [
    ["name", "Name"],
    ["beverageType", "Beverage type"],
    ["style", "Style"],
    ["abv", "ABV"],
    ["ibu", "IBU"],
    ["og", "OG"],
    ["fg", "FG"],
    ["srm", "SRM"],
    ["displayColor", "Display color"],
    ["description", "Description"],
    ["fillGlass", "Fill Glass"],
  ] as const;
  const result: Record<string, unknown> = {};
  for (const [field] of fields) {
    const capitalized = `${field[0]!.toUpperCase()}${field.slice(1)}`;
    const present = Boolean(overrides?.[`override${capitalized}Present` as keyof typeof overrides]);
    const overrideValue = overrides?.[field as keyof typeof overrides];
    const canClear = field !== "name" && field !== "beverageType";
    const value = effective[field as keyof typeof effective];
    result[`${field}Mode`] = !present
      ? "inherit"
      : canClear && overrideValue === null
        ? "clear"
        : "value";
    result[field] = value ?? "";
  }
  return result;
}
