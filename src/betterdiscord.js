/**
 * @name DopasPurifier
 * @author Bardo & Dopa
 * @description Cute bulk message purifier for Discord~ ✨ Wipe your own messages from any DM, group or server.
 * @version @@VERSION@@
 * @website @@HOMEPAGE@@
 * @source @@REPO@@
 */

const VERSION = '@@VERSION@@';
const SHARE_URL = '@@HOMEPAGE@@';
// BetterDiscord only updates plugins from its own store, and this one isn't listed there.
const PLUGIN_URL = '@@PLUGIN_URL@@';

module.exports = class DopasPurifier {
  constructor(meta) { this.meta = meta; }

  start() {
    if (this.app) return;
    this.checkForUpdate();
    if (window.__dopaPurifier) return; // the userscript is already running here
    this.app = createPurifier();
    window.__dopaPurifier = this.app;
    this.app.start();
  }

  stop() {
    this.updateCheck = null;
    if (!this.app) return;
    this.app.destroy();
    if (window.__dopaPurifier === this.app) delete window.__dopaPurifier;
    this.app = null;
  }

  // One look per start. Offline, a GitHub hiccup or anything that isn't this plugin just means no offer.
  // Rewriting our own file is enough: BetterDiscord watches the folder and reloads the plugin.
  async checkForUpdate() {
    const check = this.updateCheck = {};
    try {
      const file = this.meta && this.meta.filename;
      if (typeof BdApi === 'undefined' || !file) return;
      const res = await BdApi.Net.fetch(PLUGIN_URL);
      if (!res.ok) return;
      const text = await res.text();
      const remote = (/^\/\*\*[\s\S]*?@name DopasPurifier\s[\s\S]*?@version\s+(\S+)/.exec(text) || [])[1];
      if (!remote || !text.includes('module.exports = class DopasPurifier')) return;
      if (this.updateCheck !== check || BdApi.Utils.semverCompare(VERSION, remote) <= 0) return;
      BdApi.UI.showConfirmationModal("Dopa's Purifier update ✨", `v${remote} is here, princess~ You have v${VERSION}. Update now? ♡`, {
        confirmText: 'Update',
        cancelText: 'Later',
        onConfirm: () => {
          try { require('fs').writeFileSync(require('path').join(BdApi.Plugins.folder, file), text); }
          catch { BdApi.UI.showToast("Couldn't update~ grab the new file from the install page ♡", { type: 'error' }); }
        },
      });
    } catch { /* no offer this time */ }
  }
};

function createPurifier() {
/*@@CORE@@*/
}
