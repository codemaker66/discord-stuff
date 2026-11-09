/**
 * @name DopasPurifier
 * @author Bardo & Dopa
 * @description Cute bulk message purifier for Discord~ ✨ Wipe your own messages from any DM, group or server.
 * @version @@VERSION@@
 * @website @@HOMEPAGE@@
 * @source @@REPO@@
 */

const VERSION = '@@VERSION@@';
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
      // A dialog left open can outlive this copy, and another Discord window may have updated the
      // shared file already: write only from the live copy, and never over a newer file.
      const write = () => {
        if (this.updateCheck !== check) return;
        try {
          const fs = require('fs');
          const dest = require('path').join(BdApi.Plugins.folder, file);
          const onDisk = (/@version\s+(\S+)/.exec(fs.readFileSync(dest, 'utf8')) || [])[1];
          if (onDisk && BdApi.Utils.semverCompare(onDisk, remote) <= 0) return;
          fs.writeFileSync(dest, text);
        } catch { BdApi.UI.showToast("Couldn't update~ grab the new file from the install page ♡", { type: 'error' }); }
      };
      // Writing the file reloads the plugin, which would end a purge before its verdict shows: mid-purge
      // the update waits for the end, then asks again.
      const confirm = () => {
        if (this.updateCheck !== check) return;
        if (!this.app || !this.app.busy()) { write(); return; }
        BdApi.UI.showToast('Updating once purifying is done~ ♡');
        this.app.whenIdle().then(() => {
          if (this.updateCheck === check) ask(`All done purifying~ v${remote} is ready. Update now? ♡`);
        });
      };
      const ask = (body) => BdApi.UI.showConfirmationModal("Dopa's Purifier update ✨", body, { confirmText: 'Update', cancelText: 'Later', onConfirm: confirm });
      ask(`v${remote} is here, princess~ You have v${VERSION}. Update now? ♡`);
    } catch { /* no offer this time */ }
  }
};

function createPurifier() {
/*@@CORE@@*/
}
