"use strict";Object.defineProperty(exports, "__esModule", {value: true});




































var _chunkQMTUXFZHcjs = require('./chunk-QMTUXFZH.cjs');

// src/del.ts
async function del(urlOrPathname, options) {
  const urls = Array.isArray(urlOrPathname) ? urlOrPathname : [urlOrPathname];
  if ((options == null ? void 0 : options.ifMatch) && urls.length > 1) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("ifMatch can only be used when deleting a single URL.");
  }
  const headers = {
    "content-type": "application/json"
  };
  if (options == null ? void 0 : options.ifMatch) {
    headers["x-if-match"] = options.ifMatch;
  }
  await _chunkQMTUXFZHcjs.requestApi.call(void 0, 
    "/delete",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ urls }),
      signal: options == null ? void 0 : options.abortSignal
    },
    options
  );
}

// src/head.ts
async function head(urlOrPathname, options) {
  const searchParams = new URLSearchParams({ url: urlOrPathname });
  const response = await _chunkQMTUXFZHcjs.requestApi.call(void 0, 
    `?${searchParams.toString()}`,
    // HEAD can't have body as a response, so we use GET
    {
      method: "GET",
      signal: options == null ? void 0 : options.abortSignal
    },
    options
  );
  return {
    url: response.url,
    downloadUrl: response.downloadUrl,
    pathname: response.pathname,
    size: response.size,
    contentType: response.contentType,
    contentDisposition: response.contentDisposition,
    cacheControl: response.cacheControl,
    uploadedAt: new Date(response.uploadedAt),
    etag: response.etag
  };
}

// src/get.ts
var _undici = require('undici');
function extractPathnameFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.pathname.slice(1);
  } catch (e) {
    return url;
  }
}
async function get(urlOrPathname, options) {
  if (!urlOrPathname) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("url or pathname is required");
  }
  if (!options) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("missing options, see usage");
  }
  if (options.access !== "public" && options.access !== "private") {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)(
      'access must be "private" or "public", see https://vercel.com/docs/vercel-blob'
    );
  }
  const auth = await _chunkQMTUXFZHcjs.resolveBlobAuth.call(void 0, options);
  if (auth.kind === "presigned") {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("Presigned URLs are not supported for the get method");
  }
  let blobUrl;
  let pathname;
  const access = options.access;
  if (_chunkQMTUXFZHcjs.isUrl.call(void 0, urlOrPathname)) {
    blobUrl = urlOrPathname;
    pathname = extractPathnameFromUrl(urlOrPathname);
    try {
      const { hostname } = new URL(blobUrl);
      if (!hostname.endsWith(".blob.vercel-storage.com")) {
        throw new (0, _chunkQMTUXFZHcjs.BlobError)(
          "Invalid URL: the URL does not point to a Vercel Blob store. Use a pathname instead, see https://vercel.com/docs/vercel-blob"
        );
      }
    } catch (error) {
      if (error instanceof _chunkQMTUXFZHcjs.BlobError) throw error;
      throw new (0, _chunkQMTUXFZHcjs.BlobError)("Invalid URL: unable to parse the provided URL");
    }
  } else {
    if (!auth.storeId) {
      throw new (0, _chunkQMTUXFZHcjs.BlobError)("Invalid token: unable to extract store ID");
    }
    pathname = urlOrPathname;
    blobUrl = _chunkQMTUXFZHcjs.constructBlobUrl.call(void 0, auth.storeId, pathname, access);
  }
  const requestHeaders = {
    ...options.ifNoneMatch ? { "If-None-Match": options.ifNoneMatch } : {},
    authorization: `Bearer ${auth.token}`,
    ...options.headers
    // low-level escape hatch, applied last to override anything
  };
  let fetchUrl = blobUrl;
  if (options.useCache === false && access === "private") {
    const url = new URL(blobUrl);
    url.searchParams.set("cache", "0");
    fetchUrl = url.toString();
  }
  const response = await _undici.fetch.call(void 0, fetchUrl, {
    method: "GET",
    headers: requestHeaders,
    signal: options.abortSignal
  });
  if (response.status === 304) {
    const downloadUrlObj = new URL(blobUrl);
    downloadUrlObj.searchParams.set("download", "1");
    const lastModified2 = response.headers.get("last-modified");
    return {
      statusCode: 304,
      stream: null,
      headers: response.headers,
      blob: {
        url: blobUrl,
        downloadUrl: downloadUrlObj.toString(),
        pathname,
        contentType: null,
        contentDisposition: response.headers.get("content-disposition") || "",
        cacheControl: response.headers.get("cache-control") || "",
        size: null,
        uploadedAt: lastModified2 ? new Date(lastModified2) : /* @__PURE__ */ new Date(),
        etag: response.headers.get("etag") || ""
      }
    };
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)(
      `Failed to fetch blob: ${response.status} ${response.statusText}`
    );
  }
  const stream = response.body;
  if (!stream) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("Response body is null");
  }
  const contentLength = response.headers.get("content-length");
  const lastModified = response.headers.get("last-modified");
  const downloadUrl = new URL(blobUrl);
  downloadUrl.searchParams.set("download", "1");
  return {
    statusCode: 200,
    stream,
    headers: response.headers,
    blob: {
      url: blobUrl,
      downloadUrl: downloadUrl.toString(),
      pathname,
      contentType: response.headers.get("content-type") || "application/octet-stream",
      contentDisposition: response.headers.get("content-disposition") || "",
      cacheControl: response.headers.get("cache-control") || "",
      size: contentLength ? parseInt(contentLength, 10) : 0,
      uploadedAt: lastModified ? new Date(lastModified) : /* @__PURE__ */ new Date(),
      etag: response.headers.get("etag") || ""
    }
  };
}

// src/list.ts
async function list(options) {
  var _a;
  const searchParams = new URLSearchParams();
  if (options == null ? void 0 : options.limit) {
    searchParams.set("limit", options.limit.toString());
  }
  if (options == null ? void 0 : options.prefix) {
    searchParams.set("prefix", options.prefix);
  }
  if (options == null ? void 0 : options.cursor) {
    searchParams.set("cursor", options.cursor);
  }
  if (options == null ? void 0 : options.mode) {
    searchParams.set("mode", options.mode);
  }
  const response = await _chunkQMTUXFZHcjs.requestApi.call(void 0, 
    `?${searchParams.toString()}`,
    {
      method: "GET",
      signal: options == null ? void 0 : options.abortSignal
    },
    options
  );
  if ((options == null ? void 0 : options.mode) === "folded") {
    return {
      folders: (_a = response.folders) != null ? _a : [],
      cursor: response.cursor,
      hasMore: response.hasMore,
      blobs: response.blobs.map(mapBlobResult)
    };
  }
  return {
    cursor: response.cursor,
    hasMore: response.hasMore,
    blobs: response.blobs.map(mapBlobResult)
  };
}
function mapBlobResult(blobResult) {
  return {
    url: blobResult.url,
    downloadUrl: blobResult.downloadUrl,
    pathname: blobResult.pathname,
    size: blobResult.size,
    uploadedAt: new Date(blobResult.uploadedAt),
    etag: blobResult.etag
  };
}

// src/copy.ts
async function copy(fromUrlOrPathname, toPathname, options) {
  if (!options) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("missing options, see usage");
  }
  if (options.access !== "public" && options.access !== "private") {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)(
      'access must be "private" or "public", see https://vercel.com/docs/vercel-blob'
    );
  }
  if (toPathname.length > _chunkQMTUXFZHcjs.MAXIMUM_PATHNAME_LENGTH) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)(
      `pathname is too long, maximum length is ${_chunkQMTUXFZHcjs.MAXIMUM_PATHNAME_LENGTH}`
    );
  }
  for (const invalidCharacter of _chunkQMTUXFZHcjs.disallowedPathnameCharacters) {
    if (toPathname.includes(invalidCharacter)) {
      throw new (0, _chunkQMTUXFZHcjs.BlobError)(
        `pathname cannot contain "${invalidCharacter}", please encode it if needed`
      );
    }
  }
  const headers = {};
  headers["x-vercel-blob-access"] = options.access;
  if (options.addRandomSuffix !== void 0) {
    headers["x-add-random-suffix"] = options.addRandomSuffix ? "1" : "0";
  }
  if (options.allowOverwrite !== void 0) {
    headers["x-allow-overwrite"] = options.allowOverwrite ? "1" : "0";
  }
  if (options.contentType) {
    headers["x-content-type"] = options.contentType;
  }
  if (options.cacheControlMaxAge !== void 0) {
    headers["x-cache-control-max-age"] = options.cacheControlMaxAge.toString();
  }
  if (options.ifMatch) {
    headers["x-if-match"] = options.ifMatch;
  }
  const params = new URLSearchParams({
    pathname: toPathname,
    fromUrl: fromUrlOrPathname
  });
  const response = await _chunkQMTUXFZHcjs.requestApi.call(void 0, 
    `?${params.toString()}`,
    {
      method: "PUT",
      headers,
      signal: options.abortSignal
    },
    options
  );
  return {
    url: response.url,
    downloadUrl: response.downloadUrl,
    pathname: response.pathname,
    contentType: response.contentType,
    contentDisposition: response.contentDisposition,
    etag: response.etag
  };
}

// src/rename.ts
async function rename(fromUrlOrPathname, toPathname, options) {
  if (!options) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("missing options, see usage");
  }
  if (options.access !== "public" && options.access !== "private") {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)(
      'access must be "private" or "public", see https://vercel.com/docs/vercel-blob'
    );
  }
  if (toPathname.length > _chunkQMTUXFZHcjs.MAXIMUM_PATHNAME_LENGTH) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)(
      `pathname is too long, maximum length is ${_chunkQMTUXFZHcjs.MAXIMUM_PATHNAME_LENGTH}`
    );
  }
  for (const invalidCharacter of _chunkQMTUXFZHcjs.disallowedPathnameCharacters) {
    if (toPathname.includes(invalidCharacter)) {
      throw new (0, _chunkQMTUXFZHcjs.BlobError)(
        `pathname cannot contain "${invalidCharacter}", please encode it if needed`
      );
    }
  }
  const headers = {};
  headers["x-vercel-blob-access"] = options.access;
  if (options.addRandomSuffix !== void 0) {
    headers["x-add-random-suffix"] = options.addRandomSuffix ? "1" : "0";
  }
  if (options.allowOverwrite !== void 0) {
    headers["x-allow-overwrite"] = options.allowOverwrite ? "1" : "0";
  }
  if (options.contentType) {
    headers["x-content-type"] = options.contentType;
  }
  if (options.cacheControlMaxAge !== void 0) {
    headers["x-cache-control-max-age"] = options.cacheControlMaxAge.toString();
  }
  if (options.ifMatch) {
    headers["x-if-match"] = options.ifMatch;
  }
  const params = new URLSearchParams({
    pathname: toPathname,
    fromUrl: fromUrlOrPathname
  });
  const response = await _chunkQMTUXFZHcjs.requestApi.call(void 0, 
    `/rename?${params.toString()}`,
    {
      method: "POST",
      headers,
      signal: options.abortSignal
    },
    options
  );
  return {
    url: response.url,
    downloadUrl: response.downloadUrl,
    pathname: response.pathname,
    contentType: response.contentType,
    contentDisposition: response.contentDisposition,
    etag: response.etag
  };
}

// src/put-image.ts
function toPutBlobResult(response) {
  return {
    url: response.url,
    downloadUrl: response.downloadUrl,
    pathname: response.pathname,
    contentType: response.contentType,
    contentDisposition: response.contentDisposition,
    etag: response.etag
  };
}
async function putImage(pathname, bodyOrUrl, options) {
  if (!(options == null ? void 0 : options.optimizeImage)) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("optimizeImage is required, see usage");
  }
  const { optimizeImage } = options;
  if (bodyOrUrl instanceof URL) {
    if (bodyOrUrl.protocol !== "http:" && bodyOrUrl.protocol !== "https:") {
      throw new (0, _chunkQMTUXFZHcjs.BlobError)("the source URL must use the http(s) protocol");
    }
    const putOptions2 = await _chunkQMTUXFZHcjs.createPutOptions.call(void 0, { pathname, options });
    const headers2 = _chunkQMTUXFZHcjs.createPutHeaders.call(void 0, 
      ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "ifMatch"],
      putOptions2
    );
    const params2 = new URLSearchParams({
      pathname,
      url: bodyOrUrl.toString()
    });
    _chunkQMTUXFZHcjs.addOptimizeImageParams.call(void 0, params2, optimizeImage);
    const response2 = await _chunkQMTUXFZHcjs.requestApi.call(void 0, 
      `/put-from-url?${params2.toString()}`,
      {
        method: "POST",
        headers: headers2,
        signal: putOptions2.abortSignal
      },
      putOptions2
    );
    return toPutBlobResult(response2);
  }
  if (!bodyOrUrl) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("body is required");
  }
  if (_chunkQMTUXFZHcjs.isPlainObject.call(void 0, bodyOrUrl)) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)(
      "Body must be a string, buffer or stream. You sent a plain JavaScript object, double check what you're trying to upload."
    );
  }
  const putOptions = await _chunkQMTUXFZHcjs.createPutOptions.call(void 0, { pathname, options });
  const headers = _chunkQMTUXFZHcjs.createPutHeaders.call(void 0, 
    ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "ifMatch"],
    putOptions
  );
  _chunkQMTUXFZHcjs.validateOptimizeImageSourceContentType.call(void 0, 
    typeof Blob !== "undefined" && bodyOrUrl instanceof Blob ? bodyOrUrl.type : void 0
  );
  const params = new URLSearchParams({ pathname });
  _chunkQMTUXFZHcjs.addOptimizeImageParams.call(void 0, params, optimizeImage);
  const response = await _chunkQMTUXFZHcjs.requestApi.call(void 0, 
    `/put-optimized?${params.toString()}`,
    {
      method: "POST",
      body: bodyOrUrl,
      headers,
      signal: putOptions.abortSignal
    },
    putOptions
  );
  return toPutBlobResult(response);
}

// src/put-from-url.ts
async function putFromUrl(pathname, url, options) {
  const putOptions = await _chunkQMTUXFZHcjs.createPutOptions.call(void 0, { pathname, options });
  if (!url) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("url is required");
  }
  if (!putOptions.optimizeImage) {
    throw new (0, _chunkQMTUXFZHcjs.BlobError)("optimizeImage is required, see usage");
  }
  const headers = _chunkQMTUXFZHcjs.createPutHeaders.call(void 0, 
    ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "ifMatch"],
    putOptions
  );
  const params = new URLSearchParams({ pathname, url });
  _chunkQMTUXFZHcjs.addOptimizeImageParams.call(void 0, params, putOptions.optimizeImage);
  const response = await _chunkQMTUXFZHcjs.requestApi.call(void 0, 
    `/put-from-url?${params.toString()}`,
    {
      method: "POST",
      headers,
      signal: putOptions.abortSignal
    },
    putOptions
  );
  return {
    url: response.url,
    downloadUrl: response.downloadUrl,
    pathname: response.pathname,
    contentType: response.contentType,
    contentDisposition: response.contentDisposition,
    etag: response.etag
  };
}

// src/index.ts
var put = _chunkQMTUXFZHcjs.createPutMethod.call(void 0, {
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType",
    "ifMatch"
  ]
});
var createMultipartUpload = _chunkQMTUXFZHcjs.createCreateMultipartUploadMethod.call(void 0, {
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType",
    "ifMatch"
  ]
});
var createMultipartUploader = _chunkQMTUXFZHcjs.createCreateMultipartUploaderMethod.call(void 0, {
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType",
    "ifMatch"
  ]
});
var uploadPart = _chunkQMTUXFZHcjs.createUploadPartMethod.call(void 0, {
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType"
  ]
});
var completeMultipartUpload = _chunkQMTUXFZHcjs.createCompleteMultipartUploadMethod.call(void 0, {
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType"
  ]
});


































exports.BlobAccessError = _chunkQMTUXFZHcjs.BlobAccessError; exports.BlobClientTokenExpiredError = _chunkQMTUXFZHcjs.BlobClientTokenExpiredError; exports.BlobContentTypeNotAllowedError = _chunkQMTUXFZHcjs.BlobContentTypeNotAllowedError; exports.BlobError = _chunkQMTUXFZHcjs.BlobError; exports.BlobFileTooLargeError = _chunkQMTUXFZHcjs.BlobFileTooLargeError; exports.BlobNotFoundError = _chunkQMTUXFZHcjs.BlobNotFoundError; exports.BlobPathnameMismatchError = _chunkQMTUXFZHcjs.BlobPathnameMismatchError; exports.BlobPreconditionFailedError = _chunkQMTUXFZHcjs.BlobPreconditionFailedError; exports.BlobRequestAbortedError = _chunkQMTUXFZHcjs.BlobRequestAbortedError; exports.BlobServiceNotAvailable = _chunkQMTUXFZHcjs.BlobServiceNotAvailable; exports.BlobServiceRateLimited = _chunkQMTUXFZHcjs.BlobServiceRateLimited; exports.BlobStoreNotFoundError = _chunkQMTUXFZHcjs.BlobStoreNotFoundError; exports.BlobStoreSuspendedError = _chunkQMTUXFZHcjs.BlobStoreSuspendedError; exports.BlobUnknownError = _chunkQMTUXFZHcjs.BlobUnknownError; exports.completeMultipartUpload = completeMultipartUpload; exports.copy = copy; exports.createFolder = _chunkQMTUXFZHcjs.createFolder; exports.createMultipartUpload = createMultipartUpload; exports.createMultipartUploader = createMultipartUploader; exports.del = del; exports.get = get; exports.getDownloadUrl = _chunkQMTUXFZHcjs.getDownloadUrl; exports.head = head; exports.issueSignedToken = _chunkQMTUXFZHcjs.issueSignedToken; exports.list = list; exports.parseStoreIdFromDelegationToken = _chunkQMTUXFZHcjs.parseStoreIdFromDelegationToken; exports.parseStoreIdFromPresignedUrl = _chunkQMTUXFZHcjs.parseStoreIdFromPresignedUrl; exports.presignUrl = _chunkQMTUXFZHcjs.presignUrl; exports.put = put; exports.putFromUrl = putFromUrl; exports.putImage = putImage; exports.rename = rename; exports.uploadPart = uploadPart;
//# sourceMappingURL=index.cjs.map