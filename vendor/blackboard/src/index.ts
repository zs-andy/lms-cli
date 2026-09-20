/**
 * Library entry point.
 *
 * Importing `blackboard-mcp` gives you the client and server pieces directly,
 * so the package is usable as a Blackboard SDK without going through MCP.
 */
export { BlackboardClient, displayName, courseLabel, isContainer, fileDetailOf } from './client/index.js';
export { HttpClient, type RequestOptions } from './client/http.js';
export * from './client/types.js';
export {
  DEFAULT_ENDPOINTS, loadEndpoints, expand, saveProfile,
  type OperationName, type EndpointMap, type EndpointProfile,
} from './client/endpoints.js';

export { Session, logout, DEFAULT_USER_AGENT } from './auth/session.js';
export {
  login, loginFromBrowser, parseCookieInput, type LoginOptions, type BrowserLoginResult,
} from './auth/login.js';
export {
  discoverProfiles, discoverInstances, readBrowserCookies,
  type BrowserProfile, type BrowserCookie,
} from './auth/browsers.js';
export { refreshSession, type RefreshResult } from './auth/saml.js';
export { importHar, type HarImportResult } from './auth/har.js';

export { createServer, startStdio, SERVER_NAME, SERVER_VERSION } from './server.js';
export { install, CLIENTS, serverEntry, type ClientId } from './install.js';

export { loadConfigOrNull, saveConfig, normaliseBaseUrl, ConfigSchema, type Config } from './config.js';
export { BlackboardError, toBlackboardError, type ErrorCode } from './lib/errors.js';
export { downloadToDisk, rawFileUrl, safeFileName, fmtBytes, type DownloadResult } from './lib/files.js';
export { extractText, htmlToText, extractEmbeddedFiles, type ExtractResult } from './lib/extract.js';
export {
  assignmentBriefOf, plainText, extractLinks, type AssignmentBrief,
} from './lib/brief.js';
export {
  recogniseExternalDocument, fetchExternalDocument, linkTargetOf, externalFileName,
  type ExternalDocument, type ExternalKind, type ExternalFetchResult,
} from './lib/external.js';
export { setLogLevel, type LogLevel } from './lib/logger.js';
