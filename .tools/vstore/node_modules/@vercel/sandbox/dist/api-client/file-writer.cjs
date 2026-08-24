const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
let zlib = require("zlib");
zlib = require_rolldown_runtime.__toESM(zlib);
let tar_stream = require("tar-stream");
tar_stream = require_rolldown_runtime.__toESM(tar_stream);
let stream = require("stream");

//#region src/api-client/file-writer.ts
/**
* Allows to create a Readable stream with methods to write files
* to it and to finish it. Files written are compressed together
* and gzipped in the stream.
*/
var FileWriter = class {
	constructor() {
		const gzip = zlib.default.createGzip();
		this.pack = tar_stream.default.pack();
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
			if (file.content instanceof stream.Readable) file.content.pipe(entry);
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
exports.FileWriter = FileWriter;
//# sourceMappingURL=file-writer.cjs.map