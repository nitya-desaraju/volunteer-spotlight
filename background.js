// SharePoint and MS Graph API Configuration
const MSAL_CONFIG = {
    clientId: "ebded869-b78e-4bdc-8fe5-d7ba06c0a2c3", // Replace with your Azure AD App Client ID
    tenantId: "286fdf40-8322-4ac4-b029-c3387afb2971", // or 'common' for multi-tenant apps
    scopes: ["Files.ReadWrite", "Sites.ReadWrite.All", "offline_access"]
};
const SHAREPOINT_CONFIG = {
    siteUrl: "operationkindness.sharepoint.com/sites/Volunteers", // e.g., "contoso.sharepoint.com:/sites/marketing"
    filePath: "/Documents/Spotlight Data/Book.xlsx" // e.g., "/Documents/Path/To/Your/File.xlsx"
};
let driveItemIdCache = null;

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
    await updateSharePointSheet(token, 'meta', 'A1', [['Last Updated:', timestamp]]);
    showStatus("Timestamp updated. Clearing old shift data...");
    await clearSharePointSheet(token, 'data', 'A:Z');
    showStatus("Old data cleared. Writing new data to sheet...");

    const sheetData = formatForExcel(events);
    await updateSharePointSheet(token, 'data', 'A1', sheetData);
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

async function getDriveItemId(token) {
    if (driveItemIdCache) return driveItemIdCache;
    const { siteUrl, filePath } = SHAREPOINT_CONFIG;
    const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const endpoint = `/sites/${siteUrl}:/drive/root:${encodedPath}`;
    try {
        const item = await callGraphApi(endpoint, token);
        driveItemIdCache = item.id;
        return driveItemIdCache;
    } catch (e) {
        throw new Error(`Could not find file on SharePoint. Check config in background.js. Error: ${e.message}`);
    }
}

async function updateSharePointSheet(token, worksheet, range, values) {
    const itemId = await getDriveItemId(token);
    const endpoint = `/me/drive/items/${itemId}/workbook/worksheets/${worksheet}/range(address='${range}')`;
    await callGraphApi(endpoint, token, 'PATCH', { values });
}

async function clearSharePointSheet(token, worksheet, range) {
    const itemId = await getDriveItemId(token);
    const endpoint = `/me/drive/items/${itemId}/workbook/worksheets/${worksheet}/range(address='${range}')/clear`;
    await callGraphApi(endpoint, token, 'POST', {});
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
        const authUrl = `https://login.microsoftonline.com/${MSAL_CONFIG.tenantId}/oauth2/v2.0/authorize?` +
            new URLSearchParams({
                client_id: MSAL_CONFIG.clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                response_mode: 'query',
                scope: MSAL_CONFIG.scopes.join(' '),
                prompt: 'select_account'
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
    const params = new URLSearchParams({
        client_id: MSAL_CONFIG.clientId,
        scope: MSAL_CONFIG.scopes.join(' '),
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
    });
    return await fetchMicrosoftToken(params);
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
    chrome.runtime.sendMessage({ action: "updateStatus", data: message });
}