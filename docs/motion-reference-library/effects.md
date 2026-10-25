# Effects and native tools

Choose an effect's purpose first: reveal, guide attention, explain a relationship, compare states, imply depth, or punctuate a turn. Choose the smallest supported mechanism that performs that job. No effect quota.

For the Aasil quality target, start with **Motion > Scenes > Creator studio**: Depth stages a dominant composition on layered perspective planes; Path develops a persistent object through a traced process; Handoff resolves that object into large typography. The three scenes share an authored visual world and stay editable. Customize their actual content and bridge poses for the film rather than concatenating presets unchanged.

Clips and motion layers expose `rotateX`, `rotateY` (−85° to 85°) and `perspective` (200–8000 canvas pixels). All three can be keyframed. Use the existing clip center or layer anchor, keep a readable frontal hold, and inspect projected edges and overlaps. Alignment/snap bounds still describe the flat layout box. These are 2.5D plane projections, not mesh geometry or a 3D camera. Motion layers can also override the supported `fontFamily` and choose `fontStyle:italic`, allowing a restrained serif accent beside a heavy sans headline.

| Mechanism               | Native route                                                                 | Review                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Connected transfer      | `motion.scene` `editorial-transfer`; named path, nodes, packet and receiver  | Connection precedes travel; arrival causes a state change; final relationship is readable |
| Before/after comparison | `motion.scene` `editorial-compare`, or imported real state clips             | Distinguish illustration from evidence; hold both states and the conclusion               |
| Context to detail       | `motion.scene` `editorial-focus`, or actual media crops and clip keys        | Meaningful detail remains legible; a synthetic focus ring does not prove a real click     |
| Proof takes the frame   | Style beats `split` then `full`, `kind:asset`, `sourceIn`, `framing:contain` | Source passage shows the named action; essential controls and captions fit                |
| Quiet cut               | `entrance:cut`, `backdrop:plain`, `emphasis:none`                            | Voice and action continue; no unintended blank first frame                                |
| New idea rises          | `entrance:rise` or `slide-left`                                              | Entrance, clean settle and reading hold; no movement through essential controls           |
| Selective impact        | `entrance:pop`, optional `emphasis:ripple`                                   | One meaningful accent; no ring added to every beat                                        |
| Data/path reveal        | Named text/rectangle/path layers with scale, position and trim keys          | Real values and labels agree; don't infer chart data or geographic routes                 |
| Typographic turn        | Current promo or native type scenes                                          | Whole phrase readable; optional RGB/invert returns to clean hold                          |
| Depth impression        | Separate 2D layers, deliberate scale/position/parallax                       | Subject remains coherent; imported footage needed for true spatial objects                |

Discover current scene IDs through `cutline_editing_schema` section `guide`, and inspect `action:motion.scene`. Set `durationFrames` when creating the scene to retime choreography. Changing clip duration later changes its hold, not the authored key times. Refine returned named layers with revision-checked `cutline_edit` actions.

Style-reel optional fields:

| Field        | Values                                     | Decision                                                                   |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| `entrance`   | `cut`, `fade`, `rise`, `slide-left`, `pop` | Let evidence cut cleanly; animate selected explanatory objects             |
| `backdrop`   | `plain`, `sunburst`, `grid`                | Support this film's world, not an automatic creator palette                |
| `background` | `#RRGGBB`                                  | Preserve coherent color and contrast between beats                         |
| `emphasis`   | `none`, `ripple`                           | Mark a particular event                                                    |
| `framing`    | `contain`, `fill`                          | Contain screens that must remain intact; fill only when crop is acceptable |
| `sourceIn`   | Nonnegative proof-video seconds            | Show the correct passage and continue its action across beats              |

Omitting fields retains older treatment. Choosing an explicit entrance suppresses the automatic split ripple and continuous card drift. Background windows split when treatment or color changes, so a chosen dark/light transition is retained. Text contrast follows a custom background; preview logos and colored artwork too.

`directionReview` returns editorial notes with time ranges, including repeated composition and repeated source passage. These are prompts for review, not proof of poor quality or commands to force a random change. Locked split demonstrations are allowed to sustain their layout.

Grain, vignette, light leaks, RGB split, inversion and blur can support a particular idea. Check their peak as well as the settled frame. Protect viewers' reading time and source color when it matters. Native Cutline remains editable 2D, without automatic tracking, rotoscoping, arbitrary shape morphing, LUTs or true 3D rendering.
