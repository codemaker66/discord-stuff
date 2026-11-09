/*
 * Dopa's Discord Purifier, as a Vencord userplugin.
 * Built from the same core as the userscript and the BetterDiscord plugin (tools/build.mjs).
 * It ships inside our Vencord build as src/userplugins/dopasPurifier/index.js, so Vencord's own
 * updater replaces the whole build from our releases: there is no self-updater in here.
 * @name DopasPurifier
 * @author Bardo & Dopa
 * @version @@VERSION@@
 * @website @@HOMEPAGE@@
 * @source @@REPO@@
 */

import definePlugin from "@utils/types";

const VERSION = '@@VERSION@@';
const SHARE_URL = '@@HOMEPAGE@@';

export default definePlugin({
  name: "DopasPurifier",
  description: "Cute bulk message purifier for Discord~ ✨ Wipe your own messages from any DM, group or server.",
  authors: [{ name: "Bardo & Dopa", id: 0n }],
  enabledByDefault: true,

  start() {
    if (this.app) return;
    if (window.__dopaPurifier) return; // the userscript is already running here
    this.app = createPurifier();
    window.__dopaPurifier = this.app;
    this.app.start();
  },

  stop() {
    if (!this.app) return;
    this.app.destroy();
    if (window.__dopaPurifier === this.app) delete window.__dopaPurifier;
    this.app = null;
  },
});

function createPurifier() {
/*@@CORE@@*/
}
