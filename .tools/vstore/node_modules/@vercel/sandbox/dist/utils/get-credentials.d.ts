import { z } from "zod";

//#region src/utils/get-credentials.d.ts
interface Credentials {
  /**
   * Authentication token for the Vercel API. It could be an OIDC token
   * or a personal access token.
   */
  token: string;
  /**
   * The ID of the project to associate Sandbox operations.
   */
  projectId: string;
  /**
   * The ID of the team to associate Sandbox operations.
   */
  teamId: string;
}
//#endregion
export { Credentials };
//# sourceMappingURL=get-credentials.d.ts.map