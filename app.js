import {
  ALLOW_GUEST_CHECKUPS,
  ALLOW_GUEST_EMPLOYEE_CREATION,
  APP_TIMEZONE,
  SUPABASE_ANON_KEY,
  SUPABASE_URL
} from "./config.js";
import {
  saveDirectoryCache,
  getDirectoryCache,
  enqueueOfflineItem,
  getPendingOfflineQueue,
  getAllOfflineQueueItems,
  getPendingOfflineCount,
  removeOfflineItem,
  evaluateReadiness
} from "./offline-storage.js";

const supabaseFactory = window.supabase?.createClient;
const loginScreen = document.querySelector("#login-screen");
const appShell = document.querySelector("#app-shell");
const toastElement = document.querySelector("#toast");
const departmentSelect = document.querySelector("#department-select");
const employeeSelect = document.querySelector("#employee-select");
const checkupForm = document.querySelector("#checkup-form");
const checkupProgress = document.querySelector("#checkup-progress");
const resultCard = document.querySelector("#result-card");
const employeeModal = document.querySelector("#employee-modal");
const exportConfirmModal = document.querySelector("#export-confirm-modal");
const historyList = document.querySelector("#history-list");
const offlineQueueBadge = document.querySelector("#offline-queue-badge");
const syncIcon = document.querySelector("#sync-icon");
const syncText = document.querySelector("#sync-text");
const queueCountBadge = document.querySelector("#queue-count");
const manualSyncButton = document.querySelector("#manual-sync-button");
const queueModal = document.querySelector("#queue-modal");
const closeQueueModalBtn = document.querySelector("#close-queue-modal");
const closeQueueBtn = document.querySelector("#close-queue-btn");
const triggerSyncBtn = document.querySelector("#trigger-sync-btn");
const queueList = document.querySelector("#queue-list");
const guestProfileStorageKey = "daily-checkup-guest-profile-v1";
const checkupDraftStoragePrefix = "daily-checkup-draft-v1";

let client;
let currentUser;
let currentProfile;
let currentEmployeeId;
let guestMode = false;
let guestEmployeeCreationEnabled = false;
let guestProfile = null;
let departments = [];
let employees = [];
let checkups = [];
let todayCheckupCount = null;
let todayReadinessCounts = null;
let activeEmployeeCount = null;
let activeStep = 1;
let toastTimeout;
let realtimeChannel;
let draftStorageErrorNotified = false;
let isSyncing = false;
let guestStatusRequest = 0;
let activeTimezone = (typeof APP_TIMEZONE === "string" && APP_TIMEZONE.trim())
  ? APP_TIMEZONE.trim()
  : "Asia/Jakarta";

function getActiveTimezone() {
  return activeTimezone;
}

async function syncAppTimezone() {
  if (!client) return;
  try {
    const { data, error } = await client.rpc("get_app_timezone");
    if (!error && data && typeof data === "string" && data.trim()) {
      const candidate = data.trim();
      new Intl.DateTimeFormat(undefined, { timeZone: candidate });
      activeTimezone = candidate;
    }
  } catch (err) {
    console.warn("Could not sync app timezone from database, using config default:", err);
  }
}

const statusDetails = {
  fit_to_work: { label: "Fit to Work", pill: "status-fit", result: "result-fit", icon: "shield-check" },
  need_observation: { label: "Need Observation", pill: "status-observe", result: "result-observe", icon: "eye" },
  rest_recommended: { label: "Rest Recommended", pill: "status-rest", result: "result-rest", icon: "heart-pulse" }
};

const symptomLabels = {
  fit: "Sehat / Fit",
  flu_cough: "Flu / Batuk",
  dizziness: "Pusing",
  muscle_pain: "Nyeri otot",
  breathing_difficulty: "Sesak napas",
  chest_pain: "Nyeri dada",
  fainting: "Pingsan / hampir pingsan"
};

function showToast(message, isError = false) {
  window.clearTimeout(toastTimeout);
  toastElement.textContent = message;
  toastElement.classList.toggle("error", isError);
  toastElement.classList.add("visible");
  toastTimeout = window.setTimeout(() => toastElement.classList.remove("visible"), 3500);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function refreshIcons() {
  window.lucide?.createIcons();
}

function isAdmin() {
  return ["admin", "hr"].includes(currentProfile?.role);
}

function normalizeWhatsApp(value) {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("0")) return `+62${digits.slice(1)}`;
  if (digits.startsWith("62")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function createDeviceToken() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getTimezoneOffsetMs(date, timeZone = getActiveTimezone()) {
  const utcParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  const tzParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  const utcMs = Date.UTC(
    Number(utcParts.year), Number(utcParts.month) - 1, Number(utcParts.day),
    Number(utcParts.hour), Number(utcParts.minute), Number(utcParts.second)
  );
  const tzMs = Date.UTC(
    Number(tzParts.year), Number(tzParts.month) - 1, Number(tzParts.day),
    Number(tzParts.hour), Number(tzParts.minute), Number(tzParts.second)
  );
  return tzMs - utcMs;
}

function getAppToday(timeZone = getActiveTimezone()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date()).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDateRangeForDate(dateStr, timeZone = getActiveTimezone()) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const utcTarget = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetMs = getTimezoneOffsetMs(utcTarget, timeZone);
  const start = new Date(utcTarget.getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function getDateRange(timeZone = getActiveTimezone()) {
  return getDateRangeForDate(getAppToday(timeZone), timeZone);
}

// Backward-compatibility aliases
const jakartaToday = getAppToday;
const jakartaDateRange = getDateRange;
const jakartaDateRangeForDate = getDateRangeForDate;

function checkupDraftScope() {
  const identity = guestMode ? guestProfile?.deviceToken : currentUser?.id;
  if (!identity) return null;
  return `${checkupDraftStoragePrefix}:${guestMode ? "guest" : "user"}:${identity}`;
}

function reportDraftStorageError(action, error) {
  console.error(`Could not ${action} local checkup draft:`, error);
  if (!draftStorageErrorNotified) {
    showToast("Draft checkup tidak dapat disimpan atau dibaca di browser ini. Periksa pengaturan penyimpanan.", true);
    draftStorageErrorNotified = true;
  }
}

function resetCheckupResponses() {
  document.querySelector("#systolic").value = "";
  document.querySelector("#diastolic").value = "";
  document.querySelector("#temperature").value = "36.5";
  document.querySelector("#notes").value = "";
  checkupForm.querySelectorAll('input[name="fatigue_level"], input[name="sleep_quality"], input[name="symptoms"]')
    .forEach((input) => { input.checked = false; });
  updateTemperatureDisplay();
  setActiveStep(1);
}

function persistCheckupSelection() {
  const scope = checkupDraftScope();
  if (!scope) return;
  try {
    localStorage.setItem(`${scope}:selection`, JSON.stringify({
      departmentId: departmentSelect.value,
      employeeId: employeeSelect.value
    }));
    draftStorageErrorNotified = false;
  } catch (error) {
    reportDraftStorageError("save", error);
  }
}

function restoreCheckupSelection() {
  if (!isAdmin()) return;
  const scope = checkupDraftScope();
  if (!scope) return;
  departmentSelect.value = "";
  updateEmployeeOptions();
  try {
    const stored = localStorage.getItem(`${scope}:selection`);
    if (!stored) return;
    const selection = JSON.parse(stored);
    const employee = employees.find((item) =>
      item.id === selection.employeeId
      && item.department_id === selection.departmentId
    );
    if (!employee) return;
    departmentSelect.value = employee.department_id;
    updateEmployeeOptions();
    employeeSelect.value = employee.id;
  } catch (error) {
    reportDraftStorageError("read", error);
  }
}

function saveCheckupDraft() {
  const scope = checkupDraftScope();
  const employeeId = employeeSelect.value;
  if (!scope || !employeeId) return;
  const symptoms = Object.fromEntries(
    [...checkupForm.querySelectorAll('input[name="symptoms"]')].map((input) => [input.value, input.checked])
  );
  const draft = {
    savedOn: getAppToday(),
    departmentId: departmentSelect.value,
    employeeId,
    systolic: document.querySelector("#systolic").value,
    diastolic: document.querySelector("#diastolic").value,
    temperature: document.querySelector("#temperature").value,
    fatigueLevel: checkupForm.querySelector('input[name="fatigue_level"]:checked')?.value ?? "",
    sleepQuality: checkupForm.querySelector('input[name="sleep_quality"]:checked')?.value ?? "",
    symptoms,
    notes: document.querySelector("#notes").value,
    step: activeStep
  };
  try {
    localStorage.setItem(`${scope}:employee:${employeeId}`, JSON.stringify(draft));
    draftStorageErrorNotified = false;
  } catch (error) {
    reportDraftStorageError("save", error);
  }
}

function isCheckupDraftField(target) {
  return ["systolic", "diastolic", "temperature", "notes"].includes(target?.id)
    || ["fatigue_level", "sleep_quality", "symptoms"].includes(target?.name);
}

function restoreCheckupDraft(employeeId) {
  resetCheckupResponses();
  const scope = checkupDraftScope();
  if (!scope || !employeeId) return false;
  const key = `${scope}:employee:${employeeId}`;
  let draft;
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return false;
    draft = JSON.parse(stored);
    if (draft.savedOn !== getAppToday()) {
      localStorage.removeItem(key);
      return false;
    }
    draftStorageErrorNotified = false;
  } catch (error) {
    reportDraftStorageError("read", error);
    return false;
  }
  if (
    draft.employeeId !== employeeId
    || draft.departmentId !== departmentSelect.value
  ) return false;

  document.querySelector("#systolic").value = draft.systolic ?? "";
  document.querySelector("#diastolic").value = draft.diastolic ?? "";
  const temperature = Number(draft.temperature);
  if (Number.isFinite(temperature) && temperature >= 34 && temperature <= 42) {
    document.querySelector("#temperature").value = String(temperature);
  }
  for (const [name, value] of [["fatigue_level", draft.fatigueLevel], ["sleep_quality", draft.sleepQuality]]) {
    if (["1", "2", "3", "4", "5"].includes(String(value))) {
      const input = checkupForm.querySelector(`input[name="${name}"][value="${value}"]`);
      if (input) input.checked = true;
    }
  }
  checkupForm.querySelectorAll('input[name="symptoms"]').forEach((input) => {
    input.checked = Boolean(draft.symptoms?.[input.value]);
  });
  document.querySelector("#notes").value = typeof draft.notes === "string" ? draft.notes : "";
  updateTemperatureDisplay();
  setActiveStep(Number.isInteger(draft.step) && draft.step >= 1 && draft.step <= 3 ? draft.step : 2);
  return true;
}

function clearCheckupDraft(employeeId) {
  const scope = checkupDraftScope();
  if (!scope || !employeeId) return;
  try {
    localStorage.removeItem(`${scope}:employee:${employeeId}`);
    draftStorageErrorNotified = false;
  } catch (error) {
    reportDraftStorageError("clear", error);
  }
}

function clearGuestCheckupDrafts() {
  const scope = checkupDraftScope();
  if (!scope) return;
  try {
    const prefix = `${scope}:employee:`;
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(prefix));
    keys.forEach((key) => localStorage.removeItem(key));
    localStorage.removeItem(`${scope}:selection`);
    draftStorageErrorNotified = false;
  } catch (error) {
    reportDraftStorageError("clear", error);
  }
}

function isValidWhatsApp(value) {
  return /^\+[1-9]\d{7,14}$/.test(normalizeWhatsApp(value));
}

function readGuestProfile() {
  try {
    const stored = localStorage.getItem(guestProfileStorageKey);
    if (!stored) return null;
    const profile = JSON.parse(stored);
    if (
      typeof profile?.departmentId !== "string"
      || typeof profile?.employeeId !== "string"
      || typeof profile?.whatsapp !== "string"
    ) {
      localStorage.removeItem(guestProfileStorageKey);
      return null;
    }
    return {
      ...profile,
      deviceToken: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profile.deviceToken)
        ? profile.deviceToken
        : createDeviceToken()
    };
  } catch (error) {
    console.error("Could not read guest profile from this browser:", error);
    showToast("Profil perangkat tidak dapat dibaca. Periksa pengaturan penyimpanan browser.", true);
    return null;
  }
}

function persistGuestProfile(profile, announce = false) {
  guestProfile = {
    departmentId: profile.departmentId,
    employeeId: profile.employeeId,
    whatsapp: normalizeWhatsApp(profile.whatsapp),
    deviceToken: profile.deviceToken ?? guestProfile?.deviceToken ?? createDeviceToken()
  };
  try {
    localStorage.setItem(guestProfileStorageKey, JSON.stringify(guestProfile));
    if (announce) showToast("Profil tersimpan di browser ini.");
    return true;
  } catch (error) {
    console.error("Could not save guest profile to this browser:", error);
    showToast("Profil gagal disimpan di browser. Periksa pengaturan penyimpanan.", true);
    return false;
  }
}

function populateDepartmentSelect(select, selectedId = "") {
  select.innerHTML = '<option value="">Pilih departemen</option>';
  for (const department of departments) {
    const option = document.createElement("option");
    option.value = department.id;
    option.textContent = department.name;
    select.append(option);
  }
  if (departments.some((department) => department.id === selectedId)) {
    select.value = selectedId;
  }
}

function updateProfileEmployeeOptions(selectedId = "") {
  const departmentId = document.querySelector("#profile-department").value;
  const select = document.querySelector("#profile-employee");
  const employeeToSelect = selectedId || select.value;
  const departmentEmployees = employees.filter((item) => item.department_id === departmentId && item.is_active);
  select.innerHTML = '<option value="">Pilih nama karyawan</option>';
  for (const employee of departmentEmployees) {
    const option = document.createElement("option");
    option.value = employee.id;
    option.textContent = employee.full_name;
    select.append(option);
  }
  if (!departmentId) {
    select.innerHTML = '<option value="">Pilih departemen terlebih dahulu</option>';
  } else if (!select.options.length || (select.options.length === 1 && !select.options[0].value)) {
    select.innerHTML = '<option value="">Belum ada karyawan terdaftar</option>';
  }
  select.disabled = !departmentId || departmentEmployees.length === 0;
  if (employees.some((item) => item.id === employeeToSelect && item.department_id === departmentId && item.is_active)) {
    select.value = employeeToSelect;
  }
}

function syncGuestProfileToCheckup() {
  if (!guestProfile) return;
  departmentSelect.value = guestProfile.departmentId;
  updateEmployeeOptions();
  employeeSelect.value = guestProfile.employeeId;
  document.querySelector("#checkup-whatsapp").value = guestProfile.whatsapp;
  renderCheckupIdentitySummary();
}

function renderCheckupIdentitySummary() {
  const summary = document.querySelector("#checkup-identity-summary");
  const isSavedSelection = guestProfile
    && departmentSelect.value === guestProfile.departmentId
    && employeeSelect.value === guestProfile.employeeId
    && normalizeWhatsApp(document.querySelector("#checkup-whatsapp").value) === guestProfile.whatsapp;
  if (!isSavedSelection) {
    summary.classList.add("hidden");
    summary.classList.remove("flex");
    return;
  }

  const employee = employees.find((item) => item.id === guestProfile.employeeId);
  const department = departments.find((item) => item.id === guestProfile.departmentId);
  if (!employee || !department) {
    summary.classList.add("hidden");
    summary.classList.remove("flex");
    return;
  }
  document.querySelector("#checkup-identity-name").textContent = employee.full_name;
  document.querySelector("#checkup-identity-department").textContent = department.name;
  summary.classList.remove("hidden");
  summary.classList.add("flex");
}

function hideDailyCheckupStatus() {
  checkupForm.classList.remove("hidden");
  checkupProgress.classList.remove("hidden");
  resultCard.classList.add("hidden");
  document.querySelector("#daily-checkup-completed-notice").classList.add("hidden");
}

function showDailyCheckupStatus(checkup) {
  checkupForm.classList.add("hidden");
  checkupProgress.classList.add("hidden");
  document.querySelector("#daily-checkup-status-loading").classList.add("hidden");
  const completedNotice = document.querySelector("#daily-checkup-completed-notice");
  completedNotice.classList.remove("hidden");
  const canSubmitMore = Boolean(checkup?.can_submit_more) && !checkup?.is_offline;
  const nextButton = document.querySelector("#daily-checkup-next");
  nextButton.classList.toggle("hidden", !canSubmitMore);
  nextButton.onclick = () => showCheckupForm(2);
  if (checkup?.is_offline) {
    const boldEl = completedNotice.querySelector("b");
    const spanEl = completedNotice.querySelector("span");
    if (boldEl) boldEl.textContent = "DCU hari ini tersimpan di antrean offline.";
    if (spanEl) spanEl.textContent = "Data akan otomatis disinkronkan ke server saat perangkat terhubung internet.";
  } else {
    const boldEl = completedNotice.querySelector("b");
    const spanEl = completedNotice.querySelector("span");
    if (boldEl) boldEl.textContent = canSubmitMore
      ? "DCU hari ini berhasil tersimpan."
      : "Tidak ada kuota DCU hari ini atau pola kerja belum diisi.";
    if (spanEl) spanEl.textContent = canSubmitMore
      ? "Anda masih dapat mengisi lagi sesuai jadwal dan batas harian."
      : "Lengkapi pola kerja dengan HR, atau isi kembali pada hari berikutnya jika kuota sudah tercapai.";
  }
  showResult(checkup, checkup.readiness_status, checkup.checked_at, Boolean(checkup?.is_offline));
  resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Add "Pilih karyawan lain" button for admin
  if (isAdmin()) {
    const existingBtn = document.querySelector('.admin-employee-switch-btn');
    if (existingBtn) existingBtn.remove();
    
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-button mt-4 w-full admin-employee-switch-btn';
    btn.innerHTML = '<i data-lucide="user-select" class="mr-2 icon-text-sm"></i>Pilih karyawan lain';
    btn.addEventListener('click', () => {
      hideDailyCheckupStatus();
      setActiveStep(1);
      departmentSelect.value = '';
      updateEmployeeOptions();
      employeeSelect.value = '';
      checkupForm.classList.remove("hidden");
      checkupProgress.classList.remove("hidden");
      resultCard.classList.add("hidden");
    });
    const copyBtn = document.querySelector("#copy-report");
    if (copyBtn) {
      copyBtn.parentNode.insertBefore(btn, copyBtn.nextSibling);
    } else {
      resultCard.querySelector(".panel-card").appendChild(btn);
    }
  }
}

function showCheckupForm(step = 2) {
  checkupForm.classList.remove("hidden");
  checkupProgress.classList.remove("hidden");
  document.querySelector("#daily-checkup-status-loading").classList.add("hidden");
  document.querySelector("#daily-checkup-completed-notice").classList.add("hidden");
  resultCard.classList.add("hidden");
  setActiveStep(step);
}

function showGuestCheckupEntry() {
  document.querySelector("#daily-checkup-completed-notice").classList.add("hidden");
  resultCard.classList.add("hidden");
}

async function loadGuestDailyStatus(employeeId = guestProfile?.employeeId, deviceToken = guestProfile?.deviceToken) {
  if (!employeeId || !deviceToken) return null;
  try {
    if (!navigator.onLine) throw new Error("Offline");
    const { data, error } = await client.rpc("get_guest_daily_checkup", {
      p_employee_id: employeeId,
      p_device_token: deviceToken
    });
    if (error) throw error;
    const checkup = Array.isArray(data) ? data[0] ?? null : data;
    if (!checkup) return null;
    const { data: canSubmitMore, error: statusError } = await client.rpc("can_submit_additional_dcu", {
      p_employee_id: employeeId,
      p_device_token: deviceToken
    });
    if (statusError) throw statusError;
    return {
      ...checkup,
      employee_id: employeeId,
      can_submit_more: Boolean(canSubmitMore)
    };
  } catch (error) {
    try {
      const queue = await getPendingOfflineQueue();
      const queued = queue.find((q) => q.action === "submit_checkup" && q.employee_id === employeeId);
      if (queued) {
        return {
          ...queued.payload,
          employee_id: employeeId,
          checked_at: queued.measured_at,
          readiness_status: queued.preliminary_status,
          is_offline: true
        };
      }
    } catch (_) {}
    if (!navigator.onLine || error.message?.includes("Failed to fetch") || error.name === "TypeError" || error.message === "Offline") {
      return null;
    }
    throw error;
  }
}

async function loadAuthenticatedDailyCheckup(employeeId) {
  const { start, end } = getDateRange();
  const { data, error } = await client
    .from("checkups")
    .select("id, employee_id, checked_at, systolic, diastolic, temperature_c, fatigue_level, sleep_quality, symptoms, notes, readiness_status")
    .eq("employee_id", employeeId)
    .gte("checked_at", start)
    .lt("checked_at", end)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: canSubmitMore, error: statusError } = await client.rpc("can_submit_additional_dcu", {
    p_employee_id: employeeId,
    p_device_token: null
  });
  if (statusError) throw statusError;
  return { ...data, can_submit_more: Boolean(canSubmitMore) };
}

function saveCheckupIdentityIfComplete() {
  if (!guestMode) return false;
  const whatsapp = document.querySelector("#checkup-whatsapp").value;
  if (departmentSelect.value && employeeSelect.value && isValidWhatsApp(whatsapp)) {
    const saved = persistGuestProfile({
      departmentId: departmentSelect.value,
      employeeId: employeeSelect.value,
      whatsapp
    });
    if (!saved) return false;
    syncGuestProfileForm();
    renderCheckupIdentitySummary();
    return true;
  }
  renderCheckupIdentitySummary();
  return false;
}

async function checkSelectedGuestDailyStatus() {
  if (!guestMode) return;
  const requestId = ++guestStatusRequest;
  const selectedEmployeeId = employeeSelect.value;
  const selectedDepartmentId = departmentSelect.value;
  const whatsapp = document.querySelector("#checkup-whatsapp").value;
  const employee = employees.find((item) =>
    item.id === selectedEmployeeId
    && item.department_id === selectedDepartmentId
    && item.is_active
  );

  showGuestCheckupEntry();
  if (!employee || !saveCheckupIdentityIfComplete()) {
    showCheckupForm(1);
    return;
  }
  checkupForm.classList.add("hidden");
  checkupProgress.classList.add("hidden");
  document.querySelector("#daily-checkup-status-loading").classList.remove("hidden");
  const deviceToken = guestProfile.deviceToken;

  try {
    const dailyCheckup = await loadGuestDailyStatus(selectedEmployeeId, deviceToken);
    if (
      requestId !== guestStatusRequest
      || selectedEmployeeId !== employeeSelect.value
      || selectedDepartmentId !== departmentSelect.value
    ) return;
    if (dailyCheckup) {
        showDailyCheckupStatus({
          ...dailyCheckup,
          checked_at: dailyCheckup.checked_at,
          readiness_status: dailyCheckup.readiness_status,
        });
        return;
      } else {
        showCheckupForm(1);
      }
  } catch (error) {
    if (requestId !== guestStatusRequest) return;
    console.error("Could not check the selected employee's daily status:", error);
    showToast(`Gagal memeriksa status checkup hari ini: ${error.message}`, true);
    const restored = restoreCheckupDraft(selectedEmployeeId);
    showCheckupForm(restored ? activeStep : 2);
  }
}

async function checkAdminSelectedEmployeeDailyStatus() {
  if (!isAdmin()) return;
  const selectedEmployeeId = employeeSelect.value;
  const selectedDepartmentId = departmentSelect.value;
  const employee = employees.find((item) => item.id === selectedEmployeeId && item.department_id === selectedDepartmentId && item.is_active);
  
  if (!employee) {
    showCheckupForm(1);
    return;
  }
  
  // Check if employee has daily checkup for today
  const dailyCheckup = await loadAuthenticatedDailyCheckup(selectedEmployeeId);
  if (dailyCheckup) {
    showDailyCheckupStatus(dailyCheckup);
  } else {
    showCheckupForm(1);
  }
}

function syncGuestProfileForm() {
  const profileDepartment = document.querySelector("#profile-department");
  populateDepartmentSelect(profileDepartment, guestProfile?.departmentId ?? "");
  updateProfileEmployeeOptions(guestProfile?.employeeId ?? "");
  document.querySelector("#profile-whatsapp").value = guestProfile?.whatsapp ?? "";
}

function openEmployeeModal(departmentId, canAddAsGuest) {
  document.querySelector("#employee-form").reset();
  document.querySelector("#employee-modal-eyebrow").textContent = canAddAsGuest ? "TAMBAH NAMA" : "MASTER DATA";
  document.querySelector("#employee-modal-title").textContent = canAddAsGuest ? "Tambahkan nama Anda" : "Tambah karyawan";
  document.querySelector("#guest-employee-note").classList.toggle("hidden", !canAddAsGuest);
  document.querySelector("#new-employee-active-wrap").classList.toggle("hidden", canAddAsGuest);
  const departmentName = departments.find((department) => department.id === departmentId)?.name ?? "";
  document.querySelector("#new-employee-department").textContent = `Departemen: ${departmentName}`;
  employeeModal.showModal();
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.textContent = label;
  } else if (button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
    delete button.dataset.originalHtml;
    refreshIcons();
  }
}

function formatDate(value, includeTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: getActiveTimezone(),
    dateStyle: "medium",
    ...(includeTime ? { timeStyle: "short" } : {})
  }).format(date);
}

function setActiveStep(step) {
  activeStep = step;
  document.querySelectorAll(".checkup-step").forEach((section) => {
    section.classList.toggle("hidden", Number(section.dataset.step) !== step);
  });
  const percent = Math.round((step / 3) * 100);
  document.querySelector("#step-caption").textContent = `LANGKAH ${step} DARI 3`;
  document.querySelector("#step-percent").textContent = `${percent}%`;
  document.querySelector("#progress-bar").style.width = `${percent}%`;
}

function validateStep(step) {
  if (step === 1) {
    if (!departmentSelect.value) {
      showToast("Pilih departemen terlebih dahulu.", true);
      return false;
    }
    if (!employeeSelect.value) {
      showToast("Pilih nama karyawan untuk melanjutkan.", true);
      return false;
    }
    if (guestMode) {
      const whatsapp = document.querySelector("#checkup-whatsapp");
      if (!whatsapp.value.trim()) {
        whatsapp.setCustomValidity("Nomor WhatsApp wajib diisi.");
        whatsapp.reportValidity();
        whatsapp.setCustomValidity("");
        return false;
      }
      if (!isValidWhatsApp(whatsapp.value)) {
        whatsapp.setCustomValidity("Masukkan nomor WhatsApp yang valid, misalnya 081234567890.");
        whatsapp.reportValidity();
        whatsapp.setCustomValidity("");
        return false;
      }
      persistGuestProfile({
        departmentId: departmentSelect.value,
        employeeId: employeeSelect.value,
        whatsapp: whatsapp.value
      });
      syncGuestProfileForm();
    }
  }
  if (step === 2) {
    const systolic = document.querySelector("#systolic");
    const diastolic = document.querySelector("#diastolic");
    const requiredInputs = [systolic, diastolic];
    if (requiredInputs.some((input) => !input.reportValidity())) return false;
    if (Number(systolic.value) <= Number(diastolic.value)) {
      showToast("Nilai sistolik harus lebih besar dari diastolik.", true);
      return false;
    }
    for (const name of ["fatigue_level", "sleep_quality"]) {
      if (!checkupForm.querySelector(`input[name="${name}"]:checked`)) {
        showToast("Pilih nilai kelelahan dan kualitas tidur.", true);
        return false;
      }
    }
  }
  return true;
}

function updateTemperatureDisplay() {
  const temperature = Number(document.querySelector("#temperature").value);
  const value = document.querySelector("#temperature-value");
  const hint = document.querySelector("#temperature-hint");
  value.textContent = `${temperature.toFixed(1)}°C`;
  value.className = temperature > 37.5
    ? "rounded-lg bg-rose-50 px-2.5 py-1 text-sm font-bold text-rose-700"
    : "rounded-lg bg-blue-50 px-2.5 py-1 text-sm font-bold text-blue-700";
  hint.textContent = temperature > 37.5
    ? "Suhu di atas 37,5°C — hasil akan memerlukan observasi."
    : "Geser untuk memilih suhu tubuh.";
}

function updateEmployeeOptions() {
  const departmentId = guestMode && document.querySelector("#profile-tab").classList.contains("hidden")
    ? departmentSelect.value
    : guestMode
      ? document.querySelector("#profile-department").value
      : departmentSelect.value;
  const departmentEmployees = employees.filter((employee) =>
    employee.department_id === departmentId && employee.is_active
  );
  employeeSelect.innerHTML = '<option value="">Pilih nama karyawan</option>';
  for (const employee of departmentEmployees) {
    const option = document.createElement("option");
    option.value = employee.id;
    option.textContent = employee.full_name;
    employeeSelect.append(option);
  }
  employeeSelect.disabled = !departmentId || departmentEmployees.length === 0;
  if (!departmentId) {
    employeeSelect.innerHTML = '<option value="">Pilih departemen terlebih dahulu</option>';
  } else if (departmentEmployees.length === 0) {
    employeeSelect.innerHTML = '<option value="">Belum ada karyawan terdaftar</option>';
  }
  const addButton = document.querySelector("#open-employee-modal");
  const canAddEmployee = isAdmin() || (guestMode && ALLOW_GUEST_EMPLOYEE_CREATION && guestEmployeeCreationEnabled);
  addButton.disabled = !departmentId || !canAddEmployee;
  addButton.title = canAddEmployee ? "Tambah nama karyawan" : "Hubungi HR untuk menambahkan karyawan";
  document.querySelector("#employee-hint").textContent = isAdmin()
    ? "Karyawan baru dapat ditambahkan oleh HR/admin."
    : guestMode && canAddEmployee
      ? "Nama belum ada? Tambahkan nama Anda sendiri."
      : "Tidak menemukan nama? Hubungi HR untuk menambahkan karyawan.";
  if (guestMode) updateProfileEmployeeOptions();
}

async function loadDepartments() {
  const selectedDepartment = departmentSelect.value;
  const selectedHistoryDepartment = document.querySelector("#history-department").value;
  const { data, error } = await client
    .from("departments")
    .select("id, name")
    .order("name");
  if (error) throw error;
  departments = data ?? [];

  const options = departments.map((department) =>
    `<option value="${escapeHtml(department.id)}">${escapeHtml(department.name)}</option>`
  ).join("");
  departmentSelect.innerHTML = '<option value="">Pilih departemen</option>' + options;
  if (departments.some((department) => department.id === selectedDepartment)) {
    departmentSelect.value = selectedDepartment;
  }

  const historyDepartment = document.querySelector("#history-department");
  historyDepartment.innerHTML = '<option value="">Semua departemen</option>' + options;
  if (departments.some((department) => department.id === selectedHistoryDepartment)) {
    historyDepartment.value = selectedHistoryDepartment;
  }
}

async function updateNetworkAndQueueUI() {
  if (!offlineQueueBadge) return;
  const isOnline = navigator.onLine;
  let pendingCount = 0;
  try {
    pendingCount = await getPendingOfflineCount();
  } catch (_) {}

  offlineQueueBadge.classList.remove("hidden");
  if (!isOnline) {
    offlineQueueBadge.className = "sync-badge is-offline";
    syncIcon.innerHTML = '<i data-lucide="wifi-off" class="h-3.5 w-3.5 text-amber-700"></i>';
    syncText.textContent = "Offline";
  } else if (isSyncing) {
    offlineQueueBadge.className = "sync-badge is-syncing";
    syncIcon.innerHTML = '<i data-lucide="refresh-cw" class="h-3.5 w-3.5 text-blue-600 animate-spin"></i>';
    syncText.textContent = "Menyinkronkan…";
  } else {
    offlineQueueBadge.className = "sync-badge";
    syncIcon.innerHTML = '<i data-lucide="wifi" class="h-3.5 w-3.5 text-emerald-600"></i>';
    syncText.textContent = "Online";
  }

  if (pendingCount > 0) {
    queueCountBadge.textContent = String(pendingCount);
    queueCountBadge.classList.remove("hidden");
    manualSyncButton?.classList.remove("hidden");
  } else {
    queueCountBadge.classList.add("hidden");
    manualSyncButton?.classList.add("hidden");
  }
  refreshIcons();
}

async function renderQueueModal() {
  if (!queueList) return;
  try {
    const items = await getAllOfflineQueueItems();
    if (!items.length) {
      queueList.innerHTML = '<p class="text-xs text-center text-slate-400 py-3">Tidak ada antrean tertunda.</p>';
      return;
    }

    queueList.innerHTML = items.map((item) => {
      const isEmployee = item.action === "add_guest_employee";
      const title = isEmployee
        ? `Daftar Nama: ${escapeHtml(item.payload?.p_full_name || "Karyawan Baru")}`
        : `Checkup: ${escapeHtml(employees.find((e) => e.id === item.employee_id)?.full_name || "Karyawan")}`;
      const statusPill = item.preliminary_status
        ? `<span class="offline-notice-badge ml-1.5">${statusDetails[item.preliminary_status]?.label || item.preliminary_status}</span>`
        : "";
      const timeStr = formatDate(item.measured_at || item.created_at);

      return `
        <div class="offline-queue-item flex items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <p class="font-bold text-slate-800 text-xs truncate">${title} ${statusPill}</p>
            <p class="text-[11px] text-slate-500 mt-0.5">${timeStr} · <span class="text-amber-700 font-semibold">Menunggu sync</span></p>
          </div>
          <span class="text-slate-400 text-xs shrink-0"><i data-lucide="${isEmployee ? 'user-plus' : 'clipboard-list'}" class="h-4 w-4"></i></span>
        </div>
      `;
    }).join("");
    refreshIcons();
  } catch (err) {
    queueList.innerHTML = `<p class="text-xs text-rose-500 py-2">Gagal membaca antrean: ${escapeHtml(err.message)}</p>`;
  }
}

function openQueueModal() {
  renderQueueModal();
  queueModal?.showModal();
}

async function syncOfflineQueue(showToastNotice = false) {
  if (isSyncing) return;
  if (!navigator.onLine) {
    if (showToastNotice) showToast("Perangkat sedang offline. Menunggu koneksi internet...", true);
    return;
  }

  let pendingItems = [];
  try {
    pendingItems = await getPendingOfflineQueue();
  } catch (_) {
    return;
  }

  if (pendingItems.length === 0) {
    if (showToastNotice) showToast("Semua data sudah tersinkron.");
    await updateNetworkAndQueueUI();
    return;
  }

  isSyncing = true;
  await updateNetworkAndQueueUI();
  if (showToastNotice) showToast("Memulai sinkronisasi antrean offline…");

  let syncedCount = 0;
  let errorCount = 0;
  const rejectedCheckups = [];

  const employeeItems = pendingItems.filter((i) => i.action === "add_guest_employee");
  const checkupItems = pendingItems.filter((i) => i.action === "submit_checkup");
  const resolvedIdMap = new Map();

  // 1. Sinkronkan Karyawan Tamu Baru
  for (const item of employeeItems) {
    try {
      const { data, error } = await client.rpc("add_guest_employee", item.payload);
      if (error) throw error;
      const saved = Array.isArray(data) ? data[0] : data;
      const realEmployeeId = saved?.employee_id || saved?.id;
      if (realEmployeeId && item.temp_employee_id) {
        resolvedIdMap.set(item.temp_employee_id, realEmployeeId);

        if (guestProfile && guestProfile.employeeId === item.temp_employee_id) {
          guestProfile.employeeId = realEmployeeId;
          persistGuestProfile(guestProfile);
        }
      }
      await removeOfflineItem(item.id);
      syncedCount++;
    } catch (err) {
      console.error("Gagal menyinkronkan penambahan karyawan tamu:", err);
      errorCount++;
      if (err.message && err.message.includes("already registered")) {
        await removeOfflineItem(item.id);
      }
    }
  }

  // 2. Sinkronkan Pemeriksaan Harian (Checkup)
  for (const item of checkupItems) {
    try {
      let targetEmployeeId = item.employee_id;
      if (resolvedIdMap.has(targetEmployeeId)) {
        targetEmployeeId = resolvedIdMap.get(targetEmployeeId);
      }

      let savedCheckup;
      if (item.is_guest) {
        const { data, error } = await client.rpc("submit_guest_checkup", {
          p_employee_id: targetEmployeeId,
          p_device_token: item.device_token || guestProfile?.deviceToken,
          p_systolic: item.payload.systolic,
          p_diastolic: item.payload.diastolic,
          p_temperature_c: item.payload.temperature_c,
          p_fatigue_level: item.payload.fatigue_level,
          p_sleep_quality: item.payload.sleep_quality,
          p_symptoms: item.payload.symptoms,
          p_notes: item.payload.notes
        });
        if (error) throw error;
        savedCheckup = Array.isArray(data) ? data[0] : data;
      } else {
        const { data, error } = await client
          .from("checkups")
          .insert({ ...item.payload, employee_id: targetEmployeeId })
          .select("id, checked_at, readiness_status")
          .single();
        if (error) throw error;
        savedCheckup = data;
      }

      const checkupId = savedCheckup?.id || savedCheckup?.checkup_id;
      if (checkupId && item.whatsapp) {
        dispatchWhatsAppNotification(checkupId, item.whatsapp);
      }

      await removeOfflineItem(item.id);
      syncedCount++;
    } catch (err) {
      console.error("Gagal menyinkronkan checkup offline:", err);
      if (err.code === "23505" || (err.message && err.message.includes("sudah mengisi checkup hari ini"))) {
        await removeOfflineItem(item.id);
        syncedCount++;
      } else if (["P1001", "P1002", "P1003"].includes(err.code)) {
        await removeOfflineItem(item.id);
        rejectedCheckups.push(err.message);
        errorCount++;
      } else {
        errorCount++;
      }
    }
  }

  isSyncing = false;
  await updateNetworkAndQueueUI();

  if (employeeItems.length > 0 && guestMode) {
    try {
      await loadGuestDirectory();
    } catch (_) {}
  }

  if (syncedCount > 0 && !guestMode && currentUser) {
    try {
      await loadCheckups();
    } catch (_) {}
  }
  if (syncedCount > 0) {
    try {
      const dailyCheckup = guestMode
        ? await loadGuestDailyStatus()
        : currentProfile?.role === "employee"
          ? await loadAuthenticatedDailyCheckup(currentEmployeeId)
          : null;
      if (dailyCheckup) showDailyCheckupStatus(dailyCheckup);
      else if (rejectedCheckups.length > 0) showCheckupForm(2);
    } catch (error) {
      console.error("Could not refresh the daily DCU status after queue sync:", error);
      showToast(`Antrean terkirim, tetapi status DCU gagal diperbarui: ${error.message}`, true);
    }
  }
  let syncMessage = syncedCount > 0
    ? `${syncedCount} data antrean offline berhasil disinkronkan ke server.`
    : "";
  if (rejectedCheckups.length > 0) {
    const reasons = [...new Set(rejectedCheckups)].slice(0, 2).join(" ");
    const extraCount = rejectedCheckups.length > 2 ? ` (+${rejectedCheckups.length - 2} penolakan lain)` : "";
    const retryCount = errorCount - rejectedCheckups.length;
    const retryNotice = retryCount > 0 ? ` ${retryCount} antrean lain masih gagal dan akan dicoba kembali.` : "";
    syncMessage += `${syncMessage ? " " : ""}${rejectedCheckups.length} antrean DCU ditolak dan dihapus: ${reasons}${extraCount}${retryNotice}`;
  } else if (errorCount > 0) {
    syncMessage += `${syncMessage ? " " : ""}${errorCount} antrean gagal disinkronkan. Akan dicoba kembali saat online.`;
  }
  if (syncMessage) showToast(syncMessage, errorCount > 0);
  renderQueueModal();
}

async function loadGuestDirectory() {
  let directory = [];
  try {
    if (!navigator.onLine) throw new Error("Offline");
    const { data, error } = await client.rpc("get_guest_directory");
    if (error) throw error;
    directory = data ?? [];

    departments = [...new Map(directory.map((row) => [
      row.department_id,
      { id: row.department_id, name: row.department_name }
    ])).values()].sort((a, b) => a.name.localeCompare(b.name, "id"));
    employees = directory.filter((row) => row.employee_id).map((row) => ({
      id: row.employee_id,
      department_id: row.department_id,
      full_name: row.employee_name,
      is_active: true
    })).sort((a, b) => a.full_name.localeCompare(b.full_name, "id"));

    // Simpan ke cache lokal IndexedDB (hanya data publik aman)
    await saveDirectoryCache(departments, employees);
  } catch (err) {
    console.warn("Memuat direktori dari cache offline:", err);
    try {
      const cached = await getDirectoryCache();
      if (cached && (cached.departments?.length > 0 || cached.employees?.length > 0)) {
        departments = cached.departments || [];
        employees = cached.employees || [];
        showToast("Menggunakan direktori tersimpan (offline).");
      } else {
        throw new Error("Data karyawan belum tersedia offline. Hubungkan ke internet setidaknya sekali.");
      }
    } catch (cacheErr) {
      throw cacheErr;
    }
  }

  // Gabungkan penambahan karyawan tamu yang masih berada di antrean lokal
  try {
    const queue = await getPendingOfflineQueue();
    const pendingGuests = queue.filter((i) => i.action === "add_guest_employee");
    for (const item of pendingGuests) {
      if (item.temp_employee_id && !employees.some((e) => e.id === item.temp_employee_id)) {
        employees.push({
          id: item.temp_employee_id,
          department_id: item.payload.p_department_id,
          full_name: item.payload.p_full_name,
          employment_status: item.payload.p_employment_status,
          job_title: item.payload.p_job_title,
          work_pattern: item.payload.p_work_pattern,
          is_active: true
        });
      }
    }
    employees.sort((a, b) => a.full_name.localeCompare(b.full_name, "id"));
  } catch (_) {}

  populateDepartmentSelect(departmentSelect);
  populateDepartmentSelect(document.querySelector("#profile-department"));
  updateEmployeeOptions();
}

async function loadEmployees() {
  const selectedEmployee = employeeSelect.value;
  const { data, error } = await client
    .from("employees")
    .select("id, department_id, full_name, employment_status, job_title, work_pattern, is_active")
    .eq("is_active", true)
    .order("full_name");
  if (error) throw error;
  employees = data ?? [];
  updateEmployeeOptions();

  const ownEmployee = employees.find((employee) => employee.id === currentEmployeeId);
  if (!isAdmin() && ownEmployee) {
    departmentSelect.value = ownEmployee.department_id;
    updateEmployeeOptions();
    employeeSelect.value = ownEmployee.id;
    departmentSelect.disabled = true;
    employeeSelect.disabled = true;
  } else if (isAdmin()) {
    departmentSelect.disabled = false;
    if (employees.some((employee) => employee.id === selectedEmployee && employee.department_id === departmentSelect.value)) {
      employeeSelect.value = selectedEmployee;
    }
  } else {
    throw new Error("Akun belum ditautkan ke data karyawan. Hubungi administrator.");
  }
}

function getHistoryFilters() {
  return {
    from: document.querySelector("#filter-from").value,
    to: document.querySelector("#filter-to").value,
    departmentId: document.querySelector("#history-department").value,
    readinessStatus: document.querySelector("#history-readiness").value
  };
}

async function loadCheckups() {
  historyList.innerHTML = '<div class="empty-state">Memuat riwayat…</div>';
  let query = client
    .from("checkups")
    .select("id, employee_id, checked_at, systolic, diastolic, temperature_c, fatigue_level, sleep_quality, symptoms, notes, readiness_status, employees!inner(full_name, department_id, departments(name))")
    .order("checked_at", { ascending: false })
    .limit(1000);

  const filters = getHistoryFilters();
  if (filters.from && filters.to && filters.from > filters.to) {
    historyList.innerHTML = "";
    throw new Error("Tanggal awal tidak boleh melewati tanggal akhir.");
  }
  if (filters.from) {
    const { start } = getDateRangeForDate(filters.from);
    query = query.gte("checked_at", start);
  }
  if (filters.to) {
    const { end } = getDateRangeForDate(filters.to);
    query = query.lt("checked_at", end);
  }
  if (filters.departmentId) query = query.eq("employees.department_id", filters.departmentId);
  if (filters.readinessStatus) query = query.eq("readiness_status", filters.readinessStatus);

  const { data, error } = await query;
  if (error) {
    historyList.innerHTML = "";
    throw error;
  }
  checkups = data ?? [];
  if (isAdmin()) await loadDailyCoverage();
  renderHistory();
  renderSummary();
}

async function loadDailyCoverage() {
  const { start, end } = getDateRange();
  const [checkupResult, employeeResult, readinessCountEntries] = await Promise.all([
    client
      .from("checkups")
      .select("id", { count: "exact", head: true })
      .gte("checked_at", start)
      .lt("checked_at", end),
    client
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true),
    Promise.all(Object.keys(statusDetails).map(async (status) => {
      const result = await client
        .from("checkups")
        .select("id", { count: "exact", head: true })
        .gte("checked_at", start)
        .lt("checked_at", end)
        .eq("readiness_status", status);
      if (result.error) throw result.error;
      return [status, result.count ?? 0];
    }))
  ]);
  if (checkupResult.error) throw checkupResult.error;
  if (employeeResult.error) throw employeeResult.error;
  todayCheckupCount = checkupResult.count ?? 0;
  activeEmployeeCount = employeeResult.count ?? 0;
  todayReadinessCounts = Object.fromEntries(readinessCountEntries);
}

function renderHistory() {
  if (!checkups.length) {
    historyList.innerHTML = '<div class="empty-state"><i data-lucide="clipboard-list"></i>Belum ada checkup untuk filter ini.</div>';
    refreshIcons();
    return;
  }

  historyList.innerHTML = checkups.map((checkup) => {
    const status = statusDetails[checkup.readiness_status] ?? statusDetails.need_observation;
    const employee = checkup.employees;
    const symptoms = Object.entries(checkup.symptoms ?? {})
      .filter(([, selected]) => selected)
      .map(([key]) => symptomLabels[key] ?? key);
    return `<article class="history-card">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h2 class="truncate text-sm font-bold text-slate-900">${escapeHtml(employee?.full_name ?? "Karyawan")}</h2>
          <p class="mt-1 text-xs text-slate-500">${escapeHtml(employee?.departments?.name ?? "—")} · ${escapeHtml(formatDate(checkup.checked_at))}</p>
        </div>
        <span class="status-pill ${status.pill}"><i data-lucide="${status.icon}"></i>${status.label}</span>
      </div>
      <div class="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-xs">
        <p><span class="block text-slate-400">Tekanan darah</span><b class="mt-1 block text-slate-700">${checkup.systolic}/${checkup.diastolic}</b></p>
        <p><span class="block text-slate-400">Suhu</span><b class="mt-1 block text-slate-700">${Number(checkup.temperature_c).toFixed(1)}°C</b></p>
        <p><span class="block text-slate-400">Kelelahan / tidur</span><b class="mt-1 block text-slate-700">${checkup.fatigue_level} / ${checkup.sleep_quality}</b></p>
      </div>
      ${symptoms.length ? `<p class="mt-3 text-xs leading-5 text-slate-500"><b class="text-slate-600">Gejala:</b> ${escapeHtml(symptoms.join(", "))}</p>` : ""}
      ${checkup.notes ? `<p class="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-500">${escapeHtml(checkup.notes)}</p>` : ""}
    </article>`;
  }).join("");
  refreshIcons();
}

function renderSummary() {
  const counts = isAdmin() && todayReadinessCounts
    ? {
        fit: todayReadinessCounts.fit_to_work,
        observe: todayReadinessCounts.need_observation,
        rest: todayReadinessCounts.rest_recommended
      }
    : {
        fit: checkups.filter((item) => item.readiness_status === "fit_to_work").length,
        observe: checkups.filter((item) => item.readiness_status === "need_observation").length,
        rest: checkups.filter((item) => item.readiness_status === "rest_recommended").length
      };
  if (isAdmin() && todayCheckupCount !== null && activeEmployeeCount !== null) {
    const coverage = activeEmployeeCount
      ? Math.min(100, Math.round((todayCheckupCount / activeEmployeeCount) * 100))
      : 0;
    document.querySelector("#stat-today-checkups").textContent = String(todayCheckupCount);
    document.querySelector("#stat-active-employees").textContent = String(activeEmployeeCount);
    document.querySelector("#stat-coverage-percent").textContent = `${coverage}%`;
    document.querySelector("#stat-coverage-bar").style.width = `${coverage}%`;
    document.querySelector("#stat-coverage-bar").parentElement.setAttribute("aria-valuenow", String(coverage));
  }
  document.querySelector("#stat-fit").textContent = String(counts.fit);
  document.querySelector("#stat-observe").textContent = String(counts.observe);
  document.querySelector("#stat-rest").textContent = String(counts.rest);
}

function collectCheckup() {
  const symptoms = Object.fromEntries(
    [...checkupForm.querySelectorAll('input[name="symptoms"]')].map((input) => [input.value, input.checked])
  );
  return {
    employee_id: employeeSelect.value,
    systolic: Number(document.querySelector("#systolic").value),
    diastolic: Number(document.querySelector("#diastolic").value),
    temperature_c: Number(document.querySelector("#temperature").value),
    fatigue_level: Number(checkupForm.querySelector('input[name="fatigue_level"]:checked')?.value),
    sleep_quality: Number(checkupForm.querySelector('input[name="sleep_quality"]:checked')?.value),
    symptoms,
    notes: document.querySelector("#notes").value.trim() || null
  };
}

function reportText(payload, status, checkedAt, employeeName, departmentName) {
  const symptomNames = Object.entries(payload.symptoms)
    .filter(([, selected]) => selected)
    .map(([key]) => symptomLabels[key]);
  return [
    "*Laporan Daily Checkup*",
    `Nama: ${employeeName}`,
    `Departemen: ${departmentName}`,
    `Waktu: ${formatDate(checkedAt)}`,
    `Status: ${statusDetails[status].label}`,
    `Tekanan darah: ${payload.systolic}/${payload.diastolic} mmHg`,
    `Suhu: ${payload.temperature_c.toFixed(1)}°C`,
    `Kelelahan: ${payload.fatigue_level}/5`,
    `Kualitas tidur: ${payload.sleep_quality}/5`,
    `Gejala: ${symptomNames.length ? symptomNames.join(", ") : "Tidak ada yang dipilih"}`,
    payload.notes ? `Catatan: ${payload.notes}` : "",
    "_Hasil ini bukan diagnosis medis._"
  ].filter(Boolean).join("\n");
}

function showResult(payload, status, checkedAt, isOffline = false) {
  const selectedEmployee = employees.find((employee) => employee.id === payload.employee_id);
  const departmentName = departments.find((department) => department.id === selectedEmployee?.department_id)?.name ?? "—";
  const employeeName = selectedEmployee?.full_name ?? "Karyawan";
  const detail = statusDetails[status] ?? statusDetails.need_observation;
  const text = reportText(payload, status, checkedAt, employeeName, departmentName);
  const urgentSymptoms = payload.symptoms.breathing_difficulty
    || payload.symptoms.chest_pain
    || payload.symptoms.fainting;

  const offlineNoticeHtml = isOffline
    ? `<div class="mt-3 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <i data-lucide="cloud-off" class="h-4 w-4 shrink-0 text-amber-700"></i>
        <span><b>Tersimpan di antrean offline.</b> Hasil merupakan evaluasi lokal dan akan otomatis disinkronkan saat terhubung internet.</span>
       </div>`
    : "";

  resultCard.className = `panel-card result-card ${detail.result} mt-5`;
  resultCard.innerHTML = `<div class="flex items-start gap-3">
    <span class="status-pill ${detail.pill}"><i data-lucide="${detail.icon}"></i></span>
    <div class="min-w-0 flex-1">
      <p class="text-xs font-semibold text-slate-500">STATUS KESIAPAN HARIAN</p>
      <h2 class="mt-1 font-display text-xl font-extrabold text-slate-900">${detail.label}</h2>
      <p class="mt-1 text-xs text-slate-500">${escapeHtml(employeeName)} · ${escapeHtml(formatDate(checkedAt))}</p>
    </div>
  </div>
  ${offlineNoticeHtml}
  <p class="mt-3 text-xs leading-5 text-slate-600">${status === "rest_recommended"
    ? urgentSymptoms
      ? "Cari pertolongan medis segera untuk gejala seperti sesak napas, nyeri dada, atau pingsan."
      : "Pertimbangkan untuk beristirahat dan hubungi tenaga kesehatan."
    : status === "need_observation"
      ? "Pantau kondisi Anda dan ikuti prosedur kesehatan di tempat kerja."
      : "Tetap jaga kesehatan dan ikuti prosedur keselamatan kerja."}</p>
  <button id="copy-report" class="secondary-button mt-4 w-full" type="button"><i data-lucide="copy"></i> Salin laporan (WhatsApp)</button>`;
  resultCard.dataset.report = text;
  resultCard.classList.remove("hidden");
  document.querySelector("#copy-report").addEventListener("click", copyReport);
  refreshIcons();
  resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function copyReport() {
  const text = resultCard.dataset.report;
  try {
    await navigator.clipboard.writeText(text);
    showToast("Laporan disalin ke clipboard.");
  } catch (error) {
    console.error("Clipboard write failed:", error);
    showToast("Gagal menyalin laporan. Periksa izin clipboard browser.", true);
  }
}

async function dispatchWhatsAppNotification(checkupId, employeePhone) {
  if (!checkupId || !employeePhone || !client?.functions) return;
  try {
    const { data, error } = await client.functions.invoke("send-wa-notification", {
      body: {
        checkup_id: checkupId,
        employee_phone: employeePhone
      }
    });
    if (error) {
      console.warn("WhatsApp notification invoke warning:", error);
    } else if (data?.success) {
      console.info(`WhatsApp notification dispatched: ${data.sent} sent, ${data.failed} failed.`);
    }
  } catch (err) {
    console.warn("WhatsApp notification background dispatch failed:", err);
  }
}

async function submitCheckup(event) {
  event.preventDefault();
  if (!validateStep(1) || !validateStep(2)) {
    setActiveStep(activeStep === 1 ? 1 : 2);
    return;
  }

  const payload = collectCheckup();
  const button = document.querySelector("#submit-checkup");
  setBusy(button, true, "Menyimpan…");

  const isOffline = !navigator.onLine;

  const handleOfflineSubmission = async () => {
    const preliminaryStatus = evaluateReadiness(payload);
    const measuredAt = new Date().toISOString();
    const employeePhone = guestMode
      ? (guestProfile?.whatsapp || document.querySelector("#checkup-whatsapp")?.value || "")
      : "";

    await enqueueOfflineItem({
      action: "submit_checkup",
      is_guest: guestMode,
      employee_id: payload.employee_id,
      device_token: guestMode ? guestProfile?.deviceToken : null,
      payload,
      measured_at: measuredAt,
      preliminary_status: preliminaryStatus,
      whatsapp: employeePhone || null
    });

    clearCheckupDraft(payload.employee_id);
    showResult(payload, preliminaryStatus, measuredAt, true);

    checkupForm.reset();
    departmentSelect.disabled = !guestMode && !isAdmin() && Boolean(currentEmployeeId);
    if (!guestMode && !isAdmin() && currentEmployeeId) {
      const ownEmployee = employees.find((employee) => employee.id === currentEmployeeId);
      departmentSelect.value = ownEmployee.department_id;
      updateEmployeeOptions();
      employeeSelect.value = ownEmployee.id;
      employeeSelect.disabled = true;
    } else {
      updateEmployeeOptions();
    }

    if (guestMode) {
      syncGuestProfileToCheckup();
      syncGuestProfileForm();
      showDailyCheckupStatus({
        ...payload,
        checked_at: measuredAt,
        readiness_status: preliminaryStatus,
        is_offline: true
      });
    } else if (currentProfile?.role === "employee") {
      showDailyCheckupStatus({
        ...payload,
        checked_at: measuredAt,
        readiness_status: preliminaryStatus,
        is_offline: true
      });
    }
    updateTemperatureDisplay();
    if (!guestMode && currentProfile?.role !== "employee") setActiveStep(1);
    await updateNetworkAndQueueUI();
    showToast("DCU disimpan di antrean offline. Otomatis dikirim saat online.");
  };

  if (isOffline) {
    try {
      await handleOfflineSubmission();
    } catch (err) {
      console.error("Gagal menyimpan ke antrean offline:", err);
      showToast(`Gagal menyimpan antrean offline: ${err.message}`, true);
    } finally {
      setBusy(button, false);
    }
    return;
  }

  try {
    let savedCheckup;
    if (guestMode) {
      const { data, error } = await client.rpc("submit_guest_checkup", {
        p_employee_id: payload.employee_id,
        p_device_token: guestProfile.deviceToken,
        p_systolic: payload.systolic,
        p_diastolic: payload.diastolic,
        p_temperature_c: payload.temperature_c,
        p_fatigue_level: payload.fatigue_level,
        p_sleep_quality: payload.sleep_quality,
        p_symptoms: payload.symptoms,
        p_notes: payload.notes
      });
      if (error) throw error;
      savedCheckup = Array.isArray(data) ? data[0] : data;
      if (!savedCheckup?.checked_at || !savedCheckup?.readiness_status) {
        throw new Error("Respons penyimpanan checkup tamu tidak lengkap.");
      }
    } else {
      const { data, error } = await client
        .from("checkups")
        .insert(payload)
        .select("id, checked_at, readiness_status")
        .single();
      if (error) throw error;
      savedCheckup = data;
    }
    let canSubmitMore = false;
    let submissionStatusError = null;
    if (guestMode || currentProfile?.role === "employee") {
      const { data, error } = await client.rpc("can_submit_additional_dcu", {
        p_employee_id: payload.employee_id,
        p_device_token: guestMode ? guestProfile.deviceToken : null
      });
      if (error) {
        console.error("Could not check the remaining daily DCU limit:", error);
        submissionStatusError = error;
      } else {
        canSubmitMore = Boolean(data);
      }
    }
    clearCheckupDraft(payload.employee_id);
    const employeePhone = guestMode
      ? (guestProfile?.whatsapp || document.querySelector("#checkup-whatsapp")?.value || "")
      : "";
    const checkupId = savedCheckup?.id || savedCheckup?.checkup_id;
    showResult(payload, savedCheckup.readiness_status, savedCheckup.checked_at, false);
    if (checkupId && employeePhone) {
      dispatchWhatsAppNotification(checkupId, employeePhone);
    }
    checkupForm.reset();
    departmentSelect.disabled = !guestMode && !isAdmin() && Boolean(currentEmployeeId);
    if (!guestMode && !isAdmin() && currentEmployeeId) {
      const ownEmployee = employees.find((employee) => employee.id === currentEmployeeId);
      departmentSelect.value = ownEmployee.department_id;
      updateEmployeeOptions();
      employeeSelect.value = ownEmployee.id;
      employeeSelect.disabled = true;
    } else {
      updateEmployeeOptions();
    }
    if (guestMode) {
      syncGuestProfileToCheckup();
      syncGuestProfileForm();
      showDailyCheckupStatus({
        ...payload,
        checked_at: savedCheckup.checked_at,
        readiness_status: savedCheckup.readiness_status,
        can_submit_more: canSubmitMore
      });
    } else if (currentProfile?.role === "employee") {
      showDailyCheckupStatus({
        ...payload,
        checked_at: savedCheckup.checked_at,
        readiness_status: savedCheckup.readiness_status,
        can_submit_more: canSubmitMore
      });
    }
    updateTemperatureDisplay();
    if (!guestMode && currentProfile?.role !== "employee") setActiveStep(1);
    showToast(submissionStatusError
      ? `Checkup berhasil disimpan, tetapi status batas pengisian berikutnya gagal diperiksa: ${submissionStatusError.message}`
      : "Checkup berhasil disimpan.", Boolean(submissionStatusError));

    if (!guestMode) await loadCheckups();
  } catch (error) {
    console.error("Checkup save failed:", error);
    if (!navigator.onLine || error.message?.includes("Failed to fetch") || error.name === "TypeError") {
      try {
        await handleOfflineSubmission();
        return;
      } catch (err) {
        console.error("Gagal fallback antrean offline:", err);
      }
    }

    if (error.code === "23505") {
      showToast("Karyawan ini sudah mengisi checkup hari ini.", true);
      try {
        const dailyCheckup = guestMode
          ? await loadGuestDailyStatus()
          : await loadAuthenticatedDailyCheckup(payload.employee_id);
        if (dailyCheckup) showDailyCheckupStatus(dailyCheckup);
      } catch (statusError) {
        console.error("Could not load the existing daily checkup:", statusError);
        showToast(`Checkup sudah tercatat, tetapi statusnya gagal dimuat: ${statusError.message}`, true);
      }
    } else {
      showToast(`Checkup gagal disimpan: ${error.message}`, true);
      if (error.code === "P1002") {
        try {
          const dailyCheckup = guestMode
            ? await loadGuestDailyStatus()
            : currentProfile?.role === "employee"
              ? await loadAuthenticatedDailyCheckup(payload.employee_id)
              : null;
          if (dailyCheckup) showDailyCheckupStatus(dailyCheckup);
        } catch (statusError) {
          console.error("Could not refresh the daily DCU limit status:", statusError);
          showToast(`Checkup ditolak dan status batas harian gagal diperbarui: ${statusError.message}`, true);
        }
      }
    }
  } finally {
    setBusy(button, false);
  }
}

async function addEmployee(event) {
  event.preventDefault();
  const canAddAsGuest = guestMode && ALLOW_GUEST_EMPLOYEE_CREATION && guestEmployeeCreationEnabled;
  if (!isAdmin() && !canAddAsGuest) {
    showToast("Hanya HR/admin yang dapat menambah master karyawan.", true);
    return;
  }
  const departmentId = departmentSelect.value;
  const name = document.querySelector("#new-employee-name").value.trim();
  const employeeMetadata = {
    employment_status: document.querySelector("#new-employee-status").value || null,
    job_title: document.querySelector("#new-employee-job-title").value.trim() || null,
    work_pattern: document.querySelector("#new-employee-work-pattern").value || null
  };
  const isActive = isAdmin()
    ? document.querySelector("#new-employee-active").checked
    : true;
  if (!departmentId || !name) {
    showToast("Departemen dan nama karyawan wajib diisi.", true);
    return;
  }

  const button = document.querySelector("#save-employee");
  setBusy(button, true, "Menyimpan…");
  try {
    let employee;
    const isOffline = !navigator.onLine;

    if (canAddAsGuest && isOffline) {
      const tempId = `temp_emp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      employee = {
        id: tempId,
        department_id: departmentId,
        full_name: name,
        employment_status: employeeMetadata.employment_status,
        job_title: employeeMetadata.job_title,
        work_pattern: employeeMetadata.work_pattern,
        is_active: true
      };
      await enqueueOfflineItem({
        action: "add_guest_employee",
        temp_employee_id: tempId,
        payload: {
          p_department_id: departmentId,
          p_full_name: name,
          p_employment_status: employeeMetadata.employment_status,
          p_job_title: employeeMetadata.job_title,
          p_work_pattern: employeeMetadata.work_pattern
        }
      });
      await updateNetworkAndQueueUI();
    } else if (canAddAsGuest) {
      try {
        const { data, error } = await client.rpc("add_guest_employee", {
          p_department_id: departmentId,
          p_full_name: name,
          p_employment_status: employeeMetadata.employment_status,
          p_job_title: employeeMetadata.job_title,
          p_work_pattern: employeeMetadata.work_pattern
        });
        if (error) throw error;
        employee = Array.isArray(data) ? data[0] : data;
        if (!employee?.employee_id) {
          throw new Error("Respons penambahan nama tidak lengkap.");
        }
        employee = {
          id: employee.employee_id,
          department_id: employee.department_id,
          full_name: employee.employee_name,
          employment_status: employee.employment_status,
          job_title: employee.job_title,
          work_pattern: employee.work_pattern,
          is_active: true
        };
      } catch (networkError) {
        if (!navigator.onLine || networkError.message?.includes("Failed to fetch") || networkError.name === "TypeError") {
          const tempId = `temp_emp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          employee = {
            id: tempId,
            department_id: departmentId,
            full_name: name,
            employment_status: employeeMetadata.employment_status,
            job_title: employeeMetadata.job_title,
            work_pattern: employeeMetadata.work_pattern,
            is_active: true
          };
          await enqueueOfflineItem({
            action: "add_guest_employee",
            temp_employee_id: tempId,
            payload: {
              p_department_id: departmentId,
              p_full_name: name,
              p_employment_status: employeeMetadata.employment_status,
              p_job_title: employeeMetadata.job_title,
              p_work_pattern: employeeMetadata.work_pattern
            }
          });
          await updateNetworkAndQueueUI();
        } else {
          throw networkError;
        }
      }
    } else {
      // Admin/HR insertion - tetap 100% online
      const { data, error } = await client
        .from("employees")
        .insert({
          department_id: departmentId,
          full_name: name,
          ...employeeMetadata,
          is_active: isActive
        })
        .select("id, department_id, full_name, employment_status, job_title, work_pattern, is_active")
        .single();
      if (error) throw error;
      employee = data;
    }

    if (!employees.some((existing) => existing.id === employee.id)) {
      employees.push(employee);
    }
    departmentSelect.value = departmentId;
    updateEmployeeOptions();
    employeeSelect.value = employee.id;
    if (guestMode) {
      document.querySelector("#profile-department").value = departmentId;
      updateProfileEmployeeOptions(employee.id);
      const profileActive = !document.querySelector("#profile-tab").classList.contains("hidden");
      const currentPhone = profileActive
        ? document.querySelector("#profile-whatsapp").value
        : document.querySelector("#checkup-whatsapp").value;
      document.querySelector("#profile-whatsapp").value = currentPhone;
      document.querySelector("#checkup-whatsapp").value = currentPhone;
      if (currentPhone.trim()) {
        persistGuestProfile({
          departmentId,
          employeeId: employee.id,
          whatsapp: currentPhone
        });
      }
    }
    employeeModal.close();
    document.querySelector("#employee-form").reset();
    showToast(employee.id.startsWith("temp_emp_")
      ? "Nama karyawan disimpan ke antrean offline."
      : (canAddAsGuest ? "Nama karyawan berhasil ditambahkan." : "Master karyawan berhasil disimpan."));
  } catch (error) {
    console.error("Employee save failed:", error);
    showToast(`Gagal menyimpan karyawan: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  const safeText = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function triggerCsvDownload(items) {
  if (!items?.length) return false;
  const header = [
    "Waktu checkup", "Nama karyawan", "Departemen", "Tekanan sistolik", "Tekanan diastolik",
    "Suhu (C)", "Kelelahan (1-5)", "Kualitas tidur (1-5)", "Gejala", "Catatan", "Status"
  ];
  const rows = items.map((item) => [
    item.checked_at,
    item.employees?.full_name,
    item.employees?.departments?.name,
    item.systolic,
    item.diastolic,
    item.temperature_c,
    item.fatigue_level,
    item.sleep_quality,
    Object.entries(item.symptoms ?? {}).filter(([, selected]) => selected).map(([key]) => symptomLabels[key] ?? key).join("; "),
    item.notes,
    statusDetails[item.readiness_status]?.label ?? item.readiness_status
  ]);
  const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `daily-checkup-${getAppToday()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

async function exportCsv() {
  const button = document.querySelector("#export-csv");
  setBusy(button, true, "Mengecek data…");
  try {
    await loadCheckups();
    if (!checkups.length) {
      showToast("Tidak ada data untuk diekspor.", true);
      return;
    }

    // Jika bukan Admin (misal karyawan atau HR), langsung unduh CSV tanpa modal opsi hapus
    if (currentProfile?.role !== "admin") {
      triggerCsvDownload(checkups);
      showToast("File CSV riwayat berhasil diunduh.");
      return;
    }

    // Khusus Admin: buka modal konfirmasi
    const countElement = document.querySelector("#export-modal-count");
    if (countElement) countElement.textContent = checkups.length;
    exportConfirmModal.showModal();
    refreshIcons();
  } catch (error) {
    console.error("Gagal menyiapkan ekspor CSV:", error);
    showToast(`Gagal menyiapkan ekspor: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function setTab(tabName, refreshData = true) {
  if (guestMode && !["checkup", "profile"].includes(tabName)) return;
  if (!isAdmin() && tabName === "profile" && !guestMode) return;
  if (tabName === "summary") {
    document.querySelector("#history-readiness").value = "";
  }
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `${tabName}-tab`);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.tabTarget === tabName);
  });
  if (guestMode && tabName === "profile") syncGuestProfileForm();
  if (refreshData && (tabName === "history" || tabName === "summary")) {
    loadCheckups().catch((error) => {
      console.error("Checkup history load failed:", error);
      showToast(`Gagal memuat riwayat: ${error.message}`, true);
    });
  }
}

function openSummaryFilter(filter) {
  const fromInput = document.querySelector("#filter-from");
  const toInput = document.querySelector("#filter-to");
  const departmentInput = document.querySelector("#history-department");
  const readinessInput = document.querySelector("#history-readiness");
  const today = getAppToday();

  fromInput.value = today;
  toInput.value = today;
  departmentInput.value = "";
  if (filter === "today") {
    readinessInput.value = "";
  } else {
    readinessInput.value = filter;
  }

  setTab("history", false);
  loadCheckups().catch((error) => {
    console.error("Summary card history filter failed:", error);
    showToast(`Gagal memuat riwayat: ${error.message}`, true);
  });
}

async function initializeApp(user) {
  guestStatusRequest += 1;
  guestMode = false;
  guestProfile = null;
  document.querySelector("#daily-checkup-status-loading").classList.add("hidden");
  document.querySelector("#daily-checkup-completed-notice").classList.add("hidden");
  checkupForm.classList.remove("hidden");
  checkupProgress.classList.remove("hidden");
  resultCard.replaceChildren();
  resultCard.classList.add("hidden");
  currentUser = user;
  const signoutButton = document.querySelector("#signout-button");
  signoutButton.innerHTML = '<i data-lucide="log-out"></i>';
  signoutButton.setAttribute("aria-label", "Keluar");
  signoutButton.title = "Keluar";
  signoutButton.classList.remove("hidden");
  refreshIcons();
  document.querySelectorAll("[data-tab-target]").forEach((button) => button.classList.remove("hidden"));
  if (!isAdmin()) document.querySelector('[data-tab-target="profile"]').classList.add("hidden");
  appShell.classList.remove("guest-mode");
  document.querySelector("#checkup-whatsapp-wrap").classList.add("hidden");
  document.querySelector("#checkup-whatsapp").required = false;
  document.querySelector("#guest-mode-notice").classList.add("hidden");
  const { data, error } = await client
    .from("account_profiles")
    .select("user_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    await client.auth.signOut();
    throw new Error("Akun belum memiliki profil akses. Hubungi administrator.");
  }
  currentProfile = data;
  await syncAppTimezone();
  resetCheckupResponses();
  todayCheckupCount = null;
  todayReadinessCounts = null;
  activeEmployeeCount = null;
  currentEmployeeId = null;
  if (currentProfile.role === "employee") {
    const employeeResult = await client.rpc("current_employee_id");
    if (employeeResult.error) throw employeeResult.error;
    currentEmployeeId = employeeResult.data;
    if (!currentEmployeeId) {
      throw new Error("Akun belum ditautkan ke data karyawan. Hubungi administrator.");
    }
  }
  loginScreen.classList.add("hidden");
  loginScreen.classList.remove("flex");
  appShell.classList.remove("hidden");
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("id-ID", {
    timeZone: getActiveTimezone(),
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(new Date());
  document.querySelector("#history-department-wrap").classList.toggle("hidden", !isAdmin());
  document.querySelector("#daily-coverage-card").classList.toggle("hidden", !isAdmin());

  await loadDepartments();
  await loadEmployees();
  if (isAdmin()) restoreCheckupSelection();
  await loadCheckups();
  if (currentProfile.role === "employee") {
    const dailyCheckup = await loadAuthenticatedDailyCheckup(currentEmployeeId);
    if (dailyCheckup) {
      showDailyCheckupStatus(dailyCheckup);
    } else {
      const restored = restoreCheckupDraft(currentEmployeeId);
      showCheckupForm(restored ? activeStep : 1);
    }
  } else if (isAdmin()) {
    restoreCheckupDraft(employeeSelect.value);
  } else {
    checkupForm.classList.remove("hidden");
    checkupProgress.classList.remove("hidden");
    resultCard.classList.add("hidden");
  }
  setTab(isAdmin() ? "summary" : "checkup", false);
  if (realtimeChannel) await client.removeChannel(realtimeChannel);
  realtimeChannel = client
    .channel("checkup-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "checkups" }, () => {
      loadCheckups().catch((error) => {
        console.error("Realtime history refresh failed:", error);
        showToast(`Gagal memperbarui riwayat: ${error.message}`, true);
      });
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "departments" }, () => {
      loadDepartments().then(loadEmployees).catch((error) => {
        console.error("Realtime department refresh failed:", error);
        showToast(`Gagal memperbarui departemen: ${error.message}`, true);
      });
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "employees" }, () => {
      loadEmployees().then(async () => {
        if (isAdmin()) {
          await loadDailyCoverage();
          renderSummary();
        }
      }).catch((error) => {
        console.error("Realtime employee refresh failed:", error);
        showToast(`Gagal memperbarui data karyawan: ${error.message}`, true);
      });
    })
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        showToast("Pembaruan real-time tidak tersedia. Muat ulang tab untuk data terbaru.", true);
      }
    });
}

async function initializeGuestApp() {
  guestStatusRequest += 1;
  try {
    if (!navigator.onLine) throw new Error("Offline");
    const { data: enabled, error: settingsError } = await client.rpc("is_guest_checkups_enabled");
    if (settingsError) throw settingsError;
    if (!enabled) {
      throw new Error("Mode tamu belum diaktifkan di Supabase. Lihat guest_mode.sql.");
    }
    await syncAppTimezone();

    guestEmployeeCreationEnabled = false;
    if (ALLOW_GUEST_EMPLOYEE_CREATION) {
      const employeeSetting = await client.rpc("is_guest_employee_creation_enabled");
      if (employeeSetting.error) throw employeeSetting.error;
      guestEmployeeCreationEnabled = Boolean(employeeSetting.data);
    }
  } catch (err) {
    if (!navigator.onLine || err.message?.includes("Failed to fetch") || err.name === "TypeError" || err.message === "Offline") {
      console.warn("Inisialisasi mode tamu dalam status offline:", err);
      guestEmployeeCreationEnabled = Boolean(ALLOW_GUEST_EMPLOYEE_CREATION);
    } else {
      throw err;
    }
  }

  guestMode = true;
  document.querySelector("#daily-checkup-status-loading").classList.add("hidden");
  document.querySelector("#daily-checkup-completed-notice").classList.add("hidden");
  currentUser = null;
  currentProfile = null;
  currentEmployeeId = null;
  resetCheckupResponses();
  todayCheckupCount = null;
  todayReadinessCounts = null;
  activeEmployeeCount = null;
  checkups = [];
  historyList.replaceChildren();
  document.querySelector("#stat-today-checkups").textContent = "—";
  document.querySelector("#stat-active-employees").textContent = "—";
  document.querySelector("#stat-coverage-percent").textContent = "—";
  document.querySelector("#stat-coverage-bar").style.width = "0%";
  document.querySelector("#stat-coverage-bar").parentElement.setAttribute("aria-valuenow", "0");
  document.querySelector("#stat-fit").textContent = "—";
  document.querySelector("#stat-observe").textContent = "—";
  document.querySelector("#stat-rest").textContent = "—";
  resultCard.replaceChildren();
  resultCard.classList.add("hidden");
  checkupForm.classList.remove("hidden");
  checkupProgress.classList.remove("hidden");
  departmentSelect.disabled = false;
  employeeSelect.disabled = false;
  departmentSelect.value = "";
  employeeSelect.value = "";
  loginScreen.classList.add("hidden");
  loginScreen.classList.remove("flex");
  appShell.classList.remove("hidden");
  document.querySelector("#today-label").textContent = "Input checkup tanpa login";
  const loginButton = document.querySelector("#signout-button");
  loginButton.innerHTML = '<i data-lucide="log-in"></i>';
  loginButton.setAttribute("aria-label", "Masuk sebagai HR atau admin");
  loginButton.title = "Masuk sebagai HR atau admin";
  document.querySelector("#guest-mode-notice").classList.remove("hidden");
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    if (button.dataset.tabTarget !== "checkup") button.classList.add("hidden");
  });
  document.querySelector('[data-tab-target="profile"]').classList.remove("hidden");
  setTab("checkup", false);
  document.querySelector("#daily-coverage-card").classList.add("hidden");
  appShell.classList.add("guest-mode");
  document.querySelector("#profile-add-employee").disabled =
    !ALLOW_GUEST_EMPLOYEE_CREATION || !guestEmployeeCreationEnabled;
  document.querySelector("#checkup-whatsapp-wrap").classList.remove("hidden");
  document.querySelector("#checkup-whatsapp").required = true;
  await loadGuestDirectory();
  guestProfile = readGuestProfile();
  if (
    guestProfile
    && departments.some((department) => department.id === guestProfile.departmentId)
    && employees.some((employee) =>
      employee.id === guestProfile.employeeId
      && employee.department_id === guestProfile.departmentId
      && employee.is_active
    )
    && isValidWhatsApp(guestProfile.whatsapp)
  ) {
    if (!persistGuestProfile(guestProfile)) {
      showCheckupForm(1);
      refreshIcons();
      return;
    }
    syncGuestProfileToCheckup();
    syncGuestProfileForm();
    try {
      const dailyCheckup = await loadGuestDailyStatus();
      if (dailyCheckup) {
        showDailyCheckupStatus(dailyCheckup);
      } else {
        const restored = restoreCheckupDraft(guestProfile.employeeId);
        showCheckupForm(restored ? activeStep : 2);
      }
    } catch (error) {
      console.error("Could not load this device's daily checkup:", error);
      showToast(`Gagal memeriksa status checkup hari ini: ${error.message}`, true);
      const restored = restoreCheckupDraft(guestProfile.employeeId);
      showCheckupForm(restored ? activeStep : 2);
    }
  } else {
    guestProfile = null;
    syncGuestProfileForm();
    renderCheckupIdentitySummary();
    setActiveStep(1);
  }
  refreshIcons();
}

async function showLogin() {
  appShell.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginScreen.classList.add("flex");
  document.querySelector("#guest-mode-button").classList.toggle("hidden", !ALLOW_GUEST_CHECKUPS);
}

async function handleLogin(event) {
  event.preventDefault();
  const button = document.querySelector("#login-form button[type=submit]");
  setBusy(button, true, "Memeriksa akun…");
  try {
    const email = document.querySelector("#login-email").value.trim();
    const password = document.querySelector("#login-password").value;
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await initializeApp(data.user);
    showToast("Berhasil masuk.");
  } catch (error) {
    console.error("Sign in failed:", error);
    showToast(`Gagal masuk: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

async function handleSignOut() {
  if (guestMode) {
    guestMode = false;
    guestProfile = null;
    await showLogin();
    return;
  }
  if (realtimeChannel) {
    await client.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  const { error } = await client.auth.signOut();
  if (error) {
    console.error("Sign out failed:", error);
    showToast(`Gagal keluar: ${error.message}`, true);
    return;
  }
  currentUser = null;
  currentProfile = null;
  currentEmployeeId = null;
  guestMode = false;
  departments = [];
  employees = [];
  checkups = [];
  historyList.replaceChildren();
  resultCard.replaceChildren();
  guestProfile = null;
  await initializeGuestApp();
}

function bindEvents() {
  document.querySelector("#login-form").addEventListener("submit", handleLogin);
  document.querySelector("#signout-button").addEventListener("click", handleSignOut);
  document.querySelector("#guest-mode-button").addEventListener("click", async () => {
    try {
      await initializeGuestApp();
    } catch (error) {
      console.error("Guest mode initialization failed:", error);
      showToast(`Mode tanpa login gagal dimulai: ${error.message}`, true);
    }
  });
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tabTarget));
  });
  document.querySelectorAll("[data-next]").forEach((button) => {
    button.addEventListener("click", () => {
      if (validateStep(activeStep)) {
        setActiveStep(Math.min(3, activeStep + 1));
        saveCheckupDraft();
      }
    });
  });
  document.querySelectorAll("[data-prev]").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveStep(Math.max(1, activeStep - 1));
      saveCheckupDraft();
    });
  });
  departmentSelect.addEventListener("change", updateEmployeeOptions);
  departmentSelect.addEventListener("change", () => {
    if (guestMode) saveCheckupIdentityIfComplete();
  });
  departmentSelect.addEventListener("change", () => {
    resetCheckupResponses();
    persistCheckupSelection();
  });
  departmentSelect.addEventListener("change", checkSelectedGuestDailyStatus);
  departmentSelect.addEventListener("change", checkAdminSelectedEmployeeDailyStatus);
  employeeSelect.addEventListener("change", () => {
    if (guestMode) saveCheckupIdentityIfComplete();
  });
  employeeSelect.addEventListener("change", () => {
    resetCheckupResponses();
    persistCheckupSelection();
    restoreCheckupDraft(employeeSelect.value);
  });
  employeeSelect.addEventListener("change", checkAdminSelectedEmployeeDailyStatus);
  employeeSelect.addEventListener("change", checkSelectedGuestDailyStatus);
  document.querySelector("#edit-checkup-identity").addEventListener("click", () => {
    if (guestMode) {
      setTab("profile");
    } else if (isAdmin()) {
      setTab("profile");
    }
  });
  document.querySelector("#checkup-whatsapp").addEventListener("input", () => {
    saveCheckupIdentityIfComplete();
    if (guestMode && !isValidWhatsApp(document.querySelector("#checkup-whatsapp").value)) {
      guestStatusRequest += 1;
      showGuestCheckupEntry();
      showCheckupForm(1);
    }
  });
  document.querySelector("#checkup-whatsapp").addEventListener("change", checkSelectedGuestDailyStatus);
  document.querySelector("#profile-department").addEventListener("change", () => {
    updateProfileEmployeeOptions();
  });
  document.querySelector("#profile-employee").addEventListener("change", () => {
    const employee = employees.find((item) => item.id === document.querySelector("#profile-employee").value);
    if (employee) {
      document.querySelector("#profile-department").value = employee.department_id;
    }
  });
  document.querySelector("#guest-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const departmentId = document.querySelector("#profile-department").value;
    const employeeId = document.querySelector("#profile-employee").value;
    const whatsapp = document.querySelector("#profile-whatsapp").value;
    if (!employees.some((employee) => employee.id === employeeId && employee.department_id === departmentId)) {
      showToast("Pilih nama karyawan yang sesuai dengan departemen.", true);
      return;
    }
    if (!isValidWhatsApp(whatsapp)) {
      showToast("Masukkan nomor WhatsApp yang valid, misalnya 081234567890.", true);
      return;
    }
    const savedProfile = { departmentId, employeeId, whatsapp };
    if (guestProfile?.deviceToken) savedProfile.deviceToken = guestProfile.deviceToken;
    if (!persistGuestProfile(savedProfile, true)) return;
    syncGuestProfileToCheckup();
    try {
      const dailyCheckup = await loadGuestDailyStatus();
      if (dailyCheckup) {
        showDailyCheckupStatus(dailyCheckup);
      } else {
        const restored = restoreCheckupDraft(employeeId);
        showCheckupForm(restored ? activeStep : 2);
      }
    } catch (error) {
      console.error("Could not load this device's daily checkup:", error);
      showToast(`Profil tersimpan, tetapi status checkup gagal dimuat: ${error.message}`, true);
      const restored = restoreCheckupDraft(employeeId);
      showCheckupForm(restored ? activeStep : 2);
    }
    setTab("checkup");
  });
  document.querySelector("#clear-guest-profile").addEventListener("click", () => {
    try {
      guestStatusRequest += 1;
      clearGuestCheckupDrafts();
      localStorage.removeItem(guestProfileStorageKey);
      guestProfile = null;
      checkupForm.classList.remove("hidden");
      checkupProgress.classList.remove("hidden");
      resultCard.replaceChildren();
      resultCard.classList.add("hidden");
      departmentSelect.value = "";
      updateEmployeeOptions();
      document.querySelector("#checkup-whatsapp").value = "";
      document.querySelector("#profile-department").value = "";
      updateProfileEmployeeOptions();
      document.querySelector("#profile-whatsapp").value = "";
      setActiveStep(1);
      setTab("checkup");
      showToast("Profil perangkat berhasil dihapus.");
    } catch (error) {
      console.error("Could not clear guest profile from this browser:", error);
      showToast("Profil gagal dihapus. Periksa pengaturan penyimpanan browser.", true);
    }
  });
  document.querySelector("#temperature").addEventListener("input", updateTemperatureDisplay);
  checkupForm.addEventListener("input", (event) => {
    if (isCheckupDraftField(event.target)) saveCheckupDraft();
  });
  checkupForm.addEventListener("change", (event) => {
    if (isCheckupDraftField(event.target)) saveCheckupDraft();
  });
  checkupForm.addEventListener("submit", submitCheckup);
  document.querySelector("#open-employee-modal").addEventListener("click", () => {
    const canAddAsGuest = guestMode && ALLOW_GUEST_EMPLOYEE_CREATION && guestEmployeeCreationEnabled;
    if (!isAdmin() && !canAddAsGuest) {
      showToast("Hubungi HR untuk menambahkan karyawan.", true);
      return;
    }
    const departmentId = guestMode && !document.querySelector("#profile-tab").classList.contains("hidden")
      ? document.querySelector("#profile-department").value
      : departmentSelect.value;
    openEmployeeModal(departmentId, canAddAsGuest);
  });
  document.querySelector("#profile-add-employee").addEventListener("click", () => {
    if (!guestMode || !ALLOW_GUEST_EMPLOYEE_CREATION || !guestEmployeeCreationEnabled) {
      showToast("Penambahan nama belum diaktifkan.", true);
      return;
    }
    const departmentId = document.querySelector("#profile-department").value;
    if (!departmentId) {
      showToast("Pilih departemen terlebih dahulu.", true);
      return;
    }
    openEmployeeModal(departmentId, true);
  });
  document.querySelector("#close-employee-modal").addEventListener("click", () => employeeModal.close());
  employeeModal.addEventListener("click", (event) => {
    if (event.target === employeeModal) employeeModal.close();
  });
  document.querySelector("#employee-form").addEventListener("submit", addEmployee);
  document.querySelector("#apply-filters").addEventListener("click", () => {
    loadCheckups().catch((error) => {
      console.error("Checkup filter failed:", error);
      showToast(`Gagal memuat filter: ${error.message}`, true);
    });
  });
  document.querySelector("#filter-from").addEventListener("change", () => {
    loadCheckups().catch((error) => {
      console.error("Date from filter failed:", error);
      showToast(`Gagal memuat filter tanggal: ${error.message}`, true);
    });
  });
  document.querySelector("#filter-to").addEventListener("change", () => {
    loadCheckups().catch((error) => {
      console.error("Date to filter failed:", error);
      showToast(`Gagal memuat filter tanggal: ${error.message}`, true);
    });
  });
  document.querySelector("#history-department").addEventListener("change", () => {
    loadCheckups().catch((error) => {
      console.error("Department filter failed:", error);
      showToast(`Gagal memuat filter departemen: ${error.message}`, true);
    });
  });
  document.querySelector("#history-readiness").addEventListener("change", () => {
    loadCheckups().catch((error) => {
      console.error("Readiness filter failed:", error);
      showToast(`Gagal memuat filter status: ${error.message}`, true);
    });
  });
  document.querySelectorAll("[data-summary-filter]").forEach((card) => {
    card.addEventListener("click", () => openSummaryFilter(card.dataset.summaryFilter));
  });
  document.querySelector("#export-csv").addEventListener("click", exportCsv);
  document.querySelector("#close-export-modal")?.addEventListener("click", () => exportConfirmModal.close());
  document.querySelector("#cancel-export-modal")?.addEventListener("click", () => exportConfirmModal.close());
  exportConfirmModal?.addEventListener("click", (event) => {
    if (event.target === exportConfirmModal) exportConfirmModal.close();
  });
  document.querySelector("#confirm-export-only")?.addEventListener("click", () => {
    exportConfirmModal.close();
    triggerCsvDownload(checkups);
    showToast("File CSV riwayat berhasil diunduh.");
  });
  document.querySelector("#confirm-export-and-delete")?.addEventListener("click", async () => {
    const button = document.querySelector("#confirm-export-and-delete");
    setBusy(button, true, "Mengekspor & menghapus…");
    try {
      const itemsToDelete = [...checkups];
      const idsToDelete = itemsToDelete.map((item) => item.id);
      if (!idsToDelete.length) {
        showToast("Tidak ada data untuk dihapus.", true);
        exportConfirmModal.close();
        return;
      }

      // 1. Unduh berkas CSV terlebih dahulu
      triggerCsvDownload(itemsToDelete);

      // 2. Beri jeda singkat agar browser memproses unduhan
      await new Promise((resolve) => window.setTimeout(resolve, 600));

      // 3. Panggil RPC Supabase untuk menghapus data di database
      const { data, error } = await client.rpc("delete_checkups", {
        p_checkup_ids: idsToDelete
      });
      if (error) throw error;

      const deletedCount = (Array.isArray(data) ? data[0]?.deleted_count : data?.deleted_count) ?? idsToDelete.length;

      // 4. Tutup modal & segarkan tampilan riwayat serta ringkasan
      exportConfirmModal.close();
      await loadCheckups();
      if (isAdmin()) await loadDailyCoverage();

      showToast(`File CSV berhasil diunduh dan ${deletedCount} riwayat berhasil dihapus.`);
    } catch (error) {
      console.error("Gagal menghapus riwayat checkup:", error);
      showToast(`Gagal menghapus riwayat: ${error.message}`, true);
    } finally {
      setBusy(button, false);
    }
  });

  window.addEventListener("online", () => {
    updateNetworkAndQueueUI();
    syncOfflineQueue(false);
  });
  window.addEventListener("offline", () => {
    updateNetworkAndQueueUI();
  });
  offlineQueueBadge?.addEventListener("click", openQueueModal);
  manualSyncButton?.addEventListener("click", () => syncOfflineQueue(true));
  triggerSyncBtn?.addEventListener("click", () => syncOfflineQueue(true));
  closeQueueModalBtn?.addEventListener("click", () => queueModal?.close());
  closeQueueBtn?.addEventListener("click", () => queueModal?.close());
}
async function boot() {
  bindEvents();
  updateTemperatureDisplay();
  setActiveStep(1);
  refreshIcons();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("ServiceWorker registration failed:", err);
    });
  }

  await updateNetworkAndQueueUI();
  if (navigator.onLine) {
    syncOfflineQueue(false);
  }

  if (!supabaseFactory) {
    await showLogin();
    showToast("Supabase SDK gagal dimuat dari CDN.", true);
    return;
  }
  if (SUPABASE_URL.includes("YOUR_PROJECT_ID") || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
    await showLogin();
    showToast("Isi URL dan anon/publishable key Supabase di config.js.", true);
    return;
  }
  client = supabaseFactory(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  await syncAppTimezone();

  client.auth.onAuthStateChange((_event, session) => {
    if (!session) {
      currentUser = null;
      currentProfile = null;
      showLogin();
    }
  });
  const { data, error } = await client.auth.getSession();
  if (error) {
    console.error("Session restore failed:", error);
    await showLogin();
    showToast(`Gagal memulihkan sesi: ${error.message}`, true);
    return;
  }
  if (data.session) {
    try {
      await initializeApp(data.session.user);
    } catch (initializationError) {
      console.error("App initialization failed:", initializationError);
      await showLogin();
      showToast(`Gagal memuat aplikasi: ${initializationError.message}`, true);
    }
  } else {
    if (ALLOW_GUEST_CHECKUPS) {
      try {
        await initializeGuestApp();
      } catch (guestError) {
        console.error("Guest mode initialization failed:", guestError);
        await showLogin();
        showToast(`Mode tanpa login gagal dimulai: ${guestError.message}`, true);
      }
    } else {
      await showLogin();
    }
  }
}

boot().catch((error) => {
  console.error("Application startup failed:", error);
  showLogin();
  showToast(`Aplikasi gagal dimulai: ${error.message}`, true);
});
