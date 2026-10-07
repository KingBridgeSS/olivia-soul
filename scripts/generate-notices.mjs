import fs from 'node:fs/promises';
import path from 'node:path';

export async function generateNotices(results) {
  const packages = new Set();
  for (const result of results) for (const input of Object.keys(result.metafile.inputs)) {
    const parts = input.replaceAll('\\', '/').split('/');
    const index = parts.lastIndexOf('node_modules');
    if (index < 0) continue;
    const count = parts[index + 1].startsWith('@') ? 3 : 2;
    packages.add(parts.slice(0, index + count).join('/'));
  }
  let output = await fs.readFile('LICENSE', 'utf8');
  for (const root of [...packages].sort()) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const name = pkg.name;
    const licenseId = pkg.license === 'Apache License 2.0' ? 'Apache-2.0' : pkg.license;
    const names = (await fs.readdir(root)).filter(file => /^(licen[sc]e|copying|notice)(?:[.-]|$)/i.test(file));
    if (!names.length && !pkg.license) throw new Error(`Missing bundled dependency license: ${name}`);
    output += `\n\n${'='.repeat(72)}\n${name}@${pkg.version} (${pkg.license || 'see license text'})\n`;
    if (!names.length) {
      output += `Upstream npm tarball supplies no license/copyright text. Declared license: ${pkg.license}.\nPackage: https://www.npmjs.com/package/${name}\nLicense reference: https://spdx.org/licenses/${licenseId}.html\n`;
      console.warn(`License text absent upstream: ${name} (${pkg.license}); recorded manifest declaration.`);
    }
    for (const file of names) {
      if ((await fs.stat(path.join(root, file))).isFile()) output += `\n--- ${file} ---\n${await fs.readFile(path.join(root, file), 'utf8')}\n`;
    }
  }
  await fs.writeFile('dist/THIRD-PARTY-LICENSES.txt', output);
  console.log(`Collected licenses for ${packages.size} bundled packages.`);
}
