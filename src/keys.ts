/**
 * The LiveKit keys (spec 12.1).
 *
 * `devkey` and `secret` are what `livekit-server --dev` uses and what every
 * example on the internet uses. Anything reachable from outside this machine
 * needs its own pair, so the bridge makes one the first time it is asked and
 * keeps it in the user's own directory, readable by nobody else.
 *
 * The address the phone will use also lives here, because the server and the
 * bridge have to agree on it: LiveKit advertises the address it believes it
 * has, and inside WSL2 that is one no phone can route to.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

export interface Keys {
  apiKey: string;
  apiSecret: string;
}

export function keysPath(): string {
  return process.env.VOICE_BRIDGE_KEYS ?? join(homedir(), ".voice-bridge", "keys.json");
}

function random(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** Made once, then kept. Losing the file only means pairing the phone again. */
export function loadOrCreateKeys(path = keysPath()): Keys {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Keys>;
    if (parsed.apiKey && parsed.apiSecret) return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
  }
  const keys: Keys = { apiKey: `vb${random(9)}`, apiSecret: random(32) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`);
  chmodSync(path, 0o600);
  return keys;
}

/**
 * The address the phone reaches this machine on. The tailnet address wins when
 * there is one: it is the only one that also works away from the house, which
 * is the point of 14.1. Otherwise the first real address on the machine.
 */
export function advertiseHost(): string {
  const tailscale = Bun.spawnSync(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "ignore" });
  const address = tailscale.exitCode === 0 ? tailscale.stdout.toString().trim().split("\n")[0]?.trim() : "";
  if (address) return address;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

/** The name the tailnet knows this machine by, or "" when there is no tailnet. */
export function tailnetName(): string {
  const status = Bun.spawnSync(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
  if (status.exitCode !== 0) return "";
  try {
    const parsed = JSON.parse(status.stdout.toString()) as { Self?: { DNSName?: string } };
    return (parsed.Self?.DNSName ?? "").replace(/\.$/, "");
  } catch { return ""; }
}

/**
 * A certificate the phone will trust, from the tailnet (12.1).
 *
 * A self-signed pair proves the shape but a phone will refuse the microphone
 * over a certificate it does not trust, so this is not optional in the end.
 * The tailnet issues a real one, once the tailnet has HTTPS turned on.
 */
export function fetchCert(certPath: string, keyPath: string): { ok: boolean; message: string } {
  const name = tailnetName();
  if (!name) return { ok: false, message: "this machine is not on a tailnet: run tailscale up" };
  mkdirSync(dirname(certPath), { recursive: true });
  const run = Bun.spawnSync(["tailscale", "cert", "--cert-file", certPath, "--key-file", keyPath, name], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    const said = `${run.stderr.toString()}${run.stdout.toString()}`.trim();
    if (/does not support getting TLS certs/i.test(said)) {
      return { ok: false, message: "the tailnet does not have HTTPS certificates turned on yet.\nTurn it on at https://login.tailscale.com/admin/dns, then run this again." };
    }
    return { ok: false, message: said || "tailscale cert failed" };
  }
  chmodSync(keyPath, 0o600);
  return { ok: true, message: `${name}: certificate in ${certPath}, key in ${keyPath}` };
}

/** What livekit-server needs so that it and the bridge agree (12.1). */
export function livekitConfig(keys: Keys, host: string, port: number): string {
  return [
    "port: " + port,
    "rtc:",
    "  tcp_port: 7881",
    "  port_range_start: 50000",
    "  port_range_end: 50019",
    // the address the phone will use, not the one the server thinks it has
    `  node_ip: ${host}`,
    "  use_external_ip: false",
    "keys:",
    `  ${keys.apiKey}: ${keys.apiSecret}`,
    "",
  ].join("\n");
}
