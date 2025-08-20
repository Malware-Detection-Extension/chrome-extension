// 첨부파일을 식별하는 선택자(selector)를 정의
const ATTACHMENT_SELECTORS = 'li a.file_link';

// 스캔 버튼의 CSS 스타일을 정의합니다.
const SCAN_BUTTON_CSS = `
  .scan-button {
    margin-left: 10px;
    padding: 5px 10px;
    background-color: #4285F4;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: bold;
    display: inline-flex;
    align-items: center;
    transition: background-color 0.2s;
  }
  .scan-button:hover {
    background-color: #357ae8;
  }
  .scan-icon {
    margin-right: 5px;
  }
  .scan-status-icon {
    margin-left: 5px;
    font-size: 16px;
  }
  .scan-status-icon.success {
    color: #34A853; /* Google green */
  }
  .scan-status-icon.failure {
    color: #EA4335; /* Google red */
  }
  .scan-status-icon.loading {
    color: #FBB03B; /* Google yellow */
  }
`;

function addScanButtonToPage() {
    // 이미 스캔 버튼이 추가되었는지 확인
    if (document.querySelector('.scan-button-container')) {
        return;
    }

    // 네이버 메일 첨부파일의 공통 클래스인 'file_attachments'를 사용하여 영역을 찾습니다.
    const attachmentListArea = document.querySelector('div.file_attachments');
    if (!attachmentListArea) {
        return;
    }
    
    // 버튼 컨테이너 생성 및 추가
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'scan-button-container';
    buttonContainer.style.display = 'inline-block';
    buttonContainer.style.marginLeft = '15px';
    
    const scanButton = document.createElement('button');
    scanButton.className = 'scan-button';
    scanButton.innerHTML = `<span class="scan-icon">🔍</span> 첨부파일 모두 스캔`;

    buttonContainer.appendChild(scanButton);
    attachmentListArea.prepend(buttonContainer); // 첨부파일 목록 위에 버튼을 추가

    // CSS 스타일을 페이지에 주입
    const styleSheet = document.createElement("style");
    styleSheet.type = "text/css";
    styleSheet.innerText = SCAN_BUTTON_CSS;
    document.head.appendChild(styleSheet);

    scanButton.addEventListener('click', handleScanButtonClick);
}

// 스캔 버튼 클릭 시 실행되는 함수
async function handleScanButtonClick() {
    const scanButton = document.querySelector('.scan-button');
    scanButton.disabled = true;
    scanButton.innerHTML = `<span class="scan-icon">⏳</span> 스캔 중...`;

    const attachmentLinks = document.querySelectorAll(ATTACHMENT_SELECTORS);
    const urlsToScan = Array.from(attachmentLinks).map(link => {
        return link.href;
    }).filter(url => url);

    if (urlsToScan.length === 0) {
        alert("스캔할 첨부파일이 없습니다.");
        scanButton.disabled = false;
        scanButton.innerHTML = `<span class="scan-icon">🔍</span> 첨부파일 모두 스캔`;
        return;
    }

    // 백그라운드 스크립트로 스캔 요청을 보냅니다.
    const response = await chrome.runtime.sendMessage({
        action: "scan_attachments",
        urls: urlsToScan
    });

    // 백그라운드 스크립트로부터 받은 결과를 바탕으로 UI를 업데이트합니다.
    updateUIWithScanResults(response.results);

    scanButton.disabled = false;
    scanButton.innerHTML = `<span class="scan-icon">🔍</span> 첨부파일 스캔 완료`;
}

// 스캔 결과에 따라 첨부파일 옆에 아이콘을 표시하는 함수
function updateUIWithScanResults(results) {
    const attachmentLinks = document.querySelectorAll(ATTACHMENT_SELECTORS);

    // URL의 쿼리 파라미터를 정규화하는 헬퍼 함수
    const normalizeUrl = (url) => {
        try {
            const urlObj = new URL(url);
            urlObj.searchParams.sort();
            return urlObj.toString();
        } catch (e) {
            return url;
        }
    };

    // results 객체의 키(URL)를 순회하며 UI를 업데이트합니다.
    for (const fileUrl in results) {
        if (results.hasOwnProperty(fileUrl)) {
            const result = results[fileUrl];
            
            // 정규화된 URL을 사용하여 해당 첨부파일 링크를 찾습니다.
            const normalizedFileUrl = normalizeUrl(fileUrl);
            const link = Array.from(attachmentLinks).find(link => normalizeUrl(link.href) === normalizedFileUrl);

            if (link) {
                // 기존 아이콘이 있다면 제거
                const existingIcon = link.querySelector('.scan-status-icon');
                if (existingIcon) {
                    existingIcon.remove();
                }

                const statusIcon = document.createElement('span');
                statusIcon.className = 'scan-status-icon';

                if (result.is_malicious === true) {
                    statusIcon.textContent = '✖';
                    statusIcon.classList.add('failure');
                    link.appendChild(statusIcon);
                } else if (result.is_malicious === false) {
                    statusIcon.textContent = '✔';
                    statusIcon.classList.add('success');
                    link.appendChild(statusIcon);
                } else {
                    // 스캔 실패 또는 결과가 없을 경우
                    statusIcon.textContent = '❓';
                    statusIcon.classList.add('loading');
                    link.appendChild(statusIcon);
                }
            }
        }
    }
}

// 페이지 로드 및 변경 시 스캔 버튼을 추가하기 위해 DOM 변경을 감지
const observer = new MutationObserver(addScanButtonToPage);
const config = { childList: true, subtree: true };

// 메인 콘텐츠 영역을 관찰
const mainContent = document.querySelector('body');
if (mainContent) {
    observer.observe(mainContent, config);
}