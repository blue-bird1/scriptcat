/* eslint-disable no-undef */
const compatHeaders = require("eslint-plugin-userscripts/dist/data/compat-headers.js");

const compatMap = {
  ...compatHeaders.compatMap,
  nonFunctional: {
    ...compatHeaders.compatMap.nonFunctional,
    background: [],
    crontab: [],
    cloudCat: [],
    cloudServer: [],
    exportValue: [],
    exportCookie: [],
    scriptUrl: [],
    storageName: [],
    "early-start": [],
    "require-css": [],
  },
};

module.exports = { compatMap };
