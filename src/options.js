// OmniFiles - ChromeOS Rclone Integration
// Copyright (c) 2026 Markus Litz
// Licensed under the MIT License. See LICENSE file in the project root for details.

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const navItems = document.querySelectorAll('.nav-item');
    const tabContents = document.querySelectorAll('.tab-content');
    const statusMsg = document.getElementById('statusMsg');
    
    // Manage Tab
    const remoteList = document.getElementById('remoteList');
    
    // Wizard Tab
    const remoteTypeSelect = document.getElementById('remoteType');
    const wizardFormContainer = document.getElementById('wizardFormContainer');
    const dynamicFields = document.getElementById('dynamicFields');
    const remoteNameInput = document.getElementById('remoteName');
    const wizardSaveBtn = document.getElementById('wizardSaveBtn');
    const wizardCancelBtn = document.getElementById('wizardCancelBtn');
    
    // Guided Tab
    const guidedRemoteTypeSelect = document.getElementById('guidedRemoteType');
    const guidedRemoteNameInput = document.getElementById('guidedRemoteName');
    const guidedNextBtn = document.getElementById('guidedNextBtn');
    const guidedPrevBtn = document.getElementById('guidedPrevBtn');
    const guidedSaveBtn = document.getElementById('guidedSaveBtn');
    const guidedTestBtn = document.getElementById('guidedTestBtn');
    const guidedDynamicFields = document.getElementById('guidedDynamicFields');
    const guidedOptionalFields = document.getElementById('guidedOptionalFields');
    
    // Advanced Tab
    const configInput = document.getElementById('configInput');
    const saveBtn = document.getElementById('saveBtn');
    const testBtn = document.getElementById('testBtn');
    const darkModeBtn = document.getElementById('darkModeBtn');
    const exportBtn = document.getElementById('exportBtn');
    const importBtn = document.getElementById('importBtn');
    const fileInput = document.getElementById('fileInput');
    const highlightCode = document.getElementById('highlightCode');

    // State
    let parsedConfig = {}; // e.g. { mydrive: { type: 'drive', client_id: '...' } }

    // i18n helper (works in extension pages)
    const i18n = (key, ...subs) => chrome.i18n.getMessage(key, subs.length ? subs : undefined) || key;

    // ── rclone obscure / reveal ──────────────────────────────────────────
    // Reimplementation of fs/config/obscure/obscure.go in JS (AES-CTR, fixed key).
    // Allows the UI to accept plain passwords and store them in the obscured form
    // that rclone expects in rclone.conf — without requiring 'rclone obscure' on the desktop.
    const _OBSCURE_KEY = new Uint8Array([
        0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
        0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
        0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
        0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
    ]);

    async function rcloneObscure(plaintext) {
        const key = await crypto.subtle.importKey('raw', _OBSCURE_KEY, { name: 'AES-CTR' }, false, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(16));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-CTR', counter: iv, length: 128 },
            key,
            new TextEncoder().encode(plaintext)
        );
        const combined = new Uint8Array(16 + encrypted.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(encrypted), 16);
        let binary = '';
        for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    async function rcloneReveal(obscured) {
        if (!obscured) return '';
        try {
            const b64 = obscured.replace(/-/g, '+').replace(/_/g, '/');
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            if (bytes.length < 16) return obscured;
            const key = await crypto.subtle.importKey('raw', _OBSCURE_KEY, { name: 'AES-CTR' }, false, ['decrypt']);
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-CTR', counter: bytes.slice(0, 16), length: 128 },
                key,
                bytes.slice(16)
            );
            return new TextDecoder().decode(decrypted);
        } catch (_) {
            return obscured; // not obscured or invalid — return as-is
        }
    }

    // Collects field values from the wizard form, obscuring needsObscure fields.
    async function collectFields(idPrefix, providerDef) {
        const result = {};
        for (const field of providerDef.fields) {
            const input = document.getElementById(idPrefix + field.name);
            if (input && input.value.trim() !== '') {
                result[field.name] = field.needsObscure
                    ? await rcloneObscure(input.value.trim())
                    : input.value.trim();
            }
        }
        return result;
    }

    // Initialize
    applyI18n();
    loadConfig();
    populateProviderDropdown();
    setupEventListeners();
    initDarkMode();
    fetchDashboardData();
    loadClipboardData();
    setupLicenseModal();

    /** Applies [data-i18n] and [data-i18n-placeholder] attributes across the page. */
    function applyI18n() {
        document.title = i18n('page_title');
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const t = i18n(el.dataset.i18n);
            if (t) el.textContent = t;
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const t = i18n(el.dataset.i18nPlaceholder);
            if (t) el.placeholder = t;
        });
    }

    // --- Core Logic ---

    function loadConfig() {
        chrome.storage.local.get(['rcloneConf'], (result) => {
            const rawText = result.rcloneConf || '';
            configInput.value = rawText;
            updateHighlighting(rawText);
            parsedConfig = parseINI(rawText);
            renderRemoteList();
        });
    }

    function updateHighlighting(text) {
        if (!highlightCode) return;
        
        // Escape HTML
        let escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
            
        // Apply highlighting rules
        const lines = escaped.split('\n');
        const highlightedLines = lines.map(line => {
            // Comments
            if (line.trim().startsWith(';') || line.trim().startsWith('#')) {
                return `<span class="ini-comment">${line}</span>`;
            }
            // Sections
            if (line.trim().startsWith('[') && line.trim().endsWith(']')) {
                return `<span class="ini-section">${line}</span>`;
            }
            // Key-Value
            if (line.includes('=')) {
                const idx = line.indexOf('=');
                const key = line.substring(0, idx);
                const val = line.substring(idx + 1);
                return `<span class="ini-key">${key}</span>=<span class="ini-value">${val}</span>`;
            }
            return line;
        });
        
        highlightCode.innerHTML = highlightedLines.join('\n') + '\n';
    }

    function saveConfig(rawText) {
        if (!rawText && Object.keys(parsedConfig).length > 0) {
            rawText = serializeINI(parsedConfig);
        }
        
        chrome.storage.local.set({ rcloneConf: rawText }, () => {
            if (chrome.runtime.lastError) {
                showStatus(i18n('msg_error_saving', chrome.runtime.lastError.message), 'error');
            } else {
                showStatus(i18n('msg_config_saved'), 'success');
                configInput.value = rawText;
                parsedConfig = parseINI(rawText);
                renderRemoteList();
            }
        });
    }

    // --- Tab Navigation ---

    function setupEventListeners() {
        navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                // Remove active class from all
                navItems.forEach(n => n.classList.remove('active'));
                tabContents.forEach(t => t.classList.remove('active'));
                
                // Add active to clicked
                e.target.classList.add('active');
                const targetId = e.target.getAttribute('data-target');
                document.getElementById(targetId).classList.add('active');
                
                if (targetId === 'tab-dashboard') {
                    fetchDashboardData();
                }
                if (targetId === 'tab-clipboard') {
                    loadClipboardData();
                }
            });
        });

        // Advanced Save
        saveBtn.addEventListener('click', () => {
            const confText = configInput.value.trim();
            saveConfig(confText);
        });

        // Advanced Highlight Sync
        configInput.addEventListener('input', (e) => {
            updateHighlighting(e.target.value);
        });

        // Advanced Test Connection
        testBtn.addEventListener('click', () => {
            const confText = configInput.value.trim();
            if (!confText) {
                showStatus(i18n('msg_no_config_test'), 'error');
                return;
            }
            showStatus(i18n('msg_testing'), 'success');
            chrome.runtime.sendMessage({ action: 'testConnection', config: confText }, (response) => {
                if (chrome.runtime.lastError) {
                    showStatus(i18n('msg_error_saving', chrome.runtime.lastError.message), 'error');
                } else if (response && response.success) {
                    showStatus(i18n('msg_conn_ok', response.remotes.join(', ')), 'success');
                } else {
                    showStatus(i18n('msg_conn_fail', response ? response.error : '?'), 'error');
                }
            });
        });

        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                const confText = configInput.value.trim();
                if (!confText) {
                    showStatus(i18n('msg_no_export'), 'error');
                    return;
                }
                const blob = new Blob([confText], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'omnifiles.conf';
                document.body.appendChild(a); a.click();
                setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
                showStatus(i18n('msg_export_ok'), 'success');
            });
        }

        if (importBtn && fileInput) {
            importBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    const content = e.target.result;
                    configInput.value = content;
                    if (typeof updateHighlighting === 'function') updateHighlighting(content);
                    showStatus(i18n('msg_import_ok', i18n('btn_save_config')), 'success');
                    fileInput.value = '';
                };
                reader.readAsText(file);
            });
        }

        // Guided Setup Listeners
        if (guidedRemoteTypeSelect) {
            guidedRemoteTypeSelect.addEventListener('change', (e) => {
                const providerKey = e.target.value;
                if (providerKey) {
                    generateGuidedFields(providerKey);
                }
            });
        }

        if (guidedNextBtn) {
            guidedNextBtn.addEventListener('click', () => {
                if (currentStep === 1) {
                    const name = guidedRemoteNameInput.value.trim();
                    const type = guidedRemoteTypeSelect.value;
                    if (!name || !type) { showStatus(i18n('msg_name_type_req'), 'error'); return; }
                    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { showStatus(i18n('msg_invalid_name'), 'error'); return; }
                }
                if (currentStep < 4) { currentStep++; updateStepperUI(); }
            });
        }

        if (guidedPrevBtn) {
            guidedPrevBtn.addEventListener('click', () => {
                if (currentStep > 1) {
                    currentStep--;
                    updateStepperUI();
                }
            });
        }

        if (guidedSaveBtn) {
            guidedSaveBtn.addEventListener('click', async () => {
                const name = guidedRemoteNameInput.value.trim();
                const type = guidedRemoteTypeSelect.value;
                const newRemote = { type: type };

                const providerDef = window.rcloneProviders[type];
                if (providerDef) {
                    Object.assign(newRemote, await collectFields('guided_field_', providerDef));
                }

                parsedConfig[name] = newRemote;
                saveConfig(serializeINI(parsedConfig));

                // Reset and switch to manage
                currentStep = 1;
                updateStepperUI();
                guidedRemoteNameInput.value = '';
                guidedRemoteTypeSelect.value = '';
                document.querySelector('[data-target="tab-manage"]').click();
            });
        }

        if (guidedTestBtn) {
            guidedTestBtn.addEventListener('click', async () => {
                const name = guidedRemoteNameInput.value.trim();
                const type = guidedRemoteTypeSelect.value;
                const newRemote = { type: type };

                const providerDef = window.rcloneProviders[type];
                if (providerDef) {
                    Object.assign(newRemote, await collectFields('guided_field_', providerDef));
                }

                const tempConfig = {};
                tempConfig[name] = newRemote;
                const confText = serializeINI(tempConfig);

                showStatus(i18n('msg_testing'), 'success');
                chrome.runtime.sendMessage({ action: 'testConnection', config: confText }, (response) => {
                    if (chrome.runtime.lastError) {
                        showStatus(i18n('msg_error_saving', chrome.runtime.lastError.message), 'error');
                    } else if (response && response.success) {
                        showStatus(i18n('msg_conn_ok', response.remotes.join(', ')), 'success');
                    } else {
                        showStatus(i18n('msg_conn_fail', response ? response.error : '?'), 'error');
                    }
                });
            });
        }

        // Wizard Select Provider
        remoteTypeSelect.addEventListener('change', (e) => {
            const providerKey = e.target.value;
            if (providerKey) {
                buildWizardForm(providerKey);
                wizardFormContainer.style.display = 'block';
            } else {
                wizardFormContainer.style.display = 'none';
            }
        });

        // Wizard Save
        wizardSaveBtn.addEventListener('click', async () => {
            const name = remoteNameInput.value.trim();
            if (!name) { showStatus(i18n('msg_name_req'), 'error'); return; }
            if (!/^[a-zA-Z0-9_-]+$/.test(name)) { showStatus(i18n('msg_invalid_name'), 'error'); return; }

            const type = remoteTypeSelect.value;
            const newRemote = { type: type };

            const providerDef = window.rcloneProviders[type];
            if (providerDef) {
                Object.assign(newRemote, await collectFields('field_', providerDef));
            }

            parsedConfig[name] = newRemote;
            saveConfig(serializeINI(parsedConfig));

            // Reset wizard and switch to manage tab
            wizardCancelBtn.click();
            document.querySelector('[data-target="tab-manage"]').click();
        });

        // Wizard Cancel
        wizardCancelBtn.addEventListener('click', () => {
            remoteTypeSelect.value = '';
            remoteNameInput.value = '';
            wizardFormContainer.style.display = 'none';
        });
    }

    function fetchDashboardData() {
        const dashboardGrid = document.getElementById('dashboardGrid');
        if (!dashboardGrid) return;
        
        dashboardGrid.innerHTML = '<div class="empty-state">Loading dashboard data...</div>';
        
        chrome.runtime.sendMessage({ action: 'getDashboardData' }, (response) => {
            if (chrome.runtime.lastError) {
                dashboardGrid.innerHTML = `<div class="empty-state error">Error: ${chrome.runtime.lastError.message}</div>`;
            } else if (response && response.success) {
                renderDashboard(response.data);
            } else {
                dashboardGrid.innerHTML = `<div class="empty-state error">Error: ${response ? response.error : 'Unknown error'}</div>`;
            }
        });
    }

    function renderDashboard(data) {
        const dashboardGrid = document.getElementById('dashboardGrid');
        if (!dashboardGrid) return;
        
        dashboardGrid.innerHTML = '';
        
        if (!data || data.length === 0) {
            dashboardGrid.innerHTML = '<div class="empty-state">No active mounts found. Mount a remote in ChromeOS to see it here.</div>';
            return;
        }
        
        data.forEach(item => {
            const card = document.createElement('div');
            card.className = 'dashboard-card';
            
            let statusClass = 'status-inactive';
            let statusLabel = item.status;
            if (item.status === 'online') {
                statusClass = 'status-active';
            } else if (item.status === 'auth_expired') {
                statusClass = 'status-warning';
                statusLabel = i18n('status_auth_expired');
            }
            
            let quotaHtml = '';
            if (item.quota && item.quota.total > 0) {
                const used = item.quota.used || 0;
                const total = item.quota.total;
                const pct = Math.round((used / total) * 100);
                quotaHtml = `
                    <div class="info-row">
                        <span class="info-label">Storage:</span>
                        <span class="info-value">${formatBytes(used)} / ${formatBytes(total)} (${pct}%)</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${pct}%"></div>
                    </div>
                `;
            } else if (item.quota && item.quota.used > 0) {
                // total=0 means unlimited (e.g. Google Workspace)
                quotaHtml = `
                    <div class="info-row">
                        <span class="info-label">Storage:</span>
                        <span class="info-value">${formatBytes(item.quota.used)} used (unlimited)</span>
                    </div>
                `;
            } else {
                quotaHtml = `
                    <div class="info-row">
                        <span class="info-label">Storage:</span>
                        <span class="info-value">N/A</span>
                    </div>
                `;
            }
            
            card.innerHTML = `
                <div class="card-header">
                    <span class="card-title">${item.name}</span>
                    <span class="card-status ${statusClass}">${statusLabel}</span>
                </div>
                <div class="card-body">
                    <div class="info-row">
                        <span class="info-label">Type:</span>
                        <span class="info-value">${item.type}</span>
                    </div>
                    ${quotaHtml}
                    <div class="info-row">
                        <span class="info-label">Active Uploads:</span>
                        <span class="info-value">${item.activeUploads}</span>
                    </div>
                </div>
            `;
            
            dashboardGrid.appendChild(card);
        });
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    // --- UI Renderers ---

    function renderRemoteList() {
        chrome.storage.local.get(['remoteStatus'], (result) => {
            const statusObj = result.remoteStatus || {};
            remoteList.innerHTML = '';
            const names = Object.keys(parsedConfig);
            
        if (names.length === 0) {
                remoteList.innerHTML = `<li class="empty-state">${i18n('manage_empty')}</li>`;
                return;
            }

            names.forEach(name => {
                const remote = parsedConfig[name];
                const li = document.createElement('li');
                li.className = 'remote-item';
                const infoDiv = document.createElement('div');
                infoDiv.className = 'remote-info';
                let typeName = remote.type;
                if (window.rcloneProviders && window.rcloneProviders[remote.type]) {
                    typeName = window.rcloneProviders[remote.type].name;
                }
                const status = statusObj[name] ? statusObj[name].status : 'unknown';
                const statusClass = `status-dot status-${status}`;
                const statusTitle = status === 'auth_expired' ? i18n('status_auth_expired') : status;
                infoDiv.innerHTML = `<strong>${name} <span class="${statusClass}" title="${statusTitle}"></span></strong><span>${i18n('dash_type')} ${typeName}</span>`;
                const actionDiv = document.createElement('div');
                
                // Edit Button
                const editBtn = document.createElement('button');
                editBtn.className = 'btn btn-secondary';
                editBtn.textContent = i18n('btn_edit') || 'Edit';
                editBtn.style.marginRight = '8px';
                editBtn.addEventListener('click', () => {
                    editRemote(name);
                });
                actionDiv.appendChild(editBtn);

                // Delete Button
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'btn btn-danger';
                deleteBtn.textContent = i18n('btn_delete');
                deleteBtn.addEventListener('click', () => {
                    if (confirm(i18n('confirm_delete', name))) {
                        delete parsedConfig[name];
                        saveConfig(serializeINI(parsedConfig));
                    }
                });
                actionDiv.appendChild(deleteBtn);
                li.appendChild(infoDiv); li.appendChild(actionDiv);
                remoteList.appendChild(li);
            });
        });
    }

    async function editRemote(name) {
        const remote = parsedConfig[name];
        if (!remote || !remote.type) return;

        // Switch to wizard tab
        navItems.forEach(n => n.classList.remove('active'));
        tabContents.forEach(t => t.classList.remove('active'));
        const wizardTabBtn = document.querySelector('[data-target="tab-wizard"]');
        const wizardTabContent = document.getElementById('tab-wizard');
        if (wizardTabBtn) wizardTabBtn.classList.add('active');
        if (wizardTabContent) wizardTabContent.classList.add('active');

        // Fill in name and type
        remoteNameInput.value = name;
        remoteTypeSelect.value = remote.type;

        // Trigger dropdown change to build fields
        buildWizardForm(remote.type);
        wizardFormContainer.style.display = 'block';

        const providerDef = window.rcloneProviders[remote.type];
        const obscureFields = new Set(
            providerDef ? providerDef.fields.filter(f => f.needsObscure).map(f => f.name) : []
        );

        // Fill in fields, revealing obscured passwords
        setTimeout(async () => {
            for (const [key, value] of Object.entries(remote)) {
                if (key === 'type') continue;
                const input = document.getElementById('field_' + key);
                if (input) {
                    input.value = obscureFields.has(key) ? await rcloneReveal(value) : value;
                }
            }
        }, 50);
    }

    function populateProviderDropdown() {
        if (!window.rcloneProviders) return;
        
        Object.keys(window.rcloneProviders).forEach(key => {
            const def = window.rcloneProviders[key];
            const option = document.createElement('option');
            option.value = key;
            
            if (def.unsupported) {
                option.textContent = def.name + ' (Unsupported)';
                option.style.color = '#70757a';
            } else {
                option.textContent = def.name;
            }
            
            remoteTypeSelect.appendChild(option);
            
            if (guidedRemoteTypeSelect) {
                guidedRemoteTypeSelect.appendChild(option.cloneNode(true));
            }
        });
    }

    // Guided Setup State
    let currentStep = 1;
    let guidedSelectedProvider = null;

    function updateStepperUI() {
        // Update steps indicator
        document.querySelectorAll('.stepper-steps .step').forEach(step => {
            const stepNum = parseInt(step.getAttribute('data-step'));
            step.classList.remove('active', 'completed');
            if (stepNum === currentStep) {
                step.classList.add('active');
            } else if (stepNum < currentStep) {
                step.classList.add('completed');
            }
        });

        // Update content visibility
        document.querySelectorAll('.stepper-wrapper .step-content').forEach((content, idx) => {
            if (idx + 1 === currentStep) {
                content.style.display = 'block';
            } else {
                content.style.display = 'none';
            }
        });

        // Update buttons
        const guidedPrevBtn = document.getElementById('guidedPrevBtn');
        const guidedNextBtn = document.getElementById('guidedNextBtn');
        const guidedSaveBtn = document.getElementById('guidedSaveBtn');

        if (guidedPrevBtn) guidedPrevBtn.style.display = currentStep > 1 ? 'inline-flex' : 'none';
        if (guidedNextBtn) guidedNextBtn.style.display = currentStep < 4 ? 'inline-flex' : 'none';
        if (guidedSaveBtn) guidedSaveBtn.style.display = currentStep === 4 ? 'inline-flex' : 'none';
    }

    function generateGuidedFields(providerKey) {
        const guidedDynamicFields = document.getElementById('guidedDynamicFields');
        const guidedOptionalFields = document.getElementById('guidedOptionalFields');
        
        if (!guidedDynamicFields || !guidedOptionalFields) return;
        
        guidedDynamicFields.innerHTML = '';
        guidedOptionalFields.innerHTML = '';
        
        const def = window.rcloneProviders[providerKey];
        if (!def) return;

        guidedSelectedProvider = def;

        def.fields.forEach(field => {
            const group = document.createElement('div');
            group.className = 'form-group';
            
            const label = document.createElement('label');
            label.setAttribute('for', 'guided_field_' + field.name);
            label.textContent = field.label;
            group.appendChild(label);

            let input;
            if (field.type === 'select') {
                input = document.createElement('select');
                field.options.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.label;
                    if (field.default === opt.value) option.selected = true;
                    input.appendChild(option);
                });
            } else if (field.type === 'remote_select') {
                input = document.createElement('select');
                const remoteNames = Object.keys(parsedConfig);
                if (remoteNames.length === 0) {
                    const option = document.createElement('option');
                    option.value = "";
                    option.textContent = "-- No remotes available --";
                    input.appendChild(option);
                } else {
                    remoteNames.forEach(name => {
                        const option = document.createElement('option');
                        option.value = name + ":";
                        option.textContent = name;
                        input.appendChild(option);
                    });
                }
            } else if (field.type === 'textarea') {
                input = document.createElement('textarea');
                if (field.placeholder) input.placeholder = field.placeholder;
                input.style.minHeight = '60px';
            } else {
                input = document.createElement('input');
                input.type = field.type || 'text';
                if (field.placeholder) input.placeholder = field.placeholder;
            }
            
            input.id = 'guided_field_' + field.name;
            group.appendChild(input);

            if (field.help) {
                const help = document.createElement('span');
                help.className = 'help-text';
                help.textContent = field.help;
                group.appendChild(help);
            }

            const isCredential = ['token', 'pass', 'password', 'secret_access_key', 'client_secret'].includes(field.name);
            
            if (isCredential || def.fields.indexOf(field) < 2) {
                guidedDynamicFields.appendChild(group);
            } else {
                guidedOptionalFields.appendChild(group);
            }
        });
        
        if (guidedOptionalFields.innerHTML === '') {
            guidedOptionalFields.innerHTML = `<p>${i18n('no_optional')}</p>`;
        }
    }

    function buildWizardForm(providerKey) {
        dynamicFields.innerHTML = '';
        const def = window.rcloneProviders[providerKey];
        if (!def) return;

        const desc = document.createElement('p');
        desc.style.color = '#5f6368';
        desc.style.fontStyle = 'italic';
        desc.textContent = def.description;
        dynamicFields.appendChild(desc);

        def.fields.forEach(field => {
            const group = document.createElement('div');
            group.className = 'form-group';
            
            const label = document.createElement('label');
            label.setAttribute('for', 'field_' + field.name);
            label.textContent = field.label;
            group.appendChild(label);

            let input;
            if (field.type === 'select') {
                input = document.createElement('select');
                field.options.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.label;
                    if (field.default === opt.value) option.selected = true;
                    input.appendChild(option);
                });
            } else if (field.type === 'remote_select') {
                input = document.createElement('select');
                const remoteNames = Object.keys(parsedConfig);
                if (remoteNames.length === 0) {
                    const option = document.createElement('option');
                    option.value = "";
                    option.textContent = "-- No remotes available --";
                    input.appendChild(option);
                } else {
                    remoteNames.forEach(name => {
                        const option = document.createElement('option');
                        option.value = name + ":";
                        option.textContent = name;
                        input.appendChild(option);
                    });
                }
            } else if (field.type === 'textarea') {
                input = document.createElement('textarea');
                if (field.placeholder) input.placeholder = field.placeholder;
                input.style.minHeight = '60px';
            } else {
                input = document.createElement('input');
                input.type = field.type || 'text';
                if (field.placeholder) input.placeholder = field.placeholder;
            }
            
            input.id = 'field_' + field.name;
            group.appendChild(input);

            if (field.help) {
                const help = document.createElement('span');
                help.className = 'help-text';
                help.textContent = field.help;
                group.appendChild(help);
            }

            dynamicFields.appendChild(group);
        });
    }

    function showStatus(msg, type) {
        statusMsg.textContent = msg;
        statusMsg.className = 'status ' + type + ' visible';
        
        if (type === 'success') {
            setTimeout(() => {
                statusMsg.classList.remove('visible');
            }, 3000);
        }
    }

    // --- INI Parser/Serializer ---

    function parseINI(text) {
        const result = {};
        let currentSection = null;
        
        const lines = text.split('\n');
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith(';') || line.startsWith('#')) continue;
            
            if (line.startsWith('[') && line.endsWith(']')) {
                currentSection = line.substring(1, line.length - 1).trim();
                result[currentSection] = {};
            } else if (currentSection) {
                const match = line.match(/^([^=]+)=(.*)$/);
                if (match) {
                    const key = match[1].trim();
                    const value = match[2].trim();
                    result[currentSection][key] = value;
                }
            }
        }
        return result;
    }

    function serializeINI(obj) {
        let text = '';
        for (const [section, keys] of Object.entries(obj)) {
            text += `[${section}]\n`;
            for (const [key, value] of Object.entries(keys)) {
                text += `${key} = ${value}\n`;
            }
            text += '\n';
        }
        return text;
    }

    function initDarkMode() {
        if (!darkModeBtn) return;

        chrome.storage.local.get(['darkMode'], (result) => {
            let mode = result.darkMode;
            // migrate old boolean values from previous sessions
            if (mode === true)  mode = 'dark';
            else if (mode === false) mode = 'light';
            else mode = 'auto';
            applyDarkMode(mode);
        });

        darkModeBtn.addEventListener('click', () => {
            const current = darkModeBtn.dataset.mode || 'auto';
            const next = current === 'auto' ? 'dark' : current === 'dark' ? 'light' : 'auto';
            applyDarkMode(next);
            chrome.storage.local.set({ darkMode: next });
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if ((darkModeBtn.dataset.mode || 'auto') === 'auto') {
                applyDarkMode('auto');
            }
        });
    }

    function applyDarkMode(mode) {
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDark = mode === 'dark' || (mode === 'auto' && systemDark);
        document.body.classList.toggle('dark-mode', isDark);
        if (darkModeBtn) {
            darkModeBtn.dataset.mode = mode;
            if (mode === 'auto')       darkModeBtn.textContent = i18n('btn_auto_mode');
            else if (mode === 'dark')  darkModeBtn.textContent = i18n('btn_light_mode');
            else                       darkModeBtn.textContent = i18n('btn_dark_mode');
        }
    }

    // --- Lizenz-Modal (Footer-Link) ---

    function setupLicenseModal() {
        const link = document.getElementById('legalLink');
        const overlay = document.getElementById('licenseModalOverlay');
        const closeBtn = document.getElementById('licenseModalCloseBtn');
        const closeX = document.getElementById('licenseModalCloseX');
        if (!link || !overlay) return;

        const open = (e) => {
            if (e) e.preventDefault();
            overlay.classList.add('visible');
        };
        const close = () => overlay.classList.remove('visible');

        link.addEventListener('click', open);
        if (closeBtn) closeBtn.addEventListener('click', close);
        if (closeX) closeX.addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('visible')) close();
        });
    }

    // --- Schnellzugriff / Clipboard Tab ---

    function loadClipboardData() {
        chrome.storage.local.get(['lastGeneratedLink', 'lastCopiedPath'], (result) => {
            // ── Public link ──────────────────────────────────────────────────
            const linkEl   = document.getElementById('clipLinkValue');
            const linkMeta = document.getElementById('clipLinkMeta');
            const linkCopy = document.getElementById('clipLinkCopyBtn');
            const linkOpen = document.getElementById('clipLinkOpenBtn');
            const linkOk   = document.getElementById('clipLinkCopied');

            if (result.lastGeneratedLink && result.lastGeneratedLink.url) {
                const { url, path, ts } = result.lastGeneratedLink;
                linkEl.textContent = url;
                linkEl.classList.remove('clip-empty');
                linkMeta.textContent = i18n('clip_link_meta', path, new Date(ts).toLocaleString());
                linkCopy.disabled = false;
                linkOpen.disabled = false;
                linkCopy.onclick = () => navigator.clipboard.writeText(url).then(() => {
                    linkOk.classList.add('show'); setTimeout(() => linkOk.classList.remove('show'), 2000);
                });
                linkOpen.onclick = () => window.open(url, '_blank');
            } else {
                linkEl.textContent = i18n('clip_link_empty');
                linkEl.classList.add('clip-empty');
                linkMeta.textContent = '';
                linkCopy.disabled = true;
                linkOpen.disabled = true;
            }

            // ── Rclone path ──────────────────────────────────────────────────
            const pathEl   = document.getElementById('clipPathValue');
            const pathMeta = document.getElementById('clipPathMeta');
            const pathCopy = document.getElementById('clipPathCopyBtn');
            const pathOk   = document.getElementById('clipPathCopied');

            if (result.lastCopiedPath && result.lastCopiedPath.text) {
                const { text, ts } = result.lastCopiedPath;
                pathEl.textContent = text;
                pathEl.classList.remove('clip-empty');
                pathMeta.textContent = i18n('clip_path_meta', new Date(ts).toLocaleString());
                pathCopy.disabled = false;
                pathCopy.onclick = () => navigator.clipboard.writeText(text).then(() => {
                    pathOk.classList.add('show'); setTimeout(() => pathOk.classList.remove('show'), 2000);
                });
            } else {
                pathEl.textContent = i18n('clip_path_empty');
                pathEl.classList.add('clip-empty');
                pathMeta.textContent = '';
                pathCopy.disabled = true;
            }

            // ── Refresh button ───────────────────────────────────────────────
            const refreshBtn = document.getElementById('clipRefreshBtn');
            if (refreshBtn) {
                refreshBtn.onclick = loadClipboardData;
            }
        });
    }
});
