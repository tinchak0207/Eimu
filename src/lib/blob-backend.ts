/**
 * Storage backend selector: VPS image-data-api when configured, otherwise
 * Vercel Blob. Modules import { list, get, put, del } from this module so the
 * swap is a single env-config decision.
 */
import * as vercelBlob from "@vercel/blob";
import * as vpsBlob from "./vps-blob-adapter";

export function useVpsBlobBackend(): boolean {
  return vpsBlob.isVpsBlobBackend();
}

export const list = (async (options: Parameters<typeof vercelBlob.list>[0]) =>
  useVpsBlobBackend() ? vpsBlob.list(options) : vercelBlob.list(options)) as unknown as typeof vercelBlob.list;

export const get = (async (urlOrPathname: string, options?: Parameters<typeof vercelBlob.get>[1]) =>
  useVpsBlobBackend()
    ? vpsBlob.get(urlOrPathname, options ?? {})
    : vercelBlob.get(urlOrPathname, options ?? ({} as Parameters<typeof vercelBlob.get>[1]))) as unknown as typeof vercelBlob.get;

export const put = (async (pathname: string, body: Parameters<typeof vercelBlob.put>[1], options?: Parameters<typeof vercelBlob.put>[2]) =>
  useVpsBlobBackend()
    ? vpsBlob.put(pathname, body as unknown as Parameters<typeof vpsBlob.put>[1], options)
    : vercelBlob.put(pathname, body, options ?? ({} as Parameters<typeof vercelBlob.put>[2]))) as unknown as typeof vercelBlob.put;

export const del = (async (urls: string[], options?: Parameters<typeof vercelBlob.del>[1]) =>
  useVpsBlobBackend() ? vpsBlob.del(urls, options) : vercelBlob.del(urls, options)) as unknown as typeof vercelBlob.del;
