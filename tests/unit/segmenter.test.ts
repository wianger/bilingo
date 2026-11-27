import { beforeEach, describe, expect, it } from 'vitest';
import { collectSegments, isMeaningful, isNaturalText, looksLikeTarget, preferInline } from '@/content/segmenter';

const ALL = { target: 'zh-CN', smart: false };
const SMART = { target: 'zh-CN', smart: true };

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
    expect(texts(collectSegments(document.body, ALL))).toEqual([
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
    expect(texts(collectSegments(document.body, ALL))).toEqual(['Real paragraph here']);
  });

  it('wraps bare text that sits between block elements (HN comment style)', () => {
    document.body.innerHTML = `<div class="commtext">First paragraph text<p>Second paragraph</p></div>`;
    const segs = collectSegments(document.body, ALL);
    expect(texts(segs)).toEqual(['First paragraph text', 'Second paragraph']);
    expect(segs[0]!.className).toBe('bilingo-wrap');
  });

  it('treats an inline element that contains blocks as a container', () => {
    document.body.innerHTML = `<a href="#"><div>Card title</div><div>Card body text</div></a>`;
    expect(texts(collectSegments(document.body, ALL))).toEqual(['Card title', 'Card body text']);
  });

  it('skips text already in the target language', () => {
    document.body.innerHTML = `<p>这是一段中文内容</p><p>An English sentence</p>`;
    expect(texts(collectSegments(document.body, ALL))).toEqual(['An English sentence']);
  });

  it('does not re-collect processed elements', () => {
    document.body.innerHTML = `<p data-bilingo="done">Already done</p><p>New one</p>`;
    expect(texts(collectSegments(document.body, ALL))).toEqual(['New one']);
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

describe('smart scope', () => {
  it('skips navigation, menus, buttons and page-level header/footer but keeps article headers', () => {
    document.body.innerHTML = `
      <header><div>Site Name Here</div><nav><a href="#">Home page</a></nav></header>
      <div role="toolbar"><span>Share this post</span></div>
      <main>
        <article>
          <header><h1>Article title here</h1></header>
          <p>The main body of the article.</p>
          <button>Load more comments</button>
          <footer><p>Written by someone else</p></footer>
        </article>
      </main>
      <footer><p>Copyright notice text</p></footer>`;
    const texts = collectSegments(document.body, SMART).map((e) => e.textContent?.trim());
    expect(texts).toEqual(['Article title here', 'The main body of the article.', 'Written by someone else']);
    expect(collectSegments(document.body, ALL).length).toBeGreaterThan(texts.length);
  });
});

describe('smart scope link lists', () => {
  it('skips menus and meta lines made of short links but keeps long title links', () => {
    document.body.innerHTML = `
      <div><a href="/new">new</a> | <a href="/past">past</a> | <a href="/c">comments</a> | <a href="/ask">ask</a></div>
      <div>269 points by <a href="/u">someone</a> <a href="/i">3 hours ago</a> | <a href="/i">107 comments</a></div>
      <div><a href="/a">The group chat where your AI talks behind your back</a></div>
      <div><a href="/b">Short title here</a> (<a href="/from?site=x">x.blog</a>)</div>
      <div><a href="/c1">Bump dependencies (</a><a href="/pr/1">#1766</a><a href="/c1">)</a></div>
      <p>See <a href="#">the docs</a> and <a href="#">the guide</a> for a much longer explanation of everything.</p>`;
    expect(collectSegments(document.body, SMART).map((e) => e.textContent?.trim().slice(0, 20))).toEqual([
      'The group chat where',
      'Short title here (x.',
      'Bump dependencies (#',
      'See the docs and the',
    ]);
  });
});

describe('isNaturalText', () => {
  it('rejects code, paths, versions, handles and numbers', () => {
    for (const t of [
      'snake_case_name',
      'src/content/index.ts',
      'getElementById()',
      'useState',
      'TranslateError',
      'v1.2.3',
      '2.0.1',
      '@octocat',
      '#svelte',
      'Ctrl+Shift+P',
      'HTML',
      '12,345',
      '3h',
      'https://example.com/a',
      'a@b.com',
      '2026-11-27 13:45',
    ]) {
      expect(isNaturalText(t), t).toBe(false);
    }
  });

  it('accepts real words and sentences', () => {
    for (const t of ['Reply', 'Introduction', 'Read the docs', '12 points by alice 3 hours ago', 'Hello, world!']) {
      expect(isNaturalText(t), t).toBe(true);
    }
  });
});
