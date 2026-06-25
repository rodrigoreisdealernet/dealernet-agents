import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalsCss = readFileSync(resolve(__dirname, '../styles/globals.css'), 'utf8');
const mainTsx = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');

describe('theme wiring', () => {
  it('keeps branded color token remaps in globals.css', () => {
    expect(globalsCss).toContain('--color-primary: #0e6566;');
    expect(globalsCss).toContain('--color-accent: #f5a623;');
    expect(globalsCss).toContain('--color-foreground: #0a0d12;');
    expect(globalsCss).toContain('--color-background: #f6f8f8;');
    expect(globalsCss).toContain('--color-muted: #eef3f3;');
    expect(globalsCss).toContain('--color-ring: #0e6566;');
    expect(globalsCss).toContain('--color-primary-hover: #0b5354;');
    expect(globalsCss).toContain('--color-sidebar: #0c2d2e;');
    expect(globalsCss).toContain('--color-sidebar-end: #0a2425;');
    expect(globalsCss).toContain('--color-sidebar-accent: #f5b62e;');
  });

  it('keeps Inter typography tokens and heading tracking in globals.css', () => {
    expect(globalsCss).toContain('--font-sans: "Inter", "Inter Display", ui-sans-serif, system-ui, sans-serif;');
    expect(globalsCss).toContain('letter-spacing: -0.025em;');
  });

  it('loads local Inter font weights in app bootstrap', () => {
    expect(mainTsx).toContain("import '@fontsource/inter/400.css';");
    expect(mainTsx).toContain("import '@fontsource/inter/500.css';");
    expect(mainTsx).toContain("import '@fontsource/inter/600.css';");
    expect(mainTsx).toContain("import '@fontsource/inter/700.css';");
    expect(mainTsx).toContain("import '@fontsource/inter/800.css';");
  });
});
