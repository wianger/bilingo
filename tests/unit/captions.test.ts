import { describe, expect, it } from 'vitest';
import { cleanVttText, cueAt, fromVttCues, parseJson3, type Json3 } from '@/subtitles/captions';

describe('YouTube json3 captions', () => {
  it('merges manual caption lines into sentences and drops sound labels', () => {
    const data: Json3 = {
      events: [
        { tStartMs: 0, dDurationMs: 2892, segs: [{ utf8: '[MUSIC PLAYING]' }] },
        { tStartMs: 4305, dDurationMs: 1125, segs: [{ utf8: 'RICARDO CABELLO: All right.' }] },
        { tStartMs: 5430, dDurationMs: 1520, segs: [{ utf8: 'Hello, everyone.' }] },
        { tStartMs: 7000, dDurationMs: 2000, segs: [{ utf8: 'Today we are going to talk\nabout' }] },
        { tStartMs: 9000, dDurationMs: 1500, segs: [{ utf8: 'WebGPU.' }] },
      ],
    };
    expect(parseJson3(data).map((c) => c.text)).toEqual([
      'RICARDO CABELLO: All right.',
      'Hello, everyone.',
      'Today we are going to talk about WebGPU.',
    ]);
  });

  it('builds sentences from auto-generated word timings', () => {
    const data: Json3 = {
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 3000,
          segs: [{ utf8: 'so' }, { utf8: ' today', tOffsetMs: 300 }, { utf8: ' we', tOffsetMs: 600 }],
        },
        { tStartMs: 1900, aAppend: 1, segs: [{ utf8: '\n' }] },
        {
          tStartMs: 2000,
          dDurationMs: 2000,
          segs: [
            { utf8: ' build', tOffsetMs: 0 },
            { utf8: ' things.', tOffsetMs: 400 },
          ],
        },
        // 长时间停顿后开始新句子（即使没有标点）
        {
          tStartMs: 6000,
          dDurationMs: 1000,
          segs: [
            { utf8: 'next', tOffsetMs: 0 },
            { utf8: ' part', tOffsetMs: 300 },
          ],
        },
      ],
    };
    const cues = parseJson3(data);
    expect(cues.map((c) => c.text)).toEqual(['so today we build things.', 'next part']);
    expect(cues[0]!.start).toBe(1000);
    expect(cues[1]!.start).toBe(6000);
  });

  it('keeps a space between words on separate auto-caption lines, but not between CJK characters', () => {
    const line = (t: number, words: string[]) => ({
      tStartMs: t,
      dDurationMs: 900,
      segs: words.map((w, i) => ({ utf8: w, tOffsetMs: i * 200 })),
    });
    const en = parseJson3({
      events: [
        line(0, ['all', ' the', ' power', ' you', ' need']),
        { tStartMs: 900, aAppend: 1, segs: [{ utf8: '\n' }] },
        line(1000, ['for', ' the', ' best.']),
      ],
    });
    expect(en.map((c) => c.text)).toEqual(['all the power you need for the best.']);
    const zh = parseJson3({
      events: [line(0, ['我们', '今天']), { tStartMs: 500, aAppend: 1, segs: [{ utf8: '\n' }] }, line(600, ['开始。'])],
    });
    expect(zh.map((c) => c.text)).toEqual(['我们今天开始。']);
  });

  it('splits line-level auto captions at sentence ends (real YouTube data)', () => {
    const data: Json3 = {
      events: [
        {
          tStartMs: 28080,
          dDurationMs: 6600,
          segs: [{ utf8: 'PC and gives you all the power you need\nfor the best chance of file recovery' }],
        },
        {
          tStartMs: 32119,
          dDurationMs: 6361,
          segs: [{ utf8: "regardless of the situation.\nAll right, so here's how it works. Just" }],
        },
        {
          tStartMs: 36840,
          dDurationMs: 5520,
          segs: [{ utf8: 'download and install the free version of\nDisk Drill, link right here.' }],
        },
      ],
    };
    const cues = parseJson3(data);
    expect(cues.map((c) => c.text)).toEqual([
      'PC and gives you all the power you need for the best chance of file recovery regardless of the situation.',
      "All right, so here's how it works.",
      'Just download and install the free version of Disk Drill, link right here.',
    ]);
    // 时间按顺序、互不重叠
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
  });

  it('keeps sentences short enough to read', () => {
    const words = Array.from({ length: 60 }, (_, i) => ({ utf8: ` word${i}`, tOffsetMs: i * 100 }));
    const cues = parseJson3({ events: [{ tStartMs: 0, dDurationMs: 6000, segs: words }] });
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(110);
  });

  it('finds the cue at a given time', () => {
    const cues = [
      { start: 0, end: 1000, text: 'a' },
      { start: 1000, end: 2500, text: 'b' },
      { start: 4000, end: 5000, text: 'c' },
    ];
    expect(cueAt(cues, 500)).toBe(0);
    expect(cueAt(cues, 1000)).toBe(1);
    expect(cueAt(cues, 3000)).toBe(-1);
    expect(cueAt(cues, 4999)).toBe(2);
    expect(cueAt(cues, 6000)).toBe(-1);
  });
});

describe('HTML5 (WebVTT) captions', () => {
  it('strips WebVTT markup and decodes entities', () => {
    expect(cleanVttText('<v Roger>Hi <c.yellow>there</c> &amp; <i>welcome</i>&nbsp;back</v>')).toBe(
      'Hi there & welcome back',
    );
    expect(cleanVttText('Fish &#38; chips <00:00:01.500>now')).toBe('Fish & chips now');
  });

  it('merges cue fragments into sentences', () => {
    const cues = fromVttCues([
      { startTime: 1, endTime: 3, text: 'In this course we will learn' },
      { startTime: 3, endTime: 5, text: 'how neural networks work.' },
      { startTime: 5, endTime: 7, text: "Let's get started." },
    ]);
    expect(cues.map((c) => c.text)).toEqual([
      'In this course we will learn how neural networks work.',
      "Let's get started.",
    ]);
    expect(cues[0]!.start).toBe(1000);
  });

  it('drops the repeated line of roll-up captions', () => {
    const cues = fromVttCues([
      { startTime: 0, endTime: 2, text: 'so today we are going' },
      { startTime: 2, endTime: 4, text: 'so today we are going\nto talk about GPUs.' },
      { startTime: 4, endTime: 6, text: 'to talk about GPUs.\nThey are fast.' },
    ]);
    expect(cues.map((c) => c.text)).toEqual(['so today we are going to talk about GPUs.', 'They are fast.']);
  });
});
