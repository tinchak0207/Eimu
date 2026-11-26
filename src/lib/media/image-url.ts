const PRIVATE_IMAGE_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);

export function publicImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    return PRIVATE_IMAGE_HOSTS.has(url.hostname) ? null : url.toString();
  } catch {
    return null;
  }
}
