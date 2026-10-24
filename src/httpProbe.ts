// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// v1 probe classification.
// OpenCode v2 answers unknown v1 routes with the web SPA shell: HTTP 200 and
// content-type text/html. A bare `res.ok` therefore reads a healthy v2 server
// as a healthy v1 server, and the next POST to prompt_async dies with 405.
// Probes keep the optimistic default (mock/older hosts may omit headers) and
// only demote an explicit HTML answer, so v1 behavior stays byte-identical.
export function isSpaShellResponse(res: Response): boolean {
  try {
    const headers = (res as { headers?: { get?: (name: string) => string | null } }).headers;
    const contentType =
      typeof headers?.get === "function" ? headers.get("content-type") : null;
    return typeof contentType === "string" && contentType.toLowerCase().includes("text/html");
  } catch {
    return false;
  }
}

/** v1 route answered successfully: ok and not the v2 SPA shell. */
export function isV1StatusResponse(res: Response): boolean {
  return res.ok && !isSpaShellResponse(res);
}
