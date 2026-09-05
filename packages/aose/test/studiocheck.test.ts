/**
 * Conformance against the running studio.
 *
 * The harness rewrites a screen's tokens link to a depth the studio happens to
 * store at. That is an implementation detail with no contract behind it, and
 * when the assumption was wrong the only symptom was every screen rendering as
 * raw unstyled markup — no error, no warning. These tests exist so the
 * assumption fails loudly instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { studioConformance, formatConformance } from '../src/studiocheck.ts';

/** A stand-in studio: serves tokens.css, 404s anything else under /files. */
function studio(options: { tokensAt?: string; missingReturns?: number } = {}): Promise<{ base: string; close: () => void }> {
  const tokensAt = options.tokensAt ?? '/files/tokens.css';
  const missing = options.missingReturns ?? 404;
  return new Promise((resolve) => {
    const server: Server = createServer((request, response) => {
      const url = request.url ?? '/';
      if (url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html></html>'); return; }
      if (url === tokensAt) { response.writeHead(200, { 'content-type': 'text/css' }); response.end(':root{}'); return; }
      response.writeHead(missing, { 'content-type': missing === 404 ? 'text/plain' : 'text/html' });
      response.end(missing === 404 ? 'not found' : '<html>spa shell</html>');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test('no studio running is vacuous, not a failure', async () => {
  // A check that could not look has not looked. An unreachable studio must not
  // read as a broken one, or every offline run reports a false alarm.
  const report = await studioConformance('http://127.0.0.1:1', null, '../../../tokens.css');
  assert.equal(report.reachable, false);
  assert.equal(report.ok, true);
  assert.equal(report.checks[0].status, 'vacuous');
});

test('the right depth passes', async () => {
  const s = await studio();
  const report = await studioConformance(s.base, 'screens/board/r3/code.html', '../../../tokens.css');
  assert.equal(report.ok, true, formatConformance(report));
  s.close();
});

test('the wrong depth fails, which is the bug that motivated this check', async () => {
  // `../tokens.css` is what an author writes and what the docs describe. From
  // screens/<slug>/rN/ it resolves to a file that does not exist, and the only
  // symptom is unstyled markup.
  const s = await studio();
  const report = await studioConformance(s.base, 'screens/board/r3/code.html', '../tokens.css');
  assert.equal(report.ok, false);
  const link = report.checks.find((c) => c.name.includes('resolves its tokens link'))!;
  assert.equal(link.status, 'fail');
  assert.match(link.detail, /render unstyled with no other symptom/);
  s.close();
});

test('a studio that answers a missing asset with a page fails the check', async () => {
  // The failure mode that makes a broken link look like a working one, and cost
  // real time diagnosing. Whether any given studio does this is a fact to
  // measure, not to assume — this harness assumed it once and was wrong.
  const s = await studio({ missingReturns: 200 });
  const report = await studioConformance(s.base, null, '../../../tokens.css');
  const refusal = report.checks.find((c) => c.name.includes('missing asset'))!;
  assert.equal(refusal.status, 'fail');
  assert.match(refusal.detail, /makes a broken link look like a working one/);
  s.close();
});

test('an unregistered screen leaves the depth assumption untested, and says so', async () => {
  const s = await studio();
  const report = await studioConformance(s.base, null, '../../../tokens.css');
  const link = report.checks.find((c) => c.name.includes('resolves its tokens link'))!;
  assert.equal(link.status, 'vacuous');
  assert.match(link.detail, /untested/);
  assert.equal(report.ok, true, 'untested is not failed');
  s.close();
});

test('a studio that stops serving tokens.css as CSS fails', async () => {
  const s = await studio({ tokensAt: '/files/somewhere-else.css' });
  const report = await studioConformance(s.base, null, '../../../tokens.css');
  assert.equal(report.checks.find((c) => c.name.includes('served as CSS'))!.status, 'fail');
  s.close();
});
