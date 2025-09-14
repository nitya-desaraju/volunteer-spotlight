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

    const timestamp = new Date().toLocaleString();
    await updateSharePointSheet(token, 'meta', 'A1:B1', [['Last Updated:', timestamp]]);
    showStatus("Timestamp updated. Clearing old shift data...");
    await clearSharePointSheet(token, 'data', 'A:Z');
    showStatus("Old data cleared. Writing new data to sheet...");

    const sheetData = formatForExcel(events);
    await updateSharePointSheet(token, 'data', 'A:J', sheetData);
    chrome.runtime.sendMessage({ action: "scrapingComplete", data: { count: events.length } });

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
        await clearSharePointSheet(token, 'filter', 'A:Z');
        await chrome.storage.local.remove('savedFilters');
        showStatus("Filters cleared. Please set new filters if desired.");
    }

    chrome.runtime.sendMessage({ action: "showFilterOptions", data: { categories: newCategories } });
}

async function applyFiltersToSheet(categories) {
    const token = await getAuthToken();
    await clearSharePointSheet(token, 'filter', 'A:Z');
    
    //if no filters are applied, all categories will show 
    if (categories.length > 0) {
        const values = categories.map(category => [category]);
        await updateSharePointSheet(token, 'filter', 'A1', values);
    }
    
    chrome.runtime.sendMessage({ action: "filtersApplied" });
}

async function callGraphApi(endpoint, token, method = 'GET', body = null, contentType = 'application/json') {
    const headers = new Headers({ 'Authorization': `Bearer ${token}` });
    if (body) headers.append('Content-Type', contentType);

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, options);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Graph API error (${response.status}): ${error.error.message}`);
    }

    return response.status === 204 ? null : response.json();
}

// This new function is more reliable because it finds the site's unique ID first.
async function getDriveItemId(token) {
    if (driveItemIdCache) return driveItemIdCache;

    const { siteUrl, filePath } = SHAREPOINT_CONFIG;
    
    // The siteUrl is composed of two parts: the hostname and the server-relative path.
    const [hostname, sitePath] = siteUrl.split(':/');

    try {
        // Step 1: Get the unique Site ID using the hostname and path. This is a robust way to find the site.
        const siteInfoEndpoint = `/sites/${hostname}:/${sitePath}`;
        const siteInfo = await callGraphApi(siteInfoEndpoint, token);
        siteIdCache = siteInfo.id;
        
        if (!siteIdCache) {
            throw new Error("Could not retrieve the SharePoint Site ID.");
        }

        // Step 2: Use the Site ID and the file path to get the specific file's ID.
        const encodedFilePath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        const fileInfoEndpoint = `/sites/${siteIdCache}/drive/root:${encodedFilePath}`;
        
        const item = await callGraphApi(fileInfoEndpoint, token);
        driveIdCache = item.parentReference.driveId;
        if (!driveIdCache) {
            throw new Error("Could not retrieve the SharePoint Drive ID.");
        }

        driveItemIdCache = item.id;
        return driveItemIdCache;

    } catch (e) {
        // Provide a more detailed error message to help diagnose the issue.
        console.error("Full error details:", e);
        throw new Error(`Could not find the file on SharePoint. Please verify SHAREPOINT_CONFIG in background.js. The API error was: ${e.message}`);
    }
}

async function updateSharePointSheet(token, worksheet, range, values) {
    const itemId = await getDriveItemId(token);
    const endpoint = `/sites/${siteIdCache}/drives/${driveIdCache}/items/${itemId}/workbook/worksheets/${worksheet}/range(address='${range}')`;
    await callGraphApi(endpoint, token, 'PATCH', { values });
}

async function clearSharePointSheet(token, worksheet, range) {
    const itemId = await getDriveItemId(token);
    const endpoint = `/sites/${siteIdCache}/drives/${driveIdCache}/items/${itemId}/workbook/worksheets/${worksheet}/range(address='${range}')/clear`;
    await callGraphApi(endpoint, token, 'POST', {});
}

// --- PKCE Authentication Flow ---

// Helper function to generate a random string for the code verifier.
function generateCodeVerifier() {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return btoa(String.fromCharCode.apply(null, randomBytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

// Helper function to create a code challenge from the verifier.
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
        
        // Store the verifier to use it in the token exchange step.
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
        code_verifier: pkceCodeVerifier // PKCE parameter
    });
    
    const tokenData = await fetchMicrosoftToken(params);
    
    // Clean up the stored verifier after use.
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

// --- End of Authentication Flow ---

function formatForExcel(detailedEvents) {
    const header = ['Category', 'Activity', 'Date', 'Time', 'Open Shifts', 'Total Shifts', 'Details', 'Paw Level', 'Is Urgent', 'Animal'];
    const rows = detailedEvents.map(event => [event.title, event.detail, event.dateString, event.timeString, event.openingsAvailable, event.totalOpenings, event.activityLink, event.pawNumber, event.isVolunteerDependent, event.animalSpecificity || '']);
    
    return [header, ...rows];
}

function showStatus(message) {
    console.log("STATUS:", message); // Log status for debugging in the service worker
    chrome.runtime.sendMessage({ action: "updateStatus", data: message });
}

// This listener creates a stable popup window that doesn't close on focus loss,
// which is essential for the multi-window authentication flow to work reliably.
chrome.action.onClicked.addListener((tab) => {
    const popupUrl = chrome.runtime.getURL('popup.html');
  
    // Check if a popup window is already open to avoid creating duplicates.
    chrome.windows.getAll({ populate: true }, (windows) => {
        const existingPopup = windows.find((win) => {
            return win.type === 'popup' && win.tabs[0] && win.tabs[0].url === popupUrl;
        });

        if (existingPopup) {
            // If it exists, just focus on it.
            chrome.windows.update(existingPopup.id, { focused: true });
        } else {
            // Otherwise, create a new popup window.
            chrome.windows.create({
                url: 'popup.html',
                type: 'popup',
                width: 370,
                height: 480
            });
        }
    });
});