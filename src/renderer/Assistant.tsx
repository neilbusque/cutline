import React, { useEffect, useState, useRef } from "react";
import { ArrowUp, Square, Sparkles, Plug, SquarePen } from "lucide-react";
import type { Playhead } from "./playhead";
import {
  parseMarkdown,
  type Block,
  type Inline,
} from "../shared/chat-markdown";
import { errorText } from "./controls";
import "./assistant.css";
type Provider = "claude" | "codex";
type Message = {
  role: "user" | "assistant" | "error" | "note";
  text: string;
  /** For an error: what to send to try again. */
  retry?: string;
};
const names: Record<Provider, string> = { claude: "Claude", codex: "Codex" };
const styleShort = (style: string, name: string) =>
  `Make my speaker video on the timeline into a ${name}-inspired Short with cutline_style_reel style ${style}. Transcribe first if there are no captions. Read the transcript with timings, plan the beats by the style's rules (real logos and pages for every product, site or repo I name, short lines only from my actual words), build it, then preview the checkFrames it returns (the opening, each beat and the ending) and fix what looks wrong. Keep my voice.`;
/**
 * The chat shows the label; the assistant gets the detailed recipe. Recipes
 * that work on speaker footage are offered once the timeline has video.
 */
const suggestions: { label: string; prompt: string; needsVideo?: boolean }[] = [
  {
    label: "Jack Roberts-style Short",
    prompt: styleShort("split", "Jack Roberts"),
    needsVideo: true,
  },
  {
    label: "sebintel-style Short",
    prompt: styleShort("cards", "sebintel"),
    needsVideo: true,
  },
  {
    label: "Matthew Berman-style Short",
    prompt: styleShort("locked-split", "Matthew Berman"),
    needsVideo: true,
  },
  {
    label: "Make an animated title",
    prompt:
      "Ask me for the title text if I haven't given it. Add it at the playhead as an animated title with motion.recipe kinetic-title, readable and inside the safe area, then preview its entrance, hold and exit and fix what looks wrong.",
  },
  {
    label: "Draw an illustration",
    prompt:
      "Ask me what to draw if I haven't said. Make it with cutline_graphic and place it at the playhead, clear of any captions, then preview it and fix what looks wrong.",
  },
  {
    label: "Illustrate the key ideas",
    needsVideo: true,
    prompt:
      "Read the transcript with timings and pick the 2 to 4 key ideas that name no real product. For each, make an original illustration with cutline_graphic and place it on the words that say it, held 2 to 3 seconds and clear of the captions. Real products get their real logo with cutline_reference instead. Preview each moment and fix what looks wrong.",
  },
  {
    label: "Make an Ali-inspired Reel",
    needsVideo: true,
    prompt:
      "Build an Ali Abdaal-inspired Reel from my imported footage using creator-education, clean styling, short light caption pills, educational cards and gentle punch-ins. Read the reel format guide and real transcript first. Keep my original voice, preserve my existing timeline by appending, and inspect the speaker framing, captions and rendered cards before finishing.",
  },
  {
    label: "Build a listicle Reel",
    needsVideo: true,
    prompt:
      "Turn my imported footage into a listicle Reel with numbered animated points and Punch captions. Use the real transcript to choose and time the points. Keep every title editable, append to preserve my existing timeline, and check the rendered text for overlaps.",
  },
  {
    label: "Make this more cinematic",
    needsVideo: true,
    prompt:
      "Use the cinematic director guide to improve this video. Keep the story and my edits, remove decorative underlines, simplify the typography, and use purposeful camera moves and readable holds. Check quality, inspect rendered previews, and fix what you find.",
  },
  {
    label: "Build a product film",
    prompt:
      "Help me build a polished product film from my imported screens and media. Use the director guide, plan a clear story, vary the compositions, and keep everything editable. Ask only for essential missing information before creating it.",
  },
  {
    label: "Create a local voiceover",
    prompt:
      "Turn my supplied script into speech with local Kokoro using cutline_voiceover. If I have not supplied the script, ask only for the text to read. Use Heart (af_heart) at 1.08x unless I specify a voice or pace. Import the result into my library without changing the timeline unless I ask you to place it. Keep my words and existing edits, and wait for the voiceover job to finish.",
  },
  {
    label: "Review video quality",
    prompt:
      "Check this video’s quality, then inspect the suggested rendered frames. Tell me the most important concrete improvements with timecodes. Keep this review read-only.",
  },
];
/** What the assistant is doing, from the Cutline tool it just called. */
export function toolActivity(name: string) {
  if (name === "cutline_inspect") return "Reading the project…";
  if (name === "cutline_director_guide") return "Choosing the film direction…";
  if (name === "cutline_quality_check") return "Checking video quality…";
  if (name === "cutline_search_transcript" || name === "cutline_transcript")
    return "Reading the transcript…";
  if (name === "cutline_editing_schema" || name === "cutline_effects_guide")
    return "Checking the editing guide…";
  if (name === "cutline_edit" || name === "cutline_apply_edits")
    return "Applying edits…";
  if (name === "cutline_preview") return "Reviewing the preview…";
  if (name === "cutline_jobs") return "Waiting for the job to finish…";
  if (name === "cutline_import_media") return "Importing media…";
  if (name === "cutline_stock_import") return "Getting stock media…";
  if (name === "cutline_voiceover") return "Creating the voiceover…";
  if (name === "cutline_style_reel") return "Laying out the Short…";
  if (name === "cutline_reference") return "Getting the real logo or page…";
  if (name === "cutline_graphic") return "Drawing a graphic…";
  if (name === "cutline_story") return "Planning the storyline…";
  if (name === "cutline_story_voice") return "Creating scene narration…";
  if (name === "cutline_story_assemble") return "Assembling the story…";
  if (name === "cutline_auto_edit") return "Auto editing the video…";
  if (name === "cutline_create_reel") return "Building the animated Reel…";
  if (name === "cutline_relink") return "Relinking media…";
  if (name === "cutline_transcribe") return "Transcribing speech…";
  if (name === "cutline_remove_pauses") return "Removing pauses…";
  if (name === "cutline_export") return "Exporting…";
  if (name.startsWith("cutline_music")) return "Working on the music…";
  if (name.startsWith("cutline_caption")) return "Working on captions…";
  if (name === "cutline_undo") return "Undoing…";
  if (name === "cutline_redo") return "Redoing…";
  return "Working on your edit…";
}
function InlineText({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.type === "text" ? (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        ) : part.type === "code" ? (
          <code key={index}>{part.text}</code>
        ) : part.type === "strong" ? (
          <strong key={index}>
            <InlineText parts={part.children} />
          </strong>
        ) : (
          <em key={index}>
            <InlineText parts={part.children} />
          </em>
        ),
      )}
    </>
  );
}
const lines = (rows: Inline[][]) =>
  rows.map((row, index) => (
    <React.Fragment key={index}>
      {index > 0 && <br />}
      <InlineText parts={row} />
    </React.Fragment>
  ));
function MarkdownBlock({ block }: { block: Block }) {
  if (block.type === "code")
    return (
      <pre>
        <code>{block.text}</code>
      </pre>
    );
  if (block.type === "heading")
    return (
      <p className="message-heading">
        <InlineText parts={block.children} />
      </p>
    );
  if (block.type === "list") {
    const items = block.items.map((item, index) => (
      <li key={index}>{lines(item)}</li>
    ));
    return block.ordered ? (
      <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
    ) : (
      <ul>{items}</ul>
    );
  }
  return <p>{lines(block.lines)}</p>;
}
/** An assistant reply: simple markdown rendered as elements, never as HTML. */
export function MessageText({ text }: { text: string }) {
  return (
    <div className="message-text">
      {parseMarkdown(text).map((block, index) => (
        <MarkdownBlock key={index} block={block} />
      ))}
    </div>
  );
}
export function Assistant({
  report,
  selected,
  draft,
  playhead,
  fps = 30,
  hasVideo = false,
}: {
  report: (e: unknown) => void;
  selected?: string;
  draft?: { id: number; text: string };
  playhead?: Playhead;
  fps?: number;
  /** The timeline has video, so speaker recipes can work. */
  hasVideo?: boolean;
}) {
  const [provider, setProvider] = useState<Provider>("claude");
  const [model, setModel] = useState<"opus" | "sonnet">("opus");
  const [chats, setChats] = useState<Record<Provider, Message[]>>({
    claude: [],
    codex: [],
  });
  const [input, setInput] = useState("");
  useEffect(() => {
    if (draft) setInput(draft.text);
  }, [draft?.id]);
  const [busy, setBusy] = useState<Record<Provider, boolean>>({
    claude: false,
    codex: false,
  });
  const [status, setStatus] = useState<Record<Provider, string>>({
    claude: "Not connected",
    codex: "Not connected",
  });
  const [activity, setActivity] = useState("");
  // What the assistant said it is doing, and when the turn started.
  const [step, setStep] = useState("");
  const [started, setStarted] = useState(0);
  const [, tickClock] = useState(0);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const bottom = useRef<HTMLDivElement>(null);
  const delta = useRef<Record<Provider, string>>({ claude: "", codex: "" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const name = names[provider];
  const messages = chats[provider];
  const working = busy[provider];
  const setFor = <T,>(
    set: React.Dispatch<React.SetStateAction<Record<Provider, T>>>,
    p: Provider,
    value: NoInfer<T>,
  ) => set((old) => ({ ...old, [p]: value }));
  /** What was last sent to each assistant, for Retry. */
  const lastAsk = useRef<Record<Provider, string | undefined>>({
    claude: undefined,
    codex: undefined,
  });
  const addTo = (p: Provider, message: Message) =>
    setChats((old) => ({ ...old, [p]: [...old[p], message] }));
  const flush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const pending = delta.current;
    delta.current = { claude: "", codex: "" };
    setChats((old) => {
      const next = { ...old };
      for (const p of ["claude", "codex"] as Provider[]) {
        const text = pending[p];
        if (!text) continue;
        const list = [...next[p]];
        const last = list.at(-1);
        if (last?.role === "assistant")
          list[list.length - 1] = { role: "assistant", text: last.text + text };
        else list.push({ role: "assistant", text: text.replace(/^\n+/, "") });
        next[p] = list;
      }
      return next;
    });
  };
  useEffect(() => {
    void window.cutline
      .invoke("assistant.settings")
      .then((s) => {
        setProvider(s.provider);
        setModel(s.claudeModel);
        // Checking Claude's sign-in is instant and starts no session.
        if (s.claudeInstalled)
          void window.cutline.invoke("claude.connect").catch(() => {});
        else setFor(setStatus, "claude", "Claude Code isn't installed");
      })
      .catch(() => {});
    for (const p of ["claude", "codex"] as Provider[])
      void window.cutline
        .invoke(`${p}.status`)
        .then((s) => {
          setFor(setBusy, p, !!s.busy);
          setFor(setStatus, p, s.message);
        })
        .catch(() => {});
    return () => clearTimeout(timer.current);
  }, []);
  useEffect(
    () =>
      window.cutline.on("assistant", (e) => {
        if (e.type === "settings") {
          setProvider(e.provider);
          setModel(e.claudeModel);
          return;
        }
        const p: Provider = e.provider === "codex" ? "codex" : "claude";
        const label = names[p];
        if (e.type === "delta") {
          delta.current[p] += e.text;
          if (!timer.current) timer.current = setTimeout(flush, 50);
        }
        if (e.type === "started") {
          setFor(setBusy, p, true);
          setFor(setStatus, p, "Working on your edit…");
          if (p === providerRef.current) {
            setActivity("Working on your edit…");
            setStep("");
            setStarted(Date.now());
          }
        }
        if (e.type === "note" && p === providerRef.current)
          setStep(String(e.text).split("\n")[0].slice(0, 160));
        if (e.type === "connecting")
          setFor(setStatus, p, `Connecting to ${label}…`);
        if (e.type === "warning") {
          setFor(setStatus, p, `${label} is recovering…`);
          if (e.message && p === "claude") report(e.message);
        }
        if (e.type === "tool" && p === providerRef.current)
          setActivity(toolActivity(e.name));
        if (e.type === "connected")
          setFor(
            setStatus,
            p,
            e.account === "signed-out"
              ? `Sign in to ${label}`
              : `Connected to ${label}`,
          );
        if (e.type === "completed") {
          flush();
          setFor(
            setStatus,
            p,
            e.status === "interrupted"
              ? "Stopped"
              : `Connected to ${label}`,
          );
          setFor(setBusy, p, false);
          if (p === providerRef.current) setActivity("");
          if (e.status === "interrupted")
            addTo(p, {
              role: "note",
              text: "Stopped. Changes made before you pressed Stop are kept.",
            });
          else if (e.error) addTo(p, { role: "error", text: e.error, retry: lastAsk.current[p] });
        }
        if (e.type === "error") {
          flush();
          setFor(setBusy, p, false);
          setFor(setStatus, p, "Connection issue");
          if (p === providerRef.current) setActivity("");
          addTo(p, { role: "error", text: e.message, retry: lastAsk.current[p] });
        }
        if (e.type === "login")
          setFor(setStatus, p, e.success ? "Signed in" : "Sign-in failed");
      }),
    [],
  );
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, activity, step]);
  // The elapsed time under the progress line ticks once a second.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => tickClock((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [working]);
  const elapsed = () => {
    const seconds = started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const choose = async (next: Provider) => {
    if (next === provider || working) return;
    setProvider(next);
    setActivity("");
    await window.cutline
      .invoke("assistant.settings.set", { provider: next })
      .catch(report);
  };
  const chooseModel = async (next: "opus" | "sonnet") => {
    setModel(next);
    await window.cutline
      .invoke("assistant.settings.set", { claudeModel: next })
      .catch((e) => {
        report(e);
        setModel(model);
      });
  };
  const connect = async () => {
    const p = provider;
    try {
      setFor(setStatus, p, `Connecting to ${names[p]}…`);
      const result = await window.cutline.invoke(
        status[p].includes("issue") || status[p].includes("failed")
          ? `${p}.reconnect`
          : `${p}.connect`,
      );
      setFor(
        setStatus,
        p,
        result.account ? `Connected to ${names[p]}` : `Sign in to ${names[p]}`,
      );
      if (!result.account) await window.cutline.invoke(`${p}.login`);
    } catch (e) {
      setFor(setStatus, p, "Connection issue");
      report(e);
    }
  };
  /**
   * Sends a request. `shown` is what the chat displays when the assistant
   * gets a longer recipe (a suggestion). The editor's playhead and selection
   * go along, so "here" and "this clip" mean something.
   */
  const send = async (text = input, shown = text) => {
    const p = provider;
    if (!text.trim() || busy[p]) return;
    if (shown === input) setInput("");
    addTo(p, { role: "user", text: shown });
    lastAsk.current[p] = text;
    setFor(setBusy, p, true);
    setActivity("Working on your edit…");
    setStep("");
    setStarted(Date.now());
    const frame = playhead?.get();
    const where =
      frame === undefined
        ? ""
        : `Playhead at ${(frame / fps).toFixed(2)} s (frame ${frame}).`;
    const context = [where, selected ? `Selected clip ID: ${selected}.` : ""]
      .filter(Boolean)
      .join(" ");
    try {
      await window.cutline.invoke(`${p}.send`, {
        text: context ? `${text}\n\n[Editor] ${context}` : text,
      });
    } catch (e) {
      setFor(setBusy, p, false);
      setActivity("");
      addTo(p, { role: "error", text: errorText(e), retry: text });
    }
  };
  const newChat = async () => {
    const p = provider;
    try {
      await window.cutline.invoke(`${p}.newChat`);
      setChats((old) => ({ ...old, [p]: [] }));
      setActivity("");
    } catch (e) {
      report(e);
    }
  };
  const online = (s: string) => s.includes("Connected") || s === "Signed in";
  // Only states that need attention get a line; "connected" shows as a dot.
  const notice =
    !online(status[provider]) &&
    !status[provider].startsWith("Working") &&
    status[provider] !== "Not connected"
      ? status[provider]
      : "";
  return (
    <div className="assistant">
      <div className="assistant-status">
        <div
          className="assistant-providers"
          role="tablist"
          aria-label="Assistant"
        >
          {(["claude", "codex"] as Provider[]).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={provider === p}
              className={provider === p ? "active" : ""}
              disabled={working && provider !== p}
              title={
                working && provider !== p
                  ? "Wait for the current edit to finish"
                  : `${names[p]}: ${status[p]}`
              }
              onClick={() => void choose(p)}
            >
              <i
                className={online(status[p]) ? "online" : ""}
                aria-hidden="true"
              />
              {names[p]}
            </button>
          ))}
        </div>
        <span className="assistant-spacer" />
        {messages.length > 0 && (
          <button
            className="icon-button"
            aria-label="New chat"
            title="New chat"
            disabled={working}
            onClick={() => void newChat()}
          >
            <SquarePen size={15} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label={
            provider === "claude" ? "Connect Claude" : "Connect Codex"
          }
          title={`Connect or reconnect ${name}`}
          disabled={working || status[provider].startsWith("Connecting")}
          onClick={() => void connect()}
        >
          <Plug size={15} />
        </button>
      </div>
      {notice && (
        <div className="assistant-notice" role="status">
          {notice}
        </div>
      )}
      <div className="messages">
        {!messages.length && (
          <div className="assistant-intro">
            <Sparkles size={22} />
            <h3>Create with {name}</h3>
            <p>Every edit lands on your timeline and can be undone.</p>
            <div className="suggestions">
              {suggestions
                .filter((s) => hasVideo || !s.needsVideo)
                .map((s) => (
                  <button
                    key={s.label}
                    disabled={working}
                    onClick={() => void send(s.prompt, s.label)}
                  >
                    {s.label}
                  </button>
                ))}
            </div>
            <p className="privacy-note">
              Original footage stays on your Mac. Prompts, transcripts, project
              details and requested preview images go to {name}.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div className={"message " + m.role} key={i}>
            {/* The bubble shows who spoke; screen readers still hear it. */}
            <span className="sr-only">
              {m.role === "user" ? "You:" : m.role === "assistant" ? `${name}:` : ""}
            </span>
            {m.role === "user" || m.role === "note" ? (
              <p>{m.text}</p>
            ) : m.role === "error" ? (
              <>
                <p>{m.text}</p>
                {m.retry && i === messages.length - 1 && (
                  <button
                    className="message-retry"
                    disabled={working}
                    onClick={() => void send(m.retry!, "Try again")}
                  >
                    Try again
                  </button>
                )}
              </>
            ) : (
              <MessageText text={m.text} />
            )}
          </div>
        ))}
        {working && (
          <div className="thinking" aria-live="polite">
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="thinking-text">
              {step && <strong>{step}</strong>}
              <span>
                {activity || "Working on your edit…"}
                {started ? ` · ${elapsed()}` : ""}
              </span>
            </span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form
        className="prompt"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Ask the editing assistant"
          placeholder={
            selected
              ? "What should change in this clip?"
              : `Describe your edit for ${name}…`
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="prompt-footer">
          <div className="prompt-meta">
            {provider === "claude" && (
              <select
                className="assistant-model"
                aria-label="Claude model"
                title="Opus gives the best results; Sonnet is faster"
                value={model}
                disabled={working}
                onChange={(e) =>
                  void chooseModel(e.target.value as "opus" | "sonnet")
                }
              >
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
              </select>
            )}
            <span>{selected ? "Clip attached" : "Project attached"}</span>
          </div>
          {working ? (
            <button
              type="button"
              className="stop"
              aria-label="Stop assistant"
              onClick={() =>
                window.cutline.invoke(`${provider}.stop`).catch(report)
              }
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send"
              aria-label="Send edit request"
              disabled={!input.trim()}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
