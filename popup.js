// Get references to UI elements
const startButton = document.getElementById('start-scrape');
const statusDiv = document.getElementById('status');
const loader = document.getElementById('loader-container');
const sheetUrlInput = document.getElementById('sheet-url');

// When the popup loads, try to load the saved URL from storage.
document.addEventListener('DOMContentLoaded', async () => {
    const data = await chrome.storage.local.get('spreadsheetUrl');
    if (data.spreadsheetUrl) {
        sheetUrlInput.value = data.spreadsheetUrl;
    }
});

// Listen for clicks on the start button
startButton.addEventListener('click', async () => {
    // Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const sheetUrl = sheetUrlInput.value;

    // Validate the Google Sheet URL
    if (!sheetUrl || !sheetUrl.includes('docs.google.com/spreadsheets/d/')) {
        updateStatus('Error: Please enter a valid Google Sheet URL.');
        return;
    }

    // Save the valid URL to local storage for next time.
    await chrome.storage.local.set({ spreadsheetUrl: sheetUrl });

    // Extract Spreadsheet ID from the URL
    const spreadsheetId = sheetUrl.split('/d/')[1].split('/')[0];

    // Show loader and disable button
    loader.classList.remove('hidden');
    startButton.disabled = true;
    updateStatus('Starting extraction...');

    // Execute the content script on the active tab
    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
    }, () => {
        // After the script is injected, send a message to start scraping
        chrome.tabs.sendMessage(tab.id, { 
            action: "startScrape",
            spreadsheetId: spreadsheetId
        });
        updateStatus('Searching for calendar events on the page...');
    });
});

// Listen for messages from other parts of the extension (background/content scripts)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "updateStatus") {
        updateStatus(message.data);
    } else if (message.action === "scrapingComplete") {
        loader.classList.add('hidden');
        startButton.disabled = false;
        updateStatus(`✅ Success! ${message.data.count} events were added to your Google Sheet.`);
    } else if (message.action === "scrapingError") {
        loader.classList.add('hidden');
        startButton.disabled = false;
        updateStatus(`❌ Error: ${message.data.error}`);
    }
});

// Helper function to update the status text area
function updateStatus(text) {
    statusDiv.innerHTML = text;
}
