import { consumeReadable } from "./utils/consume-readable.js";
import { APIClient } from "./api-client/api-client.js";
import "./api-client/index.js";
import { getCredentials } from "./utils/get-credentials.js";
import { Command, CommandFinished } from "./command.js";
import { Snapshot } from "./snapshot.js";
import { toSandboxSnapshot } from "./utils/sandbox-snapshot.js";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { dirname, resolve } from "path";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";

//#region src/session.ts
/**
* A Session represents a running VM instance within a {@link Sandbox}.
*
* Obtain a session via {@link Sandbox.currentSession}.
*/
var Session = class Session {
	/**
	* Lazily resolve credentials and construct an API client.
	* This is used in step contexts where the Sandbox was deserialized
	* without a client (e.g. when crossing workflow/step boundaries).
	* Uses getCredentials() which resolves from OIDC or env vars.
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
	get client() {
		if (!this._client) throw new Error("API client not initialized");
		return this._client;
	}
	/** @internal */
	get _sessionSnapshot() {
		return this.session;
	}
	/**
	* Unique ID of this session.
	*/
	get sessionId() {
		return this.session.id;
	}
	get interactivePort() {
		return this.session.interactivePort ?? void 0;
	}
	/**
	* The status of this session.
	*/
	get status() {
		return this.session.status;
	}
	/**
	* The creation date of this session.
	*/
	get createdAt() {
		return new Date(this.session.createdAt);
	}
	/**
	* The timeout of this session in milliseconds.
	*/
	get timeout() {
		return this.session.timeout;
	}
	/**
	* The network policy of this session.
	*/
	get networkPolicy() {
		return this.session.networkPolicy;
	}
	/**
	* If the session was created from a snapshot, the ID of that snapshot.
	*/
	get sourceSnapshotId() {
		return this.session.sourceSnapshotId;
	}
	/**
	* Memory allocated to this session in MB.
	*/
	get memory() {
		return this.session.memory;
	}
	/**
	* Number of vCPUs allocated to this session.
	*/
	get vcpus() {
		return this.session.vcpus;
	}
	/**
	* The region where this session is hosted.
	*/
	get region() {
		return this.session.region;
	}
	/**
	* Legacy runtime identifier, when available.
	*
	* @deprecated Use the parent sandbox's image metadata instead.
	*/
	get runtime() {
		return this.session.runtime;
	}
	/**
	* The working directory of this session.
	*/
	get cwd() {
		return this.session.cwd;
	}
	/**
	* When this session was requested.
	*/
	get requestedAt() {
		return new Date(this.session.requestedAt);
	}
	/**
	* When this session started running.
	*/
	get startedAt() {
		return this.session.startedAt != null ? new Date(this.session.startedAt) : void 0;
	}
	/**
	* When this session was requested to stop.
	*/
	get requestedStopAt() {
		return this.session.requestedStopAt != null ? new Date(this.session.requestedStopAt) : void 0;
	}
	/**
	* When this session was stopped.
	*/
	get stoppedAt() {
		return this.session.stoppedAt != null ? new Date(this.session.stoppedAt) : void 0;
	}
	/**
	* When this session was aborted.
	*/
	get abortedAt() {
		return this.session.abortedAt != null ? new Date(this.session.abortedAt) : void 0;
	}
	/**
	* The wall-clock duration of this session in milliseconds.
	*/
	get duration() {
		return this.session.duration;
	}
	/**
	* When a snapshot was requested for this session.
	*/
	get snapshottedAt() {
		return this.session.snapshottedAt != null ? new Date(this.session.snapshottedAt) : void 0;
	}
	/**
	* When this session was last updated.
	*/
	get updatedAt() {
		return new Date(this.session.updatedAt);
	}
	/**
	* The amount of active CPU used by the session. Only reported once the VM is
	* stopped.
	*/
	get activeCpuUsageMs() {
		return this.session.activeCpuDurationMs;
	}
	/**
	* The amount of network data used by the session. Only reported once the VM
	* is stopped.
	*/
	get networkTransfer() {
		return this.session.networkTransfer;
	}
	/**
	* Serialize a Session instance to plain data for @workflow/serde.
	*
	* Although Sandbox handles top-level serialization, Session needs these
	* methods so the Workflow SWC compiler can resolve the class by name.
	* The `new Session(...)` self-reference in WORKFLOW_DESERIALIZE forces
	* rolldown to preserve the class name in the compiled output.
	*/
	static [WORKFLOW_SERIALIZE](instance) {
		return {
			session: instance.session,
			routes: instance.routes
		};
	}
	static [WORKFLOW_DESERIALIZE](data) {
		return new Session({
			routes: data.routes,
			snapshot: data.session
		});
	}
	constructor(params) {
		this._client = null;
		this.routes = params.routes;
		if ("snapshot" in params) this.session = params.snapshot;
		else {
			this._client = params.client;
			this.session = toSandboxSnapshot(params.session);
		}
	}
	/** @internal */
	updateRoutes(routes) {
		this.routes = routes;
	}
	/**
	* Get a previously run command by its ID.
	*
	* @param cmdId - ID of the command to retrieve
	* @param opts - Optional parameters.
	* @param opts.signal - An AbortSignal to cancel the operation.
	* @returns A {@link Command} instance representing the command
	*/
	async getCommand(cmdId, opts) {
		"use step";
		const client = await this.ensureClient();
		const command = await client.getCommand({
			sessionId: this.session.id,
			cmdId,
			signal: opts?.signal
		});
		return new Command({
			client,
			sessionId: this.session.id,
			cmd: command.json.command
		});
	}
	async runCommand(commandOrParams, args, opts) {
		"use step";
		const client = await this.ensureClient();
		const params = typeof commandOrParams === "string" ? {
			cmd: commandOrParams,
			args,
			signal: opts?.signal,
			timeoutMs: opts?.timeoutMs
		} : commandOrParams;
		const wait = params.detached ? false : true;
		const shouldPipeLogs = Boolean(params.stdout || params.stderr);
		if (wait) {
			let stdout = "", stderr = "";
			const finished = await (await client.runCommand({
				sessionId: this.session.id,
				command: params.cmd,
				args: params.args ?? [],
				cwd: params.cwd,
				env: params.env ?? {},
				sudo: params.sudo ?? false,
				wait: true,
				logs: true,
				onLog: (log) => {
					if (log.stream === "stdout") {
						stdout += log.data;
						params.stdout?.write(log.data);
					} else {
						stderr += log.data;
						params.stderr?.write(log.data);
					}
				},
				timeout: params.timeoutMs,
				signal: params.signal
			})).finished;
			return new CommandFinished({
				client,
				sessionId: this.session.id,
				cmd: finished,
				exitCode: finished.exitCode ?? 0,
				durationMs: finished.durationMs,
				output: {
					stdout,
					stderr
				}
			});
		}
		const commandResponse = await client.runCommand({
			sessionId: this.session.id,
			command: params.cmd,
			args: params.args ?? [],
			cwd: params.cwd,
			env: params.env ?? {},
			sudo: params.sudo ?? false,
			timeout: params.timeoutMs,
			signal: params.signal
		});
		const command = new Command({
			client,
			sessionId: this.session.id,
			cmd: commandResponse.json.command
		});
		if (shouldPipeLogs) (async () => {
			try {
				for await (const log of command.logs({ signal: params.signal })) if (log.stream === "stdout") params.stdout?.write(log.data);
				else if (log.stream === "stderr") params.stderr?.write(log.data);
			} catch (err) {
				if (params.signal?.aborted) return;
				(params.stderr ?? params.stdout)?.emit("error", err);
			}
		})();
		return command;
	}
	/**
	* Create a directory in the filesystem of this session.
	*
	* @param path - Path of the directory to create
	* @param opts - Optional parameters.
	* @param opts.signal - An AbortSignal to cancel the operation.
	*/
	async mkDir(path$1, opts) {
		"use step";
		await (await this.ensureClient()).mkDir({
			sessionId: this.session.id,
			path: path$1,
			signal: opts?.signal
		});
	}
	/**
	* Open an interactive shell session. Returns the WebSocket URL and token the
	* client uses to connect to the controller-hosted PTY.
	*
	* @param opts - Optional parameters.
	* @param opts.signal - An AbortSignal to cancel the operation.
	*/
	async openInteractive(opts) {
		"use step";
		const { json } = await (await this.ensureClient()).openInteractive({
			sessionId: this.session.id,
			signal: opts?.signal
		});
		return {
			url: json.url,
			token: json.token
		};
	}
	/**
	* Read a file from the filesystem of this session as a stream.
	*
	* @param file - File to read, with path and optional cwd
	* @param opts - Optional parameters.
	* @param opts.signal - An AbortSignal to cancel the operation.
	* @returns A promise that resolves to a ReadableStream containing the file contents, or null if file not found
	*/
	async readFile(file, opts) {
		"use step";
		return (await this.ensureClient()).readFile({
			sessionId: this.session.id,
			path: file.path,
			cwd: file.cwd,
			signal: opts?.signal
		});
	}
	/**
	* Read a file from the filesystem of this session as a Buffer.
	*
	* @param file - File to read, with path and optional cwd
	* @param opts - Optional parameters.
	* @param opts.signal - An AbortSignal to cancel the operation.
	* @returns A promise that resolves to the file contents as a Buffer, or null if file not found
	*/
	async readFileToBuffer(file, opts) {
		"use step";
		const stream = await (await this.ensureClient()).readFile({
			sessionId: this.session.id,
			path: file.path,
			cwd: file.cwd,
			signal: opts?.signal
		});
		if (stream === null) return null;
		return consumeReadable(stream);
	}
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
	async downloadFile(src, dst, opts) {
		"use step";
		const client = await this.ensureClient();
		if (!src?.path) throw new Error("downloadFile: source path is required");
		if (!dst?.path) throw new Error("downloadFile: destination path is required");
		const stream = await client.readFile({
			sessionId: this.session.id,
			path: src.path,
			cwd: src.cwd,
			signal: opts?.signal
		});
		if (stream === null) return null;
		try {
			const dstPath = resolve(dst.cwd ?? "", dst.path);
			if (opts?.mkdirRecursive) await mkdir(dirname(dstPath), { recursive: true });
			await pipeline(stream, createWriteStream(dstPath), { signal: opts?.signal });
			return dstPath;
		} finally {
			stream.destroy();
		}
	}
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
	async writeFiles(files, opts) {
		"use step";
		return (await this.ensureClient()).writeFiles({
			sessionId: this.session.id,
			cwd: this.session.cwd,
			extractDir: "/",
			files,
			signal: opts?.signal
		});
	}
	/**
	* Get the public domain of a port of this session.
	*
	* @param p - Port number to resolve
	* @returns A full domain (e.g. `https://subdomain.vercel.run`)
	* @throws If the port has no associated route
	*/
	domain(p) {
		const route = this.routes.find(({ port }) => port == p);
		if (route) return `https://${route.subdomain}.vercel.run`;
		else throw new Error(`No route for port ${p}`);
	}
	/**
	* Stop this session.
	*
	* @param opts - Optional parameters.
	* @param opts.signal - An AbortSignal to cancel the operation.
	* @returns The final session state and optional sandbox metadata.
	*/
	async stop(opts) {
		"use step";
		const response = await (await this.ensureClient()).stopSession({
			sessionId: this.session.id,
			signal: opts?.signal
		});
		this.session = toSandboxSnapshot(response.json.session);
		return {
			session: this.session,
			sandbox: response.json.sandbox,
			snapshot: response.json.snapshot
		};
	}
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
	async update(params, opts) {
		"use step";
		if (params.networkPolicy !== void 0) this.session = toSandboxSnapshot((await (await this.ensureClient()).updateNetworkPolicy({
			sessionId: this.session.id,
			networkPolicy: params.networkPolicy,
			signal: opts?.signal
		})).json.session);
	}
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
	async extendTimeout(duration, opts) {
		"use step";
		this.session = toSandboxSnapshot((await (await this.ensureClient()).extendTimeout({
			sessionId: this.session.id,
			duration,
			signal: opts?.signal
		})).json.session);
	}
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
	async snapshot(opts) {
		"use step";
		const client = await this.ensureClient();
		const response = await client.createSnapshot({
			sessionId: this.session.id,
			expiration: opts?.expiration,
			signal: opts?.signal
		});
		this.session = toSandboxSnapshot(response.json.session);
		return new Snapshot({
			client,
			snapshot: response.json.snapshot
		});
	}
};

//#endregion
export { Session };
//# sourceMappingURL=session.js.map