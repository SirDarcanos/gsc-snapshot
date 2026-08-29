#!/usr/bin/env node

import process from "node:process";

import { runCommand } from "./command.js";
import { createGoogleServices } from "./google-runtime.js";
import { createSnapshotExecutor } from "./snapshot.js";

const result = await runCommand(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  now: () => new Date(),
  execute: createSnapshotExecutor(createGoogleServices()),
});

if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
