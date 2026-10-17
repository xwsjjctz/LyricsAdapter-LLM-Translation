import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { prepareRelease } from '../scripts/release.mjs';

function fixture(version = '1.0.1') {
  const repository = 'publisher/translator';
  const manifest = { id: 'translator', version, update: { repository } };
  const code = 'exports.activate = () => {};';
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = Buffer.from(JSON.stringify({ manifest, code, sha256: hash(code) }));
  return { manifest, repository, bytes, pkg: { version }, lock: { version, packages: { '': { version } } },
    currentFeed: { schemaVersion: 1, plugins: [{ id: manifest.id, releases: [{ version, manifest,
      url: `https://github.com/${repository}/releases/download/v${version}/translator.laplugin`, sha256: hash(bytes) }] }] } };
}

test('publishes the verified artifact while retaining previous compatible releases', () => {
  const input = fixture();
  const old = { version: '1.0.0', sha256: 'old-checksum', url: 'old-asset' };
  const previousFeed = { schemaVersion: 1, plugins: [{ id: 'translator', releases: [old] }] };
  const release = prepareRelease({ ...input, previousFeed });
  assert.equal(release.tag, 'v1.0.1');
  assert.equal(release.prerelease, false);
  assert.deepEqual(release.feed.plugins[0].releases, [input.currentFeed.plugins[0].releases[0], old]);
  assert.deepEqual(previousFeed.plugins[0].releases, [old]);
});

test('the first release needs no historical feed', () => {
  assert.equal(prepareRelease(fixture()).feed.plugins[0].releases.length, 1);
});

test('version suffixes produce prereleases', () => {
  assert.equal(prepareRelease(fixture('1.1.0-beta.1')).prerelease, true);
});

test('rejects a package version mismatch', () => {
  const input = fixture(); input.pkg.version = '1.0.0';
  assert.throws(() => prepareRelease(input), /versions must match/);
});

test('rejects a changed installation package', () => {
  const input = fixture(); input.bytes = Buffer.concat([input.bytes, Buffer.from(' ')]);
  assert.throws(() => prepareRelease(input), /package checksum mismatch/);
});

test('rejects a feed pointing to another release', () => {
  const input = fixture(); input.currentFeed.plugins[0].releases[0].url = 'https://example.com/plugin';
  assert.throws(() => prepareRelease(input));
});

test('rejects a previous feed that would silently lose this plugin history', () => {
  assert.throws(() => prepareRelease({ ...fixture(), previousFeed: { schemaVersion: 1, plugins: [] } }), /missing this plugin/);
});
