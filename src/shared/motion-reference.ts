/** Original direction distilled from dated primary references, not creator presets. */
export const motionReferenceGuide = {
  reviewed: "2026-10-25",
  primaryQualityTarget: {
    creator: "Aasil Khan",
    instruction:
      "Neil explicitly wants Aasil-level film craft and styles. Make confident subject scale, strong type, purposeful depth/layering, a developing visual action and a visible payoff the primary standard. The app's calm UI is not a reason to make muted paper slides. Use the source-appropriate form; preserve useful real presenter/process footage.",
    contract: "docs/motion-reference-library/aasil-quality-contract.md",
    treatments: [
      {
        id: "depth-demo",
        intent:
          "A substantial visual artifact is staged as layered planes, then promoted to a large legible detail and result. Use ink/neutral value contrast and one purposeful blue/violet accent. Use Creator studio depth/path/handoff scenes, with animatable rotateX/rotateY/perspective and per-layer type overrides. Native plane tilt is 2.5D, not a 3D scene or face tracking.",
      },
      {
        id: "process-film",
        intent:
          "Real work and meaningful close-ups build toward the actual finished artifact. Preserve warm natural skin, separate neutral screens, selected large type and a clear process-to-result handoff. Do not fabricate client proof or borrow the reference's private work.",
      },
      {
        id: "kinetic-world",
        intent:
          "One coherent object or relationship develops through bold type, a traced process or a diagram. Change the visual mechanism with the sentence. Keep strong composed holds and a decisive final state rather than a run of labels on cards.",
      },
    ],
    review:
      "Compare the representative segment to inspected Aasil frames for subject scale, hierarchy, useful depth, actual visible change, settled reading holds and payoff. If the result is still a small heading above a generic card, revise the composition before polishing effects. Render and inspect Creator studio scenes before treating them as a quality benchmark.",
  },
  evidence:
    "Public channel inventories plus selected timestamped frame sequences. Not every video watched; sound and exact easing were not established by frame sampling.",
  docs: "docs/motion-reference-library/README.md",
  workflow: [
    "Choose the form from the material: presenter-supported tutorial, faceless product demonstration, data/diagram explanation, footage-led story, or kinetic statement. A missing presenter cannot be replaced by a static avatar and called a talking-head edit.",
    "Write each beat as purpose, visible subject, action or state change, source passage, composition, shot scale, spoken line, settled reading hold, bridge and sound event. Identify the final visible payoff before selecting a recipe. Do not invent business facts or product behavior.",
    "Set a film-specific style brief with exact palette, type, framing, motion timing and avoid list. Keep this separate from the beat sheet and source evidence. Reuse a coherent visual world while the action develops. Do not rotate effects by beat index or enforce a cut every second.",
    "For style_reel, author entrance cut|fade|rise|slide-left|pop, backdrop plain|sunburst|grid, background #RRGGBB, emphasis none|ripple, framing contain|fill and sourceIn where appropriate. Prefer a cut/contain for readable proof, a short rise for a new idea and one selective pop for impact. Omitted fields keep the older treatment. Explicit entrance suppresses implicit ripples and continuous card drift. Inspect directionReview notes; they prompt review, not mandatory random variation.",
    "Compare adjacent beats by subject, composition, scale, action, transition and sound. If the same headline/card/entrance repeats without new action, change the visual mechanism. Keep a sustained demonstration or personal performance when it continues to develop. A different backdrop color alone is not a different idea.",
    "Build a representative moving passage before a full weak-reel remake. Inspect the entrance, settled hold, exit and both sides of cuts, then play the whole film with sound when possible. Frame samples, technical decode and structural checks cannot certify pacing or the mix.",
  ],
  techniques: [
    {
      id: "proof-takes-over",
      use: "Software or a visible operation",
      picture:
        "Presenter and large proof share the frame; the actual control/result becomes full frame when it needs attention; return to the speaker for the consequence.",
      native:
        "style_reel split/full/speaker beats, kind asset with sourceIn and framing contain. Use a real recording for the action; an animated still cannot prove a successful click.",
    },
    {
      id: "persistent-transfer",
      use: "Automation, message passing, dependencies",
      picture:
        "Connections establish the relationship, a packet travels, the receiver changes state, then the wider system resolves.",
      native:
        "motion.scene editorial-transfer, then edit named nodes, path, packet and state layers. Native editable 2D, not automatic graph or data inference.",
    },
    {
      id: "comparison-resolves",
      use: "An actual before/after or competing states",
      picture:
        "Establish both states, reveal the difference, hold the result. The divider has a comparison job rather than decorating a headline.",
      native:
        "motion.scene editorial-compare for an illustrative diagram; real before/after media in separate clips for product evidence. Keep labels and claims source-supported.",
    },
    {
      id: "context-detail-result",
      use: "A small control, structured detail or result",
      picture:
        "Establish context, direct attention to one meaningful area, and resolve to a readable result with a stable hold.",
      native:
        "motion.scene editorial-focus for an illustrative focus sequence. Use imported crops and clip keyframes for actual UI. Synthetic focus does not demonstrate a recorded interaction.",
    },
    {
      id: "data-develops",
      use: "Verified data or a real process",
      picture:
        "Bars, points or paths change with the explanation. Labels and numbers share one dataset. Show the comparison and conclusion, not decorative random bars.",
      native:
        "Named rectangle/path/text layers with native scale/position/trim keyframes; preserve the real data in the project brief. No automatic chart engine or geographic route inference is promised.",
    },
    {
      id: "object-handoff",
      use: "Connected concepts or a reveal",
      picture:
        "A meaningful object, word, edge or visual center persists across the cut and becomes part of the next composition.",
      native:
        "Match outgoing/incoming layer poses and clip positions at adjacent frames. Use 2D transforms or imported footage for spatial material. No arbitrary shape morphing or true 3D camera.",
    },
    {
      id: "type-turn",
      use: "One short emphasis or narrative turn",
      picture:
        "A large phrase or palette inversion punctuates the point, then yields to evidence or the speaker. Preserve a readable complete phrase.",
      native:
        "Native text layers and promo scenes; optional short rgbSplit/invert clip keys returned to zero. Avoid continuous glitch, repeated flash and decorative underlines.",
    },
    {
      id: "process-story",
      use: "Making something or explaining a lived result",
      picture:
        "Real work, meaningful detail, timeline/process and finished outcome supply the progression. Quiet footage-led passages may carry the story without extra graphics.",
      native:
        "Imported coherent footage, motivated cuts, aligned captions and selected physical sound accents. Keep continuity and original voice.",
    },
  ],
  colorAndEffects: [
    "Correct individual shots first: compare exposure, contrast, neutral surfaces and skin on adjacent frames. Then choose an artistic treatment. These controls are global CSS-based looks, not LUTs, scopes, HDR management or selective skin correction.",
    "Use studio as a gentle presenter starting point, soft-film for a soft editorial treatment, crisp-mono for a purposeful monochrome insert, or none for faithful UI. Adjust effectAmount after viewing the source. Strong cinematic/teal-orange/vintage looks are choices, not mandatory finishing.",
    "In Effects, Copy look to this track copies only look and strength, preserving each shot's brightness/contrast/saturation correction. Apply to all video & photos copies those corrections too and must be chosen deliberately; it is not automatic color matching.",
    "Keep screens/logos on separate ungraded clips when their colors carry meaning. Protect neutral whites and small type. Reserve grain, vignette, inversion, RGB split and blur for a stated role; inspect their maximum and clean settled state. No effect quota.",
  ],
  sound: [
    "Spot sound against a specific visual event: frame, action, intended intensity, duration, speech overlap, source/license and fade. Choose a click for a click, a material sound for a material action, or silence. Do not reuse a whoosh on every transition.",
    "Search Openverse kind audio for an actual sound, preview it, retain attribution and place it on a separate audio track. Read the source license. Openverse indexes audio and images, not video B-roll. Imported sound is audible and still needs level/trim/fade review with the voice.",
    "Analyze actual music before claiming beat sync. Listen to complete playback before describing the mix, pronunciation or caption synchronization as checked. Never infer these from channel titles, transcripts or stills.",
  ],
  references: [
    {
      creator: "Jack Roberts",
      channel: "https://www.youtube.com/@Itssssss_Jack",
      video: "https://www.youtube.com/shorts/dw29554HucM",
      inspected: "0-6s dense sequence; complete Short sampled",
      lesson:
        "Persistent object, code-to-output proof, promotion to full frame",
    },
    {
      creator: "Jack Roberts",
      video: "https://www.youtube.com/shorts/3kJD-InLnTY",
      inspected: "Complete 51s Short sampled",
      lesson:
        "A personal performance can sustain the shot; no universal cut cadence",
    },
    {
      creator: "Jack Roberts",
      video: "https://www.youtube.com/watch?v=KphrV76DJoI",
      inspected:
        "0-65s, 180-270s, 580-660s sampled; primary description and linked repository",
      lesson: "Separate style brief, references, storyboard and frame review",
      upstream: "https://github.com/ItsssssJack/claude-video-2",
    },
    {
      creator: "Nick Automates",
      channel: "https://www.youtube.com/@nickautomates/shorts",
      video: "https://www.youtube.com/watch?v=a99VVqGgVM8",
      inspected: "0-4.4s and 9-13.4s dense sequences; complete Short sampled",
      lesson:
        "Proof changes format with its job; Openverse is named in source description for sound sourcing",
    },
    {
      creator: "Nick Automates",
      video: "https://www.youtube.com/watch?v=bHIMNW_4mlg",
      inspected: "0-4.4s dense sequence; complete Short sampled",
      lesson: "Example, result and customizable motion direction",
    },
    {
      creator: "Aasil Khan",
      channel: "https://www.youtube.com/@aasil_khan_",
      video: "https://www.youtube.com/watch?v=THhoOfIwn18",
      inspected: "0-5.5s dense sequence; complete Short sampled",
      lesson:
        "Chart, map and type have distinct visual mechanisms while the presenter continues",
    },
    {
      creator: "Aasil Khan",
      video: "https://www.youtube.com/watch?v=WMOiqyL4IZE",
      inspected: "50-61s dense sequence; complete Short sampled",
      lesson:
        "Real process footage develops into the visible finished artifact",
    },
  ],
};
