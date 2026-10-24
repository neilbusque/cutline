import net from "node:net";

/**
 * A port the system has free right now. Remotion starts at 3000, where web dev
 * servers live, and checks only 127.0.0.1: a server already on [::]:3000 or
 * one starting at the same moment wins localhost:3000, and Chrome then loads
 * someone else's page instead of the video.
 */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ port: 0, host: "::" }, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
