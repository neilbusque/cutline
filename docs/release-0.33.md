# Changes in 0.33.3

## Room for longer Shorts

A project can hold 400 motion designs instead of 100. A creator-style Short lays out a graphic, a ring and a backdrop per beat, so a reel over about a minute with 40+ beats stopped with "This project has reached 100 motion designs". Unused designs are still dropped first when a project fills up.

# Changes in 0.33.2

## Repaired frames keep the video's colors

0.33.1's frame repair laid the fresh frame into the video without matching its color range. Remotion writes full-range video, and the repaired frame came out washed out and grey for one frame, which read as a glitch. The repair now works in RGB and converts back to the video's own pixel format, range and color matrix, and it checks every repaired frame against its fresh render before keeping the result. Frames are compared in RGB, so a limited-range and a full-range copy of the same picture no longer look different. Each fresh frame is placed by the decoded frame number the scan reported.

# Changes in 0.33.1

## Exports check every frame

Chrome, which draws each frame of an export, now and then captures one wrong. On 2026-10-24 a reel came out with two single frames showing the top of the canvas tiled five times and the speaker gone, while the preview of those moments was fine. Exporting the same project again was clean, so the fault is random.

Every export now checks its frames before it finishes. A frame that breaks from both of its neighbours while they agree with each other is drawn again on its own, and where the fresh frame differs, it replaces the damaged one. A real one-frame shot in your edit draws the same again and is kept. The job then reads **Video exported · re-rendered 2 damaged frames**. If a frame stays wrong after that, the export stops with an error instead of saving a damaged video.

The check reads a small grayscale copy of the video, so it adds a few seconds to a short reel.

# Changes in 0.33.0

## Graphics Cutline makes itself

**Generate** now opens on **Graphic**: describe a graphic in a sentence and Claude or ChatGPT draws it as an editable vector. Cutline checks the drawing, then the assistant looks at it exactly as Cutline renders it and fixes what reads wrong: parts that float loose, an action the request names but the drawing doesn't show, details too faint to see. Drawings are fitted to what is actually drawn, so every graphic places at the same size and centered. **Video** (Higgsfield) is the second mode of the same tab.

When a subject is too detailed for a clean vector (a busy scene, realistic texture, a crowd), Higgsfield paints it instead: Recraft draws it on a flat backdrop and Cutline removes the backdrop, so it sits on your video like a sticker, on its own Graphics track. This needs Higgsfield connected and **Detailed graphics as pictures** on in **Settings → Pictures and video**, which shows the price per picture. Pictures go straight into Media, so you never pay twice, and a picture interrupted by a lost connection, the time limit or a quit is picked up when you ask again instead of being bought twice. If Claude or ChatGPT can't draw at all (not installed, signed out, out of usage), Cutline says so and never turns that into a paid picture. After a drawing you can ask for **Make it a picture with Higgsfield instead**; after a picture, **Use the drawing instead** costs nothing because the drawing was kept. A failed picture offers the drawing, and a failed drawing offers the picture.

In **Story → Produce**, **Draw this shot** has Claude or ChatGPT draw a scene's whole frame as an illustration, added to Media and used as the scene's visual. Higgsfield video stays there as the paid option.

Assistants use `cutline_graphic`, and the drawn beats in creator-style Shorts use the same route, drawn by the assistant you chose in Cutline. Re-running a Short reuses its drawings instead of drawing (or paying) again: in testing a rebuild took 6 seconds instead of 72. Drawings build in part by part, and cancelling stops the assistants at once.

## A sharper assistant

- The built-in Claude now gets Cutline's whole editing workflow. Claude Code had been keeping only its first 2,048 characters, about a tenth of the rules. External assistants get a short core that fits, plus the full guide on request.
- Cutline uses the newest Claude Code on your Mac, so **Opus** means the newest Opus.
- In testing, a centered title now takes one edit and 12 seconds instead of two edits and half a minute.
- The chat keeps only the assistant's answer; what it is doing shows in the progress line with the time elapsed. Codex now works the same way, and its progress line names the step while it runs instead of after.
- **Stop** stops Cutline's own work too: nothing the assistant started lands after you press it, and changes made before it are kept. Your own work is left alone, even a transcription you and the assistant share.
- Opening another project keeps the conversation. The chat marks the switch ("Now editing ...") and the assistant knows which project is open, so "do the same for this one" works.
- Codex picks its conversation back up after a timeout or **Reconnect** instead of forgetting it.
- Errors appear in the chat with **Try again**. **New chat** starts over. Hiding the side panel no longer erases the conversation.
- Suggestions show a plain label and fit the project: speaker recipes appear once there is video.
- The assistant knows where the playhead is and which clip is selected, so "add a title here" works.
- Long jobs such as transcription no longer make the built-in assistants check back every 30 seconds, and a job longer than five minutes keeps running instead of being cut off.
- Builders tell the assistant which frames to check, and it can look up a logo or page without adding it to the timeline.
- Agents can edit every layer of a large vector, not only the first 24, and cut pauses only when you ask.

## Your projects are safer

- Autosave never writes over a project file that was changed, moved or deleted outside Cutline, and never recreates one. Your edit stays in recovery and the save warning offers **Save as**.
- If another session, Dropbox or Time Machine changed the file while Cutline was closed, Cutline opens the newer file and keeps its own copy in **File → Open backup**.
- Long jobs (captions, pause removal, Reels, music, narration) land only in the project they started on, never in a duplicate or backup of it.
- A project left locked by a crash opens again even when the Mac reuses the crashed process number.
- Quitting or closing the window during an export asks first, and stopping deletes the unfinished file.
- A crashed editor window reloads by itself; a frozen one offers **Reload editor** or **Wait**. **View → Reload editor** (Cmd+R) is always there.
- A project on a drive that wasn't mounted yet when Cutline opened is autosaved again once the drive is back, as long as the file is exactly as Cutline left it.
- If Cutline can't start (disk full, folder not writable) it says why instead of failing silently.

## Editing

- **Cmd+Z** in a text field undoes the typing; anywhere else it undoes the last edit. Undo and Redo are in the Edit menu.
- **Delete** in Properties removes the focused point, key or layer, never the whole clip.
- **Trim start**, **Trim end** and a typed Start or Duration bring a clip's captions along, and so do Speed and Source in changes.
- **Cmd+D** copies a clip with its captions; if the spot after it is taken, the copy goes on a new track.
- A click with a small wobble selects a clip instead of nudging it.
- Dragging media lights up only the tracks that can take it.
- **Ripple delete** closes the gap on the deleted clip's own track and never slides clips on other tracks onto each other. Imported subtitles follow the speech: the deleted part's lines go and later ones move back.
- Splitting a clip gives a word spoken across the cut to one side, so captions never repeat a word.
- Caption **Find & replace** changes whole words only, curly apostrophes included.
- Imported subtitle files keep every line as its own caption, even when their timings overlap.
- Trimming a captioned clip removes captions it leaves empty, and subtitle exports skip blank lines. Over a crossfade only one caption shows at a time, and changing or removing the crossfade never loses a word.
- New captions on 9:16 projects sit higher and narrower, inside the Reel safe area.
- **Generate subtitles** and **Remove long pauses** show their progress, and say when no long pauses were found.
- Creator-style Shorts cut the speaker with real splits, so captions, keys and reversed footage stay with the right piece, without repeated words at the cuts.
- Reversed clips reverse only the part they use: faster, and much less disk.

## Settings and panels

- The Pexels key moved to **Settings → Pictures and video**, beside Higgsfield.
- Errors read plainly and appear once, in the panel that failed.
- Panels lost their always-on explanation lines; the useful facts are in tooltips.
- **Draw vector** opens an empty drawing ready for points. A failed logo search says so and offers **Try again**.
- **Use Cutline example** asks before replacing a script you typed.
- Reel, Stock and Effects have their own tab icons.

## Faster and lighter

- Edits check the project once: a 20-step assistant edit takes about 70 ms instead of 820 ms on a real project.
- Undo history is compressed: 60 steps of a real project went from a 68 MB file to 10 MB, and from about 80 MB of memory to about 11 MB.
- Assistant previews reuse one warm renderer, so each preview after the first skips about 2 seconds of startup.
- Exports share one Chrome, cap its frame cache (a quarter of free memory, 1 GB at most), use their own free port, and close Chrome if the window goes away. Chrome is never left running.
- Preview copies of 4K, HEVC and ProRes footage use the Mac's media engine: about a quarter of the CPU.
- The preview loads each video a second before its cut, so fast cuts play without a flash or gap.
- The timeline redraws only what changed while you drag, and progress updates redraw the editor at most once per percent.
- The media cache stays under 8 GB, removing the oldest preview copies first and never the open project's.

## Logos

- Node.js, Next.js and other names with a dot come from the logo library instead of being treated as web addresses.
- A website now beats a namesake: "Gamma" is gamma.app, not a hardware chain. A logo found by name alone says so.
- **Brand logos** offers the logo from a site you type when the library doesn't have it.

Earlier: [0.32](release-0.32.md).
