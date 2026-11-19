let state = {
    modules: [],
    currentModuleId: null,
    pairs: {}
};

let toastTimer = null;
function showToast(message, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.classList.add('hidden');
    }, 3500);
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function fetchModules() {
    const res = await fetch('/api/modules');
    const data = await res.json();
    state.modules = data;
    
    // Group by pair
    state.pairs = {};
    data.forEach(m => {
        if (!state.pairs[m.pair_id]) {
            state.pairs[m.pair_id] = { name: m.name, modules: [] };
        }
        state.pairs[m.pair_id].modules.push(m);
    });
}

async function renderPairs() {
    const container = document.getElementById('pairs-container');
    container.innerHTML = 'Loading pairs...';
    await fetchModules();
    
    container.innerHTML = '';
    
    for (const [pairId, pairData] of Object.entries(state.pairs)) {
        const m1 = pairData.modules[0];
        const m2 = pairData.modules[1];
        
        let diffHtml = '<div style="color:var(--text-secondary); font-size:14px;">Loading difference...</div>';
        
        // Fetch pair difference
        try {
            const res = await fetch(`/api/pairs/${pairId}/difference`);
            if (res.ok) {
                const diffData = await res.json();
                if (diffData.differences.length === 0) {
                    diffHtml = '<div style="color:var(--text-secondary); font-size:14px;">No comparison data available yet.</div>';
                } else {
                    diffHtml = '<div class="diff-list">';
                    diffData.differences.forEach(d => {
                        const cat = escapeHtml(d.category);
                        const v1 = escapeHtml(d.m1_val);
                        const v2 = escapeHtml(d.m2_val);
                        if (d.is_different) {
                            diffHtml += `<div class="diff-item text-accent"><strong>${cat}</strong>: ${escapeHtml(m1.id)}(${v1}) vs ${escapeHtml(m2.id)}(${v2})</div>`;
                        } else {
                            diffHtml += `<div class="diff-item" style="color:var(--text-secondary);"><strong>${cat}</strong>: Same (${v1})</div>`;
                        }
                    });
                    diffHtml += '</div>';
                }
            }
        } catch(e) {}
        
        const m1State = m1.state === 'T1' ? `T1D${m1.current_td}` : 'PRE';
        const m2State = m2.state === 'T1' ? `T1D${m2.current_td}` : 'PRE';
        
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <div class="card-title">Pair ${pairId}: ${pairData.name}</div>
            <div style="margin-bottom: 12px;">
                <span class="badge">${m1.id}: ${m1State}</span>
                <span class="badge">${m2.id}: ${m2State}</span>
            </div>
            <strong>Pair Difference:</strong>
            ${diffHtml}
            <div class="btn-group">
                <button class="btn" onclick="openModule('${m1.id}')">${m1.id} Details</button>
                <button class="btn" onclick="openModule('${m2.id}')">${m2.id} Details</button>
            </div>
        `;
        container.appendChild(card);
    }
}

async function openModule(id) {
    state.currentModuleId = id;
    const module = state.modules.find(m => m.id === id);
    if (!module) return;
    
    showView('module');
    renderModuleHeader(module);
    await renderTimeline(id);
}

function renderModuleHeader(m) {
    const header = document.getElementById('module-header-card');
    const isPre = m.state === 'PRE';
    
    header.innerHTML = `
        <div class="card-title">
            <span>${m.id} - ${m.name}</span>
            <span class="${isPre ? 'text-secondary' : 'text-success'}">${isPre ? 'PRE' : 'T1D'+m.current_td}</span>
        </div>
        ${isPre ? `<button class="btn" style="width:100%; margin-top:10px;" onclick="startT1('${m.id}')">Initiate T1 (First Observation)</button>` : ''}
    `;
}

async function startT1(id) {
    const res = await fetch(`/api/modules/${id}/start_t1`, { method: 'POST' });
    if (res.ok) {
        await fetchModules();
        renderModuleHeader(state.modules.find(m => m.id === id));
    }
}

async function renderTimeline(id) {
    const container = document.getElementById('module-timeline');
    container.innerHTML = 'Loading...';
    
    const res = await fetch(`/api/observations/${id}`);
    const obs = await res.json();
    
    if (obs.length === 0) {
        container.innerHTML = '<div style="color:var(--text-secondary); font-size:14px;">No observations yet.</div>';
        return;
    }
    
    container.innerHTML = '';
    // Reverse to show newest first? Timeline usually newest on top.
    obs.reverse().forEach(o => {
        const d = new Date(o.timestamp);
        const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        container.innerHTML += `
            <div class="timeline-item">
                <div class="timeline-date">${escapeHtml(dateStr)}</div>
                <div class="timeline-content">
                    <div style="margin-bottom: 4px;">
                        <span class="badge" style="background-color: var(--accent); color:#000;">${escapeHtml(o.category)}</span>
                        <strong>${escapeHtml(o.qualitative_value)}</strong>
                    </div>
                    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">
                        Source: ${escapeHtml(o.source)} | Confidence: ${escapeHtml(o.user_confidence)}
                    </div>
                    ${o.comment ? `<div>${escapeHtml(o.comment)}</div>` : ''}
                </div>
            </div>
        `;
    });
}

async function submitObservation(e) {
    e.preventDefault();
    if (!state.currentModuleId) return;
    
    const payload = {
        module_id: state.currentModuleId,
        category: document.getElementById('obs-category').value,
        qualitative_value: document.getElementById('obs-val').value,
        source: document.getElementById('obs-source').value,
        user_confidence: document.getElementById('obs-confidence').value,
        comment: document.getElementById('obs-comment').value
    };
    
    const res = await fetch('/api/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    if (res.ok) {
        document.getElementById('obs-form').reset();
        showToast('Observation saved', 'success');
        openModule(state.currentModuleId);
    } else {
        const err = await res.json();
        showToast('Error: ' + (err.detail || JSON.stringify(err)), 'error');
    }
}

function showView(viewId) {
    document.getElementById('view-pairs').classList.add('hidden');
    document.getElementById('view-module').classList.add('hidden');
    document.getElementById('view-add-obs').classList.add('hidden');
    
    document.getElementById(`view-${viewId}`).classList.remove('hidden');
    
    if (viewId === 'pairs') {
        renderPairs();
    }
}

async function exportData() {
    const res = await fetch('/api/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'argus_bio_map_backup.json';
    a.click();
}

async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const res = await fetch('/api/import', {
            method: 'POST',
            body: formData
        });
        if (res.ok) {
            showToast('Import successful', 'success');
            renderPairs();
        } else {
            showToast('Import failed', 'error');
        }
    } catch(e) {
        showToast('Error importing', 'error');
    }
}

// Init
showView('pairs');
