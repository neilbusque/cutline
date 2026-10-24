import React, { useEffect, useRef, useState } from "react";
import { plural } from "../shared/plural";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Captions,
  Check,
  Clapperboard,
  Download,
  Film,
  ImagePlus,
  LoaderCircle,
  Mic2,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import type { Asset, Job, Project } from "../shared/model";
import type { GenerationJob } from "../shared/generation";
import {
  createStoryFromScript,
  createProductStory,
  storyNarrationSignature,
} from "../shared/story";
import { sceneNeedsMedia } from "../shared/product-scenes";
import { createExplainerStory, type ExplainerInput } from "../shared/explainer";
import {
  StoryPlanSchema,
  StorySceneSchema,
  STORY_REFERENCE_LIMIT,
  mergedStoryReferenceIds,
  type StoryPlan,
  type StoryScene,
} from "../shared/story-schema";
import { captionStyles } from "../shared/caption-styles";
import { speechVoices, type SpeechVoice, type TtsStatus } from "../shared/tts";
import { ReferenceImages, type ReferenceImage } from "./ReferenceImages";
import {
  ProductCopyEditor,
  ProductFilmSetup,
  ProductLayoutPicker,
  ProductScenePreview,
} from "./ProductStory";
import {
  ExplainerStory,
  explainerInputFromStory,
  refreshExplainerInput,
} from "./ExplainerStory";
import { errorText } from "./controls";
import { GENERATION_SETTINGS_EVENT } from "./HiggsfieldSettings";
import "./story.css";

type Props = {
  project: Project;
  base: string;
  jobs: Job[];
  active: boolean;
  missing?: string[];
  importMedia: () => void;
  openGenerate: () => void;
  openCaptions: () => void;
  /** Higgsfield is connected in Settings, like the other keys. */
  openSettings: () => void;
  onCreated: (frame: number) => void;
  report: (error: unknown) => void;
  onAskAssistant?: (prompt: string) => void;
};
type Editor = {
  projectId: string;
  draft: StoryPlan;
  baseline: string;
  revision: number;
  dirty: boolean;
};
type ExplainerForm = {
  projectId: string;
  input: ExplainerInput;
  baseline: ExplainerInput;
};
function formFromStory(projectId: string, story: StoryPlan): ExplainerForm {
  const input = explainerInputFromStory(story);
  return { projectId, input, baseline: input };
}
type BuildResult = {
  startFrame: number;
  durationFrames: number;
  sceneCount: number;
  captionCount: number;
  warnings: string[];
};
type Template = "story" | "explainer" | "promo";
const templates: { id: Template; name: string; script: string }[] = [
  {
    id: "story",
    name: "Story arc",
    script:
      "In a forest that never sees daylight, a young ninja hears a call for help.\n\nThe only path forward lies beyond a rushing stream. One deep breath. One leap.\n\nOn the other side, a tiny lantern is still burning. Even the smallest light can lead the way home.",
  },
  {
    id: "explainer",
    name: "Explainer",
    script:
      "A strong video starts with one clear idea.\n\nBreak that idea into three moments: what matters, how it works, and what changes.\n\nGive each moment one visual and one simple line. Then bring the story together.",
  },
  {
    id: "promo",
    name: "Product story",
    script:
      "Your next idea deserves more than a blank timeline.\n\nPlan the story, find the right shots, and give every scene a voice.\n\nBring it all together. Make something worth watching.",
  },
];
const storyOf = (project: Project) =>
  project.story ?? StoryPlanSchema.parse({});
const serialized = (story: StoryPlan) => JSON.stringify(story);
const hasCaptionTiming = (asset?: Asset) =>
  !!asset?.words?.some(
    (word) =>
      word.text.trim() &&
      word.start >= 0 &&
      word.end > word.start &&
      word.start < asset.duration &&
      word.end <= asset.duration,
  );
const isPending = (job?: GenerationJob) =>
  !!job && ["submitting", "queued", "in_progress"].includes(job.status);
const generationLabels: Record<GenerationJob["status"], string> = {
  submitting: "Submitting shot",
  queued: "Shot queued",
  in_progress: "Generating shot",
  completed: "Shot ready",
  failed: "Generation failed",
  nsfw: "Provider blocked this shot",
  canceled: "Generation canceled",
  unknown: "Generation needs attention",
};

export function StoryLibrary({
  project,
  base,
  jobs,
  active,
  missing = [],
  importMedia,
  openGenerate,
  openCaptions,
  openSettings,
  onCreated,
  report,
  onAskAssistant,
}: Props) {
  const api = window.cutline;
  const [editor, setEditor] = useState<Editor>(() => ({
    projectId: project.id,
    draft: storyOf(project),
    baseline: serialized(storyOf(project)),
    revision: project.revision,
    dirty: false,
  }));
  const [step, setStep] = useState(0);
  const [script, setScript] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<BuildResult>();
  const [voiceStatus, setVoiceStatus] = useState<TtsStatus>();
  const [configured, setConfigured] = useState<boolean>();
  const [generations, setGenerations] = useState<GenerationJob[]>([]);
  const [pollError, setPollError] = useState("");
  const [voiceCheckError, setVoiceCheckError] = useState("");
  const [generationCheckError, setGenerationCheckError] = useState("");
  const [replaceScript, setReplaceScript] = useState(false);
  const [discardedDraft, setDiscardedDraft] = useState<Editor>();
  const [explainerForm, setExplainerForm] = useState<ExplainerForm>(() =>
    formFromStory(project.id, storyOf(project)),
  );
  const explainerForms = useRef(new Map<string, ExplainerForm>());
  const cache = useRef(new Map<string, Editor>());
  const state = useRef({ project, editor, active });
  const mounted = useRef(true);
  const lock = useRef(false);
  const pollLock = useRef(false);
  const epoch = useRef(0);
  const generationRef = useRef(generations);
  generationRef.current = generations;
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const audio = useRef<HTMLAudioElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const production = useRef<Job | undefined>(undefined);
  production.current = [...jobs]
    .reverse()
    .find((job) => job.kind === "story-produce" && job.state === "running");
  explainerForms.current.set(explainerForm.projectId, explainerForm);
  if (explainerForms.current.size > 20) {
    const oldest = [...explainerForms.current.entries()].find(
      ([id, form]) =>
        id !== project.id &&
        JSON.stringify(form.input) === JSON.stringify(form.baseline),
    );
    if (oldest) explainerForms.current.delete(oldest[0]);
  }
  state.current = { project, editor, active };
  cache.current.delete(editor.projectId);
  cache.current.set(editor.projectId, editor);
  if (cache.current.size > 20) {
    const discard = [...cache.current.entries()].find(
      ([id, entry]) => id !== editor.projectId && !entry.dirty,
    );
    if (discard) cache.current.delete(discard[0]);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);

  useEffect(() => {
    epoch.current++;
    lock.current = false;
    setAction("");
    setError("");
    setNotice("");
    setPollError("");
    setResult(undefined);
    setScript("");
    setStep(0);
    setReplaceScript(false);
    setDiscardedDraft(undefined);
    setSelectedId("");
    setExplainerForm(
      explainerForms.current.get(project.id) ??
        formFromStory(
          project.id,
          cache.current.get(project.id)?.draft ?? storyOf(project),
        ),
    );
    setEditor((previous) => {
      if (previous.projectId === project.id) return previous;
      const cached = cache.current.get(project.id);
      if (cached?.dirty) return cached;
      const story = storyOf(project);
      return {
        projectId: project.id,
        draft: story,
        baseline: serialized(story),
        revision: project.revision,
        dirty: false,
      };
    });
  }, [project.id]);

  useEffect(() => {
    setEditor((previous) => {
      if (
        previous.projectId !== project.id ||
        previous.dirty ||
        project.revision < previous.revision
      )
        return previous;
      const story = storyOf(project);
      if (
        serialized(story) === previous.baseline &&
        project.revision === previous.revision
      )
        return previous;
      return {
        ...previous,
        draft: story,
        baseline: serialized(story),
        revision: project.revision,
      };
    });
  }, [project.id, project.revision, project.story]);

  useEffect(() => {
    if (!active) audio.current?.pause();
  }, [active]);
  useEffect(() => {
    if (editor.projectId !== project.id) return;
    const source = explainerInputFromStory(editor.draft);
    setExplainerForm((previous) => {
      if (previous.projectId !== project.id) return previous;
      if (JSON.stringify(source) === JSON.stringify(previous.baseline))
        return previous;
      return {
        ...previous,
        input: refreshExplainerInput(previous.input, previous.baseline, source),
        baseline: source,
      };
    });
  }, [editor.projectId, editor.draft, project.id]);
  useEffect(() => {
    panel.current?.scrollTo({ top: 0 });
  }, [step]);

  // Connecting Higgsfield in Settings shows here at once.
  useEffect(() => {
    const refresh = () =>
      void api
        .invoke("generation.settings")
        .then((value: { configured: boolean }) => {
          if (!mounted.current) return;
          setConfigured(value.configured);
          setGenerationCheckError("");
        })
        .catch(() => {});
    window.addEventListener(GENERATION_SETTINGS_EVENT, refresh);
    return () => window.removeEventListener(GENERATION_SETTINGS_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (!active) return;
    let canceled = false;
    void Promise.allSettled([
      api.invoke("tts.status"),
      api.invoke("generation.settings"),
      api.invoke("generation.list"),
    ]).then(([voice, connection, history]) => {
      if (canceled || !mounted.current) return;
      if (voice.status === "fulfilled") {
        setVoiceStatus(voice.value);
        setVoiceCheckError("");
      } else setVoiceCheckError(errorText(voice.reason));
      if (connection.status === "fulfilled") {
        setConfigured(connection.value.configured);
        setGenerationCheckError("");
      } else setGenerationCheckError(errorText(connection.reason));
      if (history.status === "fulfilled") setGenerations(history.value);
    });
    return () => {
      canceled = true;
    };
  }, [active, project.id]);

  useEffect(() => {
    if (!active) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const current = state.current;
      if (canceled || !current.active) return;
      if (
        !pollLock.current &&
        !lock.current &&
        !production.current &&
        !current.editor.dirty
      ) {
        const scenes = current.editor.draft.scenes.filter((scene) => {
          const generation = generationRef.current.find(
            (job) => job.id === scene.generationId,
          );
          return (
            scene.generationId &&
            scene.assetId !== scene.generationId &&
            (!generation ||
              isPending(generation) ||
              generation.status === "completed")
          );
        });
        if (scenes.length) {
          pollLock.current = true;
          const projectId = current.project.id;
          try {
            for (const scene of scenes) {
              if (
                canceled ||
                state.current.editor.dirty ||
                state.current.project.id !== projectId ||
                lock.current ||
                production.current
              )
                break;
              const reply = await api.invoke("story.refresh", {
                projectId,
                sceneId: scene.id,
              });
              if (!canceled && state.current.project.id === projectId) {
                if (reply.generation) updateGeneration(reply.generation);
                setPollError("");
              }
            }
          } catch (failure) {
            if (!canceled && state.current.project.id === projectId)
              setPollError(errorText(failure));
          } finally {
            pollLock.current = false;
          }
        }
      }
      if (!canceled) timer = setTimeout(() => void tick(), 5000);
    };
    timer = setTimeout(() => void tick(), 5000);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [active, project.id]);

  function updateGeneration(generation: GenerationJob) {
    setGenerations((previous) => [
      generation,
      ...previous.filter((item) => item.id !== generation.id),
    ]);
  }
  function change(update: (draft: StoryPlan) => StoryPlan) {
    if (lock.current || production.current) return;
    setEditor((previous) => ({
      ...previous,
      draft: update(previous.draft),
      dirty: true,
    }));
    setResult(undefined);
    setNotice("");
    setError("");
  }
  function updateScene(id: string, patch: Partial<StoryScene>) {
    change((draft) => ({
      ...draft,
      scenes: draft.scenes.map((scene) =>
        scene.id === id ? { ...scene, ...patch } : scene,
      ),
    }));
  }
  function moveScene(id: string, delta: number) {
    change((draft) => {
      const scenes = [...draft.scenes];
      const from = scenes.findIndex((scene) => scene.id === id);
      const to = from + delta;
      if (to >= 0 && to < scenes.length)
        [scenes[from], scenes[to]] = [scenes[to], scenes[from]];
      return { ...draft, scenes };
    });
  }
  function addScene() {
    const scene = StorySceneSchema.parse({
      id: crypto.randomUUID(),
      title: `Scene ${editor.draft.scenes.length + 1}`,
      narration: "",
      visualPrompt: "",
      duration: 5,
    });
    change((draft) => ({ ...draft, scenes: [...draft.scenes, scene] }));
    setSelectedId(scene.id);
  }
  function splitScript(text: string, template: Template = "story") {
    try {
      const created = createStoryFromScript(text, template);
      if (editor.draft.scenes.length) setDiscardedDraft(editor);
      change((draft) => ({
        ...draft,
        scenes: created.scenes,
        explainer: undefined,
        ...(draft.brief ? {} : { brief: created.brief }),
      }));
      setSelectedId(created.scenes[0]?.id ?? "");
      setReplaceScript(false);
      setScript("");
      setNotice(
        "Your script is split into scenes. Refine each visual before generating.",
      );
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  function applyProductRecipe(style: "launch" | "walkthrough" | "type-led") {
    const created = createProductStory(style, editor.draft.brand?.name);
    if (editor.draft.scenes.length) setDiscardedDraft(editor);
    change((draft) => ({
      ...draft,
      ...created,
      brand: draft.brand ?? created.brand,
      voice: draft.voice,
      speed: draft.speed,
      captions: draft.captions,
      captionStyle: draft.captionStyle,
      referenceAssetIds: draft.referenceAssetIds,
      musicAssetId: draft.musicAssetId,
      assembly: draft.assembly,
      explainer: undefined,
    }));
    setSelectedId(created.scenes[0]?.id ?? "");
    setReplaceScript(false);
    setScript("");
    setNotice(
      "Product film draft ready. Edit the copy, add your screens in Produce, then build the sequence.",
    );
  }
  function applyExplainer(input: ExplainerInput) {
    try {
      const currentInput = refreshExplainerInput(
        input,
        explainerForm.baseline,
        explainerInputFromStory(editor.draft),
      );
      const created = createExplainerStory(currentInput, editor.draft);
      if (editor.draft.scenes.length) setDiscardedDraft(editor);
      change(() => created);
      setExplainerForm(formFromStory(project.id, created));
      setSelectedId(created.scenes[0]?.id ?? "");
      setReplaceScript(false);
      setScript("");
      setNotice(
        "Outline ready. Review the scenes, then create your explainer with local narration and captions.",
      );
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  async function run(name: string, operation: () => Promise<void>) {
    if (lock.current || production.current) return;
    lock.current = true;
    const requestEpoch = epoch.current;
    const projectId = project.id;
    const earlierJobs = new Set(jobsRef.current.map((job) => job.id));
    setAction(name);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (failure) {
      if (
        mounted.current &&
        epoch.current === requestEpoch &&
        state.current.project.id === projectId
      ) {
        const message = errorText(failure);
        const cancelled =
          name === "produce" &&
          (jobsRef.current.some(
            (job) =>
              job.kind === "story-produce" &&
              job.state === "cancelled" &&
              !earlierJobs.has(job.id),
          ) ||
            /^(?:Story (?:production|narration) )?cancelled(?:\.|$)/iu.test(
              message,
            ));
        if (cancelled) {
          setError("");
          setNotice(
            "Explainer cancelled. Finished narration is kept for your next attempt.",
          );
        } else setError(message);
      }
    } finally {
      if (mounted.current && epoch.current === requestEpoch) {
        lock.current = false;
        setAction("");
      }
    }
  }
  const stillHere = (projectId: string, requestEpoch: number) =>
    mounted.current &&
    state.current.project.id === projectId &&
    epoch.current === requestEpoch;
  async function save() {
    const projectId = project.id;
    const requestEpoch = epoch.current;
    await run("save", async () => {
      const reply = await api.invoke("story.save", {
        projectId,
        revision: Math.max(project.revision, editor.revision),
        story: editor.draft,
      });
      if (!stillHere(projectId, requestEpoch)) return;
      setEditor({
        projectId,
        draft: reply.story,
        baseline: serialized(reply.story),
        revision: reply.revision,
        dirty: false,
      });
      setDiscardedDraft(undefined);
      setNotice("");
    });
  }
  async function sceneAction(
    kind: "voice" | "generate" | "refresh",
    scene: StoryScene,
  ) {
    if (editor.dirty) return;
    const projectId = project.id;
    const requestEpoch = epoch.current;
    await run(`${kind}:${scene.id}`, async () => {
      audio.current?.pause();
      const reply = await api.invoke(`story.${kind}`, {
        projectId,
        revision: Math.max(project.revision, editor.revision),
        sceneId: scene.id,
      });
      if (!stillHere(projectId, requestEpoch)) return;
      if (reply.generation) updateGeneration(reply.generation);
      if (typeof reply.revision === "number")
        setEditor((previous) => ({
          ...previous,
          revision: Math.max(previous.revision, reply.revision),
        }));
      if (kind === "voice")
        setNotice(
          reply.warnings?.length
            ? `Voiceover ready. ${reply.warnings.join(" ")}`
            : "Voiceover ready, with timed captions for assembly.",
        );
      if (kind === "generate")
        setNotice(
          "Shot submitted to Higgsfield. You can keep planning while it generates.",
        );
      if (kind === "refresh") setPollError("");
    });
  }
  async function setupVoice() {
    const projectId = project.id;
    const requestEpoch = epoch.current;
    await run("setup", async () => {
      const status = await api.invoke("tts.setup");
      if (stillHere(projectId, requestEpoch)) setVoiceStatus(status);
    });
  }
  function withReferences(story: StoryPlan, ids: string[], sceneId?: string) {
    const previous = sceneId
      ? (story.scenes.find((scene) => scene.id === sceneId)
          ?.referenceAssetIds ?? [])
      : (story.referenceAssetIds ?? []);
    const next = [...new Set([...previous, ...ids])];
    const updated = sceneId
      ? {
          ...story,
          scenes: story.scenes.map((scene) =>
            scene.id === sceneId
              ? { ...scene, referenceAssetIds: next }
              : scene,
          ),
        }
      : { ...story, referenceAssetIds: next };
    if (
      next.length > STORY_REFERENCE_LIMIT ||
      updated.scenes.some(
        (scene) =>
          mergedStoryReferenceIds(updated, scene).length >
          STORY_REFERENCE_LIMIT,
      )
    )
      throw new Error(
        "Each shot can use up to 9 images, including shared and scene references. Remove an image before adding more.",
      );
    return updated;
  }
  function addReference(id: string, sceneId?: string) {
    if (!id) return;
    try {
      const updated = withReferences(editor.draft, [id], sceneId);
      change(() => updated);
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  function editReferences(ids: string[], sceneId?: string) {
    if (sceneId) updateScene(sceneId, { referenceAssetIds: ids });
    else change((story) => ({ ...story, referenceAssetIds: ids }));
  }
  function moveReference(id: string, delta: number, sceneId?: string) {
    const ids = [
      ...new Set(
        sceneId
          ? (editor.draft.scenes.find((scene) => scene.id === sceneId)
              ?.referenceAssetIds ?? [])
          : (editor.draft.referenceAssetIds ?? []),
      ),
    ];
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from >= 0 && to >= 0 && to < ids.length) {
      [ids[from], ids[to]] = [ids[to], ids[from]];
      editReferences(ids, sceneId);
    }
  }
  async function importReferences(sceneId?: string) {
    const projectId = project.id;
    const requestEpoch = epoch.current;
    await run("references", async () => {
      const reply: {
        assets: Asset[];
        revision: number;
        failures?: { name: string; error: string }[];
      } | null = await api.invoke("story.importReferences", {
        projectId,
        revision: Math.max(project.revision, editor.revision),
      });
      if (!reply || !stillHere(projectId, requestEpoch)) return;
      const importedIds = reply.assets.map((asset) => asset.id);
      let updated = editor.draft;
      let limitError = "";
      try {
        if (importedIds.length)
          updated = withReferences(editor.draft, importedIds, sceneId);
      } catch (failure) {
        limitError = errorText(failure);
      }
      setEditor((previous) => ({
        ...previous,
        draft: updated,
        revision: Math.max(previous.revision, reply.revision),
        dirty: previous.dirty || (importedIds.length > 0 && !limitError),
      }));
      setResult(undefined);
      if (limitError)
        setError(`Images are in your media library. ${limitError}`);
      if (reply.failures?.length)
        setNotice(
          `Some images could not be imported: ${reply.failures.map((item) => `${item.name}: ${item.error}`).join("; ")}`,
        );
    });
  }
  async function assemble() {
    const projectId = project.id;
    const requestEpoch = epoch.current;
    await run("assemble", async () => {
      const reply = await api.invoke("story.assemble", {
        projectId,
        revision: Math.max(project.revision, editor.revision),
        mode: editor.draft.assembly ? "rebuild" : "append",
      });
      if (!stillHere(projectId, requestEpoch)) return;
      setResult(reply);
      onCreated(reply.startFrame);
    });
  }
  async function produceExplainer() {
    const projectId = project.id;
    const requestEpoch = epoch.current;
    await run("produce", async () => {
      audio.current?.pause();
      const current = state.current;
      if (
        current.editor.dirty &&
        serialized(storyOf(current.project)) !== current.editor.baseline
      )
        throw new Error(
          "The saved storyline changed. Save your version or use the saved storyline before creating the explainer.",
        );
      let revision = Math.max(
        current.project.revision,
        current.editor.revision,
      );
      if (current.editor.dirty || !current.project.story) {
        const saved = await api.invoke("story.save", {
          projectId,
          revision,
          story: current.editor.draft,
        });
        if (!stillHere(projectId, requestEpoch)) return;
        revision = saved.revision;
        setEditor({
          projectId,
          draft: saved.story,
          baseline: serialized(saved.story),
          revision,
          dirty: false,
        });
        setDiscardedDraft(undefined);
      }
      if (!stillHere(projectId, requestEpoch)) return;
      const reply = await api.invoke("story.produce", { projectId, revision });
      if (!stillHere(projectId, requestEpoch)) return;
      setEditor((previous) => {
        if (
          previous.projectId !== projectId ||
          previous.dirty ||
          previous.revision > reply.revision
        )
          return previous;
        return {
          projectId,
          draft: reply.story,
          baseline: serialized(reply.story),
          revision: reply.revision,
          dirty: false,
        };
      });
      setResult(reply);
      onCreated(reply.startFrame);
    });
  }

  if (editor.projectId !== project.id || explainerForm.projectId !== project.id)
    return null;
  const draft = editor.draft;
  const selected =
    draft.scenes.find((scene) => scene.id === selectedId) ?? draft.scenes[0];
  const visuals = project.assets.filter(
    (asset) =>
      asset.kind !== "audio" &&
      (asset.kind === "image" || asset.duration > 0) &&
      !missing.includes(asset.id),
  );
  const musicAssets = project.assets.filter(
    (asset) =>
      asset.kind === "audio" &&
      asset.duration > 0 &&
      !missing.includes(asset.id),
  );
  const visualFor = (scene: StoryScene) =>
    visuals.find((asset) => asset.id === scene.assetId);
  const visualReady = (scene: StoryScene) =>
    !sceneNeedsMedia(scene) || !!visualFor(scene);
  const voiceFor = (scene: StoryScene) =>
    musicAssets.find((asset) => asset.id === scene.voiceAssetId);
  const voiceReady = (scene: StoryScene) =>
    !scene.narration.trim() ||
    (!!voiceFor(scene) &&
      scene.voiceSignature === storyNarrationSignature(scene, draft));
  const readyCount = draft.scenes.filter(
    (scene) => visualReady(scene) && voiceReady(scene),
  ).length;
  const visualCount = draft.scenes.filter(visualReady).length;
  const graphicsCount = draft.scenes.filter(
    (scene) => !sceneNeedsMedia(scene),
  ).length;
  const narrated = draft.scenes.filter((scene) => scene.narration.trim());
  const voicedCount = narrated.filter(voiceReady).length;
  const duration = draft.scenes.reduce(
    (total, scene) =>
      total +
      Math.max(
        scene.duration,
        scene.narration.trim() ? (voiceFor(scene)?.duration ?? 0) : 0,
      ),
    0,
  );
  const selectedVisual = selected && visualFor(selected);
  const selectedVoice = selected && voiceFor(selected);
  const selectedGeneration = generations.find(
    (job) => job.id === selected?.generationId,
  );
  const sharedReferenceIds = [...new Set(draft.referenceAssetIds ?? [])];
  const sceneReferenceIds = [...new Set(selected?.referenceAssetIds ?? [])];
  const selectedReferenceIds = selected
    ? mergedStoryReferenceIds(draft, selected)
    : [];
  const imageAssets = project.assets.filter(
    (asset) => asset.kind === "image" && !missing.includes(asset.id),
  );
  const referenceImage = (id: string, hint?: string): ReferenceImage => {
    const asset = imageAssets.find((image) => image.id === id);
    return {
      id,
      name:
        asset?.name ??
        project.assets.find((image) => image.id === id)?.name ??
        "Unavailable image",
      previewUrl: asset ? `${base}/media/${asset.id}` : undefined,
      missing: !asset,
      hint,
    };
  };
  const missingReferences = selectedReferenceIds.some(
    (id) => !imageAssets.some((asset) => asset.id === id),
  );
  const tooManyReferences = selectedReferenceIds.length > STORY_REFERENCE_LIMIT;
  const sharedReferenceCapacity = Math.max(
    sharedReferenceIds.length,
    ...draft.scenes.map(
      (scene) => mergedStoryReferenceIds(draft, scene).length,
    ),
  );
  const availableSharedImages = imageAssets.filter((asset) => {
    if (sharedReferenceIds.includes(asset.id)) return false;
    try {
      withReferences(draft, [asset.id]);
      return true;
    } catch {
      return false;
    }
  });
  const availableSceneImages = imageAssets.filter(
    (asset) => !selectedReferenceIds.includes(asset.id),
  );
  const runningProduction = production.current;
  const busy = !!action || !!runningProduction;
  const needsSave = editor.dirty || !project.story;
  const conflict =
    editor.dirty && serialized(storyOf(project)) !== editor.baseline;
  const runningVoice = [...jobs]
    .reverse()
    .find(
      (job) =>
        ["tts", "tts-setup", "voiceover", "story-voice"].includes(job.kind) &&
        job.state === "running",
    );
  const musicReady =
    !draft.musicAssetId ||
    musicAssets.some((asset) => asset.id === draft.musicAssetId);
  const assemblyReady =
    draft.scenes.length > 0 &&
    readyCount === draft.scenes.length &&
    !needsSave &&
    musicReady;
  const selectedIndex = selected
    ? draft.scenes.findIndex((scene) => scene.id === selected.id)
    : -1;
  const timedCaptionCount = narrated.filter(
    (scene) => voiceReady(scene) && hasCaptionTiming(voiceFor(scene)),
  ).length;

  return (
    <div
      ref={panel}
      className="library-content story-library"
      aria-label="Story studio"
    >
      <div className="section-heading">
        <span>Story studio</span>
      </div>
      <nav className="story-stepper pill-tabs" aria-label="Story workflow">
        {["Story", "Produce", "Finish"].map((label, index) => (
          <button
            key={label}
            className={step === index ? "active" : ""}
            aria-current={step === index ? "step" : undefined}
            disabled={busy || (index > 0 && !draft.scenes.length)}
            onClick={() => setStep(index)}
          >
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </nav>
      {!!draft.scenes.length && (
        <div className="story-overview">
          <span>
            {plural(draft.scenes.length, "scene")} · ~{Math.ceil(duration)}s
          </span>
          <span>{readyCount} ready</span>
          <progress
            aria-label="Scenes ready"
            max={draft.scenes.length}
            value={readyCount}
          />
        </div>
      )}
      {/* A new project has nothing to save until something is typed. */}
      {(editor.dirty || !!project.story) && (
        <div className={`story-savebar${needsSave ? " is-dirty" : ""}`}>
          <span>
            {needsSave ? (
              "Storyline has unsaved edits"
            ) : (
              <>
                <Check size={12} aria-hidden="true" /> Storyline saved
              </>
            )}
          </span>
          <button
            className={needsSave ? "control" : ""}
            disabled={busy || !needsSave}
            onClick={() => void save()}
          >
            <Save size={13} aria-hidden="true" />
            {action === "save"
              ? "Saving…"
              : conflict
                ? "Save my version"
                : "Save storyline"}
          </button>
        </div>
      )}
      {conflict && (
        <div className="story-warning" role="status">
          <p>
            The saved storyline changed while you were editing. Your draft is
            preserved. Saving your version will replace that storyline.
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setDiscardedDraft(editor);
              const story = storyOf(project);
              setEditor({
                projectId: project.id,
                draft: story,
                baseline: serialized(story),
                revision: project.revision,
                dirty: false,
              });
              setExplainerForm(formFromStory(project.id, story));
              setError("");
            }}
          >
            Discard draft and use saved
          </button>
        </div>
      )}
      {discardedDraft && (
        <div className="story-notice">
          Your previous draft is available until your next save.
          <button
            disabled={busy}
            onClick={() => {
              setEditor({ ...discardedDraft, dirty: true });
              setExplainerForm(formFromStory(project.id, discardedDraft.draft));
              setDiscardedDraft(undefined);
            }}
          >
            Restore discarded draft
          </button>
        </div>
      )}
      {error && (
        <p className="story-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="story-notice" role="status">
          {notice}
        </p>
      )}
      {runningProduction && (
        <div className="story-job" role="status">
          <span>{runningProduction.message}</span>
          <progress
            aria-label="Explainer production progress"
            max={1}
            value={runningProduction.progress}
          />
          <button
            onClick={() =>
              api
                .invoke("job.cancel", { id: runningProduction.id })
                .catch(report)
            }
          >
            Cancel explainer
          </button>
          <p className="story-hint">
            Completed voiceovers stay available if you cancel.
          </p>
        </div>
      )}
      <fieldset className="story-fieldset" disabled={busy}>
        <legend className="sr-only">Story creation</legend>
        {draft.explainer && draft.scenes.length > 0 && (
          <section className="story-batch" aria-label="Create your explainer">
            <div className="story-section-heading">
              <h3>
                <Clapperboard size={14} aria-hidden="true" /> Create your
                explainer
              </h3>
              <span>{plural(draft.scenes.length, "scene")}</span>
            </div>
            <div className="story-voice-settings">
              <label className="story-field">
                Voice
                <select
                  aria-label="Explainer narration voice"
                  value={draft.voice}
                  onChange={(event) =>
                    change((story) => ({
                      ...story,
                      voice: event.target.value as SpeechVoice,
                    }))
                  }
                >
                  {speechVoices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name} · {voice.accent}
                    </option>
                  ))}
                </select>
              </label>
              <label className="story-field">
                Pace
                <select
                  aria-label="Explainer narration pace"
                  value={draft.speed}
                  onChange={(event) =>
                    change((story) => ({
                      ...story,
                      speed: Number(event.target.value),
                    }))
                  }
                >
                  {[0.8, 0.9, 1, 1.08, 1.2, 1.35, 1.5].map((speed) => (
                    <option key={speed} value={speed}>
                      {speed}×
                    </option>
                  ))}
                  {![0.8, 0.9, 1, 1.08, 1.2, 1.35, 1.5].includes(
                    draft.speed,
                  ) && <option value={draft.speed}>{draft.speed}×</option>}
                </select>
              </label>
            </div>
            <label className="explainer-caption-toggle">
              <input
                type="checkbox"
                checked={draft.captions}
                onChange={(event) =>
                  change((story) => ({
                    ...story,
                    captions: event.target.checked,
                  }))
                }
              />
              Add timed captions
            </label>
            {visualCount < draft.scenes.length && (
              <p className="story-warning">
                Add media to {draft.scenes.length - visualCount} scene
                {draft.scenes.length - visualCount === 1 ? "" : "s"} before
                creating.
                <button
                  onClick={() => {
                    setSelectedId(
                      draft.scenes.find((scene) => !visualReady(scene))?.id ??
                        "",
                    );
                    setStep(1);
                  }}
                >
                  Choose real screens or footage
                </button>
              </p>
            )}
            {voicedCount < narrated.length && voiceCheckError && (
              <p className="story-error" role="alert">
                Could not check the voice engine: {voiceCheckError}
              </p>
            )}
            {voicedCount < narrated.length &&
              voiceStatus &&
              !voiceStatus.ready && (
                <div className="story-engine">
                  <p>
                    Download the local voice engine once (
                    {voiceStatus.downloadMB} MB).
                  </p>
                  <button
                    className="control"
                    disabled={!!runningVoice}
                    onClick={() => void setupVoice()}
                  >
                    Set up local voice
                  </button>
                </div>
              )}
            {!musicReady && (
              <p className="story-warning">
                Your music track is unavailable. Choose another track or No
                music in Finish.
              </p>
            )}
            <div className="panel-action-bar">
              <button
                className="primary story-build"
                disabled={
                  busy ||
                  !!runningVoice ||
                  conflict ||
                  visualCount !== draft.scenes.length ||
                  !musicReady ||
                  (voicedCount < narrated.length && !voiceStatus?.ready)
                }
                onClick={() => void produceExplainer()}
              >
                {action === "produce" || runningProduction ? (
                  <LoaderCircle className="spin" size={15} aria-hidden="true" />
                ) : (
                  <Clapperboard size={15} aria-hidden="true" />
                )}
                {action === "produce" || runningProduction
                  ? "Creating explainer…"
                  : "Create explainer"}
              </button>
            </div>
            {draft.assembly && (
              <p className="story-hint">
                Replaces the previous story sequence. Other timeline clips stay
                in place.
              </p>
            )}
          </section>
        )}
        {step === 0 && (
          <section className="story-step" aria-label="Plan your story">
            <ExplainerStory
              key={`explainer-${project.id}`}
              story={draft}
              input={explainerForm.input}
              onInput={(input) =>
                setExplainerForm((previous) =>
                  previous.projectId === project.id
                    ? { ...previous, input }
                    : previous,
                )
              }
              onCreate={applyExplainer}
            />
            <ProductFilmSetup
              key={project.id}
              story={draft}
              onRecipe={applyProductRecipe}
              onBrand={(brand) => change((story) => ({ ...story, brand }))}
            />
            <details className="story-brief">
              <summary>Brief &amp; visual direction</summary>
              <label className="story-field">
                The idea
                <textarea
                  aria-label="Story brief"
                  rows={2}
                  maxLength={5000}
                  value={draft.brief}
                  placeholder="What should viewers feel, learn, or do?"
                  onChange={(event) =>
                    change((story) => ({ ...story, brief: event.target.value }))
                  }
                />
              </label>
              {onAskAssistant && (
                <button
                  className="story-assistant"
                  disabled={needsSave && draft.scenes.length > 0}
                  title={
                    needsSave && draft.scenes.length > 0
                      ? "Save your storyline so the assistant can use your latest scene edits."
                      : undefined
                  }
                  onClick={() =>
                    onAskAssistant(
                      `Help me plan and refine a complete ${draft.scenes.some((scene) => scene.design) ? "product film" : "video"} storyline in this Cutline project. ${draft.brief ? `My brief: ${draft.brief}. ` : ""}Read the saved story and editing schema first. Preserve existing brand colors, scene design layouts, shared and per-scene reference images, voice and caption preferences, and assembly ownership unless I ask to change them. Use the story tools to create or refine an editable scene-by-scene draft with realistic durations. Keep on-screen headlines, supporting copy, and feature points in each scene's design, separate from spoken narration. Use native product layouts for typography and graphics, and real screenshots or recordings for product screens. Add visual prompts only for shots that need generated footage; keep recurring characters and visual style consistent. Do not submit paid generation requests or rebuild the timeline.`,
                    )
                  }
                >
                  <Sparkles size={13} aria-hidden="true" />
                  Plan with assistant
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              )}
              {onAskAssistant && needsSave && draft.scenes.length > 0 && (
                <p className="story-hint">
                  Save your storyline so the assistant can use your latest scene
                  edits.
                </p>
              )}
              <label className="story-field">
                Visual direction
                <input
                  aria-label="Story visual direction"
                  maxLength={1000}
                  value={draft.style}
                  placeholder="Cinematic, moonlit blue, slow tracking shots"
                  onChange={(event) =>
                    change((story) => ({ ...story, style: event.target.value }))
                  }
                />
              </label>
            </details>
            <details
              className="story-reference-section"
              open={sharedReferenceIds.length > 0}
            >
              <summary title="Keeps characters, wardrobe and visual style consistent across every generated scene">
                <ImagePlus size={14} aria-hidden="true" />
                Shared reference images
                <span>
                  {sharedReferenceIds.length} / {STORY_REFERENCE_LIMIT}
                </span>
              </summary>
              <ReferenceImages
                images={sharedReferenceIds.map((id) => referenceImage(id))}
                label="Shared story reference images"
                onRemove={(id) =>
                  editReferences(
                    sharedReferenceIds.filter((item) => item !== id),
                  )
                }
                onMove={(id, delta) => moveReference(id, delta)}
              />
              <label className="story-field">
                Add an image from your media
                <select
                  aria-label="Add shared image from media"
                  value=""
                  disabled={!availableSharedImages.length}
                  onChange={(event) => addReference(event.target.value)}
                >
                  <option value="">
                    {availableSharedImages.length
                      ? "Choose an image…"
                      : "No available images"}
                  </option>
                  {availableSharedImages.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="story-inline-action"
                disabled={sharedReferenceCapacity >= STORY_REFERENCE_LIMIT}
                title="PNG, JPEG or WebP. Up to 9 images per shot, including scene references. Images stay on this Mac until you generate a shot."
                onClick={() => void importReferences()}
              >
                <ImagePlus size={13} aria-hidden="true" /> Import shared
                reference images
              </button>
              {sharedReferenceCapacity >= STORY_REFERENCE_LIMIT && (
                <p className="story-hint">
                  A scene has 9 references. Remove one before importing more
                  shared images.
                </p>
              )}
            </details>
            {(!draft.scenes.length || replaceScript) && (
              <details className="story-script-entry" open={replaceScript}>
                <summary>Script scenes &amp; examples</summary>
                <div className="story-script-box">
                  <label className="story-field">
                    Paste your script
                    <textarea
                      aria-label="Story script"
                      rows={5}
                      maxLength={30000}
                      value={script}
                      placeholder="One paragraph per scene. Each paragraph becomes its narration."
                      onChange={(event) => setScript(event.target.value)}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={!script.trim()}
                    onClick={() => splitScript(script)}
                  >
                    <Clapperboard size={14} aria-hidden="true" />
                    {draft.scenes.length
                      ? "Replace scenes from script"
                      : "Split into scenes"}
                  </button>
                  {!!draft.scenes.length && (
                    <button onClick={() => setReplaceScript(false)}>
                      Keep current scenes
                    </button>
                  )}
                  {!draft.scenes.length && (
                    <>
                      <span className="story-small-heading">
                        Or start with an editable example
                      </span>
                      <div className="story-templates">
                        {templates.map((template) => (
                          <button
                            className="control"
                            key={template.id}
                            onClick={() =>
                              splitScript(template.script, template.id)
                            }
                          >
                            {template.name}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </details>
            )}
            {!!draft.scenes.length && (
              <>
                <div className="story-section-heading">
                  <h3>Your storyline</h3>
                  <button onClick={() => setReplaceScript(!replaceScript)}>
                    {replaceScript ? "Close script" : "Paste new script"}
                  </button>
                </div>
                <div className="story-scene-list" aria-label="Story scenes">
                  {draft.scenes.map((scene, index) => (
                    <div
                      key={scene.id}
                      className={`story-scene-row${selected?.id === scene.id ? " selected" : ""}`}
                    >
                      <button
                        className="story-scene-select"
                        aria-pressed={selected?.id === scene.id}
                        onClick={() => setSelectedId(scene.id)}
                      >
                        <span className="story-scene-number">{index + 1}</span>
                        <span>
                          <strong>{scene.title || `Scene ${index + 1}`}</strong>
                          <small>
                            {scene.duration}s ·{" "}
                            {scene.design
                              ? sceneNeedsMedia(scene)
                                ? "Screen + type"
                                : "Motion graphics"
                              : scene.narration.trim()
                                ? "Narrated"
                                : "Silent"}
                          </small>
                        </span>
                      </button>
                      <div className="story-order">
                        <button
                          aria-label={`Move scene ${index + 1} earlier`}
                          disabled={index === 0}
                          onClick={() => moveScene(scene.id, -1)}
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          aria-label={`Move scene ${index + 1} later`}
                          disabled={index === draft.scenes.length - 1}
                          onClick={() => moveScene(scene.id, 1)}
                        >
                          <ArrowDown size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            <button
              className="story-add-scene"
              disabled={draft.scenes.length >= 60}
              onClick={addScene}
            >
              <Plus size={14} aria-hidden="true" />
              Add a scene
            </button>
            {selected && (
              <div className="story-scene-editor">
                <div className="story-section-heading">
                  <h3>Scene {selectedIndex + 1}</h3>
                  <button
                    className="danger"
                    aria-label={`Delete scene ${selectedIndex + 1}`}
                    onClick={() =>
                      change((story) => ({
                        ...story,
                        scenes: story.scenes.filter(
                          (scene) => scene.id !== selected.id,
                        ),
                      }))
                    }
                  >
                    <Trash2 size={13} />
                    Remove
                  </button>
                </div>
                <div className="story-title-duration">
                  <label className="story-field">
                    Scene title
                    <input
                      aria-label="Scene title"
                      value={selected.title}
                      maxLength={120}
                      onChange={(event) =>
                        updateScene(selected.id, { title: event.target.value })
                      }
                    />
                  </label>
                  <label className="story-field">
                    Seconds
                    <input
                      type="number"
                      aria-label="Scene duration in seconds"
                      min={1}
                      max={120}
                      step={1}
                      value={selected.duration}
                      onChange={(event) =>
                        updateScene(selected.id, {
                          duration: Math.max(
                            1,
                            Math.min(120, Number(event.target.value) || 1),
                          ),
                        })
                      }
                    />
                  </label>
                </div>
                <ProductLayoutPicker
                  scene={selected}
                  onChange={(design) => updateScene(selected.id, { design })}
                />
                {selected.design && (
                  <>
                    <ProductScenePreview
                      key={selected.id}
                      scene={selected}
                      brand={draft.brand}
                      asset={selectedVisual}
                      base={base}
                      aspectRatio={project.width / project.height}
                    />
                    <ProductCopyEditor
                      scene={selected}
                      onChange={(design) =>
                        updateScene(selected.id, { design })
                      }
                    />
                  </>
                )}
                <label className="story-field">
                  Narration
                  <textarea
                    aria-label="Scene narration"
                    rows={4}
                    maxLength={5000}
                    value={selected.narration}
                    placeholder="What should the voice say? Leave blank for a silent scene."
                    onChange={(event) =>
                      updateScene(selected.id, {
                        narration: event.target.value,
                      })
                    }
                  />
                </label>
                {sceneNeedsMedia(selected) && (
                  <label className="story-field">
                    What we see
                    <textarea
                      aria-label="Scene visual prompt"
                      rows={4}
                      maxLength={4000}
                      value={selected.visualPrompt}
                      placeholder="Describe the character, action, setting, and camera movement."
                      onChange={(event) =>
                        updateScene(selected.id, {
                          visualPrompt: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
              </div>
            )}
            {!!draft.scenes.length && (
              <div className="panel-action-bar">
                <button
                  className="primary story-next"
                  onClick={() => setStep(1)}
                >
                  Produce scenes
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
          </section>
        )}
        {step === 1 && selected && (
          <section className="story-step" aria-label="Produce your scenes">
            {needsSave && (
              <p className="story-warning">
                Save your storyline to generate shots or voiceovers.
              </p>
            )}
            <label className="story-field">
              Scene
              <select
                aria-label="Scene to produce"
                value={selected.id}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {draft.scenes.map((scene, index) => (
                  <option key={scene.id} value={scene.id}>
                    {index + 1}. {scene.title || "Untitled scene"}
                  </option>
                ))}
              </select>
            </label>
            <div className="story-production-card">
              <div className="story-section-heading">
                <h3>
                  <Film size={14} aria-hidden="true" />
                  Visual
                </h3>
                <span
                  className={
                    visualReady(selected) ? "story-ready" : "story-hint"
                  }
                >
                  {!sceneNeedsMedia(selected)
                    ? "Graphics ready"
                    : selectedVisual
                      ? "Ready"
                      : selected.design
                        ? "Add your screen"
                        : "Choose a shot"}
                </span>
              </div>
              {selected.design && (
                <>
                  <ProductScenePreview
                    key={selected.id}
                    scene={selected}
                    brand={draft.brand}
                    asset={selectedVisual}
                    base={base}
                    aspectRatio={project.width / project.height}
                  />
                  {sceneNeedsMedia(selected) && (
                    <p className="story-hint">
                      Add a screenshot or screen recording below.
                    </p>
                  )}
                  <button
                    className="story-inline-action"
                    onClick={() => setStep(0)}
                  >
                    Edit scene design
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                </>
              )}
              {!selected.design && selectedVisual?.thumbnail && (
                <img
                  className="story-shot-preview"
                  src={`${base}/media/${selectedVisual.id}/thumb`}
                  alt={`Selected shot: ${selectedVisual.name}`}
                />
              )}
              {sceneNeedsMedia(selected) && (
                <>
                  <label className="story-field">
                    Use media
                    <select
                      aria-label="Scene visual asset"
                      value={selected.assetId ?? ""}
                      onChange={(event) =>
                        updateScene(selected.id, {
                          assetId: event.target.value || undefined,
                        })
                      }
                    >
                      <option value="">Choose video or image…</option>
                      {selected.assetId && !selectedVisual && (
                        <option value={selected.assetId}>
                          Missing media · choose another shot
                        </option>
                      )}
                      {visuals.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="story-inline-action" onClick={importMedia}>
                    <Upload size={13} aria-hidden="true" />
                    Import footage or images
                  </button>
                  {/* Paid generation is the fallback: it opens on its own
                      only to show a shot that is on its way. */}
                  <details
                    className="story-shot-generator"
                    open={
                      !selectedVisual &&
                      !selected.design &&
                      !!selected.generationId
                    }
                  >
                    <summary>Generate with Higgsfield</summary>
                    <label className="story-field">
                      Shot prompt
                      <textarea
                        aria-label="Generation shot prompt"
                        rows={4}
                        maxLength={4000}
                        value={selected.visualPrompt}
                        onChange={(event) =>
                          updateScene(selected.id, {
                            visualPrompt: event.target.value,
                          })
                        }
                      />
                    </label>
                    <p className="story-hint">
                      Seedance 2.0 ·{" "}
                      {Math.max(4, Math.min(15, Math.ceil(selected.duration)))}s
                      · 720p. Uses your Higgsfield credits. Your visual
                      direction is included.
                    </p>
                    <details
                      className="story-reference-section story-scene-references"
                      open={selectedReferenceIds.length > 0}
                    >
                      <summary>
                        <ImagePlus size={14} aria-hidden="true" /> Shot
                        reference images{" "}
                        <span>
                          {selectedReferenceIds.length} /{" "}
                          {STORY_REFERENCE_LIMIT}
                        </span>
                      </summary>
                      <p className="story-hint">
                        Shared images come first, followed by this scene’s
                        images. Describe their roles in your prompt using the
                        order shown.
                      </p>
                      <ReferenceImages
                        images={selectedReferenceIds.map((id) =>
                          referenceImage(
                            id,
                            sharedReferenceIds.includes(id)
                              ? "Shared · every scene"
                              : "This scene only",
                          ),
                        )}
                        label="Shot reference images in generation order"
                        editableFrom={sharedReferenceIds.length}
                        onRemove={(id) =>
                          editReferences(
                            sceneReferenceIds.filter((item) => item !== id),
                            selected.id,
                          )
                        }
                        onMove={(id, delta) => {
                          const uniqueSceneIds = sceneReferenceIds.filter(
                            (item) => !sharedReferenceIds.includes(item),
                          );
                          const from = uniqueSceneIds.indexOf(id);
                          const to = from + delta;
                          if (
                            from >= 0 &&
                            to >= 0 &&
                            to < uniqueSceneIds.length
                          ) {
                            [uniqueSceneIds[from], uniqueSceneIds[to]] = [
                              uniqueSceneIds[to],
                              uniqueSceneIds[from],
                            ];
                            editReferences(uniqueSceneIds, selected.id);
                          }
                        }}
                      />
                      <button
                        className="story-inline-action"
                        onClick={() => setStep(0)}
                      >
                        Edit shared reference images
                      </button>
                      <label className="story-field">
                        Add an image for this scene
                        <select
                          aria-label="Add scene image from media"
                          value=""
                          disabled={
                            !availableSceneImages.length ||
                            selectedReferenceIds.length >= STORY_REFERENCE_LIMIT
                          }
                          onChange={(event) =>
                            addReference(event.target.value, selected.id)
                          }
                        >
                          <option value="">
                            {availableSceneImages.length
                              ? "Choose an image…"
                              : "No available images"}
                          </option>
                          {availableSceneImages.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="story-inline-action"
                        disabled={
                          selectedReferenceIds.length >= STORY_REFERENCE_LIMIT
                        }
                        onClick={() => void importReferences(selected.id)}
                      >
                        <ImagePlus size={13} aria-hidden="true" /> Import scene
                        reference images
                      </button>
                      <p className="story-hint">
                        These images guide the shot’s appearance, not its first
                        frame. Selected images are sent to Higgsfield only when
                        you generate this shot.
                      </p>
                    </details>
                    {(missingReferences || tooManyReferences) && (
                      <p className="story-error" role="alert">
                        {tooManyReferences
                          ? "This shot has more than 9 reference images. Remove images before generating."
                          : "A reference image is missing. Remove it or relink it before generating."}
                      </p>
                    )}
                    {generationCheckError && (
                      <p className="story-error" role="alert">
                        Could not check Higgsfield: {generationCheckError}
                      </p>
                    )}
                    {configured === false ? (
                      <button className="control" onClick={openSettings}>
                        Connect Higgsfield
                      </button>
                    ) : (
                      <button
                        className="control"
                        disabled={
                          needsSave ||
                          !configured ||
                          !selected.visualPrompt.trim() ||
                          missingReferences ||
                          tooManyReferences ||
                          isPending(selectedGeneration) ||
                          selectedGeneration?.status === "unknown"
                        }
                        onClick={() => void sceneAction("generate", selected)}
                      >
                        {action === `generate:${selected.id}` ||
                        isPending(selectedGeneration) ? (
                          <LoaderCircle
                            size={13}
                            className="spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Sparkles size={13} aria-hidden="true" />
                        )}
                        {isPending(selectedGeneration)
                          ? "Generating shot…"
                          : selected.generationId
                            ? "Generate another shot"
                            : "Generate this shot"}
                      </button>
                    )}
                    {selectedGeneration && (
                      <div className="story-generation-status" role="status">
                        <span>
                          {generationLabels[selectedGeneration.status]}
                        </span>
                        {selectedGeneration.error && (
                          <p className="story-error">
                            {selectedGeneration.error}
                          </p>
                        )}
                        <button
                          disabled={needsSave}
                          onClick={() => void sceneAction("refresh", selected)}
                        >
                          <RefreshCw size={12} aria-hidden="true" />
                          Check status
                        </button>
                        {["unknown", "queued", "in_progress"].includes(
                          selectedGeneration.status,
                        ) && (
                          <button onClick={openGenerate}>
                            Manage in Generate
                          </button>
                        )}
                      </div>
                    )}
                    {pollError && (
                      <p className="story-error" role="alert">
                        Status check failed: {pollError}
                      </p>
                    )}
                  </details>
                </>
              )}
            </div>
            <div className="story-production-card">
              <div className="story-section-heading">
                <h3>
                  <Mic2 size={14} aria-hidden="true" />
                  Voiceover
                </h3>
                <span
                  className={
                    voiceReady(selected) ? "story-ready" : "story-hint"
                  }
                >
                  {!selected.narration.trim()
                    ? "Silent scene"
                    : voiceReady(selected)
                      ? "Ready"
                      : selectedVoice
                        ? "Needs update"
                        : "Not created"}
                </span>
              </div>
              <label className="story-field">
                Narration
                <textarea
                  aria-label="Production scene narration"
                  rows={3}
                  maxLength={5000}
                  value={selected.narration}
                  placeholder="Leave blank for a silent scene."
                  onChange={(event) =>
                    updateScene(selected.id, { narration: event.target.value })
                  }
                />
              </label>
              <div
                className="story-voice-settings"
                title="Voice and pace apply to the whole story. Narration is made on this Mac."
              >
                <label className="story-field">
                  Voice
                  <select
                    aria-label="Story narration voice"
                    value={draft.voice}
                    onChange={(event) =>
                      change((story) => ({
                        ...story,
                        voice: event.target.value as SpeechVoice,
                      }))
                    }
                  >
                    {speechVoices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.name} · {voice.accent}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="story-field">
                  Pace
                  <select
                    aria-label="Story narration pace"
                    value={draft.speed}
                    onChange={(event) =>
                      change((story) => ({
                        ...story,
                        speed: Number(event.target.value),
                      }))
                    }
                  >
                    {[0.8, 0.9, 1, 1.08, 1.2, 1.35, 1.5].map((speed) => (
                      <option key={speed} value={speed}>
                        {speed}×
                      </option>
                    ))}
                    {![0.8, 0.9, 1, 1.08, 1.2, 1.35, 1.5].includes(
                      draft.speed,
                    ) && <option value={draft.speed}>{draft.speed}×</option>}
                  </select>
                </label>
              </div>
              {voiceCheckError && (
                <p className="story-error" role="alert">
                  Could not check the voice engine: {voiceCheckError}
                </p>
              )}
              {voiceStatus && !voiceStatus.ready && !voiceReady(selected) && (
                <div className="story-engine">
                  <p>
                    Download the voice engine once ({voiceStatus.downloadMB}{" "}
                    MB).
                  </p>
                  <button
                    className="control"
                    disabled={!!runningVoice}
                    onClick={() => void setupVoice()}
                  >
                    <Download size={13} aria-hidden="true" />
                    Set up local voice
                  </button>
                </div>
              )}
              <button
                className="control"
                disabled={
                  needsSave ||
                  !selected.narration.trim() ||
                  (!voiceReady(selected) && !voiceStatus?.ready) ||
                  !!runningVoice ||
                  (voiceReady(selected) && hasCaptionTiming(selectedVoice))
                }
                onClick={() => void sceneAction("voice", selected)}
              >
                {action === `voice:${selected.id}` ? (
                  <LoaderCircle className="spin" size={13} aria-hidden="true" />
                ) : (
                  <Mic2 size={13} aria-hidden="true" />
                )}
                {voiceReady(selected) && selectedVoice
                  ? hasCaptionTiming(selectedVoice)
                    ? "Voiceover ready"
                    : "Retry caption timing"
                  : selectedVoice
                    ? "Update voiceover"
                    : "Create scene voiceover"}
              </button>
              {selectedVoice && selected.narration.trim() && (
                <audio
                  ref={audio}
                  controls
                  preload="metadata"
                  aria-label="Scene voiceover preview"
                  src={`${base}/media/${selectedVoice.id}`}
                />
              )}
              {selectedVoice && !voiceReady(selected) && (
                <p className="story-warning">
                  Narration, voice, or pace changed. Recreate this voiceover
                  before building.
                </p>
              )}
              {selectedVoice &&
                voiceReady(selected) &&
                selected.narration.trim() &&
                !hasCaptionTiming(selectedVoice) && (
                  <p className="story-warning">
                    Voice is ready. Retry caption timing to align this saved
                    voiceover, or transcribe it in Captions after assembly.
                  </p>
                )}
            </div>
            <div className="story-scene-navigation panel-action-bar">
              <button
                disabled={selectedIndex === 0}
                onClick={() =>
                  setSelectedId(draft.scenes[selectedIndex - 1].id)
                }
              >
                Previous scene
              </button>
              {selectedIndex < draft.scenes.length - 1 ? (
                <button
                  className="control"
                  onClick={() =>
                    setSelectedId(draft.scenes[selectedIndex + 1].id)
                  }
                >
                  Next scene
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              ) : (
                <button className="primary" onClick={() => setStep(2)}>
                  Finish video
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          </section>
        )}
        {step === 2 && (
          <section className="story-step" aria-label="Finish your video">
            <div className="story-finish-summary">
              <h3>Ready for the timeline</h3>
              <div>
                <span>Visuals</span>
                <strong>
                  {visualCount} / {draft.scenes.length}
                </strong>
              </div>
              {graphicsCount > 0 && (
                <div>
                  <span>Local graphics scenes</span>
                  <strong>{graphicsCount}</strong>
                </div>
              )}
              <div>
                <span>Voiceovers</span>
                <strong>
                  {voicedCount} / {narrated.length}
                </strong>
              </div>
              <div>
                <span>Estimated length</span>
                <strong>{Math.ceil(duration)}s</strong>
              </div>
            </div>
            {readyCount < draft.scenes.length && (
              <div className="story-warning">
                <p>
                  Finish the visuals and voiceovers for{" "}
                  {draft.scenes.length - readyCount} scene
                  {draft.scenes.length - readyCount === 1 ? "" : "s"}.
                </p>
                <button
                  onClick={() => {
                    const incomplete = draft.scenes.find(
                      (scene) => !visualReady(scene) || !voiceReady(scene),
                    );
                    setSelectedId(incomplete?.id ?? "");
                    setStep(1);
                  }}
                >
                  Go to next unfinished scene
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              </div>
            )}
            <label className="story-checkbox">
              <input
                type="checkbox"
                checked={draft.captions}
                onChange={(event) =>
                  change((story) => ({
                    ...story,
                    captions: event.target.checked,
                  }))
                }
              />
              <span>
                <strong>Add captions</strong>
                <small>Timed to the generated voiceover</small>
              </span>
            </label>
            {draft.captions && (
              <>
                <label className="story-field">
                  Caption style
                  <select
                    aria-label="Story caption style"
                    value={draft.captionStyle}
                    onChange={(event) =>
                      change((story) => ({
                        ...story,
                        captionStyle: event.target
                          .value as StoryPlan["captionStyle"],
                      }))
                    }
                  >
                    {captionStyles.map((style) => (
                      <option key={style.id} value={style.id}>
                        {style.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div
                  className={`story-caption-sample style-${draft.captionStyle}`}
                  aria-label="Caption style sample"
                >
                  <span>
                    Every story <em>starts</em> here.
                  </span>
                </div>
                {narrated.length > timedCaptionCount && (
                  <p className="story-hint">
                    {timedCaptionCount} of {narrated.length} narrated scenes
                    have timed captions ready. Scenes without word timing are
                    skipped.
                  </p>
                )}
              </>
            )}
            <label className="story-field">
              Background music
              <select
                aria-label="Story background music"
                value={draft.musicAssetId ?? ""}
                onChange={(event) =>
                  change((story) => ({
                    ...story,
                    musicAssetId: event.target.value || undefined,
                  }))
                }
              >
                <option value="">No music</option>
                {draft.musicAssetId &&
                  !musicAssets.some(
                    (asset) => asset.id === draft.musicAssetId,
                  ) && (
                    <option value={draft.musicAssetId}>
                      Missing audio · choose another track
                    </option>
                  )}
                {musicAssets
                  .filter(
                    (asset) =>
                      !draft.scenes.some(
                        (scene) => scene.voiceAssetId === asset.id,
                      ),
                  )
                  .map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
              </select>
            </label>
            <button className="story-inline-action" onClick={importMedia}>
              <Upload size={13} aria-hidden="true" />
              Import music
            </button>
            {!musicReady && (
              <p className="story-warning">
                Choose an available music track or select No music before
                building.
              </p>
            )}
            {needsSave && (
              <p className="story-warning">
                Save your storyline before building.
              </p>
            )}
            <div className="panel-action-bar">
              <button
                className="primary story-build"
                disabled={!assemblyReady}
                title="Short video shots loop to cover their narration"
                onClick={() => void assemble()}
              >
                {action === "assemble" ? (
                  <LoaderCircle className="spin" size={15} aria-hidden="true" />
                ) : (
                  <Clapperboard size={15} aria-hidden="true" />
                )}
                {action === "assemble"
                  ? "Building your video…"
                  : draft.assembly
                    ? "Rebuild story sequence"
                    : "Build video on timeline"}
              </button>
            </div>
            {draft.assembly && (
              <p className="story-hint">
                Rebuild replaces the previous story sequence. Other timeline
                edits stay in place.
              </p>
            )}
          </section>
        )}
      </fieldset>
      {runningVoice && !runningProduction && (
        <div className="story-job" role="status">
          <span>{runningVoice.message}</span>
          <progress
            aria-label="Voiceover progress"
            max={1}
            value={runningVoice.progress}
          />
          <button
            onClick={() =>
              api.invoke("job.cancel", { id: runningVoice.id }).catch(report)
            }
          >
            Cancel voice task
          </button>
        </div>
      )}
      {busy && !runningVoice && !runningProduction && (
        <div className="story-working" role="status">
          <LoaderCircle className="spin" size={14} aria-hidden="true" />
          {action === "setup"
            ? "Setting up the voice engine…"
            : action === "produce"
              ? "Creating local narration, captions, and your explainer…"
              : action.startsWith("voice:")
                ? "Creating voiceover and timing captions…"
                : action === "assemble"
                  ? "Building your video…"
                  : action === "save"
                    ? "Saving storyline…"
                    : "Working…"}
        </div>
      )}
      {result && (
        <div className="story-result" role="status">
          <h3>
            <Check size={15} aria-hidden="true" />
            Your video is on the timeline
          </h3>
          <p>
            {plural(result.sceneCount, "scene")} ·{" "}
            {(result.durationFrames / project.fps).toFixed(1)}s ·{" "}
            {result.captionCount} caption phrases
          </p>
          {result.warnings.map((warning, index) => (
            <p key={index} className="story-warning">
              {warning}
            </p>
          ))}
          <button className="control" onClick={openCaptions}>
            <Captions size={14} aria-hidden="true" />
            Review captions
          </button>
          <p>
            Play it back, refine the edit, then use Export video in the top bar.
          </p>
        </div>
      )}
    </div>
  );
}
