#!/usr/bin/env node

import process from "node:process";

import { runCommand, type PreflightPlan } from "./command.js";

const result = await runCommand(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  now: () => new Date(),
  execute: async (_plan: PreflightPlan) => {
    throw new Error(
      "Search Console snapshot retrieval is not available in this build",
    );
  },
});

if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
