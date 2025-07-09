const pendingUrls = new Set();

chrome.downloads.onCreated.addListener(async (downloadItem) => {
    const url = downloadItem.url;

    const parsedUrl = new URL(url);
    const filenameFromUrl = parsedUrl.pathname.split('/').pop() || "downloaded.bin";
    const filename = downloadItem.filename || filenameFromUrl;

    if (pendingUrls.has(url) || url.includes("safe_download")) return;
    pendingUrls.add(url);

    console.log("[+] 다운로드 감지:", url);

    chrome.downloads.cancel(downloadItem.id, () => {
        chrome.downloads.erase({ id: downloadItem.id });
    });

    try {
        const response = await fetch("http://localhost:5000/report_download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, filename })
        });

        const result = await response.json();

        if (result.is_malicious) {
            chrome.notifications.create({
                type: "basic",
                iconUrl: "icon.png",
                title: "🚫 다운로드 차단됨",
                message: `${filename} 은(는) 악성으로 판별되었습니다.`
            });
        } else {
            const downloadSafeUrl = `http://localhost:5000/safe_download/${encodeURIComponent(result.filename)}`;
            chrome.downloads.download({ url: downloadSafeUrl, filename: result.filename });
        }

    } catch (err) {
        console.error("❌ 서버 통신 실패. 다운로드 차단:", err.message);
        chrome.notifications.create({
            type: "basic",
            iconUrl: "icon.png",
            title: "⚠️ 서버 오류",
            message: "파일 검사 중 오류가 발생했습니다. 다운로드가 차단됩니다."
        });
    } finally {
        pendingUrls.delete(url);
    }
});
