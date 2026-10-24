import React, { useEffect, useRef, useState } from "react";
import { plural } from "../shared/plural";
import {
  Check,
  CircleAlert,
  Download,
  ExternalLink,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { Asset } from "../shared/model";
import type { GenerationInput, GenerationJob } from "../shared/generation";
import { ReferenceImages, type ReferenceImage } from "./ReferenceImages";
import "./generation.css";

type Model = GenerationInput["model"];
type GenerationSettings = {
  configured: boolean;
  secureStorageAvailable: boolean | null;
  storageError?: string;
};
type Reference = ReferenceImage;
type GenerationMode = "text" | "start" | "references";
type JobAction = "refresh" | "cancel" | "recover" | "import" | "place";

const modelName = (model: Model) =>
  model === "seedance-2" ? "Seedance 2.0" : "Kling 3.0";
const statuses: Record<GenerationJob["status"], string> = {
  submitting: "Submitting",
  queued: "Queued",
  in_progress: "Generating",
  completed: "Ready",
  failed: "Failed",
  nsfw: "Blocked by provider",
  canceled: "Canceled",
  unknown: "Needs attention",
};
const pending = (job: GenerationJob) =>
  ["submitting", "queued", "in_progress"].includes(job.status);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const ratioFor = (aspectRatio: string) =>
  ["16:9", "9:16", "1:1"].includes(aspectRatio) ? aspectRatio : "16:9";

export function GenerateLibrary({
  active,
  projectId,
  aspectRatio,
  addBroll,
  report,
}: {
  active: boolean;
  projectId: string;
  aspectRatio: string;
  addBroll: (asset: Asset) => Promise<void>;
  report: (error: unknown) => void;
}) {
  const api = window.cutline;
  const [settings, setSettings] = useState<GenerationSettings>();
  const [key, setKey] = useState("");
  const [configuring, setConfiguring] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<Model>("seedance-2");
  const [duration, setDuration] = useState(5);
  const [ratio, setRatio] = useState(() => ratioFor(aspectRatio));
  const [resolution, setResolution] = useState("720p");
  const [audio, setAudio] = useState(false);
  const [reference, setReference] = useState<Reference>();
  const [references, setReferences] = useState<Reference[]>([]);
  const [mode, setMode] = useState<GenerationMode>("text");
  const [choosingReference, setChoosingReference] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [actions, setActions] = useState<Record<string, JobAction>>({});
  const [imported, setImported] = useState<Record<string, Asset>>({});
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [jobErrors, setJobErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  const activeRef = useRef(active);
  const projectRef = useRef(projectId);
  const jobsRef = useRef(jobs);
  const actionLocks = useRef(new Set<string>());
  const submitLock = useRef(false);
  const pollLock = useRef(false);
  const loadVersion = useRef(0);
  const promptField = useRef<HTMLTextAreaElement>(null);
  activeRef.current = active;
  projectRef.current = projectId;
  jobsRef.current = jobs;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadVersion.current++;
    };
  }, []);

  useEffect(() => {
    setRatio(ratioFor(aspectRatio));
    setMessage("");
    setFormError("");
  }, [projectId, aspectRatio]);

  async function loadHistory() {
    const version = ++loadVersion.current;
    const result: GenerationJob[] = await api.invoke("generation.list");
    if (mounted.current && version === loadVersion.current) {
      setJobs(result);
      setHistoryError("");
    }
  }

  useEffect(() => {
    if (!active) return;
    let canceled = false;
    setLoading(true);
    void Promise.allSettled([
      api.invoke("generation.settings").then((value: GenerationSettings) => {
        if (!canceled && mounted.current) {
          setSettings(value);
          setConnectionError("");
        }
      }),
      loadHistory(),
    ]).then(([connection, history]) => {
      if (canceled || !mounted.current) return;
      if (connection.status === "rejected")
        setConnectionError(errorText(connection.reason));
      if (history.status === "rejected")
        setHistoryError(errorText(history.reason));
      setLoading(false);
    });
    return () => {
      canceled = true;
    };
  }, [active, projectId]);

  function updateJob(job: GenerationJob) {
    if (!mounted.current) return;
    setJobs((previous) => {
      const next = previous.some((item) => item.id === job.id)
        ? previous.map((item) => (item.id === job.id ? job : item))
        : [job, ...previous];
      jobsRef.current = next;
      return next;
    });
  }

  useEffect(() => {
    if (!active || !settings?.configured) return;
    let canceled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      if (canceled || !activeRef.current) return;
      if (!pollLock.current) {
        pollLock.current = true;
        try {
          for (const job of jobsRef.current) {
            if (canceled || !activeRef.current) break;
            if (
              job.projectId !== projectRef.current ||
              !pending(job) ||
              !job.requestId ||
              actionLocks.current.has(job.id)
            )
              continue;
            // Polling must not swallow an explicit Cancel click. The main process
            // coordinates actions; pollLock only prevents overlapping poll loops.
            try {
              const result: GenerationJob = await api.invoke(
                "generation.refresh",
                { id: job.id },
              );
              updateJob(result);
              if (mounted.current)
                setJobErrors((previous) => ({ ...previous, [job.id]: "" }));
            } catch (error) {
              if (mounted.current)
                setJobErrors((previous) => ({
                  ...previous,
                  [job.id]: `Status check failed. ${errorText(error)}`,
                }));
            }
          }
        } finally {
          pollLock.current = false;
        }
      }
      if (!canceled) timeout = setTimeout(() => void poll(), 5000);
    }
    timeout = setTimeout(() => void poll(), 5000);
    return () => {
      canceled = true;
      clearTimeout(timeout);
    };
  }, [active, settings?.configured, projectId]);

  async function configure(disconnect = false) {
    if (configuring || (!disconnect && !key.trim())) return;
    setConfiguring(true);
    setConnectionError("");
    try {
      const value: GenerationSettings = await api.invoke(
        disconnect ? "generation.disconnect" : "generation.configure",
        disconnect ? undefined : { key: key.trim() },
      );
      if (mounted.current) {
        setSettings(value);
        setKey("");
        setMessage(
          disconnect
            ? "Higgsfield key removed from this Mac."
            : "Higgsfield API key saved on this Mac.",
        );
      }
    } catch (error) {
      if (mounted.current) setConnectionError(errorText(error));
    } finally {
      if (mounted.current) {
        setKey("");
        setConfiguring(false);
      }
    }
  }

  async function chooseReference(multiple = false) {
    const targetProject = projectId;
    setChoosingReference(true);
    setFormError("");
    try {
      const result: Reference | Reference[] | null = await api.invoke(
        multiple ? "generation.pickReferences" : "generation.pickReference",
      );
      if (mounted.current && projectRef.current === targetProject && result) {
        if (Array.isArray(result)) {
          const next = [...references, ...result].filter(
            (image, index, all) =>
              all.findIndex((item) => item.id === image.id) === index,
          );
          if (next.length > 9)
            throw new Error(
              `Up to 9 reference images fit in one shot. Choose ${9 - references.length} or fewer additional images.`,
            );
          setReferences(next);
        } else setReference(result);
      }
    } catch (error) {
      if (mounted.current && projectRef.current === targetProject)
        setFormError(errorText(error));
    } finally {
      if (mounted.current) setChoosingReference(false);
    }
  }

  async function submit() {
    if (
      submitLock.current ||
      choosingReference ||
      !settings?.configured ||
      !prompt.trim() ||
      (model === "seedance-2" &&
        ((mode === "start" && !reference) ||
          (mode === "references" && !references.length))) ||
      prompt.length > (model === "kling-3" ? 2500 : 5000)
    )
      return;
    submitLock.current = true;
    setSubmitting(true);
    setFormError("");
    setMessage("");
    const targetProject = projectId;
    try {
      const job: GenerationJob = await api.invoke("generation.submit", {
        projectId: targetProject,
        prompt: prompt.trim(),
        model,
        duration,
        aspectRatio: ratio,
        resolution,
        audio,
        clientId: crypto.randomUUID(),
        ...(reference && model === "seedance-2" && mode === "start"
          ? { referenceId: reference.id }
          : {}),
        ...(model === "seedance-2" && mode === "references"
          ? { referenceIds: references.map((image) => image.id) }
          : {}),
      });
      updateJob(job);
      if (mounted.current && projectRef.current === targetProject)
        setMessage(
          job.status === "unknown"
            ? "Check the request below before generating again."
            : "Request saved. You can keep editing while the video generates.",
        );
    } catch (error) {
      if (mounted.current && projectRef.current === targetProject)
        setFormError(errorText(error));
      try {
        await loadHistory();
      } catch (historyFailure) {
        if (mounted.current) setHistoryError(errorText(historyFailure));
      }
    } finally {
      submitLock.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  async function act(job: GenerationJob, action: JobAction) {
    if (actionLocks.current.has(job.id)) return;
    actionLocks.current.add(job.id);
    setActions((previous) => ({ ...previous, [job.id]: action }));
    setJobErrors((previous) => ({ ...previous, [job.id]: "" }));
    const targetProject = projectId;
    try {
      if (action === "import" || action === "place") {
        const asset: Asset = await api.invoke("generation.import", {
          id: job.id,
          projectId: targetProject,
        });
        if (mounted.current)
          setImported((previous) => ({ ...previous, [job.id]: asset }));
        if (action === "place") {
          if (projectRef.current !== targetProject)
            throw new Error(
              "The project changed. Open the original project to add this clip at the playhead.",
            );
          await addBroll(asset);
        }
        if (mounted.current && projectRef.current === targetProject)
          setMessage(
            action === "place"
              ? "Muted B-roll added at the playhead."
              : "Video imported to your media library.",
          );
      } else {
        const result: GenerationJob = await api.invoke(`generation.${action}`, {
          id: job.id,
        });
        updateJob(result);
      }
    } catch (error) {
      if (mounted.current)
        setJobErrors((previous) => ({
          ...previous,
          [job.id]: errorText(error),
        }));
    } finally {
      actionLocks.current.delete(job.id);
      if (mounted.current)
        setActions((previous) => {
          const next = { ...previous };
          delete next[job.id];
          return next;
        });
    }
  }

  const projectJobs = jobs
    .filter((job) => job.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const waiting = projectJobs.filter(pending).length;
  const uncertain = projectJobs.some((job) => job.status === "unknown");
  const maxPromptLength = model === "kling-3" ? 2500 : 5000;
  const promptTooLong = prompt.length > maxPromptLength;
  const open = (
    name: "generation.openKeys" | "generation.openDashboard",
    id?: string,
  ) => void api.invoke(name, id ? { id } : undefined).catch(report);

  return (
    <div className="library-content generation-library">
      <div className="section-heading generation-heading">
        <span>Generate video</span>
        <button
          className="generation-provider"
          onClick={() => open("generation.openDashboard")}
        >
          Higgsfield <ExternalLink size={11} aria-hidden="true" />
        </button>
      </div>
      <p className="generation-intro">
        Create a clip, then bring it into your edit.
      </p>

      <div className="generation-connect">
        {settings?.configured ? (
          <div className="generation-connected">
            <span>
              <Check size={13} aria-hidden="true" /> API key saved
            </span>
            <button
              disabled={configuring || submitting}
              onClick={() => void configure(true)}
            >
              {configuring ? "Removing…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void configure();
            }}
          >
            <label className="generation-field">
              <span>
                <KeyRound size={13} aria-hidden="true" /> Higgsfield API key
              </span>
              <input
                type="password"
                aria-label="Higgsfield API key"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste your complete API key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                disabled={configuring}
                aria-describedby="generation-key-hint"
              />
            </label>
            <p id="generation-key-hint" className="generation-note">
              Saved encrypted on this Mac. Requires Higgsfield API credits.
            </p>
            <div className="generation-connect-actions">
              <button type="button" onClick={() => open("generation.openKeys")}>
                Get an API key <ExternalLink size={11} aria-hidden="true" />
              </button>
              <button
                type="submit"
                className="control"
                disabled={loading || configuring || !key.trim()}
              >
                {configuring ? (
                  <LoaderCircle size={13} className="spin" aria-hidden="true" />
                ) : (
                  <KeyRound size={13} aria-hidden="true" />
                )}
                {configuring ? "Connecting…" : "Connect Higgsfield"}
              </button>
            </div>
          </form>
        )}
        {(connectionError ||
          settings?.storageError ||
          settings?.secureStorageAvailable === false) && (
          <p className="generation-error" role="alert">
            {connectionError ||
              settings?.storageError ||
              "Unlock your macOS keychain to save an API key securely."}
          </p>
        )}
      </div>

      <form
        className="generation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="generation-field generation-prompt">
          <span>Prompt</span>
          <textarea
            ref={promptField}
            aria-label="Prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="A slow push through a sunlit coffee shop, steam rising from a ceramic cup…"
            rows={4}
            maxLength={maxPromptLength}
            required
            disabled={submitting}
            aria-describedby="generation-prompt-hint"
            aria-invalid={promptTooLong || undefined}
          />
        </label>
        <p
          className={promptTooLong ? "generation-error" : "generation-note"}
          id="generation-prompt-hint"
        >
          {promptTooLong
            ? `${modelName(model)} prompts must be ${maxPromptLength.toLocaleString()} characters or fewer. Shorten your prompt to continue.`
            : "Describe the subject, movement, and camera."}
        </p>
        <div className="generation-options">
          <label className="generation-field generation-model">
            <span>Model</span>
            <select
              aria-label="Model"
              value={model}
              disabled={submitting || choosingReference}
              onChange={(event) => {
                const next = event.target.value as Model;
                setModel(next);
                setDuration((previous) =>
                  Math.max(previous, next === "seedance-2" ? 4 : 3),
                );
                if (next === "kling-3") {
                  setReference(undefined);
                  setReferences([]);
                  setMode("text");
                  setResolution("720p");
                }
              }}
            >
              <option value="seedance-2">Seedance 2.0</option>
              <option value="kling-3">Kling 3.0</option>
            </select>
          </label>
          <label className="generation-field">
            <span>Duration</span>
            <select
              aria-label="Duration"
              value={duration}
              disabled={submitting}
              onChange={(event) => setDuration(Number(event.target.value))}
            >
              {Array.from(
                { length: model === "seedance-2" ? 12 : 13 },
                (_, index) => index + (model === "seedance-2" ? 4 : 3),
              ).map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} seconds
                </option>
              ))}
            </select>
          </label>
          {model === "seedance-2" && (
            <label className="generation-field">
              <span>Resolution</span>
              <select
                aria-label="Resolution"
                value={resolution}
                disabled={submitting}
                onChange={(event) => setResolution(event.target.value)}
              >
                {["480p", "720p", "1080p", "4k"].map((value) => (
                  <option key={value} value={value}>
                    {value === "4k" ? "4K" : value}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!(model === "seedance-2" && mode === "start") && (
            <label className="generation-field generation-ratio">
              <span>Aspect ratio</span>
              <select
                aria-label="Aspect ratio"
                value={ratio}
                disabled={submitting}
                onChange={(event) => setRatio(event.target.value)}
              >
                <option value="16:9">16:9 · Landscape</option>
                <option value="9:16">9:16 · Vertical</option>
                <option value="1:1">1:1 · Square</option>
              </select>
            </label>
          )}
        </div>
        {model === "seedance-2" && (
          <div className="generation-reference">
            <label className="generation-field">
              <span>Visual input</span>
              <select
                aria-label="Visual input"
                value={mode}
                disabled={submitting || choosingReference}
                onChange={(event) =>
                  setMode(event.target.value as GenerationMode)
                }
              >
                <option value="text">Text prompt only</option>
                <option value="start">Starting frame</option>
                <option value="references">Reference images</option>
              </select>
            </label>
            {mode === "start" && reference ? (
              <>
                <ReferenceImages
                  images={[reference]}
                  label="Starting frame"
                  disabled={submitting || choosingReference}
                  onRemove={() => setReference(undefined)}
                />
                <p className="generation-note">
                  Starts from this image and uses its aspect ratio. Uploaded
                  when you generate.
                </p>
              </>
            ) : mode === "start" ? (
              <button
                type="button"
                className="generation-reference-button"
                disabled={submitting || choosingReference}
                onClick={() => void chooseReference()}
              >
                {choosingReference ? (
                  <LoaderCircle size={14} className="spin" aria-hidden="true" />
                ) : (
                  <ImagePlus size={14} aria-hidden="true" />
                )}
                {choosingReference ? "Choosing image…" : "Add start image"}
              </button>
            ) : null}
            {mode === "references" && (
              <>
                <div className="generation-reference-heading">
                  <span>Characters, wardrobe, places, or style</span>
                  <strong>{references.length} / 9</strong>
                </div>
                <ReferenceImages
                  images={references}
                  label="Video reference images"
                  disabled={submitting || choosingReference}
                  onRemove={(id) =>
                    setReferences((previous) =>
                      previous.filter((image) => image.id !== id),
                    )
                  }
                  onMove={(id, delta) =>
                    setReferences((previous) => {
                      const next = [...previous];
                      const from = next.findIndex((image) => image.id === id);
                      const to = from + delta;
                      if (from >= 0 && to >= 0 && to < next.length)
                        [next[from], next[to]] = [next[to], next[from]];
                      return next;
                    })
                  }
                />
                <button
                  type="button"
                  className="generation-reference-button"
                  disabled={
                    submitting || choosingReference || references.length >= 9
                  }
                  onClick={() => void chooseReference(true)}
                >
                  {choosingReference ? (
                    <LoaderCircle
                      size={14}
                      className="spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <ImagePlus size={14} aria-hidden="true" />
                  )}
                  {choosingReference
                    ? "Choosing images…"
                    : "Add reference images"}
                </button>
                <p className="generation-note">
                  Guide the look of your shot with up to 9 images. Describe each
                  image’s role in the prompt, in the order shown. Reference
                  images do not fix the starting frame. Images stay on this Mac
                  until you generate.
                </p>
              </>
            )}
          </div>
        )}
        <label className="generation-audio">
          <input
            type="checkbox"
            aria-label="Generate audio"
            checked={audio}
            disabled={submitting}
            onChange={(event) => setAudio(event.target.checked)}
          />
          <span>Generate audio</span>
        </label>
        <p className="generation-note generation-cost" id="generation-cost">
          Uses your Higgsfield API credits. Your prompt
          {model === "seedance-2" && mode !== "text"
            ? " and selected images are"
            : " is"}{" "}
          sent to Higgsfield when you generate. Pricing varies by model and
          settings.
        </p>
        {formError && (
          <p className="generation-error" role="alert">
            {formError}
          </p>
        )}
        {uncertain && (
          <p className="generation-warning">
            A previous request needs attention. Recover it or check your
            Higgsfield dashboard before generating again.
          </p>
        )}
        <button
          type="submit"
          className="primary generation-submit"
          disabled={
            !settings?.configured ||
            submitting ||
            !prompt.trim() ||
            promptTooLong ||
            choosingReference ||
            (model === "seedance-2" &&
              ((mode === "start" && !reference) ||
                (mode === "references" && !references.length)))
          }
          aria-describedby="generation-cost"
        >
          {submitting ? (
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
          ) : (
            <Sparkles size={15} aria-hidden="true" />
          )}
          {submitting ? "Submitting request…" : "Generate video"}
        </button>
        {!settings?.configured && (
          <p className="generation-note generation-connect-hint">
            Connect your API key above to generate.
          </p>
        )}
      </form>

      {message && (
        <p className="generation-message" role="status">
          {message}
        </p>
      )}

      <section className="generation-history" aria-label="Generation history">
        <div className="generation-history-heading">
          <h3>This project</h3>
          <span>
            {waiting
              ? `${waiting} in progress`
              : `${projectJobs.length} ${projectJobs.length === 1 ? "video" : "videos"}`}
          </span>
        </div>
        {loading && (
          <p className="generation-loading" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden="true" />{" "}
            Loading requests…
          </p>
        )}
        {historyError && (
          <div className="generation-error" role="alert">
            <p>{historyError}</p>
            <button
              onClick={() =>
                void loadHistory().catch((error) =>
                  setHistoryError(errorText(error)),
                )
              }
            >
              <RefreshCw size={13} aria-hidden="true" /> Reload history
            </button>
          </div>
        )}
        {!loading && !projectJobs.length && !historyError && (
          <p className="generation-empty">
            Your generated videos appear here. Import a finished clip to media,
            then add it at the playhead.
          </p>
        )}
        <div className="generation-jobs">
          {projectJobs.map((job) => {
            const action = actions[job.id];
            const busy = Boolean(action);
            const isImported = Boolean(imported[job.id]);
            const isUnknown =
              job.status === "unknown" ||
              (job.status === "submitting" && !job.requestId && !submitting);
            const timestamp = new Date(job.createdAt);
            const validTime = !Number.isNaN(timestamp.getTime());
            return (
              <article
                className={`generation-job generation-job-${job.status}`}
                key={job.id}
                aria-label={`${modelName(job.model)} video: ${job.prompt}`}
              >
                <div className="generation-job-heading">
                  <span
                    className={`generation-status ${isUnknown ? "generation-needs-attention" : ""}`}
                  >
                    {isUnknown ? (
                      <CircleAlert size={12} aria-hidden="true" />
                    ) : pending(job) ? (
                      <LoaderCircle
                        size={12}
                        className="spin"
                        aria-hidden="true"
                      />
                    ) : job.status === "completed" ? (
                      <Check size={12} aria-hidden="true" />
                    ) : null}
                    {isUnknown
                      ? "Needs attention"
                      : isImported
                        ? "In media"
                        : statuses[job.status]}
                  </span>
                  {validTime && (
                    <time
                      dateTime={timestamp.toISOString()}
                      title={timestamp.toLocaleString()}
                    >
                      {timestamp.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  )}
                </div>
                <p className="generation-job-prompt" title={job.prompt}>
                  {job.prompt}
                </p>
                <p className="generation-job-meta">
                  {modelName(job.model)} · {job.duration}s
                  {job.model === "seedance-2"
                    ? ` · ${job.resolution === "4k" ? "4K" : job.resolution}`
                    : ""}{" "}
                  ·{" "}
                  {job.referenceNames?.length
                    ? `${job.aspectRatio} · ${plural(job.referenceNames.length, "reference")}`
                    : job.referenceName
                      ? "Image to video"
                      : job.aspectRatio}
                  {job.audio ? " · Audio" : ""}
                </p>
                {job.referenceName && (
                  <p
                    className="generation-job-reference"
                    title={job.referenceName}
                  >
                    Start image: {job.referenceName}
                  </p>
                )}
                {!!job.referenceNames?.length && (
                  <p
                    className="generation-job-reference"
                    title={job.referenceNames.join(" · ")}
                  >
                    References: {job.referenceNames.join(" · ")}
                  </p>
                )}
                {isUnknown && (
                  <p className="generation-warning">
                    The provider may have received this request. Recover checks
                    the same request without creating a new generation.
                  </p>
                )}
                {job.status === "nsfw" && !job.error && (
                  <p className="generation-error">
                    Higgsfield blocked this request. Edit the prompt before
                    trying again.
                  </p>
                )}
                {(jobErrors[job.id] || job.error) && (
                  <p className="generation-error" role="status">
                    {jobErrors[job.id] || job.error}
                  </p>
                )}
                <div className="generation-job-actions">
                  {job.status === "completed" && (
                    <button
                      className="control"
                      disabled={busy}
                      onClick={() =>
                        void act(job, isImported ? "place" : "import")
                      }
                    >
                      {busy ? (
                        <LoaderCircle
                          size={13}
                          className="spin"
                          aria-hidden="true"
                        />
                      ) : isImported ? (
                        <Plus size={13} aria-hidden="true" />
                      ) : (
                        <Download size={13} aria-hidden="true" />
                      )}
                      {action === "place"
                        ? "Adding…"
                        : action === "import"
                          ? "Importing…"
                          : isImported
                            ? "Add at playhead"
                            : "Import to media"}
                    </button>
                  )}
                  {isUnknown && (
                    <button
                      className="control"
                      disabled={busy || !settings?.configured}
                      onClick={() => void act(job, "recover")}
                    >
                      <RefreshCw
                        size={13}
                        className={action === "recover" ? "spin" : ""}
                        aria-hidden="true"
                      />{" "}
                      {action === "recover" ? "Recovering…" : "Recover request"}
                    </button>
                  )}
                  {!isUnknown && pending(job) && job.requestId && (
                    <button
                      disabled={busy || !settings?.configured}
                      onClick={() => void act(job, "refresh")}
                    >
                      <RefreshCw
                        size={12}
                        className={action === "refresh" ? "spin" : ""}
                        aria-hidden="true"
                      />{" "}
                      {action === "refresh" ? "Checking…" : "Check status"}
                    </button>
                  )}
                  {job.status === "queued" && (
                    <button
                      disabled={busy || !settings?.configured}
                      onClick={() => void act(job, "cancel")}
                    >
                      {action === "cancel" ? "Canceling…" : "Cancel"}
                    </button>
                  )}
                  {isUnknown && (
                    <button
                      onClick={() => open("generation.openDashboard", job.id)}
                    >
                      Dashboard <ExternalLink size={11} aria-hidden="true" />
                    </button>
                  )}
                  {["failed", "nsfw", "canceled"].includes(job.status) && (
                    <button
                      disabled={submitting}
                      onClick={() => {
                        setPrompt(job.prompt);
                        setFormError("");
                        promptField.current?.focus();
                      }}
                    >
                      Edit prompt
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
