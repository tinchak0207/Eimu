import * as constants from "node:constants";

//#region src/filesystem.ts
const { S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFBLK, S_IFCHR, S_IFIFO, S_IFSOCK } = constants;
const UV_DIRENT_FILE = 1;
const UV_DIRENT_DIR = 2;
const UV_DIRENT_LINK = 3;
const UV_DIRENT_FIFO = 4;
const UV_DIRENT_SOCKET = 5;
const UV_DIRENT_CHAR = 6;
const UV_DIRENT_BLOCK = 7;
function fsError(code, message, syscall, path) {
	const err = /* @__PURE__ */ new Error(`${code}: ${message}, ${syscall} '${path}'`);
	err.code = code;
	err.syscall = syscall;
	err.path = path;
	return err;
}
function parseEncoding(options) {
	if (options === null || options === void 0) return { encoding: null };
	if (typeof options === "string") return { encoding: options };
	return {
		encoding: options.encoding ?? null,
		signal: options.signal
	};
}
var SandboxStats = class {
	constructor(dev, _mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs) {
		this.dev = dev;
		this._mode = _mode;
		this.nlink = nlink;
		this.uid = uid;
		this.gid = gid;
		this.rdev = rdev;
		this.blksize = blksize;
		this.ino = ino;
		this.size = size;
		this.blocks = blocks;
		this.atimeMs = atimeMs;
		this.mtimeMs = mtimeMs;
		this.ctimeMs = ctimeMs;
		this.birthtimeMs = birthtimeMs;
		this.atime = new Date(atimeMs);
		this.mtime = new Date(mtimeMs);
		this.ctime = new Date(ctimeMs);
		this.birthtime = new Date(birthtimeMs);
	}
	get mode() {
		return this._mode;
	}
	isFile() {
		return (this.mode & S_IFMT) === S_IFREG;
	}
	isDirectory() {
		return (this.mode & S_IFMT) === S_IFDIR;
	}
	isBlockDevice() {
		return (this.mode & S_IFMT) === S_IFBLK;
	}
	isCharacterDevice() {
		return (this.mode & S_IFMT) === S_IFCHR;
	}
	isSymbolicLink() {
		return (this.mode & S_IFMT) === S_IFLNK;
	}
	isFIFO() {
		return (this.mode & S_IFMT) === S_IFIFO;
	}
	isSocket() {
		return (this.mode & S_IFMT) === S_IFSOCK;
	}
};
var SandboxDirent = class {
	constructor(name, type, parentPath) {
		this.name = name;
		this.type = type;
		this.parentPath = parentPath;
		this.path = `${this.parentPath}/${this.name}`;
	}
	isFile() {
		return this.type === UV_DIRENT_FILE;
	}
	isDirectory() {
		return this.type === UV_DIRENT_DIR;
	}
	isBlockDevice() {
		return this.type === UV_DIRENT_BLOCK;
	}
	isCharacterDevice() {
		return this.type === UV_DIRENT_CHAR;
	}
	isSymbolicLink() {
		return this.type === UV_DIRENT_LINK;
	}
	isFIFO() {
		return this.type === UV_DIRENT_FIFO;
	}
	isSocket() {
		return this.type === UV_DIRENT_SOCKET;
	}
};
function parseStat(stdout) {
	const parts = stdout.trim().split("|");
	return new SandboxStats(parseInt(parts[10], 10), parseInt(parts[1], 16), parseInt(parts[8], 10), parseInt(parts[2], 10), parseInt(parts[3], 10), 0, parseInt(parts[11], 10), parseInt(parts[9], 10), parseInt(parts[0], 10), parseInt(parts[12], 10), parseFloat(parts[4]) * 1e3, parseFloat(parts[5]) * 1e3, parseFloat(parts[6]) * 1e3, parseFloat(parts[7]) * 1e3);
}
function parseDirent(stdout, path) {
	const parts = stdout.trim().split("|");
	const name = parts[0];
	const type = parts[1];
	if (!name) throw fsError("ENOENT", "no such file or directory", "readdir", path);
	if (!type) throw new Error(`Invalid dirent type: ${type}`);
	return new SandboxDirent(name, FIND_TYPE_TO_DIRENT[type] ?? UV_DIRENT_FILE, path);
}
const STAT_FORMAT = "%s|%f|%u|%g|%X|%Y|%Z|%W|%h|%i|%d|%B|%b";
const FIND_TYPE_TO_DIRENT = {
	f: UV_DIRENT_FILE,
	d: UV_DIRENT_DIR,
	l: UV_DIRENT_LINK,
	b: UV_DIRENT_BLOCK,
	c: UV_DIRENT_CHAR,
	p: UV_DIRENT_FIFO,
	s: UV_DIRENT_SOCKET
};
var FileSystem = class {
	/** @internal */
	constructor(sandbox) {
		this.sandbox = sandbox;
	}
	async readFile(path, options) {
		"use step";
		const { encoding, signal } = parseEncoding(options);
		const buffer = await this.sandbox.readFileToBuffer({ path }, { signal });
		if (buffer === null) throw fsError("ENOENT", "no such file or directory", "open", path);
		return encoding ? buffer.toString(encoding) : buffer;
	}
	/**
	* Write data to a file, replacing the file if it already exists.
	*
	* @param path - Path to the file
	* @param data - The data to write
	* @param options - Write options
	*/
	async writeFile(path, data, options) {
		"use step";
		const { encoding, signal } = typeof options === "string" ? {
			encoding: options,
			signal: void 0
		} : {
			encoding: options?.encoding,
			signal: options?.signal
		};
		let content;
		if (typeof data === "string") content = Buffer.from(data, encoding ?? "utf8");
		else if (Buffer.isBuffer(data)) content = data;
		else content = Buffer.from(data);
		await this.sandbox.writeFiles([{
			path,
			content
		}], { signal });
	}
	/**
	* Append data to a file, creating the file if it does not yet exist.
	*
	* @param path - Path to the file
	* @param data - The data to append
	* @param options - Write options
	*/
	async appendFile(path, data, options) {
		"use step";
		const { encoding, signal } = typeof options === "string" ? {
			encoding: options,
			signal: void 0
		} : {
			encoding: options?.encoding,
			signal: options?.signal
		};
		let appendContent;
		if (typeof data === "string") appendContent = Buffer.from(data, encoding ?? "utf8");
		else if (Buffer.isBuffer(data)) appendContent = data;
		else appendContent = Buffer.from(data);
		const existing = await this.sandbox.readFileToBuffer({ path }, { signal });
		const content = existing !== null ? Buffer.concat([existing, appendContent]) : appendContent;
		await this.sandbox.writeFiles([{
			path,
			content
		}], { signal });
	}
	/**
	* Create a directory.
	*
	* @param path - Path of the directory to create
	* @param options - Options for directory creation
	*/
	async mkdir(path, options) {
		"use step";
		const opts = typeof options === "number" ? { recursive: false } : options ?? {};
		if (opts.recursive) {
			const result = await this.sandbox.runCommand("mkdir", ["-p", path], { signal: opts.signal });
			if (result.exitCode !== 0) throw fsError("EACCES", (await result.stderr()).trim() || "permission denied", "mkdir", path);
			return;
		}
		await this.sandbox.mkDir(path, { signal: opts.signal });
	}
	async readdir(path, options) {
		"use step";
		if (options?.withFileTypes) {
			const result$1 = await this.sandbox.runCommand("find", [
				path,
				"-maxdepth",
				"1",
				"-mindepth",
				"1",
				"-printf",
				"%f|%y\\n"
			], { signal: options?.signal });
			if (result$1.exitCode !== 0) {
				const stderr = await result$1.stderr();
				if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "scandir", path);
				throw fsError("EACCES", stderr.trim(), "scandir", path);
			}
			return (await result$1.stdout()).trim().split("\n").filter(Boolean).map((line) => parseDirent(line, path));
		}
		const result = await this.sandbox.runCommand("ls", ["-1", path], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "scandir", path);
			throw fsError("EACCES", stderr.trim(), "scandir", path);
		}
		return (await result.stdout()).trim().split("\n").filter(Boolean);
	}
	/**
	* Get file status. Follows symbolic links.
	*
	* @param path - Path to the file
	* @param options - Options
	*/
	async stat(path, options) {
		"use step";
		const result = await this.sandbox.runCommand("stat", [
			"-L",
			"-c",
			STAT_FORMAT,
			path
		], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "stat", path);
			throw fsError("EACCES", stderr.trim(), "stat", path);
		}
		return parseStat(await result.stdout());
	}
	/**
	* Get file status. Does not follow symbolic links.
	*
	* @param path - Path to the file
	* @param options - Options
	*/
	async lstat(path, options) {
		"use step";
		const result = await this.sandbox.runCommand("stat", [
			"-c",
			STAT_FORMAT,
			path
		], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "lstat", path);
			throw fsError("EACCES", stderr.trim(), "lstat", path);
		}
		return parseStat(await result.stdout());
	}
	/**
	* Remove a file or symbolic link.
	*
	* @param path - Path to the file
	* @param options - Options
	*/
	async unlink(path, options) {
		"use step";
		const result = await this.sandbox.runCommand("rm", [path], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "unlink", path);
			throw fsError("EACCES", stderr.trim(), "unlink", path);
		}
	}
	/**
	* Remove files and directories.
	*
	* @param path - Path to remove
	* @param options - Options
	*/
	async rm(path, options) {
		"use step";
		const args = [];
		if (options?.recursive) args.push("-r");
		if (options?.force) args.push("-f");
		args.push(path);
		const result = await this.sandbox.runCommand("rm", args, { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "rm", path);
			throw fsError("EACCES", stderr.trim(), "rm", path);
		}
	}
	/**
	* Remove a directory.
	*
	* @param path - Path to the directory
	* @param options - Options
	*/
	async rmdir(path, options) {
		"use step";
		const result = await this.sandbox.runCommand("rmdir", [path], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "rmdir", path);
			if (stderr.includes("not empty")) throw fsError("ENOTEMPTY", "directory not empty", "rmdir", path);
			throw fsError("EACCES", stderr.trim(), "rmdir", path);
		}
	}
	/**
	* Rename a file or directory.
	*
	* @param oldPath - Current path
	* @param newPath - New path
	* @param options - Options
	*/
	async rename(oldPath, newPath, options) {
		"use step";
		const result = await this.sandbox.runCommand("mv", [oldPath, newPath], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "rename", oldPath);
			throw fsError("EACCES", stderr.trim(), "rename", oldPath);
		}
	}
	/**
	* Copy a file.
	*
	* @param src - Source path
	* @param dest - Destination path
	* @param options - Options
	*/
	async copyFile(src, dest, options) {
		"use step";
		const result = await this.sandbox.runCommand("cp", [src, dest], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "copyfile", src);
			throw fsError("EACCES", stderr.trim(), "copyfile", src);
		}
	}
	/**
	* Test whether a file exists and the user has the specified permissions.
	*
	* @param path - Path to the file
	* @param options - Options
	*/
	async access(path, options) {
		"use step";
		if ((await this.sandbox.runCommand("test", ["-e", path], { signal: options?.signal })).exitCode !== 0) throw fsError("ENOENT", "no such file or directory", "access", path);
	}
	/**
	* Check if a path exists.
	*
	* This is a convenience method not in `node:fs/promises` but commonly needed.
	*
	* @param path - Path to check
	* @param options - Options
	*/
	async exists(path, options) {
		return (await this.sandbox.runCommand("test", ["-e", path], { signal: options?.signal })).exitCode === 0;
	}
	/**
	* Change file mode (permissions).
	*
	* @param path - Path to the file
	* @param mode - File mode (e.g., 0o755 or "755")
	* @param options - Options
	*/
	async chmod(path, mode, options) {
		"use step";
		const modeStr = typeof mode === "number" ? mode.toString(8) : mode;
		const result = await this.sandbox.runCommand("chmod", [modeStr, path], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "chmod", path);
			throw fsError("EACCES", stderr.trim(), "chmod", path);
		}
	}
	/**
	* Change file owner and group.
	*
	* @param path - Path to the file
	* @param uid - User ID
	* @param gid - Group ID
	* @param options - Options
	*/
	async chown(path, uid, gid, options) {
		"use step";
		const result = await this.sandbox.runCommand("chown", [`${uid}:${gid}`, path], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "chown", path);
			throw fsError("EACCES", stderr.trim(), "chown", path);
		}
	}
	/**
	* Create a symbolic link.
	*
	* @param target - The target of the symbolic link
	* @param path - The path of the symbolic link to create
	* @param options - Options
	*/
	async symlink(target, path, options) {
		"use step";
		const result = await this.sandbox.runCommand("ln", [
			"-s",
			target,
			path
		], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("File exists")) throw fsError("EEXIST", "file already exists", "symlink", path);
			throw fsError("EACCES", stderr.trim(), "symlink", path);
		}
	}
	/**
	* Read the value of a symbolic link.
	*
	* @param path - Path to the symbolic link
	* @param options - Options
	*/
	async readlink(path, options) {
		"use step";
		const result = await this.sandbox.runCommand("readlink", [path], { signal: options?.signal });
		if (result.exitCode !== 0) {
			if ((await result.stderr()).includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "readlink", path);
			throw fsError("EINVAL", "invalid argument", "readlink", path);
		}
		return (await result.stdout()).trim();
	}
	/**
	* Resolve the real path of a file (resolving symlinks).
	*
	* @param path - Path to resolve
	* @param options - Options
	*/
	async realpath(path, options) {
		"use step";
		const result = await this.sandbox.runCommand("realpath", [path], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "realpath", path);
			throw fsError("EACCES", stderr.trim(), "realpath", path);
		}
		return (await result.stdout()).trim();
	}
	/**
	* Truncate a file to a specified length.
	*
	* @param path - Path to the file
	* @param len - Length to truncate to (default: 0)
	* @param options - Options
	*/
	async truncate(path, len, options) {
		"use step";
		const result = await this.sandbox.runCommand("truncate", [
			"-s",
			String(len ?? 0),
			path
		], { signal: options?.signal });
		if (result.exitCode !== 0) {
			const stderr = await result.stderr();
			if (stderr.includes("No such file or directory")) throw fsError("ENOENT", "no such file or directory", "truncate", path);
			throw fsError("EACCES", stderr.trim(), "truncate", path);
		}
	}
	/**
	* Create a unique temporary directory.
	*
	* @param prefix - The prefix for the temporary directory name
	* @param options - Options
	* @returns The path of the created temporary directory
	*/
	async mkdtemp(prefix, options) {
		"use step";
		const result = await this.sandbox.runCommand("mktemp", ["-d", `${prefix}XXXXXX`], { signal: options?.signal });
		if (result.exitCode !== 0) throw fsError("EACCES", (await result.stderr()).trim(), "mkdtemp", prefix);
		return (await result.stdout()).trim();
	}
};

//#endregion
export { FileSystem };
//# sourceMappingURL=filesystem.js.map