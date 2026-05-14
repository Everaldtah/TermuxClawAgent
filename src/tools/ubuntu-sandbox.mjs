/**
 * ubuntu-sandbox.mjs — on-demand Ubuntu sandbox execution.
 *
 * The Vercel runtime (`shell_exec`) is Amazon Linux 2 with no apt, no
 * persistent state, and a 300s function ceiling. For anything that needs
 * a full Ubuntu (apt installs, longer jobs, system services), the agent
 * uses ubuntu_exec, which dispatches to a configured provider:
 *
 *   UBUNTU_SANDBOX_PROVIDER=e2b      → E2B sandbox via the `e2b` npm SDK
 *                                      requires: E2B_API_KEY
 *
 *   UBUNTU_SANDBOX_PROVIDER=remote   → generic HTTP bridge — POST {cmd}
 *                                      returns {stdout, stderr, exit_code}
 *                                      requires: UBUNTU_BRIDGE_URL
 *                                      optional: UBUNTU_BRIDGE_TOKEN
 *
 * If no provider is configured we surface an actionable error rather than
 * silently falling back to Vercel's shell_exec — the agent should know it
 * needs a real Ubuntu host to do what it asked for.
 *
 * Sandboxes are reused per warm Vercel function instance (module-level cache)
 * so multiple ubuntu_exec calls in the same run only pay the cold-start once.
 */

const PROVIDER     = (process.env.UBUNTU_SANDBOX_PROVIDER || "").trim().toLowerCase();
const E2B_API_KEY  = process.env.E2B_API_KEY || "";
const BRIDGE_URL   = process.env.UBUNTU_BRIDGE_URL   || "";
const BRIDGE_TOKEN = process.env.UBUNTU_BRIDGE_TOKEN || "";

let _e2bSandbox = null;  // cached per warm instance

export function ubuntuSandboxAvailable() {
  if (PROVIDER === "e2b")    return Boolean(E2B_API_KEY);
  if (PROVIDER === "remote") return Boolean(BRIDGE_URL);
  // Auto-detect when PROVIDER not set
  if (E2B_API_KEY) return true;
  if (BRIDGE_URL)  return true;
  return false;
}

export function ubuntuSandboxBackend() {
  if (PROVIDER === "e2b")    return "e2b";
  if (PROVIDER === "remote") return "remote";
  if (E2B_API_KEY) return "e2b";
  if (BRIDGE_URL)  return "remote";
  return "unconfigured";
}

// ── E2B backend ───────────────────────────────────────────────────────────────

async function getE2BSandbox() {
  if (_e2bSandbox) return _e2bSandbox;
  // Dynamic import so the cloud function only loads the SDK when actually used.
  const mod = await import("e2b");
  const Sandbox = mod.Sandbox || mod.default?.Sandbox || mod.default;
  _e2bSandbox = await Sandbox.create({ apiKey: E2B_API_KEY });
  return _e2bSandbox;
}

async function execE2B(command, { timeoutMs = 60_000 } = {}) {
  const sbx = await getE2BSandbox();
  // The e2b SDK exposes a commands.run() interface that returns { stdout, stderr, exitCode }
  const result = await sbx.commands.run(command, { timeoutMs });
  return {
    stdout: String(result.stdout ?? "").slice(0, 8000),
    stderr: String(result.stderr ?? "").slice(0, 4000),
    exit_code: result.exitCode ?? 0,
    backend: "e2b",
  };
}

// ── Generic remote-bridge backend ─────────────────────────────────────────────

async function execRemote(command, { timeoutMs = 60_000 } = {}) {
  const url = BRIDGE_URL.replace(/\/+$/, "") + "/run";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs + 5000);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(BRIDGE_TOKEN ? { "X-Bridge-Token": BRIDGE_TOKEN } : {}),
      },
      body: JSON.stringify({ command, timeout_ms: timeoutMs }),
    });
    if (!r.ok) return { error: `bridge HTTP ${r.status}`, backend: "remote" };
    const j = await r.json().catch(() => ({}));
    return {
      stdout: String(j.stdout ?? "").slice(0, 8000),
      stderr: String(j.stderr ?? "").slice(0, 4000),
      exit_code: j.exit_code ?? j.exitCode ?? 0,
      backend: "remote",
    };
  } catch (err) {
    return { error: err.name === "AbortError" ? `bridge timeout ${timeoutMs}ms` : err.message, backend: "remote" };
  } finally {
    clearTimeout(t);
  }
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

export async function ubuntuExec(command, opts = {}) {
  if (!command || typeof command !== "string") return { error: "ubuntu_exec: missing command" };

  const backend = ubuntuSandboxBackend();
  if (backend === "unconfigured") {
    return {
      error:
        "ubuntu_exec not configured. Set UBUNTU_SANDBOX_PROVIDER=e2b + E2B_API_KEY " +
        "in Vercel env (recommended — pay per second), OR set UBUNTU_SANDBOX_PROVIDER=remote " +
        "+ UBUNTU_BRIDGE_URL pointing at any HTTP endpoint that runs commands. " +
        "Fall back to shell_exec if you just need basic Linux tooling.",
    };
  }

  const timeoutMs = Math.min(opts.timeout_ms ?? 60_000, 120_000);

  try {
    if (backend === "e2b")    return await execE2B(command, { timeoutMs });
    if (backend === "remote") return await execRemote(command, { timeoutMs });
    return { error: `unknown backend: ${backend}` };
  } catch (err) {
    // Drop the cached sandbox if it died so the next call recreates it.
    if (backend === "e2b") _e2bSandbox = null;
    return { error: `ubuntu_exec failed: ${err.message}`, backend };
  }
}

// Best-effort cleanup. Vercel may not call this, that's OK — E2B auto-kills
// idle sandboxes after a few minutes.
export async function closeUbuntuSandbox() {
  if (_e2bSandbox) {
    try { await _e2bSandbox.kill?.(); } catch {}
    _e2bSandbox = null;
  }
}
