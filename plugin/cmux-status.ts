// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
import type {
  PluginAPI,
  ToolCallEvent,
  ToolResultEvent,
  AgentEndEvent,
  AgentStartEvent,
  SessionStartEvent,
} from "@ampcode/plugin";

const STATUS_KEY = "amp";
const LOG_SOURCE = "amp";

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
  const $ = amp.$;
  const log = amp.logger;
  const helpers = amp.helpers;

  // Track the last name we set so we can detect manual renames.
  let lastPluginSetName: string | null = null;

  // Number of tool calls in flight. While > 0 we display the most recent
  // tool's status; when it returns to 0 we flip back to "thinking".
  let inFlightTools = 0;

  const setStatus = async (label: string, icon: string, color: string) => {
    try {
      await $`cmux set-status ${STATUS_KEY} ${label} --icon ${icon} --color ${color}`;
    } catch {}
  };

  const clearStatus = async () => {
    try {
      await $`cmux clear-status ${STATUS_KEY}`;
    } catch {}
  };

  const wsLog = async (message: string, level: string = "info") => {
    try {
      await $`cmux log --level ${level} --source ${LOG_SOURCE} -- ${message}`;
    } catch {}
  };

  const clearLog = async () => {
    try {
      await $`cmux clear-log`;
    } catch {}
  };

  const cmuxNotify = async (title: string, body?: string) => {
    try {
      if (body) {
        await $`cmux notify --title ${title} --body ${body}`;
      } else {
        await $`cmux notify --title ${title}`;
      }
    } catch {}
  };

  const getCurrentWorkspaceName = async (): Promise<string | null> => {
    try {
      const out = (await $`cmux list-workspaces`).stdout;
      const line = out.split(/\r?\n/).find((l) => /\[selected\]\s*$/.test(l));
      if (!line) return null;
      const match = line.match(
        /^\*\s+\S+\s{2,}(.*?)\s{2,}\[selected\]\s*$/,
      );
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
      await $`cmux rename-workspace -- ${title}`;
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

  amp.on("session.start", async (event: SessionStartEvent) => {
    await setStatus("idle", "circle", COLOR.idle);
    await bootstrapWorkspaceTitle(event.thread?.id);
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
        await ctx.$`cmux rename-workspace -- ${title}`;
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
        await ctx.$`cmux rename-workspace -- ${next}`;
        // User-supplied name; release ownership so we don't overwrite it.
        lastPluginSetName = null;
        await ctx.ui.notify(`Workspace renamed to ${next}`);
      } catch (err) {
        await ctx.ui.notify(`Rename failed: ${String(err)}`);
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
