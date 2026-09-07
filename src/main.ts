#!/usr/bin/env bun
/**
 * voice-bridge-mcp serve [--port 3000] [--projects ~/.voice-bridge-mcp/projects.toml] [--jobs ~/.voice-bridge-mcp/jobs]
 * voice-bridge-mcp token                      print a fresh token for projects.toml
 * voice-bridge-mcp check <dir>                validate the mcp.toml in a project directory and list its tools
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, parseProjects } from "./server.ts";
import { Jobs } from "./jobs.ts";
import { parseManifest } from "./manifest.ts";

const HOME = process.env.HOME ?? ".";
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "serve": {
    const { values } = parseArgs({ args: rest, options: { port: { type: "string", default: "3000" }, projects: { type: "string", default: join(HOME, ".voice-bridge-mcp", "projects.toml") }, jobs: { type: "string", default: join(HOME, ".voice-bridge-mcp", "jobs") } } });
    const projects = parseProjects(readFileSync(values.projects, "utf8"), values.projects);
    const server = createServer(projects, new Jobs(values.jobs), { port: Number(values.port) });
    console.log(`voice-bridge-mcp on http://${server.hostname}:${server.port}  projects: ${Object.keys(projects).join(", ")}`);
    break;
  }
  case "token":
    console.log(randomBytes(24).toString("base64url"));
    break;
  case "check": {
    const dir = rest[0];
    if (!dir) { console.error("usage: voice-bridge-mcp check <dir>"); process.exit(1); }
    const path = join(dir, "mcp.toml");
    const m = parseManifest(readFileSync(path, "utf8"), path);
    for (const [name, t] of Object.entries(m.tools)) console.log(`${name.padEnd(14)} ${t.background ? "background " : "immediate  "} ${t.command.join(" ")}  [${Object.keys(t.args ?? {}).join(", ")}]`);
    break;
  }
  default:
    console.error("usage: voice-bridge-mcp serve [--port N] [--projects FILE] [--jobs DIR] | token | check <dir>");
    process.exit(cmd ? 1 : 0);
}
