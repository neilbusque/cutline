import { contextBridge, ipcRenderer, webUtils } from "electron";
contextBridge.exposeInMainWorld("cutline", {
  invoke: (name: string, args?: unknown) =>
    ipcRenderer.invoke("cutline", name, args),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  on: (channel: string, callback: (value: any) => void) => {
    if (!["state", "job", "assistant", "agent", "ui", "graphic"].includes(channel))
      throw Error("Unknown event");
    const handler = (_event: any, value: any) => callback(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
