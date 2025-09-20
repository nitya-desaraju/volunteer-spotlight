# Volunteer Shift Spotlight

A Google Chrome extension that scrapes shift data off of the volunteer calendar and exports it to an Excel sheet on Sharepoint. A website then displays the data. It can be viewed [here](https://nitya-desaraju.github.io/volunteer-spotlight/).

## How this works

The Chrome extension reads the html off of the calendar and, using a Sharepoint API, writes the data to a spreadsheet. The website displays urgent shifts based on certain criteria for the data.

## Features

- Puts shifts marked as "Volunteer-Dependent" in the urgent section if they are 50% full or less
- All upcoming shifts in the next week under the categories chosen in the extension's filters by the shelter manager
- Filters are saved from the previous time so they don't have to be reentered
- Information icons to explain what each section contains in the website
- Direct links to shift signup on the website
- Link to shelter website in the top banner