import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
let executable = "";

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build"]);
  const packRoot = await mkdtemp(path.join(tmpdir(), "gsc-snapshot-pack-"));
  const installRoot = await mkdtemp(path.join(tmpdir(), "gsc-snapshot-install-"));
  roots.push(packRoot, installRoot);
  const pack = await execFileAsync("npm", [
    "pack",
    "--silent",
    "--ignore-scripts",
    "--pack-destination",
    packRoot,
  ]);
  const tarball = path.join(packRoot, pack.stdout.trim());
  await writeFile(
    path.join(installRoot, "package.json"),
    JSON.stringify({ private: true }),
  );
  await cp("node_modules", path.join(installRoot, "node_modules"), {
    recursive: true,
  });
  await execFileAsync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--no-save",
      tarball,
    ],
    { cwd: installRoot },
  );
  executable = path.join(installRoot, "node_modules", ".bin", "gsc-snapshot");
}, 60_000);

afterAll(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function consumerRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-snapshot-consumer-"));
  roots.push(root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
  );
  return root;
}

function fixtureEnvironment(cwd: string): NodeJS.ProcessEnv {
  const register = path.resolve("test/fixtures/register-google-runtime.mjs");
  return {
    ...process.env,
    npm_package_json: path.join(cwd, "package.json"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${register}`.trim(),
  };
}

async function spawnCli(
  argv: readonly string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...argv], {
      cwd,
      env: fixtureEnvironment(cwd),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

describe("installed gsc-snapshot executable", () => {
  it("creates a Search Console snapshot and reports success on stdout", async () => {
    const cwd = await consumerRoot();

    const result = await spawnCli(
      [
        "--site",
        "sc-domain:example.com",
        "--start",
        "2026-08-01",
        "--end",
        "2026-08-20",
      ],
      cwd,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Created Search Console snapshot\nInterval: 2026-08-01 to 2026-08-20\nProperty: sc-domain:example.com\nStatus: final\nPath: ${path.join(cwd, "2026-08-01--2026-08-20")}\n`,
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(cwd, "2026-08-01--2026-08-20", "manifest.json"),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      property: "sc-domain:example.com",
      package: { name: "gsc-snapshot", version: "0.0.0" },
      status: "final",
    });
  });

  it("reports invalid input on stderr with a non-zero exit code", async () => {
    const cwd = await consumerRoot();

    const failure = await spawnCli(["--url", "example.com"], cwd);

    expect(failure.exitCode).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toBe("Error: Unsupported argument: --url\n");
  });
});
