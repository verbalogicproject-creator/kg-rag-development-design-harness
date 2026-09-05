/**
 * Make a screen self-contained for the studio.
 *
 * The authoring rule says a token-driven screen is "self-contained apart from
 * the one relative link to tokens.css". That assumes the studio serves
 * tokens.css. This version does not: every path under /design/ falls through to
 * the SPA shell, so a linked stylesheet resolves to an HTML document and the
 * screen renders as raw unstyled markup in the review canvas — which is exactly
 * what a reviewer saw.
 *
 * So the shared structural CSS is inlined, and the token values are inlined as
 * a FALLBACK placed before the link. Cascade order does the rest: wherever
 * tokens.css does resolve — from disk, in a build, in a future studio — the
 * linked file wins and the screen stays genuinely token-driven. Where it does
 * not, the screen still renders correctly instead of silently degrading.
 *
 * The alternative was to inline tokens outright and drop the link, which would
 * make a token edit unable to repaint the screen. That is the definition of a
 * baked screen, and baking a screen the agent authored throws away the one
 * property that makes it worth authoring.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface InlineResult { html: string; inlined: string[]; kept: string[] }

/** Resolve a screen's stylesheet links, inlining what it can and reporting what it did. */
export function selfContain(screenPath: string, tokensHref = '../../../tokens.css'): InlineResult {
  const dir = dirname(resolve(screenPath));
  let html = readFileSync(screenPath, 'utf8');
  const inlined: string[] = [];
  const kept: string[] = [];

  const links = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g)];
  for (const [tag, href] of links) {
    const target = join(dir, href);
    let css: string;
    try { css = readFileSync(target, 'utf8'); } catch { kept.push(href); continue; }

    /* tokens.css is never inlined. The studio validates this and refuses a
       screen that carries token literals — correctly, because a screen with
       baked tokens cannot be repainted by a token edit, which is the whole
       property that makes a token-driven screen worth authoring.

       Its DEPTH does change. The studio serves screens from
       /files/screens/<slug>/rN/code.html with the design directory as the
       root, so tokens.css sits three levels up from a stored screen while it
       sits one level up from the source. Authoring `../tokens.css` and shipping
       it unchanged is why the canvas rendered raw unstyled markup: the link
       resolved to a path the server answers with "not found". */
    if (/tokens\.css$/.test(href)) {
      const rewritten = tag.replace(href, tokensHref);
      html = html.replace(tag, rewritten);
      kept.push(`${href} -> ${tokensHref}`);
      continue;
    }
    {
      html = html.replace(tag, `<style data-inlined="${href}">\n${css}\n</style>`);
      inlined.push(href);
    }
  }
  return { html, inlined, kept };
}
