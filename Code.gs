/**
 * Wadhwani Registration Queue — Google Apps Script backend
 *
 * Deployment:
 * 1. Bind this project to a Google Sheet, or run setupSystem('SPREADSHEET_ID').
 * 2. Run setupSystem() once and authorize it.
 * 3. Student and facilitator logins use the ID format 001-2023-001929. Facilitator IDs and passwords are stored in Config.
 * 4. Run setupSystem() once when installing/upgrading this schema-14 backend. It adds registration email and 10-minute rotations,
 *    rebuilds SlotStats, and installs database edit triggers.
 * 5. Run repairRegistrationScheduleData() only if older date/slot cells need normalization.
 * 6. Paste the deployed /exec URL into APPS_SCRIPT_WEB_APP_URL in script.js.
 */

const APP_SETTINGS = Object.freeze({
  TIME_ZONE: 'Asia/Manila',
  LAPTOP_COUNT: 10,
  SESSION_MINUTES: 10,
  ENABLE_TODAY_TEST_DATE: false,
  // No fixed seed dates. Facilitators add the active schedule dates in Appointment settings.
  OFFICIAL_EVENT_DATES: [],
  CLOSED_EVENT_DATES: [],
  REMOVED_EVENT_DATES: ['2026-08-07', '2026-08-12', '2026-08-13'],
  FACILITATOR_SESSION_DAYS: 1,

  // Scalability controls. These values keep ordinary requests short and avoid
  // repeatedly reading the complete Registrations sheet.
  SCHEMA_VERSION: '14',
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
    APPOINTMENT_SETTINGS: 'AppointmentSettings',
    PUSH_SUBSCRIPTIONS: 'PushSubscriptions',
    PUSH_LOG: 'PushLog'
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
  { id: '16-17', start: '16:00', end: '17:00', label: '4:00–5:00 PM', part: 'afternoon' }
]);

const COLLEGES = Object.freeze({
  'College of Arts and Sciences': [],
  'College of Business and Accountancy': [],
  'College of Education': [],
  'College of Engineering and Technology': [],
  'College of Computing Multimedia Arts and Digital Innovation': []
});

const HEADERS = Object.freeze({
  Registrations: [
    'id', 'studentIdNumber', 'email', 'firstName', 'middleName', 'lastName', 'college', 'course',
    'date', 'slotId', 'sequence', 'queueNumber', 'ticketCode', 'status',
    'reminderResponse', 'calledAt', 'respondedAt', 'ongoingAt', 'completedAt',
    'noShowAt', 'rescheduledAt', 'registeredAt', 'updatedAt',
    'rotationId', 'rotationStart', 'rotationEnd'
  ],
  Config: ['facilitatorId', 'name', 'password', 'active', 'legacyEmail'],
  Messages: ['id', 'studentId', 'studentIdNumber', 'legacyEmail', 'message', 'status', 'createdAt', 'reviewedAt', 'reviewedBy'],
  Sessions: ['token', 'email', 'deviceId', 'role', 'createdAt', 'expiresAt', 'active'],
  ActivityLog: ['id', 'actorEmail', 'action', 'studentId', 'details', 'createdAt'],
  SlotStats: ['slotKey', 'date', 'slotId', 'count', 'lastSequence', 'rosterJson', 'updatedAt'],
  AppointmentSettings: ['key', 'value', 'updatedAt', 'updatedBy'],
  PushSubscriptions: ['id', 'studentIdNumber', 'target', 'targetType', 'platform', 'userAgent', 'enabled', 'createdAt', 'updatedAt', 'lastSeenAt'],
  PushLog: ['id', 'reminderKey', 'studentIdNumber', 'type', 'target', 'status', 'detail', 'sentAt']
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
    checkRegistrationIdentity: { fn: checkRegistrationIdentity, min: 4, max: 4 },
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
    facilitatorUpdateAppointmentSettings: { fn: facilitatorUpdateAppointmentSettings, min: 3, max: 3 },
    registerStudentPushTarget: { fn: registerStudentPushTarget, min: 3, max: 3 },
    disableStudentPushTarget: { fn: disableStudentPushTarget, min: 2, max: 2 }
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
  const rotationMigration = migrateRegistrationRotationData_();

  const rebuilt = rebuildOperationalIndexes();
  properties.setProperty('SETUP_SCHEMA_VERSION', APP_SETTINGS.SCHEMA_VERSION);
  const reminderTrigger = ensureBackgroundReminderTrigger_();
  invalidateConfigCache_();
  invalidatePublicCache_();

  return {
    ok: true,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    indexedRegistrations: rebuilt.registrations,
    assignedLegacyRotations: rotationMigration.assigned,
    legacyRotationOverflow: rotationMigration.overflow,
    databaseSyncTriggers: syncTriggers,
    backgroundReminderTrigger: reminderTrigger,
    firebaseMessagingConfigured: isFcmServerConfigured_(),
    message: 'Dynamic appointment settings and background-reminder infrastructure are ready.'
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
  const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
  const existing = registrations.find(row => row.studentIdNumber === clean.studentIdNumber);
  if (existing) {
    return { status: 'existing', dashboard: buildStudentDashboard_(existing, registrations) };
  }

  const duplicateName = findDuplicateRegistrationByName_(registrations, clean, clean.studentIdNumber);
  if (duplicateName) {
    return {
      status: 'duplicate_name',
      message: 'A registration with this full name already exists. Please verify the Student ID or ask the CARES Office for assistance.'
    };
  }
  return { status: 'eligible' };
}

/**
 * Lightweight registration identity pre-check. Used by the registration form on
 * field blur and again before schedule selection. It does not return another
 * student's unmasked Student ID when the duplicate was found by name only.
 */
function checkRegistrationIdentity(studentIdNumber, firstName, middleName, lastName) {
  ensureReady_();
  const normalizedId = normalizeStudentId_(studentIdNumber);
  const hasValidId = isValidStudentId_(normalizedId);

  if (hasValidId && findFacilitatorAccount_(normalizedId)) {
    return {
      idExists: true,
      idRole: 'facilitator',
      nameExists: false,
      message: 'This ID belongs to a facilitator account and cannot be used for student registration.'
    };
  }

  const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
  const existingById = hasValidId
    ? registrations.find(row => row.status !== 'cancelled' && normalizeStudentId_(row.studentIdNumber) === normalizedId) || null
    : null;

  const candidate = {
    firstName: properCase_(firstName),
    middleName: properCase_(middleName),
    lastName: properCase_(lastName)
  };
  const hasUsableName = Boolean(String(candidate.firstName || '').trim() && String(candidate.lastName || '').trim());
  const duplicateName = hasUsableName
    ? findDuplicateRegistrationByName_(registrations, candidate, normalizedId)
    : null;

  return {
    idExists: Boolean(existingById),
    idRole: existingById ? 'student' : '',
    idStatus: existingById ? String(existingById.status || '') : '',
    nameExists: Boolean(duplicateName),
    existingIdMatchesName: Boolean(existingById && normalizeName_(existingById) === normalizeName_(candidate)),
    maskedStudentId: existingById ? maskStudentId_(existingById.studentIdNumber) : '',
    message: existingById
      ? 'This Student ID is already registered. Please sign in to open the existing ticket.'
      : duplicateName
        ? 'This full name already has a registration. Please sign in using the Student ID used for that registration.'
        : ''
  };
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

    const duplicateName = findDuplicateRegistrationByName_(registrations, clean, clean.studentIdNumber);
    if (duplicateName) {
      throw new Error('A registration with this full name already exists. Please verify the Student ID or ask the CARES Office for assistance.');
    }

    // Registrations is the exact source of truth. Reserve the first free
    // 10-minute client place while the server write lock is held.
    const assignment = assertSlotAvailable_(registrations, cleanDateKey, cleanSlotId);

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
      email: clean.email,
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
      updatedAt: now,
      rotationId: assignment.rotationId,
      rotationStart: assignment.rotationStart,
      rotationEnd: assignment.rotationEnd
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
    JSON.stringify({ date: cleanDateKey, slotId: cleanSlotId, rotationId: registration.rotationId }));
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
    const assignment = assertSlotAvailable_(registrations, cleanDateKey, cleanSlotId, student.id);

    const oldDate = student.date;
    const oldSlot = student.slotId;
    const oldStat = getOrCreateSlotStat_(oldDate, oldSlot);
    const newStat = getOrCreateSlotStat_(cleanDateKey, cleanSlotId);

    const now = new Date().toISOString();
    const newSequence = nextBatchSequence_(registrations, cleanDateKey, cleanSlotId, student.id);
    student.date = cleanDateKey;
    student.slotId = cleanSlotId;
    student.rotationId = assignment.rotationId;
    student.rotationStart = assignment.rotationStart;
    student.rotationEnd = assignment.rotationEnd;
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
    JSON.stringify({ date: cleanDateKey, slotId: cleanSlotId, rotationId: student.rotationId }));
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
  let push = { configured: isFcmServerConfigured_(), attempted: 0, sent: 0 };
  try { push = sendPushToStudent_(student, 'call'); } catch (error) { console.warn('Call push failed: ' + error.message); }
  return { ok: true, student: facilitatorStudentView_(student), push: push, dataVersion: getDataVersion_() };
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
  if (status === 'completed') {
    try { disablePushTargetsForStudent_(student.studentIdNumber); } catch (error) { console.warn('Unable to disable completed-student push targets: ' + error.message); }
  }
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
  const laptopCount = Math.floor(Number(requested.laptopCount));
  const sessionMinutes = Math.floor(Number(requested.sessionMinutes));
  if (!Number.isFinite(laptopCount) || laptopCount < 1 || laptopCount > 50) {
    throw new Error('Laptop count must be a whole number from 1 to 50.');
  }
  if (![5, 10, 15, 20, 30, 60].includes(sessionMinutes)) {
    throw new Error('Minutes per client must divide one hour evenly.');
  }
  const capacity = laptopCount * Math.floor(60 / sessionMinutes);

  const removedDates = new Set((APP_SETTINGS.REMOVED_EVENT_DATES || []).map(normalizeDateKey_).filter(Boolean));
  const dates = Array.from(new Set((Array.isArray(requested.openEventDates) ? requested.openEventDates : [])
    .map(normalizeDateKey_)
    .filter(date => date && !removedDates.has(date)))).sort();
  const today = todayKey_();
  if (dates.some(date => date < today)) throw new Error('Past dates cannot be opened for new appointments.');

  const actor = auth.facilitator.email || auth.facilitator.id || 'facilitator';
  assertResourceSettingsCompatible_(laptopCount, sessionMinutes);
  upsertAppointmentSetting_('laptopCount', String(laptopCount), actor);
  upsertAppointmentSetting_('sessionMinutes', String(sessionMinutes), actor);
  upsertAppointmentSetting_('capacity', String(capacity), actor);
  upsertAppointmentSetting_('openEventDates', JSON.stringify(dates), actor);
  bumpDataVersion_();
  logActivity_(actor, 'UPDATE_APPOINTMENT_SETTINGS', '', JSON.stringify({ laptopCount: laptopCount, sessionMinutes: sessionMinutes, capacity: capacity, openEventDates: dates }));

  return {
    ok: true,
    settings: { laptopCount: laptopCount, sessionMinutes: sessionMinutes, capacity: capacity, openEventDates: dates },
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


/**
 * Saves the Firebase Cloud Messaging target for the currently authenticated-by-ID student.
 * This target is used only for Wadhwani schedule/call reminders. It never stores or restores
 * a browser login session.
 */
function registerStudentPushTarget(studentIdNumber, target, meta) {
  ensureReady_();
  const normalizedId = normalizeStudentId_(studentIdNumber);
  const cleanTarget = String(target || '').trim();
  if (!isValidStudentId_(normalizedId)) throw new Error('Enter a valid Student ID.');
  if (!cleanTarget || cleanTarget.length < 20 || cleanTarget.length > 4096) throw new Error('The push target is invalid.');

  const student = findExactObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, 'studentIdNumber', normalizedId, false);
  if (!student || normalizeStatus_(student.status) === 'cancelled') throw new Error('Student registration was not found.');
  if (normalizeStatus_(student.status) === 'completed') {
    disablePushTargetsForStudent_(normalizedId);
    return { ok: false, completed: true, serverConfigured: isFcmServerConfigured_() };
  }

  const lock = acquireWriteLock_();
  try {
    const rows = readObjects_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS);
    const existing = rows.find(row => String(row.target || '').trim() === cleanTarget);
    const now = new Date().toISOString();
    const details = meta && typeof meta === 'object' ? meta : {};
    const object = {
      id: existing ? existing.id : Utilities.getUuid(),
      studentIdNumber: normalizedId,
      target: cleanTarget,
      targetType: String(details.targetType || 'token').trim().toLowerCase() || 'token',
      platform: String(details.platform || '').slice(0, 120),
      userAgent: String(details.userAgent || '').slice(0, 500),
      enabled: true,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      lastSeenAt: now
    };
    if (existing) updateObject_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS, existing._row, object);
    else appendObject_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS, object);
  } finally {
    lock.releaseLock();
  }

  return { ok: true, serverConfigured: isFcmServerConfigured_() };
}

function disableStudentPushTarget(studentIdNumber, target) {
  ensureReady_();
  const normalizedId = normalizeStudentId_(studentIdNumber);
  const cleanTarget = String(target || '').trim();
  if (!isValidStudentId_(normalizedId) || !cleanTarget) return { ok: true, disabled: 0 };

  const lock = acquireWriteLock_();
  let disabled = 0;
  try {
    readObjects_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS).forEach(row => {
      if (normalizeStudentId_(row.studentIdNumber) !== normalizedId || String(row.target || '').trim() !== cleanTarget) return;
      row.enabled = false;
      row.updatedAt = new Date().toISOString();
      updateObject_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS, row._row, row);
      disabled += 1;
    });
  } finally {
    lock.releaseLock();
  }
  return { ok: true, disabled: disabled };
}

/**
 * Editor-only helper. Pass the Firebase service-account JSON object or JSON string.
 * The private key is written only to Apps Script Script Properties, never to a sheet
 * and never to the public web app.
 */
function configureFirebaseMessaging(serviceAccountJson) {
  let account = serviceAccountJson;
  if (typeof account === 'string') account = JSON.parse(account);
  if (!account || typeof account !== 'object') throw new Error('Provide the Firebase service-account JSON object.');
  const projectId = String(account.project_id || '').trim();
  const clientEmail = String(account.client_email || '').trim();
  const privateKey = String(account.private_key || '').replace(/\\n/g, '\n').trim();
  if (!projectId || !clientEmail || !/BEGIN PRIVATE KEY/.test(privateKey)) throw new Error('The service-account project_id, client_email, or private_key is missing.');

  PropertiesService.getScriptProperties().setProperties({
    FCM_PROJECT_ID: projectId,
    FCM_CLIENT_EMAIL: clientEmail,
    FCM_PRIVATE_KEY: privateKey
  }, false);
  CacheService.getScriptCache().remove('FCM_ACCESS_TOKEN_V11');
  invalidatePublicCache_();
  return { ok: true, projectId: projectId, clientEmail: clientEmail, configured: true };
}

function clearFirebaseMessagingConfig() {
  PropertiesService.getScriptProperties().deleteProperty('FCM_PROJECT_ID');
  PropertiesService.getScriptProperties().deleteProperty('FCM_CLIENT_EMAIL');
  PropertiesService.getScriptProperties().deleteProperty('FCM_PRIVATE_KEY');
  CacheService.getScriptCache().remove('FCM_ACCESS_TOKEN_V11');
  invalidatePublicCache_();
  return { ok: true, configured: false };
}

function isFcmServerConfigured_() {
  const props = PropertiesService.getScriptProperties();
  return Boolean(
    String(props.getProperty('FCM_PROJECT_ID') || '').trim() &&
    String(props.getProperty('FCM_CLIENT_EMAIL') || '').trim() &&
    /BEGIN PRIVATE KEY/.test(String(props.getProperty('FCM_PRIVATE_KEY') || ''))
  );
}

function getFcmAccessToken_() {
  if (!isFcmServerConfigured_()) throw new Error('Firebase Cloud Messaging is not configured in Apps Script.');
  const cache = CacheService.getScriptCache();
  const cached = cache.get('FCM_ACCESS_TOKEN_V11');
  if (cached) return cached;

  const props = PropertiesService.getScriptProperties();
  const clientEmail = String(props.getProperty('FCM_CLIENT_EMAIL') || '').trim();
  const privateKey = String(props.getProperty('FCM_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlText_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64UrlText_(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsignedJwt = header + '.' + claims;
  const signatureBytes = Utilities.computeRsaSha256Signature(unsignedJwt, privateKey);
  const signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/g, '');
  const assertion = unsignedJwt + '.' + signature;

  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion
    },
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  let parsed = {};
  try { parsed = JSON.parse(response.getContentText() || '{}'); } catch (_) {}
  if (code < 200 || code >= 300 || !parsed.access_token) {
    throw new Error('Unable to authorize Firebase Cloud Messaging (' + code + '). ' + String(parsed.error_description || parsed.error || '').slice(0, 300));
  }
  const ttl = Math.max(300, Math.min(3300, Number(parsed.expires_in || 3600) - 300));
  cache.put('FCM_ACCESS_TOKEN_V11', parsed.access_token, ttl);
  return parsed.access_token;
}

function base64UrlText_(text) {
  return Utilities.base64EncodeWebSafe(String(text || ''), Utilities.Charset.UTF_8).replace(/=+$/g, '');
}

function getActivePushTargetsForStudent_(studentIdNumber) {
  const normalizedId = normalizeStudentId_(studentIdNumber);
  if (!isValidStudentId_(normalizedId)) return [];
  return readObjects_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS)
    .filter(row => normalizeStudentId_(row.studentIdNumber) === normalizedId && isTruthy_(row.enabled) && String(row.target || '').trim())
    .sort((a, b) => new Date(b.lastSeenAt || b.updatedAt || 0) - new Date(a.lastSeenAt || a.updatedAt || 0));
}

function disablePushTargetsForStudent_(studentIdNumber) {
  const normalizedId = normalizeStudentId_(studentIdNumber);
  if (!isValidStudentId_(normalizedId)) return 0;
  const rows = readObjects_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS);
  let disabled = 0;
  rows.forEach(row => {
    if (normalizeStudentId_(row.studentIdNumber) !== normalizedId || !isTruthy_(row.enabled)) return;
    row.enabled = false;
    row.updatedAt = new Date().toISOString();
    updateObject_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS, row._row, row);
    disabled += 1;
  });
  return disabled;
}

function pushMessageForStudent_(student, type) {
  student = normalizeRegistrationRecord_(student);
  const slot = TIME_SLOTS.find(item => item.id === student.slotId);
  const exactLabel = student.rotationStart && student.rotationEnd
    ? formatRotationLabel_(student.rotationStart, student.rotationEnd)
    : (slot ? slot.label : '');
  const queue = String(student.queueNumber || 'your queue').trim();
  if (type === 'call') {
    return {
      title: 'Wadhwani · You are being called',
      body: 'Attention user ' + queue + '. This is a reminder to proceed with your registration. Please proceed to the CARES Office for assistance. Thank you.',
      tag: 'wadhwani-call-' + String(student.id || student.studentIdNumber),
      url: './?push=call',
      ttl: '300'
    };
  }
  return {
    title: 'Wadhwani · Schedule in 10 minutes',
    body: 'Attention user ' + queue + '. Your registration schedule starts in about 10 minutes' + (exactLabel ? ' (' + exactLabel + ')' : '') + '. Please prepare and proceed to the CARES Office for assistance. Thank you.',
    tag: 'wadhwani-schedule-' + String(student.date || '') + '-' + String(student.slotId || '') + '-' + String(student.rotationId || ''),
    url: './?push=schedule',
    ttl: '900'
  };
}

function sendPushToStudent_(student, type, preloadedTargets) {
  student = normalizeRegistrationRecord_(student);
  const targets = Array.isArray(preloadedTargets) ? preloadedTargets : getActivePushTargetsForStudent_(student.studentIdNumber);
  const result = { configured: isFcmServerConfigured_(), attempted: targets.length, sent: 0, failed: 0 };
  if (!targets.length || !result.configured) return result;

  const projectId = String(PropertiesService.getScriptProperties().getProperty('FCM_PROJECT_ID') || '').trim();
  const accessToken = getFcmAccessToken_();
  const message = pushMessageForStudent_(student, type);
  const endpoint = 'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(projectId) + '/messages:send';

  targets.forEach(row => {
    const target = String(row.target || '').trim();
    const payload = {
      message: {
        token: target,
        data: {
          type: String(type || 'reminder'),
          title: message.title,
          body: message.body,
          tag: message.tag,
          url: message.url,
          queueNumber: String(student.queueNumber || ''),
          studentIdNumber: normalizeStudentId_(student.studentIdNumber)
        },
        webpush: {
          headers: {
            Urgency: 'high',
            TTL: message.ttl
          }
        }
      }
    };

    try {
      const response = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + accessToken },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      const body = String(response.getContentText() || '');
      if (code >= 200 && code < 300) {
        result.sent += 1;
      } else {
        result.failed += 1;
        if (/UNREGISTERED|registration-token-not-registered|NOT_FOUND/i.test(body)) {
          row.enabled = false;
          row.updatedAt = new Date().toISOString();
          updateObject_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS, row._row, row);
        }
        console.warn('FCM send failed (' + code + '): ' + body.slice(0, 500));
      }
    } catch (error) {
      result.failed += 1;
      console.warn('FCM send exception: ' + error.message);
    }
  });
  return result;
}

function ensureBackgroundReminderTrigger_() {
  const handler = 'processScheduledPushReminders';
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === handler) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(1).create();
  return handler + ' · every 1 minute';
}

/**
 * Claims one reminder key under the normal database write lock, then releases
 * the lock before any network request. This keeps registration writes fast and
 * prevents overlapping minute triggers from sending the same reminder twice.
 */
function claimScheduledReminder_(reminderKey, student) {
  const lock = acquireWriteLock_();
  try {
    const existing = findExactObject_(APP_SETTINGS.SHEETS.PUSH_LOG, 'reminderKey', reminderKey, true);
    if (existing && ['pending', 'sent'].includes(String(existing.status || '').toLowerCase())) return null;
    const now = new Date().toISOString();
    const object = {
      id: existing ? existing.id : Utilities.getUuid(),
      reminderKey: reminderKey,
      studentIdNumber: normalizeStudentId_(student.studentIdNumber),
      type: 'schedule',
      target: '',
      status: 'pending',
      detail: '',
      sentAt: now
    };
    if (existing) {
      updateObject_(APP_SETTINGS.SHEETS.PUSH_LOG, existing._row, object);
      object._row = existing._row;
    } else {
      object._row = appendObject_(APP_SETTINGS.SHEETS.PUSH_LOG, object);
    }
    return object;
  } finally {
    lock.releaseLock();
  }
}

/** Trigger target installed by setupSystem(). */
function processScheduledPushReminders() {
  ensureReady_();
  if (!isFcmServerConfigured_()) return { ok: true, configured: false, due: 0, sent: 0 };

  const now = new Date();
  const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
  const pushTargetsByStudent = new Map();
  readObjects_(APP_SETTINGS.SHEETS.PUSH_SUBSCRIPTIONS).forEach(row => {
    const studentId = normalizeStudentId_(row.studentIdNumber);
    if (!isValidStudentId_(studentId) || !isTruthy_(row.enabled) || !String(row.target || '').trim()) return;
    if (!pushTargetsByStudent.has(studentId)) pushTargetsByStudent.set(studentId, []);
    pushTargetsByStudent.get(studentId).push(row);
  });

  let due = 0;
  let sent = 0;
  registrations.forEach(student => {
    if (['completed', 'ongoing', 'called', 'no_show', 'cancelled'].includes(normalizeStatus_(student.status))) return;
    const slot = TIME_SLOTS.find(item => item.id === normalizeSlotId_(student.slotId));
    if (!slot || !student.date) return;
    const start = studentScheduleStart_(student);
    const millisecondsUntil = start.getTime() - now.getTime();
    if (millisecondsUntil <= 0 || millisecondsUntil > 10 * 60 * 1000) return;

    const studentId = normalizeStudentId_(student.studentIdNumber);
    const pushTargets = pushTargetsByStudent.get(studentId) || [];
    if (!pushTargets.length) return;
    const reminderKey = 'schedule|' + studentId + '|' + student.date + '|' + student.slotId + '|' + student.rotationId;
    const claim = claimScheduledReminder_(reminderKey, student);
    if (!claim) return;
    due += 1;

    let pushResult = null;
    let failure = '';
    try {
      pushResult = sendPushToStudent_(student, 'schedule', pushTargets);
      if (!pushResult || pushResult.sent < 1) failure = 'No registered device accepted the push.';
    } catch (error) {
      failure = error.message;
      console.warn('Scheduled push failed for ' + studentId + ': ' + error.message);
    }

    const logUpdate = {
      id: claim.id,
      reminderKey: reminderKey,
      studentIdNumber: studentId,
      type: 'schedule',
      target: pushResult ? String(pushResult.sent || 0) + ' device(s)' : '',
      status: failure ? 'failed' : 'sent',
      detail: failure || JSON.stringify(pushResult),
      sentAt: new Date().toISOString()
    };
    updateObject_(APP_SETTINGS.SHEETS.PUSH_LOG, claim._row, logUpdate);
    if (!failure) sent += Number(pushResult.sent || 0);
  });

  return { ok: true, configured: true, due: due, sent: sent };
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
    migrateRegistrationEmailHeader_(sheetName, sheet);
    migrateAuthenticationHeaders_(sheetName, sheet);
    migrateRotationHeaders_(sheetName, sheet);
    ensureHeaders_(sheet, headers);
    retireLegacyLaptopAssignments_(sheetName, sheet);
    formatStudentIdColumn_(sheetName, sheet);
    formatRegistrationScheduleColumns_(sheetName, sheet);
  });
}

/** Removes the exact-laptop assignment introduced by the short-lived schema 12 build. */
function retireLegacyLaptopAssignments_(sheetName, sheet) {
  if (!sheet || sheetName !== APP_SETTINGS.SHEETS.REGISTRATIONS || sheet.getLastRow() === 0) return;
  const width = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(value => String(value || '').trim());
  const column = headers.indexOf('laptopNumber') + 1;
  if (column < 1) return;
  sheet.getRange(1, column).setValue('legacyLaptopNumber');
  if (sheet.getLastRow() > 1) sheet.getRange(2, column, sheet.getLastRow() - 1, 1).clearContent();
  sheet.getRange(1, column).setNote('Retired in schema 14. Clients are no longer assigned to an exact laptop.');
}

/** Appends the rotation fields without shifting any existing registration data. */
function migrateRotationHeaders_(sheetName, sheet) {
  if (!sheet || sheetName !== APP_SETTINGS.SHEETS.REGISTRATIONS || sheet.getLastRow() === 0) return;
  const existingWidth = Math.max(1, sheet.getLastColumn());
  const current = sheet.getRange(1, 1, 1, existingWidth).getDisplayValues()[0]
    .map(value => String(value || '').trim());
  const legacyHeaders = HEADERS.Registrations.slice(0, 23);
  const hasLegacyLayout = legacyHeaders.every((header, index) => current[index] === header);
  if (!hasLegacyLayout) return;

  const rotationHeaders = HEADERS.Registrations.slice(23);
  rotationHeaders.forEach((header, index) => {
    const column = 24 + index;
    if (!String(current[column - 1] || '').trim()) sheet.getRange(1, column).setValue(header);
  });
  styleHeader_(sheet, HEADERS.Registrations.length);
}

/**
 * Safely upgrades the former student-email schema without deleting data.
 * Old email values remain in the registration email column; the new Student ID column is blank
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
      sheet.getRange(1, 3).setValue('email');
      styleHeader_(sheet, HEADERS[sheetName].length);
    } else if (headers[1] === 'studentIdNumber' && headers[2] === 'firstName') {
      sheet.insertColumnAfter(2);
      sheet.getRange(1, 3).setValue('email');
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

/** Gives the registration email field its current public column name without moving or deleting data. */
function migrateRegistrationEmailHeader_(sheetName, sheet) {
  if (!sheet || sheetName !== APP_SETTINGS.SHEETS.REGISTRATIONS || sheet.getLastRow() === 0) return;
  const current = String(sheet.getRange(1, 3).getDisplayValue() || '').trim();
  if (current === 'legacyEmail') sheet.getRange(1, 3).setValue('email');
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
  ['date', 'slotId', 'rotationId', 'rotationStart', 'rotationEnd'].forEach(header => {
    const column = headers.indexOf(header) + 1;
    if (column < 1) return;
    sheet.getRange(2, column, dataRowCount, 1).setNumberFormat('@');
  });
  sheet.getRange(1, headers.indexOf('date') + 1).setNote('Schedule date stored as YYYY-MM-DD.');
  sheet.getRange(1, headers.indexOf('slotId') + 1).setNote('Hourly batch ID such as 08-09 or 13-14.');
  sheet.getRange(1, headers.indexOf('rotationId') + 1).setNote('Exact 10-minute rotation ID assigned by the server.');
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
  if (sheetName === APP_SETTINGS.SHEETS.REGISTRATIONS && ['slotId', 'rotationStart', 'rotationEnd'].includes(header)) {
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
  copy.email = normalizeEmail_(copy.email || copy.legacyEmail);
  delete copy.legacyEmail;
  copy.studentIdNumber = normalizeStudentId_(copy.studentIdNumber);
  copy.maskedStudentId = maskStudentId_(copy.studentIdNumber);
  return copy;
}

function facilitatorStudentView_(student) {
  const copy = stripInternal_(normalizeRegistrationRecord_(student));
  copy.email = normalizeEmail_(copy.email || copy.legacyEmail);
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
  const hasLaptopCount = rows.some(row => String(row.key || '').trim() === 'laptopCount');
  const hasSessionMinutes = rows.some(row => String(row.key || '').trim() === 'sessionMinutes');
  const openDatesRow = rows.find(row => String(row.key || '').trim() === 'openEventDates');
  const hasOpenDates = Boolean(openDatesRow);
  const removedDates = new Set((APP_SETTINGS.REMOVED_EVENT_DATES || []).map(normalizeDateKey_).filter(Boolean));
  const fallbackOpenDates = APP_SETTINGS.OFFICIAL_EVENT_DATES
    .map(normalizeDateKey_)
    .filter(Boolean)
    .filter(date => !(APP_SETTINGS.CLOSED_EVENT_DATES || []).map(normalizeDateKey_).includes(date));
  if (!hasCapacity) appendObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, {
    key: 'capacity', value: String(APP_SETTINGS.LAPTOP_COUNT * Math.floor(60 / APP_SETTINGS.SESSION_MINUTES)), updatedAt: new Date().toISOString(), updatedBy: 'setupSystem'
  });
  if (!hasLaptopCount) appendObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, {
    key: 'laptopCount', value: String(APP_SETTINGS.LAPTOP_COUNT), updatedAt: new Date().toISOString(), updatedBy: 'setupSystem'
  });
  if (!hasSessionMinutes) appendObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, {
    key: 'sessionMinutes', value: String(APP_SETTINGS.SESSION_MINUTES), updatedAt: new Date().toISOString(), updatedBy: 'setupSystem'
  });
  if (!hasOpenDates) appendObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, {
    key: 'openEventDates', value: JSON.stringify(fallbackOpenDates), updatedAt: new Date().toISOString(), updatedBy: 'setupSystem'
  });
  else {
    let savedDates = [];
    try {
      const parsed = JSON.parse(String(openDatesRow.value || '[]'));
      savedDates = Array.isArray(parsed) ? parsed.map(normalizeDateKey_).filter(Boolean) : [];
    } catch (_) {}
    const cleanedDates = Array.from(new Set(savedDates.filter(date => !removedDates.has(date)))).sort();
    if (JSON.stringify(savedDates.slice().sort()) !== JSON.stringify(cleanedDates)) {
      updateObject_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS, openDatesRow._row, {
        key: 'openEventDates',
        value: JSON.stringify(cleanedDates),
        updatedAt: new Date().toISOString(),
        updatedBy: 'setupSystem-date-cleanup'
      });
    }
  }
}

function readAppointmentSettings_() {
  const rows = readObjects_(APP_SETTINGS.SHEETS.APPOINTMENT_SETTINGS);
  const map = Object.create(null);
  rows.forEach(row => { map[String(row.key || '').trim()] = row; });
  const parsedLaptopCount = Math.floor(Number(map.laptopCount && map.laptopCount.value));
  const laptopCount = Number.isFinite(parsedLaptopCount) && parsedLaptopCount >= 1 && parsedLaptopCount <= 50
    ? parsedLaptopCount
    : APP_SETTINGS.LAPTOP_COUNT;
  const parsedSessionMinutes = Math.floor(Number(map.sessionMinutes && map.sessionMinutes.value));
  const sessionMinutes = [5, 10, 15, 20, 30, 60].includes(parsedSessionMinutes)
    ? parsedSessionMinutes
    : APP_SETTINGS.SESSION_MINUTES;
  const capacity = laptopCount * Math.floor(60 / sessionMinutes);

  let openEventDates = [];
  let hasConfiguredOpenDates = false;
  try {
    const raw = map.openEventDates ? JSON.parse(String(map.openEventDates.value || '[]')) : [];
    if (Array.isArray(raw)) {
      hasConfiguredOpenDates = Boolean(map.openEventDates);
      openEventDates = raw.map(normalizeDateKey_).filter(Boolean);
    }
  } catch (_) {}
  if (!hasConfiguredOpenDates) {
    openEventDates = APP_SETTINGS.OFFICIAL_EVENT_DATES
      .map(normalizeDateKey_)
      .filter(Boolean)
      .filter(date => !(APP_SETTINGS.CLOSED_EVENT_DATES || []).map(normalizeDateKey_).includes(date));
  }
  const removedDates = new Set((APP_SETTINGS.REMOVED_EVENT_DATES || []).map(normalizeDateKey_).filter(Boolean));
  openEventDates = Array.from(new Set(openEventDates.filter(date => !removedDates.has(date)))).sort();
  return {
    laptopCount: laptopCount,
    sessionMinutes: sessionMinutes,
    rotationsPerHour: Math.floor(60 / sessionMinutes),
    capacity: capacity,
    openEventDates: openEventDates
  };
}

function getCapacity_() {
  return readAppointmentSettings_().capacity;
}

function assertResourceSettingsCompatible_(laptopCount, sessionMinutes) {
  const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
  const now = new Date();
  const future = registrations.filter(row => {
    if (!row.id || row.status === 'cancelled' || !row.date || !row.slotId) return false;
    const slot = TIME_SLOTS.find(item => item.id === row.slotId);
    return Boolean(slot && slotEnd_(row.date, slot) > now);
  });
  const invalidRotations = future.filter(row => {
    const slot = TIME_SLOTS.find(item => item.id === row.slotId);
    const definitions = buildRotationDefinitions_(slot, sessionMinutes);
    return !definitions.some(item => item.id === row.rotationId);
  });
  const rotationCounts = new Map();
  future.forEach(row => {
    const slot = TIME_SLOTS.find(item => item.id === row.slotId);
    const definitions = buildRotationDefinitions_(slot, sessionMinutes);
    if (!definitions.some(item => item.id === row.rotationId)) return;
    const key = rotationCapacityKey_(row.date, row.slotId, row.rotationId);
    rotationCounts.set(key, Number(rotationCounts.get(key) || 0) + 1);
  });
  const overcrowdedRotations = Array.from(rotationCounts.values()).filter(count => count > laptopCount).length;
  if (invalidRotations.length || overcrowdedRotations) {
    const problems = [];
    if (invalidRotations.length) problems.push(invalidRotations.length + ' future registration(s) would lose their current rotation');
    if (overcrowdedRotations) problems.push(overcrowdedRotations + ' future rotation(s) would exceed the new concurrent-client capacity');
    throw new Error('These resource settings cannot be saved: ' + problems.join(' and ') + '. Complete or reschedule the affected clients first.');
  }
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
  const removedDates = new Set((APP_SETTINGS.REMOVED_EVENT_DATES || []).map(normalizeDateKey_).filter(Boolean));
  settings.openEventDates.forEach(date => dates.push(date));
  (Array.isArray(registrations) ? registrations : []).forEach(row => {
    const date = normalizeDateKey_(row.date);
    if (date) dates.push(date);
  });
  if (APP_SETTINGS.ENABLE_TODAY_TEST_DATE) dates.push(todayKey_());
  return Array.from(new Set(dates.map(normalizeDateKey_).filter(Boolean)))
    .filter(date => !removedDates.has(date))
    .sort();
}

function clockToMinutes_(clock) {
  const match = String(clock || '').match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

function minutesToClock_(minutes) {
  const safe = Math.max(0, Math.min(24 * 60, Number(minutes || 0)));
  return String(Math.floor(safe / 60)).padStart(2, '0') + ':' + String(safe % 60).padStart(2, '0');
}

function formatClockLabel_(clock) {
  const total = clockToMinutes_(clock);
  if (!Number.isFinite(total)) return String(clock || '');
  const hour24 = Math.floor(total / 60) % 24;
  const minute = total % 60;
  const hour12 = hour24 % 12 || 12;
  return hour12 + ':' + String(minute).padStart(2, '0') + ' ' + (hour24 >= 12 ? 'PM' : 'AM');
}

function formatRotationLabel_(start, end) {
  const startLabel = formatClockLabel_(start);
  const endLabel = formatClockLabel_(end);
  const startSuffix = startLabel.slice(-2);
  const endSuffix = endLabel.slice(-2);
  return startSuffix === endSuffix
    ? startLabel.slice(0, -3) + '–' + endLabel
    : startLabel + '–' + endLabel;
}

function buildRotationDefinitions_(slot, sessionMinutes) {
  const start = clockToMinutes_(slot && slot.start);
  const end = clockToMinutes_(slot && slot.end);
  const duration = Math.floor(Number(sessionMinutes));
  if (!Number.isFinite(start) || !Number.isFinite(end) || !duration || duration < 1) return [];
  const rotations = [];
  for (let minute = start; minute + duration <= end; minute += duration) {
    const rotationStart = minutesToClock_(minute);
    const rotationEnd = minutesToClock_(minute + duration);
    rotations.push({
      id: rotationStart.replace(':', '') + '-' + rotationEnd.replace(':', ''),
      start: rotationStart,
      end: rotationEnd,
      label: formatRotationLabel_(rotationStart, rotationEnd)
    });
  }
  return rotations;
}

function rotationStart_(dateKey, rotation) {
  return new Date(String(dateKey) + 'T' + String(rotation && rotation.start || '00:00') + ':00+08:00');
}

function rotationEnd_(dateKey, rotation) {
  return new Date(String(dateKey) + 'T' + String(rotation && rotation.end || '00:00') + ':00+08:00');
}

function rotationMatches_(row, dateKey, slotId, rotationId) {
  const clean = normalizeRegistrationRecord_(row);
  return scheduleMatches_(clean, dateKey, slotId) && clean.rotationId === String(rotationId || '').trim();
}

function rotationCapacityKey_(dateKey, slotId, rotationId) {
  return [normalizeDateKey_(dateKey), normalizeSlotId_(slotId), String(rotationId || '').trim()].join('|');
}

function findAvailableRotationAssignment_(registrations, dateKey, slotId, excludeStudentId, options) {
  const settings = options && options.settings ? options.settings : readAppointmentSettings_();
  const slot = TIME_SLOTS.find(item => item.id === normalizeSlotId_(slotId));
  if (!slot) return null;
  const now = options && Object.prototype.hasOwnProperty.call(options, 'now') ? options.now : new Date();
  const counts = new Map();
  (registrations || []).map(normalizeRegistrationRecord_).forEach(row => {
    if (String(row.id) === String(excludeStudentId || '') || row.status === 'cancelled') return;
    if (!scheduleMatches_(row, dateKey, slot.id) || !row.rotationId) return;
    const key = rotationCapacityKey_(row.date, row.slotId, row.rotationId);
    counts.set(key, Number(counts.get(key) || 0) + 1);
  });

  const definitions = buildRotationDefinitions_(slot, settings.sessionMinutes);
  for (let index = 0; index < definitions.length; index += 1) {
    const rotation = definitions[index];
    if (now && rotationStart_(dateKey, rotation) <= now) continue;
    const key = rotationCapacityKey_(dateKey, slot.id, rotation.id);
    if (Number(counts.get(key) || 0) < settings.laptopCount) {
      return {
        rotationId: rotation.id,
        rotationStart: rotation.start,
        rotationEnd: rotation.end
      };
    }
  }
  return null;
}

function buildRotationAvailability_(registrations, dateKey, slot, settings, now, dateClosed) {
  return buildRotationDefinitions_(slot, settings.sessionMinutes).map(rotation => {
    const count = (registrations || []).map(normalizeRegistrationRecord_).filter(row =>
      row.status !== 'cancelled' && rotationMatches_(row, dateKey, slot.id, rotation.id)
    ).length;
    const started = rotationStart_(dateKey, rotation) <= now;
    const ended = rotationEnd_(dateKey, rotation) <= now;
    const remaining = (dateClosed || started) ? 0 : Math.max(0, settings.laptopCount - count);
    return {
      id: rotation.id,
      start: rotation.start,
      end: rotation.end,
      label: rotation.label,
      count: count,
      remaining: remaining,
      started: started,
      ended: ended,
      full: dateClosed || count >= settings.laptopCount,
      available: !dateClosed && !started && count < settings.laptopCount
    };
  });
}

/**
 * Preserves valid exact rotations and fills missing legacy rotations. Each
 * rotation may contain up to the configured number of concurrent clients;
 * no exact laptop is assigned.
 */
function migrateRegistrationRotationData_() {
  const registrations = readObjects_(APP_SETTINGS.SHEETS.REGISTRATIONS).map(normalizeRegistrationRecord_);
  const settings = readAppointmentSettings_();
  const counts = new Map();
  const preservedRows = new Set();
  let assigned = 0;
  let preserved = 0;
  let overflow = 0;

  const ordered = registrations.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.slotId).localeCompare(String(b.slotId)) || Number(a.sequence || 0) - Number(b.sequence || 0) || String(a.registeredAt || '').localeCompare(String(b.registeredAt || '')));

  // First preserve valid rotations up to their concurrent client capacity.
  ordered.forEach(row => {
    const slot = TIME_SLOTS.find(item => item.id === row.slotId);
    if (!row.id || !row.date || !slot) return;
    const definitions = buildRotationDefinitions_(slot, settings.sessionMinutes);
    const currentIsValid = definitions.some(item => item.id === row.rotationId);
    const currentKey = rotationCapacityKey_(row.date, row.slotId, row.rotationId);
    const reservesPosition = row.status !== 'cancelled';
    if (currentIsValid && (!reservesPosition || Number(counts.get(currentKey) || 0) < settings.laptopCount)) {
      preservedRows.add(String(row._row || row.id));
      if (reservesPosition) counts.set(currentKey, Number(counts.get(currentKey) || 0) + 1);
      preserved += 1;
    }
  });

  ordered.forEach(row => {
      const slot = TIME_SLOTS.find(item => item.id === row.slotId);
      if (!row.id || !row.date || !slot) return;
      if (preservedRows.has(String(row._row || row.id))) return;
      const definitions = buildRotationDefinitions_(slot, settings.sessionMinutes);

      let next = null;
      for (let rotationIndex = 0; rotationIndex < definitions.length && !next; rotationIndex += 1) {
        const rotation = definitions[rotationIndex];
        const key = rotationCapacityKey_(row.date, row.slotId, rotation.id);
        if (Number(counts.get(key) || 0) < settings.laptopCount) {
          next = { rotation: rotation, key: key };
        }
      }

      if (!next && row.status === 'cancelled' && definitions.length) {
        next = { rotation: definitions[0], key: rotationCapacityKey_(row.date, row.slotId, definitions[0].id) };
      }
      if (!next) {
        overflow += 1;
        return;
      }
      row.rotationId = next.rotation.id;
      row.rotationStart = next.rotation.start;
      row.rotationEnd = next.rotation.end;
      updateObject_(APP_SETTINGS.SHEETS.REGISTRATIONS, row._row, row);
      if (row.status !== 'cancelled') counts.set(next.key, Number(counts.get(next.key) || 0) + 1);
      assigned += 1;
  });

  if (assigned) SpreadsheetApp.flush();
  return { ok: overflow === 0, assigned: assigned, preserved: preserved, overflow: overflow };
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
      const rotations = buildRotationAvailability_(registrations, dateKey, slot, appointmentSettings, now, dateClosed);
      const count = countInSlot_(registrations, dateKey, slot.id);
      const started = slotStart_(dateKey, slot) <= now;
      const ended = slotEnd_(dateKey, slot) <= now;
      const remaining = dateClosed ? 0 : rotations.reduce((sum, rotation) => sum + rotation.remaining, 0);
      const full = dateClosed || remaining < 1;
      return {
        id: slot.id,
        count: count,
        remaining: remaining,
        started: started,
        ended: ended,
        passed: started,
        closed: dateClosed,
        full: full,
        available: !dateClosed && remaining > 0,
        rotations: rotations
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
    laptopCount: appointmentSettings.laptopCount,
    sessionMinutes: appointmentSettings.sessionMinutes,
    rotationsPerHour: appointmentSettings.rotationsPerHour,
    openEventDates: appointmentSettings.openEventDates.slice(),
    eventDates: eventDates,
    closedEventDates: Array.from(closedDates),
    timeSlots: TIME_SLOTS.map(slot => Object.assign({}, slot)),
    colleges: JSON.parse(JSON.stringify(COLLEGES)),
    availability: availability,
    backgroundPushServerConfigured: isFcmServerConfigured_(),
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
    .filter(row => scheduleMatches_(row, normalizedStudent.date, normalizedStudent.slotId) &&
      row.rotationId === normalizedStudent.rotationId && row.status !== 'cancelled')
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    .slice(0, 200)
    .map(row => batchMemberView_(row, normalizedStudent.id));
}

function validateCandidate_(candidate) {
  const clean = {
    studentIdNumber: normalizeStudentId_(candidate && candidate.studentIdNumber),
    email: normalizeEmail_(candidate && candidate.email),
    firstName: properCase_(candidate && candidate.firstName),
    middleName: properCase_(candidate && candidate.middleName),
    lastName: properCase_(candidate && candidate.lastName),
    college: String(candidate && candidate.college || '').trim(),
    course: String(candidate && candidate.course || '').trim()
  };

  if (!isValidStudentId_(clean.studentIdNumber)) throw new Error('Enter a valid Student ID in the format 001-2023-001929.');
  if (!clean.email || !clean.firstName || !clean.lastName || !clean.college || !clean.course) throw new Error('Complete all required student fields.');
  if (!isValidEmail_(clean.email)) throw new Error('Enter a valid email address.');
  if (!Object.prototype.hasOwnProperty.call(COLLEGES, clean.college)) throw new Error('Select a valid college.');
  return clean;
}

function assertSlotAvailable_(registrations, dateKey, slotId, excludeStudentId) {
  const cleanDateKey = normalizeDateKey_(dateKey);
  const cleanSlotId = normalizeSlotId_(slotId);
  const appointmentSettings = readAppointmentSettings_();
  const eventDates = appointmentSettings.openEventDates.slice();
  const slot = TIME_SLOTS.find(item => item.id === cleanSlotId);
  if (!eventDates.includes(cleanDateKey) || !slot) throw new Error('Select a valid event date and time.');
  if (slotEnd_(cleanDateKey, slot) <= new Date()) throw new Error('That schedule has already passed. Choose another time.');
  const assignment = findAvailableRotationAssignment_(registrations, cleanDateKey, cleanSlotId, excludeStudentId, {
    settings: appointmentSettings,
    now: new Date()
  });
  if (!assignment) throw new Error('Every 10-minute rotation in that hour is already full. Choose another time.');
  return assignment;
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

function findDuplicateRegistrationByName_(registrations, candidate, excludeStudentId) {
  const targetName = normalizeName_(candidate);
  const excludedId = normalizeStudentId_(excludeStudentId);
  if (!targetName || targetName === '||') return null;
  return (registrations || []).find(row => {
    const normalized = normalizeRegistrationRecord_(row);
    if (normalized.status === 'cancelled') return false;
    if (excludedId && normalized.studentIdNumber === excludedId) return false;
    return normalizeName_(normalized) === targetName;
  }) || null;
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
    rotationId: row.rotationId,
    rotationStart: row.rotationStart,
    rotationEnd: row.rotationEnd,
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
    firstName: String(row.firstName || ''),
    middleName: String(row.middleName || ''),
    lastName: String(row.lastName || ''),
    college: String(row.college || ''),
    course: String(row.course || ''),
    sequence: Number(row.sequence || 0),
    queueNumber: row.queueNumber,
    status: row.status,
    slotId: row.slotId,
    rotationId: row.rotationId,
    rotationStart: row.rotationStart,
    rotationEnd: row.rotationEnd,
    owner: String(row.id) === String(ownerId),
    displayName: displayNameWithMiddleInitial_(row),
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
  if (slotEnd_(cleanDateKey, slot) <= new Date()) throw new Error('That schedule has already passed. Choose another time.');
}

function assertSlotStatAvailable_(stat, dateKey, slotId) {
  assertScheduleSelection_(dateKey, slotId);
  if (Number(stat && stat.count || 0) >= getCapacity_()) {
    throw new Error('Every 10-minute rotation in that hour is already full. Choose another time.');
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
  row.email = normalizeEmail_(row.email || row.legacyEmail);
  row.date = normalizeDateKey_(row.date);
  row.slotId = normalizeSlotId_(row.slotId);
  row.rotationId = String(row.rotationId || '').trim();
  row.rotationStart = normalizeClock_(row.rotationStart);
  row.rotationEnd = normalizeClock_(row.rotationEnd);
  row.sequence = Number(row.sequence || 0);
  row.queueNumber = String(row.queueNumber || '').trim();
  row.status = normalizeStatus_(row.status);
  return row;
}

function normalizeClock_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, APP_SETTINGS.TIME_ZONE, 'HH:mm');
  }
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  return match ? String(Number(match[1])).padStart(2, '0') + ':' + match[2] : '';
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
  const rotationMigration = migrateRegistrationRotationData_();
  const rebuilt = rebuildOperationalIndexes();
  return {
    ok: true,
    repairedRows: normalizedValues.length,
    assignedRotations: rotationMigration.assigned,
    rotationOverflow: rotationMigration.overflow,
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

function studentScheduleStart_(student) {
  const row = normalizeRegistrationRecord_(student);
  const slot = TIME_SLOTS.find(item => item.id === row.slotId);
  const clock = row.rotationStart || (slot && slot.start) || '00:00';
  return new Date(String(row.date) + 'T' + clock + ':00+08:00');
}

function studentScheduleEnd_(student) {
  const row = normalizeRegistrationRecord_(student);
  const slot = TIME_SLOTS.find(item => item.id === row.slotId);
  const clock = row.rotationEnd || (slot && slot.end) || '00:00';
  return new Date(String(row.date) + 'T' + clock + ':00+08:00');
}

function todayKey_() {
  return Utilities.formatDate(new Date(), APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail_(value) {
  const email = normalizeEmail_(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

function displayNameWithMiddleInitial_(person) {
  const middle = String(person && person.middleName || '').trim();
  const middleInitial = middle ? middle.charAt(0).toUpperCase() + '.' : '';
  return [person && person.firstName, middleInitial, person && person.lastName]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
}

function privacyName_(person) {
  return String(person.firstName || '') + ' ' + (person.lastName ? String(person.lastName).charAt(0) + '.' : '');
}

function isTruthy_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1' || String(value).toLowerCase() === 'yes';
}
