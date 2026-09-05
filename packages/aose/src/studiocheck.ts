/**
 * Conformance check against the running studio.
 *
 * The harness depends on studio behaviour it never declared and could not
 * verify. One of those dependencies is ugly: `selfContain` rewrites a screen's
 * tokens link to `../../../tokens.css` because that is the depth the studio
 * happens to store screens at. That is an implementation detail with no
 * contract behind it, and when the assumption was wrong the only symptom was
 * every screen rendering as raw unstyled markup — no error, no warning, a
 * reviewer squinting at a canvas wondering what went wrong.
 *
 * So the assumption is checked rather than trusted. If the studio moves its
 * storage layout, this fails loudly with the path it expected, instead of the
 * design plane quietly producing screens nobody can review.
 *
 * This is the same shape as `require_capability` in a query factory: declare
 * what you need from a provider, and refuse rather than proceed when the
 * provider does not supply it.
 */

export interface ConformanceCheck {
  name: string;
  status: 'pass' | 'fail' | 'vacuous';
  detail: string;
}

export interface ConformanceReport {
  base: string;
  reachable: boolean;
  checks: ConformanceCheck[];
  ok: boolean;
}

async function probe(url: string, timeoutMs = 4000): Promise<{ status: number; type: string; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: (await response.text()).slice(0, 200),
    };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/**
 * Check that the studio serves what the harness assumes.
 *
 * `screenPath` is a stored screen's path as `studio_status` reports it, e.g.
 * `screens/<slug>/r3/code.html`. `tokensHref` is what the build rewrites the
 * link to. The pair is the assumption under test.
 */
export async function studioConformance(
  base: string,
  screenPath: string | null,
  tokensHref: string,
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const root = base.replace(/\/$/, '');

  const alive = await probe(`${root}/`);
  if (!alive) {
    // Not running is not a failure. A check that could not look reports vacuous.
    return {
      base: root, reachable: false, ok: true,
      checks: [{ name: 'studio reachable', status: 'vacuous', detail: `no studio answering at ${root}` }],
    };
  }
  checks.push({ name: 'studio reachable', status: 'pass', detail: `${alive.status} from ${root}` });

  const tokens = await probe(`${root}/files/tokens.css`);
  checks.push({
    name: 'tokens.css is served as CSS',
    status: tokens && tokens.status === 200 && /text\/css/.test(tokens.type) ? 'pass' : 'fail',
    detail: tokens ? `${tokens.status} ${tokens.type}` : 'no response',
  });

  const missing = await probe(`${root}/files/definitely-not-a-real-file.css`);
  checks.push({
    name: 'a missing asset is refused, not answered with a page',
    status: missing && missing.status === 404 ? 'pass' : 'fail',
    detail: missing
      ? `${missing.status} ${missing.type}${missing.status !== 404 ? ' — a 200 here makes a broken link look like a working one' : ''}`
      : 'no response',
  });

  if (!screenPath) {
    checks.push({
      name: 'a stored screen resolves its tokens link',
      status: 'vacuous',
      detail: 'no screen registered yet, so the depth assumption is untested',
    });
  } else {
    /* The assumption that matters. Resolve the rewritten href exactly as a
       browser would from the screen's own URL. */
    const screenUrl = new URL(`${root}/files/${screenPath}`);
    const resolved = new URL(tokensHref, screenUrl).toString();
    const linked = await probe(resolved);
    const ok = Boolean(linked && linked.status === 200 && /text\/css/.test(linked.type));
    checks.push({
      name: 'a stored screen resolves its tokens link',
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `${tokensHref} from ${screenPath} → ${linked!.status} ${linked!.type}`
        : `${tokensHref} from ${screenPath} → ${linked ? `${linked.status} ${linked.type}` : 'no response'}`
          + '. The studio\'s storage depth changed, or the build rewrote the href to the wrong depth.'
          + ' Screens will render unstyled with no other symptom.',
    });
  }

  return { base: root, reachable: true, checks, ok: checks.every((check) => check.status !== 'fail') };
}

export function formatConformance(report: ConformanceReport): string {
  const lines = report.checks.map((check) => {
    const mark = check.status === 'pass' ? 'ok  ' : check.status === 'vacuous' ? '--  ' : 'FAIL';
    return `  ${mark} ${check.name}\n         ${check.detail}`;
  });
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  lines.push('');
  lines.push(failed
    ? `FAIL — ${failed} studio assumption(s) no longer hold`
    : report.reachable ? 'PASS — the studio serves what the harness assumes' : 'SKIPPED — no studio running');
  return lines.join('\n');
}
