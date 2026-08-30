#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

import { runCommand } from "./command.js";
import { createGoogleServices } from "./google-runtime.js";
import { createSnapshotExecutor } from "./snapshot.js";

const require = createRequire(import.meta.url);
const packageIdentity = require("../package.json") as {
  name: string;
  version: string;
};

const result = await runCommand(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  now: () => new Date(),
  execute: createSnapshotExecutor(createGoogleServices(packageIdentity)),
});

if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
