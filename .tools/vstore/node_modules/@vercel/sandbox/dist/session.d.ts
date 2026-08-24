import { SandboxMetaData, SandboxRouteData, SessionMetaData, SnapshotMetadata } from "./api-client/validators.js";
import { NetworkPolicy, NetworkPolicyRule, NetworkTransformer } from "./network-policy.js";
import { APIClient } from "./api-client/api-client.js";
import "./api-client/index.js";
import { Command, CommandFinished } from "./command.js";
import { Snapshot } from "./snapshot.js";
import { SandboxSnapshot } from "./utils/sandbox-snapshot.js";
import { ExecutionContext } from "./execution-context.js";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { Writable } from "stream";

//#region src/session.d.ts
/**
 * Serialized representation of a Session for @workflow/serde.
 */
interface SerializedSession {
  session: SandboxSnapshot;
  routes: SandboxRouteData[];
}
/** @inline */
interface RunCommandParams {
  /**
   * The command to execute
   */
  cmd: string;
  /**
   * Arguments to pass to the command
   */
  args?: string[];
  /**
   * Working directory to execute the command in
   */
  cwd?: string;
  /**
   * Environment variables to set for this command
   */
  env?: Record<string, string>;
  /**
   * If true, execute this command with root privileges. Defaults to false.
   */
  sudo?: boolean;
  /**
   * If true, the command will return without waiting for `exitCode`
   */
  detached?: boolean;
  /**
   * A `Writable` stream where `stdout` from the command will be piped
   */
  stdout?: Writable;
  /**
   * A `Writable` stream where `stderr` from the command will be piped
   */
  stderr?: Writable;
  /**
   * An AbortSignal to cancel the command execution
   */
  signal?: AbortSignal;
  /**
   * Maximum time in milliseconds the command may run before it is killed with
   * SIGKILL. The timeout is enforced by the sandbox at exec time, so it applies
   * whether or not the command is awaited (including `detached: true`).
   */
  timeoutMs?: number;
}
/**
 * A Session represents a running VM instance within a {@link Sandbox}.
 *
 * Obtain a session via {@link Sandbox.currentSession}.
 */
declare class Session implements ExecutionContext {
  private _client;
  /**
   * Lazily resolve credentials and construct an API client.
   * This is used in step contexts where the Sandbox was deserialized
   * without a client (e.g. when crossing workflow/step boundaries).
   * Uses getCredentials() which resolves from OIDC or env vars.
   * @internal
   */
  private ensureClient;
  /**
   * Routes from ports to subdomains.
   * @hidden
   */
  readonly routes: SandboxRouteData[];
  /**
   * Internal metadata about the current session.
   */
  private session;
  private get client();
  /** @internal */
  get _sessionSnapshot(): SandboxSnapshot;
  /**
   * Unique ID of this session.
   */
  get sessionId(): string;
  get interactivePort(): number | undefined;
  /**
   * The status of this session.
   */
  get status(): SessionMetaData["status"];
  /**
   * The creation date of this session.
   */
  get createdAt(): Date;
  /**
   * The timeout of this session in milliseconds.
   */
  get timeout(): number;
  /**
   * The network policy of this session.
   */
  get networkPolicy(): NetworkPolicy | undefined;
  /**
   * If the session was created from a snapshot, the ID of that snapshot.
   */
  get sourceSnapshotId(): string | undefined;
  /**
   * Memory allocated to this session in MB.
   */
  get memory(): number;
  /**
   * Number of vCPUs allocated to this session.
   */
  get vcpus(): number;
  /**
   * The region where this session is hosted.
   */
  get region(): string;
  /**
   * Legacy runtime identifier, when available.
   *
   * @deprecated Use the parent sandbox's image metadata instead.
   */
  get runtime(): string | undefined;
  /**
   * The working directory of this session.
   */
  get cwd(): string;
  /**
   * When this session was requested.
   */
  get requestedAt(): Date;
  /**
   * When this session started running.
   */
  get startedAt(): Date | undefined;
  /**
   * When this session was requested to stop.
   */
  get requestedStopAt(): Date | undefined;
  /**
   * When this session was stopped.
   */
  get stoppedAt(): Date | undefined;
  /**
   * When this session was aborted.
   */
  get abortedAt(): Date | undefined;
  /**
   * The wall-clock duration of this session in milliseconds.
   */
  get duration(): number | undefined;
  /**
   * When a snapshot was requested for this session.
   */
  get snapshottedAt(): Date | undefined;
  /**
   * When this session was last updated.
   */
  get updatedAt(): Date;
  /**
   * The amount of active CPU used by the session. Only reported once the VM is
   * stopped.
   */
  get activeCpuUsageMs(): number | undefined;
  /**
   * The amount of network data used by the session. Only reported once the VM
   * is stopped.
   */
  get networkTransfer(): {
    ingress: number;
    egress: number;
  } | undefined;
  /**
   * Serialize a Session instance to plain data for @workflow/serde.
   *
   * Although Sandbox handles top-level serialization, Session needs these
   * methods so the Workflow SWC compiler can resolve the class by name.
   * The `new Session(...)` self-reference in WORKFLOW_DESERIALIZE forces
   * rolldown to preserve the class name in the compiled output.
   */
  static [WORKFLOW_SERIALIZE](instance: Session): SerializedSession;
  static [WORKFLOW_DESERIALIZE](data: SerializedSession): Session;
  constructor(params: {
    client: APIClient;
    routes: SandboxRouteData[];
    session: SessionMetaData;
  } | {
    /** @internal – used during deserialization with an already-converted snapshot */
    routes: SandboxRouteData[];
    snapshot: SandboxSnapshot;
  });
  /** @internal */
  updateRoutes(routes: SandboxRouteData[]): void;
  /**
   * Get a previously run command by its ID.
   *
   * @param cmdId - ID of the command to retrieve
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A {@link Command} instance representing the command
   */
  getCommand(cmdId: string, opts?: {
    signal?: AbortSignal;
  }): Promise<Command>;
  /**
   * Start executing a command in this session.
   *
   * @param command - The command to execute.
   * @param args - Arguments to pass to the command.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the command execution.
   * @param opts.timeoutMs - Maximum time in milliseconds to wait for the
   * command to complete. On expiry the process is killed with SIGKILL.
   * @returns A {@link CommandFinished} result once execution is done.
   */
  runCommand(command: string, args?: string[], opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<CommandFinished>;
  /**
   * Start executing a command in detached mode.
   *
   * @param params - The command parameters.
   * @returns A {@link Command} instance for the running command.
   */
  runCommand(params: RunCommandParams & {
    detached: true;
  }): Promise<Command>;
  /**
   * Start executing a command in this session.
   *
   * @param params - The command parameters.
   * @returns A {@link CommandFinished} result once execution is done.
   */
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  /**
   * Create a directory in the filesystem of this session.
   *
   * @param path - Path of the directory to create
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   */
  mkDir(path: string, opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Open an interactive shell session. Returns the WebSocket URL and token the
   * client uses to connect to the controller-hosted PTY.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   */
  openInteractive(opts?: {
    signal?: AbortSignal;
  }): Promise<{
    url: string;
    token: string;
  }>;
  /**
   * Read a file from the filesystem of this session as a stream.
   *
   * @param file - File to read, with path and optional cwd
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves to a ReadableStream containing the file contents, or null if file not found
   */
  readFile(file: {
    path: string;
    cwd?: string;
  }, opts?: {
    signal?: AbortSignal;
  }): Promise<NodeJS.ReadableStream | null>;
  /**
   * Read a file from the filesystem of this session as a Buffer.
   *
   * @param file - File to read, with path and optional cwd
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves to the file contents as a Buffer, or null if file not found
   */
  readFileToBuffer(file: {
    path: string;
    cwd?: string;
  }, opts?: {
    signal?: AbortSignal;
  }): Promise<Buffer | null>;
  /**
   * Download a file from the session to the local filesystem.
   *
   * @param src - Source file on the session, with path and optional cwd
   * @param dst - Destination file on the local machine, with path and optional cwd
   * @param opts - Optional parameters.
   * @param opts.mkdirRecursive - If true, create parent directories for the destination if they don't exist.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns The absolute path to the written file, or null if the source file was not found
   */
  downloadFile(src: {
    path: string;
    cwd?: string;
  }, dst: {
    path: string;
    cwd?: string;
  }, opts?: {
    mkdirRecursive?: boolean;
    signal?: AbortSignal;
  }): Promise<string | null>;
  /**
   * Write files to the filesystem of this session.
   * Defaults to writing to /vercel/sandbox unless an absolute path is specified.
   * Writes files using the sandbox's default user.
   *
   * @param files - Array of files with path and stream/buffer contents
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves when the files are written
   */
  writeFiles(files: {
    path: string;
    content: string | Uint8Array;
    mode?: number;
  }[], opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Get the public domain of a port of this session.
   *
   * @param p - Port number to resolve
   * @returns A full domain (e.g. `https://subdomain.vercel.run`)
   * @throws If the port has no associated route
   */
  domain(p: number): string;
  /**
   * Stop this session.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns The final session state and optional sandbox metadata.
   */
  stop(opts?: {
    signal?: AbortSignal;
  }): Promise<{
    session: SandboxSnapshot;
    sandbox?: SandboxMetaData;
    snapshot?: SnapshotMetadata;
  }>;
  /**
   * Update the current session's settings.
   *
   * @param params - Fields to update.
   * @param params.networkPolicy - The new network policy to apply.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   *
   * @example
   * // Restrict to specific domains
   * await session.update({
   *   networkPolicy: {
   *     allow: ["*.npmjs.org", "github.com"],
   *   }
   * });
   *
   * @example
   * // Inject credentials with per-domain transformers
   * await session.update({
   *   networkPolicy: {
   *     allow: {
   *       "ai-gateway.vercel.sh": [{
   *         transform: [{
   *           headers: { authorization: "Bearer ..." }
   *         }]
   *       }],
   *       "*": []
   *     }
   *   }
   * });
   *
   * @example
   * // Deny all network access
   * await session.update({ networkPolicy: "deny-all" });
   */
  update(params: {
    networkPolicy?: NetworkPolicy;
  }, opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Extend the timeout of the session by the specified duration.
   *
   * This allows you to extend the lifetime of a session up until the maximum
   * execution timeout for your plan.
   *
   * @param duration - The duration in milliseconds to extend the timeout by
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves when the timeout is extended
   *
   * @example
   * const sandbox = await Sandbox.create({ timeout: ms('10m') });
   * const session = sandbox.currentSession();
   * // Extends timeout by 5 minutes, to a total of 15 minutes.
   * await session.extendTimeout(ms('5m'));
   */
  extendTimeout(duration: number, opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Create a snapshot from this currently running session. New sandboxes can
   * then be created from this snapshot using {@link Sandbox.create}.
   *
   * Note: this session will be stopped as part of the snapshot creation process.
   *
   * @param opts - Optional parameters.
   * @param opts.expiration - Optional expiration time in milliseconds. Use 0 for no expiration at all.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves to the Snapshot instance
   */
  snapshot(opts?: {
    expiration?: number;
    signal?: AbortSignal;
  }): Promise<Snapshot>;
}
//#endregion
export { RunCommandParams, Session };
//# sourceMappingURL=session.d.ts.map