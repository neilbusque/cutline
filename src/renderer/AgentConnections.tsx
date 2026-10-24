import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
  Plug,
  RefreshCw,
  Terminal,
} from "lucide-react";
import {
  createAgentConfigurations,
  agentCapabilities,
  connectionVerificationPrompt,
  type AgentConnectionSettings,
  type AgentBridgeStatus,
} from "../shared/agent-connections";
import "./agent-connections.css";

const providers = [
  ["cutline", "In Cutline"],
  ["claude-desktop", "Claude Desktop"],
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["chatgpt", "ChatGPT web"],
] as const;
type Provider = (typeof providers)[number][0];

export function AgentConnections({
  settings,
  report,
  openAssistant,
}: {
  settings?: AgentConnectionSettings;
  report: (error: unknown) => void;
  openAssistant: () => void;
}) {
  const [provider, setProvider] = useState<Provider>("cutline");
  const [status, setStatus] = useState<AgentBridgeStatus>();
  const [assistant, setAssistant] = useState(
    "Sign in to use your ChatGPT account",
  );
  const [claudeState, setClaudeState] = useState("Not connected");
  const [claudeModel, setClaudeModel] = useState<"opus" | "sonnet">("opus");
  const [claudeInstalled, setClaudeInstalled] = useState(true);
  const [busy, setBusy] = useState<
    | "test"
    | "install"
    | "install-codex"
    | "install-claude-code"
    | "session-prompt"
    | "login"
    | "claude"
  >();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const tabs = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const config = useMemo(() => {
    try {
      return { value: createAgentConfigurations(settings ?? {}), error: "" };
    } catch (error) {
      return { value: undefined, error: (error as Error).message };
    }
  }, [settings?.mcpLauncher, settings?.connection]);

  useEffect(() => {
    let live = true;
    void window.cutline
      .invoke("connection.status")
      .then((value: AgentBridgeStatus) => {
        if (live) setStatus(value);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    void window.cutline
      .invoke("codex.status")
      .then((value) => {
        if (live && value.message) setAssistant(value.message);
      })
      .catch(() => {});
    void window.cutline
      .invoke("claude.status")
      .then((value) => {
        if (live && value.message) setClaudeState(value.message);
      })
      .catch(() => {});
    void window.cutline
      .invoke("assistant.settings")
      .then((value) => {
        if (!live) return;
        setClaudeModel(value.claudeModel);
        setClaudeInstalled(value.claudeInstalled);
      })
      .catch(() => {});
    const off = window.cutline.on("assistant", (event) => {
      if (event.provider === "claude") {
        if (event.type === "connected")
          setClaudeState(
            event.account === "signed-out"
              ? "Sign in to Claude"
              : "Connected to Claude",
          );
        if (event.type === "error") setClaudeState("Claude needs attention");
        return;
      }
      if (event.type === "login")
        setAssistant(
          event.success
            ? "Signed in with ChatGPT"
            : "Sign-in failed. Try again.",
        );
      if (event.type === "connected")
        setAssistant(
          event.account === "signed-out"
            ? "Sign in to use your ChatGPT account"
            : "Connected through Codex",
        );
      if (event.type === "error") setAssistant("Assistant needs attention");
    });
    return () => {
      live = false;
      off();
      clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = async (id: string, text: string | undefined) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      clearTimeout(copyTimer.current);
      setCopied(id);
      setNotice("Copied to clipboard");
      setError("");
      copyTimer.current = setTimeout(() => setCopied(""), 2200);
    } catch (error) {
      setError(
        "Could not copy. Select the configuration and copy it manually.",
      );
      report(error);
    }
  };
  const action = async (
    kind:
      | "test"
      | "install"
      | "install-codex"
      | "install-claude-code"
      | "session-prompt"
      | "login"
      | "claude",
  ) => {
    if (busy) return;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      if (kind === "test") {
        const value: AgentBridgeStatus =
          await window.cutline.invoke("connection.test");
        setStatus(value);
        setNotice(
          value.ready
            ? "Local connection tested. Ask your assistant to inspect the project to confirm its connection."
            : value.message,
        );
      } else if (kind === "install") {
        const value = await window.cutline.invoke("connection.installClaude");
        setNotice(
          value.message ??
            "Connection installed. Fully quit and reopen Claude Desktop, then ask it to inspect Cutline.",
        );
      } else if (kind === "install-codex") {
        const value = await window.cutline.invoke("connection.installCodex");
        setNotice(value.message);
      } else if (kind === "install-claude-code") {
        const value = await window.cutline.invoke(
          "connection.installClaudeCode",
        );
        setNotice(value.message);
      } else if (kind === "session-prompt") {
        await window.cutline.invoke("sessions.copyPrompt");
        setNotice(
          "Session prompt copied. Paste it into a separate Codex chat to work on this window’s video.",
        );
      } else if (kind === "claude") {
        const value = await window.cutline.invoke("claude.connect");
        if (!value.account) {
          setNotice("Claude sign-in opened in your browser");
          await window.cutline.invoke("claude.login");
        }
        setNotice(
          "Claude is ready. Open the assistant and describe your edit.",
        );
      } else {
        await window.cutline.invoke("codex.login");
        setAssistant(
          "Finish signing in in your browser, then open the assistant",
        );
        setNotice("ChatGPT sign-in opened in your browser");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      report(error);
    } finally {
      setBusy(undefined);
    }
  };
  const copyButton = (
    id: string,
    label: string,
    text: string | undefined,
    primary = false,
  ) => (
    <button
      className={`ac-button ${primary ? "ac-primary" : ""}`}
      disabled={!text || !!busy}
      onClick={() => void copy(id, text)}
    >
      {copied === id ? <Check size={14} /> : <Copy size={14} />}
      {copied === id ? "Copied" : label}
    </button>
  );
  const code = (text: string | undefined) => (
    <pre className="ac-code" tabIndex={0}>
      {text ?? config.error}
    </pre>
  );
  const docLink = (url: string, label: string) => (
    <a
      href={url}
      onClick={(event) => {
        event.preventDefault();
        void window.cutline.invoke("connection.docs", { url }).catch(report);
      }}
    >
      {label}
      <ExternalLink size={11} />
    </a>
  );

  return (
    <section className="agent-connections" aria-label="Assistant connections">
      <div className="ac-heading">
        <Plug size={17} />
        <h3>Connect an assistant</h3>
        <span>Live editing</span>
      </div>
      <p className="ac-lead">
        Give Claude or Codex control of the open project, including editable
        motion graphics and the timeline.
      </p>
      <div className="ac-status" role="status">
        <span className={`ac-status-dot ${status?.ready ? "ready" : ""}`} />
        <div>
          <strong>
            {status?.ready
              ? "Local bridge ready"
              : (status?.message ?? "Checking local bridge…")}
          </strong>
          <small>
            {status?.ready
              ? `${status.tools ?? 0} editing tools · ${status.projectName ?? "Open project"}`
              : "Keep Cutline open while your assistant edits."}
          </small>
        </div>
        <button
          className="ac-button ac-test"
          disabled={!!busy}
          onClick={() => void action("test")}
          aria-label="Test local connection"
        >
          {busy === "test" ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          Test
        </button>
      </div>
      {status?.lastCall && (
        <p className="ac-last-call">
          Last assistant tool: <code>{status.lastCall.tool}</code> ·{" "}
          {new Date(status.lastCall.at).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      )}
      <div
        className="ac-tabs"
        role="tablist"
        aria-label="Assistant provider"
        ref={tabs}
        onKeyDown={(event) => {
          const current = providers.findIndex(([id]) => id === provider);
          const next =
            event.key === "ArrowRight"
              ? (current + 1) % providers.length
              : event.key === "ArrowLeft"
                ? (current + providers.length - 1) % providers.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? providers.length - 1
                    : undefined;
          if (next === undefined) return;
          event.preventDefault();
          setProvider(providers[next][0]);
          setNotice("");
          tabs.current
            ?.querySelectorAll<HTMLButtonElement>("button")
            [next]?.focus();
        }}
      >
        {providers.map(([id, name]) => (
          <button
            key={id}
            role="tab"
            id={`ac-tab-${id}`}
            aria-controls={`ac-panel-${id}`}
            aria-selected={provider === id}
            tabIndex={provider === id ? 0 : -1}
            onClick={() => {
              setProvider(id);
              setNotice("");
              setError("");
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        className="ac-provider"
        role="tabpanel"
        id={`ac-panel-${provider}`}
        aria-labelledby={`ac-tab-${provider}`}
      >
        {provider === "cutline" && (
          <>
            <h4>Edit with Claude or Codex inside Cutline</h4>
            <p>
              The Assistant panel can use Claude with your Claude Code sign-in,
              or Codex with your ChatGPT sign-in. Both edit through the same
              undoable tools.
            </p>
            <div className="ac-group">
              <div className="ac-row">
                <div>
                  <strong>Claude</strong>
                  <small>
                    {claudeInstalled
                      ? claudeState
                      : "Claude Code isn't installed on this Mac"}
                  </small>
                </div>
                <select
                  aria-label="Claude model for the assistant"
                  value={claudeModel}
                  onChange={(event) => {
                    const next = event.target.value as "opus" | "sonnet";
                    setClaudeModel(next);
                    void window.cutline
                      .invoke("assistant.settings.set", { claudeModel: next })
                      .catch(report);
                  }}
                >
                  <option value="opus">Opus · best results</option>
                  <option value="sonnet">Sonnet · faster</option>
                </select>
                <button
                  className="ac-button"
                  disabled={!!busy || !claudeInstalled}
                  onClick={() => void action("claude")}
                >
                  {busy === "claude" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Plug size={14} />
                  )}
                  {claudeState === "Connected to Claude"
                    ? "Reconnect"
                    : "Connect"}
                </button>
              </div>
              <div className="ac-row">
                <div>
                  <strong>Codex</strong>
                  <small>{assistant}</small>
                </div>
                <button
                  className="ac-button"
                  disabled={!!busy}
                  onClick={() => void action("login")}
                >
                  {busy === "login" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Plug size={14} />
                  )}
                  {/^(Signed in|Connected)/u.test(assistant)
                    ? "Sign in again"
                    : "Sign in with ChatGPT"}
                </button>
              </div>
            </div>
            <div className="ac-actions">
              <button className="ac-button ac-primary" onClick={openAssistant}>
                <MessageSquare size={14} />
                Open assistant
              </button>
            </div>
            <p className="ac-note">
              Your account’s model availability and usage limits apply.
            </p>
          </>
        )}
        {provider === "claude-desktop" && (
          <>
            <h4>Connect Claude Desktop in one click</h4>
            <p>
              Add Cutline to Claude’s local tools, then fully quit and reopen
              Claude Desktop.
            </p>
            <button
              className="ac-button ac-primary"
              disabled={!config.value || !!busy}
              onClick={() => void action("install")}
            >
              {busy === "install" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Plug size={14} />
              )}
              Install Claude Desktop connection
            </button>
            <p className="ac-note">
              Preserves your other MCP servers and backs up the previous
              configuration. Uses Cutline’s bundled runtime.
            </p>
            <details className="ac-details">
              <summary>Manual configuration</summary>
              <p>
                In Claude Desktop, open Settings → Developer → Edit Config.
                Merge this <code>cutline</code> entry into{" "}
                <code>mcpServers</code>, save, and restart Claude.
              </p>
              {code(config.value?.claudeDesktop)}
              {copyButton(
                "claude-json",
                "Copy Claude configuration",
                config.value?.claudeDesktop,
              )}
              {docLink(
                "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
                "Claude Desktop setup guide",
              )}
            </details>
          </>
        )}
        {provider === "claude-code" && (
          <>
            <h4>Use Cutline from Claude Code</h4>
            <p>
              Adds Cutline to Claude Code for every project on this Mac. Start a
              new session afterwards and ask it to inspect the open project.
            </p>
            <button
              className="ac-button ac-primary"
              disabled={!config.value || !!busy}
              onClick={() => void action("install-claude-code")}
            >
              {busy === "install-claude-code" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Plug size={14} />
              )}
              Add to Claude Code
            </button>
            <details className="ac-details">
              <summary>Run it yourself in Terminal</summary>
              {code(config.value?.claudeCode)}
              {copyButton(
                "claude-cli",
                "Copy install command",
                config.value?.claudeCode,
              )}
              <p className="ac-note">
                Then open Claude Code and run <code>/mcp</code> to confirm{" "}
                <code>cutline</code> is listed.
              </p>
            </details>
            {docLink(
              "https://code.claude.com/docs/en/mcp",
              "Claude Code connection guide",
            )}
          </>
        )}
        {provider === "codex" && (
          <>
            <button
              className="ac-button ac-primary"
              disabled={!!busy || !config.value}
              onClick={() => void action("install-codex")}
            >
              {busy === "install-codex" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Plug size={14} />
              )}
              Install Codex connection
            </button>
            <h4>Use Cutline from Codex</h4>
            <p>
              Once connected, copy this session’s prompt into a separate Codex
              chat. Each chat can make a different video in its own Cutline
              session. Open more windows from Sessions in the title bar.
            </p>
            <button
              className="ac-button ac-primary"
              disabled={!!busy}
              onClick={() => void action("session-prompt")}
            >
              {busy === "session-prompt" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Copy size={14} />
              )}
              Copy this session’s prompt
            </button>
            <p>Or install the connection from Terminal:</p>
            {code(config.value?.codexCommand)}
            {copyButton(
              "codex-cli",
              "Copy install command",
              config.value?.codexCommand,
              true,
            )}
            <details className="ac-details">
              <summary>Manual config.toml setup</summary>
              <p>
                Add this table to <code>~/.codex/config.toml</code>. If{" "}
                <code>mcp_servers.cutline</code> already exists, update that
                table. The ten-minute tool timeout allows local transcription
                and rendering to finish. Automatic tool access applies to
                Cutline’s editing tools.
              </p>
              {code(config.value?.codex)}
              {copyButton(
                "codex-toml",
                "Copy Codex configuration",
                config.value?.codex,
              )}
            </details>
            {docLink(
              "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
              "Codex MCP guide",
            )}
          </>
        )}
        {provider === "chatgpt" && (
          <>
            <h4>Connect ChatGPT on the web</h4>
            <div>
              <p>
                ChatGPT cloud needs a reachable HTTPS MCP server or OpenAI
                Secure MCP Tunnel. A localhost address or this local JSON
                configuration alone cannot connect it.
              </p>
              <p>
                Cutline exposes local stdio and HTTP MCP. For a private tunnel,
                create a tunnel in OpenAI Platform, run{" "}
                <code>tunnel-client</code> on this Mac, and use this local
                launch command as its <code>--mcp-command</code>.
              </p>
              {code(config.value?.localLaunchCommand)}
              {copyButton(
                "tunnel-launch",
                "Copy local launch command",
                config.value?.localLaunchCommand,
              )}
              <p className="ac-note">
                Tunnel setup requires a Platform runtime API key and tunnel
                permissions. Keep Cutline and the tunnel client running, then
                add the tunnel in ChatGPT’s custom MCP server settings.
              </p>
              {docLink(
                "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
                "Official Secure MCP Tunnel instructions",
              )}
            </div>
          </>
        )}
      </div>
      {config.error && (
        <p className="ac-error" role="alert">
          {config.error}
        </p>
      )}
      <div className="ac-feedback" aria-live="polite">
        {error ? <span className="ac-error">{error}</span> : notice}
      </div>
      <div className="ac-confirm">
        <Check size={14} />
        <div>
          <strong>Confirm from your assistant</strong>
          <p>Ask it to inspect Cutline before making your first edit.</p>
        </div>
        {copyButton("verify", "Copy test prompt", connectionVerificationPrompt)}
      </div>
      <details className="ac-details ac-capabilities">
        <summary>What connected assistants can do</summary>
        <ul>
          {agentCapabilities.map((capability) => (
            <li key={capability.name}>
              <strong>{capability.name}</strong>
              <span>{capability.detail}</span>
            </li>
          ))}
        </ul>
        <p className="ac-note">
          Edits use the current project revision and appear on the timeline.
          Undo and redo stay available. Your assistant can import local media,
          save the project and review requested preview images.
        </p>
      </details>
      <p className="ac-privacy">
        <Terminal size={12} />
        Original media stays on your Mac. Project details, asset names,
        transcripts and requested preview images can be shared with the
        assistant you connect.
      </p>
    </section>
  );
}
