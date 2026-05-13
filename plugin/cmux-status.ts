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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATUS_KEY = "amp";
const LOG_SOURCE = "amp";

// Bridge plugin that cmux >= 0.64.5's `cmux hooks amp install` writes here.
// Without it, native restore can't see Amp threads.
const CMUX_BRIDGE_PLUGIN_PATH = join(
  homedir(),
  ".config",
  "amp",
  "plugins",
  "cmux-session.ts",
);

// Where we record the last time we surfaced a native macOS notification
// about the missing bridge plugin, so we don't nag every session.
const BRIDGE_WARNING_STATE_PATH = join(
  homedir(),
  ".cache",
  "cmux-amp",
  "bridge-warning.json",
);

const BRIDGE_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

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

  // Session restore is provided natively by cmux >= 0.64.5 (see
  // manaflow-ai/cmux#3710). Run `cmux hooks setup` once to enable; it drops
  // its own `~/.config/amp/plugins/cmux-session.ts` bridge plugin and uses
  // the built-in `.amp` RestorableAgentKind. Nothing in this plugin file
  // participates in restore anymore — but we do nudge the user if the
  // bridge plugin is missing, since the failure mode is otherwise silent
  // (panes just don't restore on relaunch).
  //
  // Two channels:
  //   1. wsLog (cmux activity feed) every session.start — cheap, useful for
  //      diagnostics, not in the user's face.
  //   2. cmuxNotify (native macOS notification) at most once per 24h —
  //      visible enough to actually catch the user's attention without
  //      being annoying.
  const checkBridgePluginInstalled = async () => {
    if (!WORKSPACE_REF) return; // not running under cmux at all
    if (existsSync(CMUX_BRIDGE_PLUGIN_PATH)) return;

    await wsLog(
      "session restore disabled — run `cmux: Install cmux session restore` (requires cmux ≥ 0.64.5) to enable",
      "warning",
    );

    // Rate-limit the popup. State file tracks last notification time;
    // unparseable / missing file = treat as never-notified.
    const now = Date.now();
    let lastNotifiedAt = 0;
    if (existsSync(BRIDGE_WARNING_STATE_PATH)) {
      try {
        const parsed = JSON.parse(
          readFileSync(BRIDGE_WARNING_STATE_PATH, "utf8"),
        );
        if (typeof parsed?.lastNotifiedAt === "number") {
          lastNotifiedAt = parsed.lastNotifiedAt;
        }
      } catch {
        // Treat unparseable as never-notified; we'll overwrite below.
      }
    }
    if (now - lastNotifiedAt < BRIDGE_WARNING_INTERVAL_MS) return;

    await cmuxNotify(
      "Amp session restore is off",
      "Run `cmux: Install cmux session restore` from the Amp command palette to enable.",
    );

    try {
      mkdirSync(dirname(BRIDGE_WARNING_STATE_PATH), { recursive: true });
      writeFileSync(
        BRIDGE_WARNING_STATE_PATH,
        JSON.stringify({ lastNotifiedAt: now }),
      );
    } catch (err) {
      log.log(`bridge-warning state write failed: ${String(err)}`);
    }
  };

  amp.on("session.start", async (event: SessionStartEvent) => {
    await setStatus("idle", "circle", COLOR.idle);
    await bootstrapWorkspaceTitle(event.thread?.id);
    await checkBridgePluginInstalled();
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

  // One-click installer for the cmux >= 0.64.5 bridge plugin. Saves users
  // from having to drop into a terminal when they hit the missing-bridge
  // warning — they can run this from the Amp command palette instead.
  amp.registerCommand(
    "install-cmux-restore",
    {
      title: "Install cmux session restore",
      category: "cmux",
      description:
        "Run `cmux hooks amp install` to enable cmux ≥ 0.64.5's native Amp thread restore. Requires `plugins: reload` afterwards.",
    },
    async (ctx) => {
      try {
        // -y skips the interactive confirm prompt cmux normally shows.
        await bunShell`cmux hooks amp install -y`;
      } catch (err) {
        await ctx.ui.notify(
          `Install failed (cmux ≥ 0.64.5 required): ${String(err)}`,
        );
        return;
      }
      // Verify rather than trusting exit status — older cmux may print
      // an unrecognized-subcommand error and still exit 0 in some shells.
      if (!existsSync(CMUX_BRIDGE_PLUGIN_PATH)) {
        await ctx.ui.notify(
          `Install ran but ${CMUX_BRIDGE_PLUGIN_PATH} is missing — is cmux ≥ 0.64.5 on PATH?`,
        );
        return;
      }
      await ctx.ui.notify(
        "Installed cmux native restore. Run `plugins: reload` (or restart Amp) to activate.",
      );
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
