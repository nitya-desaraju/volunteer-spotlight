let scrapeInProgress = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    //fixing data adding twice to the spreadsheet
    if (request.action === "startScrape") {
        if (scrapeInProgress) {
            sendResponse({ status: "already running" });
            return true;
        }

        scrapeInProgress = true;
        sendResponse({ status: "received" });

        const scrapeAndProcess = async () => {
            try {
                const dayContainerSelector = 'table#SignupFromCalendarTable td';
                const directEventSelector = 'ul li a'; 
                const seeAllEventsSelector = 'div.moreShifts a'; //to get all dayContainers

                let dayContainers = Array.from(document.querySelectorAll(dayContainerSelector));
                if (dayContainers.length === 0) {
                     chrome.runtime.sendMessage({ action: "scrapingError", data: { error: "No shifts found. Make sure the calendar is open." } });
                    return;
                }
                
                dayContainers = dayContainers.filter(td => td.querySelector('a'));
                dayContainers = dayContainers.slice(0, 7);

                let finalEventUrls = new Set();
                let seeAllPages = [];
                
                dayContainers.forEach(container => {
                    const seeAllLink = container.querySelector(seeAllEventsSelector);

                    if (seeAllLink) {
                        seeAllPages.push(new URL(seeAllLink.href, window.location.origin).href);
                    } else {
                        const directLinks = container.querySelectorAll(directEventSelector);
                        directLinks.forEach(el => {
                            finalEventUrls.add(new URL(el.href, window.location.origin).href);
                        });
                    }
                });

                chrome.runtime.sendMessage({ action: "updateStatus", data: `Found ${seeAllPages.length} 'See All' pages...` });

                if (seeAllPages.length > 0) {
                    const seeAllPromises = seeAllPages.map(async (dayPageUrl) => {
                        const response = await fetch(dayPageUrl, {
                            method: 'POST', 
                            headers: {
                                'Content_Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                'Accept': 'text/html, */*; q=0.01',
                                'X-Requested-With': 'XMLHttpRequest'
                            }
                        });

                        if (!response.ok) return;

                        const htmlText = await response.text();
                        const parser = new DOMParser();
                        const dayPageDoc = parser.parseFromString(htmlText, 'text/html');

                        const eventLinkOnDayPageSelector = '.activityShiftLink';
                        const linksOnDayPage = dayPageDoc.querySelectorAll(eventLinkOnDayPageSelector);

                        linksOnDayPage.forEach(eventLink => {
                            finalEventUrls.add(new URL(eventLink.href, window.location.origin).href);
                        });
                    });

                    await Promise.all(seeAllPromises);
                }

                const uniqueEventUrls = Array.from(finalEventUrls);

                if (uniqueEventUrls.length === 0) {
                    chrome.runtime.sendMessage({ action: "scrapingError", data: { error: "No events found after full scan. Check all CSS selectors in content.js." } });
                    return;
                }

                chrome.runtime.sendMessage({ action: "updateStatus", data: `Found a total of ${uniqueEventUrls.length} unique events. Fetching details sequentially...` });

                const detailedEvents = [];
                const delay = ms => new Promise(res => setTimeout(res, ms));

                for (const url of uniqueEventUrls) {
                    const randomDelay = Math.floor(Math.random() * (15 - 5 + 1)) + 5;
                    await delay(randomDelay); //to avoid getting blocked by volunteer website for too many requests too quickly
                    chrome.runtime.sendMessage({ action: "updateStatus", data: `Fetching event ${detailedEvents.length + 1} of ${uniqueEventUrls.length}...` });

                    const response = await fetch(url, {
                            method: 'GET', 
                            headers: {
                                'Accept': 'text/html, */*; q=0.01',
                                'X-Requested-With': 'XMLHttpRequest'
                            }
                        });

                    if (!response.ok) {
                        detailedEvents.push({ url, title: 'Fetch Error', isVolunteerDependent: false, animalSpecificity: null });
                        continue;
                    }

                    //parsing html for each column in the sheets
                    const htmlText = await response.text();
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, 'text/html');

                    const titleSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h2';
                    const detailTitleSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h2:nth-child(2)';
                    const dateSelector = 'div#SignupFromCalendarSignupToShiftDialogContent h3';
                    const divSelector = 'div#SignupFromCalendarSignupToShiftDialogContent';
        
                    const titleNode = doc.querySelector(titleSelector);
                    let title = '';
                    if (titleNode) {
                        titleNode.childNodes.forEach(node => {
                        if (node.nodeType === 3) {
                            title += node.textContent;
                        }
                        });
                    }

                    title = title.trim();

                    const detail = doc.querySelector(detailTitleSelector)?.innerText.trim();
                    const dateInput = doc.querySelector(dateSelector)?.innerText.trim();
                    const dateRegex = /^(.+?)\s+(\d{1,2}:\d{2}.*)$/;
                    const dateMatches = dateInput.match(dateRegex);
                    let dateString = "", timeString = "";

                    if (dateMatches && dateMatches.length > 2) {
                        dateString = dateMatches[1].trim();
                        timeString = dateMatches[2].trim();
                    }

                    const inputText = doc.querySelector(divSelector)?.innerText.trim();
                    const openingsRegex = /(\d+)\s+of\s+(\d+)/;
                    const openingsMatches = inputText.match(openingsRegex);
                    let openingsAvailable, totalOpenings;

                    if (openingsMatches) {
                        openingsAvailable = parseInt(openingsMatches[1], 10);
                        totalOpenings = parseInt(openingsMatches[2], 10);
                    }

                    let pawNumber = null;
                    let animalSpecificity = null; //for higher paw levels that are animal specific
                    const pawRegex = /(\d+)\s*paw(?=\s*(?:dog|cat|volunteer|no)|$)/i; //prevents it from catching other mentions of paw
                    const pawMatch = inputText.match(pawRegex);

                    if (pawMatch) {
                        pawNumber = parseInt(pawMatch[1], 10);
                        if (pawNumber >= 3) {
                            const pawLine = inputText.split('\n').find(line => line.match(pawRegex));

                            if (pawLine) {
                                const hasDog = /dog/i.test(pawLine);
                                const hasCat = /cat/i.test(pawLine);
                                //prevents it from taking dog when it says Dog/Cat Volunteer
                                if (hasDog && !hasCat) animalSpecificity = "Dog";
                                else if (hasCat && !hasDog) animalSpecificity = "Cat";
                            }
                        }
                    }
                    
                    const isVolunteerDependent = inputText.includes("Volunteer-Dependent Activity!"); //go in urgent
                    const activityLink = doc.querySelector('div#SignupFromCalendarSignupToShiftDialogContent a#GoToActivityPageLink')?.href;
                    
                    detailedEvents.push({ activityLink, title, detail, dateString, timeString, openingsAvailable, totalOpenings, pawNumber, isVolunteerDependent, animalSpecificity });
                }

                chrome.runtime.sendMessage({
                    action: "processEvents",
                    data: {
                        events: detailedEvents,
                        spreadsheetId: request.spreadsheetId
                    }
                });

            } finally {
                scrapeInProgress = false;
            }
        };

        scrapeAndProcess();
        return true;
    }
});