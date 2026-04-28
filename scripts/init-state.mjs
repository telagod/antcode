#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const seedDir = path.join(root, "examples", "state", "v0.7.0");
const stateDir = path.join(root, ".antcode");
const force = process.argv.includes("--force");

if (!fs.existsSync(seedDir)) {
  console.error(`Seed state not found: ${seedDir}`);
  process.exit(1);
}

if (fs.existsSync(stateDir) && !force) {
  console.log(".antcode already exists. Use `npm run init-state -- --force` to overwrite it.");
  process.exit(0);
}

if (fs.existsSync(stateDir)) {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

fs.cpSync(seedDir, stateDir, { recursive: true });
console.log(`Initialized .antcode state from ${path.relative(root, seedDir)}`);
