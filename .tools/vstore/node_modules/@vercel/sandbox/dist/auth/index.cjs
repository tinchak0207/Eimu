const require_file = require('./file.cjs');
const require_oauth = require('./oauth.cjs');
const require_poll_for_token = require('./poll-for-token.cjs');
const require_error = require('./error.cjs');
const require_project = require('./project.cjs');

exports.NotOk = require_error.NotOk;
exports.OAuth = require_oauth.OAuth;
exports.getAuth = require_file.getAuth;
exports.inferScope = require_project.inferScope;
exports.isOAuthError = require_oauth.isOAuthError;
exports.pollForToken = require_poll_for_token.pollForToken;
exports.updateAuthConfig = require_file.updateAuthConfig;