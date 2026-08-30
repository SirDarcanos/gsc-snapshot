import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let packRoot = "";
let tarball = "";
let packedFiles: string[] = [];

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build"]);
  packRoot = await mkdtemp(path.join(tmpdir(), "gsc-snapshot-contract-pack-"));
  const pack = await execFileAsync("npm", [
    "pack",
    "--silent",
    "--ignore-scripts",
    "--pack-destination",
    packRoot,
  ]);
  tarball = path.join(packRoot, pack.stdout.trim());
  const listing = await execFileAsync("tar", ["-tzf", tarball]);
  packedFiles = listing.stdout.trim().split("\n").sort();
}, 60_000);

afterAll(async () => {
  if (packRoot !== "") {
    await rm(packRoot, { recursive: true, force: true });
  }
});

describe("public package contract", () => {
  it("declares one Node 22 executable and no JavaScript library interface", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));

    expect(manifest).toMatchObject({
      name: "gsc-snapshot",
      license: "MIT",
      repository: {
        type: "git",
        url: "https://github.com/SirDarcanos/gsc-snapshot.git",
      },
      type: "module",
      engines: { node: ">=22" },
      bin: { "gsc-snapshot": "dist/cli.js" },
      exports: {},
    });
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("module");
    expect(manifest).not.toHaveProperty("types");
  });

  it("keeps package identity and runtime dependencies reproducible", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    const lockfile = JSON.parse(await readFile("package-lock.json", "utf8"));

    expect(lockfile.lockfileVersion).toBe(3);
    expect(lockfile.packages[""]).toMatchObject({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      engines: manifest.engines,
      bin: manifest.bin,
      dependencies: manifest.dependencies,
    });
    expect(await readFile("LICENSE", "utf8")).toContain("MIT License");
  });

  it("packs only the documented executable runtime", () => {
    expect(packedFiles).toEqual([
      "package/LICENSE",
      "package/README.md",
      "package/dist/cli.js",
      "package/dist/cli.js.map",
      "package/dist/command.js",
      "package/dist/command.js.map",
      "package/dist/google-runtime.js",
      "package/dist/google-runtime.js.map",
      "package/dist/snapshot.js",
      "package/dist/snapshot.js.map",
      "package/package.json",
    ]);
  });

  it("keeps the packed executable entry point runnable by Node", async () => {
    const source = await readFile("dist/cli.js", "utf8");

    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
