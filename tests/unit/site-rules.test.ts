import { describe, expect, it } from 'vitest';
import { isStableClass, selectorFor } from '@/content/selector';
import { matchesPattern, resolveRules, type SiteRule } from '@/shared/site-rules';

const u = (s: string) => new URL(s);

describe('site rule matching', () => {
  it('matches domains, subdomains, wildcards and paths', () => {
    expect(matchesPattern(u('https://example.com/a'), 'example.com')).toBe(true);
    expect(matchesPattern(u('https://blog.example.com/a'), 'example.com')).toBe(true);
    expect(matchesPattern(u('https://blog.example.com/a'), '*.example.com')).toBe(true);
    expect(matchesPattern(u('https://notexample.com/a'), 'example.com')).toBe(false);
    expect(matchesPattern(u('https://example.com/docs/x'), 'example.com/docs/*')).toBe(true);
    expect(matchesPattern(u('https://example.com/blog/x'), 'example.com/docs/*')).toBe(false);
    expect(matchesPattern(u('https://example.com/docs/x?q=1'), 'https://EXAMPLE.com/docs/*')).toBe(true);
    expect(matchesPattern(u('https://any.site/'), '*')).toBe(true);
    expect(matchesPattern(u('https://example.com/'), '')).toBe(false);
  });

  it('merges matching rules, skips disabled built-ins and invalid selectors', () => {
    const rules: SiteRule[] = [
      { id: 'a', matches: ['example.com'], exclude: ['.ad', 'div[[bad'], css: '.x{color:red}' },
      { id: 'b', matches: ['example.com/docs/*'], include: ['main'], exclude: ['.ad', 'nav.toc'] },
      { id: 'c', matches: ['other.com'], exclude: ['.never'] },
    ];
    const r = resolveRules(u('https://www.example.com/docs/intro'), rules, ['builtin:youtube']);
    expect(r.ids).toEqual(['a', 'b']);
    expect(r.include).toEqual(['main']);
    expect(r.exclude).toEqual(['.ad', 'nav.toc']);
    expect(r.css).toContain('.x{color:red}');

    // 内置规则可单独停用；用户规则排在内置规则之后
    const builtins: SiteRule[] = [{ id: 'builtin:x', matches: ['example.com'], exclude: ['.b'] }];
    expect(resolveRules(u('https://example.com/'), rules, [], builtins).ids).toEqual(['builtin:x', 'a']);
    expect(resolveRules(u('https://example.com/'), rules, ['builtin:x'], builtins).ids).toEqual(['a']);
  });
});

describe('selector generation for site rules', () => {
  it('recognizes generated (hashed) class names', () => {
    for (const c of [
      'sidebar__oqw6Y8',
      'prc-Button-ButtonBase-9n-Xk',
      'css-1x2y3z',
      'sc-bdVaJa',
      'title_1x2y3',
      'aBcD12ef',
    ]) {
      expect(isStableClass(c), c).toBe(false);
    }
    for (const c of ['sidebar', 'react-directory-filename-column', 'comment-meta', 'post-content', 'toc']) {
      expect(isStableClass(c), c).toBe(true);
    }
  });

  it('prefers stable ids, test ids and semantic classes, and avoids hashed ones', () => {
    document.body.innerHTML = `
      <aside id="related"><p data-k="a">x</p></aside>
      <div data-testid="comments"><span data-k="b">y</span></div>
      <div class="comment-meta sidebar__oqw6Y8" data-k="c">z</div>
      <div class="css-1x2y3z"><div class="x_9f8e7d"><p data-k="d">w</p></div></div>
      <div id="post-12345"><article><p data-k="e">v</p></article></div>`;
    const sel = (k: string) => selectorFor(document.querySelector(`[data-k="${k}"]`)!);
    expect(sel('a')).toBe('aside#related p');
    expect(sel('b')).toBe('div[data-testid="comments"] span');
    expect(sel('c')).toBe('div.comment-meta');
    expect(sel('d')).toBe('body p');
    expect(sel('e')).toBe('article p');
    // 生成的选择器能匹配回原元素
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(document.querySelector(sel(id))).not.toBeNull();
    }
  });
});
