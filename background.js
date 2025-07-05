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
        updatePopupStatus("Authentication successful. Clearing old data from sheet...");

        // Clear all data from the sheet before adding new data.
        await clearGoogleSheet(token, spreadsheetId);
        updatePopupStatus("Old data cleared. Writing new data to sheet...");

        // Prepare data for Google Sheets API.
        const sheetData = formatForGoogleSheets(events);
        
        // Post data to the Google Sheet.
        await appendToGoogleSheet(token, spreadsheetId, sheetData);

        // Send completion message to popup.
        chrome.runtime.sendMessage({ action: "scrapingComplete", data: { count: events.length } });

    } catch (error) {
        console.error("Background script error:", error);
        chrome.runtime.sendMessage({ action: "scrapingError", data: { error: error.message } });
    }
}

// Clears all values from the primary sheet.
async function clearGoogleSheet(token, spreadsheetId) {
    const range = 'Sheet1!A:Z'; // Clear all columns in the first sheet.
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
    const range = 'Sheet1!A1';
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
    const header = ['Title', 'Date', 'Time', 'Location', 'Description', 'URL'];
    const rows = detailedEvents.map(event => [
        event.title,
        event.date,
        event.time,
        event.location,
        event.description,
        event.url
    ]);
    return [header, ...rows];
}

function updatePopupStatus(message) {
    chrome.runtime.sendMessage({ action: "updateStatus", data: message });
}
