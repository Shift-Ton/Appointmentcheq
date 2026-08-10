/* Wadhwani Dynamic Appointments V8 — facilitator settings + live student status transitions */
(() => {
  'use strict';

  /* ================= LOCALHOST → GOOGLE APPS SCRIPT CONFIG: BEGIN =================
   * Paste the deployed Apps Script Web App /exec URL below.
   * Example: https://script.google.com/macros/s/AKfycb.../exec
   */
  const APPS_SCRIPT_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbz7Uq7UiGNtVXwLLMJfM_zrurH9u19yvuNap8eYM88B1LM2ATXWnfNozaPAe8KkVDh_/exec';
  const API_TIMEOUT_MS = 60000;
  const STUDENT_REMINDER_CHECK_MS = 3000;
  const REMINDER_CHECK_JITTER_MS = 1500;
  const STUDENT_MAX_VIEWPORT_WIDTH = 1180;
  /* ================== LOCALHOST → GOOGLE APPS SCRIPT CONFIG: END ================== */

  const LEGACY_BROWSER_KEYS = [
    'wadhwaniStudentIdV7', 'wadhwaniStudentEmailV5', 'wadhwaniFacilitatorTokenV5',
    'wadhwaniDeviceIdV5', 'wadhwaniSoundV5', 'wadhwaniFacilitatorAutoBypassV6'
  ];

  let EVENT_DATES = [];
  let OPEN_EVENT_DATES = [];
  let TIME_SLOTS = [];
  let COLLEGES = {};
  let CAPACITY = 10;
  let TEST_TODAY_DATE = '';
  let availabilityIndex = new Map();
  let serverClockOffset = 0;

  let currentStudent = null;
  let studentBatch = [];
  let studentAvailableSlots = [];
  let state = { students: [], messages: [] };
  let currentFacilitator = null;
  let activeStudentId = '';
  let pendingLoginId = '';
  let facilitatorToken = '';
  let deviceId = makeId();
  let notifiedStudentCalls = new Set();
  let offlineCheckInFlight = false;
  let volumePromptShown = false;
  let studentBlockedTarget = 'home';
  let viewportResizeTimer = null;
  let facSelectionRequestSerial = 0;
  let activeFacView = 'appointments';
  let previousFacView = 'appointments';
  let appointmentSettingsDates = [];

  let pendingStudent = null;
  let selectedDate = null;
  let selectedSlot = null;
  let rescheduleDate = null;
  let rescheduleSlot = null;
  let selectedFacStudentId = null;
  let facDate = '';
  let facPart = 'morning';
  let facSlot = '';
  let studentLineFilter = 'pending';
  let soundEnabled = false;
  let scanStream = null;
  let scanTimer = null;
  let studentIdVisible = true;
  let studentLiveTimer = null;
  let facilitatorLiveTimer = null; // facilitator auto-refresh is intentionally disabled
  let studentLiveSyncInFlight = false;
  let facilitatorLiveSyncInFlight = false;
  let facSelectionTouched = false;
  let recentStudentBatchIds = new Set();
  let recentFacilitatorIds = new Set();
  let reminderAlarmTimer = null;
  let reminderVibrationTimer = null;
  let reminderAlarmKey = '';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  async function init() {
    clearLegacyBrowserState();
    initializeMessengerBrowserFeature();
    bindEvents();
    updateSoundButton();
    setPortalControls('none');
    showLogin(true);
    setLoading(true, 'Reading the newest configuration and seat counts…', 'Connecting without browser cache');

    try {
      if (!navigator.onLine) {
        showOfflineModal();
        return;
      }
      await refreshPublicConfig();
      populateColleges();
      hideOfflineModal();
    } catch (error) {
      if (isNetworkFailure(error)) showOfflineModal();
      else showFatalError(error);
    } finally {
      setLoading(false);
    }
  }

  /* ================= GOOGLE APPS SCRIPT JSONP CONNECTION: BEGIN =================
   * JSONP is used because this frontend runs on localhost while Apps Script is
   * hosted on another origin. Script-tag requests are not blocked by CORS.
   */
  function server(method, ...args) {
    return new Promise((resolve, reject) => {
      const endpoint = String(APPS_SCRIPT_WEB_APP_URL || '').trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/i.test(endpoint)) {
        reject(new Error('Set APPS_SCRIPT_WEB_APP_URL at the top of script.js using your deployed Apps Script /exec URL.'));
        return;
      }

      const callbackName = `__wadhwaniJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const requestScript = document.createElement('script');
      let finished = false;

      const cleanup = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        requestScript.remove();
        try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
      };

      const timeoutId = window.setTimeout(() => {
        cleanup();
        const error = new Error('The request timed out while contacting Google Apps Script.');
        showOfflineModal();
        reject(error);
      }, API_TIMEOUT_MS);

      window[callbackName] = response => {
        cleanup();
        if (response && response.ok) {
          resolve(response.data);
          return;
        }
        reject(new Error(response && response.error ? response.error : 'The Apps Script server returned an invalid response.'));
      };

      requestScript.async = true;
      requestScript.onerror = () => {
        cleanup();
        const error = new Error('Unable to reach Google Apps Script. Check your internet connection.');
        showOfflineModal();
        reject(error);
      };

      try {
        const url = new URL(endpoint);
        url.searchParams.set('action', method);
        url.searchParams.set('payload', JSON.stringify({ args }));
        url.searchParams.set('callback', callbackName);
        url.searchParams.set('_', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        url.searchParams.set('fresh', '1');
        requestScript.src = url.toString();
        document.head.appendChild(requestScript);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  function setLoading(visible, message = '', title = '') {
    const loading = $('#appLoading');
    if (!loading) return;
    if (title && $('#appLoadingTitle')) $('#appLoadingTitle').textContent = title;
    if (message && $('#appLoadingMessage')) $('#appLoadingMessage').textContent = message;
    loading.classList.toggle('is-hidden', !visible);
    document.body.classList.toggle('process-loading-active', visible);
  }

  async function withProcessLoading(title, message, task) {
    setLoading(true, message, title);
    try {
      return await task();
    } finally {
      setLoading(false);
    }
  }

  function setButtonBusy(button, busy, busyText = 'Please wait…') {
    if (!button) return;
    if (busy) {
      button.dataset.originalHtml = button.innerHTML;
      button.innerHTML = `<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>${escapeHtml(busyText)}`;
      button.disabled = true;
      button.classList.add('is-busy');
    } else {
      if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
      button.disabled = false;
      button.classList.remove('is-busy');
      delete button.dataset.originalHtml;
    }
  }

  function showFatalError(error) {
    console.error(error);
    showOnly('loginScreen');
    const wrap = $('#loginScreen .auth-layout');
    if (wrap) {
      wrap.innerHTML = `<div class="connection-error-card"><i class="bi bi-cloud-slash fs-2 text-danger"></i><h1 class="mt-3">Database connection failed</h1><p>${escapeHtml(error.message || String(error))}</p><button class="btn btn-primary mt-3" type="button" id="retryConnectionButton"><i class="bi bi-arrow-clockwise me-1"></i>Retry</button></div>`;
      $('#retryConnectionButton').addEventListener('click', () => window.location.reload());
    }
  }

  function applyConfig(config) {
    if (!config) return;
    TIME_SLOTS = (Array.isArray(config.timeSlots) ? config.timeSlots : []).map(slot => ({
      ...slot,
      id: String(slot.id || '').trim(),
      start: normalizeClock(slot.start),
      end: normalizeClock(slot.end),
      part: String(slot.part || '').trim().toLowerCase()
    })).filter(slot => slot.id);
    EVENT_DATES = Array.from(new Set((Array.isArray(config.eventDates) ? config.eventDates : [])
      .map(normalizeDateKey)
      .filter(Boolean)));
    OPEN_EVENT_DATES = Array.from(new Set((Array.isArray(config.openEventDates) ? config.openEventDates : EVENT_DATES)
      .map(normalizeDateKey)
      .filter(Boolean)));
    COLLEGES = config.colleges || {};
    CAPACITY = Number(config.capacity) || 10;
    ['#morningCapacityLabel', '#afternoonCapacityLabel'].forEach(selector => {
      const label = $(selector);
      if (label) label.textContent = `${CAPACITY} students per hour`;
    });
    TEST_TODAY_DATE = normalizeDateKey(config.today || '');
    if (config.serverNow) serverClockOffset = new Date(config.serverNow).getTime() - Date.now();

    availabilityIndex = new Map();
    (config.availability || []).forEach(rawDateItem => {
      const date = normalizeDateKey(rawDateItem.date);
      if (!date) return;
      const slotMap = new Map();
      const slots = (rawDateItem.slots || []).map(rawSlot => {
        const id = normalizeSlotId(rawSlot.id);
        const count = Number(rawSlot.count || 0);
        return {
          ...rawSlot,
          id,
          count,
          remaining: Number.isFinite(Number(rawSlot.remaining)) ? Number(rawSlot.remaining) : Math.max(0, CAPACITY - count),
          full: Boolean(rawSlot.full) || count >= CAPACITY,
          available: Boolean(rawSlot.available)
        };
      }).filter(slot => slot.id);
      slots.forEach(slot => slotMap.set(slot.id, slot));
      availabilityIndex.set(date, { ...rawDateItem, date, slots, slotMap });
    });

    facDate = normalizeDateKey(facDate);
    facSlot = normalizeSlotId(facSlot);
    if (!facDate || !EVENT_DATES.includes(facDate)) facDate = TEST_TODAY_DATE || EVENT_DATES[0] || '';
    if (!facSlot || !getSlot(facSlot)) facSlot = TIME_SLOTS.find(slot => slot.part === facPart)?.id || TIME_SLOTS[0]?.id || '';
  }

  async function refreshPublicConfig() {
    const config = await server('getPublicBootstrap');
    applyConfig(config);
    return config;
  }

  function applyStudentDashboard(dashboard) {
    applyConfig(dashboard.config);
    currentStudent = dashboard.student ? normalizeStudentRecord(dashboard.student) : null;
    studentBatch = Array.isArray(dashboard.batch) ? dashboard.batch.map(normalizeBatchMember) : [];
    studentAvailableSlots = Array.isArray(dashboard.availableSlots)
      ? dashboard.availableSlots.map(item => ({ ...item, date: normalizeDateKey(item.date), slotId: normalizeSlotId(item.slotId) }))
      : [];
  }

  async function refreshStudentData(silent = true) {
    const studentIdNumber = normalizeStudentId(activeStudentId || currentStudent?.studentIdNumber || '');
    if (!isValidStudentId(studentIdNumber)) return false;

    const load = async () => {
      const dashboard = await server('getStudentDashboard', studentIdNumber);
      if (!dashboard.student) {
        clearStudentSession();
        if (!silent) toast('Registration not found', 'This Student ID is no longer in the database.');
        showLogin();
        return false;
      }
      applyStudentDashboard(dashboard);
      activeStudentId = currentStudent.studentIdNumber;
      showStudentHome();
      setLiveSyncState('connected', `Updated ${formatSyncClock()}`);
      hideOfflineModal();
      if (!silent) toast('Student data refreshed', 'Your status and batch list now show the latest Google Sheet rows.');
      return true;
    };

    try {
      return silent
        ? await load()
        : await withProcessLoading('Refreshing your student page', 'Reading the newest status, schedule, and batchmates…', load);
    } catch (error) {
      if (!silent) toast('Refresh failed', error.message);
      throw error;
    }
  }

  function applyFacilitatorState(data) {
    currentFacilitator = data.facilitator || currentFacilitator;
    applyConfig(data.config);
    state = {
      students: Array.isArray(data.students) ? data.students.map(normalizeStudentRecord) : [],
      messages: Array.isArray(data.messages) ? data.messages : []
    };
  }

  function mergeFacilitatorStudent(rawStudent) {
    if (!rawStudent) return null;
    const student = normalizeStudentRecord(rawStudent);
    const index = state.students.findIndex(item => String(item.id) === String(student.id));
    if (index >= 0) state.students.splice(index, 1, { ...state.students[index], ...student });
    else state.students.push(student);
    return student;
  }

  function mergeFacilitatorMessage(rawMessage) {
    if (!rawMessage) return null;
    const message = { ...rawMessage };
    const index = state.messages.findIndex(item => String(item.id) === String(message.id));
    if (index >= 0) state.messages.splice(index, 1, { ...state.messages[index], ...message });
    else state.messages.push(message);
    return message;
  }

  async function refreshFacilitatorData(silent = true) {
    const token = getFacilitatorToken();
    if (!token) return false;

    const load = async () => {
      const data = await server('getFacilitatorState', token, getDeviceId());
      applyFacilitatorState(data);
      renderFacilitator();
      setLiveSyncState('connected', `Updated ${formatSyncClock()}`);
      hideOfflineModal();
      if (!silent) toast('Facilitator data refreshed', 'Registrations, statuses, and messages are now up to date.');
      return true;
    };

    try {
      return silent
        ? await load()
        : await withProcessLoading('Refreshing facilitator records', 'Checking registrations, statuses, and messages…', load);
    } catch (error) {
      if (/session|facilitator account/i.test(error.message)) {
        clearFacilitatorSession();
        currentFacilitator = null;
        if (!silent) toast('Session ended', 'Please sign in again.');
        showLogin();
        return false;
      }
      if (!silent) toast('Refresh failed', error.message);
      throw error;
    }
  }
  /* ================= LIVE SCHEDULE SYNCHRONIZATION: BEGIN ================= */
  function stopLiveSync() {
    if (studentLiveTimer) window.clearTimeout(studentLiveTimer);
    if (facilitatorLiveTimer) window.clearTimeout(facilitatorLiveTimer);
    studentLiveTimer = null;
    facilitatorLiveTimer = null;
  }

  function startStudentLiveSync() {
    stopLiveSync();
    setLiveSyncState('idle', 'Manual refresh · reminders checked');
    scheduleStudentLiveSync(3500);
  }

  function startFacilitatorLiveSync() {
    stopLiveSync();
    setLiveSyncState('idle', 'Date changes load latest records');
  }

  function scheduleStudentLiveSync(delay = STUDENT_REMINDER_CHECK_MS + Math.floor(Math.random() * REMINDER_CHECK_JITTER_MS)) {
    if (studentLiveTimer) window.clearTimeout(studentLiveTimer);
    studentLiveTimer = window.setTimeout(runStudentLiveSync, delay);
  }

  function scheduleFacilitatorLiveSync() {
    // No background facilitator refresh. Refresh only on an explicit user action.
  }

  async function runStudentLiveSync() {
    studentLiveTimer = null;
    if (!isStudentPortalActive() || !currentStudent || currentStudent.status === 'completed') return;
    if (document.hidden || studentLiveSyncInFlight) {
      scheduleStudentLiveSync();
      return;
    }

    studentLiveSyncInFlight = true;
    try {
      const result = await server('getStudentNotificationState', currentStudent.studentIdNumber);
      if (!result.student) {
        clearStudentSession();
        showLogin();
        toast('Registration unavailable', 'Your saved Student ID is no longer in the database.');
        return;
      }

      if (result.serverNow) serverClockOffset = new Date(result.serverNow).getTime() - Date.now();
      const incoming = normalizeStudentRecord(result.student);
      const ownRecordChanged = [
        'status', 'calledAt', 'reminderResponse', 'respondedAt',
        'ongoingAt', 'completedAt', 'noShowAt', 'rescheduledAt', 'updatedAt'
      ].some(key => String(incoming[key] || '') !== String(currentStudent[key] || ''));

      if (ownRecordChanged) {
        const previousCalledAt = String(currentStudent.calledAt || '');
        const dashboard = await server('getStudentDashboard', currentStudent.studentIdNumber);
        applyStudentDashboard(dashboard);
        showStudentHome();
        setLiveSyncState('connected', `Updated ${formatSyncClock()}`);
        if (currentStudent.calledAt && String(currentStudent.calledAt) !== previousCalledAt) {
          toast('Facilitator reminder received', `${currentStudent.queueNumber} is being called.`);
        }
      } else {
        setLiveSyncState('idle', 'Manual refresh · reminders checked');
      }
    } catch (error) {
      console.warn('Student reminder check failed:', error.message);
      setLiveSyncState(navigator.onLine ? 'warning' : 'offline', navigator.onLine ? 'Reminder check retrying…' : 'Offline');
    } finally {
      studentLiveSyncInFlight = false;
      if (currentStudent && currentStudent.status !== 'completed' && isStudentPortalActive()) scheduleStudentLiveSync();
    }
  }

  async function runFacilitatorLiveSync() {
    // Kept as a no-op for older cached pages.
  }

  function clearRecentStudentHighlightsLater() {
    window.setTimeout(() => {
      recentStudentBatchIds.clear();
      if (!$('#studentHomeScreen')?.classList.contains('d-none') && currentStudent) renderStudentBatch(currentStudent);
    }, 5500);
  }

  function clearRecentFacilitatorHighlightsLater() {
    window.setTimeout(() => {
      recentFacilitatorIds.clear();
      if (!$('#facilitatorScreen')?.classList.contains('d-none')) renderFacRoster();
    }, 5500);
  }

  function setLiveSyncState(stateName, text) {
    const pill = $('#liveSyncPill');
    const label = $('#liveSyncText');
    if (pill) {
      pill.classList.remove('is-connected', 'is-syncing', 'is-warning', 'is-offline', 'is-idle');
      pill.classList.add(`is-${stateName}`);
    }
    if (label) label.textContent = text;
    const studentLabel = $('#studentLiveStatus');
    const facilitatorLabel = $('#facLiveStatus');
    if (studentLabel && !$('#studentHomeScreen')?.classList.contains('d-none')) studentLabel.textContent = text;
    if (facilitatorLabel && !$('#facilitatorScreen')?.classList.contains('d-none')) facilitatorLabel.textContent = text;
  }

  function formatSyncClock() {
    return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(getServerNow());
  }

  function isStudentPortalActive() {
    return ['studentHomeScreen', 'studentOngoingScreen', 'studentCompletedScreen']
      .some(id => { const el = $('#' + id); return el && !el.classList.contains('d-none'); });
  }

  function handleLiveSyncVisibility() {
    if (document.hidden || !navigator.onLine) {
      setLiveSyncState('offline', navigator.onLine ? 'Reminder checks paused' : 'Offline');
      return;
    }
    if (isStudentPortalActive() && currentStudent && currentStudent.status !== 'completed') scheduleStudentLiveSync(350);
    if (!$('#facilitatorScreen')?.classList.contains('d-none') && getFacilitatorToken()) {
      setLiveSyncState('idle', 'Date changes load latest records');
    }
  }

  function selectRelevantFacilitatorSchedule(force) {
    if (!force && facSelectionTouched) return;
    if (!EVENT_DATES.length || !TIME_SLOTS.length) return;

    const now = getServerNow();
    const today = normalizeDateKey(now);
    const dateIsOpen = date => !availabilityIndex.get(date)?.closed &&
      TIME_SLOTS.some(slot => getSlotEnd(date, slot) > now);
    const todayHasRemainingBatch = EVENT_DATES.includes(today) && dateIsOpen(today);
    let targetDate = todayHasRemainingBatch
      ? today
      : EVENT_DATES.find(dateIsOpen) || EVENT_DATES.find(date => !availabilityIndex.get(date)?.closed) || EVENT_DATES[EVENT_DATES.length - 1];
    const slots = TIME_SLOTS.slice().sort((a, b) => getSlotStart(targetDate, a) - getSlotStart(targetDate, b));
    let targetSlot = slots.find(slot => getSlotStart(targetDate, slot) <= now && getSlotEnd(targetDate, slot) > now);
    if (!targetSlot) targetSlot = slots.find(slot => getSlotStart(targetDate, slot) > now);
    if (!targetSlot) targetSlot = slots[slots.length - 1];

    facDate = targetDate;
    facSlot = targetSlot?.id || TIME_SLOTS[0]?.id || '';
    facPart = targetSlot?.part || TIME_SLOTS[0]?.part || 'morning';
  }

  function jumpToRelevantFacilitatorBatch() {
    facSelectionTouched = false;
    selectRelevantFacilitatorSchedule(true);
    facSelectionTouched = true;
    closeSelectedStudentSheet();
    applyFacilitatorDayPartTheme();
    renderFacDateTabs();
    renderFacPartTabs();
    renderFacBatchStrip();
    renderFacRoster();
    setLiveSyncState('idle', 'Current batch selected');
  }

  function isCurrentFacilitatorBatch(date, slotId) {
    const slot = getSlot(slotId);
    if (!slot) return false;
    const now = getServerNow();
    return normalizeDateKey(date) === normalizeDateKey(now) && getSlotStart(date, slot) <= now && getSlotEnd(date, slot) > now;
  }
  /* ================== LIVE SCHEDULE SYNCHRONIZATION: END ================== */

  /* ================== GOOGLE APPS SCRIPT CONNECTION: END ================== */

  /* ================= MESSENGER / FACEBOOK IN-APP BROWSER FEATURE: BEGIN ================= */
  function initializeMessengerBrowserFeature() {
    const instructionScreen = $('#browserInstruction');
    const mainApplication = $('#mainApplication');
    if (!instructionScreen || !mainApplication) {
      document.body.classList.remove('browser-check-pending');
      return;
    }

    const userAgent = navigator.userAgent || navigator.vendor || '';
    const queryString = document.querySelector('meta[name="app-query-string"]')?.content || window.location.search.replace(/^\?/, '');
    const queryParameters = new URLSearchParams(queryString);
    const isTestMode = queryParameters.get('testMessenger') === 'true';
    const isMessengerOrFacebookBrowser = /(FBAN|FBAV|FB_IAB|FB4A|FBIOS|Messenger)/i.test(userAgent);
    const isAndroidDevice = /Android/i.test(userAgent);
    const openChromeButton = $('#browserOpenChromeButton');
    const copyLinkButton = $('#browserCopyLinkButton');
    const copyConfirmation = $('#browserCopyConfirmation');

    openChromeButton.classList.toggle('d-none', !isAndroidDevice);

    const showMainApplication = () => {
      instructionScreen.classList.add('d-none');
      mainApplication.classList.remove('d-none');
      document.body.classList.remove('browser-check-pending', 'browser-instruction-active');
    };

    const showInstructionScreen = () => {
      mainApplication.classList.add('d-none');
      instructionScreen.classList.remove('d-none');
      document.body.classList.remove('browser-check-pending');
      document.body.classList.add('browser-instruction-active');
      window.setTimeout(() => instructionScreen.focus(), 0);
    };

    const copyCurrentPageLink = async () => {
      const currentUrl = getPublicPageUrl();
      let copied = false;
      copyConfirmation.textContent = '';
      copyConfirmation.classList.remove('is-error');

      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(currentUrl);
          copied = true;
        } catch (_) { copied = false; }
      }

      if (!copied) {
        const temporaryTextarea = document.createElement('textarea');
        temporaryTextarea.value = currentUrl;
        temporaryTextarea.setAttribute('readonly', '');
        temporaryTextarea.style.position = 'fixed';
        temporaryTextarea.style.top = '-1000px';
        temporaryTextarea.style.opacity = '0';
        document.body.appendChild(temporaryTextarea);
        temporaryTextarea.select();
        temporaryTextarea.setSelectionRange(0, temporaryTextarea.value.length);
        try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
        temporaryTextarea.remove();
      }

      if (copied) copyConfirmation.textContent = 'Link copied. Open Chrome and paste it into the address bar.';
      else {
        copyConfirmation.classList.add('is-error');
        copyConfirmation.textContent = 'The link could not be copied automatically. Use the three-dot menu and choose Open in browser.';
      }
    };

    const openCurrentPageInChrome = () => {
      const currentUrl = getPublicPageUrl();
      const currentUrlObject = new URL(currentUrl);
      const intentScheme = currentUrlObject.protocol === 'https:' ? 'https' : 'http';
      const intentTarget = `${currentUrlObject.host}${currentUrlObject.pathname}${currentUrlObject.search}`;
      const browserFallbackUrl = encodeURIComponent(currentUrl);
      window.location.href = `intent://${intentTarget}#Intent;scheme=${intentScheme};package=com.android.chrome;S.browser_fallback_url=${browserFallbackUrl};end`;
    };

    if (instructionScreen.dataset.browserFeatureBound !== 'true') {
      openChromeButton.addEventListener('click', openCurrentPageInChrome);
      copyLinkButton.addEventListener('click', copyCurrentPageLink);
      instructionScreen.dataset.browserFeatureBound = 'true';
    }

    if (isMessengerOrFacebookBrowser || isTestMode) showInstructionScreen();
    else showMainApplication();
  }

  function getPublicPageUrl() {
    return window.location.href;
  }
  /* ================== MESSENGER / FACEBOOK IN-APP BROWSER FEATURE: END ================== */

  function bindEvents() {
    $('#loginStudentId').addEventListener('input', event => {
      formatStudentIdField(event);
      resetLoginResult(false);
    });
    $('#loginForm').addEventListener('submit', handleLoginSubmit);
    $('#registerFromLoginButton').addEventListener('click', beginRegistrationFromLogin);
    $('#facilitatorPasswordForm').addEventListener('submit', handleFacilitatorPasswordSubmit);
    $('#changeLoginIdButton').addEventListener('click', () => resetLoginResult(true));
    $('#toggleFacilitatorPassword').addEventListener('click', toggleFacilitatorPassword);
    $('#cancelRegistrationButton').addEventListener('click', () => showLogin());
    $('#offlineRetryButton').addEventListener('click', retryInternetConnection);

    $('#studentForm').addEventListener('submit', handleDetailsSubmit);
    ['#firstName', '#middleName', '#lastName', '#studentIdNumber'].forEach(selector => {
      $(selector)?.addEventListener('input', clearNameCheckFeedback);
    });
    $('#editDetailsButton').addEventListener('click', showDetailsStep);
    $('#confirmRegistrationButton').addEventListener('click', confirmRegistration);
    $('#showQrButton').addEventListener('click', showQrTicket);
    $('#toggleStudentIdVisibility').addEventListener('click', toggleStudentIdVisibility);
    $('#rescheduleButton').addEventListener('click', openReschedule);
    $('#refreshAvailabilityButton').addEventListener('click', () => refreshScheduleAvailability(false));
    $('#confirmRescheduleButton').addEventListener('click', confirmReschedule);
    $('#refreshStudentButton').addEventListener('click', () => refreshStudentData(false));
    $('#refreshStudentTopButton').addEventListener('click', () => refreshStudentData(false));
    $('#refreshOngoingButton').addEventListener('click', () => refreshStudentData(false));
    $('#ongoingShowQrButton').addEventListener('click', showQrTicket);
    $('#responseGrid').addEventListener('click', handleStudentResponse);
    $('#callAlertResponseGrid').addEventListener('click', handleStudentResponse);
    $('#openMessageButton').addEventListener('click', () => showModal('messageModal'));
    $('#sendMessageButton').addEventListener('click', sendRescheduleMessage);
    $('#studentStatusTabs').addEventListener('click', handleStudentLineFilter);
    $('#brandHomeButton').addEventListener('click', routeHomeWithLatestData);
    $('#soundButton').addEventListener('click', toggleSound);
    $('#topLogoutButton').addEventListener('click', handleTopLogout);
    $('#studentDeviceBackButton').addEventListener('click', () => { clearStudentSession(); pendingLoginId = ''; showLogin(true); });
    $('#enableVolumeButton').addEventListener('click', enableVolumeAlerts);
    $('#keepMutedButton').addEventListener('click', keepVolumeMuted);

    $$('.fac-nav').forEach(button => button.addEventListener('click', () => openFacilitatorView(button.dataset.facView)));
    $('#floatingMessageButton').addEventListener('click', () => openFacilitatorView('messages'));
    $('#closeMessagesButton').addEventListener('click', () => openFacilitatorView(previousFacView || 'appointments'));
    $('#dayPartTabs').addEventListener('click', handlePartTab);
    $('#facSearch').addEventListener('input', renderFacRoster);
    $('#refreshFacilitatorButton').addEventListener('click', () => refreshFacilitatorData(false));
    $('#appointmentSettingsButton').addEventListener('click', openAppointmentSettings);
    $('#capacityMinusButton').addEventListener('click', () => adjustAppointmentCapacity(-1));
    $('#capacityPlusButton').addEventListener('click', () => adjustAppointmentCapacity(1));
    $('#appointmentCapacityInput').addEventListener('input', renderAppointmentSettingsPreview);
    $('#addAppointmentDateButton').addEventListener('click', addAppointmentDateFromInput);
    $('#appointmentDateInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addAppointmentDateFromInput(); } });
    $('#saveAppointmentSettingsButton').addEventListener('click', saveAppointmentSettings);
    $('#jumpCurrentBatchButton')?.addEventListener('click', jumpToRelevantFacilitatorBatch);
    $('#callStudentButton').addEventListener('click', callSelectedStudent);
    $('#markOngoingButton').addEventListener('click', () => updateSelectedStatus('ongoing'));
    $('#markCompleteButton').addEventListener('click', () => updateSelectedStatus('completed'));
    $('#markNoShowButton').addEventListener('click', () => updateSelectedStatus('no_show'));
    $('#scanQrButton').addEventListener('click', openScannerWithLatestData);
    $('#startCameraButton').addEventListener('click', startQrScanner);
    $('#manualScanButton').addEventListener('click', manualScan);
    $('#scannerModal').addEventListener('hidden.bs.modal', stopQrScanner);
    $('#selectedStudentModal').addEventListener('hidden.bs.modal', handleSelectedStudentSheetHidden);
    document.addEventListener('visibilitychange', handleLiveSyncVisibility);
    window.addEventListener('online', retryInternetConnection);
    window.addEventListener('offline', showOfflineModal);
    window.addEventListener('pageshow', handlePageShowFresh);
    window.addEventListener('resize', handleViewportResize, { passive: true });
    initializeSelectedStudentSheet();
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const studentIdNumber = normalizeStudentId($('#loginStudentId').value);
    if (!isValidStudentId(studentIdNumber)) {
      form.classList.add('was-validated');
      showLoginFeedback('warning', 'Enter a valid Student ID in the format 001-2023-001929.');
      return;
    }

    const button = $('#loginSubmitButton');
    setButtonBusy(button, true, 'Checking latest records…');
    resetLoginResult(false);
    try {
      const result = await server('resolveLoginId', studentIdNumber);
      hideOfflineModal();
      pendingLoginId = studentIdNumber;
      if (result.role === 'student' && result.dashboard?.student) {
        applyStudentDashboard(result.dashboard);
        activeStudentId = currentStudent.studentIdNumber;
        showStudentHome();
        toast('Login successful', `Welcome back, ${currentStudent.firstName}.`);
        return;
      }
      if (result.role === 'facilitator') {
        $('#matchedFacilitatorId').value = studentIdNumber;
        $('#matchedFacilitatorName').textContent = result.name || 'Authorized facilitator';
        $('#loginForm').classList.add('d-none');
        $('#facilitatorPasswordForm').classList.remove('d-none');
        showLoginFeedback('success', 'Facilitator ID confirmed. Enter the password saved in the Config sheet.');
        window.setTimeout(() => $('#facilitatorPassword').focus(), 80);
        return;
      }
      $('#registerFromLoginPanel').classList.remove('d-none');
      showLoginFeedback('info', 'No student or facilitator account was found for this ID.');
    } catch (error) {
      showLoginFeedback('danger', error.message);
      if (isNetworkFailure(error)) showOfflineModal();
    } finally {
      setButtonBusy(button, false);
    }
  }

  function beginRegistrationFromLogin() {
    if (!isValidStudentId(pendingLoginId)) return;
    $('#studentForm').reset();
    $('#studentForm').classList.remove('was-validated');
    $('#studentIdNumber').value = pendingLoginId;
    $('#studentIdNumber').readOnly = true;
    pendingStudent = null;
    selectedDate = null;
    selectedSlot = null;
    populateColleges();
    showRegistration(pendingLoginId);
  }

  async function handleFacilitatorPasswordSubmit(event) {
    event.preventDefault();
    const facilitatorId = normalizeStudentId($('#matchedFacilitatorId').value);
    const password = String($('#facilitatorPassword').value || '');
    if (!isValidStudentId(facilitatorId) || !password) {
      showLoginFeedback('warning', 'Enter the facilitator password.');
      return;
    }
    const button = $('#facilitatorLoginButton');
    setButtonBusy(button, true, 'Authenticating…');
    try {
      const session = await server('loginFacilitator', facilitatorId, password, getDeviceId());
      saveFacilitatorToken(session.token);
      const data = await server('getFacilitatorState', session.token, getDeviceId());
      applyFacilitatorState(data);
      hideOfflineModal();
      showFacilitator(currentFacilitator);
      toast('Facilitator login successful', 'The newest registrations are now displayed.');
      $('#facilitatorPassword').value = '';
    } catch (error) {
      clearFacilitatorSession();
      showLoginFeedback('danger', error.message);
      if (isNetworkFailure(error)) showOfflineModal();
    } finally {
      setButtonBusy(button, false);
    }
  }

  function toggleFacilitatorPassword() {
    const input = $('#facilitatorPassword');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    $('#toggleFacilitatorPassword').innerHTML = `<i class="bi ${visible ? 'bi-eye' : 'bi-eye-slash'}"></i>`;
    $('#toggleFacilitatorPassword').setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
  }

  function resetLoginResult(focusInput = false) {
    $('#loginForm').classList.remove('d-none');
    $('#facilitatorPasswordForm').classList.add('d-none');
    $('#registerFromLoginPanel').classList.add('d-none');
    $('#loginFeedback').classList.add('d-none');
    $('#facilitatorPassword').value = '';
    $('#matchedFacilitatorId').value = '';
    pendingLoginId = normalizeStudentId($('#loginStudentId')?.value || '');
    if (focusInput) {
      $('#loginStudentId').value = '';
      pendingLoginId = '';
      window.setTimeout(() => $('#loginStudentId').focus(), 40);
    }
  }

  function showLoginFeedback(type, message) {
    const box = $('#loginFeedback');
    box.className = `login-feedback is-${type}`;
    box.textContent = message;
  }

  function clearStudentSession() {
    activeStudentId = '';
    currentStudent = null;
    studentBatch = [];
    studentAvailableSlots = [];
    notifiedStudentCalls.clear();
  }

  function clearFacilitatorSession() {
    document.body.classList.remove('fac-afternoon-theme');
    activeFacView = 'appointments';
    previousFacView = 'appointments';
    clearFacilitatorToken();
    currentFacilitator = null;
    state = { students: [], messages: [] };
    selectedFacStudentId = null;
  }

  function logoutStudent() {
    resetPortalAudio();
    clearStudentSession();
    showLogin(true);
    toast('Logged out', 'This browser did not save your Student ID.');
  }

  async function logoutFacilitatorAccount() {
    const token = getFacilitatorToken();
    try {
      if (token) await server('logoutFacilitator', token, getDeviceId());
    } catch (error) {
      console.warn('Facilitator logout could not reach the server:', error.message);
    } finally {
      resetPortalAudio();
      clearFacilitatorSession();
      showLogin(true);
      toast('Logged out', 'The facilitator session was removed from this page.');
    }
  }

  function handleTopLogout() {
    if (facilitatorToken && currentFacilitator) {
      logoutFacilitatorAccount();
      return;
    }
    logoutStudent();
  }

  function resetPortalAudio() {
    soundEnabled = false;
    volumePromptShown = false;
    updateSoundButton();
    hideModal('volumePromptModal');
    hideModal('callAlertModal');
    stopReminderAlarm();
  }

  function clearLegacyBrowserState() {
    LEGACY_BROWSER_KEYS.forEach(key => {
      try { localStorage.removeItem(key); } catch (_) {}
      try { sessionStorage.removeItem(key); } catch (_) {}
    });
  }

  function showOfflineModal() {
    const modal = $('#offlineModal');
    if (!modal) return;
    modal.classList.remove('d-none');
    document.body.classList.add('offline-modal-active');
    setLoading(false);
  }

  function hideOfflineModal() {
    const modal = $('#offlineModal');
    if (!modal) return;
    modal.classList.add('d-none');
    document.body.classList.remove('offline-modal-active');
  }

  function isNetworkFailure(error) {
    const message = String(error?.message || error || '');
    return !navigator.onLine || /timed out|unable to reach|network|internet|failed to fetch/i.test(message);
  }

  async function retryInternetConnection() {
    if (offlineCheckInFlight) return;
    offlineCheckInFlight = true;
    const button = $('#offlineRetryButton');
    setButtonBusy(button, true, 'Checking…');
    try {
      if (!navigator.onLine) throw new Error('The device is still offline.');
      await server('ping');
      hideOfflineModal();
      if (facilitatorToken && currentFacilitator) await refreshFacilitatorData(true);
      else if (activeStudentId && currentStudent) await refreshStudentData(true);
      else {
        await refreshPublicConfig();
        populateColleges();
      }
      toast('Connection restored', 'The latest database records are available again.');
    } catch (error) {
      showOfflineModal();
      $('#offlineMessage').textContent = 'The database is still unreachable. Check Wi-Fi or mobile data, then try again.';
    } finally {
      offlineCheckInFlight = false;
      setButtonBusy(button, false);
    }
  }

  async function handlePageShowFresh(event) {
    if (!event.persisted) return;
    const oldToken = facilitatorToken;
    const oldDeviceId = deviceId;
    resetPortalAudio();
    clearStudentSession();
    clearFacilitatorSession();
    deviceId = makeId();
    showLogin(true);
    try {
      if (oldToken) server('logoutFacilitator', oldToken, oldDeviceId).catch(() => {});
      await refreshPublicConfig();
      populateColleges();
    } catch (error) {
      if (isNetworkFailure(error)) showOfflineModal();
    }
  }

  async function autoRoute() {
    showLogin();
  }

  function showOnly(id) {
    ['loginScreen', 'studentDeviceScreen', 'registrationScreen', 'studentHomeScreen', 'studentOngoingScreen', 'studentCompletedScreen', 'facilitatorScreen'].forEach(screenId => {
      $('#' + screenId).classList.toggle('d-none', screenId !== id);
    });
  }

  function setPortalControls(role = 'none') {
    const activePortal = role === 'student' || role === 'facilitator';
    $$('.portal-control').forEach(element => element.classList.toggle('d-none', !activePortal));
    $('#facilitatorProfileButton').classList.toggle('d-none', role !== 'facilitator');
  }

  function isStudentViewportAllowed() {
    const width = Math.min(window.innerWidth || Infinity, document.documentElement.clientWidth || Infinity);
    return width <= STUDENT_MAX_VIEWPORT_WIDTH;
  }

  function showStudentDeviceNotice(target = 'home') {
    document.body.classList.remove('fac-afternoon-theme');
    stopLiveSync();
    studentBlockedTarget = target;
    document.body.classList.remove('registration-schedule-mode');
    showOnly('studentDeviceScreen');
    setPortalControls('student');
    $('#liveSyncPill').classList.add('d-none');
    $('#soundButton').classList.add('d-none');
    $('#appContext').textContent = 'Student Portal';
    window.scrollTo(0, 0);
  }

  function handleViewportResize() {
    if (viewportResizeTimer) window.clearTimeout(viewportResizeTimer);
    viewportResizeTimer = window.setTimeout(() => {
      const noticeVisible = !$('#studentDeviceScreen').classList.contains('d-none');
      const studentHomeVisible = !$('#studentHomeScreen').classList.contains('d-none') || !$('#studentOngoingScreen').classList.contains('d-none') || !$('#studentCompletedScreen').classList.contains('d-none');
      const registrationVisible = !$('#registrationScreen').classList.contains('d-none');
      if (!isStudentViewportAllowed() && studentHomeVisible) {
        showStudentDeviceNotice(currentStudent?.status === 'completed' ? 'completed' : currentStudent?.status === 'ongoing' ? 'ongoing' : 'home');
      } else if (!isStudentViewportAllowed() && registrationVisible) {
        showStudentDeviceNotice('registration');
      } else if (isStudentViewportAllowed() && noticeVisible) {
        if (studentBlockedTarget === 'registration' && isValidStudentId(pendingLoginId || $('#studentIdNumber')?.value || '')) showRegistration(pendingLoginId || $('#studentIdNumber').value);
        else if (currentStudent) showStudentHome();
        else showLogin();
      }
    }, 180);
  }

  function showLogin(resetInput = false) {
    document.body.classList.remove('fac-afternoon-theme');
    stopLiveSync();
    setLiveSyncState('idle', 'Ready');
    showOnly('loginScreen');
    setPortalControls('none');
    window.scrollTo(0, 0);
    $('#appContext').textContent = 'Secure Login';
    if (resetInput) $('#loginStudentId').value = '';
    resetLoginResult(false);
    window.setTimeout(() => $('#loginStudentId')?.focus(), 80);
  }

  function showRegistration(studentIdNumber = pendingLoginId) {
    document.body.classList.remove('fac-afternoon-theme');
    if (!isStudentViewportAllowed()) {
      showStudentDeviceNotice('registration');
      return;
    }
    stopLiveSync();
    setLiveSyncState('idle', 'Registration');
    showOnly('registrationScreen');
    setPortalControls('none');
    window.scrollTo(0, 0);
    $('#appContext').textContent = 'Student Registration';
    const lockedId = normalizeStudentId(studentIdNumber);
    $('#studentIdNumber').value = lockedId;
    $('#studentIdNumber').readOnly = true;
    showDetailsStep();
  }

  function showStudentHome() {
    document.body.classList.remove('fac-afternoon-theme');
    if (!isStudentViewportAllowed()) {
      showStudentDeviceNotice(currentStudent?.status === 'completed' ? 'completed' : currentStudent?.status === 'ongoing' ? 'ongoing' : 'home');
      return;
    }
    document.body.classList.remove('registration-schedule-mode');
    setPortalControls('student');
    window.scrollTo(0, 0);
    $('#appContext').textContent = 'Student Portal';

    if (!currentStudent) {
      showLogin(true);
      return;
    }

    if (currentStudent.status === 'completed') {
      showOnly('studentCompletedScreen');
      renderStudentCompleted();
      stopLiveSync();
      stopReminderAlarm();
      return;
    }

    if (currentStudent.status === 'ongoing') {
      showOnly('studentOngoingScreen');
      renderStudentOngoing();
      startStudentLiveSync();
      maybeShowVolumePrompt();
      return;
    }

    showOnly('studentHomeScreen');
    renderStudentHome();
    startStudentLiveSync();
    maybeShowVolumePrompt();
  }

  function showFacilitator(facilitator) {
    document.body.classList.remove('registration-schedule-mode');
    activeFacView = 'appointments';
    previousFacView = 'appointments';
    showOnly('facilitatorScreen');
    setPortalControls('facilitator');
    window.scrollTo(0, 0);
    $('#appContext').textContent = 'Facilitator Portal';
    $('#facilitatorNameTop').textContent = facilitator?.name || 'Facilitator';
    $('#facilitatorName').textContent = facilitator?.name || 'Facilitator';
    $('#facilitatorEmail').textContent = `Facilitator ID: ${facilitator?.id || facilitator?.email || ''}`;
    selectRelevantFacilitatorSchedule(false);
    renderFacilitator();
    startFacilitatorLiveSync();
    maybeShowVolumePrompt();
  }

  function showDetailsStep() {
    document.body.classList.remove('registration-schedule-mode');
    $('#detailsPanel').classList.remove('d-none');
    $('#schedulePanel').classList.add('d-none');
    setStep('details');
  }

  async function showScheduleStep() {
    document.body.classList.add('registration-schedule-mode');
    $('#detailsPanel').classList.add('d-none');
    $('#schedulePanel').classList.remove('d-none');
    setStep('schedule');
    selectedDate = null;
    selectedSlot = null;
    renderPendingSummary();
    $('#selectionBar').classList.add('d-none');
    await refreshScheduleAvailability(true);
  }

  async function refreshScheduleAvailability(initialOpen = false) {
    const button = $('#refreshAvailabilityButton');
    setScheduleLoading(true);
    if (!initialOpen) setButtonBusy(button, true, 'Refreshing…');

    const load = async () => {
      await refreshPublicConfig();
      if (!selectedDate || !EVENT_DATES.includes(selectedDate) || !TIME_SLOTS.some(slot => isSlotAvailable(selectedDate, slot.id))) {
        selectedDate = firstAvailableDate();
        selectedSlot = null;
      }
      if (selectedSlot && !isSlotAvailable(selectedDate, selectedSlot)) {
        selectedSlot = null;
        $('#selectionBar').classList.add('d-none');
        if (!initialOpen) toast('Slot changed', 'That batch is no longer available. Please choose another time.');
      }
      renderRegistrationDates();
      if (selectedDate) {
        renderSlotsForDate(selectedDate, $('#morningSlots'), $('#afternoonSlots'), chooseRegistrationSlot, selectedSlot);
        $('#datePrompt').classList.add('d-none');
        $('#slotGroups').classList.remove('d-none');
      } else {
        $('#slotGroups').classList.add('d-none');
        $('#datePrompt').classList.remove('d-none');
      }
      $('#availabilityStatusText').textContent = 'Seat availability is up to date';
      $('#availabilityUpdatedText').textContent = `Checked ${new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' }).format(getServerNow())}`;
    };

    try {
      await withProcessLoading('Checking available seats', 'Counting the latest registrations for every date and time…', load);
    } catch (error) {
      $('#availabilityStatusText').textContent = 'Unable to refresh seats';
      $('#availabilityUpdatedText').textContent = error.message;
      toast('Seat check failed', error.message);
    } finally {
      setScheduleLoading(false);
      if (!initialOpen) setButtonBusy(button, false);
    }
  }

  function setScheduleLoading(loading) {
    $('#scheduleLoading').classList.toggle('d-none', !loading);
    $('#dateGrid').classList.toggle('is-loading', loading);
    $('#slotGroups').classList.toggle('is-loading', loading);
  }

  function chooseRegistrationSlot(slot) {
    selectedSlot = slot.id;
    renderSlotsForDate(selectedDate, $('#morningSlots'), $('#afternoonSlots'), chooseRegistrationSlot, selectedSlot);
    updateRegistrationSelection();
  }

  function setStep(step) {
    const map = { details: 0, schedule: 1, done: 2 };
    const current = map[step];
    [$('#stepDetails'), $('#stepSchedule'), $('#stepDone')].forEach((element, index) => {
      element.classList.toggle('active', index === current);
      element.classList.toggle('done', index < current);
    });
  }

  function populateColleges() {
    const select = $('#college');
    const existing = select.value;
    select.innerHTML = '<option value="">Select college</option>';
    Object.keys(COLLEGES).forEach(college => select.add(new Option(college, college)));
    if (existing && Object.prototype.hasOwnProperty.call(COLLEGES, existing)) select.value = existing;
  }

  function clearNameCheckFeedback() {
    const feedback = $('#nameCheckFeedback');
    if (!feedback) return;
    feedback.classList.add('d-none');
    feedback.textContent = '';
  }

  function showNameCheckFeedback(message) {
    const feedback = $('#nameCheckFeedback');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.remove('d-none');
  }

  async function handleDetailsSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      form.classList.add('was-validated');
      return;
    }

    const data = new FormData(form);
    const candidate = {
      studentIdNumber: normalizeStudentId(data.get('studentIdNumber')),
      firstName: properCase(data.get('firstName')),
      middleName: properCase(data.get('middleName')),
      lastName: properCase(data.get('lastName')),
      college: String(data.get('college')),
      course: String(data.get('course') || '').trim()
    };

    const submitButton = form.querySelector('[type="submit"]');
    setButtonBusy(submitButton, true, 'Checking registration…');
    try {
      const result = await server('checkStudentEligibility', candidate);
      if (result.status === 'existing') {
        applyStudentDashboard(result.dashboard);
        activeStudentId = currentStudent.studentIdNumber;
        toast('Registration already exists', `Opening ${currentStudent.queueNumber}.`);
        showStudentHome();
        return;
      }

      if (result.status === 'duplicate_name') {
        const message = result.message || 'A registration with this full name already exists. Please verify the Student ID or ask the CARES Office for assistance.';
        showNameCheckFeedback(message);
        toast('Name already registered', message);
        return;
      }

      clearNameCheckFeedback();
      pendingStudent = candidate;
      await showScheduleStep();
    } catch (error) {
      toast('Unable to continue', error.message);
    } finally {
      setButtonBusy(submitButton, false);
    }
  }

  function renderPendingSummary() {
    if (!pendingStudent) return;
    $('#pendingStudentSummary').innerHTML = `<span><strong>${escapeHtml(fullName(pendingStudent))}</strong></span><span>Student ID: ${escapeHtml(pendingStudent.studentIdNumber)}</span><span>${escapeHtml(shortCollege(pendingStudent.college))}</span>`;
  }

  function renderRegistrationDates() {
    renderDateCards($('#dateGrid'), selectedDate, date => {
      selectedDate = date;
      selectedSlot = null;
      renderRegistrationDates();
      renderSlotsForDate(date, $('#morningSlots'), $('#afternoonSlots'), chooseRegistrationSlot, selectedSlot);
      $('#datePrompt').classList.add('d-none');
      $('#slotGroups').classList.remove('d-none');
      $('#selectionBar').classList.add('d-none');
    });
  }

  function renderDateCards(container, activeDate, onSelect) {
    container.innerHTML = '';
    EVENT_DATES.forEach((date, index) => {
      const dateAvailability = availabilityIndex.get(date);
      const total = Number(dateAvailability?.total || 0);
      const remaining = Number(dateAvailability?.remaining || 0);
      const closed = Boolean(dateAvailability?.closed);
      const allUnavailable = Boolean(dateAvailability?.allUnavailable);
      const capacityTotal = CAPACITY * TIME_SLOTS.length;
      const percent = closed ? 100 : (capacityTotal ? Math.round(total / capacityTotal * 100) : 0);
      const levelClass = capacityLevelClass(percent, allUnavailable);
      const button = document.createElement('button');
      button.type = 'button';
      const today = date === TEST_TODAY_DATE;
      button.className = `date-card watercolor-card ${levelClass} ${activeDate === date ? 'active' : ''} ${allUnavailable ? 'full' : ''} ${today ? 'today' : ''}`;
      button.disabled = allUnavailable;
      button.style.setProperty('--water-level', `${Math.min(100, percent)}%`);
      button.style.setProperty('--water-delay', `${index * -0.45}s`);
      button.setAttribute('aria-label', closed
        ? `${formatDate(date, { month: 'long', day: 'numeric' })}: full`
        : `${formatDate(date, { month: 'long', day: 'numeric' })}: ${total} registered, ${remaining} seats remaining`);
      const capacityHtml = closed
        ? '<div class="capacity capacity-closed"><span>Registration closed</span><span>0 seats left</span></div>'
        : `<div class="capacity"><span>${total} registered</span><span>${remaining} seats left</span></div>`;
      const labelHtml = closed
        ? '<span class="full-label">Full</span>'
        : allUnavailable ? '<span class="full-label">Date unavailable</span>' : '';
      button.innerHTML = `${today ? '<span class="today-label">Today</span>' : ''}<span class="day">${formatDate(date, { weekday: 'long' })}</span><strong>${formatDate(date, { month: 'long', day: 'numeric' })}</strong>${capacityHtml}<div class="capacity-meter" aria-hidden="true"><span style="width:${Math.min(100, percent)}%"></span></div>${labelHtml}`;
      button.addEventListener('click', () => onSelect(date));
      container.appendChild(button);
    });
  }

  function renderSlotsForDate(date, morningContainer, afternoonContainer, onSelect, activeSlot = selectedSlot) {
    morningContainer.innerHTML = '';
    afternoonContainer.innerHTML = '';
    const recommendedSlotId = getRecommendedSlot(date)?.id;
    TIME_SLOTS.forEach((slot, index) => {
      const availability = getSlotAvailability(date, slot.id);
      const count = Number(availability?.count || 0);
      const remaining = Math.max(0, CAPACITY - count);
      const percent = CAPACITY ? Math.round(count / CAPACITY * 100) : 0;
      const available = Boolean(availability?.available);
      const recommended = available && slot.id === recommendedSlotId;
      const levelClass = capacityLevelClass(percent, Boolean(availability?.full));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `slot-btn watercolor-card ${levelClass} ${activeSlot === slot.id ? 'active' : ''} ${availability?.full ? 'full' : ''} ${recommended ? 'recommended' : ''}`;
      button.disabled = !available;
      button.style.setProperty('--water-level', `${Math.min(100, percent)}%`);
      button.style.setProperty('--water-delay', `${index * -0.35}s`);
      button.setAttribute('aria-label', `${slot.label}: ${remaining} of ${CAPACITY} seats left`);
      const unavailableText = availability?.full ? 'Full · no seats available' : availability?.ended ? 'Ended · unavailable' : availability?.started ? 'In progress · unavailable' : 'Unavailable';
      button.classList.toggle('ended', Boolean(availability?.ended));
      button.classList.toggle('started', Boolean(availability?.started && !availability?.ended));
      button.innerHTML = `${recommended ? '<span class="smart-label"><i class="bi bi-stars"></i> Best availability</span>' : ''}<span class="slot-time-icon"><i class="bi ${slot.part === 'morning' ? 'bi-sunrise' : 'bi-sunset'}"></i></span><strong>${slot.label}</strong><small>${available ? `${remaining} ${remaining === 1 ? 'seat' : 'seats'} available` : unavailableText}</small><div class="capacity-meter" aria-hidden="true"><span style="width:${Math.min(100, percent)}%"></span></div>`;
      button.addEventListener('click', () => onSelect(slot));
      (slot.part === 'morning' ? morningContainer : afternoonContainer).appendChild(button);
    });
  }

  function capacityLevelClass(percent, unavailable = false) {
    if (unavailable || percent >= 100) return 'capacity-full';
    if (percent >= 75) return 'capacity-high';
    if (percent >= 45) return 'capacity-medium';
    if (percent > 0) return 'capacity-low';
    return 'capacity-empty';
  }

  function updateRegistrationSelection() {
    if (!selectedDate || !selectedSlot) return;
    const slot = getSlot(selectedSlot);
    $('#selectedScheduleText').textContent = `${formatDate(selectedDate, { month: 'long', day: 'numeric' })} · ${slot.label}`;
    $('#selectionBar').classList.remove('d-none');
  }

  async function confirmRegistration() {
    if (!pendingStudent || !selectedDate || !selectedSlot) return;
    const button = $('#confirmRegistrationButton');
    setButtonBusy(button, true, 'Saving…');
    try {
      const dashboard = await withProcessLoading('Saving your registration', 'Reserving your selected seat and creating your queue ticket…', () => server('registerStudent', pendingStudent, selectedDate, selectedSlot));
      applyStudentDashboard(dashboard);
      activeStudentId = currentStudent.studentIdNumber;
      studentIdVisible = true;
      pendingStudent = null;
      setStep('done');
      toast('Registration confirmed', `Your batch is ${getSlot(currentStudent.slotId).label}.`);
      showStudentHome();
    } catch (error) {
      toast('Registration failed', error.message);
      await refreshPublicConfig();
      renderRegistrationDates();
      if (selectedDate) renderSlotsForDate(selectedDate, $('#morningSlots'), $('#afternoonSlots'), chooseRegistrationSlot, selectedSlot);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function renderStudentHome() {
    const student = currentStudent;
    if (!student) {
      clearStudentSession();
      showLogin();
      return;
    }

    $('#studentGreeting').textContent = `Hello, ${student.firstName}`;
    $('#myQueueNumber').textContent = student.queueNumber;
    renderStudentIdVisibility();
    $('#myDate').textContent = formatDate(student.date, { month: 'short', day: 'numeric' });
    $('#myTime').textContent = getSlot(student.slotId)?.label || student.slotId;
    $('#myPosition').textContent = `${student.position || 1} of ${CAPACITY}`;
    $('#studentStatus').textContent = statusLabel(student.status);
    $('#studentStatus').className = `status-pill status-${student.status}`;
    $('#rescheduleButton').disabled = ['ongoing', 'completed'].includes(student.status);

    renderStudentCall(student);
    renderLateCard(student);
    renderStudentBatch(student);
  }

  function renderStudentOngoing() {
    const student = currentStudent;
    if (!student) return;
    $('#ongoingStudentName').textContent = fullName(student);
    $('#ongoingQueueNumber').textContent = student.queueNumber;
    $('#ongoingScheduleText').textContent = `${formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' })} · ${getSlot(student.slotId)?.label || student.slotId}`;
    $('#ongoingStatusText').textContent = statusLabel(student.status);
    $('#ongoingBatchTitle').textContent = `${formatDate(student.date, { month: 'long', day: 'numeric' })} · ${getSlot(student.slotId)?.label || student.slotId}`;
    $('#ongoingBatchSubtitle').textContent = `${studentBatch.filter(item => scheduleMatches(item, student.date, student.slotId)).length} of ${CAPACITY} registered in this batch`;

    const ongoingMembers = studentBatch
      .filter(item => scheduleMatches(item, student.date, student.slotId) && item.status === 'ongoing')
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));

    $('#ongoingBatchList').innerHTML = ongoingMembers.length ? ongoingMembers.map(item => {
      const owner = Boolean(item.owner);
      const course = courseAbbreviation(item.course);
      return `<div class="participant-row roster-layout-row ${owner ? 'owner' : ''}"><div class="number">${item.sequence || 1}</div><div class="name"><strong>${escapeHtml(batchDisplayName(item) || `Student ${item.sequence || 1}`)}${owner ? '<span class="you-badge">YOU</span>' : ''}${course ? `<span class="course-abbr">– ${escapeHtml(course)}</span>` : ''}</strong><small class="participant-time">${escapeHtml(getSlot(item.slotId)?.label || item.slotId)}</small></div><div class="participant-meta"><strong class="participant-queue-number">${escapeHtml(item.queueNumber)}</strong><span class="row-status ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div></div>`;
    }).join('') : '<div class="empty-list">No ongoing participant is marked in this batch yet.</div>';

    renderStudentCall(student);
  }

  function renderStudentCompleted() {
    const student = currentStudent;
    if (!student) return;
    $('#completedStudentName').textContent = student.firstName || fullName(student);
    $('#completedScheduleText').textContent = `${formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' })} · ${getSlot(student.slotId)?.label || student.slotId}`;
  }

  function toggleStudentIdVisibility() {
    studentIdVisible = !studentIdVisible;
    renderStudentIdVisibility();
  }

  function renderStudentIdVisibility() {
    if (!currentStudent) return;
    const button = $('#toggleStudentIdVisibility');
    const fullId = normalizeStudentId(currentStudent.studentIdNumber);
    $('#myStudentId').textContent = studentIdVisible ? fullId : maskStudentId(fullId);
    button.innerHTML = `<i class="bi ${studentIdVisible ? 'bi-eye-slash' : 'bi-eye'}" aria-hidden="true"></i>`;
    button.setAttribute('aria-pressed', String(!studentIdVisible));
    button.setAttribute('aria-label', studentIdVisible ? 'Hide Student ID' : 'Show Student ID');
    button.setAttribute('title', studentIdVisible ? 'Hide Student ID' : 'Show Student ID');
  }

  function renderStudentCall(student) {
    const awaitingResponse = student.status === 'called' && !student.reminderResponse;
    $('#callCard').classList.add('d-none');
    $('#responseGrid').classList.toggle('d-none', !awaitingResponse);
    $('#responseNote').classList.toggle('d-none', !student.reminderResponse);
    const message = `Attention, user ${student.queueNumber}. This is a reminder to proceed with your registration. Please proceed to the CARES Office for assistance. Thank you.`;
    $('#callMessage').textContent = message;
    $('#callAlertMessage').textContent = message;

    if (awaitingResponse) {
      notifyStudent(student);
      showModal('callAlertModal');
      startReminderAlarm(student);
    } else {
      stopReminderAlarm();
      hideModal('callAlertModal');
    }

    if (student.reminderResponse) {
      $('#responseNote').textContent = `Your response: ${responseLabel(student.reminderResponse)}. The facilitator can see this update.`;
    }
  }

  async function handleStudentResponse(event) {
    const button = event.target.closest('[data-response]');
    if (!button || !currentStudent) return;
    setButtonBusy(button, true, 'Sending…');
    try {
      const dashboard = await withProcessLoading('Sending your response', 'Updating the facilitator with your latest response…', () => server('submitStudentResponse', currentStudent.studentIdNumber, button.dataset.response));
      applyStudentDashboard(dashboard);
      stopReminderAlarm();
      hideModal('callAlertModal');
      showStudentHome();
      toast('Response sent', 'The facilitator has been updated.');
      if (button.dataset.response === 'reschedule_requested') openReschedule();
    } catch (error) {
      toast('Response failed', error.message);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function handleStudentLineFilter(event) {
    const button = event.target.closest('[data-line-filter]');
    if (!button) return;
    studentLineFilter = button.dataset.lineFilter;
    $$('#studentStatusTabs button').forEach(item => item.classList.toggle('active', item === button));
    if (currentStudent) renderStudentBatch(currentStudent);
  }

  function renderStudentBatch(student) {
    const members = studentBatch.slice();
    const grouped = {
      pending: members.filter(item => !['ongoing', 'completed'].includes(item.status)),
      ongoing: members.filter(item => item.status === 'ongoing'),
      completed: members.filter(item => item.status === 'completed')
    };

    const ownerGroup = student.status === 'ongoing' ? 'ongoing' : student.status === 'completed' ? 'completed' : 'pending';
    if (!grouped[studentLineFilter].some(item => item.owner)) studentLineFilter = ownerGroup;

    $('#pendingLineCount').textContent = grouped.pending.length;
    $('#ongoingLineCount').textContent = grouped.ongoing.length;
    $('#completedLineCount').textContent = grouped.completed.length;
    $$('#studentStatusTabs button').forEach(button => button.classList.toggle('active', button.dataset.lineFilter === studentLineFilter));

    const isToday = student.date === TEST_TODAY_DATE;
    $('#batchBoardTitle').textContent = `${isToday ? 'Today' : formatDate(student.date, { weekday: 'short' })} · ${formatDate(student.date, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    $('#batchBoardSubtitle').textContent = `${getSlot(student.slotId)?.label || student.slotId} · ${members.length} of ${CAPACITY} registered`;

    const visibleMembers = grouped[studentLineFilter] || grouped.pending;
    $('#studentBatchList').innerHTML = visibleMembers.length ? visibleMembers.map(item => {
      const owner = Boolean(item.owner);
      const isNew = recentStudentBatchIds.has(String(item.id));
      return `<div class="participant-row roster-layout-row ${owner ? 'owner' : ''} ${isNew ? 'newly-added' : ''}"><div class="number">${item.sequence}</div><div class="name"><strong>${escapeHtml(batchDisplayName(item) || `Student ${item.sequence}`)}${owner ? '<span class="you-badge">YOU</span>' : ''}</strong><small class="participant-time">${escapeHtml(getSlot(item.slotId)?.label || item.slotId)}</small></div><div class="participant-meta"><strong class="participant-queue-number">${escapeHtml(item.queueNumber)}</strong><span class="row-status ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div></div>`;
    }).join('') : `<div class="empty-list">No ${escapeHtml(studentLineFilter)} participants in this batch.</div>`;
  }

  function renderLateCard(student) {
    const missed = hasSchedulePassed(student) && !['ongoing', 'completed'].includes(student.status);
    $('#lateCard').classList.toggle('d-none', !missed);
    if (!missed) return;

    $('#lateAvailableSlots').innerHTML = studentAvailableSlots.slice(0, 6).map(item => {
      const slot = getSlot(item.slotId);
      return `<button type="button" data-late-date="${item.date}" data-late-slot="${item.slotId}"><strong>${formatDate(item.date, { month: 'short', day: 'numeric' })}</strong><small>${escapeHtml(slot?.label || item.slotId)} · ${item.remaining} seats</small></button>`;
    }).join('');
    $$('#lateAvailableSlots button').forEach(button => button.addEventListener('click', () => quickLateReschedule(button.dataset.lateDate, button.dataset.lateSlot)));
    $('#openMessageButton').classList.toggle('d-none', studentAvailableSlots.length > 0);
  }

  async function quickLateReschedule(date, slotId) {
    if (!currentStudent) return;
    await applyReschedule(date, slotId);
  }

  async function openReschedule() {
    if (!currentStudent || ['ongoing', 'completed'].includes(currentStudent.status)) return;
    try {
      await withProcessLoading('Checking reschedule options', 'Looking for available dates and time slots…', refreshPublicConfig);
    } catch (error) {
      toast('Seat check failed', error.message);
      return;
    }
    rescheduleDate = null;
    rescheduleSlot = null;
    $('#confirmRescheduleButton').disabled = true;
    $('#rescheduleChoice').textContent = 'Select a date and batch';
    $('#rescheduleSlotGroups').classList.add('d-none');
    renderRescheduleDates();
    showModal('rescheduleModal');
  }

  function renderRescheduleDates() {
    renderDateCards($('#rescheduleDateGrid'), rescheduleDate, date => {
      rescheduleDate = date;
      rescheduleSlot = null;
      renderRescheduleDates();
      $('#rescheduleSlotGroups').classList.remove('d-none');
      renderRescheduleSlots();
    });
  }

  function renderRescheduleSlots() {
    const choose = slot => {
      if (rescheduleDate === currentStudent.date && slot.id === currentStudent.slotId) {
        toast('Current batch', 'Choose a different date or time.');
        return;
      }
      rescheduleSlot = slot.id;
      renderSlotsForDate(rescheduleDate, $('#rescheduleMorningSlots'), $('#rescheduleAfternoonSlots'), choose, rescheduleSlot);
      $('#rescheduleChoice').textContent = `${formatDate(rescheduleDate, { month: 'long', day: 'numeric' })} · ${slot.label}`;
      $('#confirmRescheduleButton').disabled = false;
    };
    renderSlotsForDate(rescheduleDate, $('#rescheduleMorningSlots'), $('#rescheduleAfternoonSlots'), choose, rescheduleSlot);
  }

  async function confirmReschedule() {
    if (!currentStudent || !rescheduleDate || !rescheduleSlot) return;
    const button = $('#confirmRescheduleButton');
    setButtonBusy(button, true, 'Saving…');
    try {
      await applyReschedule(rescheduleDate, rescheduleSlot);
      hideModal('rescheduleModal');
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function applyReschedule(date, slotId) {
    if (!currentStudent) return;
    try {
      const dashboard = await withProcessLoading('Updating your schedule', 'Moving your registration to the selected batch…', () => server('rescheduleStudent', currentStudent.studentIdNumber, date, slotId));
      applyStudentDashboard(dashboard);
      showStudentHome();
      toast('Schedule updated', `${formatDate(date, { month: 'long', day: 'numeric' })}, ${getSlot(slotId)?.label || slotId}`);
    } catch (error) {
      toast('Reschedule failed', error.message);
      await refreshStudentData(true);
    }
  }

  async function sendRescheduleMessage() {
    const message = $('#rescheduleMessage').value.trim();
    if (!currentStudent || !message) {
      toast('Message required', 'Write a short rescheduling request.');
      return;
    }

    const button = $('#sendMessageButton');
    setButtonBusy(button, true, 'Sending…');
    try {
      const dashboard = await withProcessLoading('Sending your request', 'Delivering your rescheduling message to the facilitator…', () => server('sendRescheduleMessage', currentStudent.studentIdNumber, message));
      applyStudentDashboard(dashboard);
      $('#rescheduleMessage').value = '';
      hideModal('messageModal');
      showStudentHome();
      toast('Message sent', 'The facilitator can now review your rescheduling request.');
    } catch (error) {
      toast('Message failed', error.message);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function showQrTicket() {
    if (!currentStudent) return;
    $('#qrCode').innerHTML = '';
    if (window.QRCode) {
      new QRCode($('#qrCode'), { text: currentStudent.ticketCode, width: 196, height: 196, correctLevel: QRCode.CorrectLevel.M });
    } else {
      $('#qrCode').textContent = currentStudent.ticketCode;
    }
    $('#qrQueue').textContent = currentStudent.queueNumber;
    $('#qrName').textContent = fullName(currentStudent);
    $('#qrStudentId').textContent = currentStudent.studentIdNumber;
    $('#qrSchedule').textContent = `${formatDate(currentStudent.date, { month: 'long', day: 'numeric' })} · ${getSlot(currentStudent.slotId)?.label || currentStudent.slotId}`;
    showModal('qrModal');
  }



  async function routeHomeWithLatestData() {
    try {
      if (facilitatorToken && currentFacilitator) {
        switchFacView('appointments');
        renderFacilitator();
        window.scrollTo(0, 0);
        return;
      }
      if (activeStudentId && currentStudent) {
        await withProcessLoading('Refreshing student portal', 'Reading the latest registration and batch rows…', () => refreshStudentData(true));
        showStudentHome();
        return;
      }
      showLogin();
    } catch (error) {
      toast('Unable to open portal', error.message);
    }
  }


  function switchFacView(view) {
    const allowed = ['appointments', 'dashboard', 'messages'];
    const nextView = allowed.includes(view) ? view : 'appointments';
    if (nextView !== 'messages') previousFacView = nextView;
    activeFacView = nextView;
    if (nextView !== 'appointments') closeSelectedStudentSheet();
    $('#appointmentsView').classList.toggle('d-none', nextView !== 'appointments');
    $('#dashboardView').classList.toggle('d-none', nextView !== 'dashboard');
    $('#messagesView').classList.toggle('d-none', nextView !== 'messages');
    $$('.fac-nav').forEach(button => button.classList.toggle('active', button.dataset.facView === nextView));
    $('#floatingMessageButton').classList.toggle('active', nextView === 'messages');
    if (nextView === 'dashboard') renderFacilitatorDashboard();
    if (nextView === 'messages') renderMessages();
  }

  async function openFacilitatorView(view) {
    switchFacView(view);
  }

  async function openScannerWithLatestData() {
    showModal('scannerModal');
  }

  async function refreshFacilitatorSelection(selection = {}) {
    const token = getFacilitatorToken();
    if (!token) return;
    const requestId = ++facSelectionRequestSerial;
    const requestedDate = normalizeDateKey(selection.date || facDate);
    const requestedPart = String(selection.part || facPart || 'morning');
    const requestedSlot = normalizeSlotId(selection.slot || facSlot);

    facDate = requestedDate || facDate;
    facPart = requestedPart;
    if (selection.slot) facSlot = requestedSlot;
    else if (selection.part) facSlot = TIME_SLOTS.find(slot => slot.part === facPart)?.id || '';
    facSelectionTouched = true;
    closeSelectedStudentSheet();
    document.body.classList.add('fac-selection-loading');
    setLiveSyncState('syncing', 'Fetching latest data…');

    try {
      const data = await server('getFacilitatorState', token, getDeviceId());
      if (requestId !== facSelectionRequestSerial) return;
      applyFacilitatorState(data);
      if (requestedDate && EVENT_DATES.includes(requestedDate)) facDate = requestedDate;
      facPart = requestedPart;
      if (selection.slot && getSlot(requestedSlot)?.part === facPart) facSlot = requestedSlot;
      else if (!getSlot(facSlot) || getSlot(facSlot).part !== facPart) facSlot = TIME_SLOTS.find(slot => slot.part === facPart)?.id || '';
      renderFacilitator();
      setLiveSyncState('connected', `Updated ${formatSyncClock()}`);
      hideOfflineModal();
    } catch (error) {
      if (requestId === facSelectionRequestSerial) {
        if (/session|facilitator account/i.test(error.message)) {
          clearFacilitatorSession();
          showLogin(true);
          toast('Session ended', 'Please sign in again.');
        } else {
          setLiveSyncState('warning', 'Refresh failed');
          toast('Unable to refresh selection', error.message);
          if (isNetworkFailure(error)) showOfflineModal();
        }
      }
    } finally {
      if (requestId === facSelectionRequestSerial) document.body.classList.remove('fac-selection-loading');
    }
  }

  function renderFacilitator() {
    renderFacilitatorWelcome();
    renderFacDateTabs();
    renderFacPartTabs();
    ensureFacSlot();
    applyFacilitatorDayPartTheme();
    renderFacBatchStrip();
    renderFacRoster();
    renderSelectedStudent();
    renderFacilitatorDashboard();
    renderMessages();
    switchFacView(activeFacView);
  }

  function renderFacilitatorWelcome() {
    const hour = getServerNow().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const name = currentFacilitator?.name || 'Facilitator';
    const active = state.students.filter(student => student.status !== 'cancelled');
    $('#facGreeting').textContent = `${greeting}, ${name}`;
    $('#facTodayLabel').textContent = new Intl.DateTimeFormat('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(getServerNow());
    $('#facSummaryRegistered').textContent = active.length;
    $('#facSummaryPending').textContent = active.filter(student => !['ongoing', 'completed', 'no_show'].includes(student.status)).length;
    $('#facSummaryOngoing').textContent = active.filter(student => student.status === 'ongoing').length;
  }

  function renderFacDateTabs() {
    $('#facDateTabs').innerHTML = EVENT_DATES.map(date => {
      const isOpen = OPEN_EVENT_DATES.includes(date);
      return `<button type="button" class="${facDate === date ? 'active' : ''} ${isOpen ? '' : 'closed-date'}" data-date="${date}">${date === TEST_TODAY_DATE ? 'Today · ' : ''}${formatDate(date, { month: 'short', day: 'numeric' })}${isOpen ? '' : '<small>Closed</small>'}</button>`;
    }).join('');
    $$('#facDateTabs button').forEach(button => button.addEventListener('click', () => {
      refreshFacilitatorSelection({ date: button.dataset.date });
    }));
  }

  function renderFacPartTabs() {
    $$('#dayPartTabs button').forEach(button => button.classList.toggle('active', button.dataset.part === facPart));
    applyFacilitatorDayPartTheme();
  }

  function applyFacilitatorDayPartTheme() {
    const facilitatorVisible = !$('#facilitatorScreen')?.classList.contains('d-none');
    document.body.classList.toggle('fac-afternoon-theme', facilitatorVisible && facPart === 'afternoon');
  }

  function handlePartTab(event) {
    const button = event.target.closest('[data-part]');
    const nextPart = String(button?.dataset.part || '');
    if (!button || !['morning', 'afternoon'].includes(nextPart) || nextPart === facPart) return;
    facPart = nextPart;
    facSlot = TIME_SLOTS.find(slot => slot.part === facPart)?.id || '';
    facSelectionTouched = true;
    closeSelectedStudentSheet();
    renderFacPartTabs();
    renderFacBatchStrip();
    renderFacRoster();
    setLiveSyncState('idle', `${properCase(facPart)} appointments selected`);
  }

  function ensureFacSlot() {
    const slot = getSlot(facSlot);
    if (!slot || slot.part !== facPart) facSlot = TIME_SLOTS.find(item => item.part === facPart)?.id || '';
  }

  function renderFacBatchStrip() {
    const slots = TIME_SLOTS.filter(slot => slot.part === facPart);
    $('#facBatchStrip').innerHTML = slots.map(slot => {
      const slotStudents = state.students.filter(item => scheduleMatches(item, facDate, slot.id) && item.status !== 'cancelled');
      const count = slotStudents.length;
      const completedCount = slotStudents.filter(item => item.status === 'completed').length;
      const current = isCurrentFacilitatorBatch(facDate, slot.id);
      const ended = getSlotEnd(facDate, slot) <= getServerNow();
      const emptyEnded = ended && count === 0;
      const fill = Math.min(100, (completedCount / Math.max(1, CAPACITY)) * 100);
      const allCompleted = completedCount >= CAPACITY;
      const statusText = current
        ? `${count} registered · ${completedCount}/${CAPACITY} completed · in progress`
        : ended
          ? `${count} registered · ${completedCount}/${CAPACITY} completed · ended`
          : `${count} registered · ${completedCount}/${CAPACITY} completed`;
      return `<button type="button" class="batch-card ${facSlot === slot.id ? 'active' : ''} ${count >= CAPACITY ? 'full' : ''} ${current ? 'current' : ''} ${ended ? 'ended' : ''} ${allCompleted ? 'completed-batch' : ''}" data-slot="${slot.id}" ${emptyEnded ? 'disabled' : ''}><span class="batch-card-top"><strong>${slot.label}</strong>${current ? '<b class="current-batch-badge">NOW</b>' : ended ? '<b class="ended-batch-badge">ENDED</b>' : ''}</span><small>${statusText}</small><span class="batch-fill completed-progress-fill" style="--batch-fill:${fill}%"></span></button>`;
    }).join('');
    $$('#facBatchStrip button:not(:disabled)').forEach(button => button.addEventListener('click', () => {
      const nextSlot = normalizeSlotId(button.dataset.slot);
      if (!nextSlot || nextSlot === facSlot) return;
      facSlot = nextSlot;
      facPart = getSlot(nextSlot)?.part || facPart;
      facSelectionTouched = true;
      closeSelectedStudentSheet();
      renderFacPartTabs();
      renderFacBatchStrip();
      renderFacRoster();
      setLiveSyncState('idle', `${getSlot(facSlot)?.label || 'Batch'} selected`);
    }));
  }

  function renderFacRoster() {
    const query = $('#facSearch').value.trim().toLowerCase();
    const queryDigits = query.replace(/\D/g, '');
    const batchRoster = state.students
      .filter(item => scheduleMatches(item, facDate, facSlot) && item.status !== 'cancelled')
      .sort((a, b) => facilitatorRosterRank(a.status) - facilitatorRosterRank(b.status) || Number(a.sequence || 0) - Number(b.sequence || 0));
    const roster = batchRoster.filter(item => !query ||
      fullName(item).toLowerCase().includes(query) ||
      String(item.course || '').toLowerCase().includes(query) ||
      courseAbbreviation(item.course).toLowerCase().includes(query) ||
      (queryDigits && String(item.studentIdNumber || '').replace(/\D/g, '').includes(queryDigits)) ||
      String(item.queueNumber).toLowerCase().includes(query));

    $('#facBatchTitle').textContent = `${facDate ? formatDate(facDate, { month: 'long', day: 'numeric' }) : 'No date'} · ${getSlot(facSlot)?.label || 'No batch'}`;
    $('#facBatchCapacity').textContent = query
      ? `Showing ${roster.length} of ${batchRoster.length} registered`
      : `${batchRoster.length} of ${CAPACITY} registered`;
    $('#facRoster').innerHTML = roster.length ? roster.map(item => {
      const course = courseAbbreviation(item.course);
      return `<button type="button" class="participant-row roster-layout-row ${selectedFacStudentId === item.id ? 'selected' : ''} ${recentFacilitatorIds.has(String(item.id)) ? 'newly-added' : ''}" data-student-id="${item.id}" aria-haspopup="dialog" aria-controls="selectedStudentModal" aria-label="Open information for ${escapeHtml(fullName(item))}"><div class="number">${item.sequence || 1}</div><div class="name"><strong>${escapeHtml(fullName(item) || `Student ${item.sequence || 1}`)}${course ? `<span class="course-abbr">– ${escapeHtml(course)}</span>` : ''}</strong><small class="participant-time">${escapeHtml(getSlot(item.slotId)?.label || item.slotId)}</small></div><div class="participant-meta"><strong class="participant-queue-number">${escapeHtml(item.queueNumber)}</strong><span class="row-status ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div></button>`;
    }).join('') : '<div class="empty-list">No students registered in this batch.</div>';
    $$('#facRoster [data-student-id]').forEach(button => button.addEventListener('click', () => {
      openSelectedStudentSheet(button.dataset.studentId);
    }));
  }

  function openSelectedStudentSheet(studentId) {
    const student = state.students.find(item => item.id === studentId);
    if (!student) {
      toast('Student unavailable', 'Refresh the facilitator data and try again.');
      return;
    }

    selectedFacStudentId = studentId;
    renderFacRoster();
    renderSelectedStudent();
    showModal('selectedStudentModal');
  }

  function closeSelectedStudentSheet(clearSelection = true) {
    const modalElement = $('#selectedStudentModal');
    if (!modalElement) return;
    if (clearSelection) selectedFacStudentId = null;
    const modal = bootstrap.Modal.getInstance(modalElement);
    if (modal) modal.hide();
    renderSelectedStudent();
    renderFacRoster();
  }

  function handleSelectedStudentSheetHidden() {
    selectedFacStudentId = null;
    const sheet = $('#selectedStudentCard');
    if (sheet) {
      sheet.classList.remove('is-dragging');
      sheet.style.removeProperty('transform');
    }
    renderSelectedStudent();
    renderFacRoster();
  }

  function initializeSelectedStudentSheet() {
    const modalElement = $('#selectedStudentModal');
    const sheet = $('#selectedStudentCard');
    const dragZone = $('#selectedStudentSheetHandle');
    if (!modalElement || !sheet || !dragZone || sheet.dataset.swipeBound === 'true') return;

    let startY = 0;
    let distanceY = 0;
    let dragging = false;

    const resetSheetPosition = () => {
      dragging = false;
      distanceY = 0;
      sheet.classList.remove('is-dragging');
      sheet.style.removeProperty('transform');
    };

    const beginDrag = event => {
      if (!event.touches || event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
      distanceY = 0;
      dragging = true;
      sheet.classList.add('is-dragging');
    };

    const moveDrag = event => {
      if (!dragging || !event.touches || event.touches.length !== 1) return;
      distanceY = Math.max(0, event.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${distanceY}px)`;
    };

    const endDrag = () => {
      if (!dragging) return;
      const shouldClose = distanceY > Math.min(140, sheet.offsetHeight * 0.22);
      if (shouldClose) {
        const modal = bootstrap.Modal.getInstance(modalElement);
        if (modal) modal.hide();
      } else {
        resetSheetPosition();
      }
    };

    dragZone.addEventListener('touchstart', beginDrag, { passive: true });
    dragZone.addEventListener('touchmove', moveDrag, { passive: true });
    dragZone.addEventListener('touchend', endDrag, { passive: true });
    dragZone.addEventListener('touchcancel', resetSheetPosition, { passive: true });
    modalElement.addEventListener('show.bs.modal', resetSheetPosition);
    sheet.dataset.swipeBound = 'true';
  }

  function renderSelectedStudent() {
    const student = state.students.find(item => item.id === selectedFacStudentId);
    $('#emptySelection').classList.toggle('d-none', Boolean(student));
    $('#selectedStudentDetails').classList.toggle('d-none', !student);
    if (!student) return;

    $('#selectedName').textContent = fullName(student);
    $('#selectedStudentId').textContent = `Student ID: ${student.studentIdNumber || 'Not assigned'}`;
    $('#selectedQueue').textContent = student.queueNumber;
    $('#selectedBatch').textContent = getSlot(student.slotId)?.label || student.slotId;
    $('#selectedResponse').textContent = responseLabel(student.reminderResponse) || 'No reminder response';
    $('#selectedStatus').textContent = statusLabel(student.status);
    $('#selectedStatus').className = `status-pill status-${student.status}`;
    $('#selectedResponseHistory').innerHTML = student.calledAt
      ? `<strong>Last reminder:</strong> ${formatDateTime(student.calledAt)}<br><strong>Student response:</strong> ${escapeHtml(responseLabel(student.reminderResponse) || 'Awaiting response')}`
      : 'No reminder has been sent to this student.';
    $('#markOngoingButton').disabled = student.status === 'completed';
    $('#markCompleteButton').disabled = student.status === 'completed';
  }

  async function callSelectedStudent() {
    const student = state.students.find(item => item.id === selectedFacStudentId);
    if (!student) return;
    const button = $('#callStudentButton');
    setButtonBusy(button, true, 'Calling…');
    try {
      const result = await withProcessLoading('Calling the selected student', 'Saving the reminder and updating the facilitator view…', () => server('facilitatorCallStudent', getFacilitatorToken(), getDeviceId(), student.id));
      mergeFacilitatorStudent(result.student);
      await refreshFacilitatorData(true);
      toast('Reminder sent', `${student.queueNumber} will see an alert and sound.`);
    } catch (error) {
      toast('Call failed', error.message);
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function updateSelectedStatus(status) {
    const student = state.students.find(item => item.id === selectedFacStudentId);
    if (!student) return;
    const buttonMap = { ongoing: $('#markOngoingButton'), completed: $('#markCompleteButton'), no_show: $('#markNoShowButton') };
    const button = buttonMap[status];
    setButtonBusy(button, true, 'Updating…');
    try {
      const result = await withProcessLoading('Updating student status', 'Saving the selected status and refreshing this student card…', () => server('facilitatorUpdateStudentStatus', getFacilitatorToken(), getDeviceId(), student.id, status));
      mergeFacilitatorStudent(result.student);
      await refreshFacilitatorData(true);
      toast('Status updated', `${student.queueNumber} is now ${statusLabel(status)}.`);
    } catch (error) {
      toast('Update failed', error.message);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function openAppointmentSettings() {
    appointmentSettingsDates = OPEN_EVENT_DATES.slice().sort();
    $('#appointmentCapacityInput').value = String(CAPACITY);
    $('#appointmentDateInput').value = '';
    $('#appointmentDateInput').min = TEST_TODAY_DATE || normalizeDateKey(new Date());
    renderAppointmentSettingsDateList();
    renderAppointmentSettingsPreview();
    showModal('appointmentSettingsModal');
  }

  function adjustAppointmentCapacity(delta) {
    const input = $('#appointmentCapacityInput');
    const current = Math.floor(Number(input.value || CAPACITY || 10));
    input.value = String(Math.max(1, Math.min(200, current + delta)));
    renderAppointmentSettingsPreview();
  }

  function addAppointmentDateFromInput() {
    const input = $('#appointmentDateInput');
    const date = normalizeDateKey(input.value);
    if (!date) {
      toast('Choose a date', 'Select an appointment date before adding it.');
      return;
    }
    if (!appointmentSettingsDates.includes(date)) appointmentSettingsDates.push(date);
    appointmentSettingsDates.sort();
    input.value = '';
    renderAppointmentSettingsDateList();
    renderAppointmentSettingsPreview();
  }

  function removeAppointmentDate(date) {
    appointmentSettingsDates = appointmentSettingsDates.filter(item => item !== date);
    renderAppointmentSettingsDateList();
    renderAppointmentSettingsPreview();
  }

  function renderAppointmentSettingsDateList() {
    const wrap = $('#openAppointmentDateList');
    wrap.innerHTML = appointmentSettingsDates.length ? appointmentSettingsDates.map(date =>
      `<span class="open-date-chip"><i class="bi bi-calendar2-check"></i><strong>${escapeHtml(formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' }))}</strong><button type="button" data-remove-open-date="${date}" aria-label="Remove ${escapeHtml(date)}"><i class="bi bi-x-lg"></i></button></span>`
    ).join('') : '<div class="settings-empty-date">No open appointment date yet.</div>';
    $$('[data-remove-open-date]').forEach(button => button.addEventListener('click', () => removeAppointmentDate(button.dataset.removeOpenDate)));
  }

  function renderAppointmentSettingsPreview() {
    const capacity = Math.max(1, Math.min(200, Math.floor(Number($('#appointmentCapacityInput').value || 1))));
    $('#settingsCapacityPreview').textContent = capacity;
    $('#settingsDateCountPreview').textContent = appointmentSettingsDates.length;
  }

  async function saveAppointmentSettings() {
    const capacity = Math.floor(Number($('#appointmentCapacityInput').value));
    if (!Number.isFinite(capacity) || capacity < 1 || capacity > 200) {
      toast('Invalid capacity', 'Enter a whole number from 1 to 200 students per hour.');
      return;
    }
    if (!appointmentSettingsDates.length) {
      toast('Open date required', 'Add at least one date that students can select.');
      return;
    }

    const button = $('#saveAppointmentSettingsButton');
    setButtonBusy(button, true, 'Saving…');
    try {
      const result = await withProcessLoading('Saving appointment settings', 'Updating the hourly limit and open dates for every student…', () =>
        server('facilitatorUpdateAppointmentSettings', getFacilitatorToken(), getDeviceId(), {
          capacity,
          openEventDates: appointmentSettingsDates.slice()
        })
      );
      if (result.config) applyConfig(result.config);
      hideModal('appointmentSettingsModal');
      await refreshFacilitatorData(true);
      selectRelevantFacilitatorSchedule(false);
      renderFacilitator();
      toast('Appointment settings saved', `${CAPACITY} students per hour · ${OPEN_EVENT_DATES.length} open date${OPEN_EVENT_DATES.length === 1 ? '' : 's'}.`);
    } catch (error) {
      toast('Settings not saved', error.message);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function renderFacilitatorDashboard() {
    const registrations = state.students.filter(student => student.status !== 'cancelled');
    const completed = registrations.filter(student => student.status === 'completed');
    const pending = registrations.filter(student => !['completed', 'no_show'].includes(student.status));
    const collegeMap = new Map();

    registrations.forEach(student => {
      const college = String(student.college || 'Unspecified college').trim() || 'Unspecified college';
      if (!collegeMap.has(college)) collegeMap.set(college, { college, registered: 0, completed: 0, pending: 0 });
      const row = collegeMap.get(college);
      row.registered += 1;
      if (student.status === 'completed') row.completed += 1;
      else if (student.status !== 'no_show') row.pending += 1;
    });

    const collegeRows = [...collegeMap.values()].sort((a, b) => b.completed - a.completed || b.registered - a.registered || a.college.localeCompare(b.college));
    const topCollege = collegeRows[0] || null;
    const maxCompleted = Math.max(1, ...collegeRows.map(row => row.completed));
    const completionRate = registrations.length ? Math.round((completed.length / registrations.length) * 100) : 0;

    $('#facDashboardCompleted').textContent = completed.length;
    $('#facDashboardRate').textContent = `${completionRate}%`;
    $('#facDashboardTopCollege').textContent = topCollege ? collegeAbbreviation(topCollege.college) : '—';
    $('#facDashboardPending').textContent = pending.length;

    $('#collegeCompletionChart').innerHTML = collegeRows.length ? collegeRows.map((row, index) => {
      const percentage = (row.completed / maxCompleted) * 100;
      return `<div class="college-chart-row"><div class="college-chart-label"><span>${index + 1}</span><div><strong>${escapeHtml(collegeAbbreviation(row.college))}</strong><small>${escapeHtml(shortCollege(row.college))}</small></div></div><div class="college-chart-track"><span style="--college-bar:${percentage}%"></span></div><div class="college-chart-value"><strong>${row.completed}</strong><small>of ${row.registered}</small></div></div>`;
    }).join('') : '<div class="empty-list">No registration records are available for the graph.</div>';

    if (topCollege && topCollege.completed > 0) {
      const runnerUp = collegeRows[1];
      const leadText = runnerUp ? `, ${Math.max(0, topCollege.completed - runnerUp.completed)} ahead of the next college` : '';
      $('#facDashboardInsight').textContent = `${collegeAbbreviation(topCollege.college)} leads with ${topCollege.completed} completed registration${topCollege.completed === 1 ? '' : 's'}${leadText}.`;
    } else if (registrations.length) {
      $('#facDashboardInsight').textContent = 'Registrations are present, but no appointment has been marked Completed yet.';
    } else {
      $('#facDashboardInsight').textContent = 'No registration data is currently loaded.';
    }

    const batchCounts = new Map();
    registrations.forEach(student => {
      const key = `${student.date}|${student.slotId}`;
      batchCounts.set(key, (batchCounts.get(key) || 0) + 1);
    });
    const busiest = [...batchCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (busiest) {
      const [date, slotId] = busiest[0].split('|');
      $('#facDashboardBusiest').textContent = `${formatDate(date, { month: 'short', day: 'numeric' })} · ${getSlot(slotId)?.label || slotId} (${busiest[1]})`;
    } else {
      $('#facDashboardBusiest').textContent = 'No appointments yet';
    }
  }

  function renderMessages() {
    const callResponses = state.students
      .filter(student => student.calledAt && student.reminderResponse && student.respondedAt)
      .sort((a, b) => new Date(b.respondedAt) - new Date(a.respondedAt));
    const messages = [...state.messages].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const newCount = messages.filter(item => item.status === 'new').length + callResponses.length;
    $('#messageCount').textContent = newCount;
    $('#messageCount').classList.toggle('d-none', newCount === 0);

    $('#facCallResponseList').innerHTML = callResponses.length ? callResponses.map(student => {
      const course = courseAbbreviation(student.course) || 'Course not set';
      const response = responseLabel(student.reminderResponse) || properCase(student.reminderResponse);
      return `<article class="message-item call-response-item"><div><span class="eyebrow">CALL RESPONSE</span><h3>${escapeHtml(fullName(student))} <span class="message-course">– ${escapeHtml(course)}</span></h3><small>${escapeHtml(getSlot(student.slotId)?.label || student.slotId)} / ${escapeHtml(formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' }))}</small><p><strong>Responded message:</strong> ${escapeHtml(response)}</p><em>${escapeHtml(formatDateTime(student.respondedAt))}</em></div></article>`;
    }).join('') : '<div class="surface empty-list">No student has responded to a Call/Remind alert yet.</div>';

    $('#facMessageList').innerHTML = messages.length ? messages.map(message => {
      const student = state.students.find(item => item.id === message.studentId);
      const studentIdNumber = student?.studentIdNumber || message.studentIdNumber || 'Student ID not assigned';
      const course = courseAbbreviation(student?.course) || 'Course not set';
      const schedule = student ? `${getSlot(student.slotId)?.label || student.slotId} / ${formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' })}` : formatDateTime(message.createdAt);
      return `<article class="message-item"><div><span class="eyebrow">${escapeHtml(String(message.status).toUpperCase())}</span><h3>${escapeHtml(student ? fullName(student) : studentIdNumber)} <span class="message-course">– ${escapeHtml(course)}</span></h3><small>${escapeHtml(schedule)}</small><p><strong>Message:</strong> ${escapeHtml(message.message)}</p></div><button class="btn btn-outline-primary btn-sm" type="button" data-message-id="${message.id}" ${message.status === 'reviewed' ? 'disabled' : ''}>${message.status === 'reviewed' ? 'Reviewed' : 'Mark reviewed'}</button></article>`;
    }).join('') : '<div class="surface empty-list">No rescheduling messages.</div>';

    $$('[data-message-id]').forEach(button => button.addEventListener('click', async () => {
      setButtonBusy(button, true, 'Saving…');
      try {
        const result = await withProcessLoading('Reviewing student message', 'Saving the reviewed status for this request…', () => server('facilitatorReviewMessage', getFacilitatorToken(), getDeviceId(), button.dataset.messageId));
        mergeFacilitatorMessage(result.message);
        renderMessages();
      } catch (error) {
        toast('Unable to review', error.message);
      } finally {
        setButtonBusy(button, false);
      }
    }));
  }

  async function startQrScanner() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Camera unavailable', 'Use the Student ID or QR value field instead.');
      return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      $('#scannerVideo').srcObject = scanStream;
      await $('#scannerVideo').play();
      if (!('BarcodeDetector' in window)) {
        toast('Live scanning unsupported', 'The camera is open, but use manual entry in this browser.');
        return;
      }
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      scanTimer = window.setInterval(async () => {
        try {
          const codes = await detector.detect($('#scannerVideo'));
          if (codes.length) findStudentFromScan(codes[0].rawValue);
        } catch (_) { /* keep scanning */ }
      }, 700);
    } catch (_) {
      toast('Camera blocked', 'Allow camera access or use manual entry.');
    }
  }

  function stopQrScanner() {
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = null;
    if (scanStream) scanStream.getTracks().forEach(track => track.stop());
    scanStream = null;
    $('#scannerVideo').srcObject = null;
  }

  function manualScan() {
    findStudentFromScan($('#manualScanValue').value.trim());
  }

  function findStudentFromScan(value) {
    const normalizedStudentId = normalizeStudentId(value);
    const student = state.students.find(item =>
      String(item.ticketCode || '') === value ||
      (isValidStudentId(normalizedStudentId) && normalizeStudentId(item.studentIdNumber) === normalizedStudentId) ||
      String(item.queueNumber || '').toLowerCase() === String(value || '').toLowerCase()
    );

    if (!student) {
      toast('Student not found', 'The QR or Student ID does not match a registration.');
      return;
    }
    facDate = normalizeDateKey(student.date);
    facSlot = normalizeSlotId(student.slotId);
    facPart = getSlot(student.slotId)?.part || 'morning';
    selectedFacStudentId = student.id;
    const scannerModal = $('#scannerModal');
    scannerModal.addEventListener('hidden.bs.modal', () => openSelectedStudentSheet(student.id), { once: true });
    hideModal('scannerModal');
    stopQrScanner();
    switchFacView('appointments');
    renderFacilitator();
    toast('Ticket verified', `${student.queueNumber} · Student ID ${student.studentIdNumber}. The complete ID is shown in the slide-up student sheet.`);
  }

  function countFacilitatorSlot(date, slotId) {
    const indexed = getSlotAvailability(date, slotId);
    if (indexed && Number.isFinite(Number(indexed.count))) return Number(indexed.count);
    return state.students.filter(item => scheduleMatches(item, date, slotId) && item.status !== 'cancelled').length;
  }

  function scheduleMatches(item, date, slotId) {
    return normalizeDateKey(item?.date) === normalizeDateKey(date) && normalizeSlotId(item?.slotId) === normalizeSlotId(slotId);
  }

  function countInSlot(date, slotId) {
    const slot = getSlotAvailability(date, slotId);
    return Number(slot?.count || 0);
  }

  function isSlotAvailable(date, slotId) {
    return Boolean(getSlotAvailability(date, slotId)?.available);
  }

  function getSlotAvailability(date, slotId) {
    return availabilityIndex.get(normalizeDateKey(date))?.slotMap?.get(normalizeSlotId(slotId)) || null;
  }

  function hasSchedulePassed(student) {
    return getSlotEnd(student.date, getSlot(student.slotId)) <= getServerNow();
  }

  function getSlotStart(date, slot) {
    return new Date(`${normalizeDateKey(date)}T${normalizeClock(slot?.start)}:00+08:00`);
  }

  function getSlotEnd(date, slot) {
    return new Date(`${normalizeDateKey(date)}T${normalizeClock(slot?.end)}:00+08:00`);
  }

  function getServerNow() {
    return new Date(Date.now() + serverClockOffset);
  }

  function getRecommendedSlot(date) {
    return TIME_SLOTS
      .filter(slot => isSlotAvailable(date, slot.id))
      .sort((a, b) => countInSlot(date, a.id) - countInSlot(date, b.id) || getSlotStart(date, a) - getSlotStart(date, b))[0] || null;
  }

  function firstAvailableDate() {
    return EVENT_DATES.find(date => TIME_SLOTS.some(slot => isSlotAvailable(date, slot.id))) || null;
  }

  function getSlot(id) {
    const normalizedId = normalizeSlotId(id);
    return TIME_SLOTS.find(slot => slot.id === normalizedId);
  }

  function getDeviceId() {
    return deviceId;
  }

  function saveFacilitatorToken(token) {
    facilitatorToken = String(token || '');
  }

  function getFacilitatorToken() {
    return facilitatorToken;
  }

  function clearFacilitatorToken() {
    facilitatorToken = '';
  }

  function notifyStudent(student) {
    const key = `${student.id}:${student.calledAt || ''}`;
    if (notifiedStudentCalls.has(key)) return;
    notifiedStudentCalls.add(key);
  }

  function startReminderAlarm(student) {
    const key = `${student.id}:${student.calledAt || ''}`;
    if (reminderAlarmKey === key && reminderAlarmTimer) return;
    stopReminderAlarm();
    reminderAlarmKey = key;
    playReminderAlarm(student);
    reminderAlarmTimer = window.setInterval(() => playReminderAlarm(student), 12000);
    if (navigator.vibrate) {
      navigator.vibrate([180, 140, 220]);
      reminderVibrationTimer = window.setInterval(() => navigator.vibrate([180, 140, 220]), 12000);
    }
  }

  function stopReminderAlarm() {
    if (reminderAlarmTimer) window.clearInterval(reminderAlarmTimer);
    if (reminderVibrationTimer) window.clearInterval(reminderVibrationTimer);
    reminderAlarmTimer = null;
    reminderVibrationTimer = null;
    reminderAlarmKey = '';
    if (navigator.vibrate) navigator.vibrate(0);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  function playFlightAttendantChime() {
    if (!soundEnabled) return;
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const master = context.createGain();
      master.gain.setValueAtTime(.0001, context.currentTime);
      master.gain.exponentialRampToValueAtTime(.065, context.currentTime + .04);
      master.gain.exponentialRampToValueAtTime(.0001, context.currentTime + 1.35);
      master.connect(context.destination);

      [
        { at: 0, frequency: 659.25, duration: .55 },
        { at: .48, frequency: 523.25, duration: .72 }
      ].forEach(note => {
        const oscillator = context.createOscillator();
        const noteGain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(note.frequency, context.currentTime + note.at);
        noteGain.gain.setValueAtTime(.0001, context.currentTime + note.at);
        noteGain.gain.exponentialRampToValueAtTime(.75, context.currentTime + note.at + .05);
        noteGain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + note.at + note.duration);
        oscillator.connect(noteGain);
        noteGain.connect(master);
        oscillator.start(context.currentTime + note.at);
        oscillator.stop(context.currentTime + note.at + note.duration);
      });
    } catch (_) {}
  }

  function reminderSpeechText(student) {
    const spokenQueue = String(student.queueNumber || '')
      .replace(/^WR-/i, 'W R ')
      .split('')
      .map(character => character === '0' ? 'zero' : character)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `Attention user ${spokenQueue}. This is a reminder to proceed with your registration. Please proceed to the CARES Office for assistance. Thank you.`;
  }

  function speakPoliteReminder(student) {
    if (!soundEnabled || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(reminderSpeechText(student));
    utterance.lang = 'en-PH';
    utterance.rate = .76;
    utterance.pitch = 1.02;
    utterance.volume = .78;
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(voice => /female|samantha|zira|google.*english|english.*philippines/i.test(`${voice.name} ${voice.lang}`)) || voices.find(voice => /^en/i.test(voice.lang));
    if (preferred) utterance.voice = preferred;
    speechSynthesis.speak(utterance);
  }

  function playReminderAlarm(student) {
    playFlightAttendantChime();
    if (soundEnabled) window.setTimeout(() => {
      if (currentStudent && currentStudent.status === 'called' && !currentStudent.reminderResponse) speakPoliteReminder(student);
    }, 1150);
  }

  function toggleSound() {
    volumePromptShown = true;
    soundEnabled = !soundEnabled;
    updateSoundButton();
    if (soundEnabled) announce('Queue alerts enabled.');
  }

  function maybeShowVolumePrompt() {
    if (volumePromptShown || soundEnabled) return;
    if ($('#studentHomeScreen').classList.contains('d-none') && $('#facilitatorScreen').classList.contains('d-none')) return;
    volumePromptShown = true;
    window.setTimeout(() => showModal('volumePromptModal'), 280);
  }

  function enableVolumeAlerts() {
    soundEnabled = true;
    volumePromptShown = true;
    updateSoundButton();
    hideModal('volumePromptModal');
    announce('Volume alerts are now enabled.');
    toast('Volume alerts on', 'Queue reminders will play through this device.');
  }

  function keepVolumeMuted() {
    soundEnabled = false;
    volumePromptShown = true;
    updateSoundButton();
    hideModal('volumePromptModal');
    hideModal('callAlertModal');
    stopReminderAlarm();
  }

  function updateSoundButton() {
    const button = $('#soundButton');
    if (!button) return;
    button.innerHTML = `<i class="bi ${soundEnabled ? 'bi-volume-up' : 'bi-volume-mute'}"></i>`;
    button.setAttribute('aria-label', soundEnabled ? 'Mute volume alerts' : 'Enable volume alerts');
    button.setAttribute('title', soundEnabled ? 'Mute volume alerts' : 'Enable volume alerts');
  }

  function announce(text) {
    if (!soundEnabled) return;
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 760;
      gain.gain.setValueAtTime(.08, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .32);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + .32);
    } catch (_) { /* speech remains available */ }

    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-PH';
      utterance.rate = .84;
      utterance.pitch = 1.0;
      utterance.volume = .78;
      speechSynthesis.speak(utterance);
    }
  }

  function formatStudentIdField(event) {
    const input = event.currentTarget;
    const digits = String(input.value || '').replace(/\D/g, '').slice(0, 13);
    input.value = formatStudentIdDigits(digits);
    input.setCustomValidity(digits.length === 0 || digits.length === 13 ? '' : 'Enter all 13 Student ID digits.');
  }
  function formatStudentIdDigits(digits) {
    const clean = String(digits || '').replace(/\D/g, '').slice(0, 13);
    if (clean.length <= 3) return clean;
    if (clean.length <= 7) return `${clean.slice(0, 3)}-${clean.slice(3)}`;
    return `${clean.slice(0, 3)}-${clean.slice(3, 7)}-${clean.slice(7)}`;
  }
  function normalizeStudentId(value) {
    const raw = String(value || '').trim();
    if (!raw || !/^[\d\s-]+$/.test(raw)) return '';
    return formatStudentIdDigits(raw.replace(/\D/g, ''));
  }
  function isValidStudentId(value) { return /^\d{3}-\d{4}-\d{6}$/.test(String(value || '')); }
  function maskStudentId(value) {
    const normalized = normalizeStudentId(value);
    return isValidStudentId(normalized) ? `***-****-****${normalized.slice(-2)}` : 'Not assigned';
  }
  function normalizeDateKey(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
    }
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
      const isoDate = new Date(raw);
      if (!Number.isNaN(isoDate.getTime())) {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(isoDate);
      }
    }
    const ymd = raw.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)/);
    if (ymd) return `${ymd[1]}-${String(ymd[2]).padStart(2, '0')}-${String(ymd[3]).padStart(2, '0')}`;
    const mdy = raw.match(/^([01]?\d)[-\/]([0-3]?\d)[-\/](\d{4})$/);
    if (mdy) return `${mdy[3]}-${String(mdy[1]).padStart(2, '0')}-${String(mdy[2]).padStart(2, '0')}`;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed);
  }

  function normalizeClock(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{1,2}):(\d{2})/);
    return match ? `${String(Number(match[1])).padStart(2, '0')}:${match[2]}` : raw;
  }

  function normalizeSlotId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const direct = TIME_SLOTS.find(slot => String(slot.id).toLowerCase() === raw.toLowerCase());
    if (direct) return direct.id;
    const comparable = raw.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
    const byLabel = TIME_SLOTS.find(slot => String(slot.label || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim() === comparable);
    if (byLabel) return byLabel.id;
    const clock = comparable.match(/(?:^|\D)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (clock) {
      let hour = Number(clock[1]);
      const minute = Number(clock[2] || 0);
      const trailingMeridiem = comparable.match(/(am|pm)\s*$/i);
      const meridiem = String(clock[3] || (trailingMeridiem && trailingMeridiem[1]) || '').toLowerCase();
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      const start = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const byStart = TIME_SLOTS.find(slot => normalizeClock(slot.start) === start);
      if (byStart) return byStart.id;
    }
    return raw;
  }

  function normalizeStatus(value) {
    const status = String(value || 'scheduled').trim().toLowerCase().replace(/[ -]+/g, '_');
    const aliases = { pending: 'scheduled', registered: 'scheduled', in_progress: 'ongoing', done: 'completed', noshow: 'no_show' };
    return aliases[status] || status || 'scheduled';
  }

  function facilitatorRosterRank(status) {
    const ranks = { ongoing: 0, called: 1, scheduled: 2, pending: 2, no_show: 3, completed: 4 };
    return Object.prototype.hasOwnProperty.call(ranks, status) ? ranks[status] : 2;
  }

  function normalizeStudentRecord(item) {
    return {
      ...(item || {}),
      id: String(item?.id || '').trim(),
      studentIdNumber: normalizeStudentId(item?.studentIdNumber),
      date: normalizeDateKey(item?.date),
      slotId: normalizeSlotId(item?.slotId),
      sequence: Number(item?.sequence || 0),
      status: normalizeStatus(item?.status)
    };
  }

  function normalizeBatchMember(item) {
    const normalized = normalizeStudentRecord(item);
    normalized.owner = Boolean(item?.owner);
    normalized.displayName = String(item?.displayName || '');
    normalized.maskedStudentId = item?.maskedStudentId || maskStudentId(item?.studentIdNumber);
    return normalized;
  }

  function studentFingerprint(item) {
    if (!item) return '';
    return [item.id, item.date, item.slotId, item.status, item.reminderResponse, item.calledAt, item.updatedAt, item.position].join('|');
  }

  function batchFingerprint(batch) {
    return (batch || []).map(item => [item.id, item.sequence, item.status, item.owner, item.slotId].join(':')).join('|');
  }

  function properCase(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b\w/g, char => char.toUpperCase()); }
  function fullName(item) { return [item.firstName, item.middleName, item.lastName].filter(Boolean).join(' '); }
  function batchDisplayName(item) {
    if (item?.firstName || item?.lastName) {
      const middle = String(item?.middleName || '').trim();
      const initial = middle ? `${middle.charAt(0).toUpperCase()}.` : '';
      return [item?.firstName, initial, item?.lastName].filter(Boolean).join(' ');
    }
    return String(item?.displayName || '').replace(/\s+/g, ' ').trim();
  }
  function shortCollege(value) { return String(value || '').replace('College of ', '').replace(' and ', ' & '); }
  function courseAbbreviation(value) {
    const course = String(value || '').trim();
    if (!course) return '';
    const normalized = course.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const known = {
      'bachelor of secondary education': 'BSED',
      'bachelor of elementary education': 'BEED',
      'bachelor of technology and livelihood education': 'BTLED',
      'bs information technology': 'BSIT',
      'bs civil engineering': 'BSCE',
      'bs electrical engineering': 'BSEE',
      'bs accountancy': 'BSA',
      'bs business administration': 'BSBA',
      'bs entrepreneurship': 'BSEntrep',
      'bs biology': 'BSBio',
      'ba english language': 'BAEL',
      'bs mathematics': 'BSMath',
      'bs psychology': 'BSPsych',
      'bs agriculture': 'BSAgriculture',
      'bs forestry': 'BSF',
      'bs environmental science': 'BSES',
      'bs criminology': 'BSCrim',
      'bs nursing': 'BSN',
      'bs hospitality management': 'BSHM',
      'bs tourism management': 'BSTM'
    };
    const knownMatch = Object.entries(known).find(([key]) => normalized === key || normalized.startsWith(`${key} `));
    if (knownMatch) return knownMatch[1];
    const stopWords = new Set(['of', 'and', 'in', 'the', 'major']);
    const acronym = course.split(/[^A-Za-z0-9]+/).filter(word => word && !stopWords.has(word.toLowerCase())).map(word => word[0]).join('').toUpperCase();
    return acronym || course;
  }
  function collegeAbbreviation(value) {
    const college = String(value || '').trim();
    const known = {
      'College of Arts and Sciences': 'CAS',
      'College of Business and Accountancy': 'CBA',
      'College of Education': 'CED',
      'College of Engineering and Technology': 'CET',
      'College of Computing Multimedia Arts and Digital Innovation': 'CCMADI'
    };
    return known[college] || courseAbbreviation(shortCollege(college));
  }
  function responseLabel(value) { return ({ on_the_way: 'On the Way', cant_attend: 'Can’t Attend', reschedule_requested: 'Requested Reschedule' })[value] || ''; }
  function statusLabel(value) { return ({ scheduled: 'Pending', called: 'Called', ongoing: 'Ongoing', completed: 'Completed', no_show: 'No show', cant_attend: 'Can’t attend', cancelled: 'Cancelled' })[value] || properCase(value); }
  function spellQueue(value) { return String(value).replace('WR-', 'W R ').split('').join(' '); }
  function makeId() { return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function formatDate(date, options) {
    const key = normalizeDateKey(date);
    const parsed = new Date(`${key}T12:00:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? String(date || '—') : new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', ...options }).format(parsed);
  }
  function formatDateTime(value) { return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
  function showModal(id) { bootstrap.Modal.getOrCreateInstance($('#' + id)).show(); }
  function hideModal(id) { bootstrap.Modal.getOrCreateInstance($('#' + id)).hide(); }
  function toast(title, message) { $('#toastTitle').textContent = title; $('#toastMessage').textContent = message; bootstrap.Toast.getOrCreateInstance($('#appToast'), { delay: 4200 }).show(); }
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
})();
