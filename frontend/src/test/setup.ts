import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Raise the async utility timeout so findBy* / waitFor calls don't flake on
// constrained CI runners when React state updates are slow to flush.
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
