# Changes in 0.33.0

## Graphics Cutline makes itself

**Generate a graphic** (Motion → Vectors) turns a sentence into a graphic. Claude or ChatGPT draws an editable vector first, Cutline checks it, and then the assistant looks at its own drawing exactly as Cutline renders it and fixes what reads wrong: parts that float loose, an action the request names but the drawing doesn't show, details too faint to see. Drawings are fitted to what is actually drawn, so every graphic places at the same size and centered.

When a subject is too detailed for a clean vector (a busy scene, realistic texture, a crowd), Higgsfield paints it instead: Recraft draws it on a flat backdrop and Cutline removes the backdrop, so it sits on your video like a sticker, on its own Graphics track. This needs Higgsfield connected and **Detailed graphics as pictures** on in **Settings → Pictures and video**, which shows the price per picture. Pictures go straight into Media, so you never pay twice. After a drawing you can ask for **Make it a picture with Higgsfield instead**; after a picture, **Use the drawing instead** costs nothing because the drawing was kept.

Assistants use `cutline_graphic`, and the drawn beats in creator-style Shorts use the same route. Re-running a Short reuses its drawings instead of drawing (or paying) again, drawings build in part by part, and cancelling stops the assistants at once.

## A sharper assistant

- The built-in Claude now gets Cutline's whole editing workflow. Claude Code had been keeping only its first 2,048 characters, about a tenth of the rules. External assistants get a short core that fits, plus the full guide on request.
- Cutline uses the newest Claude Code on your Mac, so **Opus** means the newest Opus.
- In testing, a centered title now takes one edit and 12 seconds instead of two edits and half a minute.
- The chat keeps only the assistant's answer; what it is doing shows in the progress line with the time elapsed.
- Errors appear in the chat with **Try again**. **New chat** starts over. Hiding the side panel no longer erases the conversation.
- Suggestions show a plain label and fit the project: speaker recipes appear once there is video.
- The assistant knows where the playhead is and which clip is selected, so "add a title here" works.
- Agents can edit every layer of a large vector, not only the first 24.

## Faster and lighter

- Edits check the project once: a 20-step assistant edit takes about 70 ms instead of 820 ms on a real project, and every edit you make frees about 40 ms of main-process time.
- Exports share one Chrome and cap its frame cache (a quarter of free memory, 1 GB at most), and close Chrome if the window goes away mid-export.
- Preview copies of 4K, HEVC and ProRes footage use the Mac's media engine: about a quarter of the CPU.
- The preview loads each video a second before its cut, so fast cuts play without a flash or gap.
- Progress updates redraw the editor at most once per percent.
- The media cache stays under 8 GB, removing the oldest preview copies first and never the open project's.

## Logos

- Node.js, Next.js and other names with a dot come from the logo library instead of being treated as web addresses.
- A website now beats a namesake: "Gamma" is gamma.app, not a hardware chain. A logo found by name alone says so.
- **Brand logos** offers the logo from a site you type when the library doesn't have it.

Earlier: [0.32](release-0.32.md).
