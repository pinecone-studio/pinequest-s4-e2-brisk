declare global {
  interface Window {
    JSMpeg: {
      Player: new (url: string, options: Record<string, unknown>) => {
        destroy: () => void;
      };
    };
  }
}

export {};
