/**
 * Wadhwani Registration Queue — Google Apps Script backend
 *
 * Deployment:
 * 1. Bind this project to a Google Sheet, or run setupSystem('SPREADSHEET_ID').
 * 2. Run setupSystem() once and authorize it.
 * 3. Student and facilitator logins use the ID format 001-2023-001929. Facilitator IDs and passwords are stored in Config.
 * 4. Run setupSystem() once after installing this fresh-login version. It rebuilds SlotStats and installs database edit triggers.
 * 5. Run repairRegistrationScheduleData() only if older date/slot cells need normalization.
 * 6. Paste the deployed /exec URL into APPS_SCRIPT_WEB_APP_URL in script.js.
 */

const APP_SETTINGS = Object.freeze({
  TIME_ZONE: 'Asia/Manila',
  CAPACITY: 10, // fallback only; facilitator can change the live capacity in AppointmentSettings
  ENABLE_TODAY_TEST_DATE: false,
  OFFICIAL_EVENT_DATES: ['2026-08-07', '2026-08-12', '2026-08-13'],
  CLOSED_EVENT_DATES: ['2026-08-07'],
  FACILITATOR_SESSION_DAYS: 1,

  // Scalability controls. These values keep ordinary requests short and avoid
  // repeatedly reading the complete Registrations sheet.
  SCHEMA_VERSION: '9',
  WRITE_LOCK_TIMEOUT_MS: 8000,
  ENABLE_STUDENT_ACTIVITY_LOG: false,
  ENABLE_FACILITATOR_ACTIVITY_LOG: true,

  SHEETS: Object.freeze({
    REGISTRATIONS: 'Registrations',
    CONFIG: 'Config',
    MESSAGES: 'Messages',
    SESSIONS: 'Sessions',
    ACTIVITY: 'ActivityLog',
    SLOT_STATS: 'SlotStats',
    APPOINTMENT_SETTINGS: 'AppointmentSettings'
  })
});

const TIME_SLOTS = Object.freeze([
  { id: '08-09', start: '08:00', end: '09:00', label: '8:00–9:00 AM', part: 'morning' },
  { id: '09-10', start: '09:00', end: '10:00', label: '9:00–10:00 AM', part: 'morning' },
  { id: '10-11', start: '10:00', end: '11:00', label: '10:00–11:00 AM', part: 'morning' },
  { id: '11-12', start: '11:00', end: '12:00', label: '11:00 AM–12:00 PM', part: 'morning' },
  { id: '13-14', start: '13:00', end: '14:00', label: '1:00–2:00 PM', part: 'afternoon' },
  { id: '14-15', start: '14:00', end: '15:00', label: '2:00–3:00 PM', part: 'afternoon' },
  { id: '15-16', start: '15:00', end: '16:00', label: '3:00–4:00 PM', part: 'afternoon' },
  { id: '16-17', start: '16:00', end: '17:00', label: '4:00–5:00 PM', part: 'afternoon' },
  { id: '17-18', start: '17:00', end: '18:00', label: '5:00–6:00 PM', part: 'afternoon' }
]);

const COLLEGES = Object.freeze({
  'College of Arts and Sciences': ['BS Biology', 'BA English Language', 'BS Mathematics', 'BS Psychology'],
  'College of Business and Accountancy': ['BS Accountancy', 'BS Business Administration', 'BS Entrepreneurship'],
  'College of Education': ['Bachelor of Elementary Education', 'Bachelor of Secondary Education', 'Bachelor of Technology and Livelihood Education'],
  'College of Engineering and Technology': ['BS Civil Engineering', 'BS Electrical Engineering', 'BS Information Technology'],
  'College of Agriculture, Forestry and Environmental Sciences': ['BS Agriculture', 'BS Forestry', 'BS Environmental Science'],
  'College of Criminal Justice Education': ['BS Criminology'],
  'College of Nursing': ['BS Nursing'],
  'College of Hospitality and Tourism Management': ['BS Hospitality Management', 'BS Tourism Management']
});

const HEADERS = Object.freeze({
  Registrations: [
    'id', 'studentIdNumber', 'legacyEmail', 'firstName', 'middleName', 'lastName', 'college', 'course',
    'date', 'slotId', 'sequence', 'queueNumber', 'ticketCode', 'status',
    'reminderResponse', 'calledAt', 'respondedAt', 'ongoingAt', 'completedAt',
    'noShowAt', 'rescheduledAt', 'registeredAt', 'updatedAt'
  ],
  Config: ['facilitatorId', 'name', 'password', 'active', 'legacyEmail'],
  Messages: ['id', 'studentId', 'studentIdNumber', 'legacyEmail', 'message', 'status', 'createdAt', 'reviewedAt', 'reviewedBy'],
  Sessions: ['token', 'email', 'deviceId', 'role', 'createdAt', 'expiresAt', 'active'],
  ActivityLog: ['id', 'actorEmail', 'action', 'studentId', 'details', 'createdAt'],
  SlotStats: ['slotKey', 'date', 'slotId', 'count', 'lastSequence', 'rosterJson', 'updatedAt'],
  AppointmentSettings: ['key', 'value', 'updatedAt', 'updatedBy']
});

let SPREADSHEET_INSTANCE_ = null;
const SHEET_INSTANCES_ = Object.create(null);

function doGet(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  const action = String(parameters.action || '').trim();

  if (!action) {
    return jsonpOutput_({
      ok: true,
      data: {
        service: 'Wadhwani Registration API',
        status: 'online',
        message: 'Use the localhost frontend to access this service.'
      }
    }, parameters.callback);
  }

  try {
    const payload = parameters.payload ? JSON.parse(parameters.payload) : {};
    const args = Array.isArray(payload.args) ? payload.args : [];
    const result = invokeApiAction_(action, args);
    return jsonpOutput_({ ok: true, data: result }, parameters.callback);
  } catch (error) {
    console.error(error);
    return jsonpOutput_({
      ok: false,
      error: error && error.message ? error.message : String(error || 'Server request failed.')
    }, parameters.callback);
  }
}

/**
 * Only functions explicitly listed here can be called by the localhost app.
 * Administrative setup functions remain editor-only.
 */
function invokeApiAction_(action, args) {
  const routes = {
    ping: { fn: ping, min: 0, max: 0 },
    getPublicBootstrap: { fn: getPublicBootstrap, min: 0, max: 0 },
    resolveLoginId: { fn: resolveLoginId, min: 1, max: 1 },
    checkStudentEligibility: { fn: checkStudentEligibility, min: 1, max: 1 },
    registerStudent: { fn: registerStudent, min: 3, max: 3 },
    getStudentDashboard: { fn: getStudentDashboard, min: 1, max: 1 },
    getStudentSelfState: { fn: getStudentSelfState, min: 1, max: 1 },
    getStudentNotificationState: { fn: getStudentNotificationState, min: 1, max: 1 },
    rescheduleStudent: { fn: rescheduleStudent, min: 3, max: 3 },
    submitStudentResponse: { fn: submitStudentResponse, min: 2, max: 2 },
    sendRescheduleMessage: { fn: sendRescheduleMessage, min: 2, max: 2 },
    loginFacilitator: { fn: loginFacilitator, min: 3, max: 3 },
    validateFacilitatorSession: { fn: validateFacilitatorSession, min: 2, max: 2 },
    logoutFacilitator: { fn: logoutFacilitator, min: 2, max: 2 },
    getFacilitatorState: { fn: getFacilitatorState, min: 2, max: 2 },
    getFacilitatorBatchState: { fn: getFacilitatorBatchState, min: 4, max: 4 },
    facilitatorCallStudent: { fn: facilitatorCallStudent, min: 3, max: 3 },
    facilitatorUpdateStudentStatus: { fn: facilitatorUpdateStudentStatus, min: 4, max: 4 },
    facilitatorReviewMessage: { fn: facilitatorReviewMessage, min: 3, max: 3 },
    facilitatorUpdateAppointmentSettings: { fn: facilitatorUpdateAppointmentSettings, min: 3, max: 3 }
  };

  const route = routes[action];
  if (!route) throw new Error('Unknown API action.');
  if (args.length < route.min || args.length > route.max) throw new Error('Invalid API arguments.');
  return route.fn.apply(null, args);
}

function jsonpOutput_(payload, callback) {
  const callbackName = String(callback || '').trim();
  const safeCallback = /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callbackName) ? callbackName : '';
  const safeJson = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  if (safeCallback) {
    return ContentService
      .createTextOutput(safeCallback + '(' + safeJson + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(safeJson)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run once from the Apps Script editor.
 * For a standalone Apps Script project, pass the Google Sheet ID.
 * For a script bound to the database spreadsheet, leave spreadsheetId blank.
 */
function setupSystem(spreadsheetId) {
  const properties = PropertiesService.getScriptProperties();
  if (spreadsheetId) properties.setProperty('SPREADSHEET_ID', String(spreadsheetId).trim());

  const spreadsheet = getSpreadsheet_();
  spreadsheet.setSpreadsheetTimeZone(APP_SETTINGS.TIME_ZONE);
  ensureSystemSheets_(spreadsheet);
  const syncTriggers = ensureDatabaseSyncTriggers_(spreadsheet);

  const configRows = readObjects_(APP_SETTINGS.SHEETS.CONFIG);
  if (!configRows.some(row => isValidStudentId_(row.facilitatorId))) {
    appendObject_(APP_SETTINGS.SHEETS.CONFIG, {
      facilitatorId: '999-2026-000001',
      name: 'Demo Facilitator',
      password: 'Wadhwani123',
      active: true,
      legacyEmail: ''
    });
  }

  ensureAppointmentSettingsDefaults_();

  const rebuilt = rebuildOperationalIndexes();
  properties.setProperty('SETUP_SCHEMA_VERSION', APP_SETTINGS.SCHEMA_VERSION);
  invalidateConfigCache_();
  invalidatePublicCache_();

  return {
    ok: true,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    indexedRegistrations: rebuilt.registrations,
    databaseSyncTriggers: syncTriggers,
    message: 'Dynamic appointment settings are ready. Facilitators can now set capacity and open dates from the portal.'
  };
}

/**
 * Keeps SlotStats synchronized when an administrator manually edits, pastes,
 * inserts, or removes rows in the Registrations sheet. Student registrations
 * created through this API already update SlotStats directly and do not fire
 * spreadsheet edit triggers.
 */
function ensureDatabaseSyncTriggers_(spreadsheet) {
  const handlers = ['handleDatabaseRegistrationEdit', 'handleDatabaseRegistrationChange'];
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (handlers.includes(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger('handleDatabaseRegistrationEdit')
    .forSpreadsheet(spreadsheet)
    .onEdit()
    .create();
  ScriptApp.newTrigger('handleDatabaseRegistrationChange')
    .forSpreadsheet(spreadsheet)
    .onChange()
    .create();

  return handlers;
}

function handleDatabaseRegistrationEdit(event) {
  const range = event && event.range;
  const sheet = range && range.getSheet ? range.getSheet() : null;
  if (!sheet || sheet.getName() !== APP_SETTINGS.SHEETS.REGISTRATIONS || range.getRow() < 2) return;
  rebuildOperationalIndexesSafely_('EDIT');
}

function handleDatabaseRegistrationChange(event) {
  const changeType = String(event && event.changeType || '').toUpperCase();
  if (!['INSERT_ROW', 'REMOVE_ROW', 'INSERT_COLUMN', 'REMOVE_COLUMN'].includes(changeType)) return;
  rebuildOperationalIndexesSafely_(changeType);
}

function rebuildOperationalIndexesSafely_(reason) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP_SETTINGS.WRITE_LOCK_TIMEOUT_MS)) return;
  try {
    const result = rebuildOperationalIndexes();
    console.log('Operational indexes rebuilt after database change: ' + String(reason || 'UNKNOWN') + ' — ' + JSON.stringify(result));
  } finally {
    lock.releaseLock();
  }
}

function getPublicBootstrap() {
  ensureReady_();
  return buildPublicConfig_();
}

function ping() {
  ensureReady_();
  return { online: true, serverNow: new Date().toISOString(), dataVersion: getDataVersion_() };
}

/**
 * Resolves one Student ID directly from the newest Config and Registrations rows.
 * Facilitator IDs take priority and require a second password step.
 */
function resolveLoginId(loginId) {
  ensureReady_();
  const normalizedId = normalizeStudentId_(loginId);
  if (!isValidStudentId_(normalizedId)) throw new Error('Enter a valid ID in the format 001-2023-001929.');

  const facilitator = findFacilitatorAccount_(normalizedId);
  if (facilitator) {
    return {
      role: 'facilitator',
      requiresPassword: true,
      name: String(facilitator.name || 'Facilitator'),
      serverNow: new Date().toISOString()
    };
  }

  const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
  const student = registrations.find(row => normalizeStudentId_(row.studentIdNumber) === normalizedId) || null;
  if (student) {
    return {
      role: 'student',
      dashboard: buildStudentDashboard_(student, registrations),
      serverNow: new Date().toISOString()
    };
  }

  return { role: 'unregistered', serverNow: new Date().toISOString() };
}

function checkStudentEligibility(candidate) {
  ensureReady_();
  const clean = validateCandidate_(candidate);
  const existing = findRegistrationByStudentId_(clean.studentIdNumber);
  if (existing) {
    return { status: 'existing', dashboard: buildStudentDashboard_(existing) };
  }
  return { status: 'eligible' };
}

function registerStudent(candidate, dateKey, slotId) {
  ensureReady_();
  const clean = validateCandidate_(candidate);
  const cleanDateKey = normalizeDateKey_(dateKey);
  const cleanSlotId = normalizeSlotId_(slotId);
  assertScheduleSelection_(cleanDateKey, cleanSlotId);

  const lock = acquireWriteLock_();
  let registration = null;
  let registrationRow = 0;
  let oldStat = null;
  let oldQueueSequence = null;

  try {
    const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
    const duplicate = registrations.find(row => row.studentIdNumber === clean.studentIdNumber);
    if (duplicate) return buildStudentDashboard_(duplicate, registrations);

    // Registrations is the exact source of truth for capacity and sequence.
    assertSlotAvailable_(registrations, cleanDateKey, cleanSlotId);

    const stat = getOrCreateSlotStat_(cleanDateKey, cleanSlotId);
    oldStat = Object.assign({}, stat);

    // Heal the compact index before appending so it cannot hide valid rows.
    const exactRoster = registrations
      .filter(row => scheduleMatches_(row, cleanDateKey, cleanSlotId) && row.status !== 'cancelled')
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    stat.count = exactRoster.length;
    stat.lastSequence = Math.max(0, ...exactRoster.map(row => Number(row.sequence || 0)));
    stat.rosterJson = JSON.stringify(exactRoster.map(rosterEntry_));

    const properties = PropertiesService.getScriptProperties();
    oldQueueSequence = Number(properties.getProperty('QUEUE_SEQUENCE') || 0);
    const queueSequence = nextQueueSequence_(registrations);
    const sequence = nextBatchSequence_(registrations, cleanDateKey, cleanSlotId);
    const now = new Date().toISOString();
    const id = Utilities.getUuid();

    registration = {
      id: id,
      studentIdNumber: clean.studentIdNumber,
      legacyEmail: '',
      firstName: clean.firstName,
      middleName: clean.middleName,
      lastName: clean.lastName,
      college: clean.college,
      course: clean.course,
      date: cleanDateKey,
      slotId: cleanSlotId,
      sequence: sequence,
      queueNumber: 'WR-' + String(queueSequence).padStart(3, '0'),
      ticketCode: 'WRQR2|' + id + '|' + Utilities.getUuid(),
      status: 'scheduled',
      reminderResponse: '',
      calledAt: '',
      respondedAt: '',
      ongoingAt: '',
      completedAt: '',
      noShowAt: '',
      rescheduledAt: '',
      registeredAt: now,
      updatedAt: now
    };

    registrationRow = appendObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, registration);
    registration._row = registrationRow;

    const roster = exactRoster.map(rosterEntry_);
    roster.push(rosterEntry_(registration));
    stat.count = roster.length;
    stat.lastSequence = sequence;
    stat.rosterJson = JSON.stringify(roster);
    stat.updatedAt = now;
    writeSlotStat_(stat);

    properties.setProperties({
      QUEUE_SEQUENCE: String(queueSequence),
      DATA_VERSION: String(getDataVersion_() + 1)
    }, false);
    invalidatePublicCache_();
    SpreadsheetApp.flush();
  } catch (error) {
    try {
      if (registrationRow) clearObjectRow_(APP_SETTINGS.SHEETS.REGISTRATIONS, registrationRow);
      if (oldStat) writeSlotStat_(oldStat);
      if (oldQueueSequence !== null) {
        PropertiesService.getScriptProperties().setProperty('QUEUE_SEQUENCE', String(oldQueueSequence));
      }
      invalidatePublicCache_();
    } catch (_) {}
    throw error;
  } finally {
    lock.releaseLock();
  }

  logActivity_('student:' + clean.studentIdNumber, 'REGISTER', registration.id,
    JSON.stringify({ date: cleanDateKey, slotId: cleanSlotId }));
  return buildStudentDashboard_(registration);
}

function getStudentDashboard(studentIdNumber) {
  ensureReady_();
  const normalizedStudentId = normalizeStudentId_(studentIdNumber);
  if (!isValidStudentId_(normalizedStudentId)) {
    return { student: null, batch: [], availableSlots: [], config: getPublicBootstrap() };
  }

  const student = findRegistrationByStudentId_(normalizedStudentId);
  if (!student) return { student: null, batch: [], availableSlots: [], config: getPublicBootstrap() };
  return buildStudentDashboard_(student);
}

/**
 * Lightweight student refresh endpoint. It is called only when the student
 * explicitly refreshes or performs an action that needs current data.
 */
function getStudentSelfState(studentIdNumber) {
  ensureReady_();
  const normalizedStudentId = normalizeStudentId_(studentIdNumber);
  if (!isValidStudentId_(normalizedStudentId)) {
    return { student: null, batch: [], serverNow: new Date().toISOString() };
  }

  const student = findRegistrationByStudentId_(normalizedStudentId);
  if (!student) return { student: null, batch: [], serverNow: new Date().toISOString() };

  const batch = buildStudentBatch_(student);
  const position = Math.max(1, batch.findIndex(row => String(row.id) === String(student.id)) + 1);
  return {
    student: Object.assign(ownerStudentView_(student), { position: position }),
    batch: batch,
    serverNow: new Date().toISOString(),
    dataVersion: getDataVersion_()
  };
}


/**
 * Lightweight reminder/status check. It does not return or refresh the batch
 * roster, so another student's registration will not silently reload the page.
 */
function getStudentNotificationState(studentIdNumber) {
  ensureReady_();
  const normalizedStudentId = normalizeStudentId_(studentIdNumber);
  if (!isValidStudentId_(normalizedStudentId)) {
    return { student: null, serverNow: new Date().toISOString() };
  }

  const student = findRegistrationByStudentId_(normalizedStudentId);
  if (!student) return { student: null, serverNow: new Date().toISOString() };

  return {
    student: ownerStudentView_(student),
    serverNow: new Date().toISOString(),
    dataVersion: getDataVersion_()
  };
}

function rescheduleStudent(studentIdNumber, dateKey, slotId) {
  ensureReady_();
  const normalizedStudentId = normalizeStudentId_(studentIdNumber);
  const cleanDateKey = normalizeDateKey_(dateKey);
  const cleanSlotId = normalizeSlotId_(slotId);
  assertScheduleSelection_(cleanDateKey, cleanSlotId);

  const lock = acquireWriteLock_();
  let student = null;
  try {
    const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
    student = registrations.find(row => row.studentIdNumber === normalizedStudentId);
    if (!student) throw new Error('Registration was not found.');
    if (['ongoing', 'completed'].includes(normalizeStatus_(student.status))) {
      throw new Error('An ongoing or completed registration cannot be rescheduled.');
    }
    if (scheduleMatches_(student, cleanDateKey, cleanSlotId)) throw new Error('Choose a different date or time.');

    assertSlotAvailable_(registrations, cleanDateKey, cleanSlotId, student.id);

    const oldDate = student.date;
    const oldSlot = student.slotId;
    const oldStat = getOrCreateSlotStat_(oldDate, oldSlot);
    const newStat = getOrCreateSlotStat_(cleanDateKey, cleanSlotId);

    const now = new Date().toISOString();
    const newSequence = nextBatchSequence_(registrations, cleanDateKey, cleanSlotId, student.id);
    student.date = cleanDateKey;
    student.slotId = cleanSlotId;
    student.sequence = newSequence;
    student.status = 'scheduled';
    student.reminderResponse = '';
    student.calledAt = '';
    student.respondedAt = '';
    student.ongoingAt = '';
    student.completedAt = '';
    student.noShowAt = '';
    student.rescheduledAt = now;
    student.updatedAt = now;

    updateObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, student._row, student);

    const oldRoster = registrations
      .filter(row => String(row.id) !== String(student.id) &&
        scheduleMatches_(row, oldDate, oldSlot) && row.status !== 'cancelled')
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    oldStat.rosterJson = JSON.stringify(oldRoster.map(rosterEntry_));
    oldStat.count = oldRoster.length;
    oldStat.lastSequence = Math.max(0, ...oldRoster.map(row => Number(row.sequence || 0)));
    oldStat.updatedAt = now;
    writeSlotStat_(oldStat);

    const newRoster = registrations
      .filter(row => String(row.id) !== String(student.id) &&
        scheduleMatches_(row, cleanDateKey, cleanSlotId) && row.status !== 'cancelled')
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    newRoster.push(student);
    newStat.rosterJson = JSON.stringify(newRoster.map(rosterEntry_));
    newStat.count = newRoster.length;
    newStat.lastSequence = newSequence;
    newStat.updatedAt = now;
    writeSlotStat_(newStat);

    bumpDataVersion_();
    invalidatePublicCache_();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  logActivity_('student:' + normalizedStudentId, 'RESCHEDULE', student.id,
    JSON.stringify({ date: cleanDateKey, slotId: cleanSlotId }));
  return buildStudentDashboard_(student);
}

function submitStudentResponse(studentIdNumber, response) {
  ensureReady_();
  const allowed = ['on_the_way', 'cant_attend', 'reschedule_requested'];
  if (!allowed.includes(response)) throw new Error('Invalid response.');

  const normalizedStudentId = normalizeStudentId_(studentIdNumber);
  const lock = acquireWriteLock_();
  let student = null;
  try {
    student = findRegistrationByStudentId_(normalizedStudentId);
    if (!student) throw new Error('Registration was not found.');

    const now = new Date().toISOString();
    student.reminderResponse = response;
    student.respondedAt = now;
    student.updatedAt = now;
    if (response === 'cant_attend') student.status = 'cant_attend';
    updateObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, student._row, student);
    updateStudentInSlotRoster_(student, now);
    bumpDataVersion_();
  } finally {
    lock.releaseLock();
  }

  logActivity_('student:' + normalizedStudentId, 'REMINDER_RESPONSE', student.id, response);
  return buildStudentDashboard_(student);
}

function sendRescheduleMessage(studentIdNumber, message) {
  ensureReady_();
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) throw new Error('Write a short rescheduling request.');
  if (cleanMessage.length > 1000) throw new Error('The message must be 1,000 characters or fewer.');

  const normalizedStudentId = normalizeStudentId_(studentIdNumber);
  const lock = acquireWriteLock_();
  let student = null;
  try {
    student = findRegistrationByStudentId_(normalizedStudentId);
    if (!student) throw new Error('Registration was not found.');

    const now = new Date().toISOString();
    appendObject_(APP_SETTINGS.SHEETS.MESSAGES, {
      id: Utilities.getUuid(),
      studentId: student.id,
      studentIdNumber: student.studentIdNumber,
      legacyEmail: '',
      message: cleanMessage,
      status: 'new',
      createdAt: now,
      reviewedAt: '',
      reviewedBy: ''
    });

    student.reminderResponse = 'reschedule_requested';
    student.respondedAt = now;
    student.updatedAt = now;
    updateObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, student._row, student);
    updateStudentInSlotRoster_(student, now);
    bumpDataVersion_();
  } finally {
    lock.releaseLock();
  }

  logActivity_('student:' + normalizedStudentId, 'RESCHEDULE_MESSAGE', student.id, cleanMessage);
  return buildStudentDashboard_(student);
}

function loginFacilitator(facilitatorId, password, deviceId) {
  ensureReady_();
  const normalizedId = normalizeStudentId_(facilitatorId);
  const cleanDeviceId = String(deviceId || '').trim();
  if (!isValidStudentId_(normalizedId)) throw new Error('Enter a valid facilitator ID.');
  if (!cleanDeviceId) throw new Error('Device identification is unavailable. Refresh the page and try again.');

  const suppliedPassword = String(password === undefined || password === null ? '' : password);
  if (!suppliedPassword) throw new Error('Enter the facilitator password.');
  const account = findFacilitatorAccount_(normalizedId);
  if (!account || !safeTextEquals_(account.password, suppliedPassword)) {
    throw new Error('The facilitator ID or password is incorrect.');
  }

  const session = createFacilitatorSession_(account, cleanDeviceId, APP_SETTINGS.FACILITATOR_SESSION_DAYS);
  logActivity_(normalizedId, 'FACILITATOR_LOGIN', '', cleanDeviceId);
  return session;
}

function validateFacilitatorSession(token, deviceId) {
  ensureReady_();
  const session = requireFacilitatorSession_(token, deviceId);
  return { valid: true, facilitator: session.facilitator, expiresAt: session.expiresAt };
}

function logoutFacilitator(token, deviceId) {
  ensureReady_();
  const session = findSessionByToken_(String(token || ''));
  if (session && session.deviceId === String(deviceId || '')) {
    session.active = false;
    updateObject_(APP_SETTINGS.SHEETS.SESSIONS, session._row, session);
    logActivity_(session.email, 'FACILITATOR_LOGOUT', '', session.deviceId);
  }
  return { ok: true };
}

function getFacilitatorState(token, deviceId) {
  ensureReady_();
  const auth = requireFacilitatorSession_(token, deviceId);
  const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS);
  ensureOperationalIndexesCurrent_(registrations);
  const messages = readObjects_(APP_SETTINGS.SHEETS.MESSAGES);
  return {
    facilitator: auth.facilitator,
    students: registrations.map(facilitatorStudentView_),
    messages: messages.map(facilitatorMessageView_),
    config: getPublicBootstrap(),
    dataVersion: getDataVersion_()
  };
}

/**
 * Lightweight live endpoint for the facilitator's currently selected batch.
 * It reads the compact SlotStats roster rather than scanning every registration.
 */
function getFacilitatorBatchState(token, deviceId, dateKey, slotId) {
  ensureReady_();
  const auth = requireFacilitatorSession_(token, deviceId);
  const cleanDateKey = normalizeDateKey_(dateKey);
  const cleanSlotId = normalizeSlotId_(slotId);
  const slot = TIME_SLOTS.find(item => item.id === cleanSlotId);
  const allRegistrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
  if (!getEventDates_(allRegistrations).includes(cleanDateKey) || !slot) {
    throw new Error('Select a valid facilitator date and batch.');
  }

  const students = allRegistrations
    .filter(row => scheduleMatches_(row, cleanDateKey, cleanSlotId) && row.status !== 'cancelled')
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    .slice(0, 200)
    .map(facilitatorStudentView_);

  return {
    facilitator: auth.facilitator,
    date: cleanDateKey,
    slotId: cleanSlotId,
    students: students,
    count: students.length,
    serverNow: new Date().toISOString(),
    config: getPublicBootstrap(),
    dataVersion: getDataVersion_()
  };
}

function facilitatorCallStudent(token, deviceId, studentId) {
  ensureReady_();
  const auth = requireFacilitatorSession_(token, deviceId);
  const lock = acquireWriteLock_();
  let student = null;
  try {
    student = findRegistrationById_(String(studentId || ''));
    if (!student) throw new Error('Student registration was not found.');
    if (normalizeStatus_(student.status) === 'completed') throw new Error('This registration is already completed.');

    const now = new Date().toISOString();
    student.status = 'called';
    student.reminderResponse = '';
    student.calledAt = now;
    student.respondedAt = '';
    student.updatedAt = now;
    updateObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, student._row, student);
    updateStudentInSlotRoster_(student, now);
    bumpDataVersion_();
  } finally {
    lock.releaseLock();
  }

  logActivity_(auth.facilitator.email, 'CALL_STUDENT', student.id, student.queueNumber);
  return { ok: true, student: facilitatorStudentView_(student), dataVersion: getDataVersion_() };
}

function facilitatorUpdateStudentStatus(token, deviceId, studentId, status) {
  ensureReady_();
  const auth = requireFacilitatorSession_(token, deviceId);
  const allowed = ['ongoing', 'completed', 'no_show', 'scheduled'];
  if (!allowed.includes(status)) throw new Error('Invalid status update.');

  const lock = acquireWriteLock_();
  let student = null;
  try {
    student = findRegistrationById_(String(studentId || ''));
    if (!student) throw new Error('Student registration was not found.');

    const now = new Date().toISOString();
    student.status = status;
    student.updatedAt = now;
    if (status === 'ongoing') student.ongoingAt = now;
    if (status === 'completed') student.completedAt = now;
    if (status === 'no_show') student.noShowAt = now;
    updateObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, student._row, student);
    updateStudentInSlotRoster_(student, now);
    bumpDataVersion_();
  } finally {
    lock.releaseLock();
  }

  logActivity_(auth.facilitator.email, 'UPDATE_STATUS', student.id, status);
  return { ok: true, student: facilitatorStudentView_(student), dataVersion: getDataVersion_() };
}

function facilitatorReviewMessage(token, deviceId, messageId) {
  ensureReady_();
  const auth = requireFacilitatorSession_(token, deviceId);
  const message = findMessageById_(String(messageId || ''));
  if (!message) throw new Error('Message was not found.');

  message.status = 'reviewed';
  message.reviewedAt = new Date().toISOString();
  message.reviewedBy = auth.facilitator.email;
  updateObject_(APP_SETTINGS.SHEETS.MESSAGES, message._row, message);
  bumpDataVersion_();
  logActivity_(auth.facilitator.email, 'REVIEW_MESSAGE', message.studentId, message.id);
  return { ok: true, message: facilitatorMessageView_(message), dataVersion: getDataVersion_() };
}

function facilitatorUpdateAppointmentSettings(token, deviceId, payload) {
  ensureReady_();
  const auth = requireFacilitatorSession_(token, deviceId);
  const requested = payload || {};
  const capacity = Math.floor(Number(requested.capacity));
  if (!Number.isFinite(capacity) || capacity < 1 || capacity > 200) {
    throw new Error('Capacity must be a whole number from 1 to 200 students per hour.');
  }

  const dates = Array.from(new Set((Array.isArray(requested.openEventDates) ? requested.openEventDates : [])
    .map(normalizeDateKey_)
    .filter(Boolean))).sort();
  if (!dates.length) throw new Error('Add at least one open appointment date.');
  const today = todayKey_();
  if (dates.some(date => date < today)) throw new Error('Past dates cannot be opened for new appointments.');

  const actor = auth.facilitator.email || auth.facilitator.id || 'facilitator';
  upsertAppointmentSetting_('capacity', String(capacity), actor);
  upsertAppointmentSetting_('openEventDates', JSON.stringify(dates), actor);
  bumpDataVersion_();
  logActivity_(actor, 'UPDATE_APPOINTMENT_SETTINGS', '', JSON.stringify({ capacity: capacity, openEventDates: dates }));

  return {
    ok: true,
    settings: { capacity: capacity, openEventDates: dates },
    config: getPublicBootstrap(),
    dataVersion: getDataVersion_()
  };
}

/** Add or update a facilitator account without manually editing the Config sheet. */
function upsertFacilitator(facilitatorId, name, password, active) {
  ensureReady_();
  const normalizedId = normalizeStudentId_(facilitatorId);
  if (!isValidStudentId_(normalizedId) || !String(password || '').trim()) {
    throw new Error('A valid facilitator ID and password are required.');
  }
  const rows = readObjects_(APP_SETTINGS.SHEETS.CONFIG);
  const existing = rows.find(row => normalizeStudentId_(row.facilitatorId) === normalizedId);
  const account = {
    facilitatorId: normalizedId,
    name: properCase_(name) || 'Facilitator',
    password: String(password),
    active: active !== false,
    legacyEmail: existing ? String(existing.legacyEmail || '') : ''
  };
  if (existing) updateObject_(APP_SETTINGS.SHEETS.CONFIG, existing._row, account);
  else appendObject_(APP_SETTINGS.SHEETS.CONFIG, account);
  return { ok: true, facilitatorId: normalizedId };
}

// ----------------------------- Internal helpers -----------------------------

function ensureReady_() {
  const version = PropertiesService.getScriptProperties().getProperty('SETUP_SCHEMA_VERSION');
  if (version !== APP_SETTINGS.SCHEMA_VERSION) {
    throw new Error('The database needs the scalable upgrade. Run setupSystem() once in the Apps Script editor, then deploy a new version.');
  }
}

function getSpreadsheet_() {
  if (SPREADSHEET_INSTANCE_) return SPREADSHEET_INSTANCE_;
  const configuredId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (configuredId) {
    SPREADSHEET_INSTANCE_ = SpreadsheetApp.openById(configuredId);
    return SPREADSHEET_INSTANCE_;
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    SPREADSHEET_INSTANCE_ = active;
    return SPREADSHEET_INSTANCE_;
  }
  throw new Error('No database spreadsheet is configured. Run setupSystem("YOUR_SPREADSHEET_ID") once.');
}

function ensureSystemSheets_(spreadsheet) {
  Object.keys(APP_SETTINGS.SHEETS).forEach(key => {
    const sheetName = APP_SETTINGS.SHEETS[key];
    const headers = HEADERS[sheetName];
    let sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
    migrateLegacyStudentHeaders_(sheetName, sheet);
    migrateAuthenticationHeaders_(sheetName, sheet);
    ensureHeaders_(sheet, headers);
    formatStudentIdColumn_(sheetName, sheet);
    formatRegistrationScheduleColumns_(sheetName, sheet);
  });
}

/**
 * Safely upgrades the former student-email schema without deleting data.
 * Old email values move into legacyEmail; the new Student ID column is blank
 * until the ID is supplied. Existing schedule records continue to count.
 */
function migrateLegacyStudentHeaders_(sheetName, sheet) {
  if (!sheet || sheet.getLastRow() === 0) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(value => String(value || '').trim());

  if (sheetName === APP_SETTINGS.SHEETS.REGISTRATIONS) {
    if (headers[1] === 'email') {
      sheet.insertColumnAfter(1);
      sheet.getRange(1, 2).setValue('studentIdNumber');
      sheet.getRange(1, 3).setValue('legacyEmail');
      styleHeader_(sheet, HEADERS[sheetName].length);
    } else if (headers[1] === 'studentIdNumber' && headers[2] === 'firstName') {
      sheet.insertColumnAfter(2);
      sheet.getRange(1, 3).setValue('legacyEmail');
      styleHeader_(sheet, HEADERS[sheetName].length);
    }
  }

  if (sheetName === APP_SETTINGS.SHEETS.MESSAGES) {
    if (headers[2] === 'email') {
      sheet.insertColumnAfter(2);
      sheet.getRange(1, 3).setValue('studentIdNumber');
      sheet.getRange(1, 4).setValue('legacyEmail');
      styleHeader_(sheet, HEADERS[sheetName].length);
    } else if (headers[2] === 'studentIdNumber' && headers[3] === 'message') {
      sheet.insertColumnAfter(3);
      sheet.getRange(1, 4).setValue('legacyEmail');
      styleHeader_(sheet, HEADERS[sheetName].length);
    }
  }
}

function migrateAuthenticationHeaders_(sheetName, sheet) {
  if (!sheet || sheetName !== APP_SETTINGS.SHEETS.CONFIG || sheet.getLastRow() === 0) return;
  const width = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(value => String(value || '').trim());
  if (headers[0] === 'facilitatorId' && headers[2] === 'password' && headers[3] === 'active' && headers[4] !== 'legacyEmail') {
    sheet.getRange(1, 5).setValue('legacyEmail');
    styleHeader_(sheet, HEADERS.Config.length);
    return;
  }
  if (headers[0] !== 'email' || headers[2] !== 'accessCode') return;

  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  const oldRows = rowCount ? sheet.getRange(2, 1, rowCount, Math.max(4, width)).getDisplayValues() : [];
  const migrated = oldRows.map((row, index) => {
    const oldEmail = String(row[0] || '').trim();
    const possibleId = normalizeStudentId_(oldEmail);
    return [
      isValidStudentId_(possibleId) ? possibleId : '',
      String(row[1] || '').trim() || 'Facilitator',
      String(row[2] || ''),
      row[3] === '' ? true : row[3],
      oldEmail
    ];
  });

  sheet.clearContents();
  sheet.getRange(1, 1, 1, HEADERS.Config.length).setValues([HEADERS.Config]);
  if (migrated.length) sheet.getRange(2, 1, migrated.length, HEADERS.Config.length).setValues(migrated);
  sheet.setFrozenRows(1);
  styleHeader_(sheet, HEADERS.Config.length);
}

function formatStudentIdColumn_(sheetName, sheet) {
  if (![APP_SETTINGS.SHEETS.REGISTRATIONS, APP_SETTINGS.SHEETS.MESSAGES, APP_SETTINGS.SHEETS.CONFIG].includes(sheetName)) return;
  const headers = HEADERS[sheetName];
  const idHeader = sheetName === APP_SETTINGS.SHEETS.CONFIG ? 'facilitatorId' : 'studentIdNumber';
  const column = headers.indexOf(idHeader) + 1;
  if (column < 1) return;
  if (sheet.getRange(2, column).getNumberFormat() === '@') return;
  const dataRowCount = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(2, column, dataRowCount, 1).setNumberFormat('@');
  sheet.getRange(1, column).setNote((sheetName === APP_SETTINGS.SHEETS.CONFIG ? 'Facilitator ID' : 'Official Student ID') + '. Keep the format 001-2023-001929; this column is plain text to preserve leading zeroes.');
}

function formatRegistrationScheduleColumns_(sheetName, sheet) {
  if (sheetName !== APP_SETTINGS.SHEETS.REGISTRATIONS) return;
  const headers = HEADERS[sheetName];
  const dataRowCount = Math.max(1, sheet.getMaxRows() - 1);
  ['date', 'slotId'].forEach(header => {
    const column = headers.indexOf(header) + 1;
    if (column < 1) return;
    sheet.getRange(2, column, dataRowCount, 1).setNumberFormat('@');
  });
  sheet.getRange(1, headers.indexOf('date') + 1).setNote('Schedule date stored as YYYY-MM-DD.');
  sheet.getRange(1, headers.indexOf('slotId') + 1).setNote('Hourly batch ID such as 08-09 or 13-14.');
}

function ensureHeaders_(sheet, headers) {
  if (!headers || !headers.length) return;
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    styleHeader_(sheet, headers.length);
    return;
  }

  const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getDisplayValues()[0];
  const matches = headers.every((header, index) => String(current[index] || '').trim() === header);
  if (!matches) {
    throw new Error('The header row of the "' + sheet.getName() + '" sheet was changed. Restore these headers: ' + headers.join(', '));
  }
}

function styleHeader_(sheet, width) {
  sheet.getRange(1, 1, 1, width)
    .setFontWeight('bold')
    .setBackground('#115d4c')
    .setFontColor('#ffffff');
  sheet.autoResizeColumns(1, width);
}

function readObjects_(sheetName) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const headers = HEADERS[sheetName];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map((row, index) => objectFromValues_(sheetName, row, index + 2))
    .filter(object => Object.keys(object).some(key => key !== '_row' && String(object[key] || '').trim() !== ''));
}

function appendObject_(sheetName, object) {
  const sheet = getSheet_(sheetName);
  const headers = HEADERS[sheetName];
  const rowNumber = Math.max(2, sheet.getLastRow() + 1);
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([
    headers.map(header => object[header] === undefined ? '' : object[header])
  ]);
  return rowNumber;
}

function updateObject_(sheetName, rowNumber, object) {
  if (!rowNumber || rowNumber < 2) throw new Error('The database row could not be updated.');
  const sheet = getSheet_(sheetName);
  const headers = HEADERS[sheetName];
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([
    headers.map(header => object[header] === undefined ? '' : object[header])
  ]);
}

function serializeCell_(value, header, sheetName) {
  if (!(value instanceof Date)) return value;
  if (sheetName === APP_SETTINGS.SHEETS.REGISTRATIONS && header === 'date') {
    return Utilities.formatDate(value, APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
  }
  if (sheetName === APP_SETTINGS.SHEETS.REGISTRATIONS && header === 'slotId') {
    return Utilities.formatDate(value, APP_SETTINGS.TIME_ZONE, 'HH:mm');
  }
  return value.toISOString();
}

function stripInternal_(object) {
  const copy = {};
  Object.keys(object || {}).forEach(key => {
    if (key !== '_row') copy[key] = object[key];
  });
  return copy;
}

function ownerStudentView_(student) {
  const copy = stripInternal_(normalizeRegistrationRecord_(student));
  delete copy.legacyEmail;
  copy.studentIdNumber = normalizeStudentId_(copy.studentIdNumber);
  copy.maskedStudentId = maskStudentId_(copy.studentIdNumber);
  return copy;
}

function facilitatorStudentView_(student) {
  const copy = stripInternal_(normalizeRegistrationRecord_(student));
  delete copy.legacyEmail;
  copy.studentIdNumber = normalizeStudentId_(copy.studentIdNumber);
  copy.maskedStudentId = maskStudentId_(copy.studentIdNumber);
  return copy;
}

function facilitatorMessageView_(message) {
  const copy = stripInternal_(message);
  delete copy.legacyEmail;
  copy.studentIdNumber = normalizeStudentId_(copy.studentIdNumber);
  return copy;
}

function ensureAppointmentSettingsDefaults_() {
  const rows = readObjects_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS);
  const hasCapacity = rows.some(row => String(row.key || '').trim() === 'capacity');
  const hasOpenDates = rows.some(row => String(row.key || '').trim() === 'openEventDates');
  const fallbackOpenDates = APP_SETTINGS.OFFICIAL_EVENT_DATES
    .map(normalizeDateKey_)
    .filter(Boolean)
    .filter(date => !(APP_SETTINGS.CLOSED_EVENT_DATES || []).map(normalizeDateKey_).includes(date));
  if (!hasCapacity) appendObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, {
    key: 'capacity', value: String(APP_SETTINGS.CAPACITY), updatedAt: new Date().toISOString(), updatedBy: 'setupSystem'
  });
  if (!hasOpenDates) appendObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, {
    key: 'openEventDates', value: JSON.stringify(fallbackOpenDates), updatedAt: new Date().toISOString(), updatedBy: 'setupSystem'
  });
}

function readAppointmentSettings_() {
  const rows = readObjects_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS);
  const map = Object.create(null);
  rows.forEach(row => { map[String(row.key || '').trim()] = row; });
  const parsedCapacity = Number(map.capacity && map.capacity.value);
  const capacity = Number.isFinite(parsedCapacity) && parsedCapacity >= 1 && parsedCapacity <= 200
    ? Math.floor(parsedCapacity)
    : APP_SETTINGS.CAPACITY;

  let openEventDates = [];
  try {
    const raw = map.openEventDates ? JSON.parse(String(map.openEventDates.value || '[]')) : [];
    if (Array.isArray(raw)) openEventDates = raw.map(normalizeDateKey_).filter(Boolean);
  } catch (_) {}
  if (!openEventDates.length) {
    openEventDates = APP_SETTINGS.OFFICIAL_EVENT_DATES
      .map(normalizeDateKey_)
      .filter(Boolean)
      .filter(date => !(APP_SETTINGS.CLOSED_EVENT_DATES || []).map(normalizeDateKey_).includes(date));
  }
  openEventDates = Array.from(new Set(openEventDates)).sort();
  return { capacity: capacity, openEventDates: openEventDates };
}

function getCapacity_() {
  return readAppointmentSettings_().capacity;
}

function upsertAppointmentSetting_(key, value, actor) {
  const rows = readObjects_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS);
  const existing = rows.find(row => String(row.key || '').trim() === key);
  const object = { key: key, value: String(value), updatedAt: new Date().toISOString(), updatedBy: String(actor || '') };
  if (existing) updateObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, existing._row, object);
  else appendObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, object);
}

function getEventDates_(registrations) {
  const settings = readAppointmentSettings_();
  const dates = APP_SETTINGS.OFFICIAL_EVENT_DATES.slice();
  settings.openEventDates.forEach(date => dates.push(date));
  (Array.isArray(registrations) ? registrations : []).forEach(row => {
    const date = normalizeDateKey_(row.date);
    if (date) dates.push(date);
  });
  if (APP_SETTINGS.ENABLE_TODAY_TEST_DATE) dates.push(todayKey_());
  return Array.from(new Set(dates.map(normalizeDateKey_).filter(Boolean))).sort();
}

function buildPublicConfig_() {
  const now = new Date();
  const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
  const appointmentSettings = readAppointmentSettings_();
  const capacity = appointmentSettings.capacity;
  const openDates = new Set(appointmentSettings.openEventDates);
  const eventDates = getEventDates_(registrations);
  const closedDates = new Set(eventDates.filter(date => !openDates.has(date)));

  const availability = eventDates.map(dateKey => {
    const dateClosed = closedDates.has(dateKey);
    const slots = TIME_SLOTS.map(slot => {
      const count = countInSlot_(registrations, dateKey, slot.id);
      const started = slotStart_(dateKey, slot) <= now;
      const ended = slotEnd_(dateKey, slot) <= now;
      const full = dateClosed || count >= capacity;
      const remaining = (full || started) ? 0 : Math.max(0, capacity - count);
      return {
        id: slot.id,
        count: count,
        remaining: remaining,
        started: started,
        ended: ended,
        passed: started,
        closed: dateClosed,
        full: full,
        available: !dateClosed && !started && count < capacity
      };
    });

    return {
      date: dateKey,
      closed: dateClosed,
      total: slots.reduce((sum, slot) => sum + slot.count, 0),
      remaining: dateClosed ? 0 : slots.reduce((sum, slot) => sum + slot.remaining, 0),
      allUnavailable: dateClosed || slots.every(slot => !slot.available),
      slots: slots
    };
  });

  return {
    serverNow: now.toISOString(),
    today: todayKey_(),
    capacity: capacity,
    openEventDates: appointmentSettings.openEventDates.slice(),
    eventDates: eventDates,
    closedEventDates: Array.from(closedDates),
    timeSlots: TIME_SLOTS.map(slot => Object.assign({}, slot)),
    colleges: JSON.parse(JSON.stringify(COLLEGES)),
    availability: availability,
    dataVersion: getDataVersion_()
  };
}

function buildStudentDashboard_(student, registrations) {
  student = normalizeRegistrationRecord_(student);
  const config = getPublicBootstrap();
  const batch = buildStudentBatch_(student, registrations);
  const position = Math.max(1, batch.findIndex(row => String(row.id) === String(student.id)) + 1);
  const availableSlots = [];
  config.availability.forEach(dateItem => {
    dateItem.slots.forEach(slotAvailability => {
      if (slotAvailability.available && !(dateItem.date === student.date && slotAvailability.id === student.slotId)) {
        availableSlots.push({
          date: dateItem.date,
          slotId: slotAvailability.id,
          remaining: slotAvailability.remaining
        });
      }
    });
  });

  return {
    student: Object.assign(ownerStudentView_(student), { position: position }),
    batch: batch,
    availableSlots: availableSlots,
    config: config,
    dataVersion: getDataVersion_()
  };
}

function buildStudentBatch_(student, registrations) {
  const normalizedStudent = normalizeRegistrationRecord_(student);
  const source = Array.isArray(registrations)
    ? registrations
    : readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS);

  return source
    .map(normalizeRegistrationRecord_)
    .filter(row => scheduleMatches_(row, normalizedStudent.date, normalizedStudent.slotId) && row.status !== 'cancelled')
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    .slice(0, 200)
    .map(row => batchMemberView_(row, normalizedStudent.id));
}

function validateCandidate_(candidate) {
  const clean = {
    studentIdNumber: normalizeStudentId_(candidate && candidate.studentIdNumber),
    firstName: properCase_(candidate && candidate.firstName),
    middleName: properCase_(candidate && candidate.middleName),
    lastName: properCase_(candidate && candidate.lastName),
    college: String(candidate && candidate.college || '').trim(),
    course: String(candidate && candidate.course || '').trim()
  };

  if (!isValidStudentId_(clean.studentIdNumber)) throw new Error('Enter a valid Student ID in the format 001-2023-001929.');
  if (!clean.firstName || !clean.lastName || !clean.college || !clean.course) throw new Error('Complete all required student fields.');
  if (!Object.prototype.hasOwnProperty.call(COLLEGES, clean.college)) throw new Error('Select a valid college.');
  if (!COLLEGES[clean.college].includes(clean.course)) throw new Error('Select a valid course for the chosen college.');
  return clean;
}

function assertSlotAvailable_(registrations, dateKey, slotId, excludeStudentId) {
  const cleanDateKey = normalizeDateKey_(dateKey);
  const cleanSlotId = normalizeSlotId_(slotId);
  const appointmentSettings = readAppointmentSettings_();
  const eventDates = appointmentSettings.openEventDates.slice();
  const slot = TIME_SLOTS.find(item => item.id === cleanSlotId);
  if (!eventDates.includes(cleanDateKey) || !slot) throw new Error('Select a valid event date and time.');
  if (slotStart_(cleanDateKey, slot) <= new Date()) throw new Error('That schedule has already passed. Choose another time.');
  if (countInSlot_(registrations, cleanDateKey, cleanSlotId, excludeStudentId) >= appointmentSettings.capacity) {
    throw new Error('That hourly batch is already full. Choose another time.');
  }
}

function countInSlot_(registrations, dateKey, slotId, excludeStudentId) {
  const cleanDateKey = normalizeDateKey_(dateKey);
  const cleanSlotId = normalizeSlotId_(slotId);
  return registrations
    .map(normalizeRegistrationRecord_)
    .filter(row =>
      String(row.id) !== String(excludeStudentId || '') &&
      scheduleMatches_(row, cleanDateKey, cleanSlotId) &&
      row.status !== 'cancelled'
    ).length;
}

function nextBatchSequence_(registrations, dateKey, slotId, excludeStudentId) {
  const cleanDateKey = normalizeDateKey_(dateKey);
  const cleanSlotId = normalizeSlotId_(slotId);
  const values = registrations
    .map(normalizeRegistrationRecord_)
    .filter(row => String(row.id) !== String(excludeStudentId || '') && scheduleMatches_(row, cleanDateKey, cleanSlotId))
    .map(row => Number(row.sequence || 0));
  return Math.max(0, ...values) + 1;
}

function nextQueueSequence_(registrations) {
  const values = registrations.map(row => Number(String(row.queueNumber || '').replace(/\D/g, '')) || 0);
  return Math.max(0, ...values) + 1;
}

function createFacilitatorSession_(account, deviceId, durationDays) {
  const normalizedId = normalizeStudentId_(account.facilitatorId);
  const cleanDeviceId = String(deviceId || '').trim();
  const now = new Date();
  const sessions = readObjects_(APP_SETTINGS.SHEETS.SESSIONS);
  const reusable = sessions.find(row =>
    normalizeStudentId_(row.email) === normalizedId &&
    row.deviceId === cleanDeviceId &&
    row.role === 'facilitator' &&
    isTruthy_(row.active) &&
    new Date(row.expiresAt).getTime() > now.getTime()
  );

  const facilitator = { id: normalizedId, email: normalizedId, name: String(account.name || 'Facilitator') };
  if (reusable) {
    return { token: reusable.token, facilitator: facilitator, expiresAt: reusable.expiresAt };
  }

  const expires = new Date(now.getTime() + Number(durationDays || 1) * 24 * 60 * 60 * 1000);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const sessionRow = {
    token: token,
    email: normalizedId,
    deviceId: cleanDeviceId,
    role: 'facilitator',
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    active: true
  };
  appendObject_(APP_SETTINGS.SHEETS.SESSIONS, sessionRow);
  return { token: token, facilitator: facilitator, expiresAt: expires.toISOString() };
}

function requireFacilitatorSession_(token, deviceId) {
  const cleanToken = String(token || '').trim();
  const cleanDeviceId = String(deviceId || '').trim();
  if (!cleanToken || !cleanDeviceId) throw new Error('Facilitator session is missing. Sign in again.');

  const session = findSessionByToken_(cleanToken);
  if (!session || session.deviceId !== cleanDeviceId || session.role !== 'facilitator' || !isTruthy_(session.active)) {
    throw new Error('Facilitator session is invalid. Sign in again.');
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    session.active = false;
    updateObject_(APP_SETTINGS.SHEETS.SESSIONS, session._row, session);
    throw new Error('Facilitator session expired. Sign in again.');
  }

  const account = findFacilitatorAccount_(session.email);
  if (!account) throw new Error('This facilitator account is no longer active.');

  const normalizedId = normalizeStudentId_(account.facilitatorId);
  return {
    facilitator: { id: normalizedId, email: normalizedId, name: String(account.name || 'Facilitator') },
    expiresAt: session.expiresAt
  };
}

function logActivity_(actorEmail, action, studentId, details) {
  const actor = String(actorEmail || '');
  const isStudentAction = actor.indexOf('student:') === 0;
  if (isStudentAction && !APP_SETTINGS.ENABLE_STUDENT_ACTIVITY_LOG) return;
  if (!isStudentAction && !APP_SETTINGS.ENABLE_FACILITATOR_ACTIVITY_LOG) return;

  try {
    appendObject_(APP_SETTINGS.SHEETS.ACTIVITY, {
      id: Utilities.getUuid(),
      actorEmail: actor,
      action: String(action || ''),
      studentId: String(studentId || ''),
      details: String(details || ''),
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    console.warn('Activity log was skipped:', error && error.message ? error.message : error);
  }
}


function getSheet_(sheetName) {
  if (SHEET_INSTANCES_[sheetName]) return SHEET_INSTANCES_[sheetName];
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing database sheet: ' + sheetName + '. Run setupSystem() once.');
  SHEET_INSTANCES_[sheetName] = sheet;
  return sheet;
}

function objectFromValues_(sheetName, row, rowNumber) {
  const headers = HEADERS[sheetName];
  const object = { _row: rowNumber };
  headers.forEach((header, column) => {
    object[header] = serializeCell_(row[column], header, sheetName);
  });
  return sheetName === APP_SETTINGS.SHEETS.REGISTRATIONS ? normalizeRegistrationRecord_(object) : object;
}

function readObjectAtRow_(sheetName, rowNumber) {
  if (!rowNumber || rowNumber < 2) return null;
  const headers = HEADERS[sheetName];
  const values = getSheet_(sheetName).getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  return objectFromValues_(sheetName, values, rowNumber);
}

function findExactObject_(sheetName, header, value, matchCase) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const column = HEADERS[sheetName].indexOf(header) + 1;
  if (column < 1) throw new Error('Unknown database field: ' + header);
  const finder = sheet.getRange(2, column, lastRow - 1, 1)
    .createTextFinder(String(value || ''))
    .matchEntireCell(true)
    .matchCase(Boolean(matchCase));
  const cell = finder.findNext();
  return cell ? readObjectAtRow_(sheetName, cell.getRow()) : null;
}

function findRegistrationByStudentId_(studentIdNumber) {
  return findExactObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, 'studentIdNumber', normalizeStudentId_(studentIdNumber), false);
}

function findRegistrationById_(id) {
  return findExactObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, 'id', String(id || ''), true);
}

function findMessageById_(id) {
  return findExactObject_(APP_SETTINGS.SHEETS.MESSAGES, 'id', String(id || ''), true);
}

function findSessionByToken_(token) {
  return findExactObject_(APP_SETTINGS.SHEETS.SESSIONS, 'token', String(token || ''), true);
}

function clearObjectRow_(sheetName, rowNumber) {
  if (!rowNumber || rowNumber < 2) return;
  getSheet_(sheetName).getRange(rowNumber, 1, 1, HEADERS[sheetName].length).clearContent();
}

function acquireWriteLock_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP_SETTINGS.WRITE_LOCK_TIMEOUT_MS)) {
    throw new Error('Many students are registering at the same time. Please wait a few seconds, then press the button again.');
  }
  return lock;
}

function slotKey_(dateKey, slotId) {
  return normalizeDateKey_(dateKey) + '|' + normalizeSlotId_(slotId);
}

function defaultSlotStat_(dateKey, slotId) {
  return {
    slotKey: slotKey_(dateKey, slotId),
    date: normalizeDateKey_(dateKey),
    slotId: normalizeSlotId_(slotId),
    count: 0,
    lastSequence: 0,
    rosterJson: '[]',
    updatedAt: new Date().toISOString()
  };
}

function normalizeSlotStat_(stat) {
  const normalized = Object.assign(defaultSlotStat_(stat && stat.date, stat && stat.slotId), stat || {});
  normalized.slotKey = slotKey_(normalized.date, normalized.slotId);
  normalized.count = Math.max(0, Number(normalized.count || 0));
  normalized.lastSequence = Math.max(0, Number(normalized.lastSequence || 0));
  normalized.rosterJson = JSON.stringify(parseRoster_(normalized.rosterJson));
  return normalized;
}

function readSlotStats_() {
  return readObjects_(APP_SETTINGS.SHEETS.SLOT_STATS).map(normalizeSlotStat_);
}

function slotStatsMap_(stats) {
  const map = new Map();
  (stats || []).forEach(stat => map.set(slotKey_(stat.date, stat.slotId), normalizeSlotStat_(stat)));
  return map;
}

function getSlotStat_(dateKey, slotId) {
  const key = slotKey_(dateKey, slotId);
  const stat = findExactObject_(APP_SETTINGS.SHEETS.SLOT_STATS, 'slotKey', key, true);
  return stat ? normalizeSlotStat_(stat) : null;
}

function getOrCreateSlotStat_(dateKey, slotId) {
  let stat = getSlotStat_(dateKey, slotId);
  if (stat) return stat;
  stat = defaultSlotStat_(dateKey, slotId);
  stat._row = appendObject_(APP_SETTINGS.SHEETS.SLOT_STATS, stat);
  return stat;
}

function writeSlotStat_(stat) {
  const normalized = normalizeSlotStat_(stat);
  if (stat && stat._row) {
    normalized._row = stat._row;
    updateObject_(APP_SETTINGS.SHEETS.SLOT_STATS, stat._row, normalized);
    Object.assign(stat, normalized);
    return stat;
  }
  normalized._row = appendObject_(APP_SETTINGS.SHEETS.SLOT_STATS, normalized);
  Object.assign(stat, normalized);
  return stat;
}

function parseRoster_(value) {
  if (Array.isArray(value)) return value.slice(0, Math.max(getCapacity_(), 200));
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.slice(0, Math.max(getCapacity_(), 200)) : [];
  } catch (_) {
    return [];
  }
}

function rosterEntry_(student) {
  const row = normalizeRegistrationRecord_(student);
  return {
    id: row.id,
    studentIdNumber: row.studentIdNumber,
    firstName: String(row.firstName || ''),
    middleName: String(row.middleName || ''),
    lastName: String(row.lastName || ''),
    college: String(row.college || ''),
    course: String(row.course || ''),
    date: row.date,
    slotId: row.slotId,
    sequence: Number(row.sequence || 0),
    queueNumber: String(row.queueNumber || ''),
    ticketCode: String(row.ticketCode || ''),
    status: row.status,
    reminderResponse: String(row.reminderResponse || ''),
    calledAt: row.calledAt || '',
    respondedAt: row.respondedAt || '',
    ongoingAt: row.ongoingAt || '',
    completedAt: row.completedAt || '',
    noShowAt: row.noShowAt || '',
    registeredAt: row.registeredAt || '',
    updatedAt: row.updatedAt || ''
  };
}

function batchMemberView_(row, ownerId) {
  return {
    id: row.id,
    sequence: Number(row.sequence || 0),
    queueNumber: row.queueNumber,
    status: row.status,
    slotId: row.slotId,
    owner: String(row.id) === String(ownerId),
    displayName: fullName_(row),
    maskedStudentId: maskStudentId_(row.studentIdNumber)
  };
}

function updateStudentInSlotRoster_(student, timestamp) {
  const stat = getOrCreateSlotStat_(student.date, student.slotId);
  const roster = parseRoster_(stat.rosterJson);
  const entry = rosterEntry_(student);
  const index = roster.findIndex(item => String(item.id) === String(student.id));
  if (index >= 0) roster[index] = entry;
  else roster.push(entry);
  stat.rosterJson = JSON.stringify(roster);
  stat.count = roster.filter(item => normalizeStatus_(item.status) !== 'cancelled').length;
  stat.lastSequence = Math.max(Number(stat.lastSequence || 0), Number(student.sequence || 0));
  stat.updatedAt = timestamp || new Date().toISOString();
  writeSlotStat_(stat);
}

function assertScheduleSelection_(dateKey, slotId) {
  const cleanDateKey = normalizeDateKey_(dateKey);
  const cleanSlotId = normalizeSlotId_(slotId);
  const slot = TIME_SLOTS.find(item => item.id === cleanSlotId);
  const settings = readAppointmentSettings_();
  if (!settings.openEventDates.includes(cleanDateKey) || !slot) throw new Error('That event date is not open for appointments.');
  if (slotStart_(cleanDateKey, slot) <= new Date()) throw new Error('That schedule has already passed. Choose another time.');
}

function assertSlotStatAvailable_(stat, dateKey, slotId) {
  assertScheduleSelection_(dateKey, slotId);
  if (Number(stat && stat.count || 0) >= getCapacity_()) {
    throw new Error('That hourly batch is already full. Choose another time.');
  }
}

function getDataVersion_() {
  return Number(PropertiesService.getScriptProperties().getProperty('DATA_VERSION') || 0);
}

function bumpDataVersion_() {
  const properties = PropertiesService.getScriptProperties();
  const next = Number(properties.getProperty('DATA_VERSION') || 0) + 1;
  properties.setProperty('DATA_VERSION', String(next));
  return next;
}

function invalidatePublicCache_() {
  // Intentionally empty: public data is read fresh from the spreadsheet on every request.
}

function invalidateConfigCache_() {
  // Intentionally empty: facilitator credentials are read fresh from Config on every request.
}

function readFacilitatorAccounts_() {
  return readObjects_(APP_SETTINGS.SHEETS.CONFIG).map(stripInternal_);
}

function findFacilitatorAccount_(facilitatorId) {
  const normalizedId = normalizeStudentId_(facilitatorId);
  return readFacilitatorAccounts_().find(row =>
    normalizeStudentId_(row.facilitatorId) === normalizedId && isTruthy_(row.active)
  ) || null;
}

function safeTextEquals_(left, right) {
  const a = String(left === undefined || left === null ? '' : left);
  const b = String(right === undefined || right === null ? '' : right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function ensureOperationalIndexesCurrent_(registrations) {
  const expected = new Map();
  (registrations || []).map(normalizeRegistrationRecord_).forEach(row => {
    if (!row.id || !row.date || !row.slotId || row.status === 'cancelled') return;
    const key = slotKey_(row.date, row.slotId);
    expected.set(key, Number(expected.get(key) || 0) + 1);
  });

  const stats = readSlotStats_();
  const actual = new Map(stats.map(stat => [slotKey_(stat.date, stat.slotId), Number(stat.count || 0)]));
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  const mismatch = Array.from(keys).some(key => Number(expected.get(key) || 0) !== Number(actual.get(key) || 0));
  if (mismatch) rebuildOperationalIndexes(registrations);
  return !mismatch;
}

/**
 * Rebuilds the compact SlotStats roster/count index from Registrations.
 * Run after manually editing, sorting, importing, or deleting registration rows.
 */
function rebuildOperationalIndexes(existingRegistrations) {
  const registrations = Array.isArray(existingRegistrations) ? existingRegistrations : readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS);
  const map = new Map();

  getEventDates_(registrations).forEach(dateKey => {
    TIME_SLOTS.forEach(slot => {
      const stat = defaultSlotStat_(dateKey, slot.id);
      map.set(stat.slotKey, stat);
    });
  });

  let maxQueue = 0;
  registrations.forEach(raw => {
    const row = normalizeRegistrationRecord_(raw);
    if (!row.id || !row.date || !row.slotId) return;
    const key = slotKey_(row.date, row.slotId);
    const stat = map.get(key) || defaultSlotStat_(row.date, row.slotId);
    const roster = parseRoster_(stat.rosterJson);
    roster.push(rosterEntry_(row));
    stat.rosterJson = JSON.stringify(roster);
    if (row.status !== 'cancelled') stat.count += 1;
    stat.lastSequence = Math.max(Number(stat.lastSequence || 0), Number(row.sequence || 0));
    stat.updatedAt = new Date().toISOString();
    map.set(key, stat);
    maxQueue = Math.max(maxQueue, Number(String(row.queueNumber || '').replace(/\D/g, '')) || 0);
  });

  const sheet = getSheet_(APP_SETTINGS.SHEETS.SLOT_STATS);
  const headers = HEADERS[APP_SETTINGS.SHEETS.SLOT_STATS];
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
  const rows = Array.from(map.values())
    .sort((a, b) => String(a.slotKey).localeCompare(String(b.slotKey)))
    .map(stat => headers.map(header => stat[header] === undefined ? '' : stat[header]));
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

  PropertiesService.getScriptProperties().setProperties({
    QUEUE_SEQUENCE: String(maxQueue),
    DATA_VERSION: String(getDataVersion_() + 1),
    SETUP_SCHEMA_VERSION: APP_SETTINGS.SCHEMA_VERSION
  }, false);
  invalidatePublicCache_();
  SpreadsheetApp.flush();
  return { ok: true, registrations: registrations.length, slotRows: rows.length, maxQueue: maxQueue };
}

/** Quick health report; safe to run manually from the Apps Script editor. */
function runScalabilityDiagnostic() {
  ensureReady_();
  const registrationRows = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS);
  const registrations = registrationRows.length;
  const countableRegistrations = registrationRows.filter(row => normalizeStatus_(row.status) !== 'cancelled').length;
  const messages = Math.max(0, getSheet_(APP_SETTINGS.SHEETS.MESSAGES).getLastRow() - 1);
  const sessions = Math.max(0, getSheet_(APP_SETTINGS.SHEETS.SESSIONS).getLastRow() - 1);
  const stats = readSlotStats_();
  const indexed = stats.reduce((sum, stat) => sum + Number(stat.count || 0), 0);
  return {
    ok: true,
    schemaVersion: APP_SETTINGS.SCHEMA_VERSION,
    registrations: registrations,
    countableRegistrations: countableRegistrations,
    indexedActiveRegistrations: indexed,
    messages: messages,
    sessions: sessions,
    slotStatsRows: stats.length,
    queueSequence: Number(PropertiesService.getScriptProperties().getProperty('QUEUE_SEQUENCE') || 0),
    dataVersion: getDataVersion_(),
    publicConfigBytes: JSON.stringify(getPublicBootstrap()).length,
    note: indexed === countableRegistrations ? 'Slot index matches active registration rows.' : 'Run rebuildOperationalIndexes() after manual sheet edits.'
  };
}

function normalizeRegistrationRecord_(record) {
  const row = Object.assign({}, record || {});
  row.id = String(row.id || '').trim();
  row.studentIdNumber = normalizeStudentId_(row.studentIdNumber);
  row.date = normalizeDateKey_(row.date);
  row.slotId = normalizeSlotId_(row.slotId);
  row.sequence = Number(row.sequence || 0);
  row.queueNumber = String(row.queueNumber || '').trim();
  row.status = normalizeStatus_(row.status);
  return row;
}

function normalizeDateKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
  }

  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const isoDate = new Date(raw);
    if (!isNaN(isoDate.getTime())) return Utilities.formatDate(isoDate, APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
  }
  const ymd = raw.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)/);
  if (ymd) return ymd[1] + '-' + String(ymd[2]).padStart(2, '0') + '-' + String(ymd[3]).padStart(2, '0');
  const mdy = raw.match(/^([01]?\d)[-\/]([0-3]?\d)[-\/](\d{4})$/);
  if (mdy) return mdy[3] + '-' + String(mdy[1]).padStart(2, '0') + '-' + String(mdy[2]).padStart(2, '0');

  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? raw : Utilities.formatDate(parsed, APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
}

function normalizeSlotId_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    value = Utilities.formatDate(value, APP_SETTINGS.TIME_ZONE, 'HH:mm');
  }

  const raw = String(value || '').trim();
  if (!raw) return '';
  const direct = TIME_SLOTS.find(slot => slot.id.toLowerCase() === raw.toLowerCase());
  if (direct) return direct.id;

  const comparable = raw.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  const byLabel = TIME_SLOTS.find(slot => slot.label.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim() === comparable);
  if (byLabel) return byLabel.id;

  const clock = comparable.match(/(?:^|\D)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    const trailingMeridiem = comparable.match(/(am|pm)\s*$/i);
    const meridiem = String(clock[3] || (trailingMeridiem && trailingMeridiem[1]) || '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const start = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    const byStart = TIME_SLOTS.find(slot => slot.start === start);
    if (byStart) return byStart.id;
  }
  return raw;
}

function normalizeStatus_(value) {
  const status = String(value || 'scheduled').trim().toLowerCase().replace(/[ -]+/g, '_');
  const aliases = { pending: 'scheduled', registered: 'scheduled', in_progress: 'ongoing', done: 'completed', noshow: 'no_show' };
  return aliases[status] || status || 'scheduled';
}

function scheduleMatches_(row, dateKey, slotId) {
  const clean = normalizeRegistrationRecord_(row);
  return clean.date === normalizeDateKey_(dateKey) && clean.slotId === normalizeSlotId_(slotId);
}

/** Run once from the Apps Script editor to permanently standardize old schedule cells. */
function repairRegistrationScheduleData() {
  const sheet = getSheet_(APP_SETTINGS.SHEETS.REGISTRATIONS);
  const headers = HEADERS[APP_SETTINGS.SHEETS.REGISTRATIONS];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    const rebuiltEmpty = rebuildOperationalIndexes();
    return { ok: true, repairedRows: 0, rebuilt: rebuiltEmpty };
  }

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const normalizedValues = values.map((row, index) => {
    const normalized = normalizeRegistrationRecord_(objectFromValues_(APP_SETTINGS.SHEETS.REGISTRATIONS, row, index + 2));
    return headers.map(header => normalized[header] === undefined ? '' : normalized[header]);
  });
  sheet.getRange(2, 1, normalizedValues.length, headers.length).setValues(normalizedValues);
  const rebuilt = rebuildOperationalIndexes();
  return {
    ok: true,
    repairedRows: normalizedValues.length,
    rebuilt: rebuilt,
    message: 'Registration rows and scalable slot indexes were standardized in batch.'
  };
}

function slotStart_(dateKey, slot) {
  return new Date(String(dateKey) + 'T' + slot.start + ':00+08:00');
}

function slotEnd_(dateKey, slot) {
  return new Date(String(dateKey) + 'T' + slot.end + ':00+08:00');
}

function todayKey_() {
  return Utilities.formatDate(new Date(), APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStudentId_(value) {
  const raw = String(value || '').trim();
  if (!raw || !/^[\d\s-]+$/.test(raw)) return '';
  const digits = raw.replace(/\D/g, '').slice(0, 13);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return digits.slice(0, 3) + '-' + digits.slice(3);
  return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
}

function isValidStudentId_(value) {
  return /^\d{3}-\d{4}-\d{6}$/.test(String(value || ''));
}

function maskStudentId_(value) {
  const normalized = normalizeStudentId_(value);
  return isValidStudentId_(normalized) ? '***-****-****' + normalized.slice(-2) : 'Not assigned';
}

function normalizeName_(person) {
  return [person.firstName, person.middleName, person.lastName]
    .map(value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
    .join('|');
}

function properCase_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b\w/g, character => character.toUpperCase());
}

function fullName_(person) {
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ');
}

function privacyName_(person) {
  return String(person.firstName || '') + ' ' + (person.lastName ? String(person.lastName).charAt(0) + '.' : '');
}

function isTruthy_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1' || String(value).toLowerCase() === 'yes';
}
