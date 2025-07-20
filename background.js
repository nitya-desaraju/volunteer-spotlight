// This script runs in the background and now only handles API calls to Google Sheets.

// Listen for the "processEvents" message from the content script.
// This message now contains the *final, fully processed* event data.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "processEvents") {
        // The data is already processed, so we just need to upload it.
        uploadToSheet(request.data.events, request.data.spreadsheetId);
        return true; // Indicates that the response will be sent asynchronously.
    }
});

async function uploadToSheet(events, spreadsheetId) {
    updatePopupStatus(`Received ${events.length} processed events. Authenticating with Google...`);
    try {
        // Get Google Auth token.
        const token = await getAuthToken();
        updatePopupStatus("Authentication successful. Updating timestamp...");

        // 1. Write the current timestamp to the 'meta' sheet.
        const timestamp = new Date().toLocaleString();
        await updateTimestamp(token, spreadsheetId, timestamp);
        updatePopupStatus("Timestamp updated. Clearing old event data...");

        // 2. Clear all data from the main sheet.
        await clearGoogleSheet(token, spreadsheetId);
        updatePopupStatus("Old data cleared. Writing new data to sheet...");

        // 3. Prepare and write the new event data to the main sheet.
        const sheetData = formatForGoogleSheets(events);
        await appendToGoogleSheet(token, spreadsheetId, sheetData);

        // Send completion message to popup.
        chrome.runtime.sendMessage({ action: "scrapingComplete", data: { count: events.length } });

    } catch (error) {
        console.error("Background script error:", error);
        chrome.runtime.sendMessage({ action: "scrapingError", data: { error: error.message } });
    }
}

// NEW FUNCTION: Writes a timestamp to a separate 'meta' sheet.
async function updateTimestamp(token, spreadsheetId, timestamp) {
    const range = 'meta!A1';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`;

    const response = await fetch(url, {
        method: 'PUT', // Use PUT to update a specific range
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            values: [
                ["Last Updated:", timestamp]
            ]
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        // This error will likely appear if the 'meta' sheet doesn't exist.
        console.error(`Could not write timestamp (is there a sheet named 'meta'?): ${errorData.error.message}`);
        updatePopupStatus(`Warning: Could not write timestamp. Please ensure a sheet named 'meta' exists.`);
    }

    return response.json();
}


// Clears all values from the primary sheet.
async function clearGoogleSheet(token, spreadsheetId) {
    const range = 'data!A:Z'; // Clear all columns in the first sheet.
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        const errorData = await response.json();
        // It's okay if the sheet is already empty (which gives a 400 error).
        // We also ignore a 404 error in case the sheet doesn't exist yet.
        if (errorData.error.code !== 400 && errorData.error.code !== 404) {
           throw new Error(`Google Sheets clear error: ${errorData.error.message}`);
        }
    }
    return response.json();
}

// Appends the data to the specified Google Sheet.
async function appendToGoogleSheet(token, spreadsheetId, values) {
    const range = 'data!A1';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            values: values
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Google Sheets API Error: ${errorData.error.message}`);
    }

    return response.json();
}

// Helper functions (unchanged).
function getAuthToken() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(token);
            }
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