# Getting started

Cutline is a desktop video editor for Apple Silicon Macs running macOS 15 or later. This release supplies source code. Follow [development setup](development.md) to build and open the editor, then use the steps below. If you already have a trusted local build, start with your first edit.

## Make your first edit

1. Create a project. Choose the canvas and frame rate before adding clips. Use portrait for Shorts, landscape for a YouTube video, or square when that suits your destination.
2. Open **Media** and import video, images or audio. Dropping files into Cutline also imports them.
3. Add a media item with its add button, by double-clicking it, or by dragging it to a compatible timeline track. Selecting a thumbnail alone does not add it.
4. Select a timeline clip to change its timing, position, scale, volume or appearance in **Properties**. The playhead sets the moment you are previewing.
5. Add captions, text, motion or audio as needed. Play the full edit with sound.
6. Choose **Export**, select a new output filename and wait for the export job to finish. Open the MP4 and review it before sharing.

Export uses the project's canvas size and frame rate and produces H.264 video with AAC audio. It captures a project snapshot, so later edits do not change an export already running.

## Choose a workflow

| Workflow                              | Start here                 | What happens                                                                                                    |
| ------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Edit footage yourself                 | **Media** and the timeline | Add, trim and arrange clips; add effects, text and audio separately                                             |
| Turn one speaker video into a Reel    | **Reel → Auto edit**       | Transcribe, shorten pauses and build a new vertical edit; it replaces the current timeline, with Undo available |
| Choose source order and proof timings | **Reel → Build manually**  | Open Reel Builder to select footage, a format and finish options; append can keep an existing edit              |
| Build a video from a script           | **Story**                  | Plan scenes, choose imported or explicitly generated visuals, produce narration, then build the sequence        |
| Create an animated sequence           | **Motion → Sequence**      | Start from a connected sequence and edit its text, colors, layers and timing                                    |

Auto edit works from an opening passage of the source; it is not a promise to find the best moment anywhere in a long recording. Review the chosen passage, captions and any stock matches. [Reel formats](reel-formats.md) explains the treatments.

For a speaker-led Short, choose **Creator punch**. For a demonstration, choose **Screen demo**. Open **Reel → Build manually** for Reel Builder, then use **Style → Proof shots** to select the actual screenshot or recording. The original voice continues while proof media is muted. [Build a creator Short](creator-shorts.md).

## Add and correct captions

Select footage with speech, then open **Captions** and generate captions. Transcription runs locally and needs the Whisper tool and model installed. Correct names and wording in **Edit words**, then choose a style and check the longest caption on the preview.

Captions are editable timeline clips. Their word highlights follow available aligned speech timings. If a correction changes the number of words, Cutline cannot invent new word timings. Review captions after retiming or replacing speech.

SRT import and export carry subtitle text and timing, without animated word highlights, fonts or visual effects.

## Add voiceover and music

Open **Audio → Text to speech**, paste your script, choose a voice and pace, then select **Generate voiceover**. Listen before adding it to the timeline. If the model is missing, use the offered download or follow [source setup](development.md).

Kokoro runs locally and currently provides English voices. A script entered directly into Text to speech stays in local processing. A script sent through assistant chat is also shared with that assistant provider. [Voiceover details](kokoro-tts.md).

Use **Audio → My audio** for imported or generated audio. **Music sync** provides beat analysis and timing controls. Lower music under narration and check the mix with sound.

## Save, move and reopen projects

A `.cutline` file stores the editable project. Imported media is referenced, so keep the original video, audio and image files available. Saving a project does not collect all media into a portable archive.

The installed app's main session saves nonempty projects in **Movies → Cutline** by default. Use **File → Save as** to choose another location. **Projects** and **File → Open Recent** reopen work. **File → Open backup** opens a recovery copy that you can save under a new name.

Development builds and separate sessions use their own project/data folders. If media moves, use **Relink missing file** in Media. When sharing a project, include its source files and verify that the recipient can relink them.

## Work on separate videos

Use **Sessions** in the title bar and choose **New session**. Each session has its own project, recovery state and jobs. Use a separate project file for each video.

For an external assistant, choose **Copy Codex prompt** in the intended session and include that prompt in the editing chat. Connected tools use a `sessionId` to identify the correct window. Calls without a session ID are rejected when several sessions are active. [Agent connection guide](agent-control.md).

## Connect an assistant

Open **Settings & connections → Connect an assistant** and choose your client. Use **Test local connection**, then ask the client to inspect the current project without editing it. A local bridge check and a successful client inspection establish different parts of the connection.

The built-in Assistant can use Claude or Codex with the required installed client and sign-in. Account access and usage limits apply. No assistant account is needed for manual editing, local captions or local export.

A useful first brief is:

> Inspect this project. Make a 20-second introduction with the imported footage, my title and the supplied narration. Keep everything editable. Preserve existing work, show me preview frames and check the export job before calling it finished.

## Keyboard basics

| Action            | Shortcut                                                    |
| ----------------- | ----------------------------------------------------------- |
| Play or pause     | Space, when a text field or another control is not using it |
| Step the playhead | Left or Right arrow in the editor's playback context        |
| Undo / redo       | Command-Z / Shift-Command-Z                                 |
| Save              | Command-S                                                   |
| Save as           | Shift-Command-S                                             |
| Open Projects     | Command-O                                                   |

For missing media, failed exports or connection problems, see [troubleshooting](troubleshooting.md).
