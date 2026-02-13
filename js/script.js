class AppManager {
    constructor() {
        this.items = []; // Array of { id, front, back, level, last_studied }
        this.playlist = [];
        this.currentIndex = 0;
        this.isRandom = false;
        this.isRandom = false;

        // Dynamic DB name based on folder path to allow multiple instances
        // Dynamic DB name based on folder path to allow multiple instances
        // e.g. /my_folder/app/index.html -> MemorizationAppDB_v2__my_folder_app
        // Dynamic DB name based on folder path to allow multiple instances
        // e.g. /my_folder/app/index.html -> MemorizationAppDB_v2__my_folder_app
        let dirPath = window.location.pathname;

        // Robustly remove filename if it ends with .html or .htm (case insensitive)
        dirPath = dirPath.replace(/\/[^/]+\.html?$/i, '');

        if (dirPath.endsWith('/')) {
            dirPath = dirPath.substring(0, dirPath.length - 1);
        }
        const pathSuffix = dirPath.replace(/[^a-zA-Z0-9]/g, '_');
        this.db = new MemorizationDB(`MemorizationAppDB_v2_${pathSuffix}`);

        this.subjects = [];
        this.currentSubject = null;

        // Default Filter Settings
        this.targetLevels = [0, 1, 2];
        this.sortMode = 'random';

        // App Mode: 'long' (default, prototype6_long) or 'short' (prototype6)
        this.appMode = localStorage.getItem('appMode') || 'long';
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            await this.db.init();
            await this.loadSubjects();

            // Bug Fix: Cleanup duplicate 'General' subjects if they exist
            // (Occurred due to race conditions in previous versions)
            const generals = this.subjects.filter(s => s.name === "General");
            if (generals.length > 1) {
                console.log("Cleaning up duplicate General subjects...");
                // Sort by ID (keep oldest)
                generals.sort((a, b) => a.id - b.id);
                for (let i = 1; i < generals.length; i++) {
                    const subjectToDelete = generals[i];
                    // Only delete if empty to be safe
                    const items = await this.db.getAllItemsWithProgress(subjectToDelete.id);
                    if (items.length === 0) {
                        await this.db.deleteSubject(subjectToDelete.id);
                        console.log(`Deleted empty duplicate subject: ${subjectToDelete.name} (${subjectToDelete.id})`);
                    }
                }
                await this.loadSubjects();
            }

            // Auto-select first subject or default
            if (this.subjects.length === 0) {
                await this.createSubject("General"); // Default subject
            } else {
                // Try to load last used subject from localStorage?
                const lastId = localStorage.getItem('lastSubjectId');
                if (lastId) {
                    const found = this.subjects.find(s => s.id === parseInt(lastId));
                    if (found) {
                        await this.selectSubject(found.id);
                    } else {
                        await this.selectSubject(this.subjects[0].id);
                    }
                } else {
                    await this.selectSubject(this.subjects[0].id);
                }
            }

            console.log("App initialized");
        })();
        return this.initPromise;
    }

    async loadSubjects() {
        this.subjects = await this.db.getSubjects();
    }

    async createSubject(name) {
        const id = await this.db.createSubject(name, {
            frontLang: 'en-US',
            backLang: 'ja-JP'
        });
        await this.loadSubjects();
        await this.selectSubject(id);
        return id;
    }

    async deleteSubject(id) {
        if (confirm("本当に削除しますか？\nこの操作は元に戻せません。この科目の全データと学習進捗が削除されます。")) {
            await this.db.deleteSubject(id);
            await this.loadSubjects();
            if (this.currentSubject && this.currentSubject.id === id) {
                // Swith to another if available
                if (this.subjects.length > 0) {
                    await this.selectSubject(this.subjects[0].id);
                } else {
                    await this.createSubject("General");
                }
            }
            return true;
        }
        return false;
    }

    async selectSubject(id) {
        const subject = this.subjects.find(s => s.id === id);
        if (!subject) return;

        this.currentSubject = subject;
        localStorage.setItem('lastSubjectId', id);

        // Load items for this subject
        await this.loadData();
    }

    async loadData() {
        if (!this.currentSubject) return;
        try {
            this.items = await this.db.getAllItemsWithProgress(this.currentSubject.id);
            console.log(`Loaded ${this.items.length} items for subject: ${this.currentSubject.name}`);
        } catch (e) {
            console.error("Failed to load data from DB", e);
        }
    }

    async saveSettings(frontLang, backLang) {
        if (!this.currentSubject) return;

        const newSettings = {
            frontLang: frontLang,
            backLang: backLang
        };

        // Optimistic update
        this.currentSubject.settings = newSettings;

        await this.db.updateSubject(this.currentSubject.id, { settings: newSettings });
    }

    async saveProgress(itemId, level) {
        // Optimistic update
        const item = this.items.find(i => i.id === itemId);
        if (item) {
            item.level = level;
            item.last_studied = Date.now() / 1000;
        }
        await this.db.updateProgress(itemId, level);
    }

    // --- Import / Export ---

    // --- Import / Export ---

    /**
     * Parse raw text into structured items.
     * Supports Tab-separated values (TSV) and Comma-separated values (CSV).
     * Format: Front, FrontInfo, Back, BackInfo
     */
    async importDataRaw(text) {
        if (!this.currentSubject) {
            console.error("Import Error: No current subject selected.");
            return -1;
        }

        const parsedItems = this.parseCSV(text);

        if (parsedItems.length > 0) {
            await this.db.importItems(this.currentSubject.id, parsedItems, false);
            await this.loadData();
            return parsedItems.length;
        }
        return 0;
    }

    /**
     * Robust CSV/TSV Parser
     * Handles quotes and mixed delimiters.
     */
    parseCSV(text) {
        const lines = text.split(/\r?\n/);
        const parsedItems = [];

        // Helper to parse a single line with specific delimiter and quote handling
        const parseLine = (line, delimiter) => {
            const values = [];
            let current = '';
            let inQuote = false;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (c === '"') {
                    if (inQuote && line[i + 1] === '"') {
                        current += '"';
                        i++;
                    } else {
                        inQuote = !inQuote;
                    }
                } else if (c === delimiter && !inQuote) {
                    values.push(current);
                    current = '';
                } else {
                    current += c;
                }
            }
            values.push(current);
            return values;
        };

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            let parts;
            // Detect delimiter: Tab takes precedence as it's less likely to be part of content
            if (line.includes('\t')) {
                parts = line.split('\t'); // Simple split for TSV is usually sufficient
            } else {
                // Warning: CSV parsing assumes comma delimiter. 
                // Using the robust parser for CSV to handle quoted commas.
                parts = parseLine(line, ',');
            }

            // Trim parts and remove surrounding quotes
            parts = parts.map(p => p.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));

            if (parts.length > 0) {
                let front = '';
                let front_info = '';
                let back = '';
                let back_info = '';

                // Mapping based on column count
                if (parts.length >= 4) {
                    [front, front_info, back, back_info] = parts;
                } else if (parts.length === 3) {
                    // Legacy 3-col: Front, Back, FrontInfo
                    [front, back, front_info] = parts;
                } else if (parts.length === 2) {
                    [front, back] = parts;
                } else if (parts.length === 1) {
                    [front] = parts;
                }

                if (front || back) {
                    parsedItems.push({ front, front_info, back, back_info });
                }
            }
        }
        return parsedItems;
    }

    async exportSubjectBackup() {
        if (!this.currentSubject) return null;
        const backup = {
            version: 1,
            subject: {
                name: this.currentSubject.name,
                settings: this.currentSubject.settings
            },
            items: this.items
        };
        return JSON.stringify(backup, null, 2);
    }

    async importSubjectBackup(jsonString) {
        try {
            const backup = JSON.parse(jsonString);
            if (!backup.subject || !backup.items) throw new Error("Invalid Format");

            // Create new subject or overwrite current?
            // Safer to create NEW subject from backup.
            const name = backup.subject.name + " (Imported)";
            const newId = await this.db.createSubject(name, backup.subject.settings || {});

            // Transform items to add to this subject
            // items in backup have 'level' and 'last_studied'.
            // db.importItems handles them specifically if we pass them.
            // My db.importItems implementation checks for item.level.

            await this.db.importItems(newId, backup.items, true);

            // Switch to it
            await this.loadSubjects();
            await this.selectSubject(newId);
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    // --- Playlist ---

    refreshPlaylist(activeLevels, mode) {
        this.targetLevels = activeLevels;
        this.sortMode = mode;
        let candidates = this.items.filter(item => activeLevels.includes(item.level));

        if (candidates.length === 0) {
            this.playlist = [];
            return;
        }

        if (mode === 'random') {
            this.isRandom = true;
            this.playlist = this.shuffle([...candidates]);
        } else if (mode === 'id_asc') {
            this.isRandom = false;
            this.playlist = candidates.sort((a, b) => a.id - b.id);
        } else {
            this.isRandom = false;
            this.playlist = candidates.sort((a, b) => {
                const tsA = a.last_studied || 0;
                const tsB = b.last_studied || 0;
                return tsA - tsB;
            });
        }
        this.currentIndex = 0;
    }

    shuffle(array) {
        let currentIndex = array.length, randomIndex;
        while (currentIndex != 0) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex--;
            [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
        }
        return array;
    }

    getNextItem() {
        if (!this.playlist || this.playlist.length === 0) return null;
        if (this.currentIndex >= this.playlist.length) {
            this.currentIndex = 0;
            if (this.isRandom) this.refreshPlaylist(this.targetLevels, this.sortMode);
        }
        const item = this.playlist[this.currentIndex];
        this.currentIndex++;
        return item;
    }
}

// Global instance
const app = new AppManager();
const ttsManager = new TTSManager();

// Shared Logic
// ============================================================
// TTS Wrapper using TTSManager
// ============================================================

/**
 * Main TTS function using TTSManager
 */
async function speakText(text, rate = 1.0, lang = null) {
    if (!text) return;

    // Use settings from current subject
    const settings = app.currentSubject ? app.currentSubject.settings : {};
    const targetLang = lang || settings.frontLang || 'en-US';

    // Delegate to TTSManager
    // 長文版では長いテキストを再生することが多いので、タイムアウトはTTSManager側で適切に処理される
    await ttsManager.speak(text, targetLang, rate);
}

// ---------------------------------------------------------
// Page Specific Initializers
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    await app.init();

    // Header UI update (if exists)
    updateHeaderSubject();

    if (document.getElementById('quiz-app')) initQuiz('front-to-back');
    if (document.getElementById('quiz-name-app')) initQuiz('back-to-front');
    if (document.getElementById('table-container')) initListView();
    if (document.getElementById('flow-app')) initFlowMode();
    if (document.getElementById('management-app')) initManagement();
    if (document.getElementById('subject-settings')) initSubjectSettings(); // For index.html
    if (document.getElementById('maintenance-panel')) initMaintenance();
});

function updateHeaderSubject() {
    const el = document.getElementById('current-subject-display');
    if (el && app.currentSubject) {
        el.innerText = `科目: ${app.currentSubject.name}`;
    }
}

// ---------------------------------------------------------
// Maintenance Logic
// ---------------------------------------------------------
function initMaintenance() {
    const btnScan = document.getElementById('btn-scan-db');
    const listDiv = document.getElementById('db-list');

    btnScan.onclick = async () => {
        if (!indexedDB.databases) {
            alert("This browser does not support listing databases.");
            return;
        }

        listDiv.innerHTML = "Scanning...";
        const dbs = await app.db.listAllDatabases();
        const currentDbName = app.db.dbName;

        // Filter for our app's DBs (v2) but NOT the current one
        const candidates = dbs.filter(d => d.name.startsWith('MemorizationAppDB_v2') && d.name !== currentDbName);

        listDiv.innerHTML = "";
        if (candidates.length === 0) {
            listDiv.innerHTML = "<p>削除可能な古いデータベースは見つかりませんでした。</p>";
            return;
        }

        const ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.padding = 0;

        for (const dbInfo of candidates) {
            const li = document.createElement('li');
            li.style.background = '#333';
            li.style.margin = '5px 0';
            li.style.padding = '10px';
            li.style.display = 'flex';
            li.style.justifyContent = 'space-between';
            li.style.alignItems = 'center';
            li.style.border = '1px solid #555';

            const infoDiv = document.createElement('div');
            infoDiv.innerHTML = `<strong>${dbInfo.name}</strong><br><span style="font-size:0.8rem; color:#aaa;">Ver: ${dbInfo.version}</span>`;

            // Async fetch extra info
            app.db.getDatabaseSummary(dbInfo.name).then(summary => {
                if (summary) {
                    infoDiv.innerHTML += `<br><span style="font-size:0.8rem; color:#4caf50;">科目数: ${summary.subjectsCount}</span>`;
                }
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-secondary';
            delBtn.style.background = '#d32f2f';
            delBtn.innerText = '削除';
            delBtn.onclick = async () => {
                if (confirm(`データベース「${dbInfo.name}」を本当に削除しますか？\n中身のデータはすべて失われます。`)) {
                    try {
                        await app.db.deleteDatabaseByName(dbInfo.name);
                        li.remove();
                        alert("削除しました。");
                    } catch (e) {
                        alert("削除に失敗しました: " + e);
                    }
                }
            };

            li.appendChild(infoDiv);
            li.appendChild(delBtn);
            ul.appendChild(li);
        }
        listDiv.appendChild(ul);
    };
}

// ---------------------------------------------------------
// Subject & Data Management (index.html)
// ---------------------------------------------------------
function initSubjectSettings() {
    // Subject Dropdown / Creator
    const selSubject = document.getElementById('sel-subject');
    const btnNewSubject = document.getElementById('btn-new-subject');
    const btnDelSubject = document.getElementById('btn-del-subject');

    async function renderSubjects() {
        selSubject.innerHTML = '';
        app.subjects.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.innerText = s.name;
            if (app.currentSubject && s.id === app.currentSubject.id) opt.selected = true;
            selSubject.appendChild(opt);
        });
    }

    renderSubjects(); // Initial render

    selSubject.onchange = async () => {
        const id = parseInt(selSubject.value);
        await app.selectSubject(id);
        updateHeaderSubject();
        // Reload other panels if needed?
        // Since we are on index.html, we likely just re-init management
        initManagement();
    };

    const modal = document.getElementById('modal-new-subject');
    const inputName = document.getElementById('input-new-subject-name');
    const btnCancel = document.getElementById('btn-modal-cancel');
    const btnOk = document.getElementById('btn-modal-ok');

    btnNewSubject.onclick = () => {
        if (!modal) return;
        inputName.value = '';
        modal.style.display = 'block';
        inputName.focus();
    };

    if (btnCancel) {
        btnCancel.onclick = () => {
            modal.style.display = 'none';
        }
    }

    if (btnOk) {
        btnOk.onclick = async () => {
            const name = inputName.value.trim();
            if (name) {
                await app.createSubject(name);
                await renderSubjects();
                updateHeaderSubject();
                initManagement();
                modal.style.display = 'none';
            }
        };
    }

    // Close on outside click
    window.onclick = (event) => {
        if (event.target == modal) {
            modal.style.display = 'none';
        }
    };

    btnDelSubject.onclick = async () => {
        if (app.subjects.length <= 1) {
            alert("最後の科目は削除できません。");
            return;
        }
        await app.deleteSubject(app.currentSubject.id);
        await renderSubjects();
        updateHeaderSubject();
        initManagement();
    };
}

function initManagement() {
    const txtInput = document.getElementById('data-input');
    const btnImport = document.getElementById('btn-import');
    const statusMsg = document.getElementById('status-msg');
    const listPreview = document.getElementById('list-preview');

    // Audio Settings UI
    const selFrontLang = document.getElementById('sel-front-lang');
    const selBackLang = document.getElementById('sel-back-lang');
    const btnSaveLang = document.getElementById('btn-save-lang');
    const msgLang = document.getElementById('msg-lang');

    // Export/Import JSON
    const btnExportJson = document.getElementById('btn-export-json');
    const btnImportJson = document.getElementById('btn-import-json');
    const fileImportJson = document.getElementById('file-import-json');

    // Load Settings for Current Subject
    if (app.currentSubject && app.currentSubject.settings) {
        if (selFrontLang) selFrontLang.value = app.currentSubject.settings.frontLang || 'en-US';
        if (selBackLang) selBackLang.value = app.currentSubject.settings.backLang || 'ja-JP';
    }

    if (btnSaveLang) {
        btnSaveLang.onclick = async () => {
            await app.saveSettings(selFrontLang.value, selBackLang.value);
            msgLang.innerText = "保存しました！";
            msgLang.style.display = 'inline';
            setTimeout(() => { msgLang.style.display = 'none'; }, 2000);
        };
    }

    // Display Mode UI
    const selDisplayMode = document.getElementById('sel-display-mode');
    if (selDisplayMode) {
        selDisplayMode.value = app.appMode;
        selDisplayMode.onchange = () => {
            app.appMode = selDisplayMode.value;
            localStorage.setItem('appMode', app.appMode);
            location.reload();
        };
    }

    // Editable Table Render
    function renderPreview() {
        if (!listPreview) return;
        listPreview.innerHTML = '';
        if (!app.items) return;

        // Container for table
        const tableContainer = document.createElement('div');
        tableContainer.className = 'edit-table-container';

        const table = document.createElement('table');
        table.className = 'edit-table';

        // Header
        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th style="width:25%">表面 (Audio)</th>
                <th style="width:20%">表面補足 (Info)</th>
                <th style="width:25%">裏面 (Audio)</th>
                <th style="width:20%">裏面補足 (Info)</th>
                <th style="width:10%">操作</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        // Show all items (or paginate later if slow, but for now slice 100)
        // User asked for "edit from preview", normally preview is full list in management.
        const itemsToShow = app.items.slice(0, 100);

        // Add Row Button
        const trAdd = document.createElement('tr');
        const tdAdd = document.createElement('td');
        tdAdd.colSpan = 5;
        tdAdd.style.textAlign = 'center';
        tdAdd.style.padding = '10px';
        const btnAdd = document.createElement('button');
        btnAdd.className = 'btn';
        btnAdd.innerText = '+ 新規データを追加';
        btnAdd.style.width = '100%';
        btnAdd.onclick = async () => {
            // Create empty placeholder
            await app.db.importItems(app.currentSubject.id, [{
                front: 'New Item',
                front_info: '',
                back: '',
                back_info: ''
            }]);
            await app.loadData();
            renderPreview();
        };
        tdAdd.appendChild(btnAdd);
        trAdd.appendChild(tdAdd);
        // Insert at TOP of body or bottom? Top is convenient.
        tbody.appendChild(trAdd);

        itemsToShow.forEach(item => {
            const tr = document.createElement('tr');

            // Front
            const tdFront = document.createElement('td');
            const inpFront = document.createElement('input');
            inpFront.value = item.front;
            tdFront.appendChild(inpFront);

            // Front Info
            const tdFrontInfo = document.createElement('td');
            const inpFrontInfo = document.createElement('input');
            inpFrontInfo.value = item.front_info || '';
            tdFrontInfo.appendChild(inpFrontInfo);

            // Back
            const tdBack = document.createElement('td');
            const inpBack = document.createElement('input');
            inpBack.value = item.back;
            tdBack.appendChild(inpBack);

            // Back Info
            const tdBackInfo = document.createElement('td');
            const inpBackInfo = document.createElement('input');
            inpBackInfo.value = item.back_info || '';
            tdBackInfo.appendChild(inpBackInfo);

            // Actions
            const tdActions = document.createElement('td');
            const btnSave = document.createElement('button');
            btnSave.className = 'btn-small btn-save';
            btnSave.innerText = '保存';
            btnSave.onclick = async () => {
                const updatedItem = {
                    ...item,
                    front: inpFront.value,
                    front_info: inpFrontInfo.value,
                    back: inpBack.value,
                    back_info: inpBackInfo.value
                };
                try {
                    await app.db.updateItem(updatedItem);
                    // Update local memory
                    item.front = updatedItem.front;
                    item.front_info = updatedItem.front_info;
                    item.back = updatedItem.back;
                    item.back_info = updatedItem.back_info;

                    // Visual feedback
                    btnSave.innerText = 'OK!';
                    setTimeout(() => btnSave.innerText = '保存', 1000);
                } catch (e) {
                    alert("保存失敗: " + e);
                }
            };

            const btnDel = document.createElement('button');
            btnDel.className = 'btn-small btn-del';
            btnDel.innerText = '削除';
            btnDel.onclick = async () => {
                if (confirm('この行を削除しますか？')) {
                    await app.db.deleteItem(item.id);
                    // Reload data to reflect delete
                    await app.loadData();
                    renderPreview();
                }
            };

            tdActions.appendChild(btnSave);
            tdActions.appendChild(btnDel);

            tr.appendChild(tdFront);
            tr.appendChild(tdFrontInfo);
            tr.appendChild(tdBack);
            tr.appendChild(tdBackInfo);
            tr.appendChild(tdActions);
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        tableContainer.appendChild(table);
        listPreview.appendChild(tableContainer);

        if (app.items.length > 100) {
            const msg = document.createElement('div');
            msg.innerText = `...他 ${app.items.length - 100} 件 (最新100件を表示中)`;
            msg.style.padding = "10px";
            msg.style.color = "#aaa";
            listPreview.appendChild(msg);
        }
    }

    if (listPreview) renderPreview();

    // Raw Text Import
    if (btnImport) {
        btnImport.onclick = async () => {
            const text = txtInput.value;
            if (!text.trim()) { alert("テキストを入力してください。"); return; }
            const count = await app.importDataRaw(text);
            if (count > 0) {
                statusMsg.innerText = `${count}件のデータを追加しました`;
                statusMsg.style.color = "#4caf50";
                txtInput.value = "";
                // Reload data is handled inside importDataRaw -> loadData
                // But renderPreview needs custom call or re-init?
                // app.items is updated.
                renderPreview();
            } else if (count === -1) {
                statusMsg.innerText = "エラー: 科目が選択されていません。新規作成するか選択してください。";
                statusMsg.style.color = "red";
            } else {
                statusMsg.innerText = "有効なデータが見つかりませんでした。形式を確認してください。";
                statusMsg.style.color = "red";
            }
        };
    }

    // JSON Export
    if (btnExportJson) {
        btnExportJson.onclick = async () => {
            const json = await app.exportSubjectBackup();
            if (json) {
                const blob = new Blob([json], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${app.currentSubject.name}_backup.json`;
                a.click();
            }
        };
    }

    // JSON Import
    if (btnImportJson && fileImportJson) {
        btnImportJson.onclick = () => fileImportJson.click();
        fileImportJson.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                const result = await app.importSubjectBackup(ev.target.result);
                if (result) {
                    alert("バックアップを新しい科目として復元しました。");
                    location.reload(); // Reload to refresh everything properly
                } else {
                    alert("バックアップの読み込みに失敗しました。");
                }
            };
            reader.readAsText(file);
        };
    }
}

// ---------------------------------------------------------
// List View Logic
// ---------------------------------------------------------
let contextMenuItemId = null;
// 長文対応版: 横長タイル形式に変更
function initListView() {
    const grid = document.getElementById('table-container');
    const contextMenu = document.getElementById('context-menu');
    grid.innerHTML = ''; // Clear previous items to avoid duplicates

    if (app.appMode === 'short') {
        // --- Short Mode (Grid View) ---
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(150px, 1fr))';
        grid.style.gap = '10px';
        grid.style.flexDirection = 'row'; // reset

        app.items.forEach(item => {
            const cell = document.createElement('div');
            cell.className = `card-cell level-${item.level}`;
            cell.style.position = 'relative';
            cell.id = `cell-${item.id}`;

            const frontInfoHtml = item.front_info ? `<div style="font-size: 0.8rem; color: #888;">${item.front_info}</div>` : '';
            const backInfoHtml = item.back_info ? `<div style="font-size: 0.7rem; color: #999;">(${item.back_info})</div>` : '';

            cell.innerHTML = `
                <div style="font-size: 1.2rem; font-weight: bold;">${item.front}</div>
                ${frontInfoHtml}
                <div style="font-size: 0.9rem; color: #ccc; margin-top: 4px;">${item.back}</div>
                ${backInfoHtml}
                <div style="font-size: 0.7rem; color: #666; margin-top:4px;">Lvl ${item.level}</div>
            `;
            cell.onclick = () => speakText(item.front);
            cell.oncontextmenu = (e) => {
                e.preventDefault();
                contextMenuItemId = item.id;
                contextMenu.style.display = 'block';
                contextMenu.style.left = `${e.pageX}px`;
                contextMenu.style.top = `${e.pageY}px`;
            };
            grid.appendChild(cell);
        });

    } else {
        // --- Long Mode (Tile View) ---
        grid.style.display = 'flex';
        grid.style.flexDirection = 'column';
        grid.style.gap = '8px';

        app.items.forEach(item => {
            const cell = document.createElement('div');
            cell.className = `horizontal-tile level-${item.level}`;
            cell.id = `cell-${item.id}`;

            const frontInfoHtml = item.front_info ? `<div class="tile-hint">${item.front_info}</div>` : '';
            const backInfoHtml = item.back_info ? `<div class="tile-hint">${item.back_info}</div>` : '';

            cell.innerHTML = `
                <div class="tile-front" style="display:flex; flex-direction:column;">
                    <span>${item.front}</span>
                    ${frontInfoHtml}
                </div>
                <div class="tile-back" style="display:flex; flex-direction:column;">
                    <span>${item.back}</span>
                    ${backInfoHtml}
                </div>
                <div class="tile-level">Lv${item.level}</div>
            `;
            cell.onclick = () => speakText(item.front);
            cell.oncontextmenu = (e) => {
                e.preventDefault();
                contextMenuItemId = item.id;
                contextMenu.style.display = 'block';
                contextMenu.style.left = `${e.pageX}px`;
                contextMenu.style.top = `${e.pageY}px`;
            };
            grid.appendChild(cell);
        });
    }

    document.addEventListener('click', () => { if (contextMenu) contextMenu.style.display = 'none'; });
}

window.setTableLevel = async (level) => {
    if (contextMenuItemId !== null) {
        await app.saveProgress(contextMenuItemId, level);
        const cell = document.getElementById(`cell-${contextMenuItemId}`);
        if (cell) cell.className = cell.className.replace(/level-\d+/, `level-${level}`);
        // Update label
        // cell.querySelector... (skipped for brevity)
    }
};

window.setFlowLevel = async (level) => {
    if (currentFlowItem) await app.saveProgress(currentFlowItem.id, level);
};

// ---------------------------------------------------------
// Quiz Logic
// ---------------------------------------------------------
function initQuiz(mode) {
    const lblQuestion = document.getElementById('lbl-question');
    const lblAnswerMain = document.getElementById('lbl-answer-main') || document.getElementById('lbl-hanzi');
    const lblSub = document.getElementById('lbl-sub');
    const btnShow = document.getElementById('btn-show');
    const gradingButtons = document.getElementById('grading-buttons');
    const btnAudio = document.getElementById('btn-audio');
    const btnSettings = document.getElementById('btn-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const btnApply = document.getElementById('btn-apply');
    const lblInfo = document.getElementById('lbl-info');

    let currentItem = null;

    // 長文対応版: hint表示対応 (nextQuestionより前に宣言が必要)
    const lblHint = document.getElementById('lbl-hint');

    app.refreshPlaylist([0, 1, 2], 'random');
    nextQuestion();

    function nextQuestion() {
        currentItem = app.getNextItem();
        const lblStatus = document.getElementById('lbl-status');
        if (lblStatus) lblStatus.innerText = `残り: ${app.currentIndex}/${app.playlist.length}`;

        btnShow.classList.remove('hidden');
        gradingButtons.classList.add('hidden');
        btnAudio.classList.add('hidden');
        if (lblAnswerMain) lblAnswerMain.innerText = '';
        if (lblSub) lblSub.innerText = '';
        if (lblHint) lblHint.innerText = '';

        if (!currentItem) {
            lblQuestion.innerText = "データなし";
            lblInfo.innerText = "データを追加するかフィルターを確認してください";
            return;
        }

        if (mode === 'front-to-back') {
            lblQuestion.innerText = currentItem.front;

            // Mode specific styling
            if (app.appMode === 'short') {
                lblQuestion.className = 'hanzi-text';
                // Short mode also usually excludes hints, but user requested 4-col support.
                // Let's show front_info if present as a small hint?
                if (lblHint && currentItem.front_info) {
                    lblHint.innerText = currentItem.front_info;
                    lblHint.style.display = 'block';
                } else {
                    lblHint.style.display = 'none';
                }
            } else {
                lblQuestion.className = 'long-text';
                // Long mode: Hint displays front_info
                if (lblHint && currentItem.front_info) {
                    lblHint.innerText = currentItem.front_info;
                    lblHint.style.display = 'block';
                }
            }

        } else {
            lblQuestion.innerText = currentItem.back;
            lblQuestion.className = 'long-text'; // Back is usually meaning, regular text

            // Reverse quiz: Hint displays back_info
            if (lblHint && currentItem.back_info) {
                lblHint.innerText = currentItem.back_info;
                lblHint.style.display = 'block';
            }
        }

        lblInfo.innerText = `レベル: ${currentItem.level}`;
    }

    window.showAnswer = () => {
        if (!currentItem) return;
        btnShow.classList.add('hidden');
        gradingButtons.classList.remove('hidden');
        btnAudio.classList.remove('hidden');

        if (mode === 'front-to-back') {
            if (lblAnswerMain) {
                lblAnswerMain.innerText = currentItem.back;
                if (currentItem.back_info) {
                    lblAnswerMain.innerHTML += `<br><span style="font-size:0.8rem; color:#888;">${currentItem.back_info}</span>`;
                }
            }
        } else {
            if (lblAnswerMain) {
                lblAnswerMain.innerText = currentItem.front;
                if (currentItem.front_info) {
                    lblAnswerMain.innerHTML += `<br><span style="font-size:0.8rem; color:#888;">${currentItem.front_info}</span>`;
                }
            }
        }
    };

    window.playAudio = () => {
        if (currentItem) speakText(currentItem.front);
    };

    window.grade = async (level) => {
        if (currentItem) {
            await app.saveProgress(currentItem.id, level);
            nextQuestion();
        }
    };

    if (btnSettings) btnSettings.onclick = () => settingsPanel.classList.toggle('active');
    if (btnApply) btnApply.onclick = () => {
        const levels = [];
        document.querySelectorAll('input[name="level"]:checked').forEach(cb => levels.push(parseInt(cb.value)));
        app.refreshPlaylist(levels, document.getElementById('sort-mode').value);
        settingsPanel.classList.remove('active');
        nextQuestion();
    };
}

// ---------------------------------------------------------
// Flow Mode Logic
// ---------------------------------------------------------
let currentFlowItem = null;
let isFlowPlaying = false;
let flowTimeout = null;

function initFlowMode() {
    const btnToggle = document.getElementById('btn-toggle-flow');
    const btnReload = document.getElementById('btn-reload-flow');
    const selSpeed = document.getElementById('flow-speed');
    const selAudioMode = document.getElementById('flow-audio-mode');
    const flowMain = document.getElementById('flow-sym');
    const flowSub = document.getElementById('flow-jp');
    const flowStatus = document.getElementById('flow-status');

    // Load Audio Preference
    if (localStorage.getItem('flowAudioMode')) {
        selAudioMode.value = localStorage.getItem('flowAudioMode');
    }
    selAudioMode.onchange = () => {
        localStorage.setItem('flowAudioMode', selAudioMode.value);
    };

    refreshFlowPlaylist();

    function refreshFlowPlaylist() {
        stopFlow();
        const levels = [];
        document.querySelectorAll('.flow-level:checked').forEach(cb => levels.push(parseInt(cb.value)));
        app.refreshPlaylist(levels, 'date_asc');
        updateStatus();
    }

    function updateStatus() {
        flowStatus.innerText = `残り: ${app.currentIndex}/${app.playlist.length}`;
    }

    function stopFlow() {
        isFlowPlaying = false;
        btnToggle.innerText = "スタート";
        clearTimeout(flowTimeout);
        window.speechSynthesis.cancel();
    }

    btnReload.onclick = refreshFlowPlaylist;
    btnToggle.onclick = () => {
        if (isFlowPlaying) stopFlow();
        else {
            isFlowPlaying = true;
            btnToggle.innerText = "ストップ";
            playNextFlowItem();
        }
    };

    async function playNextFlowItem() {
        if (!isFlowPlaying) return;
        currentFlowItem = app.getNextItem();
        if (!currentFlowItem) {
            if (app.playlist.length === 0) {
                alert("プレイリストが空です。");
                stopFlow();
                return;
            }
        }

        updateUI(currentFlowItem);
        const speed = parseFloat(selSpeed.value);
        const audioMode = selAudioMode.value;

        // Determine Wait Time (Base)
        // If no audio, we need artificial delay. Estimate based on text length?
        // Or just fixed delay. Let's use a fixed delay + length factor if no audio.
        const baseDelay = 1500;

        try {
            // Audio Logic
            const frontLang = app.currentSubject?.settings?.frontLang;
            const backLang = app.currentSubject?.settings?.backLang;

            if (audioMode === 'none') {
                // Artificial wait: 2 seconds + char length * 50ms
                const waitTime = 2000 + (currentFlowItem.front.length * 50);
                await waitPromise(waitTime);
            }
            else if (audioMode === 'front') {
                await speakText(currentFlowItem.front, speed, frontLang);
            }
            else if (audioMode === 'back') {
                await speakText(currentFlowItem.back, speed, backLang);
            }
            else if (audioMode === 'front_back') {
                await speakText(currentFlowItem.front, speed, frontLang);
                if (!isFlowPlaying) return;
                await waitPromise(500); // gap
                if (!isFlowPlaying) return;
                await speakText(currentFlowItem.back, speed, backLang);
            }
            else if (audioMode === 'back_front') {
                await speakText(currentFlowItem.back, speed, backLang);
                if (!isFlowPlaying) return;
                await waitPromise(500); // gap
                if (!isFlowPlaying) return;
                await speakText(currentFlowItem.front, speed, frontLang);
            }

            if (!isFlowPlaying) return;
            await waitPromise(baseDelay);
            if (!isFlowPlaying) return;
            flowTimeout = setTimeout(playNextFlowItem, 100);
        } catch (e) {
            console.error(e);
            flowTimeout = setTimeout(playNextFlowItem, 1000);
        }
    }

    function updateUI(item) {
        if (flowMain) {
            flowMain.innerText = item.front;
            if (item.front_info) {
                flowMain.innerHTML += `<div style="font-size: 1rem; color: #888;">${item.front_info}</div>`;
            }
        }
        if (flowSub) {
            flowSub.innerText = item.back;
            if (item.back_info) {
                flowSub.innerHTML += `<div style="font-size: 0.9rem; color: #666;">${item.back_info}</div>`;
            }
        }
        // flow-hint div update (optional, usually repurposed)
        const flowHint = document.getElementById('lbl-flow-hint');
        if (flowHint) flowHint.innerText = ''; // Clear default hint usage as info is now inline
        updateStatus();
    }

    function waitPromise(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}
