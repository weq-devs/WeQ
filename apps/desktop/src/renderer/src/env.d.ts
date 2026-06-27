/// <reference types="vite/client" />

interface Window {
  weq: {
    openLogDir(): Promise<boolean>;
  };
}
