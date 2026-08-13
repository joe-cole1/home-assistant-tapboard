import { fileURLToPath } from "node:url";

import { Eta } from "eta";

export interface Renderer {
  render(view: string, data: Readonly<Record<string, unknown>>): string;
}

export interface CreateRendererOptions {
  readonly viewsRoot?: string;
}

export const DEFAULT_VIEWS_ROOT = fileURLToPath(new URL("../../../views/", import.meta.url));

export function createRenderer(options: CreateRendererOptions = {}): Renderer {
  const eta = new Eta({
    views: options.viewsRoot ?? DEFAULT_VIEWS_ROOT,
    autoEscape: true,
    cache: false,
  });

  return {
    render(view, data) {
      return eta.render(view, { ...data });
    },
  };
}
