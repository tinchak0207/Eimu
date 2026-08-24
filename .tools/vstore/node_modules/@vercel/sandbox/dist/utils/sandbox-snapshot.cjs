const require_network_policy = require('./network-policy.cjs');

//#region src/utils/sandbox-snapshot.ts
function toSandboxSnapshot(sandbox) {
	const { networkPolicy, ...rest } = sandbox;
	return {
		...rest,
		networkPolicy: networkPolicy ? require_network_policy.fromAPINetworkPolicy(networkPolicy) : void 0
	};
}

//#endregion
exports.toSandboxSnapshot = toSandboxSnapshot;
//# sourceMappingURL=sandbox-snapshot.cjs.map