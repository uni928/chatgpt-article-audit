(() => {
  const title = document.title || "";
  const url = location.href;

  // できるだけ「ページ全体」寄り（記事だけに絞らない）
  const text = normalize(document.body?.innerText || "");

  return { title, url, text };

  function normalize(s) {
    return (s || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
})();