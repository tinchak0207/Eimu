const require_rolldown_runtime = require('./_virtual/rolldown_runtime.cjs');
const require_validate_name = require('./utils/validate-name.cjs');
let stream = require("stream");
let path = require("path");
let stream_promises = require("stream/promises");
let fs = require("fs");
let fs_promises = require("fs/promises");

//#region src/sandbox-user.ts
/**
* Thrown when {@link Sandbox.createUser} is called for an existing username.
*/
var SandboxUserAlreadyExistsError = class extends Error {
	constructor(username) {
		super(`Failed to create user "${username}": user already exists`);
		this.name = "SandboxUserAlreadyExistsError";
		this.username = username;
	}
};
/**
* A user context within a sandbox.
*
* All file and command operations default to running as this user.
* Created via {@link Sandbox.createUser} or {@link Sandbox.asUser}.
*
* @hideconstructor
*/
var SandboxUser = class {
	constructor({ sandbox, username }) {
		this.sandbox = sandbox;
		this.username = username;
		this.homeDir = username === "root" ? "/root" : `/home/${username}`;
	}
	/**
	* Build the wrapped command args to run as this user via `sudo -u`.
	*
	* When `env` is provided, injects `env KEY=VAL ...` so that environment
	* variables survive the `sudo -u` transition.
	*/
	buildUserCommand(params) {
		const envEntries = Object.entries(params.env ?? {});
		const envArgs = envEntries.length > 0 ? ["env", ...envEntries.map(([k, v]) => `${k}=${v}`)] : [];
		const cwd = params.cwd ?? this.homeDir;
		return {
			cmd: "sudo",
			args: [
				"-u",
				this.username,
				"--",
				"bash",
				"-c",
				"cd \"$1\" || exit 1; shift; exec \"$@\"",
				"bash",
				cwd,
				...envArgs,
				params.cmd,
				...params.args ?? []
			]
		};
	}
	/**
	* Resolve a path relative to this user's home directory.
	* Absolute paths are returned as-is.
	*/
	resolvePath(path$1) {
		return path$1.startsWith("/") ? path$1 : `${this.homeDir}/${path$1}`;
	}
	async runCommand(commandOrParams, args, opts) {
		if (typeof commandOrParams === "string") {
			const wrapped$1 = this.buildUserCommand({
				cmd: commandOrParams,
				args
			});
			return this.sandbox.runCommand({
				...wrapped$1,
				signal: opts?.signal,
				timeoutMs: opts?.timeoutMs
			});
		}
		const params = commandOrParams;
		if (params.sudo) return this.sandbox.runCommand({ ...params });
		const wrapped = this.buildUserCommand({
			cmd: params.cmd,
			args: params.args,
			env: params.env,
			cwd: params.cwd
		});
		return this.sandbox.runCommand({
			cmd: wrapped.cmd,
			args: wrapped.args,
			detached: params.detached,
			stdout: params.stdout,
			stderr: params.stderr,
			signal: params.signal,
			timeoutMs: params.timeoutMs
		});
	}
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
	async writeFiles(files, opts) {
		const absoluteFiles = files.map((f) => ({
			...f,
			path: this.resolvePath(f.path)
		}));
		await this.sandbox.writeFiles(absoluteFiles, opts);
		const paths = absoluteFiles.map((f) => f.path);
		if (paths.length === 0) return;
		await this.chownOrThrow(paths, `${this.username}:${await this.primaryGroup(opts?.signal)}`, opts?.signal);
		const dirs = this.ancestorDirsUnderHome(paths);
		if (dirs.length > 0) {
			const { group } = await this.sandbox.getDefaultUser(opts);
			await this.chownOrThrow(dirs, `${this.username}:${group}`, opts?.signal);
			await this.chmodOrThrow(dirs, "770", opts?.signal);
		}
	}
	/**
	* Read a file from this user's context as a stream.
	*
	* @param file - File to read, with path and optional cwd
	* @param opts - Optional parameters.
	* @returns A ReadableStream of the file contents, or null if not found
	*/
	async readFile(file, opts) {
		"use step";
		const buffer = await this.catAsUser(file, opts);
		return buffer === null ? null : stream.Readable.from([buffer]);
	}
	/**
	* Read a file from this user's context as a Buffer.
	*
	* @param file - File to read, with path and optional cwd
	* @param opts - Optional parameters.
	* @returns The file contents as a Buffer, or null if not found
	*/
	async readFileToBuffer(file, opts) {
		return this.catAsUser(file, opts);
	}
	/**
	* Download a file from this user's context to the local filesystem.
	*
	* @param src - Source file in the sandbox
	* @param dst - Destination on the local machine
	* @param opts - Optional parameters.
	* @returns The absolute path to the written file, or null if not found
	*/
	async downloadFile(src, dst, opts) {
		"use step";
		const stream$1 = await this.readFile(src, opts);
		if (stream$1 === null) return null;
		const dstPath = (0, path.resolve)(dst.cwd ?? "", dst.path);
		if (opts?.mkdirRecursive) await (0, fs_promises.mkdir)((0, path.dirname)(dstPath), { recursive: true });
		await (0, stream_promises.pipeline)(stream$1, (0, fs.createWriteStream)(dstPath), { signal: opts?.signal });
		return dstPath;
	}
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
	async catAsUser(file, opts) {
		const path$1 = file.path.startsWith("/") ? file.path : `${file.cwd ?? this.homeDir}/${file.path}`;
		const result = await this.runCommand({
			cmd: "base64",
			args: [path$1],
			signal: opts?.signal
		});
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (/No such file or directory/i.test(stderr)) return null;
			throw new Error(`Failed to read ${path$1}: ${stderr}`);
		}
		return Buffer.from(await result.stdout(), "base64");
	}
	/**
	* Create a directory owned by this user.
	*
	* @param path - Path of the directory to create
	* @param opts - Optional parameters.
	*/
	async mkDir(path$1, opts) {
		const absPath = this.resolvePath(path$1);
		await this.sandbox.mkDir(absPath, opts);
		const dirs = [absPath, ...this.ancestorDirsUnderHome([absPath])];
		const { group } = await this.sandbox.getDefaultUser(opts);
		await this.chownOrThrow(dirs, `${this.username}:${group}`, opts?.signal);
		await this.chmodOrThrow(dirs, "770", opts?.signal);
	}
	/**
	* This user's primary group. Users created via {@link Sandbox.createUser}
	* get a group named after them, but {@link Sandbox.asUser} accepts
	* pre-existing users whose primary group can differ (e.g. system users), so
	* we resolve it from the sandbox rather than assuming `<username>`.
	*
	* The result is memoized for the lifetime of this instance.
	*/
	primaryGroup(signal) {
		if (!this.primaryGroupPromise) this.primaryGroupPromise = this.resolvePrimaryGroup(signal).catch((err) => {
			this.primaryGroupPromise = void 0;
			throw err;
		});
		return this.primaryGroupPromise;
	}
	async resolvePrimaryGroup(signal) {
		const result = await this.sandbox.runCommand({
			cmd: "id",
			args: ["-gn", this.username],
			signal
		});
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			throw new Error(`Failed to resolve the primary group of "${this.username}": ${stderr}`);
		}
		const group = (await result.stdout()).trim();
		if (!group) throw new Error(`Failed to resolve the primary group of "${this.username}"`);
		return group;
	}
	/**
	* Run `chown <ownership> <paths...>` as root, throwing on failure.
	*/
	async chownOrThrow(paths, ownership, signal) {
		const chown = await this.sandbox.runCommand({
			cmd: "chown",
			args: [ownership, ...paths],
			sudo: true,
			signal
		});
		if (chown.exitCode !== 0) {
			const stderr = await chown.stderr();
			throw new Error(`Failed to set ownership on ${paths.join(", ")}: ${stderr}`);
		}
	}
	/**
	* Run `chmod <mode> <paths...>` as root, throwing on failure.
	*/
	async chmodOrThrow(paths, mode, signal) {
		const chmod = await this.sandbox.runCommand({
			cmd: "chmod",
			args: [mode, ...paths],
			sudo: true,
			signal
		});
		if (chmod.exitCode !== 0) {
			const stderr = await chmod.stderr();
			throw new Error(`Failed to set permissions on ${paths.join(", ")}: ${stderr}`);
		}
	}
	/**
	* Given absolute leaf paths, return the directories strictly between this
	* user's home directory and each leaf. The home dir itself is excluded, as
	* are any paths that fall outside the home dir.
	*/
	ancestorDirsUnderHome(paths) {
		const dirs = /* @__PURE__ */ new Set();
		const homePrefix = `${this.homeDir}/`;
		for (const p of paths) {
			let dir = p.slice(0, p.lastIndexOf("/"));
			while (dir.length > this.homeDir.length && dir.startsWith(homePrefix)) {
				dirs.add(dir);
				dir = dir.slice(0, dir.lastIndexOf("/"));
			}
		}
		return [...dirs];
	}
	/**
	* Add this user to a group.
	*
	* @param groupname - Name of the group to join
	* @param opts - Optional parameters.
	*/
	async addToGroup(groupname, opts) {
		require_validate_name.validateName(groupname, "group name");
		await this.sandbox.addUserToGroup(this.username, groupname, opts);
	}
	/**
	* Remove this user from a group.
	*
	* @param groupname - Name of the group to leave
	* @param opts - Optional parameters.
	*/
	async removeFromGroup(groupname, opts) {
		require_validate_name.validateName(groupname, "group name");
		await this.sandbox.removeUserFromGroup(this.username, groupname, opts);
	}
};

//#endregion
exports.SandboxUser = SandboxUser;
exports.SandboxUserAlreadyExistsError = SandboxUserAlreadyExistsError;
//# sourceMappingURL=sandbox-user.cjs.map