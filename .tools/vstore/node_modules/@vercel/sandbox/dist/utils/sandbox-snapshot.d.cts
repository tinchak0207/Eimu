import { SessionMetaData } from "../api-client/validators.cjs";
import { NetworkPolicy } from "../network-policy.cjs";

//#region src/utils/sandbox-snapshot.d.ts
type SandboxSnapshot = Omit<SessionMetaData, "networkPolicy"> & {
  networkPolicy?: NetworkPolicy;
};
//#endregion
export { SandboxSnapshot };
//# sourceMappingURL=sandbox-snapshot.d.cts.map