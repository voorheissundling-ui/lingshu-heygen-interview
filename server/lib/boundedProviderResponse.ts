/** Read a billable response only up to the bytes that its durable receipt can retain. */
export async function readBoundedProviderResponse(
  response: Response,
  options: { maxBytes: number; errorCode: string; controller?: AbortController },
): Promise<string> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw Error('provider_response_limit_invalid');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) {
        options.controller?.abort();
        await reader.cancel().catch(() => undefined);
        throw Error(options.errorCode);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { reader.releaseLock(); }
}
