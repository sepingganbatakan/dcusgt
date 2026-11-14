/**
 * offline-storage.js
 * Manajemen penyimpanan IndexedDB untuk Offline Queue dan Directory Cache.
 * Didesain aman (Data Minimization) untuk mode Guest & Offline DCU.
 */

const DB_NAME = "sgt_dcu_offline_v1";
const DB_VERSION = 1;

let dbPromise = null;

/**
 * Membuka atau menginisialisasi database IndexedDB
 */
export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      console.warn("IndexedDB tidak didukung oleh browser ini.");
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 1. Store direktori publik (hanya nama, departemen, dan ID aman)
      if (!db.objectStoreNames.contains("directory_cache")) {
        db.createObjectStore("directory_cache", { keyPath: "key" });
      }

      // 2. Store antrean offline transaksi (tambah karyawan tamu & checkup)
      if (!db.objectStoreNames.contains("offline_queue")) {
        const queueStore = db.createObjectStore("offline_queue", { keyPath: "id" });
        queueStore.createIndex("status", "status", { unique: false });
        queueStore.createIndex("created_at", "created_at", { unique: false });
        queueStore.createIndex("action", "action", { unique: false });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      console.error("Gagal membuka IndexedDB:", event.target.error);
      reject(event.target.error);
    };
  });

  return dbPromise;
}

/**
 * Menyimpan data direktori minimalis ke cache IndexedDB
 * Mematuhi prinsip minimalisasi data: hanya id, department_id, full_name
 */
export async function saveDirectoryCache(departments = [], employees = []) {
  const db = await openDB();
  if (!db) return;

  const safeEmployees = employees.map((emp) => ({
    id: emp.id,
    department_id: emp.department_id,
    full_name: emp.full_name,
    is_active: emp.is_active ?? true
  }));

  const safeDepartments = departments.map((dept) => ({
    id: dept.id,
    name: dept.name
  }));

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["directory_cache"], "readwrite");
    const store = tx.objectStore("directory_cache");

    store.put({ key: "departments", data: safeDepartments });
    store.put({ key: "employees", data: safeEmployees });

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Mengambil data direktori minimalis dari cache lokal IndexedDB
 */
export async function getDirectoryCache() {
  const db = await openDB();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["directory_cache"], "readonly");
    const store = tx.objectStore("directory_cache");

    const deptReq = store.get("departments");
    const empReq = store.get("employees");

    tx.oncomplete = () => {
      resolve({
        departments: deptReq.result ? deptReq.result.data : [],
        employees: empReq.result ? empReq.result.data : []
      });
    };

    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Menambahkan transaksi ke antrean offline (FIFO)
 */
export async function enqueueOfflineItem(item) {
  const db = await openDB();
  if (!db) throw new Error("IndexedDB tidak tersedia.");

  const queueItem = {
    id: item.id || `queue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    action: item.action, // "add_guest_employee" | "submit_checkup"
    temp_employee_id: item.temp_employee_id || null,
    employee_id: item.employee_id || null,
    device_token: item.device_token || null,
    payload: item.payload,
    measured_at: item.measured_at || new Date().toISOString(),
    preliminary_status: item.preliminary_status || null,
    whatsapp: item.whatsapp || null,
    status: "pending", // "pending" | "syncing" | "failed"
    retry_count: 0,
    error_message: null,
    created_at: item.created_at || new Date().toISOString()
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["offline_queue"], "readwrite");
    const store = tx.objectStore("offline_queue");
    const request = store.add(queueItem);

    request.onsuccess = () => resolve(queueItem);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Mengambil seluruh antrean dengan status "pending" terurut berdasarkan waktu pembuatan
 */
export async function getPendingOfflineQueue() {
  const db = await openDB();
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["offline_queue"], "readonly");
    const store = tx.objectStore("offline_queue");
    const request = store.getAll();

    request.onsuccess = () => {
      const all = request.result || [];
      const pending = all
        .filter((item) => item.status === "pending" || item.status === "failed")
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      resolve(pending);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Mengambil seluruh item antrean (untuk dialog/drawer pantauan antrean)
 */
export async function getAllOfflineQueueItems() {
  const db = await openDB();
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["offline_queue"], "readonly");
    const store = tx.objectStore("offline_queue");
    const request = store.getAll();

    request.onsuccess = () => {
      const all = request.result || [];
      resolve(all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Menghitung jumlah antrean tertunda
 */
export async function getPendingOfflineCount() {
  const items = await getPendingOfflineQueue();
  return items.length;
}

/**
 * Memperbarui item dalam antrean
 */
export async function updateOfflineItem(id, updates) {
  const db = await openDB();
  if (!db) return false;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["offline_queue"], "readwrite");
    const store = tx.objectStore("offline_queue");
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const current = getReq.result;
      if (!current) {
        resolve(false);
        return;
      }
      const updated = { ...current, ...updates };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(true);
      putReq.onerror = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Menghapus item dari antrean setelah berhasil disinkronkan
 */
export async function removeOfflineItem(id) {
  const db = await openDB();
  if (!db) return false;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["offline_queue"], "readwrite");
    const store = tx.objectStore("offline_queue");
    const request = store.delete(id);

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Menilai status kelayakan kerja (triage) di sisi client
 * 100% konsisten dengan trigger PostgreSQL evaluate_checkup_readiness()
 */
export function evaluateReadiness(payload) {
  const {
    temperature_c,
    systolic,
    diastolic,
    symptoms = {}
  } = payload;

  if (
    temperature_c >= 38
    || systolic >= 180
    || diastolic >= 120
    || symptoms.breathing_difficulty
    || symptoms.chest_pain
    || symptoms.fainting
  ) {
    return "rest_recommended";
  }

  if (
    temperature_c > 37.5
    || systolic >= 140
    || diastolic >= 90
    || systolic < 90
    || diastolic < 60
    || symptoms.flu_cough
    || symptoms.dizziness
    || symptoms.muscle_pain
  ) {
    return "need_observation";
  }

  return "fit_to_work";
}
