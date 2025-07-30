// Get references to UI elements
const startButton = document.getElementById('start-scrape');
const statusDiv = document.getElementById('status');
const loader = document.getElementById('loader-container');
const filterSection = document.getElementById('filter-section');
const categoryListDiv = document.getElementById('category-list');
const applyFiltersButton = document.getElementById('apply-filters');

// Manually set your Google Sheet URL here
const GOOGLE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1icc08wyCcNJ3fCb51yT_xmjKLXbzef7DnznVgplbv-E/edit?usp=sharing';

// Listen for clicks on the start button
startButton.addEventListener('click', async () => {
    filterSection.classList.add('hidden'); // Hide filters on new scrape
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Extract Spreadsheet ID from the hardcoded URL
    const spreadsheetId = GOOGLE_SHEET_URL.split('/d/')[1].split('/')[0];

    loader.classList.remove('hidden');
    startButton.disabled = true;
    updateStatus('Starting extraction...');

    // Inject the content script
    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
    }, () => {
        // After injection, send the message to start scraping.
        setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { 
                action: "startScrape",
                spreadsheetId: spreadsheetId
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error("Error sending message:", chrome.runtime.lastError.message);
                    updateStatus(`❌ Error: Could not communicate with the page. Please refresh the page and try again.`);
                    loader.classList.add('hidden');
                    startButton.disabled = false;
                } else if (response && response.status === "received") {
                    updateStatus('Searching for calendar events on the page...');
                }
            });
        }, 100); 
    });
});

applyFiltersButton.addEventListener('click', () => {
    const selectedCategories = [];
    categoryListDiv.querySelectorAll('input[type="checkbox"]:checked').forEach(checkbox => {
        selectedCategories.push(checkbox.value);
    });

    chrome.storage.local.set({ savedFilters: selectedCategories });

    const spreadsheetId = GOOGLE_SHEET_URL.split('/d/')[1].split('/')[0];
    
    updateStatus('Applying filters to sheet...');
    loader.classList.remove('hidden');
    applyFiltersButton.disabled = true;

    chrome.runtime.sendMessage({
        action: "applyFilters",
        data: {
            selectedCategories: selectedCategories,
            spreadsheetId: spreadsheetId
        }
    });
});

// Listen for messages from other parts of the extension
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.action === "updateStatus") {
        updateStatus(message.data);
    } else if (message.action === "scrapingComplete") {
        loader.classList.add('hidden');
        startButton.disabled = false;
        updateStatus(`✅ Success! ${message.data.count} events exported. You can now select categories below to filter the website view.`);
    } else if (message.action === "scrapingError") {
        loader.classList.add('hidden');
        startButton.disabled = false;
        updateStatus(`❌ Error: ${message.data.error}`);
    } else if (message.action === "showFilterOptions") {
        const { savedFilters } = await chrome.storage.local.get('savedFilters');
        const savedFilterSet = new Set(savedFilters || []);

        categoryListDiv.innerHTML = ''; // Clear old categories
        message.data.categories.forEach(category => {
            const wrapper = document.createElement('div');
            wrapper.className = 'flex items-center';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = category;
            checkbox.value = category;
            checkbox.className = 'h-4 w-4 rounded border-gray-300 text-[#aa1f36] focus:ring-[#aa1f36]';
            
            if (savedFilterSet.has(category)) {
                checkbox.checked = true;
            }
            
            const label = document.createElement('label');
            label.htmlFor = category;
            label.textContent = category;
            label.className = 'ml-2 block text-sm text-gray-900';
            
            wrapper.appendChild(checkbox);
            wrapper.appendChild(label);
            categoryListDiv.appendChild(wrapper);
        });
        filterSection.classList.remove('hidden');
    } else if (message.action === "filtersApplied") {
        loader.classList.add('hidden');
        applyFiltersButton.disabled = false;
        updateStatus('✅ Filters applied! The website will update on the next refresh.');
    }
});

function updateStatus(text) {
    statusDiv.innerHTML = text;
}