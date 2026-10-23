// ==UserScript==
// @name         Dopa's Discord Purifier
// @namespace    https://github.com/dopameanie
// @version      @@VERSION@@
// @description  Cute bulk message purifier for Discord~ ✨ Wipe your own messages from any DM, group or server.
// @author       Bardo & Dopa
// @icon         @@ICON@@
// @homepageURL  @@HOMEPAGE@@
// @supportURL   @@ISSUES@@
// @updateURL    @@INSTALL_URL@@
// @downloadURL  @@INSTALL_URL@@
// @match        https://discord.com/*
// @match        https://ptb.discord.com/*
// @match        https://canary.discord.com/*
// @match        @@HOMEPAGE@@*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  const VERSION = '@@VERSION@@';
  const SHARE_URL = '@@HOMEPAGE@@';

  // On the install page, just say hello so it can show "installed ✓".
  if (!/(^|\.)discord\.com$/.test(location.hostname)) {
    document.documentElement.dataset.dopaPurifier = VERSION;
    window.dispatchEvent(new CustomEvent('dopa-purifier:installed', { detail: { version: VERSION } }));
    return;
  }
  if (window.__dopaPurifier) return;
  window.__dopaPurifier = createPurifier();
  window.__dopaPurifier.start();

  function createPurifier() {
/*@@CORE@@*/
  }
})();
