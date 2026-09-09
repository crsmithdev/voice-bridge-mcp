#!/usr/bin/env bun
/**
 * The text round trip (spec 7.2). Voice comes at 7.3; this loop is useful on
 * its own, and it is where the process management gets tested.
 *
 *   bun src/main.ts chat <project-dir>    a spoken conversation, typed
 *   bun src/main.ts config                the settings and where they come from
 */
import { DEFAULTS, configPath, loadConfig, type Config } from "./config.ts";
import { Session } from "./session.ts";

function showConfig(config: Config): void {
  console.log(`config: ${configPath()}`);
  for (const [key, value] of Object.entries(config)) {
    const isDefault = JSON.stringify(value) === JSON.stringify(DEFAULTS[key as keyof Config]);
    console.log(`  ${key} = ${JSON.stringify(value)}${isDefault ? "" : "   (set)"}`);
  }
}

async function chat(dir: string, config: Config): Promise<void> {
  const session = new Session(dir, config, {
    onCheckpoint: (ms) => console.log(`\n[this turn has run ${Math.round(ms / 60_000)} minutes. say "${config.agreementWord}" to let it run]`),
    onInterrupt: (reason) => console.log(`\n[interrupting the turn: ${reason}]`),
    onRestart: (reason) => console.log(`\n[restarting Claude Code: ${reason}]`),
  });
  session.start();
  console.log(`Claude Code in ${dir}, model ${config.model}. Ctrl-D to leave.`);

  for await (const line of console) {
    const text = line.trim();
    if (!text) continue;
    // 8.6.4 the agreement word is heard here in text, and by voice at 7.3
    if (text.toLowerCase() === config.agreementWord.toLowerCase()) { session.agree(); console.log("[continuing]"); continue; }
    try {
      const turn = await session.ask(text);
      console.log(`\n${turn.text}\n`);
      const fraction = session.contextFraction();
      const context = fraction === null ? "" : `, context ${Math.round(fraction * 100)}% of the compaction threshold`;
      console.log(`[turn ${turn.number}, $${session.totalCostUsd().toFixed(4)} this session${context}]`);
    } catch (error) {
      console.log(`\n[${(error as Error).message}]`);
    }
  }
  session.stop();
}

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();

if (command === "config") {
  showConfig(config);
} else if (command === "chat") {
  const dir = rest[0];
  if (!dir) { console.error("usage: bun src/main.ts chat <project-dir>"); process.exit(2); }
  await chat(dir, config);
} else {
  console.error("usage: bun src/main.ts <chat <project-dir> | config>");
  process.exit(2);
}
