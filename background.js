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
        uploadToSheet(request.data.events, request.data.spreadsheetId);
        return true; 
    }
    if (request.action === "applyFilters") {
        applyFiltersToSheet(request.data.selectedCategories, request.data.spreadsheetId);
        return true;
    }
});

async function uploadToSheet(events, spreadsheetId) {
    //shown in popup
    showStatus(`Processed ${events.length} shifts. Updating timestamp...`);
    const token = await getAuthToken();

    const timestamp = new Date().toLocaleString();
    await updateSheet(token, spreadsheetId, 'meta!A1', [['Last Updated:', timestamp]]);
    showStatus("Timestamp updated. Clearing old shift data...");
    await clearGoogleSheet(token, spreadsheetId, 'data!A:Z');
    showStatus("Old data cleared. Writing new data to sheet...");

    const sheetData = formatForGoogleSheets(events);
    await appendToGoogleSheet(token, spreadsheetId, 'data!A1', sheetData);
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
        await clearGoogleSheet(token, spreadsheetId, 'filter!A:Z');
        await chrome.storage.local.remove('savedFilters');
        showStatus("Filters cleared. Please set new filters if desired.");
    }

    chrome.runtime.sendMessage({ action: "showFilterOptions", data: { categories: newCategories, spreadsheetId: spreadsheetId } });
}

async function applyFiltersToSheet(categories, spreadsheetId) {
    const token = await getAuthToken();
    await clearGoogleSheet(token, spreadsheetId, 'filter!A:Z');
    
    //if no filters are applied, all categories will show 
    if (categories.length > 0) {
        const values = categories.map(category => [category]);
        await appendToGoogleSheet(token, spreadsheetId, 'filter!A1', values);
    }
    
    chrome.runtime.sendMessage({ action: "filtersApplied" });
}

async function updateSheet(token, spreadsheetId, range, values) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`;
    const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: values })
    });

    if (!response.ok) {
        showStatus(`Warning: Could not write to ${range}.`);
    }

    return response.json();
}

async function clearGoogleSheet(token, spreadsheetId, range) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
        const errorData = await response.json();
        if (errorData.error.code !== 400 && errorData.error.code !== 404) {
           throw new Error(`Google Sheets clear error: ${errorData.error.message}`);
        }
    }

    return response.json();
}

async function appendToGoogleSheet(token, spreadsheetId, range, values) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: values })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Google Sheets API Error: ${errorData.error.message}`);
    }

    return response.json();
}

function getAuthToken() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else { resolve(token); }
        });
    });
}

function formatForGoogleSheets(detailedEvents) {
    const header = ['Category', 'Activity', 'Date', 'Time', 'Open Shifts', 'Total Shifts', 'Details', 'Paw Level', 'Is Urgent', 'Animal'];
    const rows = detailedEvents.map(event => [event.title, event.detail, event.dateString, event.timeString, event.openingsAvailable, event.totalOpenings, event.activityLink, event.pawNumber, event.isVolunteerDependent, event.animalSpecificity || '']);
    
    return [header, ...rows];
}

function showStatus(message) {
    chrome.runtime.sendMessage({ action: "updateStatus", data: message });
}