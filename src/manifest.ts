/**
 * A project's manifest (`mcp.toml` in the project directory) declares the
 * tools the bridge exposes and the command each one runs. Nothing outside the
 * manifest is ever executed.
 *
 *   description = "instructions the model reads before using the tools"
 *
 *   [tools.status]
 *   description = "what the tool does"
 *   command = ["./fogbelt", "status"]     # argv, run in the project directory
 *   background = false                    # true: return a job id at once
 *   timeout = 120                         # seconds, immediate tools only
 *
 *   [tools.status.args.genre]             # each argument is a flag or a positional
 *   description = "horror or scifi"
 *   type = "string"                       # string | number | boolean
 *   enum = ["horror", "scifi"]
 *   flag = "--genre"                      # emitted as `--genre <value>`; a true boolean emits the bare flag
 *   position = 1                          # or: the nth positional after the command
 *   variadic = true                       # a positional that takes a list
 *   required = true
 */
import { z, type ZodTypeAny } from "zod";

export type ArgSpec = {
  description?: string;
  type?: "string" | "number" | "boolean";
  enum?: string[];
  flag?: string;
  position?: number;
  variadic?: boolean;
  required?: boolean;
};

export type ToolSpec = {
  description: string;
  command: string[];
  background?: boolean;
  timeout?: number;
  args?: Record<string, ArgSpec>;
};

export type Manifest = { description?: string; tools: Record<string, ToolSpec> };

const NAME = /^[a-z][a-z0-9_-]*$/;

export function parseManifest(text: string, where = "mcp.toml"): Manifest {
  const raw = Bun.TOML.parse(text) as any;
  const tools = raw?.tools;
  if (!tools || typeof tools !== "object" || !Object.keys(tools).length) throw new Error(`${where}: no [tools.*] tables`);
  for (const [name, t] of Object.entries<any>(tools)) {
    if (!NAME.test(name)) throw new Error(`${where}: tool name ${JSON.stringify(name)} must match ${NAME}`);
    if (typeof t.description !== "string" || !t.description) throw new Error(`${where}: tools.${name} needs a description`);
    if (!Array.isArray(t.command) || !t.command.length || t.command.some((c: unknown) => typeof c !== "string")) throw new Error(`${where}: tools.${name}.command must be a non-empty array of strings`);
    const positions = new Set<number>();
    for (const [arg, a] of Object.entries<any>(t.args ?? {})) {
      if (!NAME.test(arg)) throw new Error(`${where}: argument name ${JSON.stringify(arg)} on ${name} must match ${NAME}`);
      if (!!a.flag === (a.position !== undefined)) throw new Error(`${where}: tools.${name}.args.${arg} needs exactly one of flag or position`);
      if (a.position !== undefined && (!Number.isInteger(a.position) || a.position < 1)) throw new Error(`${where}: tools.${name}.args.${arg}.position must be a positive integer`);
      if (a.position !== undefined && positions.has(a.position)) throw new Error(`${where}: tools.${name} has two arguments at position ${a.position}`);
      if (a.position !== undefined) positions.add(a.position);
      if (a.variadic && a.position === undefined) throw new Error(`${where}: tools.${name}.args.${arg} is variadic but not positional`);
      if (a.type && !["string", "number", "boolean"].includes(a.type)) throw new Error(`${where}: tools.${name}.args.${arg}.type must be string, number or boolean`);
      if (a.type === "boolean" && a.position !== undefined) throw new Error(`${where}: tools.${name}.args.${arg} is boolean and must be a flag`);
    }
    // a variadic positional must be the last positional, or the list would swallow what follows
    const args = Object.values<any>(t.args ?? {});
    const last = Math.max(0, ...args.map((a) => a.position ?? 0));
    for (const a of args) if (a.variadic && a.position !== last) throw new Error(`${where}: tools.${name}: the variadic argument must be the last positional`);
  }
  return { description: typeof raw.description === "string" ? raw.description : undefined, tools };
}

/** The zod shape the tool advertises to the model. */
export function inputShape(tool: ToolSpec): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, a] of Object.entries(tool.args ?? {})) {
    let s: ZodTypeAny = a.enum ? z.enum(a.enum as [string, ...string[]]) : a.type === "number" ? z.number() : a.type === "boolean" ? z.boolean() : z.string();
    if (a.variadic) s = z.array(s);
    if (a.description) s = s.describe(a.description);
    shape[name] = a.required ? s : s.optional();
  }
  return shape;
}

/** The argv for one call: the command, then positionals in order, then flags. */
export function buildArgv(tool: ToolSpec, input: Record<string, unknown>): string[] {
  const args = Object.entries(tool.args ?? {});
  const positional = args.filter(([, a]) => a.position !== undefined).sort(([, a], [, b]) => a.position! - b.position!);
  const argv = [...tool.command];
  let stopped: string | null = null;
  for (const [name, a] of positional) {
    const v = input[name];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) { if (a.required) throw new Error(`${name} is required`); stopped = name; continue; }
    if (stopped) throw new Error(`${name} needs ${stopped} too`);
    for (const x of Array.isArray(v) ? v : [v]) argv.push(String(x));
  }
  for (const [name, a] of args) {
    if (a.flag === undefined) continue;
    const v = input[name];
    if (v === undefined || v === null || v === false) { if (a.required) throw new Error(`${name} is required`); continue; }
    if (v === true) { argv.push(a.flag); continue; }
    for (const x of Array.isArray(v) ? v : [v]) argv.push(a.flag, String(x));
  }
  return argv;
}
