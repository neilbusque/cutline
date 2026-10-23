# Creator shorts

Cutline has two formats for short speaker-led videos:

| Format            | Use it for                                 | Treatment                                                                                                                                   |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Creator punch** | One spoken idea delivered to camera        | Full-frame speaker, short bold white captions with dark outlines, lime highlights on spoken words, quick punch-ins and sparse text emphasis |
| **Screen demo**   | Explaining a real tool, workflow or result | The same readable speaker treatment, with screenshots or recordings at times you choose                                                     |

The formats use the original voice. Choose clean styling and recommended captions to get the default treatment. All footage, captions, proof shots, motion and keyframes remain editable on the timeline.

## Reference direction

The requested direction combines techniques observed in sampled frames from [Nathan Bentley's speaker-led Short](https://www.youtube.com/shorts/3TSXl0zJVaE), [his inset-evidence Short](https://www.youtube.com/shorts/3dwekvkVU8w) and [Nate Herk's software-demo Short](https://www.youtube.com/shorts/GnFFcLnmWuQ): a full-frame speaker, short bold outlined captions, and brief switches to real visual evidence. Nate's sampled frames also showed an upper visual with the speaker below and full-screen software evidence.

Creator punch and Screen demo apply these techniques to your own footage. The reference review used frame samples, so it does not establish exact pacing, transitions or audio treatment. The current proof layouts show one selected proof asset at a time; they do not automatically build a collage of several images.

## Build with your own proof

1. Import the speaker video and the screenshots or screen recordings you want to show.
2. Open **Reel Builder**, select the speaker footage and continue to **Style**.
3. Choose **Creator punch** or **Screen demo**.
4. Under **Proof shots**, select **Add proof shot**. Choose a source clip and the exact proof image or video.
5. Set **Show at** to the time in the original source clip, then set the shot's duration. For a proof video, set **Start proof video at** to its own start time.
6. Choose **Screen above speaker** or **Full-screen proof**. Add more shots as needed.
7. Continue to **Finish**, review captions and build the Reel. Choose append to keep an existing timeline.

Use a real screenshot or recording that supports the spoken point. Cutline does not choose an arbitrary imported asset as proof. With no proof shots, Screen demo keeps the speaker full frame. Every proof video is muted so the original speech continues once.

**Show at** refers to the original source clip, before edits. It is not the time on the finished timeline. **Duration** is the length of the proof shot in the finished Reel. A source photo starts at zero. A proof image has no separate start time.

Each proof shot must last 0.5 to 12 seconds and fit completely inside the selected source's used range. A proof video must also have enough media remaining after its start time. Shots can touch but cannot overlap. Changing your target length, source selection or source order may change which times fit. The builder checks these ranges before creating the Reel.

## Auto edit

**Auto edit** offers both formats for a single speaker video. Creator punch selects tight pacing; Screen demo selects natural pacing. Both select clean styling and the recommended captions, and start with stock B-roll, generated background music and the opening title off. These choices remain editable.

Use **Reel Builder** for deliberate proof-shot timing. Auto edit does not accept proof-shot rows. Auto edit replaces the current timeline; Undo restores it.

## Assistant API

Use `cutline_inspect` to get the actual project, revision and imported asset IDs. Ask the assistant to inspect the relevant source and transcript before choosing proof timings.

`cutline_create_reel` accepts `options.format: "creator-punch"` or `"screen-demo"` and an optional `options.proofBeats` array. A proof beat has this shape:

```json
{
  "sourceIndex": 0,
  "sourceSeconds": 8.2,
  "assetId": "<imported screenshot or recording ID>",
  "sourceIn": 0,
  "durationSeconds": 3,
  "layout": "split"
}
```

This is an object inside `options.proofBeats`, not a standalone tool call. Replace the example timing with a verified moment in your footage. `sourceIndex` is zero-based in `options.sources`. `sourceSeconds` is absolute source-media time before source trimming or speed changes. `sourceIn` belongs to the proof media and is optional; omit it or use zero for an image. `durationSeconds` is output timeline time, even when the speaker source has a playback-speed change. Use `layout: "cutaway"` for full-screen proof. Up to 24 shots are supported.

Omit `captionStyle` for the format's recommended caption treatment. An explicit caption-style choice remains in effect. Omit `beats` for transcript-based text emphasis and punch-ins; `beats: []` disables them. `proofBeats` controls the selected visual evidence separately. Do not pass `proofBeats` to `cutline_auto_edit`.

## Review the result

Play the Reel with sound. Check the opening, every proof entrance and exit, the longest caption and the final spoken words. Read the screen at phone size. Confirm that captions and essential screen controls remain visible, and that the source voice is continuous through proof shots. Reframe the speaker or choose a tighter screen crop if needed. Split layouts use fixed framing, without face tracking.

Save the editable project before exporting. These formats are a starting treatment for original footage, not an exact reconstruction of another creator's video.
