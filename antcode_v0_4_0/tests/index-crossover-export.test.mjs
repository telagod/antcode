import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

assert.match(
  indexSource,
  /export \* from ["']\.\/crossover["'];/,
  "src/index.ts should re-export ./crossover so consumers can import crossover and CrossoverResult from the package entrypoint",
);

console.log("index crossover export is present");
