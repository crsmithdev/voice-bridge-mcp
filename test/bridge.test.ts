import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgv, inputShape, parseManifest } from "../src/manifest.ts";
import { Jobs } from "../src/jobs.ts";
import { createServer, parseProjects } from "../src/server.ts";

const MANIFEST = `
description = "a fixture"

[tools.echo]
description = "echo the arguments"
command = ["echo"]
[tools.echo.args.words]
position = 1
variadic = true
required = true
[tools.echo.args.upper]
type = "boolean"
flag = "-n"

[tools.slow]
description = "sleep then print"
command = ["sh", "-c", "sleep 1; echo woke; exit 3"]
background = true

[tools.fail]
description = "exit nonzero"
command = ["sh", "-c", "echo bad >&2; exit 2"]

[tools.hang]
description = "never returns"
command = ["sleep", "30"]
timeout = 1
`;

describe("manifest", () => {
  test("parses and shapes", () => {
    const m = parseManifest(MANIFEST);
    expect(Object.keys(m.tools)).toEqual(["echo", "slow", "fail", "hang"]);
    const shape = inputShape(m.tools.echo!);
    expect(Object.keys(shape)).toEqual(["words", "upper"]);
    expect(buildArgv(m.tools.echo!, { words: ["a", "b"], upper: true })).toEqual(["echo", "a", "b", "-n"]);
    expect(buildArgv(m.tools.echo!, { words: ["a"], upper: false })).toEqual(["echo", "a"]);
    expect(() => buildArgv(m.tools.echo!, {})).toThrow("words is required");
  });
  test("rejects bad shapes", () => {
    expect(() => parseManifest(`[tools.x]\ndescription="d"\ncommand=[]`)).toThrow("non-empty");
    expect(() => parseManifest(`[tools.x]\ndescription="d"\ncommand=["a"]\n[tools.x.args.y]\nflag="-y"\nposition=1`)).toThrow("exactly one");
    expect(() => parseManifest(`[tools.x]\ndescription="d"\ncommand=["a"]\n[tools.x.args.y]\nposition=1\nvariadic=true\n[tools.x.args.z]\nposition=2`)).toThrow("last positional");
  });
  test("a later positional needs the earlier one", () => {
    const m = parseManifest(`[tools.g]\ndescription="d"\ncommand=["g"]\n[tools.g.args.a]\nposition=1\n[tools.g.args.b]\nposition=2`);
    expect(() => buildArgv(m.tools.g!, { b: "x" })).toThrow("b needs a");
  });
});

describe("server", () => {
  let base: string, url: string, server: ReturnType<typeof createServer>;
  const rpc = async (method: string, params: any = {}, id = 1) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data:"));
    return { status: res.status, body: data ? JSON.parse(data.slice(5)) : text ? JSON.parse(text) : null };
  };
  const call = async (name: string, args: any = {}) => (await rpc("tools/call", { name, arguments: args })).body.result;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "vbm-"));
    mkdirSync(join(base, "proj"));
    writeFileSync(join(base, "proj", "mcp.toml"), MANIFEST);
    const projects = parseProjects(`[fixture]\ndir = "${join(base, "proj")}"\ntoken = "0123456789abcdef0123"`);
    server = createServer(projects, new Jobs(join(base, "jobs")), { port: 0 });
    url = `http://127.0.0.1:${server.port}/fixture/mcp/0123456789abcdef0123`;
  });
  afterAll(() => server.stop(true));

  test("wrong token and unknown project are 404", async () => {
    expect((await fetch(url.replace(/0123$/, "0000"), { method: "POST" })).status).toBe(404);
    expect((await fetch(url.replace("/fixture/", "/nope/"), { method: "POST" })).status).toBe(404);
  });
  test("lists manifest tools plus job and jobs", async () => {
    const r = await rpc("tools/list");
    expect(r.body.result.tools.map((t: any) => t.name).sort()).toEqual(["echo", "fail", "hang", "job", "jobs", "slow"]);
    expect(r.body.result.tools.find((t: any) => t.name === "slow").description).toContain("background");
  });
  test("immediate tool returns output", async () => {
    const r = await call("echo", { words: ["hello", "there"] });
    expect(r.content[0].text.trim()).toBe("hello there");
  });
  test("nonzero exit and timeout are errors with output", async () => {
    const f = await call("fail");
    expect(f.isError).toBe(true); expect(f.content[0].text).toContain("code 2"); expect(f.content[0].text).toContain("bad");
    const h = await call("hang");
    expect(h.isError).toBe(true); expect(h.content[0].text).toContain("did not finish");
  });
  test("background tool returns a job that finishes", async () => {
    const s = await call("slow");
    const id = s.content[0].text.match(/job (slow-[a-z]{4})/)![1]!;
    const running = await call("job", { id });
    expect(running.content[0].text).toContain("running");
    await Bun.sleep(1500);
    const done = await call("job", { id });
    expect(done.content[0].text).toContain("failed with exit code 3");
    expect(done.content[0].text).toContain("woke");
    const list = await call("jobs");
    expect(list.content[0].text).toContain(id);
    // a fresh Jobs over the same directory reads it from disk
    const cold = new Jobs(join(base, "jobs")).get("fixture", id)!;
    expect(cold.record.status).toBe("failed"); expect(cold.output).toContain("woke");
  });
});
