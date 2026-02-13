class MemorizationDB {
    constructor(dbName = 'MemorizationAppDB_v2', version = 1) {
        this.dbName = dbName;
        this.version = version;
        this.db = null;
    }

    // Initialize the database
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // 1. Subjects Store (New)
                // Key: id (autoIncrement)
                if (!db.objectStoreNames.contains('subjects')) {
                    db.createObjectStore('subjects', { keyPath: 'id', autoIncrement: true });
                }

                // 2. Items Store
                // Key: id (autoIncrement)
                if (!db.objectStoreNames.contains('items')) {
                    const itemStore = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
                    itemStore.createIndex('front', 'front', { unique: false });
                    itemStore.createIndex('subject_id', 'subject_id', { unique: false }); // New Index
                }

                // 3. Progress Store
                if (!db.objectStoreNames.contains('progress')) {
                    db.createObjectStore('progress', { keyPath: 'item_id' });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log("IndexedDB Initialized");
                resolve(this.db);
            };

            request.onerror = (event) => {
                console.error("IndexedDB error:", event.target.error);
                reject(event.target.error);
            };
        });
    }

    // --- Subject Management ---

    async getSubjects() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['subjects'], 'readonly');
            const store = transaction.objectStore('subjects');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async createSubject(name, settings = {}) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['subjects'], 'readwrite');
            const store = transaction.objectStore('subjects');
            const request = store.add({
                name: name,
                settings: settings,
                created_at: Date.now()
            });
            request.onsuccess = (e) => resolve(e.target.result); // Returns ID
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async updateSubject(id, updates) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['subjects'], 'readwrite');
            const store = transaction.objectStore('subjects');

            // First get, then put
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (!data) {
                    reject("Subject not found");
                    return;
                }
                const newData = { ...data, ...updates };
                store.put(newData).onsuccess = () => resolve();
            };
        });
    }

    async deleteSubject(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['subjects', 'items', 'progress'], 'readwrite');

            // 1. Delete Subject
            transaction.objectStore('subjects').delete(id);

            // 2. Find items related to subject (Need to scan or use index)
            const itemStore = transaction.objectStore('items');
            const index = itemStore.index('subject_id');
            const request = index.getAllKeys(id);

            request.onsuccess = () => {
                const itemIds = request.result;
                // 3. Delete items and their progress
                itemIds.forEach(itemId => {
                    itemStore.delete(itemId);
                    transaction.objectStore('progress').delete(itemId);
                });
            };

            transaction.oncomplete = () => resolve();
            transaction.onerror = (e) => reject(e.target.error);
        });
    }

    // --- Data Management ---

    // items: Array of { front, back }
    async importItems(subjectId, items, clearExisting = false) {
        return new Promise(async (resolve, reject) => {
            if (clearExisting) {
                await this.clearItemsBySubject(subjectId);
            }

            const transaction = this.db.transaction(['items', 'progress'], 'readwrite');
            const itemStore = transaction.objectStore('items');
            const progressStore = transaction.objectStore('progress');

            transaction.oncomplete = () => resolve();
            transaction.onerror = (e) => reject(e.target.error);

            items.forEach(item => {
                // Restore ID link if existing progress logic needed? 
                // Currently just new add.
                const request = itemStore.add({
                    subject_id: subjectId,
                    front: item.front,
                    front_info: item.front_info || '', // New
                    back: item.back,
                    back_info: item.back_info || '',   // New
                    created_at: Date.now()
                });

                request.onsuccess = (e) => {
                    const id = e.target.result;
                    // Check if item has progress info provided (for restoration)
                    if (item.level !== undefined) {
                        progressStore.add({
                            item_id: id,
                            level: item.level,
                            last_studied: item.last_studied || 0
                        });
                    } else {
                        // Default new
                        progressStore.add({
                            item_id: id,
                            level: 0,
                            last_studied: 0
                        });
                    }
                };
            });
        });
    }

    async clearItemsBySubject(subjectId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['items', 'progress'], 'readwrite');
            const itemStore = transaction.objectStore('items');
            const index = itemStore.index('subject_id');

            const request = index.getAllKeys(subjectId);
            request.onsuccess = () => {
                const itemIds = request.result;
                itemIds.forEach(itemId => {
                    itemStore.delete(itemId);
                    transaction.objectStore('progress').delete(itemId);
                });
            };

            transaction.oncomplete = () => resolve();
            transaction.onerror = (e) => reject(e.target.error);
        });
    }

    async getAllItemsWithProgress(subjectId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['items', 'progress'], 'readonly');
            const itemStore = transaction.objectStore('items');
            const progressStore = transaction.objectStore('progress');
            const subjectIndex = itemStore.index('subject_id');

            const itemsRequest = subjectIndex.getAll(subjectId);

            // Optimization: Get all progress or just query one by one? 
            // getAllKeys/getAll is fast. Let's get all progress for global simplicity or just map.
            // Since we don't have index on progress by subject (it's by item_id), we might load all progress.
            // Optimized: Create map later.
            const progressRequest = progressStore.getAll();

            let items = [];
            let progress = [];

            itemsRequest.onsuccess = () => { items = itemsRequest.result; };
            progressRequest.onsuccess = () => { progress = progressRequest.result; };

            transaction.oncomplete = () => {
                const progressMap = new Map();
                progress.forEach(p => progressMap.set(p.item_id, p));

                const result = items.map(item => {
                    const p = progressMap.get(item.id) || { level: 0, last_studied: 0 };
                    return {
                        id: item.id,
                        subject_id: item.subject_id,
                        front: item.front,
                        front_info: item.front_info || '', // New
                        back: item.back,
                        back_info: item.back_info || '',   // New
                        level: (p.level !== undefined) ? p.level : 0,
                        last_studied: p.last_studied || 0
                    };
                });
                resolve(result);
            };

            transaction.onerror = (e) => reject(e.target.error);
        });
    }

    async updateProgress(itemId, level) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['progress'], 'readwrite');
            const store = transaction.objectStore('progress');

            store.put({
                item_id: itemId,
                level: level,
                last_studied: Date.now() / 1000
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = (e) => reject(e.target.error);
        });
    }

    // New: Update Item Content (Correction)
    async updateItem(item) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['items'], 'readwrite');
            const store = transaction.objectStore('items');

            // We need to fetch existing to keep created_at or other props if any
            const getReq = store.get(item.id);
            getReq.onsuccess = () => {
                const existing = getReq.result;
                if (existing) {
                    existing.front = item.front;
                    existing.front_info = item.front_info;
                    existing.back = item.back;
                    existing.back_info = item.back_info;
                    store.put(existing);
                }
            };

            transaction.oncomplete = () => resolve(true);
            transaction.onerror = (e) => reject(e.target.error);
        });
    }



    async deleteItem(itemId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['items', 'progress'], 'readwrite');
            transaction.objectStore('items').delete(itemId);
            transaction.objectStore('progress').delete(itemId);

            transaction.oncomplete = () => resolve(true);
            transaction.onerror = (e) => reject(e.target.error);
        });
    }

    // --- Maintenance ---

    // Static method or instance method, but since we are inside class...
    async listAllDatabases() {
        if (!indexedDB.databases) return [];
        return await indexedDB.databases();
    }

    async deleteDatabaseByName(name) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve(true);
            req.onerror = () => reject("Failed to delete");
            req.onblocked = () => reject("Blocked");
        });
    }

    async getDatabaseSummary(name) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(name);
            req.onsuccess = (e) => {
                const db = e.target.result;
                // Just count subjects
                if (db.objectStoreNames.contains('subjects')) {
                    const tx = db.transaction(['subjects'], 'readonly');
                    const store = tx.objectStore('subjects');
                    const countReq = store.count();
                    countReq.onsuccess = () => {
                        const count = countReq.result;
                        db.close();
                        resolve({ subjectsCount: count });
                    };
                    countReq.onerror = () => { db.close(); resolve({ subjectsCount: '?' }); };
                } else {
                    db.close();
                    resolve({ subjectsCount: 0 }); // Probably empty or old version
                }
            };
            req.onerror = () => resolve(null); // Can't open
        });
    }
}
