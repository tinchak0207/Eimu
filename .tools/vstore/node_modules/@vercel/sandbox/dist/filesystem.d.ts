import { Dirent, Stats } from "fs";

//#region src/filesystem.d.ts
type WriteFileData = string | Buffer | Uint8Array;
interface MkdirOptions {
  recursive?: boolean;
  signal?: AbortSignal;
}
interface RmOptions {
  recursive?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}
interface SandboxHandle {
  readFileToBuffer(file: {
    path: string;
  }, opts?: {
    signal?: AbortSignal;
  }): Promise<Buffer | null>;
  writeFiles(files: {
    path: string;
    content: Buffer;
  }[], opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  mkDir(path: string, opts?: {
    signal?: AbortSignal;
  }): Promise<void>;
  runCommand(cmd: string, args?: string[], opts?: {
    signal?: AbortSignal;
  }): Promise<{
    exitCode: number;
    stdout(opts?: {
      signal?: AbortSignal;
    }): Promise<string>;
    stderr(opts?: {
      signal?: AbortSignal;
    }): Promise<string>;
  }>;
}
declare class FileSystem {
  /** @internal */
  private sandbox;
  /** @internal */
  constructor(sandbox: SandboxHandle);
  /**
   * Read the entire contents of a file.
   *
   * @param path - Path to the file
   * @param options - Encoding or options object. If encoding is specified, returns a string; otherwise returns a Buffer.
   */
  readFile(path: string, options?: {
    encoding?: null;
    signal?: AbortSignal;
  } | null): Promise<Buffer>;
  readFile(path: string, options: {
    encoding: BufferEncoding;
    signal?: AbortSignal;
  } | BufferEncoding): Promise<string>;
  /**
   * Write data to a file, replacing the file if it already exists.
   *
   * @param path - Path to the file
   * @param data - The data to write
   * @param options - Write options
   */
  writeFile(path: string, data: WriteFileData, options?: {
    encoding?: BufferEncoding;
    signal?: AbortSignal;
  } | BufferEncoding): Promise<void>;
  /**
   * Append data to a file, creating the file if it does not yet exist.
   *
   * @param path - Path to the file
   * @param data - The data to append
   * @param options - Write options
   */
  appendFile(path: string, data: WriteFileData, options?: {
    encoding?: BufferEncoding;
    signal?: AbortSignal;
  } | BufferEncoding): Promise<void>;
  /**
   * Create a directory.
   *
   * @param path - Path of the directory to create
   * @param options - Options for directory creation
   */
  mkdir(path: string, options?: MkdirOptions | number): Promise<string | undefined>;
  /**
   * Read the contents of a directory.
   *
   * @param path - Path to the directory
   * @param options - Options. When `withFileTypes` is true, returns `Dirent` objects.
   */
  readdir(path: string, options?: {
    signal?: AbortSignal;
    withFileTypes?: false;
  }): Promise<string[]>;
  readdir(path: string, options: {
    signal?: AbortSignal;
    withFileTypes: true;
  }): Promise<Dirent[]>;
  /**
   * Get file status. Follows symbolic links.
   *
   * @param path - Path to the file
   * @param options - Options
   */
  stat(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<Stats>;
  /**
   * Get file status. Does not follow symbolic links.
   *
   * @param path - Path to the file
   * @param options - Options
   */
  lstat(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<Stats>;
  /**
   * Remove a file or symbolic link.
   *
   * @param path - Path to the file
   * @param options - Options
   */
  unlink(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Remove files and directories.
   *
   * @param path - Path to remove
   * @param options - Options
   */
  rm(path: string, options?: RmOptions): Promise<void>;
  /**
   * Remove a directory.
   *
   * @param path - Path to the directory
   * @param options - Options
   */
  rmdir(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Rename a file or directory.
   *
   * @param oldPath - Current path
   * @param newPath - New path
   * @param options - Options
   */
  rename(oldPath: string, newPath: string, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Copy a file.
   *
   * @param src - Source path
   * @param dest - Destination path
   * @param options - Options
   */
  copyFile(src: string, dest: string, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Test whether a file exists and the user has the specified permissions.
   *
   * @param path - Path to the file
   * @param options - Options
   */
  access(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Check if a path exists.
   *
   * This is a convenience method not in `node:fs/promises` but commonly needed.
   *
   * @param path - Path to check
   * @param options - Options
   */
  exists(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<boolean>;
  /**
   * Change file mode (permissions).
   *
   * @param path - Path to the file
   * @param mode - File mode (e.g., 0o755 or "755")
   * @param options - Options
   */
  chmod(path: string, mode: number | string, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Change file owner and group.
   *
   * @param path - Path to the file
   * @param uid - User ID
   * @param gid - Group ID
   * @param options - Options
   */
  chown(path: string, uid: number, gid: number, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Create a symbolic link.
   *
   * @param target - The target of the symbolic link
   * @param path - The path of the symbolic link to create
   * @param options - Options
   */
  symlink(target: string, path: string, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Read the value of a symbolic link.
   *
   * @param path - Path to the symbolic link
   * @param options - Options
   */
  readlink(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<string>;
  /**
   * Resolve the real path of a file (resolving symlinks).
   *
   * @param path - Path to resolve
   * @param options - Options
   */
  realpath(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<string>;
  /**
   * Truncate a file to a specified length.
   *
   * @param path - Path to the file
   * @param len - Length to truncate to (default: 0)
   * @param options - Options
   */
  truncate(path: string, len?: number, options?: {
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Create a unique temporary directory.
   *
   * @param prefix - The prefix for the temporary directory name
   * @param options - Options
   * @returns The path of the created temporary directory
   */
  mkdtemp(prefix: string, options?: {
    signal?: AbortSignal;
  }): Promise<string>;
}
//#endregion
export { FileSystem };
//# sourceMappingURL=filesystem.d.ts.map