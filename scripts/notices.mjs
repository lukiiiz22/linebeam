import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const licenseFile = /^(?:licen[sc]e|copying)(?:[._-].*)?$/i;
const noticeFile = /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i;

export async function createThirdPartyNotices(metafile, project = resolve('.')) {
  if (!metafile?.inputs || typeof metafile.inputs !== 'object') {
    throw new Error('Bundling metadata is required to generate third-party notices.');
  }
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = resolve(project, input.replace(/[\\/]/g, sep)).split(sep);
    const marker = parts.lastIndexOf('node_modules');
    if (marker < 0) continue;
    const end = marker + (parts[marker + 1]?.startsWith('@') ? 3 : 2);
    if (parts.length <= end) {
      throw new Error(`Cannot identify the bundled package for ${input}.`);
    }
    roots.add(parts.slice(0, end).join(sep));
  }

  const packages = await Promise.all([...roots].map(async (root) => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    for (const field of ['name', 'version', 'license']) {
      if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
        throw new Error(`Bundled package ${root} has no valid ${field} metadata.`);
      }
    }
    const id = `${manifest.name}@${manifest.version}`;
    const files = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && noticeFile.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (!files.some((file) => licenseFile.test(file))) {
      throw new Error(`Bundled dependency ${id} has no license file. Packaging must retain its license notices.`);
    }
    const texts = await Promise.all(files.map(async (file) => {
      const text = (await readFile(join(root, file), 'utf8')).replace(/\r\n/g, '\n').trimEnd();
      if (!text.trim()) throw new Error(`Bundled dependency ${id} has an empty ${file}.`);
      return `${file}\n\n${text}`;
    }));
    return { id, text: `${id}\nDeclared license: ${manifest.license}\n\n${texts.join('\n\n')}` };
  }));
  packages.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [
    'Third-party notices for Linebeam',
    'Generated from the packages included in dist/extension.js.',
    'Linebeam is licensed separately under the MIT license.',
    packages.length
      ? packages.map((entry) => entry.text).join('\n\n----------------------------------------\n\n')
      : 'No third-party packages are bundled.',
  ].join('\n\n') + '\n';
}
