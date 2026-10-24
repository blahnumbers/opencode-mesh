// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Hermetic service-state isolation.
// v2 delivery discovers the live port and password from the OpenCode service
// file. On a developer machine that file exists, which would make every
// "no credential configured" assertion machine-dependent. Point discovery at
// a per-file temp path unless a test opts in to its own fixture.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OPENCODE_MESH_SERVICE_STATE) {
  process.env.OPENCODE_MESH_SERVICE_STATE = join(
    mkdtempSync(join(tmpdir(), "mesh-service-state-")),
    "service.json",
  );
}
