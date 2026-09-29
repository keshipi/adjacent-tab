/**
 * 新しく作られたタブを、直前までアクティブだったタブの隣へ移動させる。
 *
 * Chrome の既定動作では Ctrl/Cmd+T や「+」ボタン、アドレスバーの Cmd/Alt+Enter で
 * 作ったタブはタブバーの末尾に配置される。リンクから開いたタブは Chrome 自身が
 * 開き元の隣に配置するため、移動先が現在位置以上になり結果として no-op になる。
 *
 * アドレスバーの Cmd/Alt+Enter や Cmd+クリックで作ったタブは背面に開かれるので、
 * 開き元が分かるものは前面に出す。
 */

// 原因切り分け用のログ。調査したいときだけ true にする。
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[next-to-current]', ...args);
}

log('service worker started');

// windowId -> 直前までアクティブだったタブの tabId。
// Service Worker が停止してもよいように storage.session に二重で持たせる。
const lastActiveByWindow = new Map();

function sessionKey(windowId) {
  return `lastActiveTab:${windowId}`;
}

async function setLastActive(windowId, tabId) {
  lastActiveByWindow.set(windowId, tabId);
  try {
    await chrome.storage.session.set({ [sessionKey(windowId)]: tabId });
  } catch (error) {
    console.warn('[next-to-current] failed to persist last active tab', error);
  }
}

async function getLastActive(windowId) {
  if (lastActiveByWindow.has(windowId)) {
    return lastActiveByWindow.get(windowId);
  }
  try {
    const key = sessionKey(windowId);
    const stored = await chrome.storage.session.get(key);
    if (typeof stored[key] === 'number') {
      lastActiveByWindow.set(windowId, stored[key]);
      return stored[key];
    }
  } catch (error) {
    console.warn('[next-to-current] failed to read last active tab', error);
  }
  return undefined;
}

async function clearLastActive(windowId) {
  lastActiveByWindow.delete(windowId);
  try {
    await chrome.storage.session.remove(sessionKey(windowId));
  } catch (error) {
    console.warn('[next-to-current] failed to clear last active tab', error);
  }
}

// ブラウザ起動直後やインストール直後は onActivated が一度も来ていないため、
// その時点のアクティブタブを起点として記録しておく。
async function seedAllWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    if (win.type !== 'normal' || !win.tabs) continue;
    const active = win.tabs.find((tab) => tab.active);
    if (active) {
      await setLastActive(win.id, active.id);
      log('seeded window', win.id, '-> tab', active.id, 'index', active.index);
    }
  }
}

// タブ作成イベントが短時間に連続しても順序が崩れないよう、処理を直列化する。
let queue = Promise.resolve();

function enqueue(task) {
  queue = queue.then(task).catch((error) => console.error('[next-to-current]', error));
  return queue;
}

async function firstUnpinnedIndex(windowId) {
  const pinned = await chrome.tabs.query({ windowId, pinned: true });
  return pinned.length;
}

/** 移動の起点にするタブを決める。 */
async function resolveAnchor(tab) {
  // 開き元が分かっているならそれが最も確実な起点。
  // Cmd+T でも直前のアクティブタブが openerTabId に入る。
  if (tab.openerTabId !== undefined) {
    const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
    if (opener && opener.windowId === tab.windowId) {
      log('anchor from openerTabId:', opener.id, 'index', opener.index);
      return opener;
    }
  }

  const storedId = await getLastActive(tab.windowId);
  if (storedId !== undefined && storedId !== tab.id) {
    const anchor = await chrome.tabs.get(storedId).catch(() => null);
    if (anchor && anchor.windowId === tab.windowId) {
      log('anchor from storage:', anchor.id, 'index', anchor.index);
      return anchor;
    }
  }

  // 拡張の再読み込み直後など起点が未記録のとき用のフォールバック。
  // onCreated の時点でまだアクティブが切り替わっていなければ、旧アクティブタブが取れる。
  const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
  if (active && active.id !== tab.id) {
    log('anchor from query fallback:', active.id, 'index', active.index);
    return active;
  }

  log('no anchor available (storedId:', storedId, ', queried active:', active?.id, ')');
  return null;
}

/**
 * Chrome が openerTabId を見て背面タブを置く位置。
 * opener の直後に既にある「opener を開き元とするタブ」の後ろになる。
 */
async function openerChildIndex(tab, opener) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const others = tabs.filter((t) => t.id !== tab.id).sort((a, b) => a.index - b.index);

  const openerPos = others.findIndex((t) => t.id === opener.id);
  if (openerPos === -1) return null;

  let slot = openerPos + 1;
  while (slot < others.length && others[slot].openerTabId === opener.id) slot += 1;
  return slot;
}

/** tab を targetIndex へ移動する。移動したら true。 */
async function moveTo(tab, targetIndex) {
  // ピン留めタブの直後には通常タブを置けないので、ピン留め領域の直後に寄せる。
  const index = tab.pinned
    ? targetIndex
    : Math.max(targetIndex, await firstUnpinnedIndex(tab.windowId));

  if (index >= tab.index) {
    log('skip: already adjacent (target', index, '>= current', tab.index, ')');
    return false;
  }

  await chrome.tabs.move(tab.id, { index });
  log('moved tab', tab.id, 'from index', tab.index, 'to', index);
  return true;
}

async function placeNewTab(tab) {
  log('onCreated', {
    id: tab.id,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    openerTabId: tab.openerTabId,
    windowId: tab.windowId,
  });

  if (tab.windowId === chrome.windows.WINDOW_ID_NONE) return log('skip: no window');

  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win) return log('skip: window not found');
  if (win.type !== 'normal') return log('skip: window type is', win.type);

  // アドレスバーの Cmd/Alt+Enter（URL を新しいタブで開く＝実質のタブ複製）と
  // Cmd+クリックのリンクタブはどちらもアクティブにならない。前者はタブバーの末尾に
  // 置かれるので、Chrome が背面タブを置く位置を計算して寄せる。
  if (!tab.active) {
    // 開き元が分からない非アクティブタブ（セッション復元など）は並び順を尊重する。
    if (tab.openerTabId === undefined) return log('skip: inactive without opener');

    const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
    if (!opener || opener.windowId !== tab.windowId) return log('skip: opener unavailable');

    const slot = await openerChildIndex(tab, opener);
    if (slot === null) return log('skip: opener not found in window');

    // Chrome が置いた位置がそのまま slot なら移動距離が 0 以下になり no-op。
    // 既存の子タブの後ろを狙うのは、続けて開いたタブが逆順に並ばないようにするため。
    await moveTo(tab, slot);

    await chrome.tabs.update(tab.id, { active: true });
    log('activated tab', tab.id);
    return;
  }

  const anchor = await resolveAnchor(tab);
  if (!anchor) return log('skip: anchor unresolved');

  if (await moveTo(tab, anchor.index + 1)) {
    // 移動したタブがそのままアクティブになるため、次の起点として記録する。
    // （onActivated より先にここへ到達するケースを取りこぼさないため）
    await setLastActive(tab.windowId, tab.id);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  enqueue(() => placeNewTab(tab));
});

chrome.tabs.onActivated.addListener(({ windowId, tabId }) => {
  enqueue(async () => {
    await setLastActive(windowId, tabId);
    log('onActivated -> anchor is now tab', tabId, 'in window', windowId);
  });
});

chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  enqueue(async () => {
    if (isWindowClosing) {
      await clearLastActive(windowId);
      return;
    }
    if ((await getLastActive(windowId)) !== tabId) return;
    // 起点にしていたタブが閉じられたので、現在のアクティブタブへ張り替える。
    const [active] = await chrome.tabs.query({ windowId, active: true });
    if (active) await setLastActive(windowId, active.id);
    else await clearLastActive(windowId);
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  enqueue(() => clearLastActive(windowId));
});

chrome.runtime.onStartup.addListener(() => {
  log('onStartup');
  enqueue(seedAllWindows);
});

chrome.runtime.onInstalled.addListener((details) => {
  log('onInstalled', details.reason);
  enqueue(seedAllWindows);
});
