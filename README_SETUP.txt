WADHWANI REGISTRATION — V20 SETUP
================================

WHAT WAS FIXED
--------------
- Responsive layout fixes for mobile, tablet, and desktop.
- Removed August 7, 12, and 13, 2026 from the schedule and previously saved open-date settings.
- Improved the registration ticket for very small phones, tablets, and desktop-width student screens.
- Removed the previous 1180px student-screen restriction, so registration and tickets also open on wide desktop monitors.
- Reworked the facilitator desktop header, controls, filters, rotations, and roster for medium and large monitors.
- Removed the Status column from the printed attendance and signature sheets.
- Set the print sheet to exact 8.5 × 13-inch long bond paper in landscape orientation, with formal margins and improved spacing.
- Facilitator buttons, schedule dates, rotations, roster, and dashboard no longer overflow.
- Appointment Settings and other modals scroll correctly on short/small screens.
- Offline/database banners no longer cover the facilitator mobile navigation.
- Bootstrap, Bootstrap Icons, and QR Code assets are now local, so the interface keeps its design when CDN access is unavailable.
- The service worker now caches the complete local interface package.
- Preserved: 10 laptops, 10-minute rotations, 60 clients per hour, no exact laptop assignment.
- Preserved: no schedules from 12:00–1:00 PM and 5:00–6:00 PM.
- Preserved: screenshot-ready QR ticket, email field, printable facilitator attendance/signature sheet, and facilitator-managed schedule dates.

GOOGLE APPS SCRIPT BACKEND
--------------------------
1. Open the Apps Script project connected to the registration Google Sheet.
2. Replace the project code with Code.gs from this folder.
3. Save, then run setupSystem() once from the Apps Script editor and authorize it.
   This also removes the old August 7, 12, and 13 schedule settings without deleting registration rows.
4. Deploy > Manage deployments > Edit > New version > Deploy.
5. Use these Web App settings:
   - Execute as: Me
   - Who has access: Anyone
6. Copy the new /exec URL.
7. Open script.js and replace APPS_SCRIPT_WEB_APP_URL near the top when the URL changed.

FRONTEND DEPLOYMENT
-------------------
Upload every file and folder together. Do not remove the vendor folder.

For Netlify: drag this complete folder into Netlify, or upload its contents to the site root.
For GitHub Pages: place the complete contents in the published branch/folder.
For local testing: run a local web server. Do not rely on opening index.html with file:// because service workers require localhost or HTTPS.

AFTER DEPLOYMENT
----------------
1. Open the site once while online so the complete interface is cached.
2. Sign in as a facilitator.
3. Open Appointment settings.
4. Add/remove the schedule dates that students may select, then click Save settings.
5. Test one student registration and one facilitator status update before public use.

OFFLINE BEHAVIOR
----------------
The cached interface, icons, and QR layout can load without CDN access after one successful visit. Google Sheets registration records and any change to them still require an internet connection.

IMPORTANT
---------
Keep firebase-config.js even when Firebase notifications are disabled. Configure it only when closed-browser push notifications are required.
