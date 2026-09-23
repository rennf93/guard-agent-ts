import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node bump-version.mjs <version>');
  console.error('Example: node bump-version.mjs 1.0.0');
  process.exit(1);
}

const packageJsonPath = 'package.json';
const content = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
content.version = version;
writeFileSync(packageJsonPath, JSON.stringify(content, null, 2) + '\n');
console.log(`Updated ${packageJsonPath} to ${version}`);
