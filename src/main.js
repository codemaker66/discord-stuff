  'use strict';

  const API = `${location.origin}/api/v9`;
  const TIMING = { deleteDelayMs: 1200, searchDelayMs: 800, requestTimeoutMs: 30000 };
  // Message types Discord refuses to delete: recipient add/remove, call,
  // channel name/icon change and thread starter messages.
  const UNDELETABLE_TYPES = new Set([1, 2, 3, 4, 5, 21]);
  // Text, voice (text-in-voice), announcement, stage, forum and media channels.
  // Searching a channel also covers its threads and forum posts.
  const TEXT_CHANNEL_TYPES = new Set([0, 2, 5, 13, 15, 16]);
  // Always immune unless someone un-shields them in the panel.
  const PROTECTED_USERNAMES = new Set(['bardo', 'bardosama', 'dopameanie', 'dopa_meanie']);

  // ── Embedded Assets ─────────────────────────────────────
  const EMOTE_IMG = '@@EMOTE@@';
  const DELETE_SOUND = '@@SOUND@@';
  const CSS = /*@@CSS@@*/;

/*@@ENGINE@@*/

/*@@UI@@*/
