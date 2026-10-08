import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

export const packagedSources = new Map([
  ['extension/package.json', 'package.json'],
  ['extension/readme.md', 'README.md'],
  ['extension/changelog.md', 'CHANGELOG.md'],
  ['extension/LICENSE.txt', 'LICENSE'],
  ['extension/docs/design.md', join('docs', 'design.md')],
  ['extension/dist/extension.js', join('dist', 'extension.js')],
  ['extension/dist/THIRD_PARTY_NOTICES.txt', join('dist', 'THIRD_PARTY_NOTICES.txt')],
  ['extension/media/sidebar.js', join('media', 'sidebar.js')],
  ['extension/media/sidebar.css', join('media', 'sidebar.css')],
  ['extension/media/linebeam.svg', join('media', 'linebeam.svg')],
]);
const metadataFiles = ['extension.vsixmanifest', '[Content_Types].xml'];
const allowedFiles = new Set([...packagedSources.keys(), ...metadataFiles]);
const maxArchiveBytes = 16 * 1024 * 1024;

function requireAllowedFile(name) {
  if (!allowedFiles.has(name)) throw new Error(`Unexpected VSIX entry: ${name}`);
}

async function readArchive(bytes) {
  if (bytes.length > maxArchiveBytes) throw new Error('The preview VSIX exceeds the 16 MiB package-check limit.');
  return new Promise((resolveArchive, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true }, (error, archive) => {
      if (error) return reject(error);
      const files = new Map();
      let totalBytes = 0;
      const fail = (failure) => { archive.close(); reject(failure); };
      archive.on('error', fail);
      archive.on('end', () => resolveArchive(files));
      archive.on('entry', (entry) => {
        void (async () => {
          requireAllowedFile(entry.fileName);
          if (files.has(entry.fileName)) throw new Error(`Duplicate VSIX entry: ${entry.fileName}`);
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
            throw new Error(`Symbolic links are not allowed in the VSIX: ${entry.fileName}`);
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > maxArchiveBytes) throw new Error('The unpacked preview VSIX exceeds 16 MiB.');
          const stream = await new Promise((resolveStream, rejectStream) => {
            archive.openReadStream(entry, (streamError, value) => streamError ? rejectStream(streamError) : resolveStream(value));
          });
          files.set(entry.fileName, await buffer(stream));
          archive.readEntry();
        })().catch(fail);
      });
      archive.readEntry();
    });
  });
}

export async function verifyPackageFiles(files, project = resolve('.')) {
  for (const name of files.keys()) requireAllowedFile(name);
  for (const name of allowedFiles) {
    if (!files.get(name)?.length) throw new Error(`Missing or empty VSIX entry: ${name}`);
  }
  await Promise.all([...packagedSources].map(async ([name, source]) => {
    if (!files.get(name).equals(await readFile(join(project, source)))) {
      throw new Error(`VSIX entry does not match the current build/source: ${name}. Repackage before testing or sharing.`);
    }
  }));
  const manifest = JSON.parse(files.get('extension/package.json').toString('utf8'));
  const identities = [...files.get('extension.vsixmanifest').toString('utf8').matchAll(/<Identity\b([^>]*)>/g)];
  if (identities.length !== 1) throw new Error('The VSIX must contain exactly one extension identity.');
  if (!/<Property\s+Id="Microsoft\.VisualStudio\.Code\.PreRelease"\s+Value="true"\s*\/>/.test(files.get('extension.vsixmanifest').toString('utf8'))) {
    throw new Error('The VSIX must be marked as a Marketplace pre-release.');
  }
  const identity = Object.fromEntries([...identities[0][1].matchAll(/\b(\w+)="([^"]*)"/g)]
    .map((match) => [match[1], match[2]]));
  for (const [attribute, field] of [['Id', 'name'], ['Version', 'version'], ['Publisher', 'publisher']]) {
    if (identity[attribute] !== manifest[field]) throw new Error(`VSIX identity ${attribute} does not match package.json.`);
  }
  return manifest;
}

export async function verifyVsix(packagePath, project = resolve('.')) {
  const source = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const path = resolve(project, packagePath || `${source.name}-${source.version}.vsix`);
  const bytes = await readFile(path);
  const files = await readArchive(bytes);
  const manifest = await verifyPackageFiles(files, project);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { files, manifest, path, sha256 };
}

export async function unpackVerifiedVsix(verified, destination) {
  for (const [name, contents] of verified.files) {
    requireAllowedFile(name);
    if (!name.startsWith('extension/')) continue;
    const path = join(destination, ...name.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return join(destination, 'extension');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/vsix.mjs [path-to-vsix]');
  const verified = await verifyVsix(process.argv[2]);
  console.log(`Verified ${verified.path}: ${verified.files.size} expected files, exact build/source contents, dependency notices, and extension identity.`);
  console.log(`SHA-256: ${verified.sha256}`);
}
