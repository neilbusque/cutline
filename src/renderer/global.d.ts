export {};
declare global {
  interface Window {
    cutline: {
      invoke: (name: string, args?: unknown) => Promise<any>;
      pathForFile: (file: File) => string;
      on: (channel: string, callback: (value: any) => void) => () => void;
    };
  }
}
