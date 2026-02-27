const PROMPT =
  "下記の記事の誤り・怪しい箇所を列挙して下さい。最後に、評価できる点も踏まえて、「どの程度正しい、もしくは信憑性のある記事か」と「どの程度有用性のある記事か」を結論として述べて下さい。どの程度というのは 0～100 パーセントの表記も教えて下さい。(80～85%など)誤字脱字など、誤り・怪しい箇所・信憑性に直接関係しない指摘は控えて下さい。";

// URLに入れるのは短文のときだけ（エンコード後が大きいと壊れやすい）
const Q_PARAM_MAX_ENCODED_LEN = 1500;

// クリップボードに入れる本文上限（重すぎるのを防止）
const CLIP_MAX_CHARS = 30000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-to-chatgpt",
    title: "ChatGPTへ（コピー＆遷移）",
    contexts: ["page", "selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "send-to-chatgpt") return;
  if (!tab?.id) return;
  await run(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "send-now") return;

  try {

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    if (!tab?.id) return;
await run(tab.id);
  } catch (e) {
    console.error("Alt+G send error:", e);
  }
});

async function handleSendCore({ tabId }) {
  // ① 抽出（あなたの extractFromTab がある前提。無いなら executeInTab でOK）
  const page = await extractFromTab(tabId); // { title, url, text }

  const prompt =
    "下記の記事の誤り・怪しい箇所を列挙して下さい。最後に、評価できる点も踏まえてどの程度正しい、もしくは信憑性のある記事かを結論として述べて下さい。誤字脱字など、誤り・怪しい箇所・信憑性に直接関係しない指摘は控えて下さい。";

  const composed = [
    prompt,
    "",
    "【対象】",
    `タイトル: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    "",
    "【本文（ページ全体）】",
    page.text || ""
  ].join("\n");

  // ② フォーカスを確実化（重要：Document is not focused 対策）
  const t = await chrome.tabs.get(tabId);
  if (t?.windowId != null) {
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  }
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});

  // ③ クリップボードへコピー（ページ側で実行）
  const copyRes = await executeInTab(tabId, (text) => {
    return navigator.clipboard.writeText(String(text ?? ""))
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, name: e?.name, message: String(e?.message || e) }));
  }, [composed]);

  console.log("copyRes:", copyRes);

  // コピー失敗でも遷移はする（手動コピー前提ならここはnotifyしてもOK）
  // ④ ChatGPTへ遷移（別タブ）
  await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
}

async function executeInTab(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args
    });
    return (Array.isArray(results) && results[0]) ? (results[0].result ?? null) : null;
  } catch (e) {
    console.warn("executeScript failed:", e);
    return null;
  }
}

const actionApi = chrome.action ?? chrome.browserAction;
actionApi?.onClicked?.addListener(async (tab) => {
  if (!tab?.id) return;
  await run(tab.id);
});

/*
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "run") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await run(tab.id);
});
*/
async function run(sourceTabId) {
  try {
    // 1) 抽出
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: sourceTabId },
      files: ["extract.js"]
    });

    if (!result?.text) {
      notify("抽出失敗", "ページ本文を取得できませんでした。");
      return;
    }

    const body = (result.text || "").slice(0, CLIP_MAX_CHARS);

    const composed =
      `${PROMPT}\n\n` +
      `【対象】\nタイトル: ${result.title || "(不明)"}\nURL: ${result.url || "(不明)"}\n\n` +
      `【本文（ページ全体）】\n${body}\n`;
/*
    // 2) クリップボードへコピー（注入ではなく、抽出元ページの権限で実施）
    const copied = await copyOnPage(sourceTabId, composed);
    if (!copied) {
      notify("コピー失敗", "クリップボードにコピーできませんでした（権限/ページ都合の可能性）。");
      // それでもChatGPTへは遷移する
    }
*/

/*
await chrome.scripting.executeScript({
  target: { tabId: sourceTabId },
  func: async (t) => {
    try {
      await navigator.clipboard.writeText(String(t ?? ""));
    } catch (e) {}
  },
  args: [composed]   // ← 必ず配列にする
});
*/

// sourceTabId を前面にする（現在ウィンドウ内）
await chrome.tabs.update(sourceTabId, { active: true });

// 可能ならウィンドウも前面へ（任意）
const tab = await chrome.tabs.get(sourceTabId);
if (tab?.windowId != null) {
  await chrome.windows.update(tab.windowId, { focused: true });
}

const results = await chrome.scripting.executeScript({
  target: { tabId: sourceTabId },
  func: (t) => {
    return navigator.clipboard
      .writeText(String(t ?? ""))
      .then(() => ({
        ok: true,
        len: String(t ?? "").length,
        hasUserActivation: !!(navigator.userActivation && navigator.userActivation.isActive),
        isSecureContext: !!window.isSecureContext
      }))
      .catch((e) => ({
        ok: false,
        name: e?.name,
        message: String(e?.message || e),
        len: String(t ?? "").length,
        hasUserActivation: !!(navigator.userActivation && navigator.userActivation.isActive),
        isSecureContext: !!window.isSecureContext
      }));
  },
  args: [composed]
});

// ★ service worker（拡張のSW）側で見るログ
//console.log("executeScript raw:", results);
//console.log("clipboard result:", results?.[0]?.result);

    // 3) 短文なら ?q= で開く（長文はURLに入れない）
    const q = `貼り付けて送信してください。\n\n${composed}`;
    const encoded = encodeURIComponent(q);

    const targetUrl =
      encoded.length <= Q_PARAM_MAX_ENCODED_LEN
        ? `https://chatgpt.com/?temporary-chat=true&q=${encoded}`
        : "https://chatgpt.com/?temporary-chat=true";

    await chrome.tabs.create({ url: targetUrl, active: true });

    // 4) 案内
    if (encoded.length <= Q_PARAM_MAX_ENCODED_LEN) {
      notify("ChatGPTを開きました", "短文のため?q=で入力済みの可能性があります。必要なら確認して送信してください。");
    } else {
      notify("ChatGPTを開きました", "コピー済みです。ChatGPTの入力欄に貼り付けて送信してください。");
    }
  } catch (e) {
    console.error(e);
    notify("実行エラー", String(e?.message || e));
  }
}

async function copyOnPage(tabId, text) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (t) => {
        try {
          await navigator.clipboard.writeText(t);
          return true;
        } catch {
          return false;
        }
      },
      args: [text]
    });
    return !!result;
  } catch {
    return false;
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: title || "通知",
    message: message || ""
  }, () => void chrome.runtime.lastError);
}