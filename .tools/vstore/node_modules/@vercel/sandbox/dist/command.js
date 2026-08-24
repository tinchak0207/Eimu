import { APIClient } from "./api-client/api-client.js";
import "./api-client/index.js";
import { getCredentials } from "./utils/get-credentials.js";
import { resolveSignal } from "./utils/resolveSignal.js";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

//#region src/command.ts
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
var Command = class Command {
	/**
	* Lazily resolve credentials and construct an API client.
	* @internal
	*/
	async ensureClient() {
		"use step";
		if (this._client) return this._client;
		const credentials = await getCredentials();
		this._client = new APIClient({
			teamId: credentials.teamId,
			token: credentials.token
		});
		return this._client;
	}
	/**
	* ID of the command execution.
	*/
	get cmdId() {
		return this.cmd.id;
	}
	get cwd() {
		return this.cmd.cwd;
	}
	get startedAt() {
		return this.cmd.startedAt;
	}
	/**
	* @param params - Object containing the client, sandbox ID, and command data.
	* @param params.client - Optional API client. If not provided, will be lazily created using global credentials.
	* @param params.sessionId - The ID of the session where the command is running.
	* @param params.cmd - The command data.
	* @param params.output - Optional cached output to restore (used during deserialization).
	*/
	constructor({ client, sessionId, cmd, output }) {
		this._client = null;
		this.outputCache = null;
		this._resolvedOutput = null;
		this._client = client ?? null;
		this.sessionId = sessionId;
		this.cmd = cmd;
		this.exitCode = cmd.exitCode ?? null;
		this.durationMs = cmd.durationMs;
		if (output) {
			this._resolvedOutput = output;
			this.outputCache = Promise.resolve({
				stdout: output.stdout,
				stderr: output.stderr,
				both: output.stdout + output.stderr
			});
		}
	}
	/**
	* Serialize a Command instance to plain data for @workflow/serde.
	*
	* @param instance - The Command instance to serialize
	* @returns A plain object containing the sandbox ID, command data, and output if fetched
	*/
	static [WORKFLOW_SERIALIZE](instance) {
		const serialized = {
			sandboxId: instance.sessionId,
			cmd: instance.cmd
		};
		if (instance._resolvedOutput) serialized.output = instance._resolvedOutput;
		return serialized;
	}
	/**
	* Deserialize plain data back into a Command instance for @workflow/serde.
	*
	* The deserialized instance will lazily create an API client using
	* OIDC or environment credentials when needed.
	*
	* @param data - The serialized command data
	* @returns The reconstructed Command instance
	*/
	static [WORKFLOW_DESERIALIZE](data) {
		return new Command({
			sessionId: data.sandboxId,
			cmd: data.cmd,
			output: data.output
		});
	}
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
	logs(opts) {
		if (!this._client) throw new Error("logs() requires an API client. Call an async method first to initialize the client.");
		return this._client.getLogs({
			sessionId: this.sessionId,
			cmdId: this.cmd.id,
			signal: opts?.signal
		});
	}
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
	async wait(params) {
		"use step";
		const client = await this.ensureClient();
		params?.signal?.throwIfAborted();
		const command = await client.getCommand({
			sessionId: this.sessionId,
			cmdId: this.cmd.id,
			wait: true,
			signal: params?.signal
		});
		return new CommandFinished({
			client,
			sessionId: this.sessionId,
			cmd: command.json.command,
			exitCode: command.json.command.exitCode,
			durationMs: command.json.command.durationMs
		});
	}
	/**
	* Get cached output, fetching logs only once and reusing for concurrent calls.
	* This prevents race conditions when stdout() and stderr() are called in parallel.
	*/
	async getCachedOutput(opts) {
		if (!this.outputCache) this.outputCache = (async () => {
			try {
				opts?.signal?.throwIfAborted();
				await this.ensureClient();
				let stdout = "";
				let stderr = "";
				let both = "";
				for await (const log of this.logs({ signal: opts?.signal })) {
					both += log.data;
					if (log.stream === "stdout") stdout += log.data;
					else stderr += log.data;
				}
				this._resolvedOutput = {
					stdout,
					stderr
				};
				return {
					stdout,
					stderr,
					both
				};
			} catch (err) {
				this.outputCache = null;
				throw err;
			}
		})();
		return this.outputCache;
	}
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
	async output(stream = "both", opts) {
		"use step";
		return (await this.getCachedOutput(opts))[stream];
	}
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
	async stdout(opts) {
		"use step";
		return this.output("stdout", opts);
	}
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
	async stderr(opts) {
		"use step";
		return this.output("stderr", opts);
	}
	/**
	* Kill a running command in a sandbox.
	*
	* @param signal - The signal to send the running process. Defaults to SIGTERM.
	* @param opts - Optional parameters.
	* @param opts.abortSignal - An AbortSignal to cancel the kill operation.
	* @returns Promise<void>.
	*/
	async kill(signal, opts) {
		"use step";
		await (await this.ensureClient()).killCommand({
			sessionId: this.sessionId,
			commandId: this.cmd.id,
			signal: resolveSignal(signal ?? "SIGTERM"),
			abortSignal: opts?.abortSignal
		});
	}
};
/**
* A command that has finished executing.
*
* The exit code is immediately available and populated upon creation.
* Unlike {@link Command}, you don't need to call wait() - the command
* has already completed execution.
*
* @hideconstructor
*/
var CommandFinished = class CommandFinished extends Command {
	/**
	* @param params - Object containing client, sandbox ID, command data, and exit code.
	* @param params.client - Optional API client. If not provided, will be lazily created using global credentials.
	* @param params.sessionId - The ID of the session where the command ran.
	* @param params.cmd - The command data.
	* @param params.exitCode - The exit code of the completed command.
	* @param params.durationMs - Optional duration of the command execution in milliseconds.
	* @param params.output - Optional cached output to restore (used during deserialization).
	*/
	constructor(params) {
		super({ ...params });
		this.exitCode = params.exitCode;
		this.durationMs = params.durationMs ?? params.cmd.durationMs;
	}
	/**
	* Serialize a CommandFinished instance to plain data for @workflow/serde.
	*
	* @param instance - The CommandFinished instance to serialize
	* @returns A plain object containing the sandbox ID, command data, exit code, and output if fetched
	*/
	static [WORKFLOW_SERIALIZE](instance) {
		return {
			...Command[WORKFLOW_SERIALIZE](instance),
			exitCode: instance.exitCode,
			durationMs: instance.durationMs
		};
	}
	/**
	* Deserialize plain data back into a CommandFinished instance for @workflow/serde.
	*
	* The deserialized instance will lazily create an API client using
	* OIDC or environment credentials when needed.
	*
	* @param data - The serialized command finished data
	* @returns The reconstructed CommandFinished instance
	*/
	static [WORKFLOW_DESERIALIZE](data) {
		return new CommandFinished({
			sessionId: data.sandboxId,
			cmd: data.cmd,
			exitCode: data.exitCode,
			durationMs: data.durationMs,
			output: data.output
		});
	}
	/**
	* The wait method is not needed for CommandFinished instances since
	* the command has already completed and exitCode is populated.
	*
	* @deprecated This method is redundant for CommandFinished instances.
	* The exitCode is already available.
	* @returns This CommandFinished instance.
	*/
	async wait() {
		return this;
	}
};

//#endregion
export { Command, CommandFinished };
//# sourceMappingURL=command.js.map