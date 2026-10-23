/**
 * @name DopasPurifier
 * @author Bardo & Dopa
 * @description Cute bulk message purifier for Discord~ ✨ Wipe your own messages from any DM, group or server.
 * @version @@VERSION@@
 * @website @@HOMEPAGE@@
 * @source @@REPO@@
 * @updateUrl @@PLUGIN_URL@@
 */

const VERSION = '@@VERSION@@';
const SHARE_URL = '@@HOMEPAGE@@';

module.exports = class DopasPurifier {
  start() {
    if (this.app) return;
    if (window.__dopaPurifier) return; // the userscript is already running here
    this.app = createPurifier();
    window.__dopaPurifier = this.app;
    this.app.start();
  }

  stop() {
    if (!this.app) return;
    this.app.destroy();
    if (window.__dopaPurifier === this.app) delete window.__dopaPurifier;
    this.app = null;
  }
};

function createPurifier() {
/*@@CORE@@*/
}
