//#region src/proxy.d.ts
interface ProxyMeta {
  /**
   * The host of the request as received by this proxy.
   */
  host: string;
  /**
   * The ID of the team that owns the sandbox that proxied the request.
   */
  teamId: string;
  /**
   * The ID of the project that owns the sandbox that proxied the request.
   */
  projectId: string;
  /**
   * The ID of the sandbox that proxied the request.
   */
  sandboxId: string;
  /**
   * The name of the sandbox that proxied the request, when using persistent sandboxes.
   */
  sandboxName: string;
}
type ProxyHandler = (request: Request, meta: ProxyMeta) => Response | Promise<Response>;
type InvalidRequestProxyHandler = (request: Request, error: Error) => Response | Promise<Response>;
/**
 * Creates a Web Handler for proxied requests from Vercel Sandboxes using the network policy `forwardURL`
 * option. The provided `handler` is called for each valid proxied request, with the original request
 * alongside extracted metadata used to identify the source sandbox and request details.
 *
 * This function automatically verifies the OIDC token included in proxied requests to ensure the request
 * is legitimate: if invalid, the `invalidRequestHandler` is called (by default, a 403 response is returned).
 *
 * @example
 * ```ts
 * export default {
 *   fetch: defineSandboxProxy(async (request, meta) => {
 *     // meta contains the original host & source team/project/sandbox ids
 *     console.log(meta)
 *
 *     // return a custom response, or proxy upstream:
 *     return await fetch(request)
 *   }, (request, error) => {
 *     // optional, handle any authorization error
 *     return new Response("Forbidden", { status: 403 })
 *   })
 * }
 * ```
 *
 * @see https://vercel.com/docs/vercel-sandbox/concepts/firewall#requests-proxying
 */
declare function defineSandboxProxy(handler: ProxyHandler, invalidRequestHandler?: InvalidRequestProxyHandler): (request: Request) => Promise<Response>;
//#endregion
export { InvalidRequestProxyHandler, ProxyHandler, ProxyMeta, defineSandboxProxy };
//# sourceMappingURL=proxy.d.ts.map