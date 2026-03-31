// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
import type { PluginAPI } from "@ampcode/plugin";

const STATUS_KEY = "amp";
const LOG_SOURCE = "amp";

function toolLabel(tool: string): string {
  switch (tool) {
    case "Read":
      return "reading";
    case "edit_file":
    case "create_file":
      return "editing";
    case "Bash":
      return "running cmd";
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
    default:
      return tool;
  }
}

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
    default:
      return "hammer";
  }
}

function shorten(threadId: string): string {
  return threadId.slice(0, 10) + "…";
}

// Matches titles the plugin auto-generates: "amp", "T-019d45e1…", or chains like "T-019d… →T-abcd…"
const AUTO_TITLE_RE = /^(?:amp|T-[0-9a-f]+…)(?: →T-[0-9a-f]+…)*$/i;

export default function (amp: PluginAPI) {
  const currentThreadId = process.env.AMP_CURRENT_THREAD_ID;

  // Read the current workspace name from cmux so we can detect manual overrides.
  const getCurrentWorkspaceName = async (): Promise<string | null> => {
    try {
      const out = String(await amp.$`cmux list-workspaces`);
      const line = out.split(/\r?\n/).find((l) => /\[selected\]\s*$/.test(l));
      if (!line) return null;
      const match = line.match(/^\*\s+\S+\s{2,}(.*?)\s{2,}\[selected\]\s*$/);
      return match?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  };

  // Only set the workspace title on first start when it's still the default "amp".
  const bootstrapWorkspaceTitle = async () => {
    const current = await getCurrentWorkspaceName();
    if (!current || current === "amp") {
      const title = currentThreadId ? shorten(currentThreadId) : "amp";
      try {
        await amp.$`cmux rename-workspace -- ${title}`;
      } catch {}
    }
  };

  // Append a spawned thread ID to the workspace title, but only if we still own it.
  const appendSpawnedThread = async (threadId: string) => {
    const current = await getCurrentWorkspaceName();
    if (!current || !AUTO_TITLE_RE.test(current)) return;
    const suffix = "→" + shorten(threadId);
    if (current.includes(suffix)) return;
    const next = current === "amp" ? shorten(threadId) : `${current} ${suffix}`;
    try {
      await amp.$`cmux rename-workspace -- ${next}`;
    } catch {}
  };

  const setStatus = async (label: string, icon: string, color: string) => {
    try {
      await amp.$`cmux set-status ${STATUS_KEY} ${label} --icon ${icon} --color ${color}`;
    } catch {}
  };

  const clearStatus = async () => {
    try {
      await amp.$`cmux clear-status ${STATUS_KEY}`;
    } catch {}
  };

  const log = async (message: string, level: string = "info") => {
    try {
      await amp.$`cmux log --level ${level} --source ${LOG_SOURCE} -- ${message}`;
    } catch {}
  };

  const clearLog = async () => {
    try {
      await amp.$`cmux clear-log`;
    } catch {}
  };

  const cleanup = () => {
    clearStatus();
    clearLog();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);

  amp.on("session.start", async () => {
    await setStatus("idle", "circle", "adb5bd");
    await bootstrapWorkspaceTitle();
  });

  amp.on("agent.start", async () => {
    await setStatus("thinking", "brain", "ffffff");
    await log("prompt received", "info");
  });

  amp.on("tool.call", async (event) => {
    const label = toolLabel(event.tool);
    const icon = toolIcon(event.tool);
    await setStatus(label, icon, "ffd700");
    return { action: "allow" as const };
  });

  amp.on("tool.result", async (event) => {
    if (event.status === "error") {
      await log(`${event.tool} failed`, "error");
    }

    // Track spawned handoff thread IDs and append to workspace title if we still own it.
    if (event.tool === "handoff" && event.status === "done" && event.output) {
      const output = String(event.output);
      const match = output.match(/newThreadID>(T-[a-f0-9-]+)</);
      if (match) {
        await appendSpawnedThread(match[1]);
        await log(`spawned thread ${shorten(match[1])}`, "info");
      }
    }
  });

  amp.on("agent.end", async (event) => {
    switch (event.status) {
      case "done":
        await setStatus("done", "checkmark.circle", "50fa7b");
        await log("turn complete", "success");
        break;
      case "error":
        await setStatus("error", "xmark.circle", "ff5555");
        await log("turn errored", "error");
        break;
      case "interrupted":
        await setStatus("interrupted", "pause.circle", "ffb86c");
        await log("turn interrupted", "warning");
        break;
    }
  });
}
