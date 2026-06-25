import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const viteConfigPath = resolve(__dirname, '../../vite.config.ts');
const viteConfig = (() => {
  try {
    return readFileSync(viteConfigPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${viteConfigPath}: ${message}`);
  }
})();

function extractObjectBlock(source: string, key: string): string {
  const keyIndex = source.indexOf(`${key}:`);
  if (keyIndex === -1) return '';

  const objectStart = source.indexOf('{', keyIndex);
  if (objectStart === -1) return '';

  let depth = 0;
  for (let i = objectStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;

    if (depth === 0) {
      return source.slice(objectStart + 1, i);
    }
  }

  return '';
}

const serverBlock = extractObjectBlock(viteConfig, 'server');
const previewBlock = extractObjectBlock(viteConfig, 'preview');

describe('vite dev server config', () => {
  it('keeps browser-accessible dev host/port/allowedHosts contract', () => {
    expect(serverBlock).toMatch(/^\s*host:\s*'0\.0\.0\.0',\s*$/m);
    expect(serverBlock).toMatch(/^\s*port:\s*3000,\s*$/m);
    expect(serverBlock).toMatch(/^\s*allowedHosts:\s*true,\s*$/m);
  });

  it('keeps relaxed host checking scoped to dev server config', () => {
    expect(serverBlock).toContain('allowedHosts: true');
    expect(previewBlock).not.toContain('allowedHosts');
  });
});
