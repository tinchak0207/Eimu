import zlib from "zlib";
import tar from "tar-stream";
import { Readable } from "stream";

//#region src/api-client/file-writer.ts
/**
* Allows to create a Readable stream with methods to write files
* to it and to finish it. Files written are compressed together
* and gzipped in the stream.
*/
var FileWriter = class {
	constructor() {
		const gzip = zlib.createGzip();
		this.pack = tar.pack();
		this.readable = this.pack.pipe(gzip);
	}
	/**
	* Allows to add a file to the stream. Size is required to write
	* the tarball header so when content is a stream it must be
	* provided.
	*
	* Returns a Promise resolved once the file is written in the
	* stream.
	*/
	async addFile(file) {
		return new Promise((resolve, reject) => {
			const entry = this.pack.entry("size" in file ? {
				name: file.name,
				size: file.size,
				mode: file.mode
			} : {
				name: file.name,
				size: Buffer.byteLength(file.content),
				mode: file.mode
			}, (error) => {
				if (error) return reject(error);
				else resolve();
			});
			if (file.content instanceof Readable) file.content.pipe(entry);
			else entry.end(file.content);
		});
	}
	/**
	* Allows to finish the stream returning a Promise that will
	* resolve once the readable is effectively closed or
	* errored.
	*/
	async end() {
		return new Promise((resolve, reject) => {
			this.readable.on("error", reject);
			this.readable.on("end", resolve);
			this.pack.finalize();
		});
	}
};

//#endregion
export { FileWriter };
//# sourceMappingURL=file-writer.js.map