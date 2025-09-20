// SharePoint and MS Graph API Configuration
const MSAL_CONFIG = {
    clientId: "ebded869-b78e-4bdc-8fe5-d7ba06c0a2c3",
    tenantId: "286fdf40-8322-4ac4-b029-c3387afb2971",
    scopes: ["Files.ReadWrite", "Sites.ReadWrite.All", "offline_access"]
};
const SHAREPOINT_CONFIG = {
    siteUrl: "operationkindness.sharepoint.com:/sites/Volunteers",
    filePath: "/Spotlight Data/Book.xlsx"
};
let driveItemIdCache = null;
let driveIdCache = null;
let siteIdCache = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    //authenticating before scraping from the fix in popup
    if (request.action === "checkAuth") {
        (async () => {
            try {
                await getAuthToken();
                sendResponse({ status: "success" });
            } catch (error) {
                sendResponse({ status: "error", message: error.message });
            }
        })();
        return true;
    }

    if (request.action === "processEvents") {
        uploadToSheet(request.data.events);
        return true; 
    }
    if (request.action === "applyFilters") {
        applyFiltersToSheet(request.data.selectedCategories);
        return true;
    }
});

async function uploadToSheet(events) {
    //shown in popup
    showStatus(`Processed ${events.length} shifts. Updating timestamp...`);
    const token = await getAuthToken();
    const sessionId = await createWorkbookSession(token);

    try {
        const timestamp = new Date().toLocaleString();
        await updateSharePointSheet(token, 'meta', 'A1:B1', [['Last Updated:', timestamp]], sessionId);
        showStatus("Timestamp updated. Clearing old shift data...");
        await clearSharePointSheet(token, 'data', 'A:Z', sessionId);
        showStatus("Old data cleared. Writing new data to sheet...");

        const sheetData = formatForExcel(events);
        // Writing to a specific range is much faster than a full column range like A:J
        const targetRange = `A1:${String.fromCharCode(65 + sheetData[0].length - 1)}${sheetData.length}`;
        await updateSharePointSheet(token, 'data', targetRange, sheetData, sessionId);
        chrome.runtime.sendMessage({ action: "scrapingComplete", data: { count: events.length } });

    } finally {
        await closeWorkbookSession(token, sessionId);
    }

    const categoriesSet = new Set();
    for (const e of events) categoriesSet.add(e.title);
    const newCategories = Array.from(categoriesSet).sort();
    const newCategoriesSet = new Set(newCategories);
    const { savedFilters } = await chrome.storage.local.get('savedFilters');
    let filtersValid = true;

    //fixing saved filters not erasing from sheets if no longer present in the shifts
    if (savedFilters && savedFilters.length > 0) {
        for (const savedCategory of savedFilters) {
            if (!newCategoriesSet.has(savedCategory)) {
                filtersValid = false;
                break;
            }
        }
    }

    if (!filtersValid) {
        showStatus("Outdated filters found, clearing them...");
        // This requires a separate session as it's outside the main data upload flow
        await applyFiltersToSheet([]); 
        await chrome.storage.local.remove('savedFilters');
        showStatus("Filters cleared. Please set new filters if desired.");
    }

    chrome.runtime.sendMessage({ action: "showFilterOptions", data: { categories: newCategories } });
}

async function applyFiltersToSheet(categories) {
    const token = await getAuthToken();
    const sessionId = await createWorkbookSession(token);
    try {
        await clearSharePointSheet(token, 'filter', 'A:Z', sessionId);
        
        //if no filters are applied, all categories will show 
        if (categories.length > 0) {
            const values = categories.map(category => [category]);
            // **FIX:** Calculate the exact range needed for the filters.
            const targetRange = `A1:A${categories.length}`;
            // **FIX:** Use the new targetRange instead of just 'A'.
            await updateSharePointSheet(token, 'filter', targetRange, values, sessionId);
        }
    } finally {
        await closeWorkbookSession(token, sessionId);
    }
    
    chrome.runtime.sendMessage({ action: "filtersApplied" });
}

async function callGraphApi(endpoint, token, method = 'GET', body = null, sessionId = null) {
    const headers = new Headers({ 'Authorization': `Bearer ${token}` });
    if (sessionId) {
        headers.append('workbook-session-id', sessionId);
    }
    if (method !== 'GET') {
        headers.append('Content-Type', 'application/json');
    }

    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, options);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Graph API error (${response.status}): ${error.error.message}`);
    }

    return response.status === 204 ? null : response.json();
}

async function getDriveItemId(token) {
    if (driveItemIdCache) return;

    const { siteUrl, filePath } = SHAREPOINT_CONFIG;
    const [hostname, sitePath] = siteUrl.split(':/');

    try {
        const siteInfoEndpoint = `/sites/${hostname}:/${sitePath}`;
        const siteInfo = await callGraphApi(siteInfoEndpoint, token);
        siteIdCache = siteInfo.id;
        
        const encodedFilePath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        const fileInfoEndpoint = `/sites/${siteIdCache}/drive/root:${encodedFilePath}`;
        
        const item = await callGraphApi(fileInfoEndpoint, token);
        driveIdCache = item.parentReference.driveId;
        driveItemIdCache = item.id;

    } catch (e) {
        console.error("Full error details:", e);
        throw new Error(`Could not find the file on SharePoint. Please verify SHAREPOINT_CONFIG in background.js. The API error was: ${e.message}`);
    }
}

async function createWorkbookSession(token) {
    await getDriveItemId(token);
    const endpoint = `/sites/${siteIdCache}/drives/${driveIdCache}/items/${driveItemIdCache}/workbook/createSession`;
    const response = await callGraphApi(endpoint, token, 'POST', { persistChanges: true });
    return response.id;
}

async function closeWorkbookSession(token, sessionId) {
    await getDriveItemId(token);
    const endpoint = `/sites/${siteIdCache}/drives/${driveIdCache}/items/${driveItemIdCache}/workbook/closeSession`;
    await callGraphApi(endpoint, token, 'POST', {}, sessionId);
}

async function updateSharePointSheet(token, worksheet, range, values, sessionId) {
    await getDriveItemId(token);
    const endpoint = `/sites/${siteIdCache}/drives/${driveIdCache}/items/${driveItemIdCache}/workbook/worksheets/${worksheet}/range(address='${range}')`;
    await callGraphApi(endpoint, token, 'PATCH', { values }, sessionId);
}

async function clearSharePointSheet(token, worksheet, range, sessionId) {
    await getDriveItemId(token);
    const endpoint = `/sites/${siteIdCache}/drives/${driveIdCache}/items/${driveItemIdCache}/workbook/worksheets/${worksheet}/range(address='${range}')/clear`;
    await callGraphApi(endpoint, token, 'POST', {}, sessionId);
}

// --- PKCE Authentication Flow ---
function generateCodeVerifier() {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return btoa(String.fromCharCode.apply(null, randomBytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function getAuthToken() {
    return new Promise(async (resolve, reject) => {
        const { tokenData } = await chrome.storage.local.get('tokenData');
        const now = Date.now();

        if (tokenData && tokenData.expires_at > now) return resolve(tokenData.access_token);
        if (tokenData && tokenData.refresh_token) {
            try {
                const refreshed = await refreshMicrosoftToken(tokenData.refresh_token);
                return resolve(refreshed.access_token);
            } catch (error) { /* fall through to interactive login */ }
        }

        const redirectUri = chrome.identity.getRedirectURL();
        console.log("My extension's redirect URI is:", redirectUri);

        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        
        await chrome.storage.local.set({ pkceCodeVerifier: codeVerifier });

        const authUrl = `https://login.microsoftonline.com/${MSAL_CONFIG.tenantId}/oauth2/v2.0/authorize?` +
            new URLSearchParams({
                client_id: MSAL_CONFIG.clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                response_mode: 'query',
                scope: MSAL_CONFIG.scopes.join(' '),
                prompt: 'select_account',
                code_challenge: codeChallenge,
                code_challenge_method: 'S256'
            }).toString();

        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (responseUrl) => {
            if (chrome.runtime.lastError || !responseUrl) {
                return reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "Auth flow cancelled."));
            }
            const code = new URL(responseUrl).searchParams.get('code');
            if (!code) return reject(new Error("Auth code not found in response."));
            try {
                const newTokens = await redeemCodeForTokens(code, redirectUri);
                resolve(newTokens.access_token);
            } catch (tokenError) {
                reject(tokenError);
            }
        });
    });
}

async function redeemCodeForTokens(code, redirectUri) {
    const { pkceCodeVerifier } = await chrome.storage.local.get('pkceCodeVerifier');
    if (!pkceCodeVerifier) {
        throw new Error("PKCE code_verifier not found.");
    }
    
    const params = new URLSearchParams({
        client_id: MSAL_CONFIG.clientId,
        scope: MSAL_CONFIG.scopes.join(' '),
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: pkceCodeVerifier
    });
    
    const tokenData = await fetchMicrosoftToken(params);
    
    await chrome.storage.local.remove('pkceCodeVerifier');
    
    return tokenData;
}

async function refreshMicrosoftToken(refreshToken) {
    const params = new URLSearchParams({
        client_id: MSAL_CONFIG.clientId,
        scope: MSAL_CONFIG.scopes.join(' '),
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
    });
    return await fetchMicrosoftToken(params);
}

async function fetchMicrosoftToken(body) {
    const response = await fetch(`https://login.microsoftonline.com/${MSAL_CONFIG.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 400) await chrome.storage.local.remove('tokenData');
        throw new Error(`Token fetch error: ${errorData.error_description}`);
    }
    const data = await response.json();
    const tokenData = { ...data, expires_at: Date.now() + (data.expires_in * 1000) };
    await chrome.storage.local.set({ tokenData });
    return tokenData;
}

function formatForExcel(detailedEvents) {
    const header = ['Category', 'Activity', 'Date', 'Time', 'Open Shifts', 'Total Shifts', 'Details', 'Paw Level', 'Is Urgent', 'Animal'];
    const rows = detailedEvents.map(event => [event.title, event.detail, event.dateString, event.timeString, event.openingsAvailable, event.totalOpenings, event.activityLink, event.pawNumber, event.isVolunteerDependent, event.animalSpecificity || '']);
    
    return [header, ...rows];
}

function showStatus(message) {
    console.log("STATUS:", message); 
    chrome.runtime.sendMessage({ action: "updateStatus", data: message });
}

chrome.action.onClicked.addListener((tab) => {
    const popupUrl = chrome.runtime.getURL('popup.html');
  
    chrome.windows.getAll({ populate: true }, (windows) => {
        const existingPopup = windows.find((win) => {
            return win.type === 'popup' && win.tabs[0] && win.tabs[0].url === popupUrl;
        });

        if (existingPopup) {
            chrome.windows.update(existingPopup.id, { focused: true });
        } else {
            chrome.windows.create({
                url: 'popup.html',
                type: 'popup',
                width: 370,
                height: 480
            });
        }
    });
});