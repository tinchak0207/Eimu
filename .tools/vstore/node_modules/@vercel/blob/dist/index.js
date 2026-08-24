import {
  BlobAccessError,
  BlobClientTokenExpiredError,
  BlobContentTypeNotAllowedError,
  BlobError,
  BlobFileTooLargeError,
  BlobNotFoundError,
  BlobPathnameMismatchError,
  BlobPreconditionFailedError,
  BlobRequestAbortedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  BlobUnknownError,
  MAXIMUM_PATHNAME_LENGTH,
  addOptimizeImageParams,
  constructBlobUrl,
  createCompleteMultipartUploadMethod,
  createCreateMultipartUploadMethod,
  createCreateMultipartUploaderMethod,
  createFolder,
  createPutHeaders,
  createPutMethod,
  createPutOptions,
  createUploadPartMethod,
  disallowedPathnameCharacters,
  getDownloadUrl,
  isPlainObject,
  isUrl,
  issueSignedToken,
  parseStoreIdFromDelegationToken,
  parseStoreIdFromPresignedUrl,
  presignUrl,
  requestApi,
  resolveBlobAuth,
  validateOptimizeImageSourceContentType
} from "./chunk-YYMLUMXS.js";

// src/del.ts
async function del(urlOrPathname, options) {
  const urls = Array.isArray(urlOrPathname) ? urlOrPathname : [urlOrPathname];
  if ((options == null ? void 0 : options.ifMatch) && urls.length > 1) {
    throw new BlobError("ifMatch can only be used when deleting a single URL.");
  }
  const headers = {
    "content-type": "application/json"
  };
  if (options == null ? void 0 : options.ifMatch) {
    headers["x-if-match"] = options.ifMatch;
  }
  await requestApi(
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
  const response = await requestApi(
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
import { fetch } from "undici";
function extractPathnameFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.pathname.slice(1);
  } catch {
    return url;
  }
}
async function get(urlOrPathname, options) {
  if (!urlOrPathname) {
    throw new BlobError("url or pathname is required");
  }
  if (!options) {
    throw new BlobError("missing options, see usage");
  }
  if (options.access !== "public" && options.access !== "private") {
    throw new BlobError(
      'access must be "private" or "public", see https://vercel.com/docs/vercel-blob'
    );
  }
  const auth = await resolveBlobAuth(options);
  if (auth.kind === "presigned") {
    throw new BlobError("Presigned URLs are not supported for the get method");
  }
  let blobUrl;
  let pathname;
  const access = options.access;
  if (isUrl(urlOrPathname)) {
    blobUrl = urlOrPathname;
    pathname = extractPathnameFromUrl(urlOrPathname);
    try {
      const { hostname } = new URL(blobUrl);
      if (!hostname.endsWith(".blob.vercel-storage.com")) {
        throw new BlobError(
          "Invalid URL: the URL does not point to a Vercel Blob store. Use a pathname instead, see https://vercel.com/docs/vercel-blob"
        );
      }
    } catch (error) {
      if (error instanceof BlobError) throw error;
      throw new BlobError("Invalid URL: unable to parse the provided URL");
    }
  } else {
    if (!auth.storeId) {
      throw new BlobError("Invalid token: unable to extract store ID");
    }
    pathname = urlOrPathname;
    blobUrl = constructBlobUrl(auth.storeId, pathname, access);
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
  const response = await fetch(fetchUrl, {
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
    throw new BlobError(
      `Failed to fetch blob: ${response.status} ${response.statusText}`
    );
  }
  const stream = response.body;
  if (!stream) {
    throw new BlobError("Response body is null");
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
  const response = await requestApi(
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
    throw new BlobError("missing options, see usage");
  }
  if (options.access !== "public" && options.access !== "private") {
    throw new BlobError(
      'access must be "private" or "public", see https://vercel.com/docs/vercel-blob'
    );
  }
  if (toPathname.length > MAXIMUM_PATHNAME_LENGTH) {
    throw new BlobError(
      `pathname is too long, maximum length is ${MAXIMUM_PATHNAME_LENGTH}`
    );
  }
  for (const invalidCharacter of disallowedPathnameCharacters) {
    if (toPathname.includes(invalidCharacter)) {
      throw new BlobError(
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
  const response = await requestApi(
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
    throw new BlobError("missing options, see usage");
  }
  if (options.access !== "public" && options.access !== "private") {
    throw new BlobError(
      'access must be "private" or "public", see https://vercel.com/docs/vercel-blob'
    );
  }
  if (toPathname.length > MAXIMUM_PATHNAME_LENGTH) {
    throw new BlobError(
      `pathname is too long, maximum length is ${MAXIMUM_PATHNAME_LENGTH}`
    );
  }
  for (const invalidCharacter of disallowedPathnameCharacters) {
    if (toPathname.includes(invalidCharacter)) {
      throw new BlobError(
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
  const response = await requestApi(
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
    throw new BlobError("optimizeImage is required, see usage");
  }
  const { optimizeImage } = options;
  if (bodyOrUrl instanceof URL) {
    if (bodyOrUrl.protocol !== "http:" && bodyOrUrl.protocol !== "https:") {
      throw new BlobError("the source URL must use the http(s) protocol");
    }
    const putOptions2 = await createPutOptions({ pathname, options });
    const headers2 = createPutHeaders(
      ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "ifMatch"],
      putOptions2
    );
    const params2 = new URLSearchParams({
      pathname,
      url: bodyOrUrl.toString()
    });
    addOptimizeImageParams(params2, optimizeImage);
    const response2 = await requestApi(
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
    throw new BlobError("body is required");
  }
  if (isPlainObject(bodyOrUrl)) {
    throw new BlobError(
      "Body must be a string, buffer or stream. You sent a plain JavaScript object, double check what you're trying to upload."
    );
  }
  const putOptions = await createPutOptions({ pathname, options });
  const headers = createPutHeaders(
    ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "ifMatch"],
    putOptions
  );
  validateOptimizeImageSourceContentType(
    typeof Blob !== "undefined" && bodyOrUrl instanceof Blob ? bodyOrUrl.type : void 0
  );
  const params = new URLSearchParams({ pathname });
  addOptimizeImageParams(params, optimizeImage);
  const response = await requestApi(
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
  const putOptions = await createPutOptions({ pathname, options });
  if (!url) {
    throw new BlobError("url is required");
  }
  if (!putOptions.optimizeImage) {
    throw new BlobError("optimizeImage is required, see usage");
  }
  const headers = createPutHeaders(
    ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "ifMatch"],
    putOptions
  );
  const params = new URLSearchParams({ pathname, url });
  addOptimizeImageParams(params, putOptions.optimizeImage);
  const response = await requestApi(
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
var put = createPutMethod({
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType",
    "ifMatch"
  ]
});
var createMultipartUpload = createCreateMultipartUploadMethod({
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType",
    "ifMatch"
  ]
});
var createMultipartUploader = createCreateMultipartUploaderMethod({
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType",
    "ifMatch"
  ]
});
var uploadPart = createUploadPartMethod({
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType"
  ]
});
var completeMultipartUpload = createCompleteMultipartUploadMethod({
  allowedOptions: [
    "cacheControlMaxAge",
    "addRandomSuffix",
    "allowOverwrite",
    "contentType"
  ]
});
export {
  BlobAccessError,
  BlobClientTokenExpiredError,
  BlobContentTypeNotAllowedError,
  BlobError,
  BlobFileTooLargeError,
  BlobNotFoundError,
  BlobPathnameMismatchError,
  BlobPreconditionFailedError,
  BlobRequestAbortedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  BlobUnknownError,
  completeMultipartUpload,
  copy,
  createFolder,
  createMultipartUpload,
  createMultipartUploader,
  del,
  get,
  getDownloadUrl,
  head,
  issueSignedToken,
  list,
  parseStoreIdFromDelegationToken,
  parseStoreIdFromPresignedUrl,
  presignUrl,
  put,
  putFromUrl,
  putImage,
  rename,
  uploadPart
};
//# sourceMappingURL=index.js.map