/* eslint-disable no-undef */
const compatGrant = require("eslint-plugin-userscripts/dist/data/compat-grant.js");

const compatMap = {
  CAT_userConfig: [{ type: "scriptcat", versionConstraint: ">=0.11.0-beta" }],
  CAT_fileStorage: [{ type: "scriptcat", versionConstraint: ">=0.11.0" }],
  CAT_registerMenuInput: [{ type: "scriptcat", versionConstraint: ">=0.17.0-beta.2" }],
  CAT_unregisterMenuInput: [{ type: "scriptcat", versionConstraint: ">=0.17.0-beta.2" }],
  CAT_scriptLoaded: [{ type: "scriptcat", versionConstraint: ">=1.1.0-beta" }],
  ...compatGrant.compatMap,
};

const gmPolyfillOverride = {
  ...compatGrant.gmPolyfillOverride,
};

module.exports = { compatMap, gmPolyfillOverride };
