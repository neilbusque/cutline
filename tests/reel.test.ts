import {describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/main/store';
import {applyCommands} from '../src/shared/commands';
import {makeClip, newProject, validateProject, type Asset, type Project} from '../src/shared/model';
import {createReelPlan, reelCaptionClips, reelWordsForClip, type ReelOptions} from '../src/shared/reel';

function asset(id: string, duration = 30, kind: Asset['kind'] = 'video'): Asset {
  return {id, name: id, path: `/local/${id}`, kind, duration, hasAudio: kind !== 'image'};
}
function fixture(): Project {
  const p = newProject();
  p.assets = [asset('voice', 90), asset('second', 20), asset('short', 1), asset('photo', 0, 'image'), asset('broll', 12), asset('music', 30, 'audio')];
  p.assets[0].words = Array.from({length: 90}, (_, index) => ({text: index % 5 === 4 ? `word${index}.` : `word${index}`, start: index, end: index + .7}));
  return p;
}
function build(p: Project, options: Partial<ReelOptions> = {}) {
  const plan = createReelPlan(p, {sources: [{assetId: 'voice'}], targetSeconds: 30, mode: 'replace', ...options});
  const next = applyCommands(p, {projectId: p.id, revision: p.revision, label: plan.label, commands: plan.commands});
  return {plan, next};
}
function assertClipSafety(p: Project) {
  expect(validateProject(p)).toBeTruthy();
  for (const clip of p.clips) {
    expect(Number.isInteger(clip.start)).toBe(true);
    expect(Number.isInteger(clip.duration)).toBe(true);
    expect(clip.start).toBeGreaterThanOrEqual(0);
    expect(clip.duration).toBeGreaterThan(0);
    const source = p.assets.find(item => item.id === clip.assetId);
    if (source && source.kind !== 'image') expect(clip.sourceIn + clip.duration / p.fps * clip.speed).toBeLessThanOrEqual(source.duration + 1e-7);
    for (const word of clip.words) {
      expect(word.start).toBeGreaterThanOrEqual(0);
      expect(word.end).toBeGreaterThan(word.start);
      expect(word.end).toBeLessThanOrEqual(clip.duration / p.fps + 1e-7);
    }
  }
}

describe('Reel planning', () => {
  it('applies an entire Reel as one undoable and redoable edit', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'cutline-reel-test-'));
    try {
      const store = new Store(path.join(directory, 'recovery.json'));
      const original = fixture();
      original.clips = [makeClip(original, 'video', 'video', 90, original.assets[1])];
      store.commit(original, 'Existing project');
      const before = structuredClone(store.project);
      const plan = createReelPlan(store.project, {sources: [{assetId: 'voice'}], targetSeconds: 30, mode: 'replace', hook: 'Start here', cta: 'Save this', brollAssetIds: ['broll'], musicAssetId: 'music'});
      store.transact({projectId: store.project.id, revision: store.project.revision, label: plan.label, commands: plan.commands});
      const after = structuredClone(store.project);
      expect(after.clips.length).toBeGreaterThan(4);
      const restored = store.undo().project;
      expect({...restored, revision: before.revision}).toEqual(before);
      const redone = store.redo().project;
      expect({...redone, revision: after.revision}).toEqual(after);
    } finally { rmSync(directory, {recursive: true, force: true}); }
  });

  it.each([15, 30, 60, 90] as const)('makes an exact %is Reel from available footage without changing the input', targetSeconds => {
    const p = fixture(), original = structuredClone(p);
    const {plan, next} = build(p, {targetSeconds, hook: 'A useful hook', cta: 'Save this Reel', brollAssetIds: ['broll', 'photo']});
    expect(plan.durationFrames).toBe(targetSeconds * p.fps);
    expect(Math.max(...next.clips.map(clip => clip.start + clip.duration))).toBe(plan.durationFrames);
    expect(plan.captionCount).toBeGreaterThan(0);
    expect(plan.brollCount).toBeGreaterThan(0);
    expect(p).toEqual(original);
    assertClipSafety(next);
  });

  it.each([24, 25, 30, 60] as const)('keeps the project frame rate %i while using the portrait canvas', fps => {
    const p = fixture(); p.fps = fps; p.width = 1920; p.height = 1080;
    const {plan, next} = build(p, {targetSeconds: 15});
    expect(next.fps).toBe(fps);
    expect([next.width, next.height]).toEqual([1080, 1920]);
    expect(plan.durationFrames).toBe(fps * 15);
    assertClipSafety(next);
  });

  it('redistributes duration from short media and retains ordered sources', () => {
    const {plan, next} = build(fixture(), {sources: [{assetId: 'short'}, {assetId: 'second'}, {assetId: 'photo'}]});
    const clips = next.clips.filter(clip => clip.kind === 'video' || clip.kind === 'image');
    expect(clips.map(clip => clip.assetId)).toEqual(['short', 'second', 'photo']);
    expect(clips[0].duration).toBe(30);
    expect(clips[1].start).toBe(30);
    expect(clips[2].start).toBe(clips[1].start + clips[1].duration);
    expect(plan.durationFrames).toBe(900);
    assertClipSafety(next);
  });

  it('stops at source end when there is insufficient media, with no frozen padding or loops', () => {
    const {plan, next} = build(fixture(), {sources: [{assetId: 'short'}], targetSeconds: 60, hook: 'Open', cta: 'Close'});
    expect(plan.durationFrames).toBe(30);
    expect(plan.warnings.join(' ')).toContain('1.0 seconds');
    expect(next.clips.every(clip => clip.start + clip.duration <= 30)).toBe(true);
    const titles = next.clips.filter(clip => clip.kind === 'text');
    expect(titles[0].start + titles[0].duration).toBeLessThanOrEqual(titles[1].start);
    assertClipSafety(next);
  });

  it('clamps out points, skips subframe sources, and gives useful empty-media errors', () => {
    const p = fixture(); p.assets.push(asset('subframe', .001));
    const {plan, next} = build(p, {sources: [{assetId: 'subframe'}, {assetId: 'short', sourceOut: 100}]});
    expect(plan.footageCount).toBe(1);
    expect(plan.warnings.join(' ')).toContain('no usable frames');
    expect(plan.warnings.join(' ')).toContain('limited to the end');
    assertClipSafety(next);
    expect(() => build(p, {sources: []})).toThrow('Choose at least one');
    expect(() => build(p, {sources: [{assetId: 'subframe'}]})).toThrow('no usable video frames');
    expect(() => build(p, {sources: [{assetId: 'music'}]})).toThrow('not a video or photo');
    expect(() => build(p, {sources: [{assetId: 'voice', speed: 0}]})).toThrow('Playback speed');
  });

  it('maps trimmed, accelerated source words exactly into the generated captions', () => {
    const p = fixture();
    p.assets[0].words = [{text: 'before', start: 1, end: 2}, {text: 'cut', start: 3.5, end: 4.5}, {text: 'keep', start: 5, end: 6}, {text: 'after', start: 12, end: 13}];
    const {next} = build(p, {sources: [{assetId: 'voice', sourceIn: 4, sourceOut: 10, speed: 2}]});
    const footage = next.clips.find(clip => clip.kind === 'video')!;
    expect(footage.duration).toBe(90);
    expect(reelWordsForClip(p.assets[0], footage, p.fps)).toEqual([{text: 'cut', start: 0, end: .25}, {text: 'keep', start: .5, end: 1}]);
    const caption = next.clips.find(clip => clip.kind === 'caption')!;
    expect(caption.words).toEqual([{text: 'cut', start: 0, end: .25}, {text: 'keep', start: .5, end: 1}]);
    expect(caption.duration).toBe(30);
    assertClipSafety(next);
  });

  it('clips words at both source boundaries and prevents caption overlap at fractional frame edges', () => {
    const p = fixture(), a = p.assets[0];
    a.words = Array.from({length: 20}, (_, i) => ({text: `word${i}`, start: 2 + i * .123, end: 2.1 + i * .123}));
    const clip = {...makeClip(p, 'video', 'video', 150, a), sourceIn: 2.03, duration: 43, speed: 1.3};
    const captions = reelCaptionClips(p, a, clip, 'captions', 'bold');
    expect(captions.length).toBeGreaterThan(1);
    for (let i = 0; i < captions.length; i++) {
      const caption = captions[i];
      expect(caption.start).toBeGreaterThanOrEqual(clip.start);
      expect(caption.start + caption.duration).toBeLessThanOrEqual(clip.start + clip.duration);
      if (i + 1 < captions.length) expect(caption.start + caption.duration).toBeLessThanOrEqual(captions[i + 1].start);
      for (const word of caption.words) expect(word.end).toBeLessThanOrEqual(caption.duration / p.fps);
    }
  });

  it('keeps narration on full-volume footage while muting B-roll and fading a quiet music bed', () => {
    const {plan, next} = build(fixture(), {brollAssetIds: ['voice', 'broll'], musicAssetId: 'music', targetSeconds: 60});
    const source = next.clips.find(clip => clip.assetId === 'voice')!;
    expect([source.volume, source.fadeIn, source.fadeOut]).toEqual([1, 0, 0]);
    const overlays = next.clips.filter(clip => clip.assetId === 'broll');
    expect(overlays.length).toBeGreaterThan(0);
    for (const clip of overlays) {
      expect(clip.volume).toBe(0);
      expect(next.tracks.find(track => track.id === clip.trackId)?.muted).toBe(true);
      expect(clip.start).toBeGreaterThanOrEqual(90);
      expect(clip.start + clip.duration).toBeLessThanOrEqual(plan.durationFrames - 90);
      expect(next.tracks.findIndex(track => track.id === clip.trackId)).toBeLessThan(next.tracks.findIndex(track => track.id === source.trackId));
    }
    expect(next.clips.filter(clip => clip.assetId === 'voice')).toHaveLength(1);
    const music = next.clips.find(clip => clip.assetId === 'music')!;
    expect([music.duration, music.volume]).toEqual([900, .16]);
    expect(music.fadeOut).toBeGreaterThan(0);
    expect(plan.warnings.join(' ')).toContain('music ends before');
    assertClipSafety(next);
  });

  it('replaces only in explicit replace mode, preserving media and custom motions', () => {
    const p = fixture(), old = makeClip(p, 'video', 'video', 300, p.assets[1]); p.clips = [old];
    const {plan, next} = build(p, {mode: 'replace'});
    expect(plan.startFrame).toBe(0);
    expect(next.clips.some(clip => clip.id === old.id)).toBe(false);
    expect(next.assets).toEqual(p.assets);
    expect(next.motions).toEqual(p.motions);
    expect(next.id).toBe(p.id);
    expect(next.revision).toBe(p.revision + 1);
  });

  it('appends after the existing edit by default and preserves existing layer relationships', () => {
    const p = fixture(); p.width = 1920; p.height = 1080;
    const old = makeClip(p, 'video', 'video', 300, p.assets[1]); p.clips = [old];
    const originalTracks = p.tracks.filter(track => p.clips.some(clip => clip.trackId === track.id));
    const {plan, next} = build(p, {mode: undefined, brollAssetIds: ['broll']});
    expect(plan.startFrame).toBe(old.start + old.duration);
    expect(next.clips.find(clip => clip.id === old.id)).toEqual(old);
    expect([next.width, next.height]).toEqual([1920, 1080]);
    expect(next.tracks.filter(track => originalTracks.some(oldTrack => oldTrack.id === track.id))).toEqual(originalTracks);
    expect(plan.warnings.join(' ')).toContain('keeps the current canvas');
    assertClipSafety(next);
  });

  it('reuses existing tracks on repeated builds and works even at the 64-track limit', () => {
    let p = fixture();
    p.tracks = Array.from({length: 64}, (_, i) => ({id: `track-${i}`, name: `Track ${i}`, kind: 'video' as const, muted: true, hidden: true}));
    for (let i = 0; i < 3; i++) {
      const {next} = build(p, {hook: 'Hook', cta: 'Save it', brollAssetIds: ['broll'], musicAssetId: 'music'});
      expect(next.tracks).toHaveLength(64);
      const used = next.tracks.filter(track => next.clips.some(clip => clip.trackId === track.id));
      expect(used.map(track => track.kind)).toEqual(['text', 'text', 'video', 'video', 'audio']);
      expect(used.every(track => !track.hidden)).toBe(true);
      p = next;
    }
    assertClipSafety(p);
  });

  it('reports unavailable transcript data and supports a photo-only Reel', () => {
    const p = fixture(); delete p.assets[0].words;
    expect(build(p).plan.missingTranscriptAssetIds).toEqual(['voice']);
    const {plan, next} = build(p, {sources: [{assetId: 'photo'}], captions: true, style: 'cinematic'});
    expect(plan.durationFrames).toBe(900);
    expect(plan.captionCount).toBe(0);
    expect(plan.missingTranscriptAssetIds).toEqual([]);
    expect(next.clips[0].cameraMotion).toBe('pan-left');
    assertClipSafety(next);
  });

  it('keeps long phrase cues and long titles inside a bounded text area without fake word timestamps', () => {
    const p = fixture(); p.assets[0].words = [{text: 'A long phrase caption from an imported subtitle file that should fit its text area.', start: 0, end: 3}];
    const {next} = build(p, {hook: 'A'.repeat(120)});
    const caption = next.clips.find(clip => clip.kind === 'caption')!;
    expect(caption.words).toHaveLength(1);
    expect(caption.words[0].end).toBe(3);
    const title = next.clips.find(clip => clip.kind === 'text')!;
    expect(title.fontSize * 120 * .62).toBeLessThanOrEqual(title.width);
    expect(caption.x + caption.width / 2).toBe(next.width / 2);
    expect(title.x + title.width).toBeLessThanOrEqual(next.width * .87);
    for (const clip of [caption, title]) {
      expect(clip.x).toBeGreaterThanOrEqual(Math.round(next.width * .08));
      expect(clip.x + clip.width).toBeLessThanOrEqual(next.width * .90);
      expect(clip.y + clip.height).toBeLessThan(next.height * .9);
    }
  });
});
