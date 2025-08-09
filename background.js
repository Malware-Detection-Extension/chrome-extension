// background.js

// Flask 서버의 URL (분석 요청을 보낼 주소)
const SERVER_URL = "http://165.246.34.137:8080";

// 현재 서버로 분석 요청이 진행 중인 URL들을 저장하는 Set
// 이 Set에 있는 URL은 중복 분석을 방지합니다.
const urlsUnderAnalysis = new Set();

// 확장 프로그램이 직접 재다운로드를 시작한 URL들을 저장하는 Set
// 이 Set에 있는 URL은 onCreated 이벤트가 다시 발생해도 분석을 건너뛰도록 합니다.
const urlsToSkipNextOnCreated = new Set();

/**
 * 파일 이름을 안전하게 정제하는 함수.
 * 파일 시스템에서 허용되지 않는 문자를 제거하고, 경로 요소를 제거하여 순수 파일명만 남깁니다.
 * @param {string} filename 원본 파일 이름
 * @returns {string} 정제된 파일 이름
 */
function sanitizeFilename(filename) {
    if (!filename) {
        return "download.bin"; // 파일명이 없는 경우 기본값
    }
    // 경로 구분자 제거 (Windows: \, Linux/macOS: /)
    let sanitized = filename.replace(/\\/g, '/'); // 모든 역슬래시를 슬래시로 통일
    sanitized = sanitized.split('/').pop(); // 마지막 경로 요소(파일명)만 추출

    // 파일 시스템에서 허용되지 않는 문자 제거 (Windows/Linux 공통으로 문제될 수 있는 문자)
    // : ? * " < > | / \ (슬래시는 이미 위에서 처리됨)
    // 추가적으로 제어 문자, 유니코드 공백 등도 고려할 수 있지만, 여기서는 일반적인 경우만 처리
    sanitized = sanitized.replace(/[\\:*?"<>|]/g, '');

    // 파일명이 비어있게 될 경우 기본값 반환
    if (sanitized.trim() === '') {
        return "download.bin";
    }
    return sanitized;
}

/**
 * downloadItem에서 가장 합리적인 원본 파일명을 추출하는 헬퍼 함수.
 * downloadItem.filename이 없거나 유효하지 않을 경우 URL에서 추출을 시도합니다.
 * Content-Disposition 헤더를 먼저 확인하여 가장 정확한 파일명을 얻으려 시도합니다.
 * @param {chrome.downloads.DownloadItem} downloadItem
 * @returns {Promise<string>} 추출된 최적의 파일명 (비동기)
 */
async function getBestOriginalFilename(downloadItem) {
    // 1. Chrome이 제공하는 downloadItem.filename을 우선적으로 사용
    if (downloadItem.filename && downloadItem.filename.trim() !== '') {
        // Chrome의 filename에 경로 정보가 포함될 수 있으므로, 마지막 부분만 추출
        let filename = downloadItem.filename.split('/').pop();
        filename = filename.split('\\').pop();
        console.log(`[DEBUG] Filename from downloadItem.filename: ${filename}`);
        return filename;
    }

    // 2. HEAD 요청을 통해 Content-Disposition 헤더에서 파일명 추출 시도
    try {
        const urlObj = new URL(downloadItem.url);
        // cross-origin HEAD 요청을 위해 'no-cors' 모드 사용
        // 'no-cors' 모드에서는 응답 헤더에 직접 접근하기 어려울 수 있으나,
        // Content-Disposition은 특정 상황에서 노출될 수 있습니다.
        // 만약 'no-cors'로 헤더 접근이 안되면, 서버에서 CORS 허용이 필요합니다.
        // 여기서는 최선을 다해 시도합니다.
        const headResponse = await fetch(urlObj.href, { method: 'HEAD', mode: 'no-cors' });

        // Content-Disposition 헤더는 보안상의 이유로 'no-cors' 모드에서 직접 접근이 제한될 수 있습니다.
        // 하지만 일부 서버는 이를 노출하기도 하며, 브라우저 내부적으로는 처리될 수 있습니다.
        // 여기서는 일단 시도하고, 실패하면 다음 단계로 넘어갑니다.
        const contentDisposition = headResponse.headers.get('Content-Disposition');
        if (contentDisposition) {
            // Content-Disposition 헤더에서 filename*=UTF-8''filename.ext 또는 filename="filename.ext" 패턴을 찾음
            const filenameMatch = /filename\*?=['"]?(?:UTF-8''|[^;]*?)([^;]+?)(?:;|$)/i.exec(contentDisposition);
            if (filenameMatch && filenameMatch[1]) {
                try {
                    // URL-encoded 또는 UTF-8 인코딩된 파일명 디코딩
                    let decodedFilename = decodeURIComponent(filenameMatch[1].replace(/^utf-8''/i, ''));
                    // 따옴표 제거
                    decodedFilename = decodedFilename.replace(/^["']|["']$/g, '');
                    console.log(`[DEBUG] Filename from Content-Disposition header: ${decodedFilename}`);
                    return decodedFilename;
                } catch (e) {
                    console.warn("Failed to decode filename from Content-Disposition header:", filenameMatch[1], e);
                }
            }
        }
    } catch (e) {
        console.warn("Error during HEAD request for Content-Disposition:", e);
        // HEAD 요청 실패 시 URL 파싱으로 계속 진행
    }

    // 3. filename이 없는 경우 URL 경로에서 파일명 추출 시도
    try {
        const urlObj = new URL(downloadItem.url);
        let filenameFromUrl = urlObj.pathname.split('/').pop();

        // URL 경로에서 추출된 파일명이 유효한 경우 (확장자 포함) 사용
        if (filenameFromUrl && filenameFromUrl.trim() !== '' && filenameFromUrl.indexOf('.') > 0) {
            console.log(`[DEBUG] Filename from URL pathname: ${filenameFromUrl}`);
            return filenameFromUrl;
        }

        // 4. URL 쿼리 파라미터에서 filename=... 추출 시도
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

        // 5. 마지막으로 hostname을 기반으로 한 대체 파일명
        if (urlObj.hostname && urlObj.hostname.trim() !== '') {
            const hostnameFilename = urlObj.hostname.replace(/\./g, '_') + ".bin";
            console.log(`[DEBUG] Filename from hostname fallback: ${hostnameFilename}`);
            return hostnameFilename;
        }

    } catch (e) {
        console.error("Error parsing URL for filename derivation (fallback):", e);
    }

    // 6. 모든 시도 실패 시 최종 기본값
    console.log(`[DEBUG] Using default filename: download.bin`);
    return "download.bin";
}


// 다운로드가 생성될 때마다 발생하는 이벤트 리스너
chrome.downloads.onCreated.addListener(async (downloadItem) => {
    const originalUrl = downloadItem.url; // 다운로드하려는 파일의 원본 URL
    // downloadItem에서 가장 적절한 원본 파일명을 비동기로 추출
    const bestOriginalFilename = await getBestOriginalFilename(downloadItem); // await 추가

    // --- 핵심 로직: 무한 루프 방지 ---
    // 1. 만약 이 URL이 '건너뛸' 목록에 있다면, 이는 우리가 재다운로드를 시작한 것이므로
    //    다시 서버로 분석 요청을 보내지 않고 다운로드를 진행시킵니다.
    if (urlsToSkipNextOnCreated.has(originalUrl)) {
        urlsToSkipNextOnCreated.delete(originalUrl); // 한 번 건너뛰었으니 목록에서 제거
        console.log(`[DEBUG] 확장 프로그램이 시작한 재다운로드: ${originalUrl}. 분석을 건너뜁니다.`);
        return; // 추가 분석 없이 다운로드를 허용하고 함수 종료
    }
    // --- 무한 루프 방지 로직 끝 ---

    // 2. 이미 분석 중인 URL이라면 중복 처리 방지
    if (urlsUnderAnalysis.has(originalUrl)) {
        console.log(`[DEBUG] 이미 분석 진행 중: ${originalUrl}. 중복 요청을 무시합니다.`);
        return;
    }

    // 3. 이 URL을 분석 중인 목록에 추가하여 중복 요청을 방지합니다.
    urlsUnderAnalysis.add(originalUrl);

    console.log("[+] 다운로드 감지:", originalUrl);

    // 4. 브라우저가 시작한 오리지널 다운로드를 취소하고 제거합니다.
    //    이는 우리가 파일을 가로채서 먼저 분석하기 위함입니다.
    chrome.downloads.cancel(downloadItem.id, () => {
        chrome.downloads.erase({ id: downloadItem.id });
        console.log(`[DEBUG] 브라우저의 원본 다운로드 취소 및 제거됨: ${originalUrl}`);
    });

    // 5. 서버로 보낼 파일명 결정 (이 이름은 서버 내부에서만 사용될 것임)
    // 서버는 이 이름을 기반으로 고유한 safe_filename을 생성할 것임.
    // 서버로 보낼 때는 bestOriginalFilename을 그대로 사용합니다.
    let filenameToSendToServer = bestOriginalFilename;

    try {
        console.log("[DEBUG] 서버 분석 요청 시작:", originalUrl);
        // 6. 서버로 파일 분석 요청 전송
        const response = await fetch(`${SERVER_URL}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: originalUrl, filename: filenameToSendToServer }) // 원본 URL과 파일명을 서버로 전송
        });

        const result = await response.json();

        if (!response.ok) { // 서버에서 오류 응답 (HTTP status code 4xx, 5xx)
            throw new Error(result.message || result.error || '서버 오류가 발생했습니다.');
        }

        // 7. 서버 응답 처리
        if (result.is_malicious) {
            console.log(`[!] 악성 파일 탐지됨: ${bestOriginalFilename}`);
            chrome.notifications.create({
                type: "basic",
                iconUrl: "icon.png", // 확장 프로그램 디렉토리에 icon.png 파일이 있어야 합니다.
                title: "🚫 다운로드 차단됨",
                message: `${bestOriginalFilename} 은(는) 악성으로 판별되었습니다.`
            });
        } else {
            console.log(`[+] 안전한 파일. 원본 URL에서 재다운로드 시작: ${originalUrl}`);
            // 8. 파일이 안전하다고 판단되면, 원본 URL에서 직접 재다운로드를 시작합니다.
            //    이 다운로드는 위의 'urlsToSkipNextOnCreated' 로직에 의해 다시 분석되지 않습니다.
            urlsToSkipNextOnCreated.add(originalUrl); // 다음 onCreated 이벤트에서 건너뛰도록 표시

            // **사용자의 로컬 PC에는 getBestOriginalFilename으로 추출한 후 정제된 파일명을 사용합니다.**
            const finalDownloadFilenameForClient = sanitizeFilename(bestOriginalFilename);
            console.log(`[DEBUG] 재다운로드 시도 - 원본 파일명 (추정): "${bestOriginalFilename}", 최종 다운로드 파일명 (로컬 PC): "${finalDownloadFilenameForClient}"`);

            chrome.downloads.download({ url: originalUrl, filename: finalDownloadFilenameForClient }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    // 재다운로드 시작 실패 시 오류 처리
                    console.error(`[!] 재다운로드 시작 오류: ${chrome.runtime.lastError.message}`);
                    urlsToSkipNextOnCreated.delete(originalUrl); // 실패했으니 건너뛸 목록에서 제거
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
        // 9. 서버 통신 실패 또는 분석 중 오류 발생 시
        console.error("❌ 서버 통신 실패 또는 분석 오류. 다운로드 차단:", err.message);
        chrome.notifications.create({
            type: "basic",
            iconUrl: "icon.png",
            title: "⚠️ 서버 오류",
            message: `파일 검사 중 오류가 발생했습니다 (${bestOriginalFilename}). 다운로드가 차단됩니다.`
        });
    } finally {
        // 10. 서버와의 통신이 완료되면 분석 중인 목록에서 URL을 제거합니다.
        urlsUnderAnalysis.delete(originalUrl);
        console.log(`[DEBUG] urlsUnderAnalysis 목록 정리 완료: ${originalUrl}`);
    }
});
