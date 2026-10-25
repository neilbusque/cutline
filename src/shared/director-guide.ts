/** Shared direction for the built-in assistant and connected editing agents. */
import { reelFormats } from "./reel-formats";
import { motionReferenceGuide } from "./motion-reference";

export const directorStyles = [
  "cinematic",
  "product",
  "social",
  "promo",
] as const;
export type DirectorStyle = (typeof directorStyles)[number];

const directions: Record<
  DirectorStyle,
  {
    intent: string;
    rhythm: string;
    camera: string;
    typography: string;
    nativeWorkflow?: string[];
    example: {
      beat: string;
      seconds: number;
      picture: string;
      sound: string;
    }[];
  }
> = {
  cinematic: {
    intent:
      "Build anticipation, reveal the subject, then resolve. Favor a few confident compositions, a consistent visual world and contrast between motion and stillness.",
    rhythm:
      "As a starting point, use 3 to 6 second scenes with an occasional 1 to 2 second detail insert and a 3 to 5 second closing hold. Adjust to the actual voice take. Let the important reveal breathe; do not add a cut or animation merely because a beat exists.",
    camera:
      "Give each shot one motivated move: a slow push toward the subject, a lateral reveal, or a deliberate static hold. For a still image, begin with a 2 to 5 percent scale change over 3 to 6 seconds and a small pan within its usable crop. Keep the horizon and subject stable. Native camera motion is 2D; do not describe it as a real 3D camera or invent new image detail.",
    typography:
      "Use a short headline, generous negative space and one restrained reveal. Establish hierarchy through size, weight, alignment and spacing. No decorative underlines, accent rules beneath headlines, permanent step numbers, or a row of feature chips by default. Functional dividers, a real UI element and a requested callout may remain.",
    example: [
      {
        beat: "Anticipation",
        seconds: 3,
        picture:
          "A strong original image or meaningful screen detail, a slow push, then one short headline.",
        sound:
          "A quiet musical opening; allow a brief breath before narration.",
      },
      {
        beat: "Reveal",
        seconds: 5,
        picture:
          "Open into the full subject or real workspace. Keep the composition steady long enough to understand it.",
        sound:
          "One clear promise in the voiceover; let the music develop underneath.",
      },
      {
        beat: "Proof",
        seconds: 6,
        picture:
          "Show one action and its visible result, with a close-up that is large enough to read. Follow with a short relevant detail insert if useful.",
        sound:
          "Describe what the viewer can actually see. Use a sound accent only when the action earns it.",
      },
      {
        beat: "Resolution",
        seconds: 4,
        picture:
          "A clean final frame with the subject, identity or one call to action. Let motion settle completely.",
        sound:
          "Finish the spoken thought before the music and picture resolve.",
      },
    ],
  },
  product: {
    intent:
      "Make the product understandable and desirable. Structure the film around a promise, a real action, its visible benefit and a clear close. The interface is the evidence, not background decoration.",
    rhythm:
      "Start with a 2 to 3 second promise, then give each meaningful operation 4 to 7 seconds. Show context, focus attention, show the outcome, and release to the next beat. Shorten the script or extend a shot before accelerating a complex demonstration.",
    camera:
      "Move from an establishing workspace to one legible detail and its result. Choose a genuine interaction recording when the action matters. A captured still can be animated with a restrained pan or scale; it cannot prove a click, loading state or successful operation.",
    typography:
      "Let large meaningful screen crops carry the explanation. Use one concise benefit headline and, only when necessary, one supporting sentence. Avoid decorative underlines, perpetual labels, duplicate captions, and small floating panels competing with the main screen.",
    example: [
      {
        beat: "Promise",
        seconds: 3,
        picture:
          "One short benefit headline with the finished result or a recognizable real workspace.",
        sound: "Name the viewer's outcome in a short sentence.",
      },
      {
        beat: "Action",
        seconds: 5,
        picture:
          "A real recording of one operation, or an honest animated still of its controls. Keep the target control readable.",
        sound:
          "Explain the purpose of this operation without narrating every button.",
      },
      {
        beat: "Result",
        seconds: 5,
        picture:
          "The actual resulting artifact or state fills the frame. Use a brief hold so the change can be understood.",
        sound: "Explain the benefit demonstrated by the visible result.",
      },
      {
        beat: "Close",
        seconds: 3,
        picture: "A quiet brand frame and one specific next action.",
        sound: "Complete the thought; resolve the music after the last word.",
      },
    ],
  },
  social: {
    intent:
      "Make one idea clear on a small screen. Earn attention with a visible result, question or contrast, then give a compact explanation and a satisfying payoff.",
    rhythm:
      "Make the opening understandable within 1 to 2 seconds. Start with 2 to 4 second beats and vary shot size when the thought changes. Keep essential copy readable for at least 1.5 seconds; speed alone does not make an effective hook.",
    camera:
      "Use the target vertical or square canvas from the start. Keep the subject and important controls away from platform overlays. Use a deliberate punch-in at a meaningful turn; avoid repeated zooms, shakes or transitions on every word.",
    typography:
      "Use short high-contrast captions and a single clear headline. Prefer two lines or fewer. Avoid decorative underlines, crowded stickers, stacked badges, and separate title and caption copies of the same sentence.",
    nativeWorkflow: [
      "For Nathan Bentley-style podcast Shorts choose creator-punch, keeping the full-frame speaker, short bold captions and selected emphasis. For Nate Herk-style explainers choose screen-demo, with actual imported screen evidence. In create_reel use proofBeats {sourceIndex, sourceSeconds, assetId, sourceIn?, durationSeconds, layout: split|cutaway}: source time is absolute speaker time before trim/speed, sourceIn is proof-media time, duration is 0.5 to 12 output seconds. Split keeps the speaker below a large screen; cutaway contains the screen on an opaque backdrop. Original voice continues and proof media stays muted. Inspect real crops, caption placement and reading time. This is an editable technique, not a reference clone or automatic face tracking. Auto edit supports these formats without proofBeats and still selects opening speech.",
      "Use cutline_create_reel for footage-led vertical work. Choose format separately from visual style: talking-head keeps the speaker with gentle punch-ins and callouts; explainer adds takeaway cards; listicle numbers spoken points; product-demo contains real screens with feature labels; montage keeps ordered footage. Choose a supported captionStyle independently. Use append to preserve the current timeline.",
      "For Ali Abdaal-inspired or educational storyteller requests, choose format creator-education in Reel Builder or Auto edit. Keep the original speaker and voice, three or four spoken words per off-white pill with dark type, cream educational cards, numbered steps and gentle speech-boundary punch-ins. Omit captionStyle or choose box for the format's captions. Supporting B-roll is muted and uses the upper graphic zone; preview the real speaker framing, captions and cards for collisions. The native layout does not detect or track faces. Use Auto edit only for a requested new Reel because it replaces the timeline.",
      "Read actual transcripts before choosing emphasized phrases. Omit beats for transcript-derived format cards, pass [] to disable them, or supply source-timed beats {sourceIndex, sourceSeconds, text, kind: callout|step|takeaway}. Source time is absolute media time before trim and speed, not timeline time. Keep cards short and source-supported. Use the returned editable layers for refinements and preview captions, faces and important controls together.",
      "Use source-supported teaching copy and actual speech timing. Do not invent statistics or unseen source actions, or claim an exact reference clone. Keep existing narration unless the user requests a new voice. Creator-education beats [] disables its cards and punch-ins; omitted beats select transcript phrases. Review entrances and settled holds before export.",
    ],
    example: [
      {
        beat: "Hook",
        seconds: 2,
        picture:
          "The result or a specific visual question, framed for a phone.",
        sound: "Begin with a useful, concrete statement.",
      },
      {
        beat: "Explain",
        seconds: 4,
        picture:
          "One supporting scene or readable action, with aligned phrase captions.",
        sound: "One idea, one sentence, with music below the voice.",
      },
      {
        beat: "Payoff",
        seconds: 4,
        picture:
          "Show the promised result with a different but purposeful shot size.",
        sound: "Deliver the answer without adding another unrelated claim.",
      },
      {
        beat: "Close",
        seconds: 2,
        picture: "A simple closing image or a natural return to the opening.",
        sound:
          "End the thought cleanly; only loop when the audio also joins cleanly.",
      },
    ],
  },
  promo: {
    intent:
      "Make an energetic original promo with bold type, a strong subject and decisive changes of scale. Alternate impact, readable holds and a clean close. Extract techniques from a supplied reference without copying its branding, promises or complete sequence.",
    rhythm:
      "Start with 2 to 4 second message beats and optional 0.3 to 0.8 second visual inserts. At 30 fps, try 4 to 8 frame impacts and 6 to 10 frame exits; scale timings to the project fps. Keep essential copy settled and readable for at least 1.5 seconds, longer for a claim or call to action. Build a phrase across successive beats only when the complete thought receives its own hold. These are design starting points, not measured reference or music timings.",
    camera:
      "Alternate a close detail, a full subject and an oversized type frame. Use a deliberate 2D punch-in or scale-through exit to connect selected beats, with a stable reading pose between them. Match direction and visual center across cuts. Physical tumbling objects, lens detail and a moving 3D camera need suitable source footage; native transforms do not generate them.",
    typography:
      "Use short heavy headlines, purposeful stacked lines and large scale contrast. Keep one phrase dominant. A black/white palette change or brief color separation can punctuate a turn, then return to clean readable type. Avoid constant glitch, repeated full-frame flashes, decorative underlines and copying the reference's permanent corner branding.",
    nativeWorkflow: [
      "Read cutline_editing_schema section guide and discover the current promo scene IDs in values.motionScenes. Read section action:motion.scene before creation. Use the catalog's punch, stack, inversion or zoom composition when it serves the beat; do not invent scene IDs or assume the installed app has them. Customize the returned named layers, text, colors and timing with motion.layer.update and motion.keyframe.",
      "Set motion.scene.durationFrames for each beat so its choreography is retimed. A later clip duration change alone does not retime motion. Read the current clipPatch and clipKeyframe schemas before using rgbSplit (0 to 30 clip pixels, scaled with the clip) or invert (0 to 1). These are clip effects, not motion-layer fields. Keyframe a short accent back to zero for a clean hold; keep a sustained inversion only when the changed palette is intentional. Preview both text and any underlying media.",
      "Place imported footage in separate media clips beneath editable native titles. An opaque title card intentionally covers footage; inspect and hide only the named background layer when an overlay is needed. Use real assets for products, physical motion and logos, and verified user copy for claims. The native scenes provide 2D typography and graphic choreography, not a 3D object renderer or automatic recreation of a reference.",
      "Inspect representative source frames and consecutive transition samples before describing the reference. Record approximate observed times separately from chosen durations. Analyze actual music before claiming beat synchronization, and listen to continuous playback before claiming the sound or full motion was reviewed. If only frame samples were available, say so.",
    ],
    example: [
      {
        beat: "Impact",
        seconds: 2.5,
        picture:
          "One original short headline punches into a clean hold over a strong subject or solid field.",
        sound:
          "An optional short accent at the entrance; verify timing against the chosen audio.",
      },
      {
        beat: "Build",
        seconds: 3,
        picture:
          "Stack a compact phrase in two or three lines, then hold the complete idea with a new subject scale.",
        sound:
          "One spoken thought or a measured musical phrase; leave enough time for the actual take.",
      },
      {
        beat: "Turn",
        seconds: 2.5,
        picture:
          "A deliberate dark-to-light composition change or brief RGB accent lands on clean readable type.",
        sound:
          "Use an accent only if it supports the turn; no invented beat alignment.",
      },
      {
        beat: "Resolve",
        seconds: 3,
        picture:
          "An optional scale-through exit leads to a stable identity and one user-supplied next action.",
        sound:
          "Let the last words finish and the musical tail resolve under the final hold.",
      },
    ],
  },
};

/** Read-only creative guidance. This is direction, not a visual quality score. */
export function getDirectorGuide(style: DirectorStyle = "cinematic") {
  return {
    style,
    purpose:
      "Use this guide to direct, build and review an original editable film. These are starting points, not fixed templates. Honor the user's explicit style and changes over defaults.",
    direction: directions[style],
    motionReferences: motionReferenceGuide,
    ...(style === "social" ? { reelFormats } : {}),
    planning: [
      "Inspect the project and run cutline_quality_check before changing an existing film. Record the requested improvement, existing duration, useful assets, manual edits and any reported issues. A narrow style request does not authorize rebuilding the whole timeline.",
      "Choose the audience, destination, aspect ratio, approximate duration, one main message and the final feeling or action. Infer reasonable defaults from the request and project; ask only when an essential choice is unresolved. Save the chosen direction in story.brief and story.style.",
      "Write a beat sheet before building: purpose, visible subject or action, source asset, shot size, camera move, on-screen copy, narration and expected duration for each beat. These are planning notes, not extra story API fields. Map them into each scene's title, visualPrompt, narration, duration and design, using the current schema.",
      "Use broad reference principles such as pacing, contrast, typography and the relationship between product screens and voiceover. Create an original script and composition. Do not copy a reference's branding, claims or complete sequence.",
      "Generate or select voice takes before finalizing scene lengths. Fit the edit to the actual take and aligned words, including a small lead-in and a natural closing breath. If a shot is too short, extend it or revise the script; never quietly clip words or invent transcript timing.",
    ],
    visualContinuity: [
      "Set a small visual bible: character or product identity, wardrobe or surface details, location, palette, light direction, lens or framing intent, and the screen direction of important motion. Repeat stable details in shot prompts and vary only the deliberate shot choices.",
      "Import real reference images and use their asset IDs. Preserve shared and per-scene referenceAssetIds and their order; each scene permits at most nine unique combined references. Describe what each reference establishes. References guide generation; they do not guarantee matching faces, hands, logos or clothing. Review the actual returned media.",
      "Keep the light, color and contrast coherent across adjacent shots. A cinematic look, heavy vignette, grain or black bars alone does not create cinematic direction. Avoid degrading readable UI with blur, grain or dramatic color grading.",
    ],
    screenDirection: [
      "Use original imported screenshots or recordings. Preserve source aspect ratio. A tall sidebar crop belongs in a deliberate tall composition, often beside copy; do not contain it inside a huge landscape box where the meaningful controls become a tiny stripe.",
      "Compose from what matters in the screen, not from the screenshot's outer bounds. Crop unused chrome, enlarge the meaningful region, keep enough surrounding context to understand it, and check legibility in a rendered preview at the intended viewing size.",
      "Use a recorded cursor for an actual interaction when available. A synthetic pointer or focus ring may direct attention to a still, but must not imply that a real click or operation was recorded. Describe animated screenshots as animated screen captures. Show actual result states for product claims.",
      "Alternate a few strong shot scales: establishing view, detail, outcome. Keep one screen or detail dominant. Use overlapping screen cards only when their relationship is clear and the key one remains readable.",
    ],
    motionAndType: [
      "Choose timing from the selected direction. For restrained cinematic or product work at 30 fps, begin with a 12 to 24 frame entrance; promo impacts and exits may be much shorter. Keep essential copy readable for at least 1.5 seconds in a settled pose, and scale timings to the project frame rate. Use ease-out or cubic-bezier [0.22, 1, 0.36, 1] for entrances and ease-in for exits; reserve bounce for an explicitly playful brief.",
      "Give each beat one dominant event, then hold. Choose a restrained reveal or a decisive scale change according to the brief. A quiet frame gives a later move weight. Stagger related elements by 2 to 4 frames at 30 fps only when it helps the reading order. Do not replace a readable hold with continuous shake, glitch or zoom.",
      "Use one or two typefaces, a clear size hierarchy and deliberate alignment. Keep the headline short enough to fit a real measured box. Scale typography to the canvas and viewing device; inspect actual wraps, safe margins and contrast rather than trusting nominal font sizes.",
      "Do not add decorative underlines or accent rules beneath headlines by default. If a supplied recipe has an Accent line layer, inspect its named layers and hide or remove only that decorative element. Do not globally delete line shapes: functional interface dividers, waveform marks, diagrams and requested annotations have other purposes.",
      "Keep captions separate from hero titles. Reserve a caption region and test the longest phrase while the largest screen and title are visible. Leave quiet negative space instead of filling every gap with an eyebrow, chip or step number.",
    ],
    soundAndCaptions: [
      "Use a consistent narrator unless the story needs multiple speakers. Keep spoken copy natural and easy to say. Use actual aligned words from the selected take, correct proper names without inventing timestamps, and regenerate or realign when narration changes.",
      "Caption complete short phrases in one or two readable lines. Favor standard or minimal treatment for cinematic films unless contrast requires a subtle panel. Avoid bouncing every word, constant all-caps or aggressive highlighting unless explicitly requested. Check the first and last word of every take.",
      "Keep voice, music and effects on separate editable tracks. Use audio.duck under speech and short fades at joins. Analyze music before syncing cuts; a beat grid is a guide, not a reason to move every cut or disrupt spoken cadence.",
      "Review the full film with sound when playback is available. Confirm speech is intelligible, music supports it, levels are consistent and no last syllable or musical tail is chopped. Rendered stills cannot prove audio quality; if playback or loudness measurement is unavailable, report that review as unverified.",
    ],
    buildAndReview: [
      "Read cutline_editing_schema and cutline_effects_guide for supported fields. Keep graphics in named native motion layers and keyframes, screen media in media clips, and speech and captions linked. Use story assembly as a starting point; refine the actual timeline rather than repeatedly rebuilding and losing hand-tuned edits.",
      "Apply coherent revision-checked edits, preserving unrelated work. Keep scene IDs, assigned assets, references and existing brand/design data when revising. All native motion is editable 2D; do not promise unsupported 3D, tracking or external composition import.",
      "Run cutline_quality_check after the edit. Resolve relevant issues, then render its previewFrames with cutline_preview image true in batches of at most 12 frames. Also sample the start, middle and end of important moves, the longest caption, and both sides of key cuts. A sampled hold alone does not prove an entrance or transition works.",
      "Review rendered images for composition, meaningful screen size, clipping, blank gaps, aspect distortion, caption collisions, visual continuity and unnecessary ornaments. Use checksRequiringReview as the remaining human or visual/audio checklist. Fix findings and repeat only the affected checks and previews.",
      "An empty issues array is a structural check, not proof of cinematic quality. Do not invent a quality percentage, star rating or claim that the film was watched based on a tool result. State what was actually inspected and what remains unverified.",
      "When export is requested, save the editable project, call cutline_export, wait for cutline_jobs to report completion, and confirm its actual duration and output. Preview the exported result when possible. Report a usable export and editable project, with any remaining limitation stated plainly.",
    ],
    boundaries: [
      "Planning, reference selection, local narration and native editing do not authorize a paid cloud generation. Keep the existing explicit paid-generation step; do not upload images, submit provider jobs or promise their cost or availability without the user's authorization.",
      "If the user says train the AI, improve and retain app direction instructions, examples or review rules where supported. Do not claim model weights were trained, fine-tuned or permanently changed by reading this guide. Show the concrete workflow or film improvement.",
    ],
  };
}
