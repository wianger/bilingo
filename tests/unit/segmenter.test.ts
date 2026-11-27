import { beforeEach, describe, expect, it } from 'vitest';
import { collectSegments, isMeaningful, looksLikeTarget, preferInline } from '@/content/segmenter';

const texts = (els: Element[]) => els.map((e) => e.textContent?.trim());

describe('collectSegments', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('picks leaf blocks and keeps inline markup inside one segment', () => {
    document.body.innerHTML = `
      <article>
        <h1>Hello world</h1>
        <p>This is <a href="#">a link</a> and <b>bold</b> text.</p>
        <ul><li>First item</li><li>Second item</li></ul>
      </article>`;
    expect(texts(collectSegments(document.body, 'zh-CN'))).toEqual([
      'Hello world',
      'This is a link and bold text.',
      'First item',
      'Second item',
    ]);
  });

  it('skips code, pre, notranslate, contenteditable and textareas', () => {
    document.body.innerHTML = `
      <pre>const x = 1;</pre>
      <p class="notranslate">Brand name</p>
      <p translate="no">Do not translate</p>
      <div contenteditable="true"><p>Editable text</p></div>
      <textarea>typed</textarea>
      <p>Real paragraph here</p>`;
    expect(texts(collectSegments(document.body, 'zh-CN'))).toEqual(['Real paragraph here']);
  });

  it('wraps bare text that sits between block elements (HN comment style)', () => {
    document.body.innerHTML = `<div class="commtext">First paragraph text<p>Second paragraph</p></div>`;
    const segs = collectSegments(document.body, 'zh-CN');
    expect(texts(segs)).toEqual(['First paragraph text', 'Second paragraph']);
    expect(segs[0]!.className).toBe('bilingo-wrap');
  });

  it('treats an inline element that contains blocks as a container', () => {
    document.body.innerHTML = `<a href="#"><div>Card title</div><div>Card body text</div></a>`;
    expect(texts(collectSegments(document.body, 'zh-CN'))).toEqual(['Card title', 'Card body text']);
  });

  it('skips text already in the target language', () => {
    document.body.innerHTML = `<p>这是一段中文内容</p><p>An English sentence</p>`;
    expect(texts(collectSegments(document.body, 'zh-CN'))).toEqual(['An English sentence']);
  });

  it('does not re-collect processed elements', () => {
    document.body.innerHTML = `<p data-bilingo="done">Already done</p><p>New one</p>`;
    expect(texts(collectSegments(document.body, 'zh-CN'))).toEqual(['New one']);
  });
});

describe('language heuristics', () => {
  it('detects Chinese but not Japanese as zh target', () => {
    expect(looksLikeTarget('这是中文', 'zh-CN')).toBe(true);
    expect(looksLikeTarget('これは日本語の文章です', 'zh-CN')).toBe(false);
    expect(looksLikeTarget('Hello there', 'zh-CN')).toBe(false);
  });

  it('filters junk segments', () => {
    expect(isMeaningful('12345', 'zh-CN')).toBe(false);
    expect(isMeaningful('https://example.com/a', 'zh-CN')).toBe(false);
    expect(isMeaningful('a', 'zh-CN')).toBe(false);
    expect(isMeaningful('Hi', 'zh-CN')).toBe(true);
  });

  it('prefers inline placement for short nav items only', () => {
    document.body.innerHTML = `<nav><a id="a">Home</a></nav><h2 id="h">Short title</h2>`;
    expect(preferInline(document.getElementById('a')!, 'Home')).toBe(true);
    expect(preferInline(document.getElementById('h')!, 'Short title')).toBe(false);
  });
});
