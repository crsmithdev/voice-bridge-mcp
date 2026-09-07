/**
 * Runs manifest commands. An immediate run waits for exit and returns the
 * output; a background run returns a job id and the output accumulates in
 * `<jobsDir>/<project>/<id>.log` beside a `.json` status file, so a job
 * outlives the process that started it and can still be read after a restart.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type JobStatus = "running" | "done" | "failed" | "lost";
export type JobRecord = { id: string; project: string; tool: string; argv: string[]; started_at: string; ended_at: string | null; status: JobStatus; exit_code: number | null };

const OUTPUT_CAP = 40_000;

/** The tail of an output, with a note when the head was cut. */
export function tail(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return `[first ${text.length - cap} characters omitted]\n…${text.slice(-cap)}`;
}

function jobId(tool: string): string {
  const letters = "abcdefghijkmnpqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 4; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return `${tool}-${s}`;
}

export class Jobs {
  private live = new Map<string, { record: JobRecord; output: string }>();

  constructor(public dir: string) { mkdirSync(dir, { recursive: true }); }

  /** Run to completion; the result is the combined output, plus the exit code when it is not zero. */
  async run(cwd: string, argv: string[], timeoutSeconds: number, env: Record<string, string>): Promise<{ output: string; exit_code: number; timed_out: boolean }> {
    const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutSeconds * 1000);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exit = await proc.exited;
    clearTimeout(timer);
    return { output: tail(joinStreams(out, err)), exit_code: exit, timed_out: timedOut };
  }

  /** Start and return at once. */
  start(project: string, tool: string, cwd: string, argv: string[], env: Record<string, string>): JobRecord {
    const id = jobId(tool);
    const record: JobRecord = { id, project, tool, argv, started_at: new Date().toISOString(), ended_at: null, status: "running", exit_code: null };
    const entry = { record, output: "" };
    this.live.set(key(project, id), entry);
    this.persist(entry);
    const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) { entry.output += dec.decode(chunk, { stream: true }); this.persist(entry); }
    };
    Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]).then(([, , exit]) => {
      record.exit_code = exit; record.status = exit === 0 ? "done" : "failed"; record.ended_at = new Date().toISOString();
      this.persist(entry);
    });
    return record;
  }

  get(project: string, id: string): { record: JobRecord; output: string } | null {
    const hit = this.live.get(key(project, id));
    if (hit) return hit;
    const base = join(this.dir, project, id);
    if (!existsSync(`${base}.json`)) return null;
    const record = JSON.parse(readFileSync(`${base}.json`, "utf8")) as JobRecord;
    // a job that was running when the previous server process ended has no one to finish it
    if (record.status === "running") record.status = "lost";
    return { record, output: existsSync(`${base}.log`) ? readFileSync(`${base}.log`, "utf8") : "" };
  }

  list(project: string): JobRecord[] {
    const dir = join(this.dir, project);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => this.get(project, f.replace(/\.json$/, ""))!.record)
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  private persist(entry: { record: JobRecord; output: string }) {
    const dir = join(this.dir, entry.record.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${entry.record.id}.json`), JSON.stringify(entry.record, null, 2));
    writeFileSync(join(dir, `${entry.record.id}.log`), entry.output);
  }
}

function key(project: string, id: string) { return `${project}/${id}`; }

function joinStreams(out: string, err: string): string {
  if (!err.trim()) return out;
  if (!out.trim()) return err;
  return `${out}\n[stderr]\n${err}`;
}
