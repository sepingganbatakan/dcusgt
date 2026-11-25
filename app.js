import {
  ALLOW_GUEST_CHECKUPS,
  APP_TIMEZONE,
  DEFAULT_EMPLOYEE_DISPLAY_LIMIT,
  DEPARTMENT_SELECTION_MODE,
  EMPLOYEE_SELECTION_MODE,
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

function getSupabaseFactory() {
  return window.supabase?.createClient;
}
const loginScreen = document.querySelector("#login-screen");
const appShell = document.querySelector("#app-shell");
const loggedInIdentity = document.querySelector("#logged-in-identity");
const toastElement = document.querySelector("#toast");
const startupScreen = document.querySelector("#startup-screen");
const startupMessage = document.querySelector("#startup-message");
const startupRetryButton = document.querySelector("#startup-retry-button");
const privacyNoticeModal = document.querySelector("#privacy-notice-modal");
const changePasswordModal = document.querySelector("#change-password-modal");
const departmentSelect = document.querySelector("#department-select");
const employeeSelect = document.querySelector("#employee-select");
const checkupForm = document.querySelector("#checkup-form");
const checkupProgress = document.querySelector("#checkup-progress");
const resultCard = document.querySelector("#result-card");
const employeeModal = document.querySelector("#employee-modal");
const employeeEditModal = document.querySelector("#employee-edit-modal");
const checkupConfirmModal = document.querySelector("#checkup-confirm-modal");
const exportConfirmModal = document.querySelector("#export-confirm-modal");
const missingDcuModal = document.querySelector("#missing-dcu-modal");
const historyList = document.querySelector("#history-list");
const offlineQueueBadge = document.querySelector("#offline-queue-badge");
const syncIcon = document.querySelector("#sync-icon");
const queueCountBadge = document.querySelector("#queue-count");
const manualSyncButton = document.querySelector("#manual-sync-button");
const queueModal = document.querySelector("#queue-modal");
const adminSettingsFields = document.querySelector("#admin-settings-fields");
const hrSettingsFields = document.querySelector("#hr-settings-fields");
const hrSettingsPermissions = document.querySelector("#hr-settings-permissions");
const closeQueueModalBtn = document.querySelector("#close-queue-modal");
const closeQueueBtn = document.querySelector("#close-queue-btn");
const triggerSyncBtn = document.querySelector("#trigger-sync-btn");
const queueList = document.querySelector("#queue-list");
const guestProfileStorageKey = "daily-checkup-guest-profile-v1";
const checkupDraftStoragePrefix = "daily-checkup-draft-v1";
const substanceQuestionKeys = {
  medication: "medication_consumption_24h",
  alcohol: "alcohol_consumption_24h"
};

let client;
let currentUser;
let currentProfile;
let adminSettings = [];
let adminSettingsLoaded = false;
let hrSettingsAccessConfig = { enabled: false, allowed_settings: [], allowed_features: [] };
let hrSettingsAccessConfigLoaded = false;
let hrSettings = [];
let hrSettingsLoaded = false;
let adminHrMenuVisibility = { profile_admin: true, profile_hr: true, checkup: true };
let adminHrMenuVisibilityLoaded = false;
let hrEmployeeCreationEnabled = false;
let linkedAccountEmployeeId = null;
let currentEmployeeId;
let currentDepartmentId;
let privacyGatePassed = false;
let guestMode = false;
let guestEmployeeCreationEnabled = false;
let guestProfile = null;
let departments = [];
let subdepartments = [];
let subdepartmentSupervisors = [];
let employees = [];
let employeeManagementEmployees = [];
let employeeManagementSelectedId = "";
let employeeManagementDepartmentId = "all";
let checkups = [];
let todayCheckupCount = null;
let todayReadinessCounts = null;
let activeEmployeeCount = null;
let employeesWithoutTodayCheckup = null;
let selectedMissingDcuDepartmentId = "";
let activeStep = 1;
let toastTimeout;
let realtimeChannel;
let draftStorageErrorNotified = false;
let isSyncing = false;
let guestStatusRequest = 0;
let activeTimezone = (typeof APP_TIMEZONE === "string" && APP_TIMEZONE.trim())
  ? APP_TIMEZONE.trim()
  : "Asia/Jakarta";
let waNotificationsEnabled = false;
let waEmployeeTemplate = "";
let checkupLocationEnabled = false;
let measurementProviderEnabled = false;
let measurementProviderNames = [];
let substanceQuestionSettings = { enabled: false, departments: [], jobTitles: [] };
let substanceQuestionSettingsLoaded = false;
let checkupPageCount = 3;
let employeeDisplayLimit = (typeof DEFAULT_EMPLOYEE_DISPLAY_LIMIT === "number" && DEFAULT_EMPLOYEE_DISPLAY_LIMIT > 0)
  ? DEFAULT_EMPLOYEE_DISPLAY_LIMIT
  : 4;
const HR_FEATURES = [
  { key: "employee_data", label: "Mengubah data pekerja" },
  { key: "subdepartments", label: "Menambah atau menghapus subfungsi" },
  { key: "supervisors", label: "Menambah atau menghapus pengawas subfungsi" },
  { key: "employee_subdepartment", label: "Menetapkan subfungsi pekerja" }
];

if (!["tabs", "dropdown"].includes(DEPARTMENT_SELECTION_MODE)) {
  throw new Error('DEPARTMENT_SELECTION_MODE must be "tabs" or "dropdown".');
}
if (!["list", "dropdown"].includes(EMPLOYEE_SELECTION_MODE)) {
  throw new Error('EMPLOYEE_SELECTION_MODE must be "list" or "dropdown".');
}

function updateSleepHoursDisplay() {
  const input = document.querySelector("#sleep-hours");
  if (!input) return;
  const sleepHours = Number(input.value);
  const value = document.querySelector("#sleep-hours-value");
  const hint = document.querySelector("#sleep-hours-hint");
  value.textContent = `${sleepHours.toFixed(1).replace(/\.0$/, "")} jam`;
  value.className = sleepHours < 3
    ? "rounded-lg bg-rose-50 px-2.5 py-1 text-sm font-bold text-rose-700"
    : sleepHours <= 5
      ? "rounded-lg bg-amber-50 px-2.5 py-1 text-sm font-bold text-amber-700"
      : sleepHours <= 7
        ? "rounded-lg bg-emerald-50 px-2.5 py-1 text-sm font-bold text-emerald-700"
        : sleepHours <= 9
          ? "rounded-lg bg-cyan-50 px-2.5 py-1 text-sm font-bold text-cyan-700"
          : "rounded-lg bg-blue-50 px-2.5 py-1 text-sm font-bold text-blue-700";
  hint.textContent = sleepHours < 3
    ? "Kurang dari 3 jam — hentikan aktifitas dan segera istirahat."
    : sleepHours <= 5
      ? "3 – 5 jam — direkomendasikan istirahat cukup."
      : sleepHours <= 7
        ? "5 – 7 jam — lakukan istirahat berkala."
        : sleepHours <= 9
          ? "7 – 9 jam — dapat beraktifitas seperti biasa."
          : "di atas 9 jam — sesuaikan istirahat sesuai kebutuhan.";
}

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

async function syncWhatsAppNotificationSetting() {
  if (!client) return;
  try {
    const { data, error } = await client.rpc("get_wa_notifications_enabled");
    if (error) throw error;
    if (typeof data !== "boolean") {
      throw new Error("Supabase returned an invalid WhatsApp notification setting.");
    }
    waNotificationsEnabled = data;
  } catch (err) {
    console.warn("Could not sync WhatsApp notification setting; keeping the current value:", err);
  }
}

async function syncWAEmployeeTemplate() {
  if (!client) return;
  try {
    const { data, error } = await client.rpc("get_wa_template_employee");
    if (!error && typeof data === "string" && data.trim()) {
      waEmployeeTemplate = data;
    }
  } catch (err) {
    console.warn("Could not sync WhatsApp employee template; using the default template:", err);
  }
}

function applyCheckupLocationSettingUI() {
  document.querySelector("#checkup-location-notice")
    ?.classList.toggle("hidden", !checkupLocationEnabled);
}

function getLastCheckupStep() {
  if (checkupPageCount === 1) return 2;
  if (checkupPageCount === 2 || !measurementProviderEnabled) return 3;
  return 4;
}

function applyCheckupPageLayoutUI() {
  const physicalStep = document.querySelector("#checkup-physical-step");
  const symptomsStep = document.querySelector("#checkup-symptoms-step");
  const providerStep = document.querySelector("#measurement-provider-step");
  const providerSelect = document.querySelector("#measurement-provider");
  const providerEmptyNotice = document.querySelector("#measurement-provider-empty");
  const stepThreeNextButton = document.querySelector("#checkup-step3-next");
  const stepThreeSubmitButton = document.querySelector("#submit-checkup");
  const physicalNavigation = document.querySelector("#checkup-step2-navigation");
  const physicalPreviousButton = document.querySelector("#checkup-step2-prev");
  const symptomsNavigation = document.querySelector("#checkup-step3-navigation");
  const symptomsPreviousButton = document.querySelector("#checkup-step3-prev");
  const providerAnchor = document.querySelector("#measurement-provider-step-anchor");
  const providerNavigation = document.querySelector("#measurement-provider-navigation");
  const providerPreviousButton = document.querySelector("#measurement-provider-prev");

  if (
    !physicalStep || !symptomsStep || !providerStep || !providerSelect
    || !stepThreeNextButton || !stepThreeSubmitButton || !physicalNavigation
    || !physicalPreviousButton
    || !symptomsNavigation || !symptomsPreviousButton || !providerAnchor
    || !providerNavigation || !providerPreviousButton
  ) return;

  const selectedProvider = providerSelect.value;
  providerSelect.replaceChildren(new Option("Pilih tenaga medis", ""));
  for (const name of measurementProviderNames) {
    providerSelect.add(new Option(name, name));
  }
  providerSelect.value = measurementProviderNames.includes(selectedProvider) ? selectedProvider : "";
  symptomsStep.dataset.step = checkupPageCount === 1 ? "2" : "3";
  providerStep.dataset.step = checkupPageCount === 1 || checkupPageCount === 2
    ? String(checkupPageCount === 1 ? 2 : 3)
    : "4";
  if (checkupPageCount < 3) {
    symptomsStep.insertBefore(providerStep, symptomsNavigation);
  } else {
    providerAnchor.after(providerStep);
  }
  providerStep.classList.toggle("hidden", !measurementProviderEnabled);
  providerEmptyNotice?.classList.toggle("hidden", measurementProviderNames.length > 0);
  physicalNavigation.classList.toggle("hidden", checkupPageCount === 1);
  physicalPreviousButton.classList.add("hidden");
  physicalNavigation.classList.toggle("grid-cols-1", true);
  physicalNavigation.classList.toggle("grid-cols-2", false);
  symptomsPreviousButton.classList.toggle("hidden", checkupPageCount === 1);
  stepThreeNextButton.classList.toggle("hidden", !measurementProviderEnabled || checkupPageCount !== 3);
  stepThreeSubmitButton.classList.toggle("hidden", measurementProviderEnabled && checkupPageCount === 3);
  symptomsNavigation.classList.toggle("grid-cols-1", checkupPageCount === 1);
  symptomsNavigation.classList.toggle("grid-cols-2", checkupPageCount !== 1);
  providerNavigation.classList.toggle("hidden", checkupPageCount !== 3);
  providerPreviousButton.classList.toggle("hidden", checkupPageCount !== 3);
  providerNavigation.classList.toggle("grid-cols-1", false);
  providerNavigation.classList.toggle("grid-cols-2", true);
  if (activeStep > getLastCheckupStep()) setActiveStep(getLastCheckupStep());
  else setActiveStep(activeStep);
}

async function syncCheckupPageCountSetting() {
  if (!client) return;
  try {
    const { data, error } = await client.rpc("get_dcu_page_count");
    if (error) throw error;
    if (![1, 2, 3].includes(data)) {
      throw new Error("Supabase mengembalikan jumlah halaman DCU yang tidak valid.");
    }
    checkupPageCount = data;
  } catch (error) {
    console.warn("Could not sync DCU page count; using the default layout:", error);
    checkupPageCount = 3;
  }
  applyCheckupPageLayoutUI();
}

async function syncMeasurementProviderSetting() {
  if (!client) return;
  try {
    const { data, error } = await client.rpc("get_measurement_provider_settings");
    if (error) throw error;
    if (
      !data
      || typeof data.enabled !== "boolean"
      || !Array.isArray(data.names)
      || data.names.some((name) => typeof name !== "string")
    ) {
      throw new Error("Supabase mengembalikan konfigurasi tenaga medis dengan format yang tidak valid.");
    }
    measurementProviderEnabled = data.enabled;
    measurementProviderNames = [...new Set(data.names.map((name) => name.trim()).filter(Boolean))];
  } catch (error) {
    console.warn("Could not sync measurement provider settings; hiding the provider step:", error);
    measurementProviderEnabled = false;
    measurementProviderNames = [];
  }
  applyCheckupPageLayoutUI();
}

function normalizeConfiguredCategories(values) {
  return [...new Set(values.map((value) => value.trim().toLocaleLowerCase("id-ID")).filter(Boolean))];
}

function isSubstanceQuestionEligible(employee) {
  if (!employee) return false;
  if (!substanceQuestionSettingsLoaded) return null;
  if (!substanceQuestionSettings.enabled) return false;

  const departmentName = departments.find((department) => department.id === employee.department_id)?.name;
  if (typeof employee.job_title === "string" && departmentName) {
    const departmentMatches = normalizeConfiguredCategories(substanceQuestionSettings.departments)
      .includes(departmentName.trim().toLocaleLowerCase("id-ID"));
    const jobTitleMatches = normalizeConfiguredCategories(substanceQuestionSettings.jobTitles)
      .includes(employee.job_title.trim().toLocaleLowerCase("id-ID"));
    return departmentMatches && jobTitleMatches;
  }

  if (typeof employee.requires_substance_questions === "boolean") {
    return employee.requires_substance_questions;
  }
  return null;
}

function updateSubstanceQuestionVisibility() {
  const section = document.querySelector("#substance-question-wrap");
  const warning = document.querySelector("#substance-question-config-warning");
  if (!section || !warning) return;

  const employee = employees.find((item) => item.id === employeeSelect.value);
  const eligible = isSubstanceQuestionEligible(employee);
  section.classList.toggle("hidden", eligible !== true);
  warning.classList.toggle("hidden", eligible !== null || !employee);
  for (const input of checkupForm.querySelectorAll('input[name="substance_medication_24h"], input[name="substance_alcohol_24h"]')) {
    if (eligible === false) input.checked = false;
  }
  updateSubstanceQuestionStates();
}

function updateSubstanceQuestionStates() {
  for (const [name, statusId] of [
    ["substance_medication_24h", "substance-medication-status"],
    ["substance_alcohol_24h", "substance-alcohol-status"]
  ]) {
    const input = checkupForm.querySelector(`input[name="${name}"]`);
    const status = document.querySelector(`#${statusId}`);
    if (!input || !status) continue;
    status.textContent = input.checked ? "Ya" : "Tidak";
    input.setAttribute("aria-checked", String(input.checked));
  }
}

async function syncSubstanceQuestionSettings() {
  if (!client) return false;
  try {
    const { data, error } = await client.rpc("get_dcu_substance_questions_config");
    if (error) throw error;
    if (
      !data
      || typeof data.enabled !== "boolean"
      || !Array.isArray(data.departments)
      || data.departments.some((value) => typeof value !== "string")
      || !Array.isArray(data.job_titles)
      || data.job_titles.some((value) => typeof value !== "string")
    ) {
      throw new Error("Supabase mengembalikan konfigurasi pertanyaan konsumsi dengan format yang tidak valid.");
    }

    substanceQuestionSettings = {
      enabled: data.enabled,
      departments: [...new Set(data.departments.map((value) => value.trim()).filter(Boolean))],
      jobTitles: [...new Set(data.job_titles.map((value) => value.trim()).filter(Boolean))]
    };
    substanceQuestionSettingsLoaded = true;
    saveCachedAppSettings();
    updateSubstanceQuestionVisibility();
    return true;
  } catch (error) {
    console.error("Could not sync substance question settings:", error);
    if (!substanceQuestionSettingsLoaded) {
      showToast(`Konfigurasi pertanyaan konsumsi belum tersedia. Hubungkan ke internet atau jalankan migrasi terkait: ${error.message}`, true);
    }
    return false;
  }
}

async function syncCheckupLocationSetting() {
  if (!client) return checkupLocationEnabled;
  try {
    const { data, error } = await client.rpc("get_checkup_location_enabled");
    if (error) throw error;
    if (typeof data !== "boolean") {
      throw new Error("Supabase returned an invalid checkup location setting.");
    }
    checkupLocationEnabled = data;
  } catch (err) {
    console.warn("Could not sync checkup location setting; disabling location capture:", err);
    checkupLocationEnabled = false;
  }
  applyCheckupLocationSettingUI();
  return checkupLocationEnabled;
}

function getDeviceLocation() {
  if (!navigator.geolocation) {
    showToast("Lokasi perangkat tidak tersedia. Checkup tetap akan disimpan tanpa lokasi.", true);
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        ({ coords, timestamp }) => {
          if (
            !Number.isFinite(coords.latitude)
            || !Number.isFinite(coords.longitude)
            || !Number.isFinite(coords.accuracy)
            || coords.accuracy < 0
          ) {
            showToast("Koordinat lokasi tidak valid. Checkup tetap akan disimpan tanpa lokasi.", true);
            resolve(null);
            return;
          }

          resolve({
            location_latitude: coords.latitude,
            location_longitude: coords.longitude,
            location_accuracy_m: coords.accuracy,
            location_captured_at: new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString()
          });
        },
        (error) => {
          const reason = error.code === error.PERMISSION_DENIED
            ? "Izin lokasi ditolak."
            : error.code === error.POSITION_UNAVAILABLE
              ? "Lokasi perangkat tidak dapat ditentukan."
              : "Pengambilan lokasi melewati batas waktu.";
          showToast(`${reason} Checkup tetap akan disimpan tanpa lokasi.`, true);
          resolve(null);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    } catch (error) {
      console.warn("Could not request device location:", error);
      showToast("Lokasi perangkat tidak dapat diminta. Checkup tetap akan disimpan tanpa lokasi.", true);
      resolve(null);
    }
  });
}

function applyEmployeeDisplayLimitUI() {
  const wrap = document.querySelector("#employee-list-scroll-wrap");
  if (wrap) {
    wrap.style.setProperty("--visible-limit", String(employeeDisplayLimit));
  }
}

async function syncEmployeeDisplayLimit() {
  if (!client) return;
  try {
    const { data, error } = await client.rpc("get_employee_display_limit");
    if (!error && typeof data === "number" && data > 0) {
      employeeDisplayLimit = data;
    }
  } catch (err) {
    console.warn("Could not sync employee display limit from database, using fallback:", err);
  }
  applyEmployeeDisplayLimitUI();
}

const SETTINGS_CACHE_KEY = "sgt_dcu_settings_cache_v1";

function loadCachedAppSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw);
    if (cached.activeTimezone && typeof cached.activeTimezone === "string") {
      activeTimezone = cached.activeTimezone;
    }
    if (typeof cached.waNotificationsEnabled === "boolean") {
      waNotificationsEnabled = cached.waNotificationsEnabled;
    }
    if (typeof cached.checkupLocationEnabled === "boolean") {
      checkupLocationEnabled = cached.checkupLocationEnabled;
      applyCheckupLocationSettingUI();
    }
    if (typeof cached.measurementProviderEnabled === "boolean" && Array.isArray(cached.measurementProviderNames)) {
      measurementProviderEnabled = cached.measurementProviderEnabled;
      measurementProviderNames = cached.measurementProviderNames;
    }
    if (
      cached.substanceQuestionSettings
      && typeof cached.substanceQuestionSettings.enabled === "boolean"
      && Array.isArray(cached.substanceQuestionSettings.departments)
      && cached.substanceQuestionSettings.departments.every((value) => typeof value === "string")
      && Array.isArray(cached.substanceQuestionSettings.jobTitles)
      && cached.substanceQuestionSettings.jobTitles.every((value) => typeof value === "string")
    ) {
      substanceQuestionSettings = cached.substanceQuestionSettings;
      substanceQuestionSettingsLoaded = true;
    }
    if ([1, 2, 3].includes(cached.checkupPageCount)) {
      checkupPageCount = cached.checkupPageCount;
    }
    if (typeof cached.employeeDisplayLimit === "number" && cached.employeeDisplayLimit > 0) {
      employeeDisplayLimit = cached.employeeDisplayLimit;
      applyEmployeeDisplayLimitUI();
    }
    applyCheckupPageLayoutUI();
  } catch (err) {
    console.warn("Could not load cached app settings:", err);
  }
}

function saveCachedAppSettings() {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({
      activeTimezone,
      waNotificationsEnabled,
      checkupLocationEnabled,
      measurementProviderEnabled,
      measurementProviderNames,
      substanceQuestionSettings,
      checkupPageCount,
      employeeDisplayLimit
    }));
  } catch (err) {
    console.warn("Could not save app settings to cache:", err);
  }
}

async function syncBootstrapSettings() {
  if (!client) return;
  await Promise.allSettled([
    syncAppTimezone(),
    syncWhatsAppNotificationSetting(),
    syncWAEmployeeTemplate(),
    syncCheckupLocationSetting(),
    syncMeasurementProviderSetting(),
    syncSubstanceQuestionSettings(),
    syncCheckupPageCountSetting(),
    syncEmployeeDisplayLimit()
  ]);
  saveCachedAppSettings();
}

const statusDetails = {
  fit_to_work: { label: "Fit Bekerja", pill: "status-fit", result: "result-fit", icon: "shield-check" },
  need_observation: { label: "Perlu Evaluasi Medis", pill: "status-observe", result: "result-observe", icon: "eye" },
  rest_recommended: { label: "Tidak Fit Bekerja", pill: "status-rest", result: "result-rest", icon: "heart-pulse" }
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

function renderSettingsFields(container, settings) {
  container.replaceChildren();
  if (settings.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "panel-card text-sm text-slate-500";
    emptyMessage.textContent = "Belum ada pengaturan yang tersedia. Pastikan migrasi konfigurasi terkait sudah dijalankan.";
    container.append(emptyMessage);
    return;
  }

  for (const setting of settings) {
    const card = document.createElement("div");
    card.className = "panel-card";
    const inputId = `${container.id}-setting-${setting.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const input = setting.type === "textarea"
      ? document.createElement("textarea")
      : setting.type === "select"
        ? document.createElement("select")
        : document.createElement("input");
    input.id = inputId;
    input.dataset.settingKey = setting.key;
    input.className = setting.type === "boolean"
      ? "toggle-input"
      : "field-input mt-2";

    if (setting.type === "boolean") {
      input.type = "checkbox";
      input.checked = setting.value === true;
      input.setAttribute("aria-label", setting.label);
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-3";
      const label = document.createElement("label");
      label.className = "field-label";
      label.htmlFor = inputId;
      label.textContent = setting.label;
      row.append(label, input);
      card.append(row);
    } else {
      const label = document.createElement("label");
      label.className = "field-label";
      label.htmlFor = inputId;
      label.textContent = setting.label;

      if (setting.type === "textarea") {
        input.rows = 4;
        input.value = typeof setting.value === "string" ? setting.value : "";
        if (typeof setting.max_length === "number") {
          input.maxLength = setting.max_length;
        }
      } else if (setting.type === "select") {
        if (!Array.isArray(setting.options)) {
          throw new Error(`Pilihan untuk pengaturan "${setting.key}" tidak valid.`);
        }
        for (const optionValue of setting.options) {
          const option = document.createElement("option");
          option.value = String(optionValue);
          option.textContent = String(optionValue);
          input.append(option);
        }
        input.value = typeof setting.value === "string" ? setting.value : "";
      } else {
        input.type = setting.type === "integer"
          ? "number"
          : setting.type === "time"
            ? "time"
            : "text";
        input.value = setting.value == null ? "" : String(setting.value);
        if (setting.type === "integer") {
          input.step = "1";
          if (typeof setting.min === "number") input.min = String(setting.min);
          if (typeof setting.max === "number") input.max = String(setting.max);
        }
      }
      input.required = setting.required !== false;
      card.append(label, input);
    }

    container.append(card);
  }
  refreshIcons();
}

async function loadAdminSettings(forceReload = false) {
  if (currentProfile?.role !== "admin") {
    throw new Error("Hanya admin yang dapat mengakses pengaturan aplikasi.");
  }
  if (adminSettingsLoaded && !forceReload) return;

  adminSettingsFields.replaceChildren();
  const loadingMessage = document.createElement("p");
  loadingMessage.className = "panel-card text-sm text-slate-500";
  loadingMessage.textContent = "Memuat pengaturan…";
  adminSettingsFields.append(loadingMessage);

  const { data, error } = await client.rpc("get_admin_editable_settings");
  if (error) {
    adminSettingsLoaded = false;
    adminSettingsFields.textContent = `Pengaturan gagal dimuat: ${error.message}`;
    throw error;
  }
  if (!Array.isArray(data)) {
    adminSettingsLoaded = false;
    throw new Error("Supabase mengembalikan daftar pengaturan dengan format yang tidak valid.");
  }
  adminSettings = data;
  adminSettingsLoaded = true;
  renderSettingsFields(adminSettingsFields, adminSettings);
  if (hrSettingsAccessConfigLoaded) renderHrSettingsAccessConfig();
}

async function handleAdminSettingsSave(event) {
  event.preventDefault();
  if (currentProfile?.role !== "admin") {
    showToast("Hanya admin yang dapat mengubah pengaturan aplikasi.", true);
    return;
  }

  const button = document.querySelector("#save-admin-settings");
  const values = Object.create(null);
  for (const input of adminSettingsFields.querySelectorAll("[data-setting-key]")) {
    values[input.dataset.settingKey] = input.type === "checkbox"
      ? input.checked
      : input.type === "number"
        ? Number(input.value)
        : input.value;
  }

  setBusy(button, true, "Menyimpan…");
  try {
    const { error } = await client.rpc("update_admin_editable_settings", { p_values: values });
    if (error) throw error;

    adminSettings = adminSettings.map((setting) => ({
      ...setting,
      value: values[setting.key]
    }));
    showToast("Pengaturan berhasil disimpan.");

    try {
      await refreshRuntimeAfterSettingsSave(values);
    } catch (error) {
      console.error("Saved settings but runtime refresh failed:", error);
      showToast(`Pengaturan tersimpan, tetapi tampilan gagal diperbarui: ${error.message}`, true);
    }
  } catch (error) {
    console.error("Admin settings save failed:", error);
    showToast(`Gagal menyimpan pengaturan: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

async function refreshRuntimeAfterSettingsSave(values) {
  if (Object.hasOwn(values, "app_timezone")) {
    await syncAppTimezone();
    document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("id-ID", {
      timeZone: getActiveTimezone(),
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    }).format(new Date());
    await loadCheckups();
  }
  if (Object.hasOwn(values, "wa_notifications_enabled")) {
    await syncWhatsAppNotificationSetting();
  }
  if (Object.hasOwn(values, "checkup_location_enabled")) {
    await syncCheckupLocationSetting();
  }
  if (Object.hasOwn(values, "measurement_provider_enabled") || Object.hasOwn(values, "measurement_provider_names")) {
    await syncMeasurementProviderSetting();
  }
  if (Object.hasOwn(values, "dcu_page_count")) {
    await syncCheckupPageCountSetting();
  }
  if ([
    "dcu_substance_questions_enabled",
    "dcu_substance_questions_departments",
    "dcu_substance_questions_job_titles"
  ].some((key) => Object.hasOwn(values, key))) {
    if (!await syncSubstanceQuestionSettings()) {
      throw new Error("Pengaturan pertanyaan konsumsi tersimpan, tetapi konfigurasi aktif gagal dimuat.");
    }
    renderEmployeeList(currentCheckupTab);
    updateSubstanceQuestionVisibility();
  }
}

function renderHrSettingsAccessConfig() {
  document.querySelector("#hr-settings-enabled").checked = hrSettingsAccessConfig.enabled;
  hrSettingsPermissions.replaceChildren();
  const featurePermissions = document.querySelector("#hr-settings-features");
  featurePermissions.replaceChildren();

  if (adminSettings.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "text-sm text-slate-500";
    emptyMessage.textContent = "Tidak ada pengaturan tersedia untuk dipilih.";
    hrSettingsPermissions.append(emptyMessage);
  } else {
    for (const setting of adminSettings) {
      const row = document.createElement("label");
      row.className = "flex items-start gap-3 text-sm text-slate-700";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "toggle-input mt-0.5";
      input.dataset.hrSettingKey = setting.key;
      input.checked = hrSettingsAccessConfig.allowed_settings.includes(setting.key);
      const label = document.createElement("span");
      label.textContent = setting.label;
      row.append(input, label);
      hrSettingsPermissions.append(row);
    }
  }

  for (const feature of HR_FEATURES) {
    const row = document.createElement("label");
    row.className = "flex items-start gap-3 text-sm text-slate-700";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "toggle-input mt-0.5";
    input.dataset.hrFeatureKey = feature.key;
    input.checked = hrSettingsAccessConfig.allowed_features.includes(feature.key);
    const label = document.createElement("span");
    label.textContent = feature.label;
    row.append(input, label);
    featurePermissions.append(row);
  }
}

async function loadHrSettingsAccessConfig(forceReload = false) {
  if (!isAdmin()) {
    throw new Error("Hanya admin atau HR yang dapat membaca konfigurasi pengaturan HR.");
  }
  if (hrSettingsAccessConfigLoaded && !forceReload) return;

  const { data, error } = await client.rpc("get_hr_settings_access_config");
  if (error) {
    hrSettingsAccessConfigLoaded = false;
    throw error;
  }
  if (
    !data
    || typeof data.enabled !== "boolean"
    || !Array.isArray(data.allowed_settings)
    || data.allowed_settings.some((key) => typeof key !== "string")
    || !Array.isArray(data.allowed_features)
    || data.allowed_features.some((key) => typeof key !== "string")
  ) {
    hrSettingsAccessConfigLoaded = false;
    throw new Error("Supabase mengembalikan konfigurasi akses pengaturan HR dengan format yang tidak valid.");
  }

  hrSettingsAccessConfig = {
    enabled: data.enabled,
    allowed_settings: [...new Set(data.allowed_settings)],
    allowed_features: [...new Set(data.allowed_features)]
  };
  hrSettingsAccessConfigLoaded = true;
  if (currentProfile?.role === "admin" && adminSettingsLoaded) renderHrSettingsAccessConfig();
  syncHrFeatureAccess();
}

async function loadHrSettings(forceReload = false) {
  if (currentProfile?.role !== "hr") {
    throw new Error("Hanya HR yang dapat mengakses pengaturan HR.");
  }
  if (!hrSettingsAccessConfigLoaded || forceReload) {
    await loadHrSettingsAccessConfig(forceReload);
  }
  if (!hrSettingsAccessConfig.enabled) {
    throw new Error("Akses menu Pengaturan untuk HR sedang dinonaktifkan.");
  }
  const hrSettingsForm = document.querySelector("#hr-settings-form");
  if (hrSettingsLoaded && !forceReload) {
    hrSettingsForm.classList.toggle("hidden", hrSettings.length === 0);
    return;
  }

  hrSettingsForm.classList.remove("hidden");
  hrSettingsFields.replaceChildren();
  const loadingMessage = document.createElement("p");
  loadingMessage.className = "panel-card text-sm text-slate-500";
  loadingMessage.textContent = "Memuat pengaturan…";
  hrSettingsFields.append(loadingMessage);

  const { data, error } = await client.rpc("get_hr_editable_settings");
  if (error) {
    hrSettingsLoaded = false;
    document.querySelector("#save-hr-settings").classList.add("hidden");
    hrSettingsFields.textContent = `Pengaturan gagal dimuat: ${error.message}`;
    throw error;
  }
  if (!Array.isArray(data)) {
    hrSettingsLoaded = false;
    document.querySelector("#save-hr-settings").classList.add("hidden");
    throw new Error("Supabase mengembalikan daftar pengaturan HR dengan format yang tidak valid.");
  }

  hrSettings = data;
  hrSettingsLoaded = true;
  if (data.length === 0) {
    hrSettingsForm.classList.add("hidden");
    return;
  }
  document.querySelector("#save-hr-settings").classList.remove("hidden");
  renderSettingsFields(hrSettingsFields, hrSettings);
}

function readSettingsFormValues(container) {
  const values = Object.create(null);
  for (const input of container.querySelectorAll("[data-setting-key]")) {
    values[input.dataset.settingKey] = input.type === "checkbox"
      ? input.checked
      : input.type === "number"
        ? Number(input.value)
        : input.value;
  }
  return values;
}

async function handleHrSettingsSave(event) {
  event.preventDefault();
  if (currentProfile?.role !== "hr" || !hrSettingsAccessConfig.enabled) {
    showToast("HR tidak diizinkan mengubah pengaturan aplikasi.", true);
    return;
  }

  const button = document.querySelector("#save-hr-settings");
  const values = readSettingsFormValues(hrSettingsFields);
  setBusy(button, true, "Menyimpan…");
  try {
    const { error } = await client.rpc("update_hr_editable_settings", { p_values: values });
    if (error) throw error;

    hrSettings = hrSettings.map((setting) => ({
      ...setting,
      value: values[setting.key]
    }));
    showToast("Pengaturan berhasil disimpan.");
    try {
      await refreshRuntimeAfterSettingsSave(values);
    } catch (error) {
      console.error("Saved HR settings but runtime refresh failed:", error);
      showToast(`Pengaturan tersimpan, tetapi tampilan gagal diperbarui: ${error.message}`, true);
    }
  } catch (error) {
    console.error("HR settings save failed:", error);
    showToast(`Gagal menyimpan pengaturan: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

async function handleHrSettingsAccessSave(event) {
  event.preventDefault();
  if (currentProfile?.role !== "admin") {
    showToast("Hanya admin yang dapat mengubah akses pengaturan HR.", true);
    return;
  }

  const button = document.querySelector("#save-hr-settings-access");
  const values = {
    enabled: document.querySelector("#hr-settings-enabled").checked,
    allowed_settings: [...hrSettingsPermissions.querySelectorAll("[data-hr-setting-key]:checked")]
      .map((input) => input.dataset.hrSettingKey),
    allowed_features: [...document.querySelectorAll("#hr-settings-features [data-hr-feature-key]:checked")]
      .map((input) => input.dataset.hrFeatureKey)
  };
  setBusy(button, true, "Menyimpan…");
  try {
    const { error } = await client.rpc("update_hr_settings_access_config", { p_values: values });
    if (error) throw error;

    hrSettingsAccessConfig = values;
    hrSettingsAccessConfigLoaded = true;
    syncHrFeatureAccess();
    const activeTab = document.querySelector(".nav-item.active")?.dataset.tabTarget;
    if (activeTab === "settings" && !values.enabled && values.allowed_features.length === 0) {
      setTab("summary", false);
    }
    showToast("Akses pengaturan HR berhasil disimpan.");
  } catch (error) {
    console.error("HR settings access save failed:", error);
    showToast(`Gagal menyimpan akses pengaturan HR: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function renderAdminHrMenuVisibility() {
  document.querySelector("#menu-profile-admin-visible").checked = adminHrMenuVisibility.profile_admin;
  document.querySelector("#menu-profile-hr-visible").checked = adminHrMenuVisibility.profile_hr;
  document.querySelector("#menu-checkup-visible").checked = adminHrMenuVisibility.checkup;
}

async function loadAdminHrMenuVisibility(forceReload = false) {
  if (!isAdmin()) {
    throw new Error("Hanya admin atau HR yang dapat membaca konfigurasi visibilitas menu.");
  }
  if (adminHrMenuVisibilityLoaded && !forceReload) return;

  const { data, error } = await client.rpc("get_admin_hr_menu_visibility");
  if (error) {
    adminHrMenuVisibilityLoaded = false;
    throw error;
  }
  if (
    !data
    || typeof data !== "object"
    || typeof data.profile_admin !== "boolean"
    || typeof data.profile_hr !== "boolean"
    || typeof data.checkup !== "boolean"
  ) {
    adminHrMenuVisibilityLoaded = false;
    throw new Error(
      "Konfigurasi visibilitas menu di Supabase masih menggunakan format lama atau tidak valid. " +
      "Jalankan ulang seluruh migrations/admin_hr_menu_visibility.sql di SQL Editor Supabase."
    );
  }
  adminHrMenuVisibility = {
    profile_admin: data.profile_admin,
    profile_hr: data.profile_hr,
    checkup: data.checkup
  };
  adminHrMenuVisibilityLoaded = true;
  renderAdminHrMenuVisibility();
}

async function handleMenuVisibilitySave(event) {
  event.preventDefault();
  if (currentProfile?.role !== "admin") {
    showToast("Hanya admin yang dapat mengubah visibilitas menu.", true);
    return;
  }

  const button = document.querySelector("#save-menu-visibility");
  const values = {
    profile_admin: document.querySelector("#menu-profile-admin-visible").checked,
    profile_hr: document.querySelector("#menu-profile-hr-visible").checked,
    checkup: document.querySelector("#menu-checkup-visible").checked
  };
  let saved = false;
  setBusy(button, true, "Menyimpan…");
  try {
    const { error } = await client.rpc("update_admin_hr_menu_visibility", { p_values: values });
    if (error) throw error;

    saved = true;
    const checkupWasEnabled = adminHrMenuVisibility.checkup;
    adminHrMenuVisibility = values;
    adminHrMenuVisibilityLoaded = true;
    currentEmployeeId = values.checkup ? linkedAccountEmployeeId : null;
    applyRoleMenuVisibility();
    configureCheckupPhoneField();

    if (checkupWasEnabled !== values.checkup) {
      await loadEmployees();
      if (isLinkedAdminHrCheckupAccount()) {
        const dailyCheckup = await loadAuthenticatedDailyCheckup(currentEmployeeId);
        if (dailyCheckup) showDailyCheckupStatus(dailyCheckup);
        else showCheckupForm(1);
      }
    }

    const activeTab = document.querySelector(".nav-item.active")?.dataset.tabTarget;
    if (
      (activeTab === "profile" && !isProfileMenuVisible())
      || (activeTab === "checkup" && !isLinkedAdminHrCheckupAccount())
    ) {
      setTab("summary", false);
    }
    showToast("Visibilitas menu berhasil disimpan.");
  } catch (error) {
    console.error("Menu visibility save failed:", error);
    showToast(
      saved
        ? `Visibilitas menu tersimpan, tetapi tampilan gagal diperbarui: ${error.message}`
        : `Gagal menyimpan visibilitas menu: ${error.message}`,
      true
    );
  } finally {
    setBusy(button, false);
  }
}

function openChangePasswordModal() {
  document.querySelector("#change-password-form").reset();
  changePasswordModal.showModal();
  refreshIcons();
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const passwordInput = document.querySelector("#new-account-password");
  const confirmationInput = document.querySelector("#confirm-account-password");
  if (passwordInput.value !== confirmationInput.value) {
    showToast("Konfirmasi password tidak sama.", true);
    confirmationInput.focus();
    return;
  }

  const button = document.querySelector("#save-account-password");
  setBusy(button, true, "Menyimpan…");
  try {
    const { error } = await client.auth.updateUser({ password: passwordInput.value });
    if (error) throw error;
    changePasswordModal.close();
    document.querySelector("#change-password-form").reset();
    showToast("Password berhasil diubah.");
  } catch (error) {
    console.error("Password update failed:", error);
    showToast(`Gagal mengubah password: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function showPrivacyNoticeError(error) {
  console.error("Could not load mandatory privacy notice settings:", error);
  startupMessage.textContent = `Informasi penggunaan aplikasi tidak dapat dimuat. Aplikasi belum dapat digunakan. Periksa koneksi atau konfigurasi Supabase, lalu coba lagi. (${error.message})`;
  startupMessage.setAttribute("role", "alert");
  startupRetryButton.classList.remove("hidden");
}

function completePrivacyNotice() {
  privacyGatePassed = true;
  privacyNoticeModal.close();
  startupScreen.classList.add("hidden");
}

const PRIVACY_NOTICE_CACHE_KEY = "sgt_dcu_privacy_notice_cache_v1";

async function requestPrivacyNotice() {
  let data = null;
  try {
    const res = await client.rpc("get_dcu_notice_settings");
    if (!res.error && res.data) {
      data = res.data;
      try {
        localStorage.setItem(PRIVACY_NOTICE_CACHE_KEY, JSON.stringify(data));
      } catch (_) {}
    } else if (res.error) {
      throw res.error;
    }
  } catch (err) {
    console.warn("Could not fetch privacy notice from server, checking cache:", err);
    try {
      const cached = localStorage.getItem(PRIVACY_NOTICE_CACHE_KEY);
      if (cached) data = JSON.parse(cached);
    } catch (_) {}
    if (!data) throw err;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Supabase returned invalid DCU notice settings.");
  }

  const requiredTextFields = ["legal_basis", "dcu_summary", "privacy_message", "consent_statement"];
  for (const field of requiredTextFields) {
    if (typeof data[field] !== "string" || !data[field].trim()) {
      throw new Error(`Supabase returned an invalid ${field} notice setting.`);
    }
  }
  if (typeof data.legal_basis_enabled !== "boolean" || typeof data.dcu_summary_enabled !== "boolean") {
    throw new Error("Supabase returned invalid DCU notice visibility settings.");
  }
  if (!["consent_required", "notice_acknowledgement", "disabled"].includes(data.mode)) {
    throw new Error("Supabase returned an unsupported DCU notice mode.");
  }

  if (data.mode === "disabled") {
    completePrivacyNotice();
    return;
  }

  const summaryWrap = document.querySelector("#privacy-notice-summary-wrap");
  const legalWrap = document.querySelector("#privacy-notice-legal-wrap");
  const consentForm = document.querySelector("#privacy-notice-consent-form");
  const acknowledgeWrap = document.querySelector("#privacy-notice-acknowledge-wrap");
  const consentCheckbox = document.querySelector("#privacy-notice-consent-checkbox");

  document.querySelector("#privacy-notice-summary").textContent = data.dcu_summary;
  document.querySelector("#privacy-notice-legal").textContent = data.legal_basis;
  document.querySelector("#privacy-notice-privacy").textContent = data.privacy_message;
  document.querySelector("#privacy-notice-consent-statement").textContent = data.consent_statement;
  consentCheckbox.checked = false;
  document.querySelector("#privacy-notice-agree-button").disabled = true;
  summaryWrap.classList.toggle("hidden", !data.dcu_summary_enabled);
  legalWrap.classList.toggle("hidden", !data.legal_basis_enabled);
  consentForm.classList.toggle("hidden", data.mode !== "consent_required");
  acknowledgeWrap.classList.toggle("hidden", data.mode !== "notice_acknowledgement");
  document.querySelector("#privacy-notice-blocked-message").classList.add("hidden");
  document.querySelector("#privacy-notice-title").textContent = "Informasi Penggunaan Data";

  privacyNoticeModal.showModal();
}

function bindPrivacyNoticeEvents() {
  const consentCheckbox = document.querySelector("#privacy-notice-consent-checkbox");
  const consentForm = document.querySelector("#privacy-notice-consent-form");
  const blockedMessage = document.querySelector("#privacy-notice-blocked-message");

  consentCheckbox.addEventListener("change", () => {
    document.querySelector("#privacy-notice-agree-button").disabled = !consentCheckbox.checked;
  });
  consentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!consentCheckbox.checked) return;
    completePrivacyNotice();
  });
  document.querySelector("#privacy-notice-decline-button").addEventListener("click", () => {
    blockedMessage.textContent = "Tanpa persetujuan, Anda tidak dapat melanjutkan penggunaan aplikasi. Anda dapat menutup halaman ini.";
    blockedMessage.classList.remove("hidden");
  });
  document.querySelector("#privacy-notice-acknowledge-button").addEventListener("click", completePrivacyNotice);
  privacyNoticeModal.addEventListener("cancel", (event) => event.preventDefault());
  startupRetryButton.addEventListener("click", () => window.location.reload());
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

function refreshIcons(root) {
  if (!window.lucide) return;
  if (root && root instanceof Element) {
    window.lucide.createIcons({ root });
  } else {
    window.lucide.createIcons();
  }
}

function isAdmin() {
  return ["admin", "hr"].includes(currentProfile?.role);
}

function canManageHrFeature(feature) {
  return currentProfile?.role === "admin"
    || (currentProfile?.role === "hr" && hrSettingsAccessConfig.allowed_features.includes(feature));
}

function syncHrFeatureAccess() {
  const canManageSubdepartments = canManageHrFeature("subdepartments");
  const canManageSupervisors = canManageHrFeature("supervisors");
  const canAssignEmployeeSubdepartments = canManageHrFeature("employee_subdepartment");
  const hasSubdepartmentAccess = canManageSubdepartments
    || canManageSupervisors
    || canAssignEmployeeSubdepartments;

  document.querySelector("#subdepartment-management").classList.toggle("hidden", !hasSubdepartmentAccess);
  document.querySelector("#subdepartment-form").classList.toggle("hidden", !canManageSubdepartments);
  document.querySelector("#supervisor-form").classList.toggle("hidden", !canManageSupervisors);
  document.querySelector("#subdepartment-list-panel").classList.toggle(
    "hidden",
    !canManageSubdepartments && !canManageSupervisors
  );
  document.querySelector("#employee-subdepartment-form").classList.toggle(
    "hidden",
    !canAssignEmployeeSubdepartments
  );
  document.querySelector("#employee-edit-subdepartment-wrap").classList.toggle(
    "hidden",
    !canAssignEmployeeSubdepartments
  );
  document.querySelector("#new-employee-subdepartment-wrap").classList.toggle(
    "hidden",
    guestMode || !canAssignEmployeeSubdepartments
  );
  document.querySelector("#new-employee-subdepartment").classList.toggle(
    "hidden",
    guestMode || !canAssignEmployeeSubdepartments
  );
  syncEmployeeManagementAccess();
  applyRoleMenuVisibility();
}

function isProfileMenuVisible() {
  if (currentProfile?.role === "admin") return adminHrMenuVisibility.profile_admin;
  if (currentProfile?.role === "hr") return adminHrMenuVisibility.profile_hr;
  return false;
}

function canAddAuthenticatedEmployee() {
  return currentProfile?.role === "admin"
    || (currentProfile?.role === "hr" && hrEmployeeCreationEnabled);
}

function canAddGuestEmployee() {
  return guestMode && guestEmployeeCreationEnabled;
}

function canEditEmployeeData() {
  return canManageHrFeature("employee_data");
}

function syncEmployeeCreationButtons() {
  const canAdd = canAddAuthenticatedEmployee() || canAddGuestEmployee();
  document.querySelector("#open-employee-modal").classList.toggle("hidden", !canAdd);
  document.querySelector("#profile-add-employee").classList.toggle("hidden", !canAdd);
  document.querySelector("#employee-management-add").classList.toggle(
    "hidden",
    !canAddAuthenticatedEmployee()
  );
}

async function loadHrEmployeeCreationSetting() {
  if (currentProfile?.role !== "hr") {
    hrEmployeeCreationEnabled = false;
    syncEmployeeCreationButtons();
    return false;
  }

  const { data, error } = await client.rpc("is_hr_employee_creation_enabled");
  if (error) throw error;
  if (typeof data !== "boolean") {
    throw new Error("Supabase mengembalikan status izin penambahan pekerja HR yang tidak valid.");
  }

  hrEmployeeCreationEnabled = data;
  syncEmployeeCreationButtons();
  return data;
}

function syncEmployeeManagementAccess() {
  const allowed = canEditEmployeeData();
  document.querySelector("#employee-management").classList.toggle("hidden", !allowed);
  applyRoleMenuVisibility();
}

async function loadGuestEmployeeCreationSetting() {
  const { data, error } = await client.rpc("is_guest_employee_creation_enabled");
  if (error) throw error;
  if (typeof data !== "boolean") {
    throw new Error("Supabase mengembalikan status izin penambahan pekerja tamu yang tidak valid.");
  }

  guestEmployeeCreationEnabled = data;
  syncEmployeeCreationButtons();
  return data;
}

function isDepartmentRepresentative() {
  return currentProfile?.role === "department_rep";
}

function isSummaryViewer() {
  return isAdmin() || isDepartmentRepresentative();
}

function isEmployeeAccount() {
  return ["employee", "department_rep"].includes(currentProfile?.role);
}

function isLinkedAdminHrCheckupAccount() {
  return isAdmin() && adminHrMenuVisibility.checkup && Boolean(linkedAccountEmployeeId);
}

function isSelfCheckupAccount() {
  return isEmployeeAccount() || isLinkedAdminHrCheckupAccount();
}

function isCheckupIdentityLocked() {
  return isDepartmentRepresentative() || isLinkedAdminHrCheckupAccount();
}

function configureCheckupPhoneField() {
  const required = isLinkedAdminHrCheckupAccount();
  const wrapper = document.querySelector("#checkup-whatsapp-wrap");
  const input = document.querySelector("#checkup-whatsapp");
  wrapper.classList.toggle("hidden", !required);
  input.required = required;
}

function applyRoleMenuVisibility() {
  const profileButton = document.querySelector('[data-tab-target="profile"]');
  const checkupButton = document.querySelector('[data-tab-target="checkup"]');
  const settingsButton = document.querySelector('[data-tab-target="settings"]');
  const bottomNav = document.querySelector(".bottom-nav");
  const canAccessSettings = currentProfile?.role === "admin"
    || (currentProfile?.role === "hr" && (
      hrSettingsAccessConfig.enabled || hrSettingsAccessConfig.allowed_features.length > 0
    ));
  profileButton.classList.toggle("hidden", !guestMode && !isProfileMenuVisible());
  checkupButton.classList.toggle("hidden", !guestMode && isAdmin() && !isLinkedAdminHrCheckupAccount());
  settingsButton.classList.toggle("hidden", !canAccessSettings);
  bottomNav.classList.toggle(
    "has-admin-profile",
    !profileButton.classList.contains("hidden") && isAdmin()
  );
  bottomNav.classList.toggle("has-admin-settings", canAccessSettings);
  const visibleMenuCount = [...bottomNav.querySelectorAll(".nav-item")]
    .filter((button) => !button.classList.contains("hidden"))
    .length;
  bottomNav.style.gridTemplateColumns = `repeat(${visibleMenuCount}, minmax(0, 1fr))`;
}

function normalizeWhatsApp(value) {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("0")) return `+62${digits.slice(1)}`;
  if (digits.startsWith("62")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function normalizeSupervisorPhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith("8")) digits = `62${digits}`;
  return digits;
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
  document.querySelector("#systolic").value = "90";
  document.querySelector("#diastolic").value = "70";
  document.querySelector("#temperature").value = "36.5";
  document.querySelector("#notes").value = "";
  document.querySelector("#measurement-provider").value = "";
  checkupForm.querySelectorAll('input[name="fatigue_level"], input[name="symptoms"], input[name="has_complaint_today"]')
    .forEach((input) => { input.checked = false; });
  checkupForm.querySelectorAll('input[name="substance_medication_24h"], input[name="substance_alcohol_24h"]')
    .forEach((input) => { input.checked = false; });
  updateComplaintSymptomsVisibility();
  updateSubstanceQuestionVisibility();
  updateTemperatureDisplay();
  const sleepHoursInput = document.querySelector("#sleep-hours");
  if (sleepHoursInput) sleepHoursInput.value = "8";
  updateSleepHoursDisplay();
  setActiveStep(1);
}

function updateComplaintSymptomsVisibility() {
  const hasComplaint = document.querySelector("#has-complaint-today").checked;
  document.querySelector("#complaint-status").textContent = hasComplaint ? "Ya, ada keluhan" : "Tidak";
  document.querySelector("#complaint-symptoms").classList.toggle("hidden", !hasComplaint);
  if (!hasComplaint) {
    checkupForm.querySelectorAll('#complaint-symptoms input[name="symptoms"]').forEach((input) => {
      input.checked = false;
    });
  }
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
  if (!isAdmin() || isLinkedAdminHrCheckupAccount()) return;
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
    sleepHours: document.querySelector("#sleep-hours")?.value ?? "",
    hasComplaintToday: document.querySelector("#has-complaint-today").checked ? "yes" : "no",
    symptoms,
    medicationConsumption24h: checkupForm.querySelector('input[name="substance_medication_24h"]').checked,
    alcoholConsumption24h: checkupForm.querySelector('input[name="substance_alcohol_24h"]').checked,
    notes: document.querySelector("#notes").value,
    measurementProvider: document.querySelector("#measurement-provider").value,
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
  return ["systolic", "diastolic", "temperature", "sleep-hours", "notes", "measurement-provider"].includes(target?.id)
    || [
      "fatigue_level",
      "symptoms",
      "has_complaint_today",
      "substance_medication_24h",
      "substance_alcohol_24h"
    ].includes(target?.name);
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
  for (const [name, value] of [["fatigue_level", draft.fatigueLevel]]) {
    if (["1", "2", "3", "4", "5"].includes(String(value))) {
      const input = checkupForm.querySelector(`input[name="${name}"][value="${value}"]`);
      if (input) input.checked = true;
    }
  }
  const sleepHoursInput = document.querySelector("#sleep-hours");
  const sleepHours = Number(draft.sleepHours);
  if (sleepHoursInput && Number.isFinite(sleepHours) && sleepHours >= 0 && sleepHours <= 12 && sleepHours * 2 % 1 === 0) {
    sleepHoursInput.value = String(sleepHours);
  }
  checkupForm.querySelectorAll('input[name="symptoms"]').forEach((input) => {
    input.checked = Boolean(draft.symptoms?.[input.value]);
  });
  for (const [name, value] of [
    ["substance_medication_24h", draft.medicationConsumption24h],
    ["substance_alcohol_24h", draft.alcoholConsumption24h]
  ]) {
    const input = checkupForm.querySelector(`input[name="${name}"]`);
    if (input) input.checked = value === true || value === "yes";
  }
  document.querySelector("#has-complaint-today").checked = draft.hasComplaintToday === "yes";
  updateComplaintSymptomsVisibility();
  updateSubstanceQuestionVisibility();
  document.querySelector("#notes").value = typeof draft.notes === "string" ? draft.notes : "";
  const measurementProvider = typeof draft.measurementProvider === "string" ? draft.measurementProvider : "";
  document.querySelector("#measurement-provider").value = measurementProviderNames.includes(measurementProvider)
    ? measurementProvider
    : "";
  updateTemperatureDisplay();
  updateSleepHoursDisplay();
  setActiveStep(Number.isInteger(draft.step) && draft.step >= 1 && draft.step <= getLastCheckupStep() ? draft.step : 2);
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
  select.innerHTML = '<option value="">Pilih fungsi</option>';
  for (const department of departments) {
    const option = document.createElement("option");
    option.value = department.id;
    option.textContent = department.name;
    select.append(option);
  }
  if (departments.some((department) => department.id === selectedId)) {
    select.value = selectedId;
  }
  if (select === departmentSelect) {
    renderDepartmentTabs();
  } else if (select === document.querySelector("#profile-department")) {
    renderProfileDepartmentTabs();
  }
}

function updateProfileEmployeeOptions(selectedId = "") {
  const departmentId = document.querySelector("#profile-department")?.value;
  const select = document.querySelector("#profile-employee");
  if (!select) return;
  const employeeToSelect = selectedId || select.value;
  const showAllEmployees = !departmentId && (
    EMPLOYEE_SELECTION_MODE === "list"
    || (DEPARTMENT_SELECTION_MODE === "tabs" && currentProfileTab === "all")
  );
  const departmentEmployees = employees.filter((item) =>
    item.is_active && (item.department_id === departmentId || showAllEmployees)
  );
  select.innerHTML = '<option value="">Pilih nama pekerja</option>';
  for (const employee of departmentEmployees) {
    const option = document.createElement("option");
    option.value = employee.id;
    const departmentName = departments.find((department) => department.id === employee.department_id)?.name;
    option.textContent = showAllEmployees && departmentName
      ? `${employee.full_name} — ${departmentName}`
      : employee.full_name;
    select.append(option);
  }
  if (!departmentId && !showAllEmployees) {
    select.innerHTML = '<option value="">Pilih fungsi terlebih dahulu</option>';
  } else if (!select.options.length || (select.options.length === 1 && !select.options[0].value)) {
    select.innerHTML = '<option value="">Belum ada pekerja terdaftar</option>';
  }
  select.disabled = false;
  if (employees.some((item) => item.id === employeeToSelect && item.is_active)) {
    select.value = employeeToSelect;
  }
  if (DEPARTMENT_SELECTION_MODE === "dropdown") {
    currentProfileTab = departmentId || "all";
  } else if (departmentId) {
    currentProfileTab = departmentId;
  }
  syncProfileDepartmentTabsUI(currentProfileTab);
  renderProfileEmployeeList(currentProfileTab);
}

function syncGuestProfileToCheckup() {
  if (!guestProfile) return;
  departmentSelect.value = guestProfile.departmentId;
  updateEmployeeOptions();
  employeeSelect.value = guestProfile.employeeId;
  document.querySelector("#checkup-whatsapp").value = guestProfile.whatsapp;
  renderCheckupIdentitySummary();
}

function hasValidGuestProfile() {
  return Boolean(
    guestProfile
    && departments.some((department) => department.id === guestProfile.departmentId)
    && employees.some((employee) =>
      employee.id === guestProfile.employeeId
      && employee.department_id === guestProfile.departmentId
      && employee.is_active
    )
    && isValidWhatsApp(guestProfile.whatsapp)
  );
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
  showCheckupProgress();
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
  nextButton.onclick = () => showCheckupForm(isLinkedAdminHrCheckupAccount() ? 1 : 2);
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
      : "Anda sudah mengisi DCU untuk hari ini.";
    if (spanEl) spanEl.textContent = canSubmitMore
      ? "Anda masih dapat mengisi lagi sesuai jadwal dan batas harian."
      : "Silakan isi kembali pada hari berikutnya.";
  }
  showResult(checkup, checkup.readiness_status, checkup.checked_at, Boolean(checkup?.is_offline));
  resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Department representatives must keep their linked checkup identity.
  const existingBtn = document.querySelector('.admin-employee-switch-btn');
  if (existingBtn) existingBtn.remove();
  if (isCheckupIdentityLocked()) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary-button mt-4 w-full admin-employee-switch-btn';
  btn.innerHTML = '<i data-lucide="user-round" class="mr-2 icon-text-sm"></i>Pilih pekerja lain';
  btn.addEventListener('click', () => {
    hideDailyCheckupStatus();
    setActiveStep(1);
    checkupForm.classList.remove("hidden");
    showCheckupProgress();
    resultCard.classList.add("hidden");
    updateEmployeeOptions();
  });
  const copyBtn = document.querySelector("#copy-report");
  if (copyBtn) {
    copyBtn.parentNode.insertBefore(btn, copyBtn.nextSibling);
  } else {
    resultCard.querySelector(".panel-card")?.appendChild(btn);
  }
  window.lucide?.createIcons();
}

function showCheckupForm(step = 2) {
  checkupForm.classList.remove("hidden");
  showCheckupProgress();
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
    .select("id, employee_id, checked_at, systolic, diastolic, temperature_c, fatigue_level, sleep_hours, sleep_quality, symptoms, notes, measurement_provider, readiness_status")
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

async function checkAuthenticatedSelectedEmployeeDailyStatus() {
  if (guestMode) return;
  const selectedEmployeeId = employeeSelect.value;
  const selectedDepartmentId = departmentSelect.value;
  const employee = employees.find((item) => item.id === selectedEmployeeId && item.department_id === selectedDepartmentId && item.is_active);
  
  if (!employee) {
    showCheckupForm(1);
    return;
  }
  
  // Check if employee has daily checkup for today
  try {
    const dailyCheckup = await loadAuthenticatedDailyCheckup(selectedEmployeeId);
    if (dailyCheckup) {
      showDailyCheckupStatus(dailyCheckup);
    } else {
      showCheckupForm(1);
    }
  } catch (err) {
    console.error("Could not check daily status for selected employee:", err);
    showCheckupForm(1);
  }
}

const checkAdminSelectedEmployeeDailyStatus = checkAuthenticatedSelectedEmployeeDailyStatus;

function syncGuestProfileForm() {
  const profileDepartment = document.querySelector("#profile-department");
  populateDepartmentSelect(profileDepartment, guestProfile?.departmentId ?? "");
  if (guestProfile?.departmentId) {
    currentProfileTab = guestProfile.departmentId;
  } else {
    currentProfileTab = "all";
  }
  renderProfileDepartmentTabs();
  updateProfileEmployeeOptions(guestProfile?.employeeId ?? "");
  document.querySelector("#profile-whatsapp").value = guestProfile?.whatsapp ?? "";
  renderProfileEmployeeList(currentProfileTab);
  if (guestProfile?.employeeId) {
    syncProfileEmployeeListUI(guestProfile.employeeId);
  }
}

function openEmployeeModal(departmentId, canAddAsGuest, options = {}) {
  document.querySelector("#employee-form").reset();
  employeeModal.dataset.departmentId = departmentId || "";
  employeeModal.dataset.managementAdd = options.managementAdd ? "true" : "false";
  document.querySelector("#employee-modal-eyebrow").textContent = canAddAsGuest ? "TAMBAH NAMA" : "MASTER DATA";
  document.querySelector("#employee-modal-title").textContent = canAddAsGuest ? "Tambahkan nama Anda" : "Tambah pekerja";
  document.querySelector("#guest-employee-note").classList.toggle("hidden", !canAddAsGuest);
  document.querySelector("#new-employee-active-wrap").classList.toggle("hidden", canAddAsGuest);
  const departmentSelectWrap = document.querySelector("#new-employee-department-select-wrap");
  const departmentSelectForNewEmployee = document.querySelector("#new-employee-department-select");
  const allowDepartmentSelection = Boolean(options.allowDepartmentSelection) && !canAddAsGuest;
  departmentSelectWrap.classList.toggle("hidden", !allowDepartmentSelection);
  departmentSelectForNewEmployee.classList.toggle("hidden", !allowDepartmentSelection);
  departmentSelectForNewEmployee.required = allowDepartmentSelection;
  departmentSelectForNewEmployee.replaceChildren(new Option("Pilih fungsi", ""));
  for (const department of departments) {
    departmentSelectForNewEmployee.add(new Option(department.name, department.id));
  }
  departmentSelectForNewEmployee.value = departmentId || "";
  document.querySelector("#new-employee-department").classList.toggle("hidden", allowDepartmentSelection);
  const canAssignSubdepartment = canManageHrFeature("employee_subdepartment") && !canAddAsGuest;
  document.querySelector("#new-employee-subdepartment-wrap").classList.toggle("hidden", !canAssignSubdepartment);
  document.querySelector("#new-employee-subdepartment").classList.toggle("hidden", !canAssignSubdepartment);
  populateSubdepartmentSelect(
    document.querySelector("#new-employee-subdepartment"),
    departmentId,
    "",
    "Tanpa subfungsi"
  );
  const departmentName = departments.find((department) => department.id === departmentId)?.name ?? "";
  document.querySelector("#new-employee-department").textContent = `Fungsi: ${departmentName}`;
  employeeModal.showModal();
}

async function openEmployeeModalFromManagement() {
  if (currentProfile?.role === "hr") {
    try {
      await loadHrEmployeeCreationSetting();
    } catch (error) {
      console.error("Could not verify HR employee-creation permission:", error);
      showToast(`Gagal memverifikasi izin penambahan pekerja: ${error.message}`, true);
      return;
    }
  }
  if (!canAddAuthenticatedEmployee()) {
    showToast("Anda tidak diizinkan menambah pekerja baru.", true);
    return;
  }

  const selectedDepartmentId = DEPARTMENT_SELECTION_MODE === "dropdown"
    ? document.querySelector("#employee-management-department").value
    : employeeManagementDepartmentId === "all"
      ? ""
      : employeeManagementDepartmentId;
  if (!selectedDepartmentId && departments.length === 0) {
    showToast("Tambahkan fungsi terlebih dahulu sebelum menambah pekerja.", true);
    return;
  }
  openEmployeeModal(selectedDepartmentId, false, {
    managementAdd: true,
    allowDepartmentSelection: !selectedDepartmentId
  });
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

function showCheckupProgress() {
  checkupProgress.classList.toggle("hidden", checkupPageCount === 1);
}

function setActiveStep(step) {
  step = Math.min(step, getLastCheckupStep());
  if (guestMode && step === 1) step = 2;
  activeStep = step;
  document.querySelectorAll(".checkup-step").forEach((section) => {
    section.classList.toggle("hidden", Number(section.dataset.step) !== step);
  });
  const displayStep = step - 1;
  const totalSteps = getLastCheckupStep() - 1;
  checkupProgress.classList.toggle("hidden", checkupPageCount === 1 || (!guestMode && step === 1));
  const percent = Math.round((displayStep / totalSteps) * 100);
  document.querySelector("#step-caption").textContent = `LANGKAH ${displayStep} DARI ${totalSteps}`;
  document.querySelector("#step-percent").textContent = `${percent}%`;
  document.querySelector("#progress-bar").style.width = `${percent}%`;
}

function validateSubstanceQuestions() {
  const employee = employees.find((item) => item.id === employeeSelect.value);
  const eligible = isSubstanceQuestionEligible(employee);
  if (eligible === null) {
    showToast("Kriteria pekerja belum dapat diverifikasi. Hubungkan ke internet untuk memperbarui konfigurasi dan direktori.", true);
    return false;
  }
  return true;
}

function validateStep(step) {
  if (step === 1) {
    if (!departmentSelect.value) {
      showToast("Pilih fungsi terlebih dahulu.", true);
      return false;
    }
    if (!employeeSelect.value) {
      showToast("Pilih nama pekerja untuk melanjutkan.", true);
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
    } else if (isLinkedAdminHrCheckupAccount()) {
      const phone = document.querySelector("#checkup-whatsapp");
      if (!phone.value.trim()) {
        phone.setCustomValidity("Nomor HP wajib diisi sebelum checkup.");
        phone.reportValidity();
        phone.setCustomValidity("");
        return false;
      }
      if (!isValidWhatsApp(phone.value)) {
        phone.setCustomValidity("Masukkan nomor HP yang valid, misalnya 081234567890.");
        phone.reportValidity();
        phone.setCustomValidity("");
        return false;
      }
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
    if (!checkupForm.querySelector('input[name="fatigue_level"]:checked')) {
      showToast("Pilih nilai kelelahan.", true);
      return false;
    }
    const sleepHoursInput = document.querySelector("#sleep-hours");
    if (!sleepHoursInput) {
      showToast("Form checkup belum diperbarui. Muat ulang aplikasi untuk menggunakan isian jumlah jam tidur.", true);
      return false;
    }
    const sleepHours = Number(sleepHoursInput.value);
    if (!Number.isFinite(sleepHours) || sleepHours < 0 || sleepHours > 12) {
      showToast("Pilih jumlah jam tidur antara 0 dan 12 jam.", true);
      return false;
    }
  }
  if (step === Number(document.querySelector("#checkup-symptoms-step").dataset.step)) {
    if (!validateSubstanceQuestions()) return false;
  }
  return true;
}

function updateTemperatureDisplay() {
  const temperature = Number(document.querySelector("#temperature").value);
  const value = document.querySelector("#temperature-value");
  const hint = document.querySelector("#temperature-hint");
  value.textContent = `${temperature.toFixed(1)}°C`;
  value.className = temperature > 38
    ? "rounded-lg bg-rose-50 px-2.5 py-1 text-sm font-bold text-rose-700"
    : "rounded-lg bg-blue-50 px-2.5 py-1 text-sm font-bold text-blue-700";
  hint.textContent = temperature > 38
    ? "Suhu di atas 38°C — hasil akan memerlukan observasi."
    : "Geser untuk memilih suhu tubuh.";
}

let currentCheckupTab = "all";
let currentProfileTab = "all";
let checkupSearchQuery = "";
let profileSearchQuery = "";

function renderDepartmentTabs() {
  const container = document.querySelector("#department-tabs");
  if (!container) return;

  const totalActive = employees.filter((e) => e.is_active).length;

  if (departmentSelect.value && currentCheckupTab !== "all") {
    currentCheckupTab = departmentSelect.value;
  }

  container.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `department-tab ${currentCheckupTab === "all" ? "is-active" : ""}`;
  allBtn.setAttribute("role", "tab");
  allBtn.setAttribute("aria-selected", currentCheckupTab === "all" ? "true" : "false");
  allBtn.dataset.departmentId = "all";
  allBtn.innerHTML = `<span>Semua</span><span class="department-tab-count">${totalActive}</span>`;
  allBtn.addEventListener("click", () => {
    currentCheckupTab = "all";
    if (EMPLOYEE_SELECTION_MODE === "dropdown") {
      departmentSelect.value = "";
      departmentSelect.dispatchEvent(new Event("change"));
    }
    syncDepartmentTabsUI("all");
    renderEmployeeList("all");
  });
  container.appendChild(allBtn);

  // 2. Tab untuk masing-masing fungsi
  for (const dept of departments) {
    const isActive = currentCheckupTab === dept.id;
    const count = employees.filter((e) => e.department_id === dept.id && e.is_active).length;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `department-tab ${isActive ? "is-active" : ""}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.dataset.departmentId = dept.id;
    btn.innerHTML = `<span>${escapeHtml(dept.name)}</span><span class="department-tab-count">${count}</span>`;

    btn.addEventListener("click", () => {
      currentCheckupTab = dept.id;
      departmentSelect.value = dept.id;
      departmentSelect.dispatchEvent(new Event("change"));
      syncDepartmentTabsUI(dept.id);
      renderEmployeeList(dept.id);
    });

    container.appendChild(btn);
  }

  const activeBtn = container.querySelector(".department-tab.is-active");
  if (activeBtn) {
    activeBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}

function syncDepartmentTabsUI(activeTabId = currentCheckupTab) {
  const container = document.querySelector("#department-tabs");
  if (!container) return;

  currentCheckupTab = activeTabId;
  const tabs = container.querySelectorAll(".department-tab");
  tabs.forEach((tab) => {
    const isMatch = tab.dataset.departmentId === activeTabId;
    tab.classList.toggle("is-active", isMatch);
    tab.setAttribute("aria-selected", isMatch ? "true" : "false");
    if (isMatch) {
      tab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  });
}

function renderEmployeeList(departmentId = currentCheckupTab) {
  const listContainer = document.querySelector("#employee-list");
  const scrollWrap = document.querySelector("#employee-list-scroll-wrap");
  const countBadge = document.querySelector("#employee-count-badge");
  const scrollHint = document.querySelector("#employee-scroll-hint");
  if (!listContainer) return;

  if (scrollWrap) {
    scrollWrap.style.setProperty("--visible-limit", String(employeeDisplayLimit));
  }

  let deptEmployees;
  if (departmentId === "all" || !departmentId) {
    deptEmployees = employees.filter((e) => e.is_active);
  } else {
    deptEmployees = employees.filter((e) => e.department_id === departmentId && e.is_active);
  }

  let displayEmployees = deptEmployees;
  if (checkupSearchQuery) {
    displayEmployees = deptEmployees.filter((e) => {
      const nameMatch = e.full_name?.toLowerCase().includes(checkupSearchQuery);
      const titleMatch = e.job_title?.toLowerCase().includes(checkupSearchQuery);
      const deptName = departments.find((d) => d.id === e.department_id)?.name?.toLowerCase();
      const deptMatch = deptName?.includes(checkupSearchQuery);
      return nameMatch || titleMatch || deptMatch;
    });
  }

  if (countBadge) {
    countBadge.textContent = `(${displayEmployees.length})`;
  }

  if (scrollHint) {
    scrollHint.classList.toggle("hidden",
      EMPLOYEE_SELECTION_MODE === "dropdown" || displayEmployees.length <= employeeDisplayLimit);
  }

  if (displayEmployees.length === 0) {
    if (checkupSearchQuery) {
      listContainer.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">Tidak ada pekerja yang cocok dengan "${escapeHtml(checkupSearchQuery)}"</div>`;
    } else {
      listContainer.innerHTML = '<div class="p-4 text-center text-xs text-slate-400">Belum ada pekerja terdaftar di fungsi ini</div>';
    }
    return;
  }

  const currentEmpId = employeeSelect.value;
  listContainer.innerHTML = "";

  for (const emp of displayEmployees) {
    const isSelected = emp.id === currentEmpId;
    const isOwn = !guestMode && currentEmployeeId && emp.id === currentEmployeeId;

    const card = document.createElement("button");
    card.type = "button";
    card.className = `employee-card ${isSelected ? "is-selected" : ""}`;
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", isSelected ? "true" : "false");
    card.dataset.employeeId = emp.id;

    let badgesHtml = "";
    if (isOwn) {
      badgesHtml += '<span class="employee-card-badge is-own">Akun Anda</span>';
    }
    if (departmentId === "all" || !departmentId || checkupSearchQuery) {
      const deptName = departments.find((d) => d.id === emp.department_id)?.name;
      if (deptName) {
        badgesHtml += `<span class="employee-card-badge dept">${escapeHtml(deptName)}</span>`;
      }
    }
    if (emp.work_pattern) {
      const isShift = emp.work_pattern.toLowerCase().includes("shift") && !emp.work_pattern.toLowerCase().includes("non");
      badgesHtml += `<span class="employee-card-badge ${isShift ? "shift" : "non-shift"}">${escapeHtml(emp.work_pattern)}</span>`;
    }
    if (emp.job_title) {
      badgesHtml += `<span>${escapeHtml(emp.job_title)}</span>`;
    } else if (emp.employment_status) {
      badgesHtml += `<span>${escapeHtml(emp.employment_status)}</span>`;
    }

    card.innerHTML = `
      <div class="employee-card-info">
        <span class="employee-card-name">${escapeHtml(emp.full_name)}</span>
        <div class="employee-card-meta">${badgesHtml}</div>
      </div>
      <div class="employee-card-radio">
        <i data-lucide="check"></i>
      </div>
    `;

    card.addEventListener("click", () => {
      if (emp.department_id) {
        departmentSelect.value = emp.department_id;
        departmentSelect.dispatchEvent(new Event("change"));
        if (currentCheckupTab !== "all") {
          currentCheckupTab = emp.department_id;
          syncDepartmentTabsUI(emp.department_id);
        }
      }
      employeeSelect.value = emp.id;
      employeeSelect.dispatchEvent(new Event("change"));
      syncEmployeeListUI(emp.id);
    });

    listContainer.appendChild(card);
  }

  window.lucide?.createIcons();

  const selectedCard = listContainer.querySelector(".employee-card.is-selected");
  if (selectedCard) {
    selectedCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function syncEmployeeListUI(selectedEmpId = employeeSelect.value) {
  const listContainer = document.querySelector("#employee-list");
  if (!listContainer) return;

  const cards = listContainer.querySelectorAll(".employee-card");
  cards.forEach((card) => {
    const isMatch = card.dataset.employeeId === selectedEmpId;
    card.classList.toggle("is-selected", isMatch);
    card.setAttribute("aria-checked", isMatch ? "true" : "false");
    if (isMatch) {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

function renderProfileDepartmentTabs() {
  const container = document.querySelector("#profile-department-tabs");
  if (!container) return;

  const totalActive = employees.filter((e) => e.is_active).length;
  const profileDept = document.querySelector("#profile-department");

  if (profileDept?.value && currentProfileTab !== "all") {
    currentProfileTab = profileDept.value;
  }

  container.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `department-tab ${currentProfileTab === "all" ? "is-active" : ""}`;
  allBtn.setAttribute("role", "tab");
  allBtn.setAttribute("aria-selected", currentProfileTab === "all" ? "true" : "false");
  allBtn.dataset.departmentId = "all";
  allBtn.innerHTML = `<span>Semua</span><span class="department-tab-count">${totalActive}</span>`;
  allBtn.addEventListener("click", () => {
    currentProfileTab = "all";
    if (EMPLOYEE_SELECTION_MODE === "dropdown" && profileDept) {
      profileDept.value = "";
      profileDept.dispatchEvent(new Event("change"));
    }
    syncProfileDepartmentTabsUI("all");
    renderProfileEmployeeList("all");
  });
  container.appendChild(allBtn);

  // 2. Tab masing-masing fungsi
  for (const dept of departments) {
    const isActive = currentProfileTab === dept.id;
    const count = employees.filter((e) => e.department_id === dept.id && e.is_active).length;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `department-tab ${isActive ? "is-active" : ""}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.dataset.departmentId = dept.id;
    btn.innerHTML = `<span>${escapeHtml(dept.name)}</span><span class="department-tab-count">${count}</span>`;

    btn.addEventListener("click", () => {
      currentProfileTab = dept.id;
      if (profileDept) {
        profileDept.value = dept.id;
        profileDept.dispatchEvent(new Event("change"));
      }
      syncProfileDepartmentTabsUI(dept.id);
      renderProfileEmployeeList(dept.id);
    });

    container.appendChild(btn);
  }

  const activeBtn = container.querySelector(".department-tab.is-active");
  if (activeBtn) {
    activeBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}

function syncProfileDepartmentTabsUI(activeTabId = currentProfileTab) {
  const container = document.querySelector("#profile-department-tabs");
  if (!container) return;

  currentProfileTab = activeTabId;
  const tabs = container.querySelectorAll(".department-tab");
  tabs.forEach((tab) => {
    const isMatch = tab.dataset.departmentId === activeTabId;
    tab.classList.toggle("is-active", isMatch);
    tab.setAttribute("aria-selected", isMatch ? "true" : "false");
    if (isMatch) {
      tab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  });
}

function renderProfileEmployeeList(departmentId = currentProfileTab) {
  const listContainer = document.querySelector("#profile-employee-list");
  const scrollWrap = document.querySelector("#profile-employee-list-scroll-wrap");
  const countBadge = document.querySelector("#profile-employee-count-badge");
  const scrollHint = document.querySelector("#profile-employee-scroll-hint");
  const profileEmpSelect = document.querySelector("#profile-employee");
  const profileDeptSelect = document.querySelector("#profile-department");
  if (!listContainer) return;

  if (scrollWrap) {
    scrollWrap.style.setProperty("--visible-limit", String(employeeDisplayLimit));
  }

  let deptEmployees;
  if (departmentId === "all" || !departmentId) {
    deptEmployees = employees.filter((e) => e.is_active);
  } else {
    deptEmployees = employees.filter((e) => e.department_id === departmentId && e.is_active);
  }

  let displayEmployees = deptEmployees;
  if (profileSearchQuery) {
    displayEmployees = deptEmployees.filter((e) => {
      const nameMatch = e.full_name?.toLowerCase().includes(profileSearchQuery);
      const titleMatch = e.job_title?.toLowerCase().includes(profileSearchQuery);
      const deptName = departments.find((d) => d.id === e.department_id)?.name?.toLowerCase();
      const deptMatch = deptName?.includes(profileSearchQuery);
      return nameMatch || titleMatch || deptMatch;
    });
  }

  if (countBadge) {
    countBadge.textContent = `(${displayEmployees.length})`;
  }

  if (scrollHint) {
    scrollHint.classList.toggle("hidden",
      EMPLOYEE_SELECTION_MODE === "dropdown" || displayEmployees.length <= employeeDisplayLimit);
  }

  if (displayEmployees.length === 0) {
    if (profileSearchQuery) {
      listContainer.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">Tidak ada pekerja yang cocok dengan "${escapeHtml(profileSearchQuery)}"</div>`;
    } else {
      listContainer.innerHTML = '<div class="p-4 text-center text-xs text-slate-400">Belum ada pekerja terdaftar di fungsi ini</div>';
    }
    return;
  }

  const currentEmpId = profileEmpSelect ? profileEmpSelect.value : "";
  listContainer.innerHTML = "";

  for (const emp of displayEmployees) {
    const isSelected = emp.id === currentEmpId;

    const card = document.createElement("button");
    card.type = "button";
    card.className = `employee-card ${isSelected ? "is-selected" : ""}`;
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", isSelected ? "true" : "false");
    card.dataset.employeeId = emp.id;

    let badgesHtml = "";
    if (departmentId === "all" || !departmentId || profileSearchQuery) {
      const deptName = departments.find((d) => d.id === emp.department_id)?.name;
      if (deptName) {
        badgesHtml += `<span class="employee-card-badge dept">${escapeHtml(deptName)}</span>`;
      }
    }
    if (emp.work_pattern) {
      const isShift = emp.work_pattern.toLowerCase().includes("shift") && !emp.work_pattern.toLowerCase().includes("non");
      badgesHtml += `<span class="employee-card-badge ${isShift ? "shift" : "non-shift"}">${escapeHtml(emp.work_pattern)}</span>`;
    }
    if (emp.job_title) {
      badgesHtml += `<span>${escapeHtml(emp.job_title)}</span>`;
    } else if (emp.employment_status) {
      badgesHtml += `<span>${escapeHtml(emp.employment_status)}</span>`;
    }

    card.innerHTML = `
      <div class="employee-card-info">
        <span class="employee-card-name">${escapeHtml(emp.full_name)}</span>
        <div class="employee-card-meta">${badgesHtml}</div>
      </div>
      <div class="employee-card-radio">
        <i data-lucide="check"></i>
      </div>
    `;

    card.addEventListener("click", () => {
      if (emp.department_id && profileDeptSelect) {
        profileDeptSelect.value = emp.department_id;
        profileDeptSelect.dispatchEvent(new Event("change"));
        if (currentProfileTab !== "all") {
          currentProfileTab = emp.department_id;
          syncProfileDepartmentTabsUI(emp.department_id);
        }
      }
      if (profileEmpSelect) {
        profileEmpSelect.value = emp.id;
        profileEmpSelect.dispatchEvent(new Event("change"));
      }
      syncProfileEmployeeListUI(emp.id);
    });

    listContainer.appendChild(card);
  }

  window.lucide?.createIcons();

  const selectedCard = listContainer.querySelector(".employee-card.is-selected");
  if (selectedCard) {
    selectedCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function syncProfileEmployeeListUI(selectedEmpId) {
  const listContainer = document.querySelector("#profile-employee-list");
  if (!listContainer) return;

  const cards = listContainer.querySelectorAll(".employee-card");
  cards.forEach((card) => {
    const isMatch = card.dataset.employeeId === selectedEmpId;
    card.classList.toggle("is-selected", isMatch);
    card.setAttribute("aria-checked", isMatch ? "true" : "false");
    if (isMatch) {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

function updateEmployeeOptions() {
  const departmentId = guestMode && document.querySelector("#profile-tab").classList.contains("hidden")
    ? departmentSelect.value
    : guestMode
      ? document.querySelector("#profile-department").value
      : departmentSelect.value;
  const showAllEmployees = !departmentId
    && DEPARTMENT_SELECTION_MODE === "tabs"
    && EMPLOYEE_SELECTION_MODE === "dropdown"
    && currentCheckupTab === "all";
  const departmentEmployees = employees.filter((employee) =>
    employee.is_active && (employee.department_id === departmentId || showAllEmployees)
  );
  employeeSelect.innerHTML = '<option value="">Pilih nama pekerja</option>';
  for (const employee of departmentEmployees) {
    const option = document.createElement("option");
    option.value = employee.id;
    const departmentName = departments.find((department) => department.id === employee.department_id)?.name;
    option.textContent = showAllEmployees && departmentName
      ? `${employee.full_name} — ${departmentName}`
      : employee.full_name;
    employeeSelect.append(option);
  }
  employeeSelect.disabled = isCheckupIdentityLocked();
  if (!departmentId && !showAllEmployees) {
    employeeSelect.innerHTML = '<option value="">Pilih fungsi terlebih dahulu</option>';
  } else if (departmentEmployees.length === 0) {
    employeeSelect.innerHTML = '<option value="">Belum ada pekerja terdaftar</option>';
  }
  const addButton = document.querySelector("#open-employee-modal");
  const canAddEmployee = canAddAuthenticatedEmployee() || canAddGuestEmployee();
  syncEmployeeCreationButtons();
  addButton.disabled = false;
  addButton.title = canAddEmployee ? "Tambah nama pekerja" : "Hubungi HR untuk menambahkan pekerja";
  document.querySelector("#employee-hint").textContent = canAddAuthenticatedEmployee()
    ? "Pekerja baru dapat ditambahkan oleh HR/admin."
    : guestMode && canAddEmployee
      ? "Nama belum ada? Tambahkan nama Anda sendiri."
      : "Tidak menemukan nama? Hubungi HR untuk menambahkan pekerja.";
  if (guestMode) updateProfileEmployeeOptions();

  if (DEPARTMENT_SELECTION_MODE === "dropdown") {
    currentCheckupTab = departmentId || "all";
  }
  syncDepartmentTabsUI(currentCheckupTab);
  renderEmployeeList(currentCheckupTab);
}

function applySelectionModes() {
  const departmentDropdown = DEPARTMENT_SELECTION_MODE === "dropdown";
  const employeeDropdown = EMPLOYEE_SELECTION_MODE === "dropdown";

  for (const [select, isDropdown] of [
    [departmentSelect, departmentDropdown],
    [document.querySelector("#profile-department"), departmentDropdown],
    [document.querySelector("#employee-management-department"), departmentDropdown],
    [employeeSelect, employeeDropdown],
    [document.querySelector("#profile-employee"), employeeDropdown],
    [document.querySelector("#employee-management-employee"), employeeDropdown]
  ]) {
    select.classList.toggle("sr-only", !isDropdown);
    select.classList.toggle("field-input", isDropdown);
    select.classList.toggle("mt-2", isDropdown);
    select.classList.toggle("w-full", isDropdown);
    if (isDropdown) {
      select.removeAttribute("aria-hidden");
      select.removeAttribute("tabindex");
    } else {
      select.setAttribute("aria-hidden", "true");
      select.tabIndex = -1;
    }
  }

  document.querySelector("#department-tabs-wrap").classList.toggle("hidden", departmentDropdown);
  document.querySelector("#profile-department-tabs-wrap").classList.toggle("hidden", departmentDropdown);
  document.querySelector("#employee-management-department-tabs-wrap").classList.toggle("hidden", departmentDropdown);
  document.querySelector("#employee-search-wrap").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#employee-list-scroll-wrap").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#employee-scroll-hint").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#profile-employee-search-wrap").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#profile-employee-list-scroll-wrap").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#profile-employee-scroll-hint").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#employee-management-search-wrap").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#employee-management-list-scroll-wrap").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#employee-management-scroll-hint").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#employee-count-badge").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#profile-employee-count-badge").classList.toggle("hidden", employeeDropdown);
  document.querySelector("#employee-management-count-badge").classList.toggle("hidden", employeeDropdown);
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
  departmentSelect.innerHTML = '<option value="">Pilih fungsi</option>' + options;
  if (departments.some((department) => department.id === selectedDepartment)) {
    departmentSelect.value = selectedDepartment;
  }

  const historyDepartment = document.querySelector("#history-department");
  historyDepartment.innerHTML = isDepartmentRepresentative()
    ? options
    : '<option value="">Semua fungsi</option>' + options;
  historyDepartment.disabled = isDepartmentRepresentative();
  if (isDepartmentRepresentative() && departments.some((department) => department.id === currentDepartmentId)) {
    historyDepartment.value = currentDepartmentId;
  } else if (departments.some((department) => department.id === selectedHistoryDepartment)) {
    historyDepartment.value = selectedHistoryDepartment;
  }

  renderDepartmentTabs();
  renderProfileDepartmentTabs();
  renderSubdepartmentControls();
}

function subdepartmentsForDepartment(departmentId) {
  return subdepartments.filter((subdepartment) => subdepartment.department_id === departmentId);
}

function populateSubdepartmentSelect(select, departmentId, selectedId = "", emptyLabel = "Tanpa subfungsi") {
  if (!select) return;
  select.replaceChildren(new Option(emptyLabel, ""));
  for (const subdepartment of subdepartmentsForDepartment(departmentId)) {
    select.add(new Option(subdepartment.name, subdepartment.id));
  }
  if (subdepartmentsForDepartment(departmentId).some((subdepartment) => subdepartment.id === selectedId)) {
    select.value = selectedId;
  }
}

async function loadEmployeeManagementList() {
  if (!canEditEmployeeData()) {
    throw new Error("Anda tidak diizinkan mengubah data pekerja.");
  }

  const pageSize = 1000;
  const allEmployees = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("employees")
      .select("id, department_id, sub_department_id, full_name, employment_status, job_title, work_pattern, is_active")
      .order("full_name")
      .order("id")
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    allEmployees.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }

  employeeManagementEmployees = allEmployees;
  renderEmployeeManagementPicker();
}

function renderEmployeeManagementDepartmentTabs() {
  const container = document.querySelector("#employee-management-department-tabs");
  const departmentSelectForManagement = document.querySelector("#employee-management-department");
  container.replaceChildren();

  const addTab = (id, label, count) => {
    const tab = document.createElement("button");
    const isActive = employeeManagementDepartmentId === id;
    tab.type = "button";
    tab.className = `department-tab ${isActive ? "is-active" : ""}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
    tab.dataset.departmentId = id;
    tab.innerHTML = `<span>${escapeHtml(label)}</span><span class="department-tab-count">${count}</span>`;
    tab.addEventListener("click", () => {
      employeeManagementDepartmentId = id;
      departmentSelectForManagement.value = id === "all" ? "" : id;
      clearEmployeeManagementSelection();
      renderEmployeeManagementPicker();
    });
    container.append(tab);
  };

  addTab("all", "Semua", employeeManagementEmployees.length);
  for (const department of departments) {
    const count = employeeManagementEmployees.filter((employee) =>
      employee.department_id === department.id
    ).length;
    addTab(department.id, department.name, count);
  }
}

function clearEmployeeManagementSelection() {
  employeeManagementSelectedId = "";
  document.querySelector("#employee-management-employee").value = "";
  document.querySelector("#edit-employee-button").disabled = true;
}

function renderEmployeeManagementPicker() {
  const departmentSelectForManagement = document.querySelector("#employee-management-department");
  const employeeSelectForManagement = document.querySelector("#employee-management-employee");
  const employeeList = document.querySelector("#employee-management-list");
  const searchInput = document.querySelector("#employee-management-search");
  const searchQuery = searchInput.value.trim().toLowerCase();
  const searchClear = document.querySelector("#employee-management-search-clear");
  const countBadge = document.querySelector("#employee-management-count-badge");
  const scrollHint = document.querySelector("#employee-management-scroll-hint");
  const scrollWrap = document.querySelector("#employee-management-list-scroll-wrap");
  const departmentId = DEPARTMENT_SELECTION_MODE === "dropdown"
    ? departmentSelectForManagement.value
    : employeeManagementDepartmentId;
  const showAllEmployees = !departmentId && (
    EMPLOYEE_SELECTION_MODE === "list"
    || (DEPARTMENT_SELECTION_MODE === "tabs" && employeeManagementDepartmentId === "all")
  );
  const departmentEmployees = employeeManagementEmployees.filter((employee) =>
    employee.department_id === departmentId || showAllEmployees
  );
  const displayedEmployees = departmentEmployees.filter((employee) => {
    if (!searchQuery) return true;
    const departmentName = departments.find((department) => department.id === employee.department_id)?.name ?? "";
    return `${employee.full_name} ${departmentName} ${employee.job_title ?? ""} ${employee.employment_status ?? ""}`
      .toLowerCase()
      .includes(searchQuery);
  });

  departmentSelectForManagement.replaceChildren(new Option("Pilih fungsi", ""));
  for (const department of departments) {
    departmentSelectForManagement.add(new Option(department.name, department.id));
  }
  if (departments.some((department) => department.id === departmentId)) {
    departmentSelectForManagement.value = departmentId;
  }
  if (DEPARTMENT_SELECTION_MODE === "tabs") {
    renderEmployeeManagementDepartmentTabs();
    departmentSelectForManagement.value = employeeManagementDepartmentId === "all"
      ? ""
      : employeeManagementDepartmentId;
  } else {
    employeeManagementDepartmentId = departmentSelectForManagement.value || "all";
  }

  if (EMPLOYEE_SELECTION_MODE === "list") {
    employeeSelectForManagement.replaceChildren(new Option("Pilih pekerja", ""));
    for (const employee of displayedEmployees) {
      employeeSelectForManagement.add(new Option(employee.full_name, employee.id));
    }
    if (!displayedEmployees.some((employee) => employee.id === employeeManagementSelectedId)) {
      clearEmployeeManagementSelection();
    } else {
      employeeSelectForManagement.value = employeeManagementSelectedId;
    }
    document.querySelector("#edit-employee-button").disabled = !employeeManagementSelectedId;

    scrollWrap.style.setProperty("--visible-limit", String(employeeDisplayLimit));
    countBadge.textContent = `(${displayedEmployees.length})`;
    scrollHint.classList.toggle("hidden", displayedEmployees.length <= employeeDisplayLimit);
    searchClear.classList.toggle("hidden", !searchInput.value);
    employeeList.replaceChildren();
    if (displayedEmployees.length === 0) {
      const emptyState = document.createElement("div");
      emptyState.className = "p-4 text-center text-xs text-slate-400";
      emptyState.textContent = searchQuery
        ? `Tidak ada pekerja yang cocok dengan "${searchInput.value.trim()}"`
        : departmentId && departmentId !== "all"
          ? "Belum ada pekerja terdaftar di fungsi ini"
          : "Belum ada pekerja terdaftar";
      employeeList.append(emptyState);
    } else {
      for (const employee of displayedEmployees) {
        const isSelected = employee.id === employeeManagementSelectedId;
        const card = document.createElement("button");
        card.type = "button";
        card.className = `employee-card ${isSelected ? "is-selected" : ""}`;
        card.setAttribute("role", "radio");
        card.setAttribute("aria-checked", isSelected ? "true" : "false");
        card.dataset.employeeId = employee.id;
        const departmentName = departments.find((department) => department.id === employee.department_id)?.name;
        const badges = [];
        if ((departmentId === "all" || !departmentId || searchQuery) && departmentName) {
          badges.push(`<span class="employee-card-badge dept">${escapeHtml(departmentName)}</span>`);
        }
        if (employee.work_pattern) {
          const shift = employee.work_pattern.toLowerCase().includes("shift")
            && !employee.work_pattern.toLowerCase().includes("non");
          badges.push(`<span class="employee-card-badge ${shift ? "shift" : "non-shift"}">${escapeHtml(employee.work_pattern)}</span>`);
        }
        if (employee.job_title) badges.push(`<span>${escapeHtml(employee.job_title)}</span>`);
        else if (employee.employment_status) badges.push(`<span>${escapeHtml(employee.employment_status)}</span>`);
        if (!employee.is_active) badges.push('<span class="employee-card-badge">Tidak aktif</span>');
        card.innerHTML = `
          <div class="employee-card-info">
            <span class="employee-card-name">${escapeHtml(employee.full_name)}</span>
            <div class="employee-card-meta">${badges.join("")}</div>
          </div>
          <div class="employee-card-radio"><i data-lucide="check"></i></div>
        `;
        card.addEventListener("click", () => {
          employeeManagementSelectedId = employee.id;
          if (DEPARTMENT_SELECTION_MODE === "tabs") {
            employeeManagementDepartmentId = employee.department_id;
            renderEmployeeManagementPicker();
          } else {
            departmentSelectForManagement.value = employee.department_id;
            employeeManagementDepartmentId = employee.department_id;
            renderEmployeeManagementPicker();
          }
          employeeSelectForManagement.value = employee.id;
          document.querySelector("#edit-employee-button").disabled = false;
        });
        employeeList.append(card);
      }
    }
    window.lucide?.createIcons();
  } else {
    employeeSelectForManagement.replaceChildren(new Option(
      !departmentId && !showAllEmployees
        ? "Pilih fungsi terlebih dahulu"
        : displayedEmployees.length
          ? "Pilih pekerja"
          : "Belum ada pekerja terdaftar",
      ""
    ));
    for (const employee of displayedEmployees) {
      const departmentName = departments.find((department) => department.id === employee.department_id)?.name;
      const departmentLabel = showAllEmployees && departmentName ? ` — ${departmentName}` : "";
      const inactiveLabel = employee.is_active ? "" : " [Tidak aktif]";
      employeeSelectForManagement.add(new Option(
        `${employee.full_name}${departmentLabel}${inactiveLabel}`,
        employee.id
      ));
    }
    employeeSelectForManagement.value = displayedEmployees.some(
      (employee) => employee.id === employeeManagementSelectedId
    ) ? employeeManagementSelectedId : "";
    employeeManagementSelectedId = employeeSelectForManagement.value;
    document.querySelector("#edit-employee-button").disabled = !employeeManagementSelectedId;
  }
}

function openEmployeeEditModal(employeeId) {
  if (!canEditEmployeeData()) {
    showToast("Anda tidak diizinkan mengubah data pekerja.", true);
    return;
  }
  const employee = employeeManagementEmployees.find((item) => item.id === employeeId);
  if (!employee) {
    showToast("Data pekerja tidak ditemukan. Muat ulang daftar pekerja.", true);
    return;
  }

  const departmentSelectForEdit = document.querySelector("#employee-edit-department");
  const subdepartmentSelectForEdit = document.querySelector("#employee-edit-subdepartment");
  document.querySelector("#employee-edit-form").reset();
  employeeEditModal.dataset.employeeId = employee.id;
  employeeEditModal.dataset.originalDepartmentId = employee.department_id;
  employeeEditModal.dataset.originalSubDepartmentId = employee.sub_department_id ?? "";
  document.querySelector("#employee-edit-name").value = employee.full_name;
  document.querySelector("#employee-edit-status").value = employee.employment_status ?? "";
  document.querySelector("#employee-edit-job-title").value = employee.job_title ?? "";
  populateDepartmentSelect(departmentSelectForEdit, employee.department_id);
  document.querySelector("#employee-edit-work-pattern").value = employee.work_pattern ?? "";
  populateSubdepartmentSelect(
    subdepartmentSelectForEdit,
    employee.department_id,
    employee.sub_department_id ?? ""
  );
  document.querySelector("#employee-edit-active").checked = employee.is_active;
  employeeEditModal.showModal();
  refreshIcons();
}

async function saveEmployeeData(event) {
  event.preventDefault();
  if (!canEditEmployeeData()) {
    showToast("Anda tidak diizinkan mengubah data pekerja.", true);
    return;
  }

  const employeeId = employeeEditModal.dataset.employeeId;
  const departmentId = document.querySelector("#employee-edit-department").value;
  const name = document.querySelector("#employee-edit-name").value.trim();
  const subDepartmentId = canManageHrFeature("employee_subdepartment")
    ? document.querySelector("#employee-edit-subdepartment").value || null
    : employeeEditModal.dataset.originalSubDepartmentId || null;
  if (!employeeId || !departmentId || !name) {
    showToast("Departemen dan nama pekerja wajib diisi.", true);
    return;
  }
  if (
    subDepartmentId
    && !subdepartmentsForDepartment(departmentId).some((item) => item.id === subDepartmentId)
  ) {
    showToast("Subfungsi tidak sesuai dengan departemen pekerja.", true);
    return;
  }

  const button = document.querySelector("#save-employee-edit");
  setBusy(button, true, "Menyimpan…");
  try {
    const { data, error } = await client.rpc("update_employee_data", {
      p_employee_id: employeeId,
      p_department_id: departmentId,
      p_full_name: name,
      p_employment_status: document.querySelector("#employee-edit-status").value || null,
      p_job_title: document.querySelector("#employee-edit-job-title").value.trim() || null,
      p_work_pattern: document.querySelector("#employee-edit-work-pattern").value || null,
      p_sub_department_id: subDepartmentId,
      p_is_active: document.querySelector("#employee-edit-active").checked
    });
    if (error) throw error;

    const savedEmployee = Array.isArray(data) ? data[0] : data;
    if (!savedEmployee?.id) {
      throw new Error("Respons penyimpanan data pekerja tidak lengkap.");
    }

    employeeEditModal.close();
    employeeManagementSelectedId = savedEmployee.id;
    document.querySelector("#employee-management-search").value = "";
    if (DEPARTMENT_SELECTION_MODE === "tabs") {
      employeeManagementDepartmentId = savedEmployee.department_id;
    } else {
      document.querySelector("#employee-management-department").value = savedEmployee.department_id;
      employeeManagementDepartmentId = savedEmployee.department_id;
    }
    try {
      await Promise.all([loadEmployees(), loadEmployeeManagementList()]);
      if (isSummaryViewer()) {
        await loadDailyCoverage();
        renderSummary();
      }
      showToast("Data pekerja berhasil diperbarui.");
    } catch (refreshError) {
      console.error("Employee updated but the displayed data could not be refreshed:", refreshError);
      showToast(`Data tersimpan, tetapi tampilan gagal diperbarui: ${refreshError.message}`, true);
    }
  } catch (error) {
    console.error("Employee update failed:", error);
    showToast(`Gagal memperbarui data pekerja: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function renderSubdepartmentControls() {
  if (!isAdmin()) return;

  const departmentSelectForSubdepartment = document.querySelector("#subdepartment-department");
  const supervisorsSubdepartment = document.querySelector("#supervisor-subdepartment");
  const employeeSelectForAssignment = document.querySelector("#subdepartment-employee");
  const employeeSubdepartmentSelect = document.querySelector("#employee-subdepartment");
  const selectedDepartmentId = departmentSelectForSubdepartment.value;
  const selectedSubdepartmentId = supervisorsSubdepartment.value;
  const selectedEmployeeId = employeeSelectForAssignment.value;

  departmentSelectForSubdepartment.replaceChildren(new Option("Pilih fungsi", ""));
  for (const department of departments) {
    departmentSelectForSubdepartment.add(new Option(department.name, department.id));
  }
  if (departments.some((department) => department.id === selectedDepartmentId)) {
    departmentSelectForSubdepartment.value = selectedDepartmentId;
  }

  supervisorsSubdepartment.replaceChildren(new Option("Pilih subfungsi", ""));
  for (const subdepartment of subdepartments) {
    const departmentName = departments.find((department) => department.id === subdepartment.department_id)?.name ?? "";
    supervisorsSubdepartment.add(new Option(`${departmentName} — ${subdepartment.name}`, subdepartment.id));
  }
  if (subdepartments.some((subdepartment) => subdepartment.id === selectedSubdepartmentId)) {
    supervisorsSubdepartment.value = selectedSubdepartmentId;
  }

  employeeSelectForAssignment.replaceChildren(new Option("Pilih pekerja", ""));
  for (const employee of employees) {
    const departmentName = departments.find((department) => department.id === employee.department_id)?.name ?? "";
    employeeSelectForAssignment.add(new Option(`${employee.full_name} — ${departmentName}`, employee.id));
  }
  if (employees.some((employee) => employee.id === selectedEmployeeId)) {
    employeeSelectForAssignment.value = selectedEmployeeId;
  }

  const selectedEmployee = employees.find((employee) => employee.id === employeeSelectForAssignment.value);
  populateSubdepartmentSelect(
    employeeSubdepartmentSelect,
    selectedEmployee?.department_id,
    selectedEmployee?.sub_department_id ?? "",
    selectedEmployee ? "Tanpa subfungsi" : "Pilih pekerja terlebih dahulu"
  );
  populateSubdepartmentSelect(
    document.querySelector("#new-employee-subdepartment"),
    departmentSelect.value,
    "",
    "Tanpa subfungsi"
  );

  renderSubdepartmentSupervisorList();
}

function renderSubdepartmentSupervisorList() {
  const list = document.querySelector("#subdepartment-supervisor-list");
  if (!list) return;
  if (subdepartments.length === 0) {
    list.innerHTML = '<p class="text-sm text-slate-500">Belum ada subfungsi.</p>';
    return;
  }

  list.innerHTML = subdepartments.map((subdepartment) => {
    const departmentName = departments.find((department) => department.id === subdepartment.department_id)?.name ?? "";
    const supervisors = subdepartmentSupervisors.filter((item) => item.sub_department_id === subdepartment.id);
    const contactsHtml = supervisors.length
      ? `<ul class="mt-2 space-y-2">${supervisors.map((supervisor) => `
          <li class="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
            <span class="min-w-0 text-sm"><span class="block truncate font-semibold text-slate-800">${escapeHtml(supervisor.full_name)}</span><span class="text-xs text-slate-500">${escapeHtml(supervisor.whatsapp_number)}</span></span>
            ${canManageHrFeature("supervisors") ? `<button class="secondary-button min-h-[32px] shrink-0 px-2 py-1 text-xs" type="button" data-subdepartment-action="remove-supervisor" data-id="${escapeHtml(supervisor.id)}" aria-label="Hapus pengawas ${escapeHtml(supervisor.full_name)}">Hapus</button>` : ""}
          </li>`).join("")}</ul>`
      : '<p class="mt-2 text-xs text-slate-500">Belum ada kontak pengawas.</p>';
    return `<article class="rounded-xl border border-slate-200 p-3">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0"><p class="text-xs text-slate-500">${escapeHtml(departmentName)}</p><h4 class="font-semibold text-slate-800">${escapeHtml(subdepartment.name)}</h4></div>
        ${canManageHrFeature("subdepartments") ? `<button class="secondary-button min-h-[32px] shrink-0 px-2 py-1 text-xs" type="button" data-subdepartment-action="remove-subdepartment" data-id="${escapeHtml(subdepartment.id)}">Hapus</button>` : ""}
      </div>
      ${contactsHtml}
    </article>`;
  }).join("");
}

async function loadSubdepartments() {
  if (!isAdmin()) return;
  const [subdepartmentResult, supervisorResult] = await Promise.all([
    client.from("sub_departments").select("id, department_id, name").order("name"),
    client.from("sub_department_supervisors").select("id, sub_department_id, full_name, whatsapp_number").order("full_name")
  ]);
  if (subdepartmentResult.error) throw subdepartmentResult.error;
  if (supervisorResult.error) throw supervisorResult.error;
  subdepartments = subdepartmentResult.data ?? [];
  subdepartmentSupervisors = supervisorResult.data ?? [];
  renderSubdepartmentControls();
}

async function saveSubdepartment(event) {
  event.preventDefault();
  if (!canManageHrFeature("subdepartments")) {
    showToast("Anda tidak diizinkan mengelola subfungsi.", true);
    return;
  }
  const departmentId = document.querySelector("#subdepartment-department").value;
  const name = document.querySelector("#subdepartment-name").value.trim();
  const button = document.querySelector("#save-subdepartment");
  if (!departmentId || !name) {
    showToast("Fungsi dan nama subfungsi wajib diisi.", true);
    return;
  }

  setBusy(button, true, "Menyimpan…");
  try {
    const { error } = await client.from("sub_departments").insert({ department_id: departmentId, name });
    if (error) throw error;
    document.querySelector("#subdepartment-form").reset();
    await loadSubdepartments();
    showToast("Subfungsi berhasil ditambahkan.");
  } catch (error) {
    console.error("Subdepartment save failed:", error);
    showToast(`Gagal menyimpan subfungsi: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

async function saveSupervisor(event) {
  event.preventDefault();
  if (!canManageHrFeature("supervisors")) {
    showToast("Anda tidak diizinkan mengelola pengawas subfungsi.", true);
    return;
  }
  const subDepartmentId = document.querySelector("#supervisor-subdepartment").value;
  const fullName = document.querySelector("#supervisor-name").value.trim();
  const whatsappNumber = normalizeSupervisorPhone(document.querySelector("#supervisor-whatsapp").value);
  const button = document.querySelector("#save-supervisor");
  if (!subDepartmentId || !fullName || !/^62\d{8,13}$/.test(whatsappNumber)) {
    showToast("Pilih subfungsi, isi nama, dan masukkan nomor WhatsApp Indonesia yang valid.", true);
    return;
  }

  setBusy(button, true, "Menyimpan…");
  try {
    const { error } = await client.from("sub_department_supervisors").insert({
      sub_department_id: subDepartmentId,
      full_name: fullName,
      whatsapp_number: whatsappNumber
    });
    if (error) throw error;
    document.querySelector("#supervisor-form").reset();
    await loadSubdepartments();
    showToast("Pengawas berhasil ditambahkan.");
  } catch (error) {
    console.error("Supervisor save failed:", error);
    showToast(`Gagal menyimpan pengawas: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

async function saveEmployeeSubdepartment(event) {
  event.preventDefault();
  if (!canManageHrFeature("employee_subdepartment")) {
    showToast("Anda tidak diizinkan menetapkan subfungsi pekerja.", true);
    return;
  }
  const employeeId = document.querySelector("#subdepartment-employee").value;
  const subDepartmentId = document.querySelector("#employee-subdepartment").value || null;
  const button = document.querySelector("#save-employee-subdepartment");
  if (!employeeId) {
    showToast("Pilih pekerja terlebih dahulu.", true);
    return;
  }

  setBusy(button, true, "Menyimpan…");
  try {
    const { data, error } = await client.rpc("update_employee_subdepartment", {
      p_employee_id: employeeId,
      p_sub_department_id: subDepartmentId
    });
    if (error) throw error;
    const savedEmployee = Array.isArray(data) ? data[0] : data;
    if (!savedEmployee?.employee_id) {
      throw new Error("Respons penetapan subfungsi tidak lengkap.");
    }
    const employee = employees.find((item) => item.id === savedEmployee.employee_id);
    if (employee) employee.sub_department_id = savedEmployee.sub_department_id;
    renderSubdepartmentControls();
    showToast("Penetapan subfungsi pekerja berhasil disimpan.");
  } catch (error) {
    console.error("Employee subdepartment assignment failed:", error);
    showToast(`Gagal menyimpan penetapan subfungsi: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

async function handleSubdepartmentManagerClick(event) {
  const button = event.target.closest("button[data-subdepartment-action]");
  if (!button) return;
  const { subdepartmentAction: action, id } = button.dataset;
  const isSubdepartment = action === "remove-subdepartment";
  if (!canManageHrFeature(isSubdepartment ? "subdepartments" : "supervisors")) {
    showToast(
      isSubdepartment
        ? "Anda tidak diizinkan mengelola subfungsi."
        : "Anda tidak diizinkan mengelola pengawas subfungsi.",
      true
    );
    return;
  }
  const confirmed = window.confirm(isSubdepartment
    ? "Hapus subfungsi ini? Subfungsi yang masih digunakan oleh pekerja tidak dapat dihapus."
    : "Hapus kontak pengawas ini?");
  if (!confirmed) return;

  button.disabled = true;
  try {
    const table = isSubdepartment ? "sub_departments" : "sub_department_supervisors";
    const { error } = await client.from(table).delete().eq("id", id);
    if (error) throw error;
    await loadSubdepartments();
    showToast(isSubdepartment ? "Subfungsi berhasil dihapus." : "Kontak pengawas berhasil dihapus.");
  } catch (error) {
    console.error("Subdepartment data deletion failed:", error);
    showToast(`Gagal menghapus data: ${error.message}`, true);
    button.disabled = false;
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
    syncIcon.innerHTML = '<i data-lucide="wifi-off" class="text-amber-700"></i>';
    offlineQueueBadge.setAttribute("aria-label", "Status koneksi: Offline");
    offlineQueueBadge.title = "Status koneksi: Offline";
  } else if (isSyncing) {
    offlineQueueBadge.className = "sync-badge is-syncing";
    syncIcon.innerHTML = '<i data-lucide="refresh-cw" class="text-blue-600 animate-spin"></i>';
    offlineQueueBadge.setAttribute("aria-label", "Sedang menyinkronkan antrean");
    offlineQueueBadge.title = "Sedang menyinkronkan antrean";
  } else {
    offlineQueueBadge.className = "sync-badge";
    syncIcon.innerHTML = '<i data-lucide="wifi" class="text-emerald-600"></i>';
    offlineQueueBadge.setAttribute("aria-label", "Status koneksi: Online");
    offlineQueueBadge.title = "Status koneksi: Online";
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
        ? `Daftar Nama: ${escapeHtml(item.payload?.p_full_name || "Pekerja Baru")}`
        : `Checkup: ${escapeHtml(employees.find((e) => e.id === item.employee_id)?.full_name || "Pekerja")}`;
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
    refreshIcons(queueList);
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

  // 1. Sinkronkan Pekerja Tamu Baru
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
      console.error("Gagal menyinkronkan penambahan pekerja tamu:", err);
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
      const isGuestSubmission = Boolean(item.is_guest || guestMode || !currentUser);
      if (isGuestSubmission) {
        const deviceToken = item.device_token || guestProfile?.deviceToken || createDeviceToken();
        const { data, error } = await client.rpc("submit_guest_checkup", {
          p_employee_id: targetEmployeeId,
          p_device_token: deviceToken,
          p_systolic: item.payload.systolic,
          p_diastolic: item.payload.diastolic,
          p_temperature_c: item.payload.temperature_c,
          p_fatigue_level: item.payload.fatigue_level,
          ...(item.payload.sleep_hours == null
            ? { p_sleep_quality: item.payload.sleep_quality }
            : { p_sleep_hours: item.payload.sleep_hours }),
          p_symptoms: item.payload.symptoms,
          p_notes: item.payload.notes,
          p_measurement_provider: item.payload.measurement_provider ?? null,
          p_location_latitude: item.payload.location_latitude ?? null,
          p_location_longitude: item.payload.location_longitude ?? null,
          p_location_accuracy_m: item.payload.location_accuracy_m ?? null,
          p_location_captured_at: item.payload.location_captured_at ?? null
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
        : isSelfCheckupAccount()
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

async function mergePendingOfflineGuests() {
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
          is_active: true,
          requires_substance_questions: isSubstanceQuestionEligible({
            department_id: item.payload.p_department_id,
            job_title: item.payload.p_job_title
          })
        });
      }
    }
    employees.sort((a, b) => a.full_name.localeCompare(b.full_name, "id"));
  } catch (_) {}
}

async function loadGuestDirectory() {
  let hasRenderedFromCache = false;

  // 1. Sajikan instan dari cache IndexedDB (<10ms) jika tersedia
  try {
    const cached = await getDirectoryCache();
    if (cached && (cached.departments?.length > 0 || cached.employees?.length > 0)) {
      departments = cached.departments || [];
      employees = cached.employees || [];
      await mergePendingOfflineGuests();
      populateDepartmentSelect(departmentSelect);
      populateDepartmentSelect(document.querySelector("#profile-department"));
      updateEmployeeOptions();
      updateSubstanceQuestionVisibility();
      hasRenderedFromCache = true;
    }
  } catch (e) {
    console.warn("Gagal membaca cache awal direktori:", e);
  }

  // 2. Jika online, perbarui data dari server di latar belakang/langsung
  try {
    if (!navigator.onLine) {
      if (!hasRenderedFromCache) throw new Error("Offline");
      return;
    }
    const { data, error } = await client.rpc("get_guest_directory_with_substance_rules");
    if (error) throw error;
    const directory = data ?? [];

    departments = [...new Map(directory.map((row) => [
      row.department_id,
      { id: row.department_id, name: row.department_name }
    ])).values()].sort((a, b) => a.name.localeCompare(b.name, "id"));
    employees = directory.filter((row) => row.employee_id).map((row) => ({
      id: row.employee_id,
      department_id: row.department_id,
      full_name: row.employee_name,
      requires_substance_questions: row.requires_substance_questions,
      is_active: true
    })).sort((a, b) => a.full_name.localeCompare(b.full_name, "id"));

    // Simpan ke cache lokal IndexedDB (hanya data publik aman)
    await saveDirectoryCache(departments, employees);
    await mergePendingOfflineGuests();

    populateDepartmentSelect(departmentSelect);
    populateDepartmentSelect(document.querySelector("#profile-department"));
    updateEmployeeOptions();
    updateSubstanceQuestionVisibility();
  } catch (err) {
    if (!hasRenderedFromCache) {
      console.warn("Memuat direktori dari cache offline fallback:", err);
      const cached = await getDirectoryCache();
      if (cached && (cached.departments?.length > 0 || cached.employees?.length > 0)) {
        departments = cached.departments || [];
        employees = cached.employees || [];
        await mergePendingOfflineGuests();
        populateDepartmentSelect(departmentSelect);
        populateDepartmentSelect(document.querySelector("#profile-department"));
        updateEmployeeOptions();
        updateSubstanceQuestionVisibility();
        showToast("Menggunakan direktori tersimpan (offline).");
      } else {
        throw new Error("Data pekerja belum tersedia offline. Hubungkan ke internet setidaknya sekali.");
      }
    }
  }
}

async function loadEmployees() {
  const selectedEmployee = employeeSelect.value;
  const { data, error } = await client
    .from("employees")
    .select("id, department_id, sub_department_id, full_name, employment_status, job_title, work_pattern, is_active")
    .eq("is_active", true)
    .order("full_name");
  if (error) throw error;
  employees = data ?? [];
  updateEmployeeOptions();
  renderSubdepartmentControls();

  const ownEmployee = employees.find((employee) => employee.id === currentEmployeeId);
  if (isLinkedAdminHrCheckupAccount() && ownEmployee) {
    departmentSelect.value = ownEmployee.department_id;
    updateEmployeeOptions();
    employeeSelect.value = ownEmployee.id;
    departmentSelect.disabled = true;
    employeeSelect.disabled = true;
    syncEmployeeListUI(ownEmployee.id);
    document.querySelector("#checkup-identity-controls").classList.add("hidden");
    document.querySelector("#checkup-identity-name").textContent = ownEmployee.full_name;
    document.querySelector("#checkup-identity-department").textContent =
      departments.find((department) => department.id === ownEmployee.department_id)?.name ?? "—";
    document.querySelector("#checkup-identity-summary").classList.remove("hidden");
    document.querySelector("#checkup-identity-summary").classList.add("flex");
    document.querySelector("#edit-checkup-identity").classList.add("hidden");
  } else if (!isAdmin() && ownEmployee) {
    departmentSelect.value = ownEmployee.department_id;
    updateEmployeeOptions();
    employeeSelect.value = ownEmployee.id;
    departmentSelect.disabled = isCheckupIdentityLocked();
    employeeSelect.disabled = isCheckupIdentityLocked();
    syncEmployeeListUI(ownEmployee.id);
    if (isDepartmentRepresentative()) {
      document.querySelector("#checkup-identity-controls").classList.add("hidden");
      document.querySelector("#checkup-identity-name").textContent = ownEmployee.full_name;
      document.querySelector("#checkup-identity-department").textContent =
        departments.find((department) => department.id === ownEmployee.department_id)?.name ?? "—";
      document.querySelector("#checkup-identity-summary").classList.remove("hidden");
      document.querySelector("#checkup-identity-summary").classList.add("flex");
      document.querySelector("#edit-checkup-identity").classList.add("hidden");
    } else {
      document.querySelector("#checkup-identity-controls").classList.remove("hidden");
      document.querySelector("#checkup-identity-summary").classList.add("hidden");
      document.querySelector("#checkup-identity-summary").classList.remove("flex");
      document.querySelector("#edit-checkup-identity").classList.remove("hidden");
    }
  } else if (isAdmin()) {
    document.querySelector("#checkup-identity-controls").classList.remove("hidden");
    document.querySelector("#checkup-identity-summary").classList.add("hidden");
    document.querySelector("#checkup-identity-summary").classList.remove("flex");
    document.querySelector("#edit-checkup-identity").classList.remove("hidden");
    departmentSelect.disabled = isCheckupIdentityLocked();
    employeeSelect.disabled = isCheckupIdentityLocked();
    if (employees.some((employee) => employee.id === selectedEmployee && employee.department_id === departmentSelect.value)) {
      employeeSelect.value = selectedEmployee;
      syncEmployeeListUI(selectedEmployee);
    }
  } else {
    throw new Error("Akun belum ditautkan ke data pekerja. Hubungi administrator.");
  }
  updateSubstanceQuestionVisibility();
}

function getHistoryFilters() {
  return {
    from: document.querySelector("#filter-from").value,
    to: document.querySelector("#filter-to").value,
    departmentId: isDepartmentRepresentative()
      ? currentDepartmentId
      : document.querySelector("#history-department").value,
    readinessStatus: document.querySelector("#history-readiness").value
  };
}

async function loadCheckups() {
  historyList.innerHTML = '<div class="empty-state">Memuat riwayat…</div>';
  let query = client
    .from("checkups")
    .select("id, employee_id, checked_at, systolic, diastolic, temperature_c, fatigue_level, sleep_hours, sleep_quality, symptoms, notes, measurement_provider, readiness_status, location_latitude, location_longitude, location_accuracy_m, location_captured_at, employees!inner(full_name, department_id, departments(name))")
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
  if (isSummaryViewer()) await loadDailyCoverage();
  renderHistory();
  renderSummary();
}

async function loadDailyCoverage() {
  employeesWithoutTodayCheckup = null;
  document.querySelector("#stat-missing-dcu").textContent = "—";
  document.querySelector("#missing-dcu-card").disabled = true;
  if (missingDcuModal.open) renderMissingDcuModal();
  const { start, end } = getDateRange();
  const departmentId = isDepartmentRepresentative() ? currentDepartmentId : null;
  const checkupSelect = departmentId ? "id, employees!inner(department_id)" : "id";
  let checkupQuery = client
    .from("checkups")
    .select(checkupSelect, { count: "exact", head: true })
    .gte("checked_at", start)
    .lt("checked_at", end);
  let employeeQuery = client
    .from("employees")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  if (departmentId) {
    checkupQuery = checkupQuery.eq("employees.department_id", departmentId);
    employeeQuery = employeeQuery.eq("department_id", departmentId);
  }
  const [checkupResult, employeeResult, readinessCountEntries, missingEmployees] = await Promise.all([
    checkupQuery,
    employeeQuery,
    Promise.all(Object.keys(statusDetails).map(async (status) => {
      let query = client
        .from("checkups")
        .select(departmentId ? "id, employees!inner(department_id)" : "id", { count: "exact", head: true })
        .gte("checked_at", start)
        .lt("checked_at", end)
        .eq("readiness_status", status);
      if (departmentId) query = query.eq("employees.department_id", departmentId);
      const result = await query;
      if (result.error) throw result.error;
      return [status, result.count ?? 0];
    })),
    loadEmployeesWithoutTodayCheckup(start, end, departmentId)
  ]);
  if (checkupResult.error) throw checkupResult.error;
  if (employeeResult.error) throw employeeResult.error;
  todayCheckupCount = checkupResult.count ?? 0;
  activeEmployeeCount = employeeResult.count ?? 0;
  todayReadinessCounts = Object.fromEntries(readinessCountEntries);
  employeesWithoutTodayCheckup = missingEmployees;
}

async function loadEmployeesWithoutTodayCheckup(start, end, departmentId) {
  const pageSize = 1000;
  const activeEmployees = [];
  for (let offset = 0; ; offset += pageSize) {
    let query = client
      .from("employees")
      .select("id, department_id, full_name, employment_status, work_pattern")
      .eq("is_active", true)
      .order("full_name")
      .order("id")
      .range(offset, offset + pageSize - 1);
    if (departmentId) query = query.eq("department_id", departmentId);
    const { data, error } = await query;
    if (error) throw error;
    activeEmployees.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }

  const checkedEmployeeIds = new Set();
  for (let offset = 0; ; offset += pageSize) {
    const select = departmentId ? "id, employee_id, employees!inner(department_id)" : "id, employee_id";
    let query = client
      .from("checkups")
      .select(select)
      .gte("checked_at", start)
      .lt("checked_at", end)
      .order("id")
      .range(offset, offset + pageSize - 1);
    if (departmentId) query = query.eq("employees.department_id", departmentId);
    const { data, error } = await query;
    if (error) throw error;
    for (const checkup of data ?? []) checkedEmployeeIds.add(checkup.employee_id);
    if (!data || data.length < pageSize) break;
  }

  return activeEmployees.filter((employee) => !checkedEmployeeIds.has(employee.id));
}

function renderHistory() {
  if (!checkups.length) {
    historyList.innerHTML = '<div class="empty-state"><i data-lucide="clipboard-list"></i>Belum ada checkup untuk filter ini.</div>';
    refreshIcons(historyList);
    return;
  }

  historyList.innerHTML = checkups.map((checkup) => {
    const status = statusDetails[checkup.readiness_status] ?? statusDetails.need_observation;
    const employee = checkup.employees;
    const symptoms = Object.entries(checkup.symptoms ?? {})
      .filter(([key, selected]) => selected && !Object.values(substanceQuestionKeys).includes(key))
      .map(([key]) => symptomLabels[key] ?? key);
    const substanceAnswers = [
      [substanceQuestionKeys.medication, "Konsumsi obat-obatan yang menyebabkan kantuk dalam 24 jam terakhir"],
      [substanceQuestionKeys.alcohol, "Konsumsi alkohol dalam 24 jam terakhir"]
    ].filter(([key]) => typeof checkup.symptoms?.[key] === "boolean");
    const locationDetails = checkup.location_latitude !== null
      && checkup.location_latitude !== undefined
      && checkup.location_longitude !== null
      && checkup.location_longitude !== undefined
      && Number.isFinite(Number(checkup.location_latitude))
      && Number.isFinite(Number(checkup.location_longitude))
      ? `<p class="mt-2 text-xs text-slate-500"><b class="text-slate-600">Lokasi:</b> ${Number(checkup.location_latitude).toFixed(6)}, ${Number(checkup.location_longitude).toFixed(6)} · akurasi ±${Number(checkup.location_accuracy_m).toFixed(1)} m${checkup.location_captured_at ? ` · ${escapeHtml(formatDate(checkup.location_captured_at))}` : ""}</p>`
      : "";
    return `<article class="history-card">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h2 class="truncate text-sm font-bold text-slate-900">${escapeHtml(employee?.full_name ?? "Pekerja")}</h2>
          <p class="mt-1 text-xs text-slate-500">${escapeHtml(employee?.departments?.name ?? "—")} · ${escapeHtml(formatDate(checkup.checked_at))}</p>
        </div>
        <span class="status-pill ${status.pill}"><i data-lucide="${status.icon}"></i>${status.label}</span>
      </div>
      <div class="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-xs">
        <p><span class="block text-slate-400">Tekanan darah</span><b class="mt-1 block text-slate-700">${checkup.systolic}/${checkup.diastolic}</b></p>
        <p><span class="block text-slate-400">Suhu</span><b class="mt-1 block text-slate-700">${Number(checkup.temperature_c).toFixed(1)}°C</b></p>
        <p><span class="block text-slate-400">Kelelahan / tidur</span><b class="mt-1 block text-slate-700">${checkup.fatigue_level} / ${checkup.sleep_hours != null ? `${checkup.sleep_hours} jam` : `${checkup.sleep_quality ?? "—"}/5 (data lama)`}</b></p>
      </div>
      ${symptoms.length ? `<p class="mt-3 text-xs leading-5 text-slate-500"><b class="text-slate-600">Gejala:</b> ${escapeHtml(symptoms.join(", "))}</p>` : ""}
      ${substanceAnswers.length ? `<div class="mt-3 space-y-1 text-xs leading-5 text-slate-500">${substanceAnswers.map(([key, label]) => `<p><b class="text-slate-600">${label}:</b> ${checkup.symptoms[key] ? "Ya" : "Tidak"}</p>`).join("")}</div>` : ""}
      ${checkup.measurement_provider ? `<p class="mt-2 text-xs leading-5 text-slate-500"><b class="text-slate-600">Tenaga medis:</b> ${escapeHtml(checkup.measurement_provider)}</p>` : ""}
      ${checkup.notes ? `<p class="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-500">${escapeHtml(checkup.notes)}</p>` : ""}
      ${locationDetails}
    </article>`;
  }).join("");
  refreshIcons(historyList);
}

function renderSummary() {
  const departmentLabel = document.querySelector("#stat-active-department");
  const departmentName = departments.find((department) => department.id === currentDepartmentId)?.name;
  departmentLabel.textContent = isDepartmentRepresentative() && departmentName
    ? ` — ${departmentName}`
    : "";
  departmentLabel.classList.toggle("hidden", !isDepartmentRepresentative() || !departmentName);

  const counts = isSummaryViewer() && todayReadinessCounts
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
  if (isSummaryViewer() && todayCheckupCount !== null && activeEmployeeCount !== null) {
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
  const missingDcuCard = document.querySelector("#missing-dcu-card");
  missingDcuCard.classList.toggle("hidden", !isSummaryViewer());
  missingDcuCard.disabled = !isSummaryViewer() || employeesWithoutTodayCheckup === null;
  const missingDepartmentLabel = document.querySelector("#stat-missing-department");
  missingDepartmentLabel.textContent = isDepartmentRepresentative() && departmentName
    ? ` — ${departmentName}`
    : "";
  missingDepartmentLabel.classList.toggle("hidden", !isDepartmentRepresentative() || !departmentName);
  document.querySelector("#stat-missing-dcu").textContent = employeesWithoutTodayCheckup === null
    ? "—"
    : String(employeesWithoutTodayCheckup.length);
  if (missingDcuModal.open && employeesWithoutTodayCheckup !== null) renderMissingDcuModal();
}

function renderMissingDcuModal() {
  const list = document.querySelector("#missing-dcu-list");
  const exportButton = document.querySelector("#export-missing-dcu-csv");
  const departmentFilterWrap = document.querySelector("#missing-dcu-department-filter-wrap");
  const departmentFilter = document.querySelector("#missing-dcu-department-filter");
  const isLoaded = employeesWithoutTodayCheckup !== null;
  const canFilterByDepartment = isAdmin();
  departmentFilterWrap.classList.toggle("hidden", !canFilterByDepartment);
  if (canFilterByDepartment) {
    const hasSelectedDepartment = departments.some((department) => department.id === selectedMissingDcuDepartmentId);
    if (selectedMissingDcuDepartmentId && !hasSelectedDepartment) selectedMissingDcuDepartmentId = "";
    departmentFilter.innerHTML = '<option value="">Semua fungsi</option>' + departments.map((department) =>
      `<option value="${escapeHtml(department.id)}">${escapeHtml(department.name)}</option>`
    ).join("");
    departmentFilter.value = selectedMissingDcuDepartmentId;
  }
  const missingEmployees = getFilteredMissingDcuEmployees();
  const departmentsById = new Map(departments.map((department) => [department.id, department.name]));

  document.querySelector("#missing-dcu-date").textContent = getAppToday();
  document.querySelector("#missing-dcu-count").textContent = isLoaded ? String(missingEmployees.length) : "—";
  exportButton.disabled = !isLoaded || missingEmployees.length === 0;
  list.innerHTML = !isLoaded
    ? '<div class="empty-state">Memuat daftar pekerja…</div>'
    : missingEmployees.length
    ? missingEmployees.map((employee) => `<div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
        <span class="min-w-0 truncate text-sm font-semibold text-slate-800">${escapeHtml(employee.full_name)}</span>
        <span class="shrink-0 text-right text-xs text-slate-500">${escapeHtml(departmentsById.get(employee.department_id) ?? "—")}</span>
      </div>`).join("")
    : '<div class="empty-state">Semua pekerja aktif telah melakukan DCU hari ini.</div>';
  refreshIcons();
}

function getFilteredMissingDcuEmployees() {
  const missingEmployees = employeesWithoutTodayCheckup ?? [];
  if (!isAdmin() || !selectedMissingDcuDepartmentId) return missingEmployees;
  return missingEmployees.filter((employee) => employee.department_id === selectedMissingDcuDepartmentId);
}

function openMissingDcuModal() {
  if (employeesWithoutTodayCheckup === null) {
    showToast("Daftar pekerja belum tersedia. Coba muat ulang Ringkasan.", true);
    return;
  }
  selectedMissingDcuDepartmentId = "";
  renderMissingDcuModal();
  missingDcuModal.showModal();
}

function collectCheckup() {
  const symptoms = Object.fromEntries(
    [...checkupForm.querySelectorAll('input[name="symptoms"]')].map((input) => [input.value, input.checked])
  );
  const selectedEmployee = employees.find((employee) => employee.id === employeeSelect.value);
  if (isSubstanceQuestionEligible(selectedEmployee) === true) {
    symptoms[substanceQuestionKeys.medication] =
      checkupForm.querySelector('input[name="substance_medication_24h"]').checked;
    symptoms[substanceQuestionKeys.alcohol] =
      checkupForm.querySelector('input[name="substance_alcohol_24h"]').checked;
  }
  return {
    employee_id: isCheckupIdentityLocked() ? currentEmployeeId : employeeSelect.value,
    systolic: Number(document.querySelector("#systolic").value),
    diastolic: Number(document.querySelector("#diastolic").value),
    temperature_c: Number(document.querySelector("#temperature").value),
    fatigue_level: Number(checkupForm.querySelector('input[name="fatigue_level"]:checked')?.value),
    sleep_hours: Number(document.querySelector("#sleep-hours").value),
    symptoms,
    notes: document.querySelector("#notes").value.trim() || null,
    measurement_provider: measurementProviderEnabled
      ? document.querySelector("#measurement-provider").value.trim() || null
      : null
  };
}

function formatWhatsAppAbnormalValue(value, isAbnormal) {
  return isAbnormal ? `*${value}*` : value;
}

function renderWhatsAppTemplate(template, variables) {
  return Object.entries(variables).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value ?? ""),
    template
  );
}

function reportText(payload, status, checkedAt, employeeName, departmentName) {
  const triggerSymptoms = new Set([
    "flu_cough",
    "dizziness",
    "muscle_pain",
    "alcohol_consumption_24h",
    "medication_consumption_24h",
    "breathing_difficulty",
    "chest_pain",
    "fainting"
  ]);
  const symptomNames = Object.entries(payload.symptoms || {})
    .filter(([key, selected]) => selected && !Object.values(substanceQuestionKeys).includes(key))
    .map(([key]) => {
      const label = symptomLabels[key];
      return label ? (triggerSymptoms.has(key) ? `*${label}*` : label) : null;
    })
    .filter(Boolean);

  const systolic = Number(payload.systolic);
  const diastolic = Number(payload.diastolic);
  const temperature = Number(payload.temperature_c);
  const sleepHours = Number(payload.sleep_hours);

  const formattedSystolic = formatWhatsAppAbnormalValue(
    String(payload.systolic),
    Number.isFinite(systolic) && (systolic >= 150 || systolic < 100)
  );
  const formattedDiastolic = formatWhatsAppAbnormalValue(
    String(payload.diastolic),
    Number.isFinite(diastolic) && (diastolic >= 100 || diastolic < 70)
  );
  const formattedTemperature = formatWhatsAppAbnormalValue(
    temperature.toFixed(1),
    Number.isFinite(temperature) && temperature > 38
  );
  const formattedSleepHours = formatWhatsAppAbnormalValue(
    sleepHours.toFixed(1).replace(/\.0$/, ""),
    Number.isFinite(sleepHours) && (sleepHours < 3 || (sleepHours >= 3 && sleepHours <= 5))
  );

  let instructions = "";
  if (status === "fit_to_work") {
    instructions = "Anda dinyatakan fit untuk beraktivitas. Tetap patuhi protokol K3 dan utamakan keselamatan kerja.";
  } else if (status === "need_observation") {
    instructions = "Kondisi Anda memerlukan pemantauan/observasi. Harap berhati-hati, pantau kondisi fisik, dan laporkan ke atasan atau tim medis jika keluhan berlanjut.";
  } else {
    instructions = "Kondisi Anda disarankan untuk beristirahat. Harap segera melapor kepada atasan langsung atau fasilitas kesehatan kerja setempat dan tidak memaksakan diri bekerja.";
  }

  const template = waEmployeeTemplate?.trim() || `*HASIL DAILY CHECKUP HARIAN*
Halo {{employee_name}}, terima kasih telah mengisi pemeriksaan kesehatan harian.

• Status Kesiapan: *{{readiness_status}}*
• Tanggal & Waktu: {{checked_at}}
• Tekanan Darah: {{systolic}}/{{diastolic}} mmHg
• Suhu Tubuh: {{temperature}}°C
• Kelelahan: {{fatigue_level}}/5
• Jumlah Jam Tidur: {{sleep_hours}} jam
• Gejala: {{symptoms}}
• Catatan: {{notes}}

*Petunjuk K3:*
{{instructions}}`;

  return renderWhatsAppTemplate(template, {
    employee_name: employeeName,
    department_name: departmentName,
    sub_department_name: "-",
    readiness_status: statusDetails[status]?.label ?? status,
    checked_at: formatDate(checkedAt),
    systolic: formattedSystolic,
    diastolic: formattedDiastolic,
    temperature: formattedTemperature,
    fatigue_level: String(payload.fatigue_level),
    sleep_hours: formattedSleepHours,
    symptoms: symptomNames.length ? symptomNames.join(", ") : "Tidak ada keluhan",
    notes: payload.notes?.trim() || "-",
    instructions
  });
}

function showResult(payload, status, checkedAt, isOffline = false) {
  const selectedEmployee = employees.find((employee) => employee.id === payload.employee_id);
  const departmentName = departments.find((department) => department.id === selectedEmployee?.department_id)?.name ?? "—";
  const employeeName = selectedEmployee?.full_name ?? "Pekerja";
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
  const copyReportButtonHtml = waNotificationsEnabled
    ? ""
    : `<button id="copy-report" class="secondary-button mt-4 w-full" type="button"><i data-lucide="copy"></i> Salin laporan (WhatsApp)</button>`;

  resultCard.className = `panel-card result-card ${detail.result} mt-5`;
  resultCard.innerHTML = `<div class="flex items-start gap-3">
    <span class="status-pill ${detail.pill}"><i data-lucide="${detail.icon}"></i></span>
    <div class="min-w-0 flex-1">
      <p class="text-xs font-semibold text-slate-500">STATUS KESEHATAN PEKERJA</p>
      <h2 class="mt-1 font-display text-xl font-extrabold text-slate-900">${detail.label}</h2>
      <p class="mt-1 text-xs text-slate-500">${escapeHtml(employeeName)} · ${escapeHtml(formatDate(checkedAt))}</p>
    </div>
  </div>
  ${offlineNoticeHtml}
  <p class="mt-3 text-xs leading-5 text-slate-600">${status === "rest_recommended"
    ? urgentSymptoms
      ? "Cari pertolongan medis segera untuk gejala seperti sesak napas, nyeri dada, atau pingsan."
      : "Anda tidak diperkenankan bekerja, segera hubungi atasan dan petugas medis."
    : status === "need_observation"
      ? "Pantau kondisi Anda,  segera hubungi petugas medis untuk evaluasi lebih lanjut."
      : "Tetap jaga kesehatan dan ikuti prosedur keselamatan kerja."}</p>
  ${copyReportButtonHtml}`;
  resultCard.dataset.report = text;
  resultCard.classList.remove("hidden");
  resultCard.querySelector("#copy-report")?.addEventListener("click", copyReport);
  refreshIcons(resultCard);
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
  if (!guestMode && isAdmin() && !isLinkedAdminHrCheckupAccount()) {
    showToast("Menu Checkup tidak aktif untuk akun ini.", true);
    return;
  }
  if (checkupConfirmModal.open) return;
  if (!validateStep(1)) {
    setActiveStep(1);
    return;
  }
  if (!validateStep(2)) {
    setActiveStep(2);
    return;
  }
  if (!validateSubstanceQuestions()) return;

  if (navigator.onLine) await syncCheckupLocationSetting();
  document.querySelector("#checkup-location-confirmation")
    ?.classList.toggle("hidden", !checkupLocationEnabled);
  checkupConfirmModal.returnValue = "";
  const confirmation = new Promise((resolve) => {
    checkupConfirmModal.addEventListener("close", () => {
      resolve(checkupConfirmModal.returnValue === "confirm");
    }, { once: true });
  });
  checkupConfirmModal.showModal();
  refreshIcons();
  const confirmed = await confirmation;
  if (!confirmed) return;

  const payload = collectCheckup();
  const button = event.submitter
    ?? document.querySelector(measurementProviderEnabled ? "#submit-checkup-final" : "#submit-checkup");
  setBusy(button, true, "Menyimpan…");

  if (checkupLocationEnabled) {
    Object.assign(payload, await getDeviceLocation() ?? {});
  }

  const isOffline = !navigator.onLine;

  const handleOfflineSubmission = async () => {
    const preliminaryStatus = evaluateReadiness(payload);
    const measuredAt = new Date().toISOString();
    const checkupPhone = document.querySelector("#checkup-whatsapp").value;
    const employeePhone = guestMode
      ? (guestProfile?.whatsapp || document.querySelector("#checkup-whatsapp")?.value || "")
      : "";

    await enqueueOfflineItem({
      action: "submit_checkup",
      is_guest: guestMode,
      employee_id: payload.employee_id,
      device_token: guestMode ? (guestProfile?.deviceToken || createDeviceToken()) : null,
      payload,
      measured_at: measuredAt,
      preliminary_status: preliminaryStatus,
      whatsapp: employeePhone || null
    });

    clearCheckupDraft(payload.employee_id);
    showResult(payload, preliminaryStatus, measuredAt, true);

    checkupForm.reset();
    if (isLinkedAdminHrCheckupAccount()) {
      document.querySelector("#checkup-whatsapp").value = checkupPhone;
    }
    updateSleepHoursDisplay();
    departmentSelect.disabled = isCheckupIdentityLocked();
    employeeSelect.disabled = isCheckupIdentityLocked();
    if (!guestMode && currentEmployeeId) {
      const ownEmployee = employees.find((employee) => employee.id === currentEmployeeId);
      if (ownEmployee) {
        departmentSelect.value = ownEmployee.department_id;
        updateEmployeeOptions();
        employeeSelect.value = ownEmployee.id;
        syncEmployeeListUI(ownEmployee.id);
      } else {
        updateEmployeeOptions();
      }
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
    } else if (isSelfCheckupAccount()) {
      showDailyCheckupStatus({
        ...payload,
        checked_at: measuredAt,
        readiness_status: preliminaryStatus,
        is_offline: true
      });
    }
    updateTemperatureDisplay();
    if (!guestMode && !isSelfCheckupAccount()) setActiveStep(1);
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
        p_sleep_hours: payload.sleep_hours,
        p_symptoms: payload.symptoms,
        p_notes: payload.notes,
        p_measurement_provider: payload.measurement_provider,
        p_location_latitude: payload.location_latitude ?? null,
        p_location_longitude: payload.location_longitude ?? null,
        p_location_accuracy_m: payload.location_accuracy_m ?? null,
        p_location_captured_at: payload.location_captured_at ?? null
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
    if (guestMode || isSelfCheckupAccount()) {
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
    await syncWhatsAppNotificationSetting();
    showResult(payload, savedCheckup.readiness_status, savedCheckup.checked_at, false);
    if (checkupId && employeePhone) {
      dispatchWhatsAppNotification(checkupId, employeePhone);
    }
    const checkupPhone = document.querySelector("#checkup-whatsapp").value;
    checkupForm.reset();
    if (isLinkedAdminHrCheckupAccount()) {
      document.querySelector("#checkup-whatsapp").value = checkupPhone;
    }
    updateSleepHoursDisplay();
    departmentSelect.disabled = isCheckupIdentityLocked();
    employeeSelect.disabled = isCheckupIdentityLocked();
    if (!guestMode && currentEmployeeId) {
      const ownEmployee = employees.find((employee) => employee.id === currentEmployeeId);
      if (ownEmployee) {
        departmentSelect.value = ownEmployee.department_id;
        updateEmployeeOptions();
        employeeSelect.value = ownEmployee.id;
        syncEmployeeListUI(ownEmployee.id);
      } else {
        updateEmployeeOptions();
      }
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
    } else if (isSelfCheckupAccount()) {
      showDailyCheckupStatus({
        ...payload,
        checked_at: savedCheckup.checked_at,
        readiness_status: savedCheckup.readiness_status,
        can_submit_more: canSubmitMore
      });
    }
    updateTemperatureDisplay();
    if (!guestMode && !isSelfCheckupAccount()) setActiveStep(1);
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
      showToast("Pekerja ini sudah mengisi checkup hari ini.", true);
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
            : isSelfCheckupAccount()
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
  if (currentProfile?.role === "hr" || (guestMode && navigator.onLine)) {
    try {
      if (currentProfile?.role === "hr") {
        await loadHrEmployeeCreationSetting();
      } else {
        await loadGuestEmployeeCreationSetting();
      }
    } catch (error) {
      console.error("Could not verify employee-creation permission:", error);
      showToast(`Gagal memverifikasi izin penambahan pekerja: ${error.message}`, true);
      return;
    }
  }
  const canAddAsGuest = canAddGuestEmployee();
  if (currentProfile?.role === "hr" && !hrEmployeeCreationEnabled) {
    showToast("HR tidak diizinkan menambah pekerja baru.", true);
    return;
  }
  if (!canAddAuthenticatedEmployee() && !canAddAsGuest) {
    showToast("Hanya HR/admin yang dapat menambah master pekerja.", true);
    return;
  }
  const departmentSelectForNewEmployee = document.querySelector("#new-employee-department-select");
  const departmentId = departmentSelectForNewEmployee.classList.contains("hidden")
    ? employeeModal.dataset.departmentId
    : departmentSelectForNewEmployee.value;
  const name = document.querySelector("#new-employee-name").value.trim();
  const employeeMetadata = {
    employment_status: document.querySelector("#new-employee-status").value || null,
    job_title: document.querySelector("#new-employee-job-title").value.trim() || null,
    work_pattern: document.querySelector("#new-employee-work-pattern").value || null,
    sub_department_id: canManageHrFeature("employee_subdepartment")
      ? document.querySelector("#new-employee-subdepartment").value || null
      : null
  };
  const isActive = isAdmin()
    ? document.querySelector("#new-employee-active").checked
    : true;
  if (!departmentId || !name) {
    showToast("Fungsi dan nama pekerja wajib diisi.", true);
    return;
  }
  if (
    employeeMetadata.sub_department_id
    && !subdepartmentsForDepartment(departmentId).some((item) => item.id === employeeMetadata.sub_department_id)
  ) {
    showToast("Subfungsi tidak sesuai dengan fungsi pekerja.", true);
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
        sub_department_id: null,
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
          sub_department_id: null,
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
            sub_department_id: null,
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
        .select("id, department_id, sub_department_id, full_name, employment_status, job_title, work_pattern, is_active")
        .single();
      if (error) throw error;
      employee = data;
    }

    if (!employees.some((existing) => existing.id === employee.id)) {
      employees.push(employee);
    }
    renderSubdepartmentControls();
    let managementRefreshError = null;
    if (employeeModal.dataset.managementAdd === "true") {
      const managementDepartmentSelect = document.querySelector("#employee-management-department");
      employeeManagementDepartmentId = employee.department_id;
      managementDepartmentSelect.value = employee.department_id;
      employeeManagementSelectedId = employee.id;
      document.querySelector("#employee-management-search").value = "";
      try {
        await loadEmployeeManagementList();
      } catch (error) {
        console.error("Could not refresh employee management list after adding an employee:", error);
        managementRefreshError = error;
        if (!employeeManagementEmployees.some((existing) => existing.id === employee.id)) {
          employeeManagementEmployees.push(employee);
        }
        renderEmployeeManagementPicker();
      }
    } else {
      departmentSelect.value = departmentId;
      updateEmployeeOptions();
      employeeSelect.value = employee.id;
      syncDepartmentTabsUI(departmentId);
      syncEmployeeListUI(employee.id);
    }
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
    showToast(managementRefreshError
      ? `Pekerja berhasil ditambahkan, tetapi daftar tidak dapat diperbarui: ${managementRefreshError.message}`
      : employee.id.startsWith("temp_emp_")
        ? "Nama pekerja disimpan ke antrean offline."
        : (canAddAsGuest ? "Nama pekerja berhasil ditambahkan." : "Master pekerja berhasil disimpan."),
    Boolean(managementRefreshError));
  } catch (error) {
    console.error("Employee save failed:", error);
    showToast(`Gagal menyimpan pekerja: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  const safeText = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function downloadCsvRows(rows, filename) {
  const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function triggerCsvDownload(items) {
  if (!items?.length) return false;
  const header = [
    "Waktu checkup", "Nama pekerja", "Fungsi", "Tekanan sistolik", "Tekanan diastolik",
    "Suhu (C)", "Kelelahan (1-5)", "Jumlah jam tidur", "Gejala",
    "Konsumsi obat-obatan yang menyebabkan kantuk dalam 24 jam terakhir", "Konsumsi alkohol dalam 24 jam terakhir",
    "Tenaga medis", "Catatan", "Status",
    "Latitude", "Longitude", "Akurasi lokasi (m)", "Waktu pengambilan lokasi"
  ];
  const rows = items.map((item) => [
    item.checked_at,
    item.employees?.full_name,
    item.employees?.departments?.name,
    item.systolic,
    item.diastolic,
    item.temperature_c,
    item.fatigue_level,
    item.sleep_hours ?? (item.sleep_quality == null ? "" : `${item.sleep_quality}/5 (data lama)`),
    Object.entries(item.symptoms ?? {})
      .filter(([key, selected]) => selected && !Object.values(substanceQuestionKeys).includes(key))
      .map(([key]) => symptomLabels[key] ?? key)
      .join("; "),
    typeof item.symptoms?.[substanceQuestionKeys.medication] === "boolean"
      ? item.symptoms[substanceQuestionKeys.medication] ? "Ya" : "Tidak"
      : "",
    typeof item.symptoms?.[substanceQuestionKeys.alcohol] === "boolean"
      ? item.symptoms[substanceQuestionKeys.alcohol] ? "Ya" : "Tidak"
      : "",
    item.measurement_provider,
    item.notes,
    statusDetails[item.readiness_status]?.label ?? item.readiness_status,
    item.location_latitude,
    item.location_longitude,
    item.location_accuracy_m,
    item.location_captured_at
  ]);
  downloadCsvRows([header, ...rows], `daily-checkup-${getAppToday()}.csv`);
  return true;
}

function exportMissingDcuCsv() {
  const missingEmployees = getFilteredMissingDcuEmployees();
  if (!missingEmployees.length) {
    showToast("Tidak ada pekerja yang perlu diekspor.", true);
    return;
  }
  const departmentsById = new Map(departments.map((department) => [department.id, department.name]));
  const rows = [
    ["Nama Pekerja", "Fungsi", "Status Pekerja", "Pola Kerja"],
    ...missingEmployees.map((employee) => [
      employee.full_name,
      departmentsById.get(employee.department_id) ?? "",
      employee.employment_status ?? "",
      employee.work_pattern ?? ""
    ])
  ];
  downloadCsvRows(rows, `belum-dcu-${getAppToday()}.csv`);
  showToast("Daftar pekerja belum DCU berhasil diunduh.");
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

    // Jika bukan Admin (misal pekerja atau HR), langsung unduh CSV tanpa modal opsi hapus
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
  if (
    guestMode
    && tabName === "checkup"
    && !hasValidGuestProfile()
  ) {
    tabName = "profile";
  }
  if (!guestMode && tabName === "profile" && !isProfileMenuVisible()) return;
  if (!guestMode && tabName === "checkup" && isAdmin() && !isLinkedAdminHrCheckupAccount()) return;
  if (
    tabName === "settings"
    && currentProfile?.role !== "admin"
    && !(currentProfile?.role === "hr" && (
      hrSettingsAccessConfig.enabled || hrSettingsAccessConfig.allowed_features.length > 0
    ))
  ) return;
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
  if (tabName === "settings") {
    loadAdminHrMenuVisibility().catch((error) => {
      console.error("Admin/HR menu visibility load failed:", error);
      showToast(`Gagal memuat visibilitas menu: ${error.message}`, true);
    });
    if (currentProfile?.role === "admin") {
      loadAdminSettings().catch((error) => {
        console.error("Admin settings load failed:", error);
        showToast(`Gagal memuat pengaturan: ${error.message}`, true);
      });
      loadHrSettingsAccessConfig().catch((error) => {
        console.error("HR settings access config load failed:", error);
        showToast(`Gagal memuat akses pengaturan HR: ${error.message}`, true);
      });
      loadEmployeeManagementList().catch((error) => {
        console.error("Employee management list load failed:", error);
        showToast(`Gagal memuat daftar pekerja: ${error.message}`, true);
      });
    } else if (currentProfile?.role === "hr") {
      Promise.all([
        loadHrSettingsAccessConfig(true)
      ]).then(() => {
        syncHrFeatureAccess();
        if (!hrSettingsAccessConfig.enabled && hrSettingsAccessConfig.allowed_features.length === 0) {
          applyRoleMenuVisibility();
          setTab("summary", false);
          return;
        }
        const hrSettingsForm = document.querySelector("#hr-settings-form");
        hrSettingsForm.classList.toggle("hidden", !hrSettingsAccessConfig.enabled);
        document.querySelector("#hr-settings-access-form").classList.add("hidden");
        const tasks = [];
        if (hrSettingsAccessConfig.enabled) tasks.push(loadHrSettings());
        if (canManageHrFeature("employee_data")) tasks.push(loadEmployeeManagementList());
        if (
          canManageHrFeature("subdepartments")
          || canManageHrFeature("supervisors")
          || canManageHrFeature("employee_subdepartment")
        ) {
          tasks.push(loadSubdepartments());
        }
        if (canManageHrFeature("employee_subdepartment")) tasks.push(loadEmployees());
        return Promise.all(tasks);
      }).catch((error) => {
        console.error("HR settings load failed:", error);
        applyRoleMenuVisibility();
        showToast(`Gagal memuat pengaturan HR: ${error.message}`, true);
        if (!hrSettingsAccessConfig.enabled && hrSettingsAccessConfig.allowed_features.length === 0) {
          setTab("summary", false);
        }
      });
    }
  }
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
  departmentInput.value = isDepartmentRepresentative() ? currentDepartmentId : "";
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
  hrEmployeeCreationEnabled = false;
  document.querySelector("#profile-add-employee").classList.add("hidden");
  document.querySelector("#open-employee-modal").classList.add("hidden");
  document.querySelector("#checkup-whatsapp").value = "";
  document.querySelector("#daily-checkup-status-loading").classList.add("hidden");
  document.querySelector("#daily-checkup-completed-notice").classList.add("hidden");
  checkupForm.classList.remove("hidden");
  showCheckupProgress();
  resultCard.replaceChildren();
  resultCard.classList.add("hidden");
  currentUser = user;
  loggedInIdentity.textContent = user.email ?? "";
  loggedInIdentity.classList.toggle("hidden", !user.email);
  adminSettings = [];
  adminSettingsLoaded = false;
  employeeManagementEmployees = [];
  employeeManagementSelectedId = "";
  employeeManagementDepartmentId = "all";
  document.querySelector("#employee-management-search").value = "";
  document.querySelector("#employee-management-department").value = "";
  document.querySelector("#employee-management-employee").value = "";
  document.querySelector("#edit-employee-button").disabled = true;
  hrSettingsAccessConfig = { enabled: false, allowed_settings: [], allowed_features: [] };
  hrSettingsAccessConfigLoaded = false;
  hrSettings = [];
  hrSettingsLoaded = false;
  adminHrMenuVisibility = { profile_admin: true, profile_hr: true, checkup: true };
  adminHrMenuVisibilityLoaded = false;
  linkedAccountEmployeeId = null;
  const signoutButton = document.querySelector("#signout-button");
  signoutButton.innerHTML = '<i data-lucide="log-out"></i>';
  signoutButton.setAttribute("aria-label", "Keluar");
  signoutButton.title = "Keluar";
  signoutButton.classList.remove("hidden");
  refreshIcons();
  document.querySelectorAll("[data-tab-target]").forEach((button) => button.classList.remove("hidden"));
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
  document.querySelector("#settings-admin-heading").classList.toggle(
    "hidden",
    currentProfile.role !== "admin"
  );
  if (currentProfile.role === "hr") {
    await loadHrEmployeeCreationSetting();
    await loadHrSettingsAccessConfig();
  } else {
    syncEmployeeCreationButtons();
  }
  document.querySelector("#change-password-button").classList.remove("hidden");
  if (isAdmin()) await loadAdminHrMenuVisibility();
  document.querySelector("#admin-settings-form").classList.toggle("hidden", currentProfile.role !== "admin");
  document.querySelector("#hr-settings-access-form").classList.toggle("hidden", currentProfile.role !== "admin");
  document.querySelector("#hr-settings-form").classList.toggle(
    "hidden",
    currentProfile.role !== "hr" || !hrSettingsAccessConfig.enabled
  );
  document.querySelector("#menu-visibility-form").classList.toggle("hidden", currentProfile.role !== "admin");
  syncHrFeatureAccess();
  await syncBootstrapSettings();
  resetCheckupResponses();
  todayCheckupCount = null;
  todayReadinessCounts = null;
  activeEmployeeCount = null;
  employeesWithoutTodayCheckup = null;
  currentEmployeeId = null;
  currentDepartmentId = null;
  configureCheckupPhoneField();
  const employeeResult = await client.rpc("current_employee_id");
  if (employeeResult.error) throw employeeResult.error;
  const identityEmployeeId = employeeResult.data;
  linkedAccountEmployeeId = identityEmployeeId;
  if (isEmployeeAccount()) {
    currentEmployeeId = identityEmployeeId;
    if (!currentEmployeeId) {
      throw new Error("Akun belum ditautkan ke data pekerja. Hubungi administrator.");
    }
  } else if (isAdmin() && adminHrMenuVisibility.checkup) {
    currentEmployeeId = identityEmployeeId;
  }
  applyRoleMenuVisibility();
  configureCheckupPhoneField();
  if (isDepartmentRepresentative()) {
    const departmentResult = await client.rpc("current_department_id");
    if (departmentResult.error) throw departmentResult.error;
    currentDepartmentId = departmentResult.data;
    if (!currentDepartmentId) {
      throw new Error("Akun perwakilan belum ditautkan ke fungsi. Hubungi administrator.");
    }
  }
  loginScreen.classList.add("hidden");
  loginScreen.classList.remove("flex");
  appShell.classList.remove("hidden");
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("id-ID", {
    timeZone: getActiveTimezone(),
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(new Date());
  document.querySelector("#history-department-wrap").classList.toggle("hidden", !isAdmin() && !isDepartmentRepresentative());
  document.querySelector("#daily-coverage-card").classList.toggle("hidden", !isSummaryViewer());
  document.querySelector("#missing-dcu-card").classList.toggle("hidden", !isSummaryViewer());

  await loadDepartments();
  await loadEmployees();
  await loadSubdepartments();
  const identityEmployee = employees.find((employee) => employee.id === identityEmployeeId);
  loggedInIdentity.textContent = identityEmployee
    ? `${identityEmployee.full_name}`
    : (user.email ?? "");
  loggedInIdentity.classList.toggle("hidden", !loggedInIdentity.textContent);
  if (isAdmin() && !isLinkedAdminHrCheckupAccount()) restoreCheckupSelection();
  await loadCheckups();
  if (isSelfCheckupAccount()) {
    const dailyCheckup = await loadAuthenticatedDailyCheckup(currentEmployeeId);
    if (dailyCheckup) {
      showDailyCheckupStatus(dailyCheckup);
    } else {
      const restored = restoreCheckupDraft(currentEmployeeId);
      showCheckupForm(restored ? activeStep : 1);
    }
  } else {
    checkupForm.classList.remove("hidden");
    showCheckupProgress();
    resultCard.classList.add("hidden");
  }
  setTab(isLinkedAdminHrCheckupAccount() ? "checkup" : isSummaryViewer() ? "summary" : "checkup", false);
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
      loadDepartments().then(loadEmployees).then(loadSubdepartments).catch((error) => {
        console.error("Realtime department refresh failed:", error);
        showToast(`Gagal memperbarui fungsi: ${error.message}`, true);
      });
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "employees" }, () => {
      loadEmployees().then(async () => {
        if (isSummaryViewer()) {
          await loadDailyCoverage();
          renderSummary();
        }
      }).catch((error) => {
        console.error("Realtime employee refresh failed:", error);
        showToast(`Gagal memperbarui data pekerja: ${error.message}`, true);
      });
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "sub_departments" }, () => {
      loadSubdepartments().catch((error) => {
        console.error("Realtime subdepartment refresh failed:", error);
        showToast(`Gagal memperbarui subfungsi: ${error.message}`, true);
      });
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "sub_department_supervisors" }, () => {
      loadSubdepartments().catch((error) => {
        console.error("Realtime supervisor refresh failed:", error);
        showToast(`Gagal memperbarui pengawas: ${error.message}`, true);
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
  currentProfile = null;
  document.querySelector("#settings-admin-heading").classList.add("hidden");
  hrEmployeeCreationEnabled = false;
  employeeManagementSelectedId = "";
  employeeManagementDepartmentId = "all";
  document.querySelector("#employee-management-search").value = "";
  document.querySelector("#employee-management-department").value = "";
  document.querySelector("#employee-management-employee").value = "";
  document.querySelector("#edit-employee-button").disabled = true;
  hrSettingsAccessConfig = { enabled: false, allowed_settings: [], allowed_features: [] };
  hrSettingsAccessConfigLoaded = false;
  hrSettings = [];
  hrSettingsLoaded = false;
  guestEmployeeCreationEnabled = false;
  currentEmployeeId = null;
  linkedAccountEmployeeId = null;
  adminHrMenuVisibility = { profile_admin: true, profile_hr: true, checkup: true };
  adminHrMenuVisibilityLoaded = false;
  document.querySelector(".bottom-nav").style.removeProperty("grid-template-columns");
  document.querySelector("#admin-settings-form").classList.add("hidden");
  document.querySelector("#hr-settings-access-form").classList.add("hidden");
  document.querySelector("#employee-management").classList.add("hidden");
  employeeManagementEmployees = [];
  document.querySelector("#hr-settings-form").classList.add("hidden");
  document.querySelector("#menu-visibility-form").classList.add("hidden");
  document.querySelector("#subdepartment-management").classList.add("hidden");
  try {
    if (!navigator.onLine) throw new Error("Offline");
    const guestPromises = [
      client.rpc("is_guest_checkups_enabled"),
      client.rpc("is_guest_employee_creation_enabled")
    ];
    const results = await Promise.all(guestPromises);
    const guestCheckupRes = results[0];
    const guestEmployeeCreationRes = results[1];
    if (guestCheckupRes.error) throw guestCheckupRes.error;
    if (!guestCheckupRes.data) {
      throw new Error("Mode tamu belum diaktifkan di Supabase. Lihat guest_mode.sql.");
    }
    if (guestEmployeeCreationRes.error) throw guestEmployeeCreationRes.error;
    if (typeof guestEmployeeCreationRes.data !== "boolean") {
      throw new Error("Supabase mengembalikan status izin penambahan pekerja tamu yang tidak valid.");
    }
    guestEmployeeCreationEnabled = guestEmployeeCreationRes.data;
  } catch (err) {
    if (!navigator.onLine || err.message?.includes("Failed to fetch") || err.name === "TypeError" || err.message === "Offline") {
      console.warn("Inisialisasi mode tamu dalam status offline:", err);
      guestEmployeeCreationEnabled = false;
    } else {
      throw err;
    }
  }
  guestMode = true;
  syncEmployeeCreationButtons();
  document.querySelector("#daily-checkup-status-loading").classList.add("hidden");
  document.querySelector("#daily-checkup-completed-notice").classList.add("hidden");
  currentUser = null;
  currentProfile = null;
  loggedInIdentity.textContent = "";
  loggedInIdentity.classList.add("hidden");
  adminSettings = [];
  adminSettingsLoaded = false;
  currentEmployeeId = null;
  currentDepartmentId = null;
  resetCheckupResponses();
  todayCheckupCount = null;
  todayReadinessCounts = null;
  activeEmployeeCount = null;
  employeesWithoutTodayCheckup = null;
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
  document.querySelector("#stat-missing-dcu").textContent = "—";
  resultCard.replaceChildren();
  resultCard.classList.add("hidden");
  document.querySelector("#change-password-button").classList.add("hidden");
  checkupForm.classList.remove("hidden");
  showCheckupProgress();
  document.querySelector("#checkup-identity-controls").classList.remove("hidden");
  document.querySelector("#checkup-identity-summary").classList.add("hidden");
  document.querySelector("#checkup-identity-summary").classList.remove("flex");
  document.querySelector("#edit-checkup-identity").classList.remove("hidden");
  document.querySelector("#history-department").disabled = false;
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
  document.querySelector(".bottom-nav").classList.remove("has-admin-profile", "has-admin-settings");
  setTab("checkup", false);
  document.querySelector("#daily-coverage-card").classList.add("hidden");
  document.querySelector("#missing-dcu-card").classList.add("hidden");
  appShell.classList.add("guest-mode");
  document.querySelector("#checkup-whatsapp-wrap").classList.add("hidden");
  document.querySelector("#checkup-whatsapp").required = false;
  checkupForm.classList.add("hidden");
  checkupProgress.classList.add("hidden");
  await loadGuestDirectory();
  guestProfile = readGuestProfile();
  if (hasValidGuestProfile()) {
    if (!persistGuestProfile(guestProfile)) {
      setTab("profile", false);
      refreshIcons();
      return;
    }
    setTab("checkup", false);
    syncGuestProfileToCheckup();
    syncGuestProfileForm();
    try {
      const dailyCheckup = await loadGuestDailyStatus();
      if (dailyCheckup) {
        showDailyCheckupStatus(dailyCheckup);
      } else {
        const restored = restoreCheckupDraft(guestProfile.employeeId);
        showCheckupForm(restored ? activeStep : 1);
      }
    } catch (error) {
      console.error("Could not load this device's daily checkup:", error);
      showToast(`Gagal memeriksa status checkup hari ini: ${error.message}`, true);
      const restored = restoreCheckupDraft(guestProfile.employeeId);
      showCheckupForm(restored ? activeStep : 1);
    }
  } else {
    setTab("profile", false);
    renderCheckupIdentitySummary();
  }
  refreshIcons();
}

async function showLogin() {
  appShell.classList.add("hidden");
  document.querySelector("#change-password-button").classList.add("hidden");
  loggedInIdentity.textContent = "";
  loggedInIdentity.classList.add("hidden");
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
  currentDepartmentId = null;
  guestMode = false;
  departments = [];
  subdepartments = [];
  subdepartmentSupervisors = [];
  employees = [];
  employeeManagementEmployees = [];
  employeeManagementSelectedId = "";
  employeeManagementDepartmentId = "all";
  checkups = [];
  historyList.replaceChildren();
  resultCard.replaceChildren();
  guestProfile = null;
  await initializeGuestApp();
}

function bindEvents() {
  applySelectionModes();
  document.querySelector("#login-form").addEventListener("submit", handleLogin);
  document.querySelector("#signout-button").addEventListener("click", handleSignOut);
  document.querySelector("#change-password-button").addEventListener("click", openChangePasswordModal);
  document.querySelector("#close-change-password").addEventListener("click", () => {
    changePasswordModal.close();
    document.querySelector("#change-password-form").reset();
  });
  document.querySelector("#change-password-form").addEventListener("submit", handlePasswordChange);
  document.querySelector("#admin-settings-form").addEventListener("submit", handleAdminSettingsSave);
  document.querySelector("#menu-visibility-form").addEventListener("submit", handleMenuVisibilitySave);
  document.querySelector("#hr-settings-access-form").addEventListener("submit", handleHrSettingsAccessSave);
  document.querySelector("#hr-settings-form").addEventListener("submit", handleHrSettingsSave);
  document.querySelector("#subdepartment-form").addEventListener("submit", saveSubdepartment);
  document.querySelector("#supervisor-form").addEventListener("submit", saveSupervisor);
  document.querySelector("#employee-subdepartment-form").addEventListener("submit", saveEmployeeSubdepartment);
  document.querySelector("#employee-management-search").addEventListener("input", renderEmployeeManagementPicker);
  document.querySelector("#employee-management-search-clear").addEventListener("click", () => {
    document.querySelector("#employee-management-search").value = "";
    renderEmployeeManagementPicker();
  });
  document.querySelector("#employee-management-department").addEventListener("change", (event) => {
    employeeManagementDepartmentId = event.target.value || "all";
    clearEmployeeManagementSelection();
    renderEmployeeManagementPicker();
  });
  document.querySelector("#employee-management-employee").addEventListener("change", (event) => {
    employeeManagementSelectedId = event.target.value;
    document.querySelector("#edit-employee-button").disabled = !employeeManagementSelectedId;
  });
  document.querySelector("#employee-management-add").addEventListener("click", openEmployeeModalFromManagement);
  document.querySelector("#new-employee-department-select").addEventListener("change", (event) => {
    populateSubdepartmentSelect(
      document.querySelector("#new-employee-subdepartment"),
      event.target.value
    );
  });
  document.querySelector("#edit-employee-button").addEventListener("click", () => {
    openEmployeeEditModal(employeeManagementSelectedId);
  });
  document.querySelector("#employee-edit-form").addEventListener("submit", saveEmployeeData);
  document.querySelector("#employee-edit-department").addEventListener("change", (event) => {
    const employee = employeeManagementEmployees.find(
      (item) => item.id === employeeEditModal.dataset.employeeId
    );
    const selectedSubdepartmentId = event.target.value === employeeEditModal.dataset.originalDepartmentId
      ? employee?.sub_department_id ?? ""
      : "";
    populateSubdepartmentSelect(
      document.querySelector("#employee-edit-subdepartment"),
      event.target.value,
      selectedSubdepartmentId
    );
  });
  document.querySelector("#close-employee-edit-modal").addEventListener("click", () => employeeEditModal.close());
  document.querySelector("#cancel-employee-edit").addEventListener("click", () => employeeEditModal.close());
  employeeEditModal.addEventListener("click", (event) => {
    if (event.target === employeeEditModal) employeeEditModal.close();
  });
  document.querySelector("#subdepartment-employee").addEventListener("change", renderSubdepartmentControls);
  document.querySelector("#subdepartment-supervisor-list").addEventListener("click", handleSubdepartmentManagerClick);
  document.querySelector("#reload-admin-settings").addEventListener("click", () => {
    loadAdminSettings(true).catch((error) => {
      console.error("Admin settings reload failed:", error);
      showToast(`Gagal memuat ulang pengaturan: ${error.message}`, true);
    });
  });
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
        setActiveStep(Math.min(getLastCheckupStep(), activeStep + 1));
        saveCheckupDraft();
      }
    });
  });
  document.querySelectorAll("[data-prev]").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveStep(Math.max(guestMode ? 2 : 1, activeStep - 1));
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
    if (EMPLOYEE_SELECTION_MODE !== "dropdown") return;
    const employee = employees.find((item) => item.id === employeeSelect.value);
    if (employee && employee.department_id !== departmentSelect.value) {
      if (currentCheckupTab === "all") {
        currentCheckupTab = employee.department_id;
      }
      departmentSelect.value = employee.department_id;
      departmentSelect.dispatchEvent(new Event("change"));
      employeeSelect.value = employee.id;
    }
  });
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

  const checkupSearch = document.querySelector("#employee-search");
  const checkupSearchClear = document.querySelector("#employee-search-clear");
  if (checkupSearch) {
    checkupSearch.addEventListener("input", (e) => {
      checkupSearchQuery = e.target.value.trim().toLowerCase();
      if (checkupSearchClear) {
        checkupSearchClear.classList.toggle("hidden", !checkupSearchQuery);
      }
      renderEmployeeList(currentCheckupTab);
    });
  }
  if (checkupSearchClear) {
    checkupSearchClear.addEventListener("click", () => {
      if (checkupSearch) checkupSearch.value = "";
      checkupSearchQuery = "";
      checkupSearchClear.classList.add("hidden");
      renderEmployeeList(currentCheckupTab);
      checkupSearch?.focus();
    });
  }

  const profileSearch = document.querySelector("#profile-employee-search");
  const profileSearchClear = document.querySelector("#profile-employee-search-clear");
  if (profileSearch) {
    profileSearch.addEventListener("input", (e) => {
      profileSearchQuery = e.target.value.trim().toLowerCase();
      if (profileSearchClear) {
        profileSearchClear.classList.toggle("hidden", !profileSearchQuery);
      }
      renderProfileEmployeeList(currentProfileTab);
    });
  }
  if (profileSearchClear) {
    profileSearchClear.addEventListener("click", () => {
      if (profileSearch) profileSearch.value = "";
      profileSearchQuery = "";
      profileSearchClear.classList.add("hidden");
      renderProfileEmployeeList(currentProfileTab);
      profileSearch?.focus();
    });
  }

  document.querySelector("#profile-department").addEventListener("change", () => {
    updateProfileEmployeeOptions();
  });
  document.querySelector("#profile-employee").addEventListener("change", () => {
    const profileEmployee = document.querySelector("#profile-employee");
    const profileDepartment = document.querySelector("#profile-department");
    const employee = employees.find((item) => item.id === profileEmployee.value);
    if (employee && employee.department_id !== profileDepartment.value) {
      if (currentProfileTab === "all") {
        currentProfileTab = employee.department_id;
      }
      profileDepartment.value = employee.department_id;
      profileDepartment.dispatchEvent(new Event("change"));
      profileEmployee.value = employee.id;
    }
  });
  document.querySelector("#guest-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const departmentId = document.querySelector("#profile-department").value;
    const employeeId = document.querySelector("#profile-employee").value;
    const whatsapp = document.querySelector("#profile-whatsapp").value;
    if (!employees.some((employee) => employee.id === employeeId && employee.department_id === departmentId)) {
      showToast("Pilih nama pekerja yang sesuai dengan fungsi.", true);
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
      showCheckupProgress();
      resultCard.replaceChildren();
      resultCard.classList.add("hidden");
      departmentSelect.value = "";
      updateEmployeeOptions();
      document.querySelector("#checkup-whatsapp").value = "";
      document.querySelector("#profile-department").value = "";
      updateProfileEmployeeOptions();
      document.querySelector("#profile-whatsapp").value = "";
      setActiveStep(1);
      setTab("profile");
      showToast("Profil perangkat berhasil dihapus.");
    } catch (error) {
      console.error("Could not clear guest profile from this browser:", error);
      showToast("Profil gagal dihapus. Periksa pengaturan penyimpanan browser.", true);
    }
  });
  document.querySelector("#temperature").addEventListener("input", updateTemperatureDisplay);
  document.querySelector("#sleep-hours")?.addEventListener("input", updateSleepHoursDisplay);
  checkupForm.addEventListener("click", (event) => {
    const button = event.target.closest("[data-blood-pressure-step]");
    if (!button) return;
    const input = document.getElementById(button.dataset.bloodPressureInput);
    if (!input) return;
    const currentValue = Number(input.value);
    const step = Number(button.dataset.bloodPressureStep);
    if (!Number.isFinite(currentValue) || !Number.isFinite(step)) return;
    input.value = String(currentValue + step);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  checkupForm.querySelectorAll(".blood-pressure-input").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      input.value = String(Number(input.value) + (event.key === "ArrowUp" ? 5 : -5));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  checkupForm.addEventListener("input", (event) => {
    if (isCheckupDraftField(event.target)) saveCheckupDraft();
  });
  checkupForm.addEventListener("change", (event) => {
    if (event.target?.name === "has_complaint_today") updateComplaintSymptomsVisibility();
    if (["substance_medication_24h", "substance_alcohol_24h"].includes(event.target?.name)) {
      updateSubstanceQuestionStates();
    }
    if (isCheckupDraftField(event.target)) saveCheckupDraft();
  });
  checkupForm.addEventListener("submit", submitCheckup);
  document.querySelector("#open-employee-modal").addEventListener("click", async () => {
    if (currentProfile?.role === "hr" || (guestMode && navigator.onLine)) {
      try {
        const allowed = currentProfile?.role === "hr"
          ? await loadHrEmployeeCreationSetting()
          : await loadGuestEmployeeCreationSetting();
        if (!allowed) {
          showToast(currentProfile?.role === "hr"
            ? "HR tidak diizinkan menambah pekerja baru."
            : "Penambahan nama belum diaktifkan.", true);
          return;
        }
      } catch (error) {
        console.error("Could not verify HR employee-creation permission:", error);
        showToast(`Gagal memverifikasi izin penambahan pekerja: ${error.message}`, true);
        return;
      }
    }
    const canAddAsGuest = canAddGuestEmployee();
    if (currentProfile?.role === "hr" && !hrEmployeeCreationEnabled) {
      showToast("HR tidak diizinkan menambah pekerja baru.", true);
      return;
    }
    if (!canAddAuthenticatedEmployee() && !canAddAsGuest) {
      showToast("Hubungi HR untuk menambahkan pekerja.", true);
      return;
    }
    const departmentId = guestMode && !document.querySelector("#profile-tab").classList.contains("hidden")
      ? document.querySelector("#profile-department").value
      : departmentSelect.value;
    openEmployeeModal(departmentId, canAddAsGuest);
  });
  document.querySelector("#profile-add-employee").addEventListener("click", async () => {
    if (currentProfile?.role === "hr" || (guestMode && navigator.onLine)) {
      try {
        const allowed = currentProfile?.role === "hr"
          ? await loadHrEmployeeCreationSetting()
          : await loadGuestEmployeeCreationSetting();
        if (!allowed) {
          showToast(currentProfile?.role === "hr"
            ? "HR tidak diizinkan menambah pekerja baru."
            : "Penambahan nama belum diaktifkan.", true);
          return;
        }
      } catch (error) {
        console.error("Could not verify employee-creation permission:", error);
        showToast(`Gagal memverifikasi izin penambahan pekerja: ${error.message}`, true);
        return;
      }
    }
    const canAddAsGuest = canAddGuestEmployee();
    if (!canAddAuthenticatedEmployee() && !canAddAsGuest) {
      showToast("Penambahan pekerja belum diizinkan.", true);
      return;
    }
    const departmentId = document.querySelector("#profile-department").value;
    if (!departmentId) {
      showToast("Pilih fungsi terlebih dahulu.", true);
      return;
    }
    departmentSelect.value = departmentId;
    updateEmployeeOptions();
    openEmployeeModal(departmentId, canAddAsGuest);
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
      showToast(`Gagal memuat filter fungsi: ${error.message}`, true);
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
  document.querySelector("#missing-dcu-card").addEventListener("click", openMissingDcuModal);
  document.querySelector("#close-missing-dcu-modal").addEventListener("click", () => missingDcuModal.close());
  document.querySelector("#cancel-missing-dcu-modal").addEventListener("click", () => missingDcuModal.close());
  missingDcuModal.addEventListener("click", (event) => {
    if (event.target === missingDcuModal) missingDcuModal.close();
  });
  document.querySelector("#export-missing-dcu-csv").addEventListener("click", exportMissingDcuCsv);
  document.querySelector("#missing-dcu-department-filter").addEventListener("change", (event) => {
    selectedMissingDcuDepartmentId = event.currentTarget.value;
    renderMissingDcuModal();
  });
  document.querySelector("#close-checkup-confirm-modal")?.addEventListener("click", () => checkupConfirmModal.close());
  document.querySelector("#cancel-checkup-submit")?.addEventListener("click", () => checkupConfirmModal.close());
  checkupConfirmModal?.addEventListener("click", (event) => {
    if (event.target === checkupConfirmModal) checkupConfirmModal.close();
  });
  document.querySelector("#confirm-checkup-submit")?.addEventListener("click", () => {
    checkupConfirmModal.close("confirm");
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
      if (isSummaryViewer()) await loadDailyCoverage();

      showToast(`File CSV berhasil diunduh dan ${deletedCount} riwayat berhasil dihapus.`);
    } catch (error) {
      console.error("Gagal menghapus riwayat checkup:", error);
      showToast(`Gagal menghapus riwayat: ${error.message}`, true);
    } finally {
      setBusy(button, false);
    }
  });

  window.addEventListener("online", () => {
    if (!privacyGatePassed) return;
    updateNetworkAndQueueUI();
    syncOfflineQueue(false);
  });
  window.addEventListener("offline", () => {
    if (!privacyGatePassed) return;
    updateNetworkAndQueueUI();
  });
  offlineQueueBadge?.addEventListener("click", openQueueModal);
  manualSyncButton?.addEventListener("click", () => syncOfflineQueue(true));
  triggerSyncBtn?.addEventListener("click", () => syncOfflineQueue(true));
  closeQueueModalBtn?.addEventListener("click", () => queueModal?.close());
  closeQueueBtn?.addEventListener("click", () => queueModal?.close());
}
async function boot() {
  loadCachedAppSettings();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("ServiceWorker registration failed:", err);
    });
  }

  bindEvents();
  bindPrivacyNoticeEvents();
  updateTemperatureDisplay();
  setActiveStep(1);
  refreshIcons();

  const supabaseFactory = getSupabaseFactory();
  if (!supabaseFactory) {
    throw new Error("Supabase SDK gagal dimuat dari CDN.");
  }
  if (SUPABASE_URL.includes("YOUR_PROJECT_ID") || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
    throw new Error("Isi URL dan anon/publishable key Supabase di config.js.");
  }
  client = supabaseFactory(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "sgt-dcu-privacy-notice-auth"
    }
  });
  await requestPrivacyNotice();
  client = supabaseFactory(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  await updateNetworkAndQueueUI();
  if (navigator.onLine) {
    syncOfflineQueue(false);
  }
  await syncBootstrapSettings();

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
  if (!privacyGatePassed) {
    showPrivacyNoticeError(error);
    return;
  }
  showLogin();
  showToast(`Aplikasi gagal dimulai: ${error.message}`, true);
});
