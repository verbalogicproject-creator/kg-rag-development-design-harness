/**
 * Conformance against the running studio.
 *
 * The harness rewrites a screen's tokens link to a depth the studio happens to
 * store at. That is an implementation detail with no contract behind it, and
 * when the assumption was wrong the only symptom was every screen rendering as
 * raw unstyled markup — no error, no warning. These tests exist so the
 * assumption fails loudly instead.
 *
 * Each stub is unref'd, awaited on close, and closed in a `finally`. A server
 * left listening keeps the runner's event loop alive and turns a passing suite
 * into an intermittent one, and a flaky test is worse than no test because it
 * teaches people to re-run rather than to look.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { studioConformance, formatConformance } from '../src/studiocheck.ts';

interface Stub { base: string; close: () => Promise<void> }

/** A stand-in studio: serves tokens.css, refuses anything else under /files. */
function studio(options: { tokensAt?: string; missingReturns?: number } = {}): Promise<Stub> {
  const tokensAt = options.tokensAt ?? '/files/tokens.css';
  const missing = options.missingReturns ?? 404;
  return new Promise((resolve) => {
    const server: Server = createServer((request, response) => {
      const url = request.url ?? '/';
      if (url === '/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html></html>');
        return;
      }
      if (url === tokensAt) {
        response.writeHead(200, { 'content-type': 'text/css' });
        response.end(':root{}');
        return;
      }
      response.writeHead(missing, { 'content-type': missing === 404 ? 'text/plain' : 'text/html' });
      response.end(missing === 404 ? 'not found' : '<html>spa shell</html>');
    });
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Run a check against a stub and always close it, assertion or not. */
async function withStudio<T>(
  options: Parameters<typeof studio>[0],
  body: (base: string) => Promise<T>,
): Promise<T> {
  const stub = await studio(options);
  try { return await body(stub.base); }
  finally { await stub.close(); }
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
  await withStudio({}, async (base) => {
    const report = await studioConformance(base, 'screens/board/r3/code.html', '../../../tokens.css');
    assert.equal(report.ok, true, formatConformance(report));
  });
});

test('the wrong depth fails, which is the bug that motivated this check', async () => {
  // `../tokens.css` is what an author writes and what the docs describe. From
  // screens/<slug>/rN/ it resolves to a file that does not exist, and the only
  // symptom is unstyled markup.
  await withStudio({}, async (base) => {
    const report = await studioConformance(base, 'screens/board/r3/code.html', '../tokens.css');
    assert.equal(report.ok, false);
    const link = report.checks.find((c) => c.name.includes('resolves its tokens link'))!;
    assert.equal(link.status, 'fail');
    assert.match(link.detail, /render unstyled with no other symptom/);
  });
});

test('a studio that answers a missing asset with a page fails the check', async () => {
  // The failure mode that makes a broken link look like a working one. Whether
  // a given studio does this is a fact to measure, not to assume — this harness
  // assumed it once and was wrong.
  await withStudio({ missingReturns: 200 }, async (base) => {
    const report = await studioConformance(base, null, '../../../tokens.css');
    const refusal = report.checks.find((c) => c.name.includes('missing asset'))!;
    assert.equal(refusal.status, 'fail');
    assert.match(refusal.detail, /makes a broken link look like a working one/);
  });
});

test('an unregistered screen leaves the depth assumption untested, and says so', async () => {
  await withStudio({}, async (base) => {
    const report = await studioConformance(base, null, '../../../tokens.css');
    const link = report.checks.find((c) => c.name.includes('resolves its tokens link'))!;
    assert.equal(link.status, 'vacuous');
    assert.match(link.detail, /untested/);
    assert.equal(report.ok, true, 'untested is not failed');
  });
});

test('a studio that stops serving tokens.css as CSS fails', async () => {
  await withStudio({ tokensAt: '/files/somewhere-else.css' }, async (base) => {
    const report = await studioConformance(base, null, '../../../tokens.css');
    assert.equal(report.checks.find((c) => c.name.includes('served as CSS'))!.status, 'fail');
  });
});

test('a stub is never left listening', async () => {
  // The property that keeps this suite deterministic. If close() resolved
  // before the socket was released, a later run could bind the same port and
  // the failure would look like an unrelated flake somewhere else.
  const stub = await studio();
  const port = Number(new URL(stub.base).port);
  await stub.close();
  const reachable = await fetch(stub.base, { signal: AbortSignal.timeout(500) })
    .then(() => true).catch(() => false);
  assert.equal(reachable, false, `port ${port} still answering after close()`);
});
