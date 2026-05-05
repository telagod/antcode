import blessed from "blessed";
import fs from "node:fs";
import { Attempt, MutationEvent, RewardBundle, StrategyGenome, StrategyPheromone, NegativePheromone } from "../types";
import { readJsonl, antcodePath } from "../storage";
import { samplingTable } from "../sampler";

interface DashboardState {
  iteration: number;
  totalIterations: number;
  genomes: StrategyGenome[];
  attempts: Attempt[];
  rewards: RewardBundle[];
  mutations: MutationEvent[];
  positives: StrategyPheromone[];
  negatives: NegativePheromone[];
  running: boolean;
  mode: string;
}

export function startDashboard(root: string, totalIterations: number, mode: string): { stop: () => void; screen: blessed.Widgets.Screen } {
  const screen = blessed.screen({
    smartCSR: true,
    title: "AntCode Evolution Dashboard v0.8.3",
  });

  // ── Header ──
  const header = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    style: { fg: "white", bg: "blue" },
    content: "",
  });

  // ── Genome list (left) ──
  const genomeBox = blessed.list({
    top: 3,
    left: 0,
    width: "50%",
    height: "40%",
    label: " {bold}Active Genomes{/bold} ",
    border: { type: "line" },
    style: { border: { fg: "cyan" }, selected: { bg: "blue" } },
    keys: true,
    interactive: false,
    tags: true,
  });

  // ── Reward curve (right-top) ──
  const rewardBox = blessed.box({
    top: 3,
    left: "50%",
    width: "50%",
    height: "40%",
    label: " {bold}Reward Curve (last 40){/bold} ",
    border: { type: "line" },
    style: { border: { fg: "green" } },
    tags: true,
  });

  // ── Slot / mutation log (bottom-left) ──
  const slotBox = blessed.log({
    top: "43%",
    left: 0,
    width: "50%",
    height: "57%",
    label: " {bold}Mutation Log{/bold} ",
    border: { type: "line" },
    style: { border: { fg: "yellow" } },
    scrollable: true,
    alwaysScroll: true,
    tags: true,
  });

  // ── Sampling probabilities (bottom-right) ──
  const sampleBox = blessed.box({
    top: "43%",
    left: "50%",
    width: "50%",
    height: "57%",
    label: " {bold}Sampling Probabilities{/bold} ",
    border: { type: "line" },
    style: { border: { fg: "magenta" } },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
  });

  screen.append(header);
  screen.append(genomeBox);
  screen.append(rewardBox);
  screen.append(slotBox);
  screen.append(sampleBox);

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  let lastMutationCount = 0;
  const state: DashboardState = {
    iteration: 0,
    totalIterations,
    genomes: [],
    attempts: [],
    rewards: [],
    mutations: [],
    positives: [],
    negatives: [],
    running: true,
    mode,
  };

  function loadData(): void {
    try {
      state.genomes = readJsonl<StrategyGenome>(antcodePath(root, "strategy-genomes.jsonl"));
      state.attempts = readJsonl<Attempt>(antcodePath(root, "attempts.jsonl"));
      state.rewards = readJsonl<RewardBundle>(antcodePath(root, "reward-bundles.jsonl"));
      state.mutations = readJsonl<MutationEvent>(antcodePath(root, "mutation-events.jsonl"));
      state.positives = readJsonl<StrategyPheromone>(antcodePath(root, "strategy-pheromones.jsonl"));
      state.negatives = readJsonl<NegativePheromone>(antcodePath(root, "negative-pheromones.jsonl"));
      state.iteration = state.attempts.length;
    } catch {
      // ignore read errors during experiment
    }
  }

  function renderHeader(): void {
    const pct = state.totalIterations > 0 ? Math.min(100, Math.round((state.iteration / state.totalIterations) * 100)) : 0;
    const filled = Math.max(0, Math.min(20, Math.floor(pct / 5)));
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    header.setContent(
      ` {center}{bold}AntCode v0.8.3{/bold} | ${state.mode} | Iteration ${state.iteration}/${state.totalIterations} [${bar}] ${pct}%{/center}`,
    );
  }

  function renderGenomes(): void {
    const active = state.genomes
      .filter((g) => g.status === "active" || g.status === "candidate")
      .slice(-20);
    const rewardMap = new Map<string, number>();
    for (const r of state.rewards) {
      const prev = rewardMap.get(r.strategy_genome_id) ?? 0;
      rewardMap.set(r.strategy_genome_id, prev + r.reward);
    }
    const lines = active.map((g) => {
      const total = rewardMap.get(g.id) ?? 0;
      const count = state.rewards.filter((r) => r.strategy_genome_id === g.id).length;
      const avg = count > 0 ? (total / count).toFixed(3) : "-.---";
      const color = g.status === "active" ? "green" : "yellow";
      return ` {${color}-fg}${g.id.slice(0, 35).padEnd(35)}{/} ${g.status.padEnd(10)} avg=${avg}`;
    });
    genomeBox.setItems(lines.length ? lines : [" No active genomes yet..."]);
  }

  function renderRewardCurve(): void {
    const recent = state.rewards.slice(-40);
    if (recent.length === 0) {
      rewardBox.setContent(" Awaiting rewards...");
      return;
    }
    const maxR = Math.max(...recent.map((r) => r.reward), 0.01);
    const rows = 8;
    const cols = recent.length;
    const lines: string[] = [];
    for (let row = rows; row >= 0; row--) {
      const threshold = (row / rows) * maxR;
      let line = row === 0 ? "+" : "|";
      for (let c = 0; c < cols; c++) {
        const r = recent[c].reward;
        line += r >= threshold ? (r >= threshold + maxR / rows / 2 ? "█" : "▓") : " ";
      }
      lines.push(line);
    }
    rewardBox.setContent(lines.join("\n"));
  }

  function renderMutations(): void {
    if (state.mutations.length > lastMutationCount) {
      const newItems = state.mutations.slice(lastMutationCount);
      for (const m of newItems) {
        const color = m.status === "candidate" ? "yellow" : m.status === "quarantined" ? "red" : "green";
        slotBox.log(
          ` [{${color}-fg}${m.id}{/}] ${m.parent_strategy} → ${m.child_strategy} | ${m.mutation.type} | ${m.triggered_by.failure_mode}`,
        );
      }
      lastMutationCount = state.mutations.length;
    }
  }

  function renderSampling(): void {
    if (state.genomes.length === 0 || state.positives.length === 0) {
      sampleBox.setContent(" Awaiting sampling data...");
      return;
    }
    // Pick first experience key for demo
    const goals = [...new Set(state.genomes.map((g) => g.applies_to.goal_pattern))];
    const goal = goals[0] ?? "add_cli_command";
    const table = samplingTable(
      state.genomes,
      {
        goal_pattern: goal,
        module_region: "src/cli.ts",
        context_shape: ["medium"],
        risk_level: "medium",
      },
      state.positives,
      state.negatives,
    );
    const lines = table.map((row) => {
      const barLen = Math.round(row.probability * 20);
      const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
      const color = row.status === "active" ? "green" : row.status === "candidate" ? "yellow" : "red";
      return ` {${color}-fg}${row.id.slice(0, 30).padEnd(30)}{/} ${(row.probability * 100).toFixed(1).padStart(5)}% [${bar}]`;
    });
    sampleBox.setContent(lines.join("\n"));
  }

  function tick(): void {
    if (!state.running) return;
    loadData();
    renderHeader();
    renderGenomes();
    renderRewardCurve();
    renderMutations();
    renderSampling();
    screen.render();
    setTimeout(tick, 2000);
  }

  // Kick off
  tick();

  return {
    stop: () => {
      state.running = false;
      try { screen.destroy(); } catch {}
    },
    screen,
  };
}
