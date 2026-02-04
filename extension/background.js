// chrome.runtime.onMessage.addListener(async (msg, sender) => {
//   if (msg.type === "ANALYZE") {
//     const res = await fetch("http://localhost:8080/analyze", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         text: msg.text,
//         cursor: msg.cursor
//       })
//     })

//     const data = await res.json()

//     chrome.tabs.sendMessage(sender.tab.id, {
//       type: "SUGGESTIONS",
//       suggestions: data.suggestions
//     })
//   }
// })


console.log("[Local Grammarly] background loaded")

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ANALYZE") {
    console.log("[BG] ANALYZE requestId=", msg.requestId, "text preview:", (msg.text || "").slice(0,200));
    // forward to local backend (try localhost then 127.0.0.1)
    (async () => {
      const endpoints = ["http://localhost:8080/analyze", "http://127.0.0.1:8080/analyze"];
      let lastErr = null;
      for (const url of endpoints) {
        try {
          console.log("[BG] calling backend:", url);
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: msg.text })
          });
          console.log("[BG] backend response status:", res.status);
          const data = await res.json();
          console.log("[BG] fetch result from", url, ":", data);
          sendResponse({ errors: Array.isArray(data.errors) ? data.errors : (data.errors || []), requestId: msg.requestId });
          return;
        } catch (e) {
          console.error("[BG] fetch to", url, "failed:", e);
          lastErr = e;
          // try next endpoint
        }
      }
      console.error("[BG] all backend endpoints failed:", lastErr);
      sendResponse({ errors: [], requestId: msg.requestId });
    })();
    // indicate we'll call sendResponse asynchronously
    return true;
  }
});

