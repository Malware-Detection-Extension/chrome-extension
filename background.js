// background.js

const SERVER_URL = "your-server-url:port";

const urlsUnderAnalysis = new Set();
const urlsToSkipNextOnCreated = new Set();

function sanitizeFilename(filename) {
    if (!filename) {
	// default file name
        return "download.bin";
    }

    let sanitized = filename.replace(/\\/g, '/');
    sanitized = sanitized.split('/').pop();

    // remove unacceptable characters
    sanitized = sanitized.replace(/[\\:*?"<>|]/g, '');

    // default file name
    if (sanitized.trim() === '') {
        return "download.bin";
    }
    return sanitized;
}

// helper function that extracts reasonable source file name
async function getBestOriginalFilename(downloadItem) {

    // file name provided by Chrome
    if (downloadItem.filename && downloadItem.filename.trim() !== '') {
        let filename = downloadItem.filename.split('/').pop();
        filename = filename.split('\\').pop();
        console.log(`[DEBUG] Filename from downloadItem.filename: ${filename}`);
        return filename;
    }

    // attempt to extract the file name from the Content-Disposition header through a HEAD request
    try {
        const urlObj = new URL(downloadItem.url);
        const headResponse = await fetch(urlObj.href, { method: 'HEAD', mode: 'no-cors' });
        const contentDisposition = headResponse.headers.get('Content-Disposition');

        if (contentDisposition) {
            // pattern detection
            const filenameMatch = /filename\*?=['"]?(?:UTF-8''|[^;]*?)([^;]+?)(?:;|$)/i.exec(contentDisposition);

            if (filenameMatch && filenameMatch[1]) {
                try {
                    // decode the encoded file name
                    let decodedFilename = decodeURIComponent(filenameMatch[1].replace(/^utf-8''/i, ''));
                    decodedFilename = decodedFilename.replace(/^["']|["']$/g, '');
                    console.log(`[DEBUG] Filename from Content-Disposition header: ${decodedFilename}`);
                    return decodedFilename;
                } catch (e) {
                    console.warn("Failed to decode filename from Content-Disposition header:", filenameMatch[1], e);
                }
            }
        }
    } catch (e) {
	// continue to URL parsing if the HEAD request fails
        console.warn("Error during HEAD request for Content-Disposition:", e);
    }

    // attempt to extract the file name from the URL path if the file name is not present
    try {
        const urlObj = new URL(downloadItem.url);
        let filenameFromUrl = urlObj.pathname.split('/').pop();

        // use if the file name extracted from the URL path is valid
        if (filenameFromUrl && filenameFromUrl.trim() !== '' && filenameFromUrl.indexOf('.') > 0) {
            console.log(`[DEBUG] Filename from URL pathname: ${filenameFromUrl}`);
            return filenameFromUrl;
        }

        // attempt to extract filename=... from URL query parameters
        const filenameParamMatch = /[?&]filename=([^&]+)/.exec(urlObj.search);
        if (filenameParamMatch && filenameParamMatch[1]) {
            try {
                const decodedParamFilename = decodeURIComponent(filenameParamMatch[1]);
                console.log(`[DEBUG] Filename from URL parameter: ${decodedParamFilename}`);
                return decodedParamFilename;
            } catch (e) {
                console.warn("Failed to decode filename from URL parameter:", filenameParamMatch[1], e);
            }
        }

        // alternate file name based on hostname
        if (urlObj.hostname && urlObj.hostname.trim() !== '') {
            const hostnameFilename = urlObj.hostname.replace(/\./g, '_') + ".bin";
            console.log(`[DEBUG] Filename from hostname fallback: ${hostnameFilename}`);
            return hostnameFilename;
        }

    } catch (e) {
        console.error("Error parsing URL for filename derivation (fallback):", e);
    }

    // default
    console.log(`[DEBUG] Using default filename: download.bin`);
    return "download.bin";
}


// event listener for each download attempt
chrome.downloads.onCreated.addListener(async (downloadItem) => {
    const originalUrl = downloadItem.url;
  
    // extraction of the most appropriate source file name from downloadItem
    const bestOriginalFilename = await getBestOriginalFilename(downloadItem);

    // infinite loop protection
    if (urlsToSkipNextOnCreated.has(originalUrl)) {
        urlsToSkipNextOnCreated.delete(originalUrl);
        console.log(`[DEBUG] 확장 프로그램이 시작한 재다운로드: ${originalUrl}. 분석을 건너뜁니다.`);
        return;
    }

    // prevent duplicate processing
    if (urlsUnderAnalysis.has(originalUrl)) {
        console.log(`[DEBUG] 이미 분석 진행 중: ${originalUrl}. 중복 요청을 무시합니다.`);
        return;
    }

    // prevent duplicate requests
    urlsUnderAnalysis.add(originalUrl);

    console.log("[+] 다운로드 감지:", originalUrl);

    // cancel downloads (file interception)
    chrome.downloads.cancel(downloadItem.id, () => {
        chrome.downloads.erase({ id: downloadItem.id });
        console.log(`[DEBUG] 브라우저의 원본 다운로드 취소 및 제거됨: ${originalUrl}`);
    });

    let filenameToSendToServer = bestOriginalFilename;

    try {
	// send URL, file name to server
        console.log("[DEBUG] 서버 분석 요청 시작:", originalUrl);
        const response = await fetch(`${SERVER_URL}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: originalUrl, filename: filenameToSendToServer })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.message || result.error || '서버 오류가 발생했습니다.');
        }

        // processing server response
        if (result.is_malicious) {
            console.log(`[!] 악성 파일 탐지됨: ${bestOriginalFilename}`);
            chrome.notifications.create({
                type: "basic",
                iconUrl: "icon.png", // 확장 프로그램 디렉토리에 icon.png 파일이 있어야 합니다.
                title: "🚫 다운로드 차단됨",
                message: `${bestOriginalFilename} 은(는) 악성으로 판별되었습니다.`
            });
        } else {
	    // start the re-download directly from the source URL if the file is determined to be secure
            console.log(`[+] 안전한 파일. 원본 URL에서 재다운로드 시작: ${originalUrl}`);
            urlsToSkipNextOnCreated.add(originalUrl);

            const finalDownloadFilenameForClient = sanitizeFilename(bestOriginalFilename);
            console.log(`[DEBUG] 재다운로드 시도 - 원본 파일명 (추정): "${bestOriginalFilename}", 최종 다운로드 파일명 (로컬 PC): "${finalDownloadFilenameForClient}"`);

            chrome.downloads.download({ url: originalUrl, filename: finalDownloadFilenameForClient }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    // handling re-download errors
                    console.error(`[!] 재다운로드 시작 오류: ${chrome.runtime.lastError.message}`);
                    urlsToSkipNextOnCreated.delete(originalUrl);
                    chrome.notifications.create({
                        type: "basic",
                        iconUrl: "icon.png",
                        title: "⚠️ 다운로드 재개 실패",
                        message: `${bestOriginalFilename} 파일 다운로드 재개에 실패했습니다. 수동으로 시도해주세요.`
                    });
                } else {
                    console.log(`[DEBUG] 재다운로드 시작됨 (ID: ${downloadId})`);
                    chrome.notifications.create({
                        type: "basic",
                        iconUrl: "icon.png",
                        title: "✅ 다운로드 허용됨",
                        message: `${bestOriginalFilename} 은(는) 안전한 파일입니다. 다운로드를 재개합니다.`
                    });
                }
            });
        }

    } catch (err) {
        // server communication failure or error during analysis
        console.error("❌ 서버 통신 실패 또는 분석 오류. 다운로드 차단:", err.message);
        chrome.notifications.create({
            type: "basic",
            iconUrl: "icon.png",
            title: "⚠️ 서버 오류",
            message: `파일 검사 중 오류가 발생했습니다 (${bestOriginalFilename}). 다운로드가 차단됩니다.`
        });
    } finally {
        // remove the URL from the list when communication with the server is complete
        urlsUnderAnalysis.delete(originalUrl);
        console.log(`[DEBUG] urlsUnderAnalysis 목록 정리 완료: ${originalUrl}`);
    }
});
