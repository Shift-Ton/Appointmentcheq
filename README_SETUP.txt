WADHWANI REGISTRATION — V21 SETUP
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
   If this is a new installation, or the old demo password was present, setup creates
   a random facilitator password. Open the Config sheet and set your own strong
   password before attempting a facilitator login. Never use Wadhwani123 in production.
4. Deploy > Manage deployments > Edit > New version > Deploy.
5. Use these Web App settings:
   - Execute as: Me
   - Who has access: Anyone
6. Copy the new /exec URL. Do not put it in script.js or any other frontend file.
7. In Apps Script > Project Settings > Script properties, add:
   - Name: APPS_SCRIPT_PROXY_SECRET
   - Value: a random secret of at least 32 characters
   Keep this value private. It must exactly match the Vercel environment variable below.

FRONTEND DEPLOYMENT
-------------------
Deploy this folder to Vercel. Set the Vercel Project Root Directory to
Wadhwani_Registration_UI_Fixed.

1. Keep vendor/, sw.js, firebase-config.js, api/, vercel.json, and .vercelignore.
2. Do not remove .vercelignore. It prevents Code.gs, .env files, and Apps Script
   metadata from being uploaded or served by Vercel.
3. In Vercel Project Settings > Environment Variables, add these values for
   Production (and Preview only when you intentionally want preview sites to work):
   - APPS_SCRIPT_EXEC_URL = the Apps Script /exec URL from the previous section
   - APPS_SCRIPT_PROXY_SECRET = the exact Script Property secret from the previous section
4. Deploy the Vercel project. The frontend calls /api/backend; the Vercel Function
   forwards the request to Apps Script without revealing its URL to the browser.
5. For local testing, use `vercel dev` so the /api/backend Function is available.
   Opening index.html with file:// or using a plain static local server will not
   provide the Vercel API proxy.

This proxy replaces the former JSONP connection. Do not deploy this version to
Netlify or GitHub Pages unless you add an equivalent server-side proxy there.

AFTER DEPLOYMENT
----------------
1. Open the Vercel site once while online so the complete interface is cached.
2. Confirm a direct visit to the Apps Script /exec URL returns a direct-request
   rejection rather than registration data.
3. Sign in as a facilitator through the Vercel site.
4. Open Appointment settings.
5. Add/remove the schedule dates that students may select, then click Save settings.
6. Test one student registration and one facilitator status update before public use.

OFFLINE BEHAVIOR
----------------
The cached interface, icons, and QR layout can load without CDN access after one successful visit. Google Sheets registration records and any change to them still require an internet connection.

IMPORTANT
---------
Keep firebase-config.js even when Firebase notifications are disabled. Configure it only when closed-browser push notifications are required.
Firebase web configuration is public by design; never put a Firebase service-account
private key, the Apps Script URL, or the proxy secret in that file.

The Vercel proxy protects the Apps Script endpoint from direct use, but it does
not authenticate a student by itself. Student actions still need a separate
server-verified student session before the site is suitable for sensitive public use.
Restrict access to the Config sheet because its facilitator password field is a
sensitive credential until the authentication system is upgraded.
