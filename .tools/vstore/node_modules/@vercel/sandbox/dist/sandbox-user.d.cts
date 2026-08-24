import { Command, CommandFinished } from "./command.cjs";
import { ExecutionContext } from "./execution-context.cjs";
import { RunCommandParams } from "./session.cjs";
import { Sandbox } from "./sandbox.cjs";

//#region src/sandbox-user.d.ts

/**
 * Thrown when {@link Sandbox.createUser} is called for an existing username.
 */
declare class SandboxUserAlreadyExistsError extends Error {
  readonly username: string;
  constructor(username: string);
}
/**
 * A user context within a sandbox.
 *
 * All file and command operations default to running as this user.
 * Created via {@link Sandbox.createUser} or {@link Sandbox.asUser}.
 *
 * @hideconstructor
 */
declare class SandboxUser implements ExecutionContext {
  /**
   * The Linux username.
   */
  readonly username: string;
  /**
   * The user's home directory (e.g., `/home/alice`).
   */
  readonly homeDir: string;
  private readonly sandbox;
  /**
   * Memoized lookup of this user's primary group.
   * See {@link SandboxUser.primaryGroup}.
   */
  private primaryGroupPromise?;
  constructor({
    sandbox,
    username
  }: {
    sandbox: Sandbox;
    username: string;
  });
  /**
   * Build the wrapped command args to run as this user via `sudo -u`.
   *
   * When `env` is provided, injects `env KEY=VAL ...` so that environment
   * variables survive the `sudo -u` transition.
   */
  private buildUserCommand;
  /**
   * Resolve a path relative to this user's home directory.
   * Absolute paths are returned as-is.
   */
  private resolvePath;
  /**
   * Start executing a command as this user.
   *
   * @param command - The command to execute.
   * @param args - Arguments to pass to the command.
   * @param opts - Optional parameters.
   * @returns A {@link CommandFinished} result once execution is done.
   */
  runCommand(command: string, args?: string[], opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<CommandFinished>;
  /**
   * Start executing a command as this user in detached mode.
   *
   * @param params - The command parameters.
   * @returns A {@link Command} instance for the running command.
   */
  runCommand(params: RunCommandParams & {
    detached: true;
  }): Promise<Command>;
  /**
   * Start executing a command as this user.
   *
   * @param params - The command parameters.
   * @returns A {@link CommandFinished} result once execution is done.
   */
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  /**
   * Write files to this user's home directory (or absolute paths).
   * Files are written via the sandbox HTTP API then chowned to this user.
   *
   * The HTTP API can write to user home dirs because they are group-owned
   * by the sandbox's default user group with `770` permissions.
   *
   * @param files - Array of files with path, content, and optional mode
   * @param opts - Optional parameters.
   */
  writeFiles(files: {
    path: string;
    content: string | Uint8Array;
    mode?: number;
  }[], opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Read a file from this user's context as a stream.
   *
   * @param file - File to read, with path and optional cwd
   * @param opts - Optional parameters.
   * @returns A ReadableStream of the file contents, or null if not found
   */
  readFile(file: {
    path: string;
    cwd?: string;
  }, opts?: {
    signal?: AbortSignal;
  }): Promise<NodeJS.ReadableStream | null>;
  /**
   * Read a file from this user's context as a Buffer.
   *
   * @param file - File to read, with path and optional cwd
   * @param opts - Optional parameters.
   * @returns The file contents as a Buffer, or null if not found
   */
  readFileToBuffer(file: {
    path: string;
    cwd?: string;
  }, opts?: {
    signal?: AbortSignal;
  }): Promise<Buffer | null>;
  /**
   * Download a file from this user's context to the local filesystem.
   *
   * @param src - Source file in the sandbox
   * @param dst - Destination on the local machine
   * @param opts - Optional parameters.
   * @returns The absolute path to the written file, or null if not found
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
   * Read a file as this user and return its bytes, or null if it does not
   * exist.
   *
   * Reads via `sudo -u <user> base64` rather than the HTTP file API, which may
   * not be able to read files this user has kept private (e.g. mode `600`).
   * Reading as the user always honours the user's own permissions. The payload
   * is base64-encoded because the command output channel is UTF-8 only and
   * would otherwise corrupt binary files.
   */
  private catAsUser;
  /**
   * Create a directory owned by this user.
   *
   * @param path - Path of the directory to create
   * @param opts - Optional parameters.
   */
  mkDir(path: string, opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * This user's primary group. Users created via {@link Sandbox.createUser}
   * get a group named after them, but {@link Sandbox.asUser} accepts
   * pre-existing users whose primary group can differ (e.g. system users), so
   * we resolve it from the sandbox rather than assuming `<username>`.
   *
   * The result is memoized for the lifetime of this instance.
   */
  private primaryGroup;
  private resolvePrimaryGroup;
  /**
   * Run `chown <ownership> <paths...>` as root, throwing on failure.
   */
  private chownOrThrow;
  /**
   * Run `chmod <mode> <paths...>` as root, throwing on failure.
   */
  private chmodOrThrow;
  /**
   * Given absolute leaf paths, return the directories strictly between this
   * user's home directory and each leaf. The home dir itself is excluded, as
   * are any paths that fall outside the home dir.
   */
  private ancestorDirsUnderHome;
  /**
   * Add this user to a group.
   *
   * @param groupname - Name of the group to join
   * @param opts - Optional parameters.
   */
  addToGroup(groupname: string, opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Remove this user from a group.
   *
   * @param groupname - Name of the group to leave
   * @param opts - Optional parameters.
   */
  removeFromGroup(groupname: string, opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
}
//#endregion
export { SandboxUser, SandboxUserAlreadyExistsError };
//# sourceMappingURL=sandbox-user.d.cts.map