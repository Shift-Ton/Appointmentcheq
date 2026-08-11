/*
 * Wadhwani Registration V14 — optional browser Firebase Web Push configuration
 *
 * IMPORTANT:
 * 1. Create/register a Web app in your Firebase project.
 * 2. Paste the PUBLIC Firebase web config below.
 * 3. In Firebase Console > Project settings > Cloud Messaging > Web Push certificates,
 *    generate a VAPID key pair and paste the PUBLIC key below.
 * 4. Change enabled to true.
 *
 * This file contains PUBLIC web-app configuration only. Never place the Firebase
 * service-account private key here. The private key belongs in Apps Script
 * Script Properties through configureFirebaseMessaging().
 */

globalThis.WADHWANI_FIREBASE = Object.freeze({
  enabled: false,
  sdkVersion: '12.17.1',
  config: Object.freeze({
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: ''
  }),
  vapidKey: ''
});
