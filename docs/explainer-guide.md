# Make an explainer

Open **Story → Explainer** to turn your written script into an editable video. Choose a style, review the scene outline, then select **Create explainer** to generate local narration, align captions and assemble the sequence.

This workflow uses the words you supply. A topic alone does not generate a factual script or research its claims. You can write your script yourself, use the included Cutline example, or work with an optional connected assistant before creating the outline.

## Start with a script

1. Create a project and choose its canvas and frame rate. Use landscape for a YouTube explainer or portrait for a Short.
2. Open **Story → Explainer** and choose a [visual style](explainer-styles.md).
3. Enter a topic or title and your script or key points. Each nonempty line starts a scene; longer passages split at sentence breaks. Remove hard line wraps if you want a paragraph to stay together. Write key points as sentences you want spoken.
4. Optionally expand **Audience & next step**. Audience is saved as planning context. The closing action appears on screen; include it in the script too if you want it spoken.
5. Select **Create outline**. Cutline keeps your narration words and creates shorter on-screen copy from them. Review both separately.

**Use Cutline example** fills in an original starter script without changing the selected style. It is a useful way to try the complete workflow without imported footage when using Kinetic type, Sketch flow or Editorial collage.

Creating a new outline over existing scenes asks you to confirm **Replace outline**. **Restore discarded draft** remains available until the next save. Changing the outline does not change the timeline yet.

## Refine the scenes

Select a scene in **Your storyline** to edit its title, narration, layout and on-screen copy. Reorder, add or remove scenes as needed. The estimated duration is a starting point; assembly allows enough time for the actual narration.

The styles use different native layouts:

| Style             | Editable scene controls                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| Kinetic type      | Headline, supporting text and motion pace                                       |
| Product focus     | Opening and closing copy, screen or split layouts, imported visual media        |
| Sketch flow       | Up to three process steps or two comparison sides                               |
| Editorial collage | Paper statement layouts, supporting text and a cutout label on editorial scenes |

Expand **Product film → Brand & colors** to change the shared brand name and palette. Layout previews show the arrangement; build the sequence to review its full animation on the canvas.

For Product focus, open **Produce**, select each screen scene, then choose **Import footage or images** and assign the relevant asset under **Use media**. Use your real screenshots or recordings. Cutline adds the frame, copy and motion; it does not generate a working interface or perform the demonstrated actions. Missing screen media blocks creation before narration begins.

For footage scenes, the existing per-scene controls remain available. **Draw this shot** has Claude or ChatGPT (whichever the Assistant uses) draw the whole frame from the shot prompt, or from the scene's title and narration when the prompt is empty. The drawing is added to Media as an image at the project's size and becomes the scene's visual; save the storyline to keep it. It uses your assistant sign-in, not Higgsfield credits. Optional Higgsfield generation is a separate explicit action that uses the connected provider account. **Create explainer** does not submit paid generation requests.

## Create narration and the timeline

1. In **Create your explainer**, choose a voice and pace. The current local voices are English.
2. If prompted, select **Set up local voice**. Initial model downloads need internet access. Source builds also need the local transcription tools from [development setup](development.md). Once installed, synthesis and caption alignment run locally.
3. Choose whether to add timed captions. Caption style and optional background music are available in **Finish**.
4. Select **Create explainer**. Cutline saves your outline, processes narration one scene at a time and builds the editable sequence. Progress appears in Story and **Jobs**.
5. Play the result with sound. Check pronunciation, caption wording and timing, screen legibility and the final line before exporting.

Unchanged narration is reused when the script, voice and pace still match and the audio is available. If caption alignment failed, retrying can align the saved audio without synthesizing another take. When captions are requested but cannot be aligned, automatic assembly stops and keeps the completed narration. Retry after repairing the transcription setup, or turn captions off if you want to finish them separately.

Use **Cancel explainer** or cancel its job in **Jobs** to stop production. Finished narration stays available for another attempt. The timeline is built only after the batch finishes successfully. Opening another project or changing the storyline during production stops automatic assembly rather than applying a stale result.

## Keep editing and export

The result contains ordinary editable motion, media, narration and caption clips. You can change layers and keyframes, replace media, adjust timing, correct captions and mix music using the existing editor controls. This is native 2D motion; it does not add true 3D scenes, automatic character rigs or automatic photo cutouts.

Selecting **Create explainer** again rebuilds the previous story sequence while preserving unrelated timeline clips. Direct edits to that story sequence may be replaced by a later rebuild, so decide whether you want to keep refining the outline or finish the assembled timeline by hand. The existing per-scene narration and manual **Build video on timeline** controls remain available.

Save the `.cutline` project and keep its source media available. Choose **Export**, wait for the job to finish and review the exported MP4 with sound before sharing. See [getting started](getting-started.md#save-move-and-reopen-projects) for moving projects and [local voiceover](kokoro-tts.md) for speech setup.

For assistants and MCP clients, see [explainer tools](agent-control.md#explainers).
