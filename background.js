// This script runs in the background and now only handles API calls to Google Sheets.

// Listen for messages from other parts of the extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
    updatePopupStatus(`Received ${events.length} processed events. Authenticating with Google...`);
    try {
        const token = await getAuthToken();
        updatePopupStatus("Authentication successful. Updating timestamp...");

        // --- Standard Data Upload ---
        const timestamp = new Date().toLocaleString();
        await updateSheet(token, spreadsheetId, 'meta!A1', [['Last Updated:', timestamp]]);
        updatePopupStatus("Timestamp updated. Clearing old event data...");
        await clearGoogleSheet(token, spreadsheetId, 'data!A:Z');
        updatePopupStatus("Old data cleared. Writing new data to sheet...");
        const sheetData = formatForGoogleSheets(events);
        await appendToGoogleSheet(token, spreadsheetId, 'data!A1', sheetData);
        chrome.runtime.sendMessage({ action: "scrapingComplete", data: { count: events.length } });

        // --- NEW: Filter Validation Logic ---
        const newCategories = [...new Set(events.map(event => event.title))].sort();
        const newCategoriesSet = new Set(newCategories);
        const { savedFilters } = await chrome.storage.local.get('savedFilters');
        let filtersAreValid = true;

        if (savedFilters && savedFilters.length > 0) {
            // Check if every saved filter category still exists in the new data.
            for (const savedCategory of savedFilters) {
                if (!newCategoriesSet.has(savedCategory)) {
                    filtersAreValid = false;
                    break; // An outdated filter was found.
                }
            }
        }

        if (!filtersAreValid) {
            updatePopupStatus("Outdated filters found, clearing them...");
            await clearGoogleSheet(token, spreadsheetId, 'filter!A:Z'); // Clear sheet
            await chrome.storage.local.remove('savedFilters');          // Clear storage
            updatePopupStatus("Filters cleared. Please set new filters if desired.");
        }

        // Finally, send the fresh list of categories to the popup.
        chrome.runtime.sendMessage({ action: "showFilterOptions", data: { categories: newCategories, spreadsheetId: spreadsheetId } });

    } catch (error) {
        console.error("Background script error:", error);
        chrome.runtime.sendMessage({ action: "scrapingError", data: { error: error.message } });
    }
}

async function applyFiltersToSheet(categories, spreadsheetId) {
    try {
        const token = await getAuthToken();
        await clearGoogleSheet(token, spreadsheetId, 'filter!A:Z');
        
        if (categories.length > 0) {
            const values = categories.map(category => [category]); // Format for sheet API
            await appendToGoogleSheet(token, spreadsheetId, 'filter!A1', values);
        }
        
        chrome.runtime.sendMessage({ action: "filtersApplied" });
    } catch (error) {
        console.error("Filter apply error:", error);
        chrome.runtime.sendMessage({ action: "scrapingError", data: { error: `Failed to apply filters: ${error.message}` } });
    }
}

async function updateSheet(token, spreadsheetId, range, values) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`;
    const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: values })
    });
    if (!response.ok) {
        const errorData = await response.json();
        console.error(`Sheet update error for range ${range}: ${errorData.error.message}`);
        updatePopupStatus(`Warning: Could not write to ${range}.`);
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
    //activityLink, title, detail, dateString, timeString, openingsAvailable, totalOpenings
    const header = ['Category', 'Activity', 'Date', 'Time', 'Open Shifts', 'Total Shifts', 'Details', 'Paw Level'];
    const rows = detailedEvents.map(event => [
        event.title,
        event.detail,
        event.dateString,
        event.timeString,
        event.openingsAvailable,
        event.totalOpenings,
        event.activityLink,
        event.pawNumber
    ]);
    return [header, ...rows];
}

function updatePopupStatus(message) {
    chrome.runtime.sendMessage({ action: "updateStatus", data: message });
}