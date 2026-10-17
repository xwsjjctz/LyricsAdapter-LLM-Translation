import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Builds dist/<id>.laplugin and dist/plugins.update.json. Packaging never executes plugin code.
// Usage: npm run package [-- --base-url https://github.com/<owner>/<repo>/releases/download/v<version>/] [--notes notes.txt]
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id) || !/^[\w.-]+\.cjs$/.test(manifest.main)) throw new Error('Invalid package id or entry');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error(`Invalid version ${manifest.version}`);

const result = await build({ entryPoints: [path.join(root, 'src', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false });
const code = result.outputFiles[0].text;
const bytes = Buffer.from(JSON.stringify({ manifest, code, sha256: createHash('sha256').update(code).digest('hex') }));
await mkdir(output, { recursive: true });
const file = `${manifest.id}.laplugin`;
await writeFile(path.join(output, file), bytes);
console.log(`Plugin package: dist/${file}`);

// The update feed keeps earlier releases (place the previous plugins.update.json in dist/ first)
// so older hosts can still find the last version compatible with them.
const base = new URL(option('--base-url') ?? `https://github.com/${manifest.update.repository}/releases/download/v${manifest.version}/`);
if (base.protocol !== 'https:' || !base.pathname.endsWith('/')) throw new Error('Base URL must be an HTTPS directory');
const notesFile = option('--notes');
const notes = notesFile ? await readFile(path.resolve(notesFile), 'utf8') : undefined;
const feedPath = path.join(output, 'plugins.update.json');
let feed = { schemaVersion: 1, plugins: [] };
try { feed = JSON.parse(await readFile(feedPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const release = { version: manifest.version, manifest, url: new URL(file, base).href, sha256: createHash('sha256').update(bytes).digest('hex'), ...(notes ? { notes } : {}) };
let plugin = feed.plugins.find(item => item.id === manifest.id);
if (!plugin) { plugin = { id: manifest.id, releases: [] }; feed.plugins.push(plugin); }
plugin.releases = [release, ...plugin.releases.filter(item => item.version !== manifest.version)];
await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
console.log('Update feed: dist/plugins.update.json');
