/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COMMIT_SHA: string | undefined;
  readonly VITE_BUILD_TIME: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
