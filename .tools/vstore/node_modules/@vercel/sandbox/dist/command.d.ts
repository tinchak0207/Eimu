import { CommandData, LogOutputLine } from "./api-client/validators.js";
import { APIClient } from "./api-client/api-client.js";
import "./api-client/index.js";
import { Signal } from "./utils/resolveSignal.js";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

//#region src/command.d.ts
/**
 * Cached output from a command execution.
 */
interface CommandOutput {
  stdout: string;
  stderr: string;
}
/**
 * Serialized representation of a Command for @workflow/serde.
 */
interface SerializedCommand {
  sandboxId: string;
  cmd: CommandData;
  /** Cached output, included if output was fetched before serialization */
  output?: CommandOutput;
}
/**
 * Serialized representation of a CommandFinished for @workflow/serde.
 */
interface SerializedCommandFinished extends SerializedCommand {
  exitCode: number;
  durationMs?: number;
}
/**
 * A command executed in a Sandbox.
 *
 * For detached commands, you can {@link wait} to get a {@link CommandFinished} instance
 * with the populated exit code. For non-detached commands, {@link Sandbox.runCommand}
 * automatically waits and returns a {@link CommandFinished} instance.
 *
 * You can iterate over command output with {@link logs}.
 *
 * @see {@link Sandbox.runCommand} to start a command.
 *
 * @hideconstructor
 */
declare class Command {
  /**
   * Cached API client instance.
   * @internal
   */
  protected _client: APIClient | null;
  /**
   * Lazily resolve credentials and construct an API client.
   * @internal
   */
  protected ensureClient(): Promise<APIClient>;
  /**
   * ID of the session this command is running in.
   */
  protected sessionId: string;
  /**
   * Data for the command execution.
   */
  protected cmd: CommandData;
  exitCode: number | null;
  durationMs?: number;
  protected outputCache: Promise<{
    stdout: string;
    stderr: string;
    both: string;
  }> | null;
  /**
   * Synchronously accessible resolved output, populated after output is fetched.
   * Used for serialization.
   * @internal
   */
  protected _resolvedOutput: CommandOutput | null;
  /**
   * ID of the command execution.
   */
  get cmdId(): string;
  get cwd(): string;
  get startedAt(): number;
  /**
   * @param params - Object containing the client, sandbox ID, and command data.
   * @param params.client - Optional API client. If not provided, will be lazily created using global credentials.
   * @param params.sessionId - The ID of the session where the command is running.
   * @param params.cmd - The command data.
   * @param params.output - Optional cached output to restore (used during deserialization).
   */
  constructor({
    client,
    sessionId,
    cmd,
    output
  }: {
    client?: APIClient;
    sessionId: string;
    cmd: CommandData;
    output?: CommandOutput;
  });
  /**
   * Serialize a Command instance to plain data for @workflow/serde.
   *
   * @param instance - The Command instance to serialize
   * @returns A plain object containing the sandbox ID, command data, and output if fetched
   */
  static [WORKFLOW_SERIALIZE](instance: Command): SerializedCommand;
  /**
   * Deserialize plain data back into a Command instance for @workflow/serde.
   *
   * The deserialized instance will lazily create an API client using
   * OIDC or environment credentials when needed.
   *
   * @param data - The serialized command data
   * @returns The reconstructed Command instance
   */
  static [WORKFLOW_DESERIALIZE](data: SerializedCommand): Command;
  /**
   * Iterate over the output of this command.
   *
   * ```
   * for await (const log of cmd.logs()) {
   *   if (log.stream === "stdout") {
   *     process.stdout.write(log.data);
   *   } else {
   *     process.stderr.write(log.data);
   *   }
   * }
   * ```
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel log streaming.
   * @returns An async iterable of log entries from the command output.
   *
   * @see {@link Command.stdout}, {@link Command.stderr}, and {@link Command.output}
   * to access output as a string.
   */
  logs(opts?: {
    signal?: AbortSignal;
  }): AsyncGenerator<LogOutputLine, void, void> & Disposable & {
    close(): void;
  };
  /**
   * Wait for a command to exit and populate its exit code.
   *
   * This method is useful for detached commands where you need to wait
   * for completion. For non-detached commands, {@link Sandbox.runCommand}
   * automatically waits and returns a {@link CommandFinished} instance.
   *
   * ```
   * const detachedCmd = await sandbox.runCommand({ cmd: 'sleep', args: ['5'], detached: true });
   * const result = await detachedCmd.wait();
   * if (result.exitCode !== 0) {
   *   console.error("Something went wrong...")
   * }
   * ```
   *
   * @param params - Optional parameters.
   * @param params.signal - An AbortSignal to cancel waiting.
   * @returns A {@link CommandFinished} instance with populated exit code.
   */
  wait(params?: {
    signal?: AbortSignal;
  }): Promise<CommandFinished>;
  /**
   * Get cached output, fetching logs only once and reusing for concurrent calls.
   * This prevents race conditions when stdout() and stderr() are called in parallel.
   */
  protected getCachedOutput(opts?: {
    signal?: AbortSignal;
  }): Promise<{
    stdout: string;
    stderr: string;
    both: string;
  }>;
  /**
   * Get the output of `stdout`, `stderr`, or both as a string.
   *
   * NOTE: This may throw string conversion errors if the command does
   * not output valid Unicode.
   *
   * @param stream - The output stream to read: "stdout", "stderr", or "both".
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel output streaming.
   * @returns The output of the specified stream(s) as a string.
   */
  output(stream?: "stdout" | "stderr" | "both", opts?: {
    signal?: AbortSignal;
  }): Promise<string>;
  /**
   * Get the output of `stdout` as a string.
   *
   * NOTE: This may throw string conversion errors if the command does
   * not output valid Unicode.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel output streaming.
   * @returns The standard output of the command.
   */
  stdout(opts?: {
    signal?: AbortSignal;
  }): Promise<string>;
  /**
   * Get the output of `stderr` as a string.
   *
   * NOTE: This may throw string conversion errors if the command does
   * not output valid Unicode.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel output streaming.
   * @returns The standard error output of the command.
   */
  stderr(opts?: {
    signal?: AbortSignal;
  }): Promise<string>;
  /**
   * Kill a running command in a sandbox.
   *
   * @param signal - The signal to send the running process. Defaults to SIGTERM.
   * @param opts - Optional parameters.
   * @param opts.abortSignal - An AbortSignal to cancel the kill operation.
   * @returns Promise<void>.
   */
  kill(signal?: Signal, opts?: {
    abortSignal?: AbortSignal;
  }): Promise<void>;
}
/**
 * A command that has finished executing.
 *
 * The exit code is immediately available and populated upon creation.
 * Unlike {@link Command}, you don't need to call wait() - the command
 * has already completed execution.
 *
 * @hideconstructor
 */
declare class CommandFinished extends Command {
  /**
   * The exit code of the command. This is always populated for
   * CommandFinished instances.
   */
  exitCode: number;
  /**
   * The duration of the command execution in milliseconds.
   */
  durationMs?: number;
  /**
   * @param params - Object containing client, sandbox ID, command data, and exit code.
   * @param params.client - Optional API client. If not provided, will be lazily created using global credentials.
   * @param params.sessionId - The ID of the session where the command ran.
   * @param params.cmd - The command data.
   * @param params.exitCode - The exit code of the completed command.
   * @param params.durationMs - Optional duration of the command execution in milliseconds.
   * @param params.output - Optional cached output to restore (used during deserialization).
   */
  constructor(params: {
    client?: APIClient;
    sessionId: string;
    cmd: CommandData;
    exitCode: number;
    durationMs?: number;
    output?: CommandOutput;
  });
  /**
   * Serialize a CommandFinished instance to plain data for @workflow/serde.
   *
   * @param instance - The CommandFinished instance to serialize
   * @returns A plain object containing the sandbox ID, command data, exit code, and output if fetched
   */
  static [WORKFLOW_SERIALIZE](instance: CommandFinished): SerializedCommandFinished;
  /**
   * Deserialize plain data back into a CommandFinished instance for @workflow/serde.
   *
   * The deserialized instance will lazily create an API client using
   * OIDC or environment credentials when needed.
   *
   * @param data - The serialized command finished data
   * @returns The reconstructed CommandFinished instance
   */
  static [WORKFLOW_DESERIALIZE](data: SerializedCommandFinished): CommandFinished;
  /**
   * The wait method is not needed for CommandFinished instances since
   * the command has already completed and exitCode is populated.
   *
   * @deprecated This method is redundant for CommandFinished instances.
   * The exitCode is already available.
   * @returns This CommandFinished instance.
   */
  wait(): Promise<CommandFinished>;
}
//#endregion
export { Command, CommandFinished, CommandOutput, SerializedCommand, SerializedCommandFinished };
//# sourceMappingURL=command.d.ts.map