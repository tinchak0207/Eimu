import { fromAPINetworkPolicy } from "./network-policy.js";

//#region src/utils/sandbox-snapshot.ts
function toSandboxSnapshot(sandbox) {
	const { networkPolicy, ...rest } = sandbox;
	return {
		...rest,
		networkPolicy: networkPolicy ? fromAPINetworkPolicy(networkPolicy) : void 0
	};
}

//#endregion
export { toSandboxSnapshot };
//# sourceMappingURL=sandbox-snapshot.js.map