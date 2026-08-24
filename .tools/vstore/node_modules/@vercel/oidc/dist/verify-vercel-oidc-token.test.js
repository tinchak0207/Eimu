"use strict";
var import_vitest = require("vitest");
var import_jose = require("jose");
var import_verify_vercel_oidc_token = require("./verify-vercel-oidc-token");
const mocks = import_vitest.vi.hoisted(() => {
  const remoteJwks = import_vitest.vi.fn();
  return {
    remoteJwks,
    createRemoteJWKSet: import_vitest.vi.fn(() => remoteJwks),
    jwtVerify: import_vitest.vi.fn()
  };
});
import_vitest.vi.mock("jose", () => ({
  createRemoteJWKSet: mocks.createRemoteJWKSet,
  jwtVerify: mocks.jwtVerify
}));
(0, import_vitest.describe)("verifyVercelOidcToken", () => {
  const verifyResult = {
    payload: {
      sub: "owner:team1:project:site:environment:production",
      iss: "https://oidc.vercel.com/team1",
      aud: "https://oidc.vercel.com/team1",
      project_id: "prj_test",
      environment: "production",
      owner_id: "team_team1"
    },
    protectedHeader: {
      alg: "RS256"
    }
  };
  (0, import_vitest.beforeEach)(() => {
    process.env.VERCEL_PROJECT_ID = "prj_test";
    process.env.VERCEL_TARGET_ENV = "production";
    delete process.env.VERCEL_ENV;
    import_vitest.vi.mocked(import_jose.jwtVerify).mockClear();
    mockVerifiedPayload();
  });
  (0, import_vitest.afterEach)(() => {
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TARGET_ENV;
    delete process.env.VERCEL_ENV;
  });
  (0, import_vitest.test)("verifies a token using the Vercel issuer and JWKS", async () => {
    const result = await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      audience: "https://oidc.vercel.com/team1",
      subject: "owner:team1:project:site:environment:production"
    });
    (0, import_vitest.expect)(result).toStrictEqual(verifyResult);
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledWith("token", mocks.remoteJwks, {
      algorithms: ["RS256"],
      audience: "https://oidc.vercel.com/team1",
      subject: "owner:team1:project:site:environment:production"
    });
  });
  (0, import_vitest.test)("verifies a token without additional options", async () => {
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token");
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledWith("token", mocks.remoteJwks, {
      algorithms: ["RS256"]
    });
  });
  (0, import_vitest.test)("reuses the Vercel remote JWKS resolver", async () => {
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("first-token");
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("second-token");
    (0, import_vitest.expect)(mocks.createRemoteJWKSet).toHaveBeenCalledTimes(1);
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledTimes(2);
  });
  (0, import_vitest.test)("passes custom algorithms to Jose verification", async () => {
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      algorithms: ["RS512"]
    });
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledWith("token", mocks.remoteJwks, {
      algorithms: ["RS512"]
    });
  });
  (0, import_vitest.test)("accepts a team issuer by default", async () => {
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token");
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledTimes(1);
  });
  (0, import_vitest.test)("accepts the global issuer", async () => {
    mockVerifiedPayload({
      iss: "https://oidc.vercel.com"
    });
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token");
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledTimes(1);
  });
  (0, import_vitest.test)("accepts a matching explicit issuer option", async () => {
    mockVerifiedPayload({
      iss: "https://oidc.vercel.com/acme"
    });
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      issuer: "https://oidc.vercel.com/acme"
    });
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledTimes(1);
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledWith("token", mocks.remoteJwks, {
      algorithms: ["RS256"],
      issuer: "https://oidc.vercel.com/acme"
    });
  });
  (0, import_vitest.test)("uses VERCEL_ENV when VERCEL_TARGET_ENV is missing", async () => {
    delete process.env.VERCEL_TARGET_ENV;
    process.env.VERCEL_ENV = "production";
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token");
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledTimes(1);
  });
  (0, import_vitest.test)("accepts custom projectId and environment options", async () => {
    mockVerifiedPayload({
      project_id: "prj_custom",
      environment: "preview"
    });
    const result = await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      projectId: "prj_custom",
      environment: "preview"
    });
    (0, import_vitest.expect)(result.payload.project_id).toBe("prj_custom");
    (0, import_vitest.expect)(result.payload.environment).toBe("preview");
  });
  (0, import_vitest.test)("accepts a matching projectId array option", async () => {
    mockVerifiedPayload({
      project_id: "prj_allowed"
    });
    const result = await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      projectId: ["prj_first", "prj_allowed"]
    });
    (0, import_vitest.expect)(result.payload.project_id).toBe("prj_allowed");
  });
  (0, import_vitest.test)("accepts a matching ownerId option", async () => {
    const result = await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      ownerId: "team_team1"
    });
    (0, import_vitest.expect)(result.payload.owner_id).toBe("team_team1");
  });
  (0, import_vitest.test)("does not require ownerId by default", async () => {
    mockVerifiedPayload({
      owner_id: "team_other"
    });
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token");
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledTimes(1);
  });
  (0, import_vitest.test)("allows any project_id claim with projectId wildcard", async () => {
    mockVerifiedPayload({
      project_id: "prj_other"
    });
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      projectId: "*",
      ownerId: "team_team1"
    });
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledTimes(1);
  });
  (0, import_vitest.test)("allows projectId wildcard with audience verification", async () => {
    mockVerifiedPayload({
      project_id: "prj_other"
    });
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      projectId: "*",
      audience: "https://oidc.vercel.com/team1"
    });
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledWith("token", mocks.remoteJwks, {
      algorithms: ["RS256"],
      audience: "https://oidc.vercel.com/team1"
    });
  });
  (0, import_vitest.test)("requires ownerId or audience when projectId wildcard is used", async () => {
    await (0, import_vitest.expect)(
      (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
        projectId: "*"
      })
    ).rejects.toThrow(
      "Expected ownerId or audience to be provided when projectId is '*'."
    );
    (0, import_vitest.expect)(import_jose.jwtVerify).not.toHaveBeenCalled();
  });
  (0, import_vitest.test)("requires ownerId or a non-empty audience when projectId wildcard is used", async () => {
    await (0, import_vitest.expect)(
      (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
        projectId: "*",
        audience: []
      })
    ).rejects.toThrow(
      "Expected ownerId or audience to be provided when projectId is '*'."
    );
    (0, import_vitest.expect)(import_jose.jwtVerify).not.toHaveBeenCalled();
  });
  (0, import_vitest.test)("allows any environment claim with environment wildcard", async () => {
    mockVerifiedPayload({
      environment: "preview"
    });
    await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      environment: "*"
    });
    (0, import_vitest.expect)(import_jose.jwtVerify).toHaveBeenCalledTimes(1);
  });
  (0, import_vitest.test)("accepts a matching environment array option", async () => {
    mockVerifiedPayload({
      environment: "preview"
    });
    const result = await (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
      environment: ["production", "preview"]
    });
    (0, import_vitest.expect)(result.payload.environment).toBe("preview");
  });
  (0, import_vitest.test)("rejects a token from a different project", async () => {
    mockVerifiedPayload({
      project_id: "prj_other"
    });
    await (0, import_vitest.expect)((0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token")).rejects.toThrow(
      'Expected Vercel OIDC token project_id claim to be "prj_test".'
    );
  });
  (0, import_vitest.test)("rejects a token from a project outside the projectId array", async () => {
    mockVerifiedPayload({
      project_id: "prj_other"
    });
    await (0, import_vitest.expect)(
      (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
        projectId: ["prj_first", "prj_second"]
      })
    ).rejects.toThrow(
      'Expected Vercel OIDC token project_id claim to be one of: "prj_first", "prj_second".'
    );
  });
  (0, import_vitest.test)("requires a non-empty projectId array", async () => {
    await (0, import_vitest.expect)(
      (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
        projectId: []
      })
    ).rejects.toThrow(
      "Expected VERCEL_PROJECT_ID to be set or projectId to be provided. Pass projectId: '*' to allow any project_id claim."
    );
  });
  (0, import_vitest.test)("rejects a token from a different owner", async () => {
    mockVerifiedPayload({
      owner_id: "team_other"
    });
    await (0, import_vitest.expect)(
      (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
        ownerId: "team_team1"
      })
    ).rejects.toThrow(
      'Expected Vercel OIDC token owner_id claim to be "team_team1".'
    );
  });
  (0, import_vitest.test)("rejects a token from a non-Vercel issuer", async () => {
    mockVerifiedPayload({
      iss: "https://example.com"
    });
    await (0, import_vitest.expect)((0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token")).rejects.toThrow(
      'Expected Vercel OIDC token iss claim to be "https://oidc.vercel.com" or to start with "https://oidc.vercel.com/".'
    );
  });
  (0, import_vitest.test)("rejects a token from an issuer that only shares the prefix text", async () => {
    mockVerifiedPayload({
      iss: "https://oidc.vercel.com.evil.example"
    });
    await (0, import_vitest.expect)((0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token")).rejects.toThrow(
      'Expected Vercel OIDC token iss claim to be "https://oidc.vercel.com" or to start with "https://oidc.vercel.com/".'
    );
  });
  (0, import_vitest.test)("rejects a token from a different environment", async () => {
    mockVerifiedPayload({
      environment: "preview"
    });
    await (0, import_vitest.expect)((0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token")).rejects.toThrow(
      'Expected Vercel OIDC token environment claim to be "production".'
    );
  });
  (0, import_vitest.test)("rejects a token from an environment outside the environment array", async () => {
    mockVerifiedPayload({
      environment: "preview"
    });
    await (0, import_vitest.expect)(
      (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
        environment: ["production", "development"]
      })
    ).rejects.toThrow(
      'Expected Vercel OIDC token environment claim to be one of: "production", "development".'
    );
  });
  (0, import_vitest.test)("requires a projectId default or wildcard", async () => {
    delete process.env.VERCEL_PROJECT_ID;
    await (0, import_vitest.expect)((0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token")).rejects.toThrow(
      "Expected VERCEL_PROJECT_ID to be set or projectId to be provided. Pass projectId: '*' to allow any project_id claim."
    );
  });
  (0, import_vitest.test)("requires an environment default or wildcard", async () => {
    delete process.env.VERCEL_TARGET_ENV;
    delete process.env.VERCEL_ENV;
    await (0, import_vitest.expect)((0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token")).rejects.toThrow(
      "Expected VERCEL_TARGET_ENV or VERCEL_ENV to be set or environment to be provided. Pass environment: '*' to allow any environment claim."
    );
  });
  (0, import_vitest.test)("requires a non-empty environment array", async () => {
    await (0, import_vitest.expect)(
      (0, import_verify_vercel_oidc_token.verifyVercelOidcToken)("token", {
        environment: []
      })
    ).rejects.toThrow(
      "Expected VERCEL_TARGET_ENV or VERCEL_ENV to be set or environment to be provided. Pass environment: '*' to allow any environment claim."
    );
  });
  function mockVerifiedPayload(payload) {
    import_vitest.vi.mocked(import_jose.jwtVerify).mockResolvedValue({
      ...verifyResult,
      payload: {
        ...verifyResult.payload,
        ...payload
      }
    });
  }
});
