import { DeviceAuthorizationRequest, OAuth } from "./oauth.js";

//#region src/auth/poll-for-token.d.ts
type PollTokenItem = {
  _tag: "Timeout";
  newInterval: number;
} | {
  _tag: "SlowDown";
  newInterval: number;
} | {
  _tag: "Error";
  error: Error;
} | {
  _tag: "Response";
  response: {
    text(): Promise<string>;
  };
};
declare function pollForToken({
  request,
  oauth
}: {
  request: DeviceAuthorizationRequest;
  oauth: OAuth;
}): AsyncGenerator<PollTokenItem, void, void>;
//#endregion
export { pollForToken };
//# sourceMappingURL=poll-for-token.d.ts.map