/**
 * The server: owns Notebook Sessions, serves the browser client, streams events
 * and handles auth. This is where the launcher's web flags arrive.
 *
 * Nothing of it is built yet — ticket 14 begins it with a server that binds to
 * loopback and serves the client shell — so starting it says so, rather than
 * leaving a reader to wonder whether the flag was read.
 */

export interface ServerOptions {
  /** The port to listen on. Absent leaves the choice to the server. */
  readonly port?: number;
}

export function startServer(options: ServerOptions): Promise<void> {
  const where = options.port === undefined ? "" : ` on port ${options.port}`;
  return Promise.reject(
    new Error(`The web interface is not built yet, so there is no server to start${where}.`),
  );
}
