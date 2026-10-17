import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Verify the checked artifact and merge immutable release history without rebuilding code. */
export function prepareRelease({ manifest, pkg, lock, bytes, currentFeed, previousFeed, repository }) {
  const version = manifest.version;
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.version, version, 'package.json and manifest versions must match');
  assert.equal(lock.version, version, 'lockfile version must match');
  assert.equal(lock.packages[''].version, version, 'lockfile root version must match');
  assert.equal(manifest.update.repository, repository, 'Release repository must match the manifest');
  const bundle = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(bundle.manifest, manifest, 'Artifact manifest must match the checked commit');
  assert.equal(bundle.sha256, sha256(bundle.code), 'Artifact code checksum mismatch');
  assert.equal(currentFeed.schemaVersion, 1);
  const current = currentFeed.plugins.find(plugin => plugin.id === manifest.id)?.releases.find(release => release.version === version);
  assert(current, 'Build is missing its current update entry');
  assert.equal(current.sha256, sha256(bytes), 'Update feed package checksum mismatch');
  assert.deepEqual(current.manifest, manifest);
  assert.equal(current.url, `https://github.com/${repository}/releases/download/v${version}/${manifest.id}.laplugin`);
  let history = [];
  if (previousFeed) {
    assert.equal(previousFeed.schemaVersion, 1, 'Unsupported previous update feed');
    const plugin = previousFeed.plugins.find(plugin => plugin.id === manifest.id);
    assert(plugin && Array.isArray(plugin.releases), 'Previous update feed is missing this plugin');
    history = plugin.releases.filter(release => release.version !== version);
  }
  return { tag: `v${version}`, prerelease: version.includes('-'), file: `${manifest.id}.laplugin`,
    feed: { schemaVersion: 1, plugins: [{ id: manifest.id, releases: [current, ...history] }] } };
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const manifest = await readJson('manifest.json');
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = process.env.GITHUB_SHA;
  assert(repository && /^[\w.-]+\/[\w.-]+$/.test(repository), 'GITHUB_REPOSITORY is required');
  assert(commit && /^[a-f0-9]{40}$/.test(commit), 'GITHUB_SHA is required');
  const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8' });
  const releases = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`)).flat();
  const tag = `v${manifest.version}`;
  const existing = releases.find(release => release.tag_name === tag);
  if (existing) {
    assert(!existing.draft, `${tag} has an unfinished draft; review it before retrying`);
    for (const file of [`${manifest.id}.laplugin`, 'plugins.update.json']) {
      assert(existing.assets.some(asset => asset.name === file && asset.state === 'uploaded'), `${tag} is missing ${file}`);
    }
    console.log(`${tag} is already published; skipping without replacing assets.`);
    return;
  }
  const tagged = spawnSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`], { cwd: root, encoding: 'utf8' });
  assert.equal(tagged.status, 2, tagged.status === 0 ? `${tag} already exists without a release` : `Unable to check tag: ${tagged.stderr}`);
  const previous = releases.find(release => !release.draft && release.assets.some(asset => asset.name === 'plugins.update.json'));
  const previousFeed = previous ? JSON.parse(gh('release', 'download', previous.tag_name, '--repo', repository,
    '--pattern', 'plugins.update.json', '--output', '-')) : undefined;
  const release = prepareRelease({ manifest, pkg: await readJson('package.json'), lock: await readJson('package-lock.json'),
    bytes: await readFile(path.join(root, 'dist', `${manifest.id}.laplugin`)),
    currentFeed: await readJson('dist/plugins.update.json'), previousFeed, repository });
  await writeFile(path.join(root, 'dist/plugins.update.json'), `${JSON.stringify(release.feed, null, 2)}\n`);
  // Upload both assets while private; publishing creates the tag at the checked commit.
  console.log(gh('release', 'create', release.tag, path.join(root, 'dist', release.file), path.join(root, 'dist/plugins.update.json'),
    '--repo', repository, '--target', commit, '--title', release.tag, '--generate-notes', '--draft',
    ...(release.prerelease ? ['--prerelease'] : [])));
  const drafts = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`)).flat();
  const draft = drafts.find(item => item.draft && item.tag_name === release.tag);
  assert(draft, 'New release draft was not found');
  gh('api', '--method', 'PATCH', `repos/${repository}/releases/${draft.id}`, '-F', 'draft=false');
  console.log(`Published ${release.tag} from ${commit}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
