/* Wadhwani Premium Ticket V20 — all-screen responsiveness + dynamic dates */
(() => {
  'use strict';

  /* ================= VERCEL API PROXY CONFIG: BEGIN =================
   * The Apps Script URL and proxy secret are stored only in Vercel Environment
   * Variables. Browsers call this same-origin endpoint and never see them.
   */
  const API_PROXY_ENDPOINT = '/api/backend';
  const API_TIMEOUT_MS = 60000;
  // Poll less often to reduce Apps Script executions while keeping ticket updates timely.
  const STUDENT_REMINDER_CHECK_MS = 300000;
  const REMINDER_CHECK_JITTER_MS = 2500;
  // Registration and ticket views are supported on phones, tablets, laptops, and wide desktops.
  const STUDENT_MAX_VIEWPORT_WIDTH = Number.POSITIVE_INFINITY;
  const SCHEDULE_REMINDER_MINUTES = 10;
  const SCHEDULE_REMINDER_REPEAT_MS = 15000;
  const STUDENT_DEVICE_SESSION_KEY = 'wadhwaniRememberedStudentIdV12';
  const REMOVED_EVENT_DATES = new Set(['2026-08-07', '2026-08-12', '2026-08-13']);
  /* ================== VERCEL API PROXY CONFIG: END ================== */

  const LEGACY_BROWSER_KEYS = [
    'wadhwaniStudentIdV7', 'wadhwaniStudentEmailV5', 'wadhwaniFacilitatorTokenV5',
    'wadhwaniDeviceIdV5', 'wadhwaniSoundV5', 'wadhwaniFacilitatorAutoBypassV6'
  ];

  let EVENT_DATES = [];
  let OPEN_EVENT_DATES = [];
  let TIME_SLOTS = [];
  let COLLEGES = {};
  let LAPTOP_COUNT = 10;
  let SESSION_MINUTES = 10;
  let CAPACITY = 60;
  // Keep room on an hourly printout for walk-in/manual registrations without adding another sheet.
  const HOURLY_PRINT_MIN_ROWS = 10;
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
  let appointmentSettingsOriginalDates = [];
  let appointmentExpiredDates = [];

  let pendingStudent = null;
  let selectedDate = null;
  let selectedSlot = null;
  let rescheduleDate = null;
  let rescheduleSlot = null;
  let selectedFacStudentId = null;
  let facDate = '';
  let facPart = 'morning';
  let facSlot = '';
  let facRotation = '';
  let printScope = 'rotation';
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
  let scheduleReminderWatchTimer = null;
  let scheduleReminderAlarmTimer = null;
  let scheduleReminderVibrationTimer = null;
  let acknowledgedScheduleReminderKey = '';
  let notifiedScheduleReminderKey = '';
  let serviceWorkerRegistration = null;
  let firebaseMessagingClient = null;
  let firebasePushToken = '';
  let firebasePushBoundStudentId = '';
  let firebaseScriptsPromise = null;
  let firebaseForegroundHandlerBound = false;
  let studentSessionBackgrounded = false;
  let pendingUnregisteredStudentId = '';
  let registrationIdentityRequestSerial = 0;

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  async function init() {
    clearLegacyBrowserState();
    clearStudentSession();
    clearFacilitatorSession();
    initializeMessengerBrowserFeature();
    initializeBrowserNotificationFeature();
    bindEvents();
    updateSoundButton();
    setPortalControls('none');
    setLoading(true, 'Reading the newest schedule and ticket information…', 'Connecting');

    try {
      if (!navigator.onLine) {
        showOfflineModal();
        return;
      }
      await refreshPublicConfig();
      populateColleges();
      hideOfflineModal();
      if (!isBrowserInstructionActive()) await autoRoute();
    } catch (error) {
      if (isNetworkFailure(error)) showOfflineModal();
      else showFatalError(error);
    } finally {
      setLoading(false);
    }
  }

  /* ================= VERCEL SAME-ORIGIN API CONNECTION: BEGIN =================
   * The Vercel Function adds the server-only Apps Script URL and proxy secret
   * before forwarding this request to the separate Apps Script deployment.
   */
  async function server(method, ...args) {
    if (!navigator.onLine) {
      const error = new Error('The device is offline. Reconnect to continue.');
      showOfflineModal(error.message);
      throw error;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(API_PROXY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ action: method, args: args }),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal
      });

      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (_) {
        throw new Error(response.ok
          ? 'The registration service returned an invalid response.'
          : 'Unable to reach the registration service.');
      }

      if (!response.ok) {
        throw new Error(payload?.error || 'Unable to reach the registration service.');
      }
      if (payload?.ok) return payload.data;
      throw new Error(payload?.error || 'The registration service returned an invalid response.');
    } catch (error) {
      const requestError = error?.name === 'AbortError'
        ? new Error('The request timed out while contacting the registration service.')
        : error;
      if (isNetworkFailure(requestError)) showOfflineModal(requestError.message);
      throw requestError;
    } finally {
      window.clearTimeout(timeoutId);
    }
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
      .filter(date => date && !REMOVED_EVENT_DATES.has(date))));
    OPEN_EVENT_DATES = Array.from(new Set((Array.isArray(config.openEventDates) ? config.openEventDates : EVENT_DATES)
      .map(normalizeDateKey)
      .filter(date => date && !REMOVED_EVENT_DATES.has(date))));
    COLLEGES = config.colleges || {};
    LAPTOP_COUNT = Number(config.laptopCount) || 10;
    SESSION_MINUTES = Number(config.sessionMinutes) || 10;
    CAPACITY = Number(config.capacity) || (LAPTOP_COUNT * Math.floor(60 / SESSION_MINUTES));
    ['#morningCapacityLabel', '#afternoonCapacityLabel'].forEach(selector => {
      const label = $(selector);
      if (label) label.textContent = `${CAPACITY} clients/hour · ${LAPTOP_COUNT} laptops · ${SESSION_MINUTES}-minute turns`;
    });
    TEST_TODAY_DATE = normalizeDateKey(config.today || '');
    if (config.serverNow) serverClockOffset = new Date(config.serverNow).getTime() - Date.now();

    availabilityIndex = new Map();
    (config.availability || []).forEach(rawDateItem => {
      const date = normalizeDateKey(rawDateItem.date);
      if (!date || REMOVED_EVENT_DATES.has(date)) return;
      const slotMap = new Map();
      const slots = (rawDateItem.slots || []).map(rawSlot => {
        const id = normalizeSlotId(rawSlot.id);
        const count = Number(rawSlot.count || 0);
        const rotations = (rawSlot.rotations || []).map(rotation => ({
          ...rotation,
          id: String(rotation.id || '').trim(),
          start: normalizeClock(rotation.start),
          end: normalizeClock(rotation.end),
          count: Number(rotation.count || 0),
          remaining: Number(rotation.remaining || 0),
          full: Boolean(rotation.full),
          available: Boolean(rotation.available)
        })).filter(rotation => rotation.id);
        return {
          ...rawSlot,
          id,
          count,
          remaining: Number.isFinite(Number(rawSlot.remaining)) ? Number(rawSlot.remaining) : Math.max(0, CAPACITY - count),
          full: Boolean(rawSlot.full),
          available: Boolean(rawSlot.available),
          rotations,
          rotationMap: new Map(rotations.map(rotation => [rotation.id, rotation]))
        };
      }).filter(slot => slot.id);
      slots.forEach(slot => slotMap.set(slot.id, slot));
      availabilityIndex.set(date, { ...rawDateItem, date, slots, slotMap });
    });

    facDate = normalizeDateKey(facDate);
    facSlot = normalizeSlotId(facSlot);
    if (!facDate || !EVENT_DATES.includes(facDate)) facDate = TEST_TODAY_DATE || EVENT_DATES[0] || '';
    if (!facSlot || !getSlot(facSlot)) facSlot = TIME_SLOTS.find(slot => slot.part === facPart)?.id || TIME_SLOTS[0]?.id || '';
    if (!getRotationsForSlot(facDate, facSlot).some(rotation => rotation.id === facRotation)) facRotation = '';
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
    const studentIdNumber = normalizeStudentId(activeStudentId || currentStudent?.studentIdNumber || getRememberedStudentId() || '');
    if (!isValidStudentId(studentIdNumber)) return false;

    const load = async () => {
      const result = await server('getStudentNotificationState', studentIdNumber);
      if (!result.student) {
        clearStudentSession({ forgetDevice: true });
        if (!silent) toast('Registration not found', 'This Student ID is no longer in the database.');
        showLogin(true);
        return false;
      }
      if (result.serverNow) serverClockOffset = new Date(result.serverNow).getTime() - Date.now();
      currentStudent = normalizeStudentRecord(result.student);
      activeStudentId = currentStudent.studentIdNumber;
      rememberStudentId(activeStudentId);
      showStudentHome();
      setLiveSyncState('connected', `Ticket checked ${formatSyncClock()}`);
      hideOfflineModal();
      if (!silent) toast('Ticket updated', 'Your latest registration status is now displayed.');
      return true;
    };

    try {
      return silent
        ? await load()
        : await withProcessLoading('Refreshing your ticket', 'Checking only your latest registration status…', load);
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
    if (scheduleReminderWatchTimer) window.clearTimeout(scheduleReminderWatchTimer);
    studentLiveTimer = null;
    facilitatorLiveTimer = null;
    scheduleReminderWatchTimer = null;
    stopScheduleReminderAlarm();
  }

  function startStudentLiveSync() {
    stopLiveSync();
    setLiveSyncState('idle', 'Status and schedule reminders active');
    scheduleStudentLiveSync(1200);
    startScheduleReminderWatch();
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
        clearStudentSession({ forgetDevice: true });
        showLogin(true);
        toast('Registration unavailable', 'Your saved Student ID is no longer in the database.');
        return;
      }

      if (result.serverNow) serverClockOffset = new Date(result.serverNow).getTime() - Date.now();
      const incoming = normalizeStudentRecord(result.student);
      const previousCalledAt = String(currentStudent.calledAt || '');
      const ownRecordChanged = [
        'status', 'calledAt', 'reminderResponse', 'respondedAt',
        'ongoingAt', 'completedAt', 'noShowAt', 'rescheduledAt', 'updatedAt',
        'date', 'slotId'
      ].some(key => String(incoming[key] || '') !== String(currentStudent[key] || ''));

      currentStudent = incoming;
      activeStudentId = incoming.studentIdNumber;
      rememberStudentId(activeStudentId);
      renderStudentHome();
      if (currentStudent.status === 'completed') {
        stopReminderAlarm();
        stopScheduleReminderAlarm();
        clearSystemNotifications();
      } else {
        checkScheduleReminderWindow();
      }

      if (ownRecordChanged) {
        setLiveSyncState('connected', `Ticket updated ${formatSyncClock()}`);
        if (currentStudent.calledAt && String(currentStudent.calledAt) !== previousCalledAt) {
          toast('Facilitator reminder received', `${currentStudent.queueNumber} is being called.`);
        }
      } else {
        setLiveSyncState('idle', `Ticket checked ${formatSyncClock()}`);
      }
    } catch (error) {
      console.warn('Student ticket check failed:', error.message);
      setLiveSyncState(navigator.onLine ? 'warning' : 'offline', navigator.onLine ? 'Ticket check retrying…' : 'Offline');
    } finally {
      studentLiveSyncInFlight = false;
      if (currentStudent && currentStudent.status !== 'completed' && isStudentPortalActive()) scheduleStudentLiveSync();
    }
  }

  async function runFacilitatorLiveSync() {
    // Kept as a no-op for older cached pages.
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
    const el = $('#studentHomeScreen');
    return Boolean(el && !el.classList.contains('d-none'));
  }

  function handleLiveSyncVisibility() {
    if (document.hidden) {
      if (currentStudent && isStudentPortalActive()) studentSessionBackgrounded = true;
      if (!navigator.onLine) setLiveSyncState('offline', 'Offline');
      else if (currentStudent && currentStudent.status !== 'completed') setLiveSyncState('idle', 'Background reminders armed');
      return;
    }

    if (!navigator.onLine) {
      setLiveSyncState('offline', 'Offline');
      return;
    }

    if (studentSessionBackgrounded) {
      studentSessionBackgrounded = false;
      if (currentStudent) {
        setLiveSyncState('syncing', 'Checking your latest status…');
        refreshStudentData(true).catch(error => console.warn('Return-to-app refresh failed:', error.message));
      } else if (getRememberedStudentId()) {
        autoRoute().catch(error => console.warn('Remembered student restore failed:', error.message));
      }
    }

    if (isStudentPortalActive() && currentStudent && currentStudent.status !== 'completed') {
      setLiveSyncState('idle', 'Status and schedule reminders active');
      scheduleStudentLiveSync(250);
      checkScheduleReminderWindow();
    }
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
    facRotation = '';
    ensureFacRotation();
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
    renderFacRotationStrip();
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
      document.body.classList.remove('browser-check-pending', 'browser-instruction-active');
      mainApplication.classList.remove('d-none');
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

  /* ================== BROWSER NOTIFICATIONS: BEGIN ================== */
  function initializeBrowserNotificationFeature() {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('./sw.js?v=23', { updateViaCache: 'none' }).then(registration => {
        serviceWorkerRegistration = registration;
        registration.update().catch(() => {});
      }).catch(error => console.warn('Notification service worker registration failed:', error.message));
    }
  }

  function isBrowserInstructionActive() {
    const instruction = $('#browserInstruction');
    return Boolean(instruction && !instruction.classList.contains('d-none'));
  }

  function isInstalledPwaMode() {
    return false;
  }

  async function requestSystemNotificationPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    try { return await Notification.requestPermission(); } catch (_) { return Notification.permission || 'default'; }
  }

  async function showSystemNotification(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    try {
      const registration = serviceWorkerRegistration || await navigator.serviceWorker?.ready;
      if (!registration?.showNotification) return false;
      await registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        vibrate: [180, 120, 220],
        data: { url: './' }
      });
      return true;
    } catch (error) {
      console.warn('System notification failed:', error.message);
      return false;
    }
  }

  async function clearSystemNotifications() {
    try {
      const registration = serviceWorkerRegistration || await navigator.serviceWorker?.ready;
      if (!registration?.getNotifications) return;
      const notifications = await registration.getNotifications();
      notifications.forEach(notification => notification.close());
    } catch (_) {}
  }

  function isFirebasePushConfigured() {
    const config = globalThis.WADHWANI_FIREBASE;
    return Boolean(
      config?.enabled &&
      config?.config?.apiKey &&
      config?.config?.projectId &&
      config?.config?.messagingSenderId &&
      config?.config?.appId &&
      config?.vapidKey
    );
  }

  function loadFirebaseScript(src, id) {
    const existing = document.getElementById(id);
    if (existing?.dataset.loaded === 'true') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = existing || document.createElement('script');
      script.id = id;
      script.src = src;
      script.async = true;
      script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve(); }, { once: true });
      script.addEventListener('error', () => reject(new Error(`Unable to load ${src}`)), { once: true });
      if (!existing) document.head.appendChild(script);
    });
  }

  async function initializeFirebasePushClient() {
    if (firebaseMessagingClient) return firebaseMessagingClient;
    if (!isFirebasePushConfigured()) return null;
    if (firebaseScriptsPromise) return firebaseScriptsPromise;

    firebaseScriptsPromise = (async () => {
      const pushConfig = globalThis.WADHWANI_FIREBASE;
      const sdkVersion = pushConfig.sdkVersion || '12.17.1';
      await loadFirebaseScript(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-app-compat.js`, 'firebaseAppCompatSdk');
      await loadFirebaseScript(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-messaging-compat.js`, 'firebaseMessagingCompatSdk');
      if (!globalThis.firebase?.initializeApp) throw new Error('Firebase client SDK did not initialize.');

      let app = globalThis.firebase.apps?.find(item => item.name === 'wadhwani-push');
      if (!app) app = globalThis.firebase.initializeApp(pushConfig.config, 'wadhwani-push');
      firebaseMessagingClient = globalThis.firebase.messaging(app);

      if (!firebaseForegroundHandlerBound && firebaseMessagingClient?.onMessage) {
        firebaseForegroundHandlerBound = true;
        firebaseMessagingClient.onMessage(handleForegroundPushMessage);
      }
      return firebaseMessagingClient;
    })().catch(error => {
      firebaseScriptsPromise = null;
      console.warn('Firebase push client could not initialize:', error.message);
      return null;
    });

    return firebaseScriptsPromise;
  }

  async function registerBackgroundPushForCurrentStudent(silent = true) {
    const student = currentStudent;
    if (!student || student.status === 'completed') return false;
    if (!isFirebasePushConfigured()) {
      if (!silent) toast('Background push not configured', 'Complete firebase-config.js and Apps Script Firebase setup to enable background browser reminders where supported.');
      return false;
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      if (!silent) toast('Notification permission needed', 'Allow notifications to receive browser reminders when supported.');
      return false;
    }
    if (!('serviceWorker' in navigator)) return false;

    const studentIdNumber = normalizeStudentId(student.studentIdNumber);
    if (firebasePushBoundStudentId === studentIdNumber && firebasePushToken) return true;

    try {
      const messaging = await initializeFirebasePushClient();
      if (!messaging) return false;
      const registration = serviceWorkerRegistration || await navigator.serviceWorker.ready;
      const token = await messaging.getToken({
        vapidKey: globalThis.WADHWANI_FIREBASE.vapidKey,
        serviceWorkerRegistration: registration
      });
      if (!token) throw new Error('No Firebase push target was returned for this device.');

      const meta = {
        targetType: 'token',
        platform: navigator.userAgentData?.platform || navigator.platform || 'Web',
        userAgent: String(navigator.userAgent || '').slice(0, 500),
        appVersion: '16-console-fix',
        standalone: isInstalledPwaMode()
      };
      const result = await server('registerStudentPushTarget', studentIdNumber, token, meta);
      firebasePushToken = token;
      firebasePushBoundStudentId = studentIdNumber;
      if (!silent) {
        const suffix = result?.serverConfigured === false ? ' Device registration saved, but the Apps Script FCM service account still needs configuration.' : ' Browser background reminders are enabled for this device when supported.';
        toast('Background reminders ready', suffix.trim());
      }
      return true;
    } catch (error) {
      console.warn('Background push registration failed:', error.message);
      if (!silent) toast('Background reminder setup failed', error.message);
      return false;
    }
  }

  async function disableBackgroundPushForCurrentStudent(silent = true) {
    const studentIdNumber = normalizeStudentId(currentStudent?.studentIdNumber || firebasePushBoundStudentId || '');
    if (!isValidStudentId(studentIdNumber) || !firebasePushToken) return false;
    try {
      await server('disableStudentPushTarget', studentIdNumber, firebasePushToken);
      firebasePushBoundStudentId = '';
      if (!silent) toast('Background reminders disabled', 'This device will no longer receive Wadhwani push reminders for this registration.');
      return true;
    } catch (error) {
      console.warn('Unable to disable push target:', error.message);
      return false;
    }
  }

  function handleForegroundPushMessage(payload) {
    const data = payload?.data || {};
    const targetStudentId = normalizeStudentId(data.studentIdNumber || '');
    if (currentStudent && targetStudentId && targetStudentId !== normalizeStudentId(currentStudent.studentIdNumber)) return;

    const type = String(data.type || '').toLowerCase();
    if (type === 'call') {
      toast('Facilitator reminder received', data.body || 'Please open your Wadhwani reminder.');
      if (currentStudent) refreshStudentData(true).catch(() => {});
      return;
    }
    if (type === 'schedule') {
      toast('Schedule reminder', data.body || 'Your Wadhwani schedule is approaching.');
      if (currentStudent) checkScheduleReminderWindow();
    }
  }
  /* ================== PWA INSTALL + SYSTEM NOTIFICATIONS: END ================== */

  function bindEvents() {
    $('#loginStudentId').addEventListener('input', event => {
      formatStudentIdField(event);
      resetLoginResult(false);
    });
    $('#loginForm').addEventListener('submit', handleLoginSubmit);
    $('#registerFromLoginButton').addEventListener('click', beginRegistrationFromLogin);
    $('#newRegistrationButton')?.addEventListener('click', () => { pendingLoginId = ''; beginRegistrationFromLogin(); });
    $('#modalRegisterStudentButton')?.addEventListener('click', beginRegistrationFromUnregisteredModal);
    $('#existingRegistrationLoginButton')?.addEventListener('click', goToLoginFromExistingRegistration);
    $('#facilitatorPasswordForm').addEventListener('submit', handleFacilitatorPasswordSubmit);
    $('#changeLoginIdButton').addEventListener('click', () => resetLoginResult(true));
    $('#toggleFacilitatorPassword').addEventListener('click', toggleFacilitatorPassword);
    $('#cancelRegistrationButton').addEventListener('click', () => showLogin());
    $('#offlineRetryButton').addEventListener('click', retryInternetConnection);
    $('#connectionBannerRetryButton').addEventListener('click', retryInternetConnection);
    $('#acknowledgeScheduleAlertButton').addEventListener('click', acknowledgeScheduleReminder);

    $('#studentForm').addEventListener('submit', handleDetailsSubmit);
    ['#firstName', '#middleName', '#lastName', '#studentIdNumber'].forEach(selector => {
      $(selector)?.addEventListener('input', clearNameCheckFeedback);
    });
    $('#studentIdNumber')?.addEventListener('input', formatStudentIdField);
    $('#studentIdNumber')?.addEventListener('blur', () => checkRegistrationIdentityLive('id'));
    ['#firstName', '#middleName', '#lastName'].forEach(selector => {
      $(selector)?.addEventListener('blur', () => checkRegistrationIdentityLive('name'));
    });
    $('#editDetailsButton').addEventListener('click', showDetailsStep);
    $('#confirmRegistrationButton').addEventListener('click', confirmRegistration);
    $('#rescheduleButton').addEventListener('click', openReschedule);
    $('#refreshAvailabilityButton').addEventListener('click', () => refreshScheduleAvailability(false));
    $('#confirmRescheduleButton').addEventListener('click', confirmReschedule);
    $('#refreshStudentTopButton').addEventListener('click', () => refreshStudentData(false));
    $('#callAlertResponseGrid').addEventListener('click', handleStudentResponse);
    $('#sendMessageButton').addEventListener('click', sendRescheduleMessage);
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
    $('#laptopMinusButton').addEventListener('click', () => adjustAppointmentLaptopCount(-1));
    $('#laptopPlusButton').addEventListener('click', () => adjustAppointmentLaptopCount(1));
    $('#appointmentLaptopInput').addEventListener('input', renderAppointmentSettingsPreview);
    $('#appointmentSessionMinutesInput').addEventListener('change', renderAppointmentSettingsPreview);
    $('#addAppointmentDateButton').addEventListener('click', addAppointmentDateFromInput);
    $('#clearAppointmentDatesButton').addEventListener('click', clearAppointmentDates);
    $('#appointmentDateInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addAppointmentDateFromInput(); } });
    $('#saveAppointmentSettingsButton').addEventListener('click', saveAppointmentSettings);
    $('#jumpCurrentBatchButton')?.addEventListener('click', jumpToRelevantFacilitatorBatch);
    $('#printRegistrationButton')?.addEventListener('click', openPrintRegistrationModal);
    $$('[data-print-scope]').forEach(button => button.addEventListener('click', () => selectPrintScope(button.dataset.printScope)));
    $('#confirmPrintRegistrationButton')?.addEventListener('click', printRegistrationSheet);
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
    window.addEventListener('offline', () => showOfflineModal('The internet connection was lost.'));
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
        rememberStudentId(activeStudentId);
        studentSessionBackgrounded = false;
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
      pendingUnregisteredStudentId = studentIdNumber;
      $('#unregisteredStudentId').textContent = studentIdNumber;
      showLoginFeedback('info', 'No registration was found. You may continue to registration.');
      showModal('unregisteredStudentModal');
    } catch (error) {
      showLoginFeedback('danger', error.message);
      if (isNetworkFailure(error)) showOfflineModal();
    } finally {
      setButtonBusy(button, false);
    }
  }

  function beginRegistrationFromLogin() {
    const preferredId = isValidStudentId(pendingLoginId) ? pendingLoginId : '';
    hideModal('unregisteredStudentModal');
    $('#studentForm').reset();
    $('#studentForm').classList.remove('was-validated');
    $('#studentIdNumber').value = preferredId;
    $('#studentIdNumber').readOnly = false;
    pendingStudent = null;
    selectedDate = null;
    selectedSlot = null;
    clearNameCheckFeedback();
    populateColleges();
    showRegistration(preferredId);
  }

  function beginRegistrationFromUnregisteredModal() {
    pendingLoginId = normalizeStudentId(pendingUnregisteredStudentId || pendingLoginId || '');
    beginRegistrationFromLogin();
  }

  function goToLoginFromExistingRegistration() {
    hideModal('existingRegistrationModal');
    const id = normalizeStudentId($('#studentIdNumber')?.value || pendingLoginId || '');
    showLogin(false);
    if (isValidStudentId(id)) {
      $('#loginStudentId').value = id;
      formatStudentIdField({ target: $('#loginStudentId') });
    }
  }

  function showExistingRegistrationModal(message) {
    const text = $('#existingRegistrationMessage');
    if (text) text.textContent = message || 'This Student ID or full name is already registered. Please sign in instead of creating another registration.';
    showModal('existingRegistrationModal');
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

  function getRememberedStudentId() {
    try {
      return normalizeStudentId(localStorage.getItem(STUDENT_DEVICE_SESSION_KEY) || '');
    } catch (_) {
      return '';
    }
  }

  function rememberStudentId(studentIdNumber) {
    const normalized = normalizeStudentId(studentIdNumber);
    if (!isValidStudentId(normalized)) return false;
    try {
      localStorage.setItem(STUDENT_DEVICE_SESSION_KEY, normalized);
      return true;
    } catch (_) {
      return false;
    }
  }

  function forgetRememberedStudentId() {
    try { localStorage.removeItem(STUDENT_DEVICE_SESSION_KEY); } catch (_) {}
  }

  function clearStudentSession({ forgetDevice = false } = {}) {
    activeStudentId = '';
    currentStudent = null;
    studentBatch = [];
    studentAvailableSlots = [];
    notifiedStudentCalls.clear();
    firebasePushBoundStudentId = '';
    studentSessionBackgrounded = false;
    acknowledgedScheduleReminderKey = '';
    notifiedScheduleReminderKey = '';
    if (scheduleReminderWatchTimer) window.clearTimeout(scheduleReminderWatchTimer);
    scheduleReminderWatchTimer = null;
    stopScheduleReminderAlarm();
    if (forgetDevice) forgetRememberedStudentId();
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
    clearStudentSession({ forgetDevice: true });
    $('#studentForm')?.reset();
    $('#studentForm')?.classList.remove('was-validated');
    pendingStudent = null;
    selectedDate = null;
    selectedSlot = null;
    showLogin(true);
    toast('Ticket closed', 'This browser no longer remembers the previous Student ID.');
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
    hideModal('scheduleAlertModal');
    stopReminderAlarm();
    stopScheduleReminderAlarm();
  }

  function clearLegacyBrowserState() {
    LEGACY_BROWSER_KEYS.forEach(key => {
      try { localStorage.removeItem(key); } catch (_) {}
      try { sessionStorage.removeItem(key); } catch (_) {}
    });
  }

  function showOfflineModal(reason = '') {
    const modal = $('#offlineModal');
    const banner = $('#connectionBanner');
    const hasLoadedScreen = Boolean(TIME_SLOTS.length || currentStudent || currentFacilitator);
    const browserOffline = !navigator.onLine;
    const message = typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : browserOffline
        ? 'This device is offline. Reconnect to load or save registration data.'
        : 'The registration database is temporarily unreachable.';

    if ($('#offlineTitle')) $('#offlineTitle').textContent = browserOffline ? 'No internet connection' : 'Database temporarily unavailable';
    if ($('#offlineMessage')) $('#offlineMessage').textContent = message;
    if ($('#offlineStatusText')) $('#offlineStatusText').textContent = browserOffline
      ? 'Waiting for Wi-Fi or mobile data…'
      : 'Your internet works, but the database has not responded yet.';
    if ($('#connectionBannerTitle')) $('#connectionBannerTitle').textContent = browserOffline ? 'You are offline' : 'Database connection interrupted';
    if ($('#connectionBannerMessage')) $('#connectionBannerMessage').textContent = hasLoadedScreen
      ? 'Viewing the current screen only. Changes cannot be saved until reconnection.'
      : 'Reconnect to load registration information.';

    if (banner) banner.classList.remove('d-none');
    document.body.classList.add('connection-banner-active', 'offline-view-mode');
    setLiveSyncState('offline', browserOffline ? 'Offline · view only' : 'Database unavailable · view only');
    if (modal && !hasLoadedScreen) {
      modal.classList.remove('d-none');
      document.body.classList.add('offline-modal-active');
    } else if (modal) {
      modal.classList.add('d-none');
      document.body.classList.remove('offline-modal-active');
    }
    setLoading(false);
  }

  function hideOfflineModal() {
    const modal = $('#offlineModal');
    const banner = $('#connectionBanner');
    if (modal) modal.classList.add('d-none');
    if (banner) banner.classList.add('d-none');
    document.body.classList.remove('offline-modal-active', 'connection-banner-active', 'offline-view-mode');
    if ($('#offlineTitle')) $('#offlineTitle').textContent = 'No internet connection';
    if ($('#offlineMessage')) $('#offlineMessage').textContent = 'The registration database needs an internet connection. Reconnect, then try again.';
    if ($('#offlineStatusText')) $('#offlineStatusText').textContent = 'Waiting for an internet connection…';
  }

  function isNetworkFailure(error) {
    const message = String(error?.message || error || '');
    return !navigator.onLine || /timed out|unable to reach|network|internet|failed to fetch/i.test(message);
  }

  async function retryInternetConnection() {
    if (offlineCheckInFlight) return;
    offlineCheckInFlight = true;
    const buttons = [$('#offlineRetryButton'), $('#connectionBannerRetryButton')].filter(Boolean);
    buttons.forEach(button => setButtonBusy(button, true, 'Checking…'));
    try {
      if (!navigator.onLine) throw new Error('The device is still offline.');
      await server('ping');
      hideOfflineModal();
      if (facilitatorToken && currentFacilitator) await refreshFacilitatorData(true);
      else if (activeStudentId && currentStudent) await refreshStudentData(true);
      else if (getRememberedStudentId()) await autoRoute();
      else {
        await refreshPublicConfig();
        populateColleges();
      }
      toast('Connection restored', 'The latest database records are available again.');
    } catch (error) {
      showOfflineModal(error.message || 'The database is still unreachable. Check Wi-Fi or mobile data, then try again.');
    } finally {
      offlineCheckInFlight = false;
      buttons.forEach(button => setButtonBusy(button, false));
    }
  }

  async function handlePageShowFresh(event) {
    if (!event.persisted) return;
    const oldToken = facilitatorToken;
    const oldDeviceId = deviceId;

    try {
      if (oldToken) {
        resetPortalAudio();
        clearFacilitatorSession();
        deviceId = makeId();
        server('logoutFacilitator', oldToken, oldDeviceId).catch(() => {});
      }
      await refreshPublicConfig();
      populateColleges();
      if (getRememberedStudentId()) await autoRoute();
      else if (!isBrowserInstructionActive()) showLogin(true);
    } catch (error) {
      if (isNetworkFailure(error)) showOfflineModal();
    }
  }

  async function autoRoute() {
    const rememberedStudentId = getRememberedStudentId();
    if (!isValidStudentId(rememberedStudentId)) {
      showLogin(true);
      return false;
    }

    try {
      const result = await server('getStudentNotificationState', rememberedStudentId);
      if (!result?.student) {
        clearStudentSession({ forgetDevice: true });
        showLogin(true);
        toast('Registration not found', 'The remembered Student ID is no longer registered.');
        return false;
      }

      if (result.serverNow) serverClockOffset = new Date(result.serverNow).getTime() - Date.now();
      currentStudent = normalizeStudentRecord(result.student);
      activeStudentId = currentStudent.studentIdNumber;
      rememberStudentId(activeStudentId);
      studentSessionBackgrounded = false;
      showStudentHome();
      hideOfflineModal();
      return true;
    } catch (error) {
      if (isNetworkFailure(error)) {
        showOfflineModal();
        return false;
      }
      console.warn('Automatic ticket restore failed:', error.message);
      showLogin(true);
      return false;
    }
  }

  function showOnly(id) {
    ['loginScreen', 'studentDeviceScreen', 'registrationScreen', 'studentHomeScreen', 'facilitatorScreen'].forEach(screenId => {
      $('#' + screenId).classList.toggle('d-none', screenId !== id);
    });
  }

  function setPortalControls(role = 'none') {
    const activePortal = role === 'student' || role === 'facilitator';
    document.body.classList.toggle('student-portal-active', role === 'student');
    document.body.classList.toggle('facilitator-portal-active', role === 'facilitator');
    $$('.portal-control').forEach(element => element.classList.toggle('d-none', !activePortal));
    // Registered students stay attached to this browser. Only facilitators keep a topbar logout action.
    $('#topLogoutButton')?.classList.toggle('d-none', role !== 'facilitator');
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
      const ticketVisible = !$('#studentHomeScreen').classList.contains('d-none');
      const registrationVisible = !$('#registrationScreen').classList.contains('d-none');
      if (!isStudentViewportAllowed() && ticketVisible) {
        showStudentDeviceNotice('ticket');
      } else if (!isStudentViewportAllowed() && registrationVisible) {
        showStudentDeviceNotice('registration');
      } else if (isStudentViewportAllowed() && noticeVisible) {
        if (currentStudent) showStudentHome();
        else showRegistration(pendingLoginId || $('#studentIdNumber')?.value || '');
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
    pendingUnregisteredStudentId = '';
    window.setTimeout(() => $('#loginStudentId')?.focus(), 80);
  }

  function showRegistration(studentIdNumber = '') {
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
    const idInput = $('#studentIdNumber');
    if (idInput) {
      idInput.readOnly = false;
      if (studentIdNumber) idInput.value = normalizeStudentId(studentIdNumber);
    }
    showDetailsStep();
  }

  function showStudentHome() {
    document.body.classList.remove('fac-afternoon-theme');
    if (!isStudentViewportAllowed()) {
      showStudentDeviceNotice('ticket');
      return;
    }
    document.body.classList.remove('registration-schedule-mode');
    setPortalControls('student');
    window.scrollTo(0, 0);
    $('#appContext').textContent = 'My Ticket';

    if (!currentStudent) {
      showLogin(true);
      return;
    }

    studentSessionBackgrounded = false;
    rememberStudentId(currentStudent.studentIdNumber);
    showOnly('studentHomeScreen');
    renderStudentHome();

    if (currentStudent.status === 'completed') {
      stopLiveSync();
      stopReminderAlarm();
      stopScheduleReminderAlarm();
      clearSystemNotifications();
      return;
    }

    startStudentLiveSync();
    maybeShowVolumePrompt();
    if ('Notification' in window && Notification.permission === 'granted') registerBackgroundPushForCurrentStudent(true).catch(() => {});
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

  function getRegistrationIdentityFields() {
    return {
      studentIdNumber: normalizeStudentId($('#studentIdNumber')?.value || ''),
      firstName: properCase($('#firstName')?.value || ''),
      middleName: properCase($('#middleName')?.value || ''),
      lastName: properCase($('#lastName')?.value || '')
    };
  }

  function isUnknownApiActionError(error) {
    return /unknown api action/i.test(String(error?.message || error || ''));
  }

  /**
   * V16 compatibility layer.
   * Preferred path: use the lightweight checkRegistrationIdentity endpoint.
   * Fallback path: older deployed backends can still verify the Student ID via
   * resolveLoginId and the normalized full name via checkStudentEligibility.
   * This keeps duplicate protection working while the new Apps Script version
   * is being deployed.
   */
  async function checkRegistrationIdentityCompat(fields) {
    const studentIdNumber = normalizeStudentId(fields?.studentIdNumber || '');
    const firstName = properCase(fields?.firstName || '');
    const middleName = properCase(fields?.middleName || '');
    const lastName = properCase(fields?.lastName || '');

    try {
      return await server('checkRegistrationIdentity', studentIdNumber, firstName, middleName, lastName);
    } catch (error) {
      if (!isUnknownApiActionError(error)) throw error;

      // Old Apps Script deployment: first check the ID using an endpoint that
      // already existed before V14.
      if (isValidStudentId(studentIdNumber)) {
        const resolved = await server('resolveLoginId', studentIdNumber);
        if (resolved?.role === 'student') {
          return {
            idExists: true,
            idRole: 'student',
            nameExists: false,
            message: 'This Student ID is already registered. Please sign in to open the existing ticket.',
            compatibilityFallback: true
          };
        }
        if (resolved?.role === 'facilitator') {
          return {
            idExists: true,
            idRole: 'facilitator',
            nameExists: false,
            message: 'This ID belongs to a facilitator account and cannot be used for student registration.',
            compatibilityFallback: true
          };
        }
      }

      // checkStudentEligibility requires a complete candidate. For a blur-time
      // name check, use the currently selected values or safe read-only
      // placeholders. This endpoint never writes a registration.
      if (isValidStudentId(studentIdNumber) && firstName && lastName) {
        const fallbackCollege = String($('#college')?.value || Object.keys(COLLEGES || {})[0] || '').trim();
        const fallbackCourse = String($('#course')?.value || 'Identity Check').trim() || 'Identity Check';
        if (fallbackCollege) {
          const eligibility = await server('checkStudentEligibility', {
            studentIdNumber,
            email: normalizeEmail($('#email')?.value || ''),
            firstName,
            middleName,
            lastName,
            college: fallbackCollege,
            course: fallbackCourse
          });
          if (eligibility?.status === 'existing') {
            return {
              idExists: true,
              idRole: 'student',
              nameExists: false,
              message: 'This Student ID is already registered. Please sign in to open the existing ticket.',
              compatibilityFallback: true,
              eligibility
            };
          }
          if (eligibility?.status === 'duplicate_name') {
            return {
              idExists: false,
              idRole: '',
              nameExists: true,
              message: eligibility.message || 'This full name already has a registration. Please sign in using the Student ID used for that registration.',
              compatibilityFallback: true,
              eligibility
            };
          }
          return {
            idExists: false,
            idRole: '',
            nameExists: false,
            message: '',
            compatibilityFallback: true,
            eligibility
          };
        }
      }

      return {
        idExists: false,
        idRole: '',
        nameExists: false,
        message: '',
        compatibilityFallback: true
      };
    }
  }

  async function checkRegistrationIdentityLive(source = 'all', { showConflictModal = true } = {}) {
    const fields = getRegistrationIdentityFields();
    const validId = isValidStudentId(fields.studentIdNumber);
    const hasName = Boolean(fields.firstName && fields.lastName);
    if ((source === 'id' && !validId) || (source === 'name' && !hasName) || (!validId && !hasName)) return { clear: true };

    const serial = ++registrationIdentityRequestSerial;
    try {
      const result = await checkRegistrationIdentityCompat(fields);
      if (serial !== registrationIdentityRequestSerial) return result;

      if (result.idExists) {
        const message = result.message || 'This Student ID is already registered. Please sign in to open the existing ticket.';
        showNameCheckFeedback(message);
        if (showConflictModal) showExistingRegistrationModal(message);
        return result;
      }
      if (result.nameExists) {
        const message = result.message || 'This full name already has a registration. Please sign in using the Student ID used for that registration.';
        showNameCheckFeedback(message);
        if (showConflictModal) showExistingRegistrationModal(message);
        return result;
      }
      clearNameCheckFeedback();
      return result;
    } catch (error) {
      console.warn('Registration identity check failed:', error.message);
      return { error: true, message: error.message };
    }
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
      email: normalizeEmail(data.get('email')),
      firstName: properCase(data.get('firstName')),
      middleName: properCase(data.get('middleName')),
      lastName: properCase(data.get('lastName')),
      college: String(data.get('college')),
      course: String(data.get('course') || '').trim()
    };

    const submitButton = form.querySelector('[type="submit"]');
    setButtonBusy(submitButton, true, 'Checking registration…');
    try {
      const identity = await checkRegistrationIdentityCompat(candidate);
      if (identity.idExists || identity.nameExists) {
        const message = identity.message || 'A registration already exists for this Student ID or full name. Please sign in instead.';
        showNameCheckFeedback(message);
        showExistingRegistrationModal(message);
        return;
      }

      const result = identity.eligibility || await server('checkStudentEligibility', candidate);
      if (result.status === 'existing') {
        const message = 'This Student ID is already registered. Please sign in to open the existing ticket.';
        showNameCheckFeedback(message);
        showExistingRegistrationModal(message);
        return;
      }

      if (result.status === 'duplicate_name') {
        const message = result.message || 'A registration with this full name already exists. Please verify the Student ID or ask the CARES Office for assistance.';
        showNameCheckFeedback(message);
        showExistingRegistrationModal(message);
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
    $('#pendingStudentSummary').innerHTML = `<span><strong>${escapeHtml(fullName(pendingStudent))}</strong></span><span>Student ID: ${escapeHtml(pendingStudent.studentIdNumber)}</span><span>Email: ${escapeHtml(pendingStudent.email)}</span><span>${escapeHtml(shortCollege(pendingStudent.college))}</span>`;
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
      const remaining = Math.max(0, Number(availability?.remaining || 0));
      const percent = CAPACITY ? Math.round(count / CAPACITY * 100) : 0;
      const available = Boolean(availability?.available);
      const nextRotation = availability?.rotations?.find(rotation => rotation.available);
      const recommended = available && slot.id === recommendedSlotId;
      const levelClass = capacityLevelClass(percent, Boolean(availability?.full));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `slot-btn watercolor-card ${levelClass} ${activeSlot === slot.id ? 'active' : ''} ${availability?.full ? 'full' : ''} ${recommended ? 'recommended' : ''}`;
      button.disabled = !available;
      button.style.setProperty('--water-level', `${Math.min(100, percent)}%`);
      button.style.setProperty('--water-delay', `${index * -0.35}s`);
      button.setAttribute('aria-label', `${slot.label}: ${remaining} of ${CAPACITY} client places left`);
      const unavailableText = availability?.ended ? 'Ended · unavailable' : availability?.full ? 'Full · no 10-minute positions available' : 'Unavailable';
      button.classList.toggle('ended', Boolean(availability?.ended));
      button.classList.toggle('started', Boolean(availability?.started && !availability?.ended));
      button.innerHTML = `${recommended ? '<span class="smart-label"><i class="bi bi-stars"></i> Best availability</span>' : ''}<span class="slot-time-icon"><i class="bi ${slot.part === 'morning' ? 'bi-sunrise' : 'bi-sunset'}"></i></span><strong>${slot.label}</strong><small>${available ? `${remaining} ${remaining === 1 ? 'position' : 'positions'} · next ${escapeHtml(nextRotation?.label || 'rotation')}` : unavailableText}</small><div class="capacity-meter" aria-hidden="true"><span style="width:${Math.min(100, percent)}%"></span></div>`;
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
    $('#selectedScheduleText').textContent = `${formatDate(selectedDate, { month: 'long', day: 'numeric' })} · ${slot.label} · exact 10-minute time assigned automatically`;
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
      rememberStudentId(activeStudentId);
      studentIdVisible = true;
      pendingStudent = null;
      setStep('done');
      toast('Registration confirmed', `${appointmentTimeLabel(currentStudent)} is reserved. Use any available laptop when your rotation begins.`);
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

  function ticketStatusForStudent(student) {
    if (!student) return 'upcoming';
    const status = String(student.status || 'scheduled');
    if (status === 'completed') return 'complete';
    if (['no_show', 'cant_attend', 'cancelled'].includes(status)) return 'expired';
    const slot = getSlot(student.slotId);
    if (!slot) return status === 'ongoing' ? 'ongoing' : 'upcoming';
    const now = getServerNow();
    const start = getStudentScheduleStart(student);
    const end = getStudentScheduleEnd(student);
    if (status === 'ongoing') return 'ongoing';
    if (end <= now) return 'expired';
    if (start <= now && now < end) return 'ongoing';
    return 'upcoming';
  }

  function renderStudentHome() {
    const student = currentStudent;
    if (!student) {
      clearStudentSession();
      showLogin(true);
      return;
    }

    const ticketStatus = ticketStatusForStudent(student);
    const card = $('#studentTicketCard');
    if (!card) return;
    card.classList.remove('ticket-upcoming', 'ticket-ongoing', 'ticket-complete', 'ticket-expired');
    card.classList.add(`ticket-${ticketStatus}`);
    const isCompleteTicket = ticketStatus === 'complete';
    const wasFlipped = card.classList.contains('is-flipped');
    card.classList.toggle('is-flipped', isCompleteTicket);
    const frontFace = $('#ticketFrontFace');
    const backFace = $('#ticketBackFace');
    if (frontFace) frontFace.setAttribute('aria-hidden', isCompleteTicket ? 'true' : 'false');
    if (backFace) backFace.setAttribute('aria-hidden', isCompleteTicket ? 'false' : 'true');
    if (isCompleteTicket && !wasFlipped) {
      card.classList.remove('ticket-flip-arrival');
      void card.offsetWidth;
      card.classList.add('ticket-flip-arrival');
    }

    const badge = $('#ticketStatusBadge');
    badge.textContent = ticketStatus.toUpperCase();
    badge.className = `ticket-status-badge status-${ticketStatus}`;
    $('#ticketQueueNumber').textContent = student.queueNumber || 'WR-000';
    $('#ticketStudentName').textContent = batchDisplayName(student) || fullName(student) || 'Student';
    $('#ticketStudentMeta').textContent = `${normalizeStudentId(student.studentIdNumber)} · ${courseAbbreviation(student.course) || student.course || 'Course'}`;
    $('#ticketDate').textContent = formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' });
    $('#ticketTime').textContent = appointmentTimeLabel(student);
    $('#ticketCollege').textContent = shortCollege(student.college) || student.college || '—';
    $('#ticketCourse').textContent = student.course || '—';
    $('#ticketReference').textContent = ticketStatus === 'expired'
      ? 'Select a new available seat below'
      : ticketStatus === 'complete'
        ? 'Completed ticket'
        : ticketStatus === 'ongoing'
          ? 'Your selected schedule is currently in progress'
          : 'Keep this browser ticket ready for your selected schedule';

    const called = student.status === 'called' && !student.reminderResponse;
    $('#ticketCalledNotice').classList.toggle('d-none', !called);
    $('#ticketExpiredNotice').classList.toggle('d-none', ticketStatus !== 'expired');
    $('#rescheduleButton').disabled = ticketStatus !== 'expired';

    const completedName = batchDisplayName(student) || fullName(student) || 'Student';
    const completedSchedule = `${formatDate(student.date, { month: 'short', day: 'numeric', year: 'numeric' })} · ${appointmentTimeLabel(student)}`;
    if ($('#completedTicketStudentName')) $('#completedTicketStudentName').textContent = completedName;
    if ($('#completedTicketQueue')) $('#completedTicketQueue').textContent = student.queueNumber || 'WR-000';
    if ($('#completedTicketSchedule')) $('#completedTicketSchedule').textContent = completedSchedule;
    if ($('#completedTicketTimestamp')) $('#completedTicketTimestamp').textContent = student.completedAt ? formatDateTime(student.completedAt) : 'Completed by CARES';

    renderTicketQr(student);
    renderStudentCall(student);
    startScheduleReminderWatch();
  }

  function renderTicketQr(student) {
    const target = $('#ticketQrCode');
    const shell = $('#ticketQrShell');
    const caption = $('#ticketQrCaption');
    if (!target || !shell) return;

    shell.classList.remove('is-locked');
    shell.classList.add('is-unlocked');
    shell.setAttribute('aria-label', 'Scannable registration QR code; screenshots are allowed');
    if (caption) caption.textContent = 'Scannable registration QR · Screenshot allowed';

    const code = String(student.ticketCode || student.queueNumber || student.studentIdNumber || '');
    if (target.dataset.ticketCode === code && target.childNodes.length) return;
    target.innerHTML = '';
    target.dataset.ticketCode = code;
    try {
      if (window.QRCode) new QRCode(target, { text: code, width: 156, height: 156, correctLevel: QRCode.CorrectLevel.M });
      else target.textContent = code;
    } catch (_) {
      target.textContent = code;
    }
  }

  function renderStudentCall(student) {
    const awaitingResponse = student.status === 'called' && !student.reminderResponse;
    const message = `Attention, user ${student.queueNumber}. This is a reminder to proceed with your registration. Please proceed to the CARES Office for assistance. Thank you.`;
    if ($('#callAlertMessage')) $('#callAlertMessage').textContent = message;
    $('#ticketCalledNotice')?.classList.toggle('d-none', !awaitingResponse);

    if (awaitingResponse) {
      acknowledgeScheduleReminder(true);
      notifyStudent(student);
      showModal('callAlertModal');
      startReminderAlarm(student);
    } else {
      stopReminderAlarm();
      hideModal('callAlertModal');
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
      rescheduleSlot = slot.id;
      renderSlotsForDate(rescheduleDate, $('#rescheduleMorningSlots'), $('#rescheduleAfternoonSlots'), choose, rescheduleSlot);
      $('#rescheduleChoice').textContent = `${formatDate(rescheduleDate, { month: 'long', day: 'numeric' })} · ${slot.label} · exact 10-minute time assigned automatically`;
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
      toast('Schedule updated', `${formatDate(date, { month: 'long', day: 'numeric' })} · ${appointmentTimeLabel(currentStudent)}`);
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
    $('#qrSchedule').textContent = `${formatDate(currentStudent.date, { month: 'long', day: 'numeric' })} · ${appointmentTimeLabel(currentStudent)}`;
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
        await withProcessLoading('Refreshing ticket', 'Checking your latest ticket status…', () => refreshStudentData(true));
        showStudentHome();
        return;
      }
      if (getRememberedStudentId()) {
        await autoRoute();
        return;
      }
      showLogin(true);
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
    ensureFacRotation();
    applyFacilitatorDayPartTheme();
    renderFacBatchStrip();
    renderFacRotationStrip();
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
    facRotation = '';
    ensureFacRotation();
    facSelectionTouched = true;
    closeSelectedStudentSheet();
    renderFacPartTabs();
    renderFacBatchStrip();
    renderFacRotationStrip();
    renderFacRoster();
    setLiveSyncState('idle', `${properCase(facPart)} appointments selected`);
  }

  function ensureFacSlot() {
    const slot = getSlot(facSlot);
    if (!slot || slot.part !== facPart) facSlot = TIME_SLOTS.find(item => item.part === facPart)?.id || '';
  }

  function getRotationsForSlot(date, slotId) {
    return getSlotAvailability(date, slotId)?.rotations || [];
  }

  function rotationMatches(item, date, slotId, rotationId) {
    return scheduleMatches(item, date, slotId) && String(item?.rotationId || '') === String(rotationId || '');
  }

  function ensureFacRotation() {
    const rotations = getRotationsForSlot(facDate, facSlot);
    if (!rotations.length) {
      facRotation = '';
      return;
    }
    if (rotations.some(rotation => rotation.id === facRotation)) return;
    const now = getServerNow();
    const current = rotations.find(rotation => {
      const start = new Date(`${normalizeDateKey(facDate)}T${normalizeClock(rotation.start)}:00+08:00`);
      const end = new Date(`${normalizeDateKey(facDate)}T${normalizeClock(rotation.end)}:00+08:00`);
      return start <= now && now < end;
    });
    const upcoming = rotations.find(rotation => new Date(`${normalizeDateKey(facDate)}T${normalizeClock(rotation.start)}:00+08:00`) > now);
    facRotation = (current || upcoming || rotations[0]).id;
  }

  function renderFacRotationStrip() {
    ensureFacRotation();
    const rotations = getRotationsForSlot(facDate, facSlot);
    $('#facRotationEyebrow').textContent = `${SESSION_MINUTES}-MINUTE ROTATIONS`;
    $('#facRotationCapacity').textContent = LAPTOP_COUNT;
    const selected = rotations.find(rotation => rotation.id === facRotation);
    $('#facRotationSummary').textContent = selected
      ? `${selected.label} · ${selected.count}/${LAPTOP_COUNT} registered`
      : 'No rotation available';
    $('#facRotationStrip').innerHTML = rotations.length ? rotations.map(rotation => {
      const now = getServerNow();
      const start = new Date(`${normalizeDateKey(facDate)}T${normalizeClock(rotation.start)}:00+08:00`);
      const end = new Date(`${normalizeDateKey(facDate)}T${normalizeClock(rotation.end)}:00+08:00`);
      const current = start <= now && now < end;
      const ended = end <= now;
      const completed = state.students.filter(item => rotationMatches(item, facDate, facSlot, rotation.id) && item.status === 'completed').length;
      return `<button type="button" class="rotation-card ${facRotation === rotation.id ? 'active' : ''} ${current ? 'current' : ''} ${ended ? 'ended' : ''}" data-rotation="${escapeHtml(rotation.id)}"><span><strong>${escapeHtml(rotation.label)}</strong>${current ? '<b>NOW</b>' : ''}</span><small>${Number(rotation.count || 0)}/${LAPTOP_COUNT} registered · ${completed} completed</small></button>`;
    }).join('') : '<div class="empty-list">No 10-minute rotation is configured for this hour.</div>';
    $$('#facRotationStrip [data-rotation]').forEach(button => button.addEventListener('click', () => {
      facRotation = button.dataset.rotation;
      facSelectionTouched = true;
      closeSelectedStudentSheet();
      renderFacRotationStrip();
      renderFacRoster();
      setLiveSyncState('idle', `${getRotationsForSlot(facDate, facSlot).find(item => item.id === facRotation)?.label || 'Rotation'} selected`);
    }));
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
      facRotation = '';
      ensureFacRotation();
      facSelectionTouched = true;
      closeSelectedStudentSheet();
      renderFacPartTabs();
      renderFacBatchStrip();
      renderFacRotationStrip();
      renderFacRoster();
      setLiveSyncState('idle', `${getSlot(facSlot)?.label || 'Batch'} selected`);
    }));
  }

  function renderFacRoster() {
    const query = $('#facSearch').value.trim().toLowerCase();
    const queryDigits = query.replace(/\D/g, '');
    const batchRoster = state.students
      .filter(item => rotationMatches(item, facDate, facSlot, facRotation) && item.status !== 'cancelled')
      .sort((a, b) => facilitatorRosterRank(a.status) - facilitatorRosterRank(b.status) || Number(a.sequence || 0) - Number(b.sequence || 0));
    const roster = batchRoster.filter(item => !query ||
      fullName(item).toLowerCase().includes(query) ||
      String(item.course || '').toLowerCase().includes(query) ||
      String(item.email || '').toLowerCase().includes(query) ||
      courseAbbreviation(item.course).toLowerCase().includes(query) ||
      (queryDigits && String(item.studentIdNumber || '').replace(/\D/g, '').includes(queryDigits)) ||
      String(item.queueNumber).toLowerCase().includes(query));

    const rotation = getRotationsForSlot(facDate, facSlot).find(item => item.id === facRotation);
    $('#facBatchTitle').textContent = `${facDate ? formatDate(facDate, { month: 'long', day: 'numeric' }) : 'No date'} · ${rotation?.label || 'No rotation'}`;
    $('#facBatchCapacity').textContent = query
      ? `Showing ${roster.length} of ${batchRoster.length} registered`
      : `${batchRoster.length} of ${LAPTOP_COUNT} registered`;
    $('#facRoster').innerHTML = roster.length ? roster.map((item, index) => {
      const course = courseAbbreviation(item.course);
      return `<button type="button" class="participant-row roster-layout-row ${selectedFacStudentId === item.id ? 'selected' : ''} ${recentFacilitatorIds.has(String(item.id)) ? 'newly-added' : ''}" data-student-id="${item.id}" aria-haspopup="dialog" aria-controls="selectedStudentModal" aria-label="Open information for ${escapeHtml(fullName(item))}"><div class="number">${index + 1}</div><div class="name"><strong>${escapeHtml(fullName(item) || `Student ${item.sequence || 1}`)}${course ? `<span class="course-abbr">– ${escapeHtml(course)}</span>` : ''}</strong><small class="participant-time">${escapeHtml(appointmentTimeLabel(item))} · Any available laptop</small></div><div class="participant-meta"><strong class="participant-queue-number">${escapeHtml(item.queueNumber)}</strong><span class="row-status ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div></button>`;
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
    $('#selectedEmail').textContent = `Email: ${student.email || 'Not provided'}`;
    $('#selectedQueue').textContent = student.queueNumber;
    $('#selectedBatch').textContent = appointmentTimeLabel(student);
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
    const today = TEST_TODAY_DATE || normalizeDateKey(new Date());
    appointmentExpiredDates = OPEN_EVENT_DATES.filter(date => normalizeDateKey(date) < today).sort();
    appointmentSettingsDates = OPEN_EVENT_DATES.filter(date => normalizeDateKey(date) >= today).sort();
    appointmentSettingsOriginalDates = appointmentSettingsDates.slice();
    $('#appointmentLaptopInput').value = String(LAPTOP_COUNT);
    $('#appointmentSessionMinutesInput').value = String(SESSION_MINUTES);
    $('#appointmentDateInput').value = '';
    $('#appointmentDateInput').min = today;
    renderAppointmentSettingsDateList();
    renderAppointmentSettingsPreview();
    showModal('appointmentSettingsModal');
  }

  function adjustAppointmentLaptopCount(delta) {
    const input = $('#appointmentLaptopInput');
    const current = Math.floor(Number(input.value || LAPTOP_COUNT || 10));
    input.value = String(Math.max(1, Math.min(50, current + delta)));
    renderAppointmentSettingsPreview();
  }

  function addAppointmentDateFromInput() {
    const input = $('#appointmentDateInput');
    const date = normalizeDateKey(input.value);
    if (!date) {
      toast('Choose a date', 'Select an appointment date before adding it.');
      return;
    }
    const minimumDate = normalizeDateKey(input.min || TEST_TODAY_DATE || new Date());
    if (date < minimumDate) {
      toast('Past date unavailable', 'Choose today or a future appointment date.');
      return;
    }
    if (appointmentSettingsDates.includes(date)) {
      toast('Date already added', `${formatDate(date, { month: 'long', day: 'numeric', year: 'numeric' })} is already open.`);
      return;
    }
    appointmentSettingsDates.push(date);
    appointmentSettingsDates.sort();
    input.value = '';
    renderAppointmentSettingsDateList();
    renderAppointmentSettingsPreview();
  }

  function removeAppointmentDate(date) {
    const cleanDate = normalizeDateKey(date);
    const registrationCount = state.students.filter(item => normalizeDateKey(item.date) === cleanDate && item.status !== 'cancelled').length;
    const dateLabel = formatDate(cleanDate, { month: 'long', day: 'numeric', year: 'numeric' });
    const warning = registrationCount
      ? `${dateLabel} has ${registrationCount} existing registration${registrationCount === 1 ? '' : 's'}. Removing it will stop new bookings, but those records will remain available to facilitators.\n\nRemove this schedule date?`
      : `Remove ${dateLabel} from the dates students can select?`;
    if (!window.confirm(warning)) return;
    appointmentSettingsDates = appointmentSettingsDates.filter(item => item !== date);
    renderAppointmentSettingsDateList();
    renderAppointmentSettingsPreview();
  }

  function clearAppointmentDates() {
    if (!appointmentSettingsDates.length) {
      toast('No dates to remove', 'New registration is already paused because there are no open schedule dates.');
      return;
    }
    const registrationCount = state.students.filter(item => appointmentSettingsDates.includes(normalizeDateKey(item.date)) && item.status !== 'cancelled').length;
    const warning = registrationCount
      ? `Remove all ${appointmentSettingsDates.length} open dates? ${registrationCount} existing registration${registrationCount === 1 ? '' : 's'} will remain available, but students cannot make new bookings until another date is added and saved.`
      : `Remove all ${appointmentSettingsDates.length} open dates? Students cannot make new bookings until another date is added and saved.`;
    if (!window.confirm(warning)) return;
    appointmentSettingsDates = [];
    renderAppointmentSettingsDateList();
    renderAppointmentSettingsPreview();
  }

  function appointmentDateListsMatch() {
    return appointmentSettingsDates.length === appointmentSettingsOriginalDates.length &&
      appointmentSettingsDates.every((date, index) => date === appointmentSettingsOriginalDates[index]);
  }

  function renderAppointmentSettingsDateList() {
    const wrap = $('#openAppointmentDateList');
    wrap.innerHTML = appointmentSettingsDates.length ? appointmentSettingsDates.map(date =>
      `<div class="open-date-chip"><span class="open-date-icon"><i class="bi bi-calendar2-check"></i></span><span class="open-date-copy"><strong>${escapeHtml(formatDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</strong><small>${escapeHtml(date)} · Open for registration</small></span><button type="button" data-remove-open-date="${date}" aria-label="Remove ${escapeHtml(date)}"><i class="bi bi-trash3 me-1"></i>Remove</button></div>`
    ).join('') : '<div class="settings-empty-date"><i class="bi bi-calendar2-x"></i><strong>No open schedule dates</strong><small>Saving this setting pauses all new registrations. You can add another date at any time.</small></div>';
    $$('[data-remove-open-date]').forEach(button => button.addEventListener('click', () => removeAppointmentDate(button.dataset.removeOpenDate)));

    const expiredNote = $('#expiredAppointmentDateNote');
    if (expiredNote) {
      expiredNote.classList.toggle('d-none', appointmentExpiredDates.length === 0);
      expiredNote.innerHTML = appointmentExpiredDates.length
        ? `<i class="bi bi-clock-history"></i><span>${appointmentExpiredDates.length} expired schedule date${appointmentExpiredDates.length === 1 ? ' was' : 's were'} removed from the editable list automatically. Existing records are preserved.</span>`
        : '';
    }
    const changed = !appointmentDateListsMatch() || appointmentExpiredDates.length > 0;
    const status = $('#appointmentDateChangeStatus');
    if (status) {
      status.classList.toggle('has-changes', changed);
      status.textContent = changed
        ? 'Unsaved date changes · Select Save settings to apply them.'
        : 'No unsaved date changes.';
    }
    const clearButton = $('#clearAppointmentDatesButton');
    if (clearButton) clearButton.disabled = appointmentSettingsDates.length === 0;
  }

  function renderAppointmentSettingsPreview() {
    const laptopCount = Math.max(1, Math.min(50, Math.floor(Number($('#appointmentLaptopInput').value || 1))));
    const sessionMinutes = Math.floor(Number($('#appointmentSessionMinutesInput').value || 10));
    const capacity = laptopCount * Math.floor(60 / sessionMinutes);
    $('#settingsLaptopPreview').textContent = laptopCount;
    $('#settingsSessionPreview').textContent = sessionMinutes;
    $('#settingsCapacityPreview').textContent = capacity;
    $('#settingsDateCountPreview').textContent = appointmentSettingsDates.length;
  }

  async function saveAppointmentSettings() {
    const laptopCount = Math.floor(Number($('#appointmentLaptopInput').value));
    const sessionMinutes = Math.floor(Number($('#appointmentSessionMinutesInput').value));
    if (!Number.isFinite(laptopCount) || laptopCount < 1 || laptopCount > 50) {
      toast('Invalid laptop count', 'Enter a whole number from 1 to 50 laptops.');
      return;
    }
    if (![5, 10, 15, 20, 30, 60].includes(sessionMinutes)) {
      toast('Invalid session time', 'Choose a supported number of minutes per client.');
      return;
    }
    const button = $('#saveAppointmentSettingsButton');
    setButtonBusy(button, true, 'Saving…');
    try {
      const result = await withProcessLoading('Saving appointment settings', 'Updating rotation capacity and open dates for every student…', () =>
        server('facilitatorUpdateAppointmentSettings', getFacilitatorToken(), getDeviceId(), {
          laptopCount,
          sessionMinutes,
          openEventDates: appointmentSettingsDates.slice()
        })
      );
      if (result.config) applyConfig(result.config);
      appointmentSettingsOriginalDates = appointmentSettingsDates.slice();
      appointmentExpiredDates = [];
      hideModal('appointmentSettingsModal');
      await refreshFacilitatorData(true);
      selectRelevantFacilitatorSchedule(false);
      renderFacilitator();
      const dateMessage = OPEN_EVENT_DATES.length
        ? `${OPEN_EVENT_DATES.length} open date${OPEN_EVENT_DATES.length === 1 ? '' : 's'}`
        : 'new registrations paused';
      toast('Appointment settings saved', `${LAPTOP_COUNT} laptops · ${SESSION_MINUTES} minutes/client · ${CAPACITY} clients/hour · ${dateMessage}.`);
    } catch (error) {
      toast('Settings not saved', error.message);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function openPrintRegistrationModal() {
    ensureFacRotation();
    printScope = 'rotation';
    const rotation = getRotationsForSlot(facDate, facSlot).find(item => item.id === facRotation);
    $('#printRotationOptionLabel').textContent = rotation?.label || 'Selected 10-minute rotation';
    $('#printHourOptionLabel').textContent = getSlot(facSlot)?.label || 'Selected hourly batch';
    $('#printDayOptionLabel').textContent = facDate ? formatDate(facDate, { month: 'long', day: 'numeric', year: 'numeric' }) : 'Selected date';
    selectPrintScope('rotation');
    showModal('printRegistrationModal');
  }

  function selectPrintScope(scope) {
    if (!['rotation', 'hour', 'day'].includes(scope)) return;
    printScope = scope;
    $$('[data-print-scope]').forEach(button => button.classList.toggle('active', button.dataset.printScope === scope));
    const students = getPrintableStudents(scope);
    const blankHourlyRows = scope === 'hour' ? Math.max(0, HOURLY_PRINT_MIN_ROWS - students.length) : 0;
    const handwrittenEntryNote = blankHourlyRows
      ? ` The hourly sheet will also include ${blankHourlyRows} bordered blank row${blankHourlyRows === 1 ? '' : 's'} for handwritten registrations.`
      : '';
    $('#printRegistrationSummary').textContent = `${students.length} registered client${students.length === 1 ? '' : 's'} will be included with a blank signature column.${handwrittenEntryNote}`;
  }

  function getPrintableStudents(scope = printScope) {
    return state.students
      .filter(student => student.status !== 'cancelled' && normalizeDateKey(student.date) === normalizeDateKey(facDate))
      .filter(student => scope === 'day' || normalizeSlotId(student.slotId) === normalizeSlotId(facSlot))
      .filter(student => scope !== 'rotation' || String(student.rotationId || '') === String(facRotation || ''))
      .sort((a, b) => {
        const slotDifference = getSlotStart(a.date, getSlot(a.slotId)) - getSlotStart(b.date, getSlot(b.slotId));
        return slotDifference || String(a.rotationStart || '').localeCompare(String(b.rotationStart || '')) || Number(a.sequence || 0) - Number(b.sequence || 0);
      });
  }

  function printableStudentName(student) {
    const middle = String(student.middleName || '').trim();
    const initial = middle ? `${middle.charAt(0).toUpperCase()}.` : '';
    return [student.lastName ? `${student.lastName},` : '', student.firstName, initial].filter(Boolean).join(' ');
  }

function printRegistrationSheet() {
  const students = getPrintableStudents(printScope);
  const rotation = getRotationsForSlot(facDate, facSlot).find(item => item.id === facRotation);

  const scopeLabel = printScope === 'day'
    ? 'Complete Daily Registration List'
    : printScope === 'hour'
      ? `Hourly Batch · ${getSlot(facSlot)?.label || facSlot}`
      : `${SESSION_MINUTES}-Minute Rotation · ${rotation?.label || facRotation}`;

  const generatedAt = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(getServerNow());

  const buildRow = (student, number) => {
    const hasStudent = Boolean(student);

    return `<tr>
      <td class="center">${hasStudent ? number : ''}</td>
      <td>${hasStudent ? escapeHtml(student.queueNumber || '') : ''}</td>
      <td>${hasStudent ? escapeHtml(student.studentIdNumber || '') : ''}</td>
      <td class="name">${hasStudent ? escapeHtml(printableStudentName(student)) : ''}</td>
      <td>${hasStudent ? escapeHtml(`${shortCollege(student.college)} / ${student.course || ''}`) : ''}</td>
      <td>${hasStudent ? escapeHtml(appointmentTimeLabel(student)) : ''}</td>
      <td class="signature"></td>
    </tr>`;
  };

  // Hourly sheets leave a few bordered rows for registrations written in by hand.
  // Other print scopes retain their existing one-row minimum when there are no registrations.
  const minimumPrintableRows = printScope === 'hour' ? HOURLY_PRINT_MIN_ROWS : 1;
  const printableRows = [
    ...students,
    ...Array(Math.max(0, minimumPrintableRows - students.length)).fill(null)
  ];
  const rows = printableRows
    .map((student, index) => buildRow(student, index + 1))
    .join('');

  const tableHeader = `
    <thead>
      <tr>
        <th>No.</th>
        <th>Queue</th>
        <th>Student ID</th>
        <th>Full Name</th>
        <th>College / Course</th>
        <th>Exact Time</th>
        <th>Client Signature</th>
      </tr>
    </thead>`;

  const attendanceTable = `<table>${tableHeader}<tbody>${rows}</tbody></table>`;

  const printHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Wadhwani Registration · ${escapeHtml(scopeLabel)}</title>
  <style>
    @page { size: 13in 8.5in; margin: .45in .50in .55in; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111; font: 11pt/1.3 Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 18px; align-items: end; padding: 0 0 10px; border-bottom: 2px solid #145f4f; }
    h1 { margin: 2px 0 0; font-size: 20pt; line-height: 1.15; color: #145f4f; }
    h2 { margin: 3px 0 0; font-size: 12pt; line-height: 1.2; }
    .office { font-size: 9pt; font-weight: 700; letter-spacing: .055em; text-transform: uppercase; }
    .meta { text-align: right; font-size: 9.5pt; line-height: 1.3; }
    .meta strong, .meta span { display: block; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin: 10px 0; }
    .summary div { min-height: 44px; padding: 7px 9px; border: 1px solid #b8c7c2; border-radius: 5px; }
    .summary small, .summary strong { display: block; }
    .summary small { color: #53655f; font-size: 8pt; text-transform: uppercase; }
    .summary strong { font-size: 10.5pt; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    th { padding: 7px 5px; border: 1px solid #53655f; color: #0d4f41; background: #e5f0ec; font-size: 8.5pt; font-weight: 700; line-height: 1.15; text-transform: uppercase; }
    td { height: 37px; padding: 6px 5px; border: 1px solid #8e9b97; font-size: 9.5pt; line-height: 1.22; vertical-align: middle; overflow-wrap: anywhere; }
    tbody tr:nth-child(even) { background: #f4f8f6; }
    .center { text-align: center; }
    .name { font-weight: 700; }
    .signature { height: 38px; background: #fff; }
    th:nth-child(1) { width: 4%; }
    th:nth-child(2) { width: 8%; }
    th:nth-child(3) { width: 13%; }
    th:nth-child(4) { width: 25%; }
    th:nth-child(5) { width: 20%; }
    th:nth-child(6) { width: 12%; }
    th:nth-child(7) { width: 18%; }
    footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 28px; margin-top: 13px; padding-top: 10px; border-top: 1px solid #8e9b97; font-size: 9.5pt; }
    .signoff { width: 270px; padding-top: 28px; border-bottom: 1px solid #111; }
    .print-note { max-width: 520px; color: #4e5e59; }
  </style>
</head>
<body>
  <header>
    <div>
      <span class="office">Romblon State University · Center for Alumni Relations and Employment Services</span>
      <h1>Wadhwani Registration Attendance and Signature Sheet</h1>
      <h2>${escapeHtml(scopeLabel)}</h2>
    </div>
    <div class="meta">
      <strong>${escapeHtml(formatDate(facDate, { month: 'long', day: 'numeric', year: 'numeric' }))}</strong>
      <span>Printed: ${escapeHtml(generatedAt)}</span>
    </div>
  </header>

  <section class="summary">
    <div><small>Appointment date</small><strong>${escapeHtml(formatDate(facDate, { month: 'long', day: 'numeric', year: 'numeric' }))}</strong></div>
    <div><small>Schedule scope</small><strong>${escapeHtml(scopeLabel)}</strong></div>
    <div><small>Registered clients</small><strong>${students.length}</strong></div>
  </section>

  ${attendanceTable}

  <footer>
    <div class="print-note">By signing, the client confirms attendance during the indicated 10-minute rotation.</div>
    <div>
      <div class="signoff"></div>
      <div class="center">Facilitator signature over printed name</div>
    </div>
  </footer>
</body>
</html>`;

  const printUrl = URL.createObjectURL(new Blob([printHtml], { type: 'text/html' }));
  const printWindow = window.open(printUrl, '_blank', 'width=1280,height=860');

  if (!printWindow) {
    URL.revokeObjectURL(printUrl);
    toast('Print window blocked', 'Allow pop-ups for this page, then try printing again.');
    return;
  }

  const releasePrintUrl = () => URL.revokeObjectURL(printUrl);
  printWindow.addEventListener('afterprint', releasePrintUrl, { once: true });

  let printStarted = false;
  const startPrint = () => {
    if (printStarted) return;
    printStarted = true;
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 300);
  };

  printWindow.addEventListener('load', startPrint, { once: true });
  window.setTimeout(startPrint, 800);
  window.setTimeout(releasePrintUrl, 60000);

  hideModal('printRegistrationModal');
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
      return `<article class="message-item call-response-item"><div><span class="eyebrow">CALL RESPONSE</span><h3>${escapeHtml(fullName(student))} <span class="message-course">– ${escapeHtml(course)}</span></h3><small>${escapeHtml(appointmentTimeLabel(student))} / ${escapeHtml(formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' }))}</small><p><strong>Responded message:</strong> ${escapeHtml(response)}</p><em>${escapeHtml(formatDateTime(student.respondedAt))}</em></div></article>`;
    }).join('') : '<div class="surface empty-list">No student has responded to a Call/Remind alert yet.</div>';

    $('#facMessageList').innerHTML = messages.length ? messages.map(message => {
      const student = state.students.find(item => item.id === message.studentId);
      const studentIdNumber = student?.studentIdNumber || message.studentIdNumber || 'Student ID not assigned';
      const course = courseAbbreviation(student?.course) || 'Course not set';
      const schedule = student ? `${appointmentTimeLabel(student)} / ${formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' })}` : formatDateTime(message.createdAt);
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
    facRotation = String(student.rotationId || '');
    facPart = getSlot(student.slotId)?.part || 'morning';
    selectedFacStudentId = student.id;
    const scannerModal = $('#scannerModal');
    scannerModal.addEventListener('hidden.bs.modal', () => openSelectedStudentSheet(student.id), { once: true });
    hideModal('scannerModal');
    stopQrScanner();
    switchFacView('appointments');
    renderFacilitator();
    const today = normalizeDateKey(getServerNow());
    const warning = normalizeDateKey(student.date) !== today
      ? ` Warning: this ticket is scheduled for ${formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' })}, not today.`
      : ['completed', 'cancelled', 'no_show'].includes(student.status)
        ? ` Current status: ${statusLabel(student.status)}.`
        : '';
    toast(warning ? 'Ticket verified with warning' : 'Ticket verified', `${student.queueNumber} · ${appointmentTimeLabel(student)}.${warning}`);
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
    return getStudentScheduleEnd(student) <= getServerNow();
  }

  function getSlotStart(date, slot) {
    return new Date(`${normalizeDateKey(date)}T${normalizeClock(slot?.start)}:00+08:00`);
  }

  function getSlotEnd(date, slot) {
    return new Date(`${normalizeDateKey(date)}T${normalizeClock(slot?.end)}:00+08:00`);
  }

  function getStudentScheduleStart(student) {
    const slot = getSlot(student?.slotId);
    return new Date(`${normalizeDateKey(student?.date)}T${normalizeClock(student?.rotationStart || slot?.start)}:00+08:00`);
  }

  function getStudentScheduleEnd(student) {
    const slot = getSlot(student?.slotId);
    // A student's 10-minute rotation controls their arrival time, but the
    // ticket stays valid for the entire selected hourly slot.
    return new Date(`${normalizeDateKey(student?.date)}T${normalizeClock(slot?.end || student?.rotationEnd || '00:00')}:00+08:00`);
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
    const body = `Attention user ${student.queueNumber}. Please proceed to the CARES Office for assistance.`;
    showSystemNotification('Wadhwani · You are being called', body, `call-${key}`).catch(() => {});
  }

  function scheduleReminderKey(student = currentStudent) {
    if (!student) return '';
    return `${student.id || student.studentIdNumber}:${normalizeDateKey(student.date)}:${normalizeSlotId(student.slotId)}:${student.rotationId || ''}`;
  }

  function startScheduleReminderWatch() {
    if (scheduleReminderWatchTimer) window.clearTimeout(scheduleReminderWatchTimer);
    scheduleReminderWatchTimer = null;
    checkScheduleReminderWindow();
  }

  function checkScheduleReminderWindow() {
    if (scheduleReminderWatchTimer) window.clearTimeout(scheduleReminderWatchTimer);
    scheduleReminderWatchTimer = null;
    const student = currentStudent;
    if (!student || !isStudentPortalActive() || ['completed', 'ongoing', 'called', 'no_show', 'cancelled'].includes(student.status)) return;
    const slot = getSlot(student.slotId);
    if (!slot) return;

    const start = getStudentScheduleStart(student);
    const now = getServerNow();
    const reminderAt = new Date(start.getTime() - SCHEDULE_REMINDER_MINUTES * 60 * 1000);
    const key = scheduleReminderKey(student);

    if (now >= reminderAt && now < start && acknowledgedScheduleReminderKey !== key) {
      triggerScheduleReminder(student, start, key);
      scheduleReminderWatchTimer = window.setTimeout(checkScheduleReminderWindow, 15000);
      return;
    }

    if (now >= start) {
      stopScheduleReminderAlarm();
      hideModal('scheduleAlertModal');
      return;
    }

    if (acknowledgedScheduleReminderKey === key) {
      const untilStart = start.getTime() - now.getTime();
      scheduleReminderWatchTimer = window.setTimeout(checkScheduleReminderWindow, Math.max(1000, Math.min(60000, untilStart)));
      return;
    }

    const untilReminder = reminderAt.getTime() - now.getTime();
    const nextCheck = Math.max(1000, Math.min(60000, untilReminder));
    scheduleReminderWatchTimer = window.setTimeout(checkScheduleReminderWindow, nextCheck);
  }

  function triggerScheduleReminder(student, start, key) {
    if (student.status === 'called') return;
    const slotLabel = appointmentTimeLabel(student);
    const minutesLeft = Math.max(1, Math.ceil((start.getTime() - getServerNow().getTime()) / 60000));
    $('#scheduleAlertTitle').textContent = minutesLeft <= SCHEDULE_REMINDER_MINUTES
      ? `Your schedule starts in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}`
      : 'Your schedule is coming up';
    $('#scheduleAlertMessage').textContent = `Attention, user ${student.queueNumber}. Your registration schedule is approaching. Please prepare and proceed to the CARES Office for assistance. Thank you.`;
    $('#scheduleAlertSummary').textContent = `${formatDate(student.date, { month: 'long', day: 'numeric', year: 'numeric' })} · ${slotLabel}`;
    showModal('scheduleAlertModal');
    startScheduleReminderAlarm(student, key);

    if (notifiedScheduleReminderKey !== key) {
      notifiedScheduleReminderKey = key;
      showSystemNotification(
        'Wadhwani · Schedule reminder',
        `${student.queueNumber} · ${slotLabel} starts in about ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}. Please proceed to the CARES Office.`,
        `schedule-${key}`
      ).catch(() => {});
    }
  }

  function startScheduleReminderAlarm(student, key = scheduleReminderKey(student)) {
    if (scheduleReminderAlarmTimer) return;
    playScheduleReminderAlarm(student);
    scheduleReminderAlarmTimer = window.setInterval(() => playScheduleReminderAlarm(student), SCHEDULE_REMINDER_REPEAT_MS);
    if (navigator.vibrate) {
      navigator.vibrate([180, 140, 220]);
      scheduleReminderVibrationTimer = window.setInterval(() => navigator.vibrate([180, 140, 220]), SCHEDULE_REMINDER_REPEAT_MS);
    }
  }

  function stopScheduleReminderAlarm() {
    if (scheduleReminderAlarmTimer) window.clearInterval(scheduleReminderAlarmTimer);
    if (scheduleReminderVibrationTimer) window.clearInterval(scheduleReminderVibrationTimer);
    scheduleReminderAlarmTimer = null;
    scheduleReminderVibrationTimer = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  function acknowledgeScheduleReminder(silent = false) {
    const key = scheduleReminderKey(currentStudent);
    if (key) acknowledgedScheduleReminderKey = key;
    stopScheduleReminderAlarm();
    hideModal('scheduleAlertModal');
    if (!silent) toast('Schedule reminder acknowledged', 'Your registration schedule remains visible in the app.');
  }

  function scheduleReminderSpeechText(student) {
    const spokenQueue = String(student.queueNumber || '')
      .replace(/^WR-/i, 'W R ')
      .split('')
      .map(character => character === '0' ? 'zero' : character)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `Attention user ${spokenQueue}. Your registration schedule starts in ten minutes. Please prepare and proceed to the CARES Office for assistance. Thank you.`;
  }

  function speakScheduleReminder(student) {
    if (!soundEnabled || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(scheduleReminderSpeechText(student));
    utterance.lang = 'en-PH';
    utterance.rate = .76;
    utterance.pitch = 1.02;
    utterance.volume = .78;
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(voice => /female|samantha|zira|google.*english|english.*philippines/i.test(`${voice.name} ${voice.lang}`)) || voices.find(voice => /^en/i.test(voice.lang));
    if (preferred) utterance.voice = preferred;
    speechSynthesis.speak(utterance);
  }

  function playScheduleReminderAlarm(student) {
    playFlightAttendantChime();
    if (soundEnabled) window.setTimeout(() => {
      if (currentStudent && scheduleReminderKey(currentStudent) === scheduleReminderKey(student) && currentStudent.status !== 'called') speakScheduleReminder(student);
    }, 1150);
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

  async function enableVolumeAlerts() {
    soundEnabled = true;
    volumePromptShown = true;
    updateSoundButton();
    hideModal('volumePromptModal');
    const notificationPermission = await requestSystemNotificationPermission();
    announce('Reminder alerts are now enabled.');
    let backgroundReady = false;
    if (notificationPermission === 'granted' && currentStudent) {
      backgroundReady = await registerBackgroundPushForCurrentStudent(true);
    }
    const extra = notificationPermission === 'granted'
      ? (backgroundReady ? ' Background browser notifications are registered for this device.' : ' System notifications are enabled.')
      : '';
    toast('Reminder alerts on', `Queue and schedule reminders will play through this device.${extra}`);
    if (currentStudent) checkScheduleReminderWindow();
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

  function formatClock12(value) {
    const clock = normalizeClock(value);
    const match = clock.match(/^(\d{2}):(\d{2})$/);
    if (!match) return String(value || '');
    const hour24 = Number(match[1]);
    return `${hour24 % 12 || 12}:${match[2]} ${hour24 >= 12 ? 'PM' : 'AM'}`;
  }

  function formatClockRange(start, end) {
    const startLabel = formatClock12(start);
    const endLabel = formatClock12(end);
    if (!startLabel || !endLabel) return '';
    const sameSuffix = startLabel.slice(-2) === endLabel.slice(-2);
    return sameSuffix ? `${startLabel.slice(0, -3)}–${endLabel}` : `${startLabel}–${endLabel}`;
  }

  function appointmentTimeLabel(student) {
    if (student?.rotationStart && student?.rotationEnd) return formatClockRange(student.rotationStart, student.rotationEnd);
    return getSlot(student?.slotId)?.label || student?.slotId || 'Schedule unavailable';
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
      email: normalizeEmail(item?.email),
      date: normalizeDateKey(item?.date),
      slotId: normalizeSlotId(item?.slotId),
      rotationId: String(item?.rotationId || '').trim(),
      rotationStart: normalizeClock(item?.rotationStart),
      rotationEnd: normalizeClock(item?.rotationEnd),
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
    return [item.id, item.email, item.date, item.slotId, item.rotationId, item.status, item.reminderResponse, item.calledAt, item.updatedAt, item.position].join('|');
  }

  function batchFingerprint(batch) {
    return (batch || []).map(item => [item.id, item.sequence, item.status, item.owner, item.slotId, item.rotationId].join(':')).join('|');
  }

  function properCase(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b\w/g, char => char.toUpperCase()); }
  function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
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
