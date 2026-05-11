// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
import type {
  PluginAPI,
  ToolCallEvent,
  ToolResultEvent,
  AgentEndEvent,
  AgentStartEvent,
  SessionStartEvent,
} from "@ampcode/plugin";
// We deliberately use Bun's shell directly instead of `amp.$` / `ctx.$`.
// The PluginAPI shell wrapper does NOT auto-escape interpolated values, so
// strings containing whitespace (e.g. multi-word notification titles) get
// word-split into multiple argv elements: `cmux_notify({title: "two words"})`
// gets stored as title="two", body="and stray positional args". It also
// doesn't expose `.nothrow()` / `.text()` from the underlying ShellPromise.
// `Bun.$` properly escapes interpolated values and exposes the full API.
import { $ as bunShell } from "bun";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const STATUS_KEY = "amp";
const LOG_SOURCE = "amp";

// Path cmux reads on relaunch to restore agent sessions.
// See cmux Sources/RestorableAgentSession.swift → RestorableAgentSessionIndex.load
const HOOK_SESSIONS_PATH = join(
  homedir(),
  ".cmuxterm",
  "amp-hook-sessions.json",
);

// Path cmux loads vault agent registrations from (JSONC).
// See cmux Sources/VaultAgentRegistry.swift → CmuxVaultAgentRegistry.load
const CMUX_CONFIG_PATH = join(homedir(), ".config", "cmux", "cmux.json");

// Vault registration that teaches cmux about Amp as a `.custom` RestorableAgentKind.
// Once present, cmux reads HOOK_SESSIONS_PATH on relaunch and runs `amp threads continue <id>`.
const VAULT_REGISTRATION = {
  id: "amp",
  name: "Amp",
  detect: { processName: "amp", argvContains: ["amp"] },
  // sessionIdSource is required by the schema; argvOption is the simplest valid
  // value. cmux's process scanner uses it for live-detection of running amp
  // processes, but the hook-sessions.json path doesn't depend on it.
  sessionIdSource: { type: "argvOption", argvOption: "--thread-id" },
  resumeCommand: "{{executable}} threads continue {{sessionId}}",
  cwd: "preserve",
} as const;

// Short verbs shown in the cmux status bar for each Amp tool.
function toolLabel(tool: string): string {
  switch (tool) {
    case "Read":
      return "reading";
    case "edit_file":
    case "create_file":
      return "editing";
    case "Bash":
      return "running";
    case "Grep":
    case "finder":
    case "glob":
      return "searching";
    case "Task":
      return "subagent";
    case "oracle":
      return "consulting oracle";
    case "web_search":
    case "read_web_page":
      return "browsing";
    case "mermaid":
      return "diagramming";
    case "handoff":
      return "handing off";
    case "skill":
      return "loading skill";
    case "todo_write":
    case "todo_read":
      return "planning";
    default:
      return tool;
  }
}

// SF Symbol names rendered inside the cmux status badge.
function toolIcon(tool: string): string {
  switch (tool) {
    case "Read":
      return "eye";
    case "edit_file":
    case "create_file":
      return "pencil";
    case "Bash":
      return "terminal";
    case "Grep":
    case "finder":
    case "glob":
      return "magnifyingglass";
    case "Task":
      return "person.2";
    case "oracle":
      return "sparkles";
    case "web_search":
    case "read_web_page":
      return "globe";
    case "todo_write":
    case "todo_read":
      return "checklist";
    default:
      return "hammer";
  }
}

const COLOR = {
  idle: "adb5bd",
  thinking: "ffffff",
  active: "ffd700",
  done: "50fa7b",
  error: "ff5555",
  interrupted: "ffb86c",
} as const;

const shortenThreadId = (id: string): string => id.slice(0, 10) + "…";

const basename = (path: string): string => {
  const m = path.match(/[^/]+$/);
  return m ? m[0] : path;
};

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max - 1) + "…" : s;

// Workspace titles the plugin auto-generates: "amp", "T-019d…", or chains like
// "T-019d… →T-abcd…". Anything else is treated as a manual user rename.
const AUTO_TITLE_RE = /^(?:amp|T-[0-9a-f]+…)(?: →T-[0-9a-f]+…)*$/i;

export default function (amp: PluginAPI) {
  // Use Bun's shell, not `amp.$`. See top-of-file comment for the why.
  const $ = bunShell;
  const log = amp.logger;
  const helpers = amp.helpers;

  // Pin every cmux call to the workspace this plugin process was launched in.
  // cmux sets CMUX_WORKSPACE_ID in every pane env, so this is stable across
  // `plugins: reload` and across async callbacks.
  //
  // Without `--workspace`, cmux defaults to whichever pane is *globally
  // focused* at the moment of the call, which can be a different workspace
  // by the time our async handler runs. In setups where the plugin process
  // doesn't inherit a focus context, `cmux notify` and friends then exit
  // non-zero, the empty `try { ... } catch {}` below swallows the throw,
  // and the user sees nothing despite the plugin reporting success.
  const WORKSPACE_REF = process.env.CMUX_WORKSPACE_ID || null;
  const wsArgs = WORKSPACE_REF ? ["--workspace", WORKSPACE_REF] : [];

  // Track the last name we set so we can detect manual renames.
  let lastPluginSetName: string | null = null;

  // Number of tool calls in flight. While > 0 we display the most recent
  // tool's status; when it returns to 0 we flip back to "thinking".
  let inFlightTools = 0;

  const setStatus = async (label: string, icon: string, color: string) => {
    try {
      await $`cmux set-status ${STATUS_KEY} ${label} --icon ${icon} --color ${color} ${wsArgs}`;
    } catch {}
  };

  const clearStatus = async () => {
    try {
      await $`cmux clear-status ${STATUS_KEY} ${wsArgs}`;
    } catch {}
  };

  const wsLog = async (message: string, level: string = "info") => {
    try {
      await $`cmux log --level ${level} --source ${LOG_SOURCE} ${wsArgs} -- ${message}`;
    } catch {}
  };

  const clearLog = async () => {
    try {
      await $`cmux clear-log ${wsArgs}`;
    } catch {}
  };

  const cmuxNotify = async (title: string, body?: string) => {
    try {
      if (body) {
        await $`cmux notify --title ${title} --body ${body} ${wsArgs}`;
      } else {
        await $`cmux notify --title ${title} ${wsArgs}`;
      }
    } catch {}
  };

  const getCurrentWorkspaceName = async (): Promise<string | null> => {
    try {
      // Bun.$ returns a ShellOutput with .stdout as a Buffer. Use .text() to
      // get a string directly.
      const out = await $`cmux list-workspaces`.text();
      const lines = out.split(/\r?\n/);
      // Prefer matching our pinned workspace ref over the [selected] row,
      // since the globally-focused workspace may not be ours.
      if (WORKSPACE_REF) {
        const escaped = WORKSPACE_REF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`^[\\s*]*${escaped}\\s+(.*?)(?:\\s+\\[selected\\])?\\s*$`);
        for (const l of lines) {
          const m = l.match(re);
          if (m) return m[1]?.trim() || null;
        }
      }
      const line = lines.find((l) => /\[selected\]\s*$/.test(l));
      if (!line) return null;
      const match = line.match(/^\*\s+\S+\s{2,}(.*?)\s{2,}\[selected\]\s*$/);
      const name = match?.[1]?.trim();
      return name || null; // treat empty string as no name
    } catch {
      return null;
    }
  };

  // True if the workspace name differs from what the plugin last set and
  // doesn't match the auto-generated pattern — i.e. the user renamed it.
  const isUserRenamed = (current: string | null): boolean => {
    if (!current) return false;
    if (lastPluginSetName !== null && current !== lastPluginSetName) return true;
    if (lastPluginSetName === null && !AUTO_TITLE_RE.test(current)) return true;
    return false;
  };

  const setWorkspaceName = async (title: string) => {
    try {
      await $`cmux rename-workspace ${wsArgs} -- ${title}`;
      lastPluginSetName = title;
    } catch {}
  };

  // Initialize the workspace title. If the user already renamed it, leave it
  // alone. If the plugin previously set a name (e.g. before an Amp restart),
  // adopt it so we don't lose appended spawned-thread suffixes.
  const bootstrapWorkspaceTitle = async (threadId: string | undefined) => {
    const current = await getCurrentWorkspaceName();
    if (current === null) {
      log.log("workspace name unreadable, skipping rename");
      return;
    }
    if (isUserRenamed(current)) {
      log.log(`preserving user-set name: ${current}`);
      return;
    }
    if (lastPluginSetName === null && AUTO_TITLE_RE.test(current)) {
      lastPluginSetName = current;
      return;
    }
    const title = threadId ? shortenThreadId(threadId) : "amp";
    await setWorkspaceName(title);
  };

  const appendSpawnedThread = async (threadId: string) => {
    const current = await getCurrentWorkspaceName();
    if (!current || isUserRenamed(current)) return;
    const suffix = "→" + shortenThreadId(threadId);
    if (current.includes(suffix)) return;
    const next =
      current === "amp" ? shortenThreadId(threadId) : `${current} ${suffix}`;
    await setWorkspaceName(next);
  };

  // Build a rich status label using the new Neo helpers — e.g.
  //   "running: yarn test"
  //   "editing: cmux-status.ts"
  //   "reading: README.md"
  const detailedToolStatus = (
    event: ToolCallEvent,
  ): { label: string; icon: string } => {
    const baseLabel = toolLabel(event.tool);
    const icon = toolIcon(event.tool);

    const shell = helpers.shellCommandFromToolCall(event);
    if (shell) {
      const cmd = shell.command.replace(/\s+/g, " ").trim();
      return { label: `${baseLabel}: ${truncate(cmd, 32)}`, icon };
    }

    const files = helpers.filesModifiedByToolCall(event);
    if (files && files.length > 0) {
      const path = helpers.filePathFromURI(files[0]);
      return { label: `${baseLabel}: ${truncate(basename(path), 24)}`, icon };
    }

    if (event.tool === "Read") {
      const path =
        typeof event.input.path === "string" ? event.input.path : null;
      if (path) {
        return { label: `${baseLabel}: ${truncate(basename(path), 24)}`, icon };
      }
    }

    if (event.tool === "Grep" || event.tool === "glob") {
      const pattern =
        typeof event.input.pattern === "string"
          ? event.input.pattern
          : typeof event.input.query === "string"
            ? event.input.query
            : null;
      if (pattern) {
        return { label: `${baseLabel}: ${truncate(pattern, 24)}`, icon };
      }
    }

    return { label: baseLabel, icon };
  };

  // Best-effort cleanup on shutdown. Note these run synchronously on exit so
  // we fire-and-forget the shell calls.
  const cleanup = () => {
    void clearStatus();
    void clearLog();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);

  // ─────────────────────────────────────────────────────────────────────────
  // Session restore. Two pieces, both written silently per session:
  //   1. ~/.config/cmux/cmux.json   — registers Amp as a custom vault agent
  //      so cmux knows how to resume it (`amp threads continue <id>`).
  //   2. ~/.cmuxterm/amp-hook-sessions.json — records this thread's id keyed
  //      by cmux workspace/panel so cmux can match it on relaunch.
  // cmux re-reads both on every autosave tick (see RestorableAgentSessionIndex
  // .load → CmuxVaultAgentRegistry.load), so changes apply without restart.
  //
  // Requires cmux nightly / >= 0.64.4 (custom vault registry support landed
  // in manaflow-ai/cmux@744521d). Older cmux silently ignores both files.
  // ─────────────────────────────────────────────────────────────────────────

  const writeHookSession = (threadId: string) => {
    const workspaceId = process.env.CMUX_WORKSPACE_ID;
    const surfaceId = process.env.CMUX_PANEL_ID;
    if (!workspaceId || !surfaceId) {
      log.log("CMUX_WORKSPACE_ID or CMUX_PANEL_ID missing; skipping restore");
      return;
    }

    try {
      mkdirSync(dirname(HOOK_SESSIONS_PATH), { recursive: true });
      let store: { version: number; sessions: Record<string, unknown> } = {
        version: 1,
        sessions: {},
      };
      if (existsSync(HOOK_SESSIONS_PATH)) {
        try {
          const existing = JSON.parse(readFileSync(HOOK_SESSIONS_PATH, "utf8"));
          if (existing && typeof existing === "object") {
            store = existing;
            if (!store.sessions) store.sessions = {};
          }
          // If parsing fails we'd rather skip than nuke other agents'
          // entries by overwriting with an empty store.
        } catch {
          log.log("amp-hook-sessions.json corrupt; skipping write");
          return;
        }
      }
      // process.cwd() in a plugin is the plugin file's dir, not the user's
      // shell cwd. PWD is inherited from amp's launch env which preserves it.
      const cwd = process.env.PWD ?? process.cwd();
      // Key by panelId so the same surface only ever has one active session.
      store.sessions[surfaceId] = {
        sessionId: threadId,
        workspaceId,
        surfaceId,
        cwd,
        launchCommand: {
          executablePath: process.env.AMP_EXECUTABLE_PATH ?? "amp",
          arguments: ["amp"],
          workingDirectory: cwd,
        },
        updatedAt: Date.now() / 1000,
      };
      writeFileSync(HOOK_SESSIONS_PATH, JSON.stringify(store, null, 2));
    } catch (err) {
      log.log(`hook-sessions write failed: ${String(err)}`);
    }
  };

  // Convert JSONC (cmux.json's format) to plain JSON so we can JSON.parse it.
  // Strips // and /* */ comments and trailing commas before } or ].
  // (cmux uses JSONCParser.preprocess on read; we mirror that here.)
  const stripJsonComments = (input: string): string => {
    let out = "";
    let i = 0;
    let inString = false;
    let stringQuote = "";
    while (i < input.length) {
      const ch = input[i];
      const next = input[i + 1];
      if (inString) {
        out += ch;
        if (ch === "\\" && i + 1 < input.length) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        if (ch === stringQuote) inString = false;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringQuote = ch;
        out += ch;
        i++;
        continue;
      }
      if (ch === "/" && next === "/") {
        while (i < input.length && input[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        i += 2;
        while (i < input.length && !(input[i] === "*" && input[i + 1] === "/"))
          i++;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    // Drop trailing commas before } or ] (JSONC allows them; JSON does not).
    return out.replace(/,(\s*[}\]])/g, "$1");
  };

  // Idempotently ensure ~/.config/cmux/cmux.json contains the Amp vault
  // registration. Returns "added" | "present" | "skipped" | "failed".
  const ensureVaultRegistration = ():
    | "added"
    | "present"
    | "skipped"
    | "failed" => {
    try {
      let raw = "";
      let parsed: { vault?: { agents?: unknown[] } } & Record<string, unknown> =
        {};
      if (existsSync(CMUX_CONFIG_PATH)) {
        raw = readFileSync(CMUX_CONFIG_PATH, "utf8");
        try {
          const decoded = JSON.parse(stripJsonComments(raw));
          if (decoded && typeof decoded === "object") parsed = decoded;
        } catch {
          // Don't risk corrupting a config we can't parse. User can fix
          // manually or run the command palette command for an explicit
          // error.
          log.log(
            "cmux.json is unparseable JSONC; vault registration skipped",
          );
          return "skipped";
        }
      }

      parsed.vault = parsed.vault ?? {};
      const agents = Array.isArray(parsed.vault.agents)
        ? parsed.vault.agents
        : [];
      const present = agents.some(
        (a: unknown) =>
          !!a && typeof a === "object" && (a as { id?: unknown }).id === "amp",
      );
      if (present) return "present";

      agents.push(VAULT_REGISTRATION);
      parsed.vault.agents = agents;

      if (raw) {
        const backup = `${CMUX_CONFIG_PATH}.${Date.now()}.bak`;
        writeFileSync(backup, raw);
      }
      mkdirSync(dirname(CMUX_CONFIG_PATH), { recursive: true });
      writeFileSync(
        CMUX_CONFIG_PATH,
        JSON.stringify(parsed, null, 2) + "\n",
      );
      log.log("registered Amp as custom vault agent in cmux.json");
      return "added";
    } catch (err) {
      log.log(`vault registration failed: ${String(err)}`);
      return "failed";
    }
  };

  amp.on("session.start", async (event: SessionStartEvent) => {
    await setStatus("idle", "circle", COLOR.idle);
    await bootstrapWorkspaceTitle(event.thread?.id);
    if (event.thread?.id) {
      ensureVaultRegistration();
      writeHookSession(event.thread.id);
    }
  });

  amp.on("agent.start", async (_event: AgentStartEvent) => {
    inFlightTools = 0;
    await setStatus("thinking", "brain", COLOR.thinking);
    await wsLog("prompt received");
    return {};
  });

  amp.on("tool.call", async (event: ToolCallEvent) => {
    inFlightTools++;
    const { label, icon } = detailedToolStatus(event);
    await setStatus(label, icon, COLOR.active);
    return { action: "allow" as const };
  });

  amp.on("tool.result", async (event: ToolResultEvent) => {
    inFlightTools = Math.max(0, inFlightTools - 1);

    if (event.status === "error") {
      await wsLog(`${event.tool} failed`, "error");
    }

    // Track spawned handoff thread IDs and append to workspace title.
    if (event.tool === "handoff" && event.status === "done" && event.output) {
      const output = String(event.output);
      const match = output.match(/newThreadID>(T-[a-f0-9-]+)</);
      if (match) {
        await appendSpawnedThread(match[1]);
        await wsLog(`spawned thread ${shortenThreadId(match[1])}`);
      }
    }

    // After the last in-flight tool returns, the model is thinking again.
    if (inFlightTools === 0) {
      await setStatus("thinking", "brain", COLOR.thinking);
    }
  });

  amp.on("agent.end", async (event: AgentEndEvent) => {
    inFlightTools = 0;
    switch (event.status) {
      case "done":
        await setStatus("done", "checkmark.circle", COLOR.done);
        await wsLog("turn complete", "success");
        break;
      case "error":
        await setStatus("error", "xmark.circle", COLOR.error);
        await wsLog("turn errored", "error");
        await cmuxNotify("Amp errored");
        break;
      case "cancelled":
        await setStatus("interrupted", "pause.circle", COLOR.interrupted);
        await wsLog("turn interrupted", "warning");
        break;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tools the agent can call via the Neo Plugin API.
  // ─────────────────────────────────────────────────────────────────────────

  // Let the agent send a native macOS notification through cmux when it needs
  // the user's attention — e.g. after a long-running task or when blocked.
  amp.registerTool({
    name: "cmux_notify",
    description:
      "Send a native macOS notification via cmux. Use this to get the user's attention when you've finished a long-running task or are blocked waiting for input.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        body: {
          type: "string",
          description: "Optional notification body text",
        },
      },
      required: ["title"],
    },
    async execute(input) {
      const title = String(input.title ?? "").trim();
      if (!title) return "Notification title is required";
      const body =
        typeof input.body === "string" && input.body.trim() !== ""
          ? input.body.trim()
          : undefined;
      await cmuxNotify(title, body);
      return body
        ? `Sent cmux notification: ${title} — ${body}`
        : `Sent cmux notification: ${title}`;
    },
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Commands available in the Amp command palette.
  // ─────────────────────────────────────────────────────────────────────────

  amp.registerCommand(
    "rename-workspace-to-thread",
    {
      title: "Rename workspace to thread ID",
      category: "cmux",
      description:
        "Set the cmux workspace title to the current Amp thread ID",
    },
    async (ctx) => {
      const threadId = ctx.thread?.id;
      if (!threadId) {
        await ctx.ui.notify("No active Amp thread");
        return;
      }
      const title = shortenThreadId(threadId);
      try {
        // Use bunShell (not ctx.$) so multi-word titles aren't word-split.
        await bunShell`cmux rename-workspace ${wsArgs} -- ${title}`;
        lastPluginSetName = title;
        await ctx.ui.notify(`Workspace renamed to ${title}`);
      } catch (err) {
        await ctx.ui.notify(`Rename failed: ${String(err)}`);
      }
    },
  );

  amp.registerCommand(
    "rename-workspace-prompt",
    {
      title: "Rename workspace…",
      category: "cmux",
      description: "Prompt for a new cmux workspace title",
    },
    async (ctx) => {
      const current = await getCurrentWorkspaceName();
      const next = await ctx.ui.input({
        title: "Rename cmux workspace",
        helpText: "Enter a new title for the current cmux workspace",
        initialValue: current ?? "",
        submitButtonText: "Rename",
      });
      if (!next) return;
      try {
        // Use bunShell (not ctx.$) so multi-word titles aren't word-split.
        await bunShell`cmux rename-workspace ${wsArgs} -- ${next}`;
        // User-supplied name; release ownership so we don't overwrite it.
        lastPluginSetName = null;
        await ctx.ui.notify(`Workspace renamed to ${next}`);
      } catch (err) {
        await ctx.ui.notify(`Rename failed: ${String(err)}`);
      }
    },
  );

  // Manual fallback. Registration normally happens automatically on
  // session.start; this command is useful for explicit feedback when the
  // automatic write was skipped (e.g. unparseable cmux.json).
  amp.registerCommand(
    "register-vault-amp",
    {
      title: "Register Amp for cmux session restore",
      category: "cmux",
      description:
        "Re-add Amp as a custom vault agent in ~/.config/cmux/cmux.json. Normally runs automatically.",
    },
    async (ctx) => {
      const result = ensureVaultRegistration();
      switch (result) {
        case "added":
          await ctx.ui.notify("Amp registered for cmux session restore");
          break;
        case "present":
          await ctx.ui.notify("Amp already registered");
          break;
        case "skipped":
          await ctx.ui.notify(
            "cmux.json is unparseable JSONC; add the `amp` vault entry manually",
          );
          break;
        case "failed":
          await ctx.ui.notify("Registration failed; see Amp plugin log");
          break;
      }
    },
  );

  amp.registerCommand(
    "clear-status",
    {
      title: "Clear Amp status",
      category: "cmux",
      description: "Remove the Amp status indicator from the cmux tab",
    },
    async () => {
      await clearStatus();
      await clearLog();
    },
  );
}
