const startButton = document.getElementById('start-scrape');
const statusDiv = document.getElementById('status');
const loader = document.getElementById('loader-container');
const filterSection = document.getElementById('filter-section');
const categoryListDiv = document.getElementById('category-list');
const applyFiltersButton = document.getElementById('apply-filters');

const google_sheet_url = 'https://docs.google.com/spreadsheets/d/1icc08wyCcNJ3fCb51yT_xmjKLXbzef7DnznVgplbv-E/edit?usp=sharing';

startButton.addEventListener('click', async () => {
    filterSection.classList.add('hidden');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    const spreadsheetId = google_sheet_url.split('/d/')[1].split('/')[0];

    loader.classList.remove('hidden');
    startButton.disabled = true;
    
    //fixing having to run scraping twice if i need to log in by scraping after logging in
    updateStatus('Authenticating with Google...');
    try {
        const response = await chrome.runtime.sendMessage({ action: "checkAuth" });
        if (!response || response.status !== 'success') {
            throw new Error(response.message || "Authentication failed.");
        }

    } catch (error) {
        updateStatus(`❌ Error: ${error.message}`);
        loader.classList.add('hidden');
        startButton.disabled = false;

        return;
    }

    updateStatus('Authentication successful. Starting extraction...');
    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']

    }, () => {
        setTimeout(() => { //fixing race condition 
            chrome.tabs.sendMessage(tab.id, { 
                action: "startScrape",
                spreadsheetId: spreadsheetId

            }, (response) => {
                if (chrome.runtime.lastError) { //fixing freezing when running on the wrong page
                    updateStatus(`❌ Error: Could not communicate with the page. Please refresh the page and try again.`);
                    loader.classList.add('hidden');
                    startButton.disabled = false;
                } else if (response && response.status === "received") {
                    updateStatus('Searching for shifts on the page...');
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

    chrome.storage.local.set({ savedFilters: selectedCategories }); //saving filters entered from previous time 

    const spreadsheetId = google_sheet_url.split('/d/')[1].split('/')[0];
    
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

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.action === "updateStatus") {
        updateStatus(message.data);
    } else if (message.action === "scrapingComplete") {
        loader.classList.add('hidden');
        startButton.disabled = false;
        updateStatus(`✅ Success! ${message.data.count} shifts exported. You can now select categories below to filter the upcoming shifts.`);
    } else if (message.action === "scrapingError") {
        loader.classList.add('hidden');
        startButton.disabled = false;
        updateStatus(`❌ Error: ${message.data.error}`);
    } else if (message.action === "showFilterOptions") {
        const { savedFilters } = await chrome.storage.local.get('savedFilters');
        const savedFilterSet = new Set(savedFilters || []);

        categoryListDiv.innerHTML = '';
        message.data.categories.forEach(category => {
            const wrapper = document.createElement('div');
            wrapper.className = 'flex items-center';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = category;
            checkbox.value = category;
            checkbox.className = 'h-4 w-4 rounded border-gray-300 text-[#aa1f36] focus:ring-[#aa1f36]';
            
            //fixing previous filters not appearing in popup
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