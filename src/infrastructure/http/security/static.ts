import { lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ApplicationError } from "../../../shared/errors.ts";

function pathError(): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "http.invalid_static_path",
    clientMessage: "The requested resource is invalid.",
  });
}

export function decodeContainedPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw pathError();
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw pathError();
  }
  if (decoded.includes("\\") || decoded.includes("\u0000") || !decoded.startsWith("/"))
    throw pathError();
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "..")) throw pathError();
  return decoded;
}

export function isContainedPath(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const remainder = relative(rootResolved, candidateResolved);
  return (
    remainder === "" ||
    (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
  );
}

export function containedStaticPath(root: string, requestPath: string): string {
  const decoded = decodeContainedPath(requestPath);
  const candidate = resolve(root, `.${decoded}`);
  if (!isContainedPath(root, candidate)) throw pathError();
  return candidate;
}

export interface ResolveContainedPathOptions {
  readonly allowSymlink?: boolean;
}

export async function resolveContainedPath(
  root: string,
  requestPath: string,
  options: ResolveContainedPathOptions = {},
): Promise<string> {
  const candidate = containedStaticPath(root, requestPath);
  try {
    const rootReal = await realpath(root);
    const candidateReal = await realpath(candidate);
    if (!isContainedPath(rootReal, candidateReal)) throw pathError();
    if (options.allowSymlink !== true) {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw pathError();
    }
    return candidateReal;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw pathError();
  }
}

export function resolveContainedPathSync(
  root: string,
  requestPath: string,
  options: ResolveContainedPathOptions = {},
): string {
  const candidate = containedStaticPath(root, requestPath);
  try {
    const rootReal = realpathSync(root);
    const candidateReal = realpathSync(candidate);
    if (!isContainedPath(rootReal, candidateReal)) throw pathError();
    if (options.allowSymlink !== true && lstatSync(candidate).isSymbolicLink()) throw pathError();
    return candidateReal;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw pathError();
  }
}

export const safeStaticPath = containedStaticPath;
