import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {applyCommands, type Command} from '../src/shared/commands';
import {ClipSchema, makeClip, newProject, validateProject, type Clip, type Project} from '../src/shared/model';
import {cameraTransform, filterFor} from '../src/shared/effects';
import {captionStyles, captionWordStyle} from '../src/shared/caption-styles';
import {parseSrt, toSrt} from '../src/shared/subtitles';
import {trimClip} from '../src/shared/timeline';
import {createReelPlan} from '../src/shared/reel';
import {FinishingOverlay} from '../src/composition/FinishingOverlay';

function caption(): Clip {
  return {...makeClip(newProject(), 'caption', 'captions', 90), duration: 90, text: 'First second third', words: [{text: 'First', start: 0, end: .8}, {text: 'second', start: 1, end: 1.8}, {text: 'third', start: 2, end: 2.8}]};
}
function edit(p: Project, commands: Command[]) {
  return applyCommands(p, {projectId: p.id, revision: p.revision, label: 'Creative edit', commands});
}

describe('New creative treatments', () => {
  it('loads a previous project with neutral finishing, standard captions and existing editing values intact', () => {
    const p = newProject(), old = {...caption(), x: 72, y: 1100, fontSize: 54, sourceIn: 3, speed: 1.5, look: 'warm', cameraMotion: 'zoom-in'} as Record<string, unknown>;
    for (const field of ['overlay', 'overlayAmount', 'captionStyle']) delete old[field];
    const loaded = validateProject({...p, clips: [old]});
    expect(loaded.clips[0]).toMatchObject({overlay: 'none', overlayAmount: .5, captionStyle: 'standard', x: 72, y: 1100, fontSize: 54, sourceIn: 3, speed: 1.5, look: 'warm', cameraMotion: 'zoom-in'});
    expect(loaded.clips[0].words).toEqual(old.words);
  });

  it.each(['moody', 'sunset', 'teal-orange', 'bleach'] as const)('validates and renders the %s look with a neutral zero-strength state', look => {
    const c = ClipSchema.parse({...caption(), look, effectAmount: .75});
    const output = filterFor(c);
    expect(output).not.toBe('none');
    expect(output).toContain('brightness(');
    expect(output).not.toMatch(/NaN|undefined|Infinity/);
    expect(filterFor({...c, effectAmount: 0})).toBe('none');
  });

  it.each(['slow-orbit', 'punch-in', 'breathe'] as const)('keeps %s camera movement deterministic and bounded for one-frame and normal clips', cameraMotion => {
    for (const duration of [1, 90]) {
      const c = {...caption(), cameraMotion, duration};
      for (const frame of [-1, 0, 15, 89, 1000]) {
        const transform = cameraTransform(c, frame);
        expect(transform).toBe(cameraTransform(c, frame));
        expect(transform).not.toMatch(/NaN|Infinity|undefined/);
        const scale = Number(transform.match(/scale\(([^)]+)\)/)![1]);
        expect(scale).toBeGreaterThanOrEqual(1);
        expect(scale).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it('applies finishing and caption patches without resetting clip position, timing or earlier effects', () => {
    const p = newProject();
    p.clips = [{...caption(), look: 'warm', x: 82, duration: 150, fontSize: 61, captionStyle: 'pop'}];
    const before = structuredClone(p.clips[0]);
    const next = edit(p, [{type: 'clip.update', id: before.id, patch: {overlay: 'light-leak', overlayAmount: .35}}]);
    expect(next.clips[0]).toEqual({...before, overlay: 'light-leak', overlayAmount: .35});
    const styled = edit(next, [{type: 'clip.update', id: before.id, patch: {captionStyle: 'karaoke'}}]);
    expect(styled.clips[0]).toEqual({...next.clips[0], captionStyle: 'karaoke'});
  });

  it.each(['film-grain', 'light-leak', 'vhs', 'halftone'] as const)('renders %s as a deterministic finishing layer for export and preview', overlay => {
    const c = {...caption(), overlay, overlayAmount: .5};
    const render = (frame: number) => renderToStaticMarkup(React.createElement(FinishingOverlay, {clip: c, frame}));
    const markup = render(12);
    expect(markup).toBe(render(12));
    expect(markup).toContain('pointer-events:none');
    expect(markup).not.toMatch(/NaN|undefined|Infinity/);
    if (overlay !== 'halftone') expect(render(30)).not.toBe(markup);
    expect(renderToStaticMarkup(React.createElement(FinishingOverlay, {clip: {...c, overlay: 'none'}, frame: 12}))).toBe('');
  });

  it('rejects corrupt or unsupported finishing values before committing them', () => {
    const p = newProject(); p.clips = [caption()];
    for (const patch of [{overlay: 'external-plugin'}, {overlayAmount: -.1}, {overlayAmount: 1.1}, {overlayAmount: NaN}, {captionStyle: 'unknown'}, {cameraMotion: 'unknown'}]) {
      expect(() => edit(p, [{type: 'clip.update', id: p.clips[0].id, patch: patch as Partial<Clip>}])).toThrow();
    }
    expect(p.clips[0].overlay).toBe('none');
  });
});

describe('Spoken caption timing', () => {
  it('uses inclusive start and exclusive end boundaries for real word highlighting', () => {
    const c = caption();
    expect(captionWordStyle(c, 1, .999).active).toBe(false);
    expect(captionWordStyle(c, 1, 1).active).toBe(true);
    expect(captionWordStyle(c, 1, 1.799).active).toBe(true);
    expect(captionWordStyle(c, 1, 1.8).active).toBe(false);
    expect(captionWordStyle(c, 99, 1)).toEqual({active: false, visible: true, scale: 1, filled: false});
  });

  it('reveals only spoken words, fills karaoke only while active, and decays the word-pop scale', () => {
    const c = caption();
    expect(captionWordStyle({...c, captionStyle: 'typewriter'}, 1, .5).visible).toBe(false);
    expect(captionWordStyle({...c, captionStyle: 'typewriter'}, 1, 1).visible).toBe(true);
    expect(captionWordStyle({...c, captionStyle: 'typewriter'}, 1, 2).visible).toBe(true);
    expect(captionWordStyle({...c, captionStyle: 'karaoke'}, 1, 1).filled).toBe(true);
    expect(captionWordStyle({...c, captionStyle: 'karaoke'}, 1, 1.8).filled).toBe(false);
    expect(captionWordStyle({...c, captionStyle: 'pop'}, 1, 1).scale).toBeCloseTo(1.12);
    expect(captionWordStyle({...c, captionStyle: 'pop'}, 1, 1.6).scale).toBeLessThan(captionWordStyle({...c, captionStyle: 'pop'}, 1, 1.1).scale);
    expect(captionWordStyle({...c, captionStyle: 'pop'}, 1, 1.8).scale).toBe(1);
  });

  it('keeps every library caption treatment schema-valid with its intended text', () => {
    for (const style of captionStyles) {
      const c = ClipSchema.parse({...caption(), ...style.patch});
      expect(c.captionStyle).toBe(style.id);
      expect(c.words).toEqual(caption().words);
      expect(captionWordStyle(c, 1, 1.2).active).toBe(true);
    }
  });

  it('splits both visible text and SRT text at the same source word boundary', () => {
    const p = newProject(); p.clips = [caption()];
    const next = edit(p, [{type: 'clip.split', id: p.clips[0].id, frame: 120}]);
    const [left, right] = next.clips;
    expect([left.text, right.text]).toEqual(['First', 'second third']);
    expect(left.words).toEqual([{text: 'First', start: 0, end: .8}]);
    expect(right.words.map(({text, start}) => ({text, start}))).toEqual([{text: 'second', start: 0}, {text: 'third', start: 1}]);
    expect(right.words[0].end).toBeCloseTo(.8);
    expect(right.words[1].end).toBeCloseTo(1.8);
    const cues = parseSrt(toSrt(next.clips, p.fps));
    expect(cues).toEqual([{text: 'First', start: 3, end: 4}, {text: 'second third', start: 4, end: 6}]);
    expect(captionWordStyle(right, 0, .1).active).toBe(true);
    expect(captionWordStyle(right, 1, .1).active).toBe(false);
  });

  it('keeps a word crossing a split visible on both sides without extending either highlight interval', () => {
    const p = newProject(); p.clips = [{...caption(), words: [{text: 'Together', start: .5, end: 1.5}], text: 'Together'}];
    const next = edit(p, [{type: 'clip.split', id: p.clips[0].id, frame: 120}]);
    const [left, right] = next.clips;
    expect(left.words).toEqual([{text: 'Together', start: .5, end: 1}]);
    expect(right.words).toEqual([{text: 'Together', start: 0, end: .5}]);
    expect(left.text).toBe('Together');
    expect(right.text).toBe('Together');
    expect(captionWordStyle(left, 0, 1).active).toBe(false);
    expect(captionWordStyle(right, 0, .5).active).toBe(false);
  });

  it('maps accelerated trimmed speech once, then keeps split and left-trim captions in timeline seconds', () => {
    const p = newProject();
    p.assets = [{id: 'voice', name: 'voice', kind: 'video', path: '/local/voice.mov', duration: 20, hasAudio: true, words: [{text: 'One', start: 4, end: 4.8}, {text: 'two', start: 5, end: 5.8}, {text: 'three', start: 6, end: 6.8}]}];
    const plan = createReelPlan(p, {sources: [{assetId: 'voice', sourceIn: 4, sourceOut: 10, speed: 2}], targetSeconds: 15, mode: 'replace'});
    const next = edit(p, plan.commands), originalCaption = next.clips.find(clip => clip.kind === 'caption')!;
    expect(originalCaption.speed).toBe(1);
    expect(originalCaption.words.map(word => word.start)).toEqual([0, .5, 1]);
    const split = edit(next, [{type: 'clip.split', id: originalCaption.id, frame: originalCaption.start + 15}]);
    const right = split.clips.find(clip => clip.kind === 'caption' && clip.id !== originalCaption.id)!;
    expect(right.text).toBe('two three');
    expect(right.words.map(word => word.start)).toEqual([0, .5]);
    expect(captionWordStyle(right, 0, .2).active).toBe(true);
    expect(captionWordStyle(right, 1, .2).active).toBe(false);
    const trimmed = trimClip(split, right, 'left', right.start + 15);
    expect(trimmed.text).toBe('three');
    expect(trimmed.words[0].start).toBe(0);
    expect(trimmed.words[0].end).toBeCloseTo(.4);
    expect(captionWordStyle(trimmed, 0, .2).active).toBe(true);
    expect(captionWordStyle(trimmed, 0, .5).active).toBe(false);
    expect(parseSrt(toSrt([trimmed], p.fps))[0].text).toBe('three');
  });

  it('treats caption-local words as timeline timing even when a legacy caption carries a speed value', () => {
    const p = newProject(); p.clips = [{...caption(), speed: 2}];
    const split = edit(p, [{type: 'clip.split', id: p.clips[0].id, frame: 120}]);
    const right = split.clips[1];
    expect(right.words[0].start).toBe(0);
    expect(right.words[0].end).toBeCloseTo(.8);
    expect(captionWordStyle(right, 0, .6).active).toBe(true);
    const trimmed = trimClip(split, right, 'left', right.start + 15);
    expect(trimmed.words[0].end).toBeCloseTo(.3);
    expect(captionWordStyle(trimmed, 0, .2).active).toBe(true);
  });
});
