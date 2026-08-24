const require_validators = require('../api-client/validators.cjs');

//#region src/utils/network-policy.ts
function toAPINetworkPolicy(policy) {
	const apiPolicy = policy === "allow-all" || policy === "deny-all" ? { mode: policy } : policy;
	require_validators.NetworkPolicyRequestValidator.parse(apiPolicy);
	return apiPolicy;
}
function fromAPINetworkPolicy(api) {
	if (api.mode === "allow-all" || api.mode === "deny-all") return api.mode;
	const subnets = api.allowedCIDRs || api.deniedCIDRs ? { subnets: {
		...api.allowedCIDRs && { allow: api.allowedCIDRs },
		...api.deniedCIDRs && { deny: api.deniedCIDRs }
	} } : void 0;
	if (api.injectionRules && api.injectionRules.length > 0 || api.forwardRules && api.forwardRules.length > 0) {
		const rulesByDomain = /* @__PURE__ */ new Map();
		for (const rule of api.injectionRules ?? []) {
			const headers = Object.fromEntries((rule.headerNames ?? []).map((n) => [n, "<redacted>"]));
			const rules = rulesByDomain.get(rule.domain) ?? [];
			rules.push({
				...rule.match ? { match: rule.match } : {},
				transform: [{ headers }]
			});
			rulesByDomain.set(rule.domain, rules);
		}
		for (const rule of api.forwardRules ?? []) {
			const rules = rulesByDomain.get(rule.domain) ?? [];
			rules.push({
				...rule.match ? { match: rule.match } : {},
				forwardURL: rule.forwardURL
			});
			rulesByDomain.set(rule.domain, rules);
		}
		const allow = {};
		for (const domain of api.allowedDomains ?? []) allow[domain] = rulesByDomain.get(domain) ?? [];
		for (const rule of [...api.injectionRules ?? [], ...api.forwardRules ?? []]) if (!(rule.domain in allow)) allow[rule.domain] = rulesByDomain.get(rule.domain) ?? [];
		return {
			allow,
			...subnets
		};
	}
	return {
		...api.allowedDomains && { allow: api.allowedDomains },
		...subnets
	};
}

//#endregion
exports.fromAPINetworkPolicy = fromAPINetworkPolicy;
exports.toAPINetworkPolicy = toAPINetworkPolicy;
//# sourceMappingURL=network-policy.cjs.map