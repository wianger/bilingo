import { describe, expect, it } from 'vitest';
import { detectMainContent } from '@/content/main-content';

const LONG =
  'WebGPU is a modern graphics and compute API for the web that exposes the capabilities of current GPU hardware, ' +
  'designed as the successor to WebGL with a much closer mapping to Vulkan, Metal and Direct3D 12.';

const ARTICLE_PAGE = `
  <header><a href="/">My Blog</a><nav><a href="/a">Archive</a> <a href="/b">About</a></nav></header>
  <div class="layout">
    <main><article id="post">
      <h2>Why the browser needs a new GPU API</h2>
      ${[1, 2, 3, 4, 5].map((i) => `<p id="p${i}">${LONG} Paragraph number ${i} continues the story.</p>`).join('')}
    </article></main>
    <aside id="side">
      <h3>Related posts</h3>
      <ul><li><a href="/x">Another post</a></li><li><a href="/y">Yet another post</a></li></ul>
      <p id="promo">Subscribe to the newsletter to get every new post delivered straight to your inbox.</p>
    </aside>
  </div>
  <footer><p>Copyright 2026 somebody</p></footer>`;

describe('detectMainContent', () => {
  it('finds the article region on article pages', () => {
    document.body.innerHTML = `<h1 id="title">A long article title</h1>${ARTICLE_PAGE}`;
    const main = detectMainContent(document);
    expect(main).not.toBeNull();
    const post = document.getElementById('post')!;
    expect(main!.roots.some((r) => r === post || r.contains(post) || post.contains(r))).toBe(true);
    expect(main!.roots.some((r) => r.contains(document.getElementById('promo')))).toBe(false);
    expect(main!.headings.map((h) => h.id)).toContain('title');
  });

  it('returns null on pages that are not articles', () => {
    document.body.innerHTML = `<ul>${Array.from({ length: 30 }, (_, i) => `<li><a href="/${i}">Item ${i}</a></li>`).join('')}</ul>`;
    expect(detectMainContent(document)).toBeNull();
  });
});
