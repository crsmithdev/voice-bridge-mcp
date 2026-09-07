/**
 * One HTTP server, one MCP endpoint per project at `/<project>/mcp/<token>`.
 * The token in the path is the only authentication, so the endpoint should
 * sit behind HTTPS (a tunnel). Every request builds a fresh stateless MCP
 * server over the project's manifest, which is re-read on each request so a
 * manifest edit needs no restart.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { buildArgv, inputShape, parseManifest, type Manifest, type ToolSpec } from "./manifest.ts";
import { Jobs, tail, type JobRecord } from "./jobs.ts";

export type Project = { dir: string; token: string; env?: Record<string, string> };
export type Projects = Record<string, Project>;

const DEFAULT_TIMEOUT = 120;

export function parseProjects(text: string, where = "projects.toml"): Projects {
  const raw = Bun.TOML.parse(text) as Record<string, any>;
  const out: Projects = {};
  for (const [name, p] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`${where}: project name ${JSON.stringify(name)} is not a path segment`);
    if (typeof p?.dir !== "string" || !p.dir) throw new Error(`${where}: ${name}.dir is required`);
    if (typeof p?.token !== "string" || p.token.length < 16) throw new Error(`${where}: ${name}.token must be at least 16 characters`);
    out[name] = { dir: p.dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"), token: p.token, env: p.env };
  }
  if (!Object.keys(out).length) throw new Error(`${where}: no projects`);
  return out;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function describeJob(r: JobRecord, output: string): string {
  const head = `job ${r.id} (${r.tool}) ${r.status}${r.exit_code !== null && r.exit_code !== 0 ? ` with exit code ${r.exit_code}` : ""}, started ${r.started_at}${r.ended_at ? `, ended ${r.ended_at}` : ""}`;
  if (r.status === "running") return `${head}. Not finished; ask again in a minute.${output.trim() ? `\n\noutput so far:\n${tail(output, 4000)}` : ""}`;
  if (r.status === "lost") return `${head}. The bridge restarted while it ran, so the end of it was not recorded.\n\n${tail(output)}`;
  return `${head}.\n\n${tail(output)}`;
}

/** The MCP server for one request against one project. */
export function buildMcp(name: string, project: Project, manifest: Manifest, jobs: Jobs): McpServer {
  const server = new McpServer({ name: `voice-bridge-mcp/${name}`, version: "0.1.0" }, { instructions: manifest.description });
  const env = { ...process.env, ...(project.env ?? {}) } as Record<string, string>;
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  for (const [toolName, tool] of Object.entries(manifest.tools)) {
    const description = tool.background ? `${tool.description}\n\nRuns in the background: returns a job id at once. Read the result with the job tool.` : tool.description;
    server.registerTool(toolName, { description, inputSchema: inputShape(tool) }, async (input: Record<string, unknown>) => {
      let argv: string[];
      try { argv = buildArgv(tool, input ?? {}); } catch (e: any) { return { ...text(e.message), isError: true }; }
      if (tool.background) {
        const r = jobs.start(name, toolName, project.dir, argv, env);
        return text(`started job ${r.id}. It runs ${tool.timeout ? `up to ${tool.timeout} seconds` : "for a while"}; read it with the job tool when asked or after a minute or two.`);
      }
      const r = await jobs.run(project.dir, argv, tool.timeout ?? DEFAULT_TIMEOUT, env);
      if (r.timed_out) return { ...text(`${toolName} did not finish within ${tool.timeout ?? DEFAULT_TIMEOUT} seconds.\n\n${r.output}`), isError: true };
      if (r.exit_code !== 0) return { ...text(`${toolName} exited with code ${r.exit_code}.\n\n${r.output}`), isError: true };
      return text(r.output.trim() ? r.output : `${toolName} printed nothing.`);
    });
  }

  server.registerTool("job", { description: "The status and output of a background job started by another tool here. Running jobs report what they have printed so far.", inputSchema: { id: z.string().describe("the job id, e.g. draw-kwpr") } },
    async ({ id }: { id: string }) => {
      const j = jobs.get(name, id);
      if (!j) return { ...text(`no job ${id}`), isError: true };
      return text(describeJob(j.record, j.output));
    });

  server.registerTool("jobs", { description: "Background jobs of this project, newest first, with their status.", inputSchema: {} }, async () => {
    const rows = jobs.list(name);
    return text(rows.length ? rows.map((r) => `${r.id}  ${r.status.padEnd(8)} ${r.started_at}  ${r.argv.join(" ")}`).join("\n") : "no jobs yet");
  });

  return server;
}

export function loadManifest(project: Project): Manifest {
  const path = join(project.dir, "mcp.toml");
  return parseManifest(readFileSync(path, "utf8"), path);
}

export function createServer(projects: Projects, jobs: Jobs, opts: { port: number; hostname?: string }) {
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/([a-z][a-z0-9_-]*)\/mcp\/([^/]+)\/?$/);
      if (!m) return url.pathname === "/" ? new Response("voice-bridge-mcp\n") : new Response("not found\n", { status: 404 });
      const [, name, token] = m;
      const project = projects[name!];
      if (!project || !sameToken(token!, project.token)) return new Response("not found\n", { status: 404 });
      let manifest: Manifest;
      try { manifest = loadManifest(project); } catch (e: any) { return new Response(`manifest error: ${e.message}\n`, { status: 500 }); }
      const server = buildMcp(name!, project, manifest, jobs);
      // JSON responses: the reply is complete when handleRequest returns, so the transport can close at once
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try { return await transport.handleRequest(req); } finally { transport.close().catch(() => {}); }
    },
  });
}
